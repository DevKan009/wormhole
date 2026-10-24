'use strict';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const {
  generateAESKey,
  keyToBase64Url,
  keyFromBase64Url,
  encryptChunk,
  encryptHeader,
  decryptHeader,
  parseShareInput,
  buildShareFragment,
  nonceIndex,
  deriveNonce,
  HEADER_NONCE_INDEX,
  bytesToBase64Url,
  base64UrlToBytes
} = require('./chunkCrypto');
const { WebRTCFileReceiver, MemorySink, createReceiverSink } = require('./webrtcReceiver');
const { sanitizeFileName, validateFileHeader } = require('./public/webrtcManager');
const { createSignalingServer, buildIceConfig, resolveStaticFile } = require('./server');

const CHUNK = 65536;

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path, host: '127.0.0.1' }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

async function expectReject(promise, pattern, label) {
  let error = null;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  assert(error, `${label}: expected a rejection`);
  if (pattern) assert(pattern.test(error.message), `${label}: got "${error.message}"`);
}

/** Feeds frames to a receiver and resolves with { result, error }. */
function runReceiver(key, header, frames, extra = {}) {
  return new Promise((resolve) => {
    const receiver = new WebRTCFileReceiver(
      {},
      {
        ...extra,
        key,
        bindChannel: false,
        expectedTotalChunks: header.totalChunks,
        expectedFileSize: header.fileSize,
        onComplete: (result) => resolve({ result }),
        onError: (error) => resolve({ error })
      }
    );
    (async () => {
      for (const data of frames) await receiver.handleMessage({ data });
      // Give a failure that fires on the last frame a tick to surface
      setTimeout(() => resolve({ timeout: true }), 100);
    })();
  });
}

async function run() {
  console.log('🧪 Starting protocol, key transport and server hardening tests...\n');

  console.log('Test 1: Key travels as base64url and round-trips...');
  const key = await generateAESKey();
  const encodedKey = await keyToBase64Url(key);
  assert.strictEqual(encodedKey.length, 43, '32 bytes encode to 43 base64url chars');
  assert(/^[A-Za-z0-9_-]+$/.test(encodedKey));
  const imported = await keyFromBase64Url(encodedKey);
  const sample = new Uint8Array(100).fill(9).buffer;
  const ct = await encryptChunk(key, sample, 0);
  const pt = await require('./chunkCrypto').decryptChunk(imported, ct, 0);
  assert.deepStrictEqual(new Uint8Array(pt), new Uint8Array(sample));
  await expectReject(keyFromBase64Url('AAAA'), /malformed/i, 'short key');
  await expectReject(keyFromBase64Url('not valid!'), /base64url/i, 'bad characters');
  assert.deepStrictEqual(
    base64UrlToBytes(bytesToBase64Url(new Uint8Array([250, 251, 252]))),
    new Uint8Array([250, 251, 252])
  );
  console.log('  ✅ Key encoding round-trips and malformed keys are rejected.\n');

  console.log('Test 2: Share link parsing...');
  const frag = buildShareFragment('abc123', encodedKey);
  assert.deepStrictEqual(parseShareInput(`https://x.example/#${frag}`), {
    roomCode: 'ABC123',
    key: encodedKey
  });
  assert.deepStrictEqual(parseShareInput(`#${frag}`).key, encodedKey);
  assert.deepStrictEqual(parseShareInput('  abc123 '), { roomCode: 'ABC123', key: null });
  assert.strictEqual(parseShareInput('ABC123.short'), null, 'truncated key is not accepted');
  assert.strictEqual(parseShareInput('ABC12'), null);
  assert.strictEqual(parseShareInput('https://x.example/'), null);
  assert.strictEqual(parseShareInput(null), null);
  console.log('  ✅ Links, fragments and bare codes parse; the key keeps its case.\n');

  console.log('Test 3: Encrypted file header...');
  const header = {
    fileName: 'a.txt',
    fileSize: 10,
    fileType: 'text/plain',
    totalChunks: 1,
    fileIndex: 0,
    fileCount: 1,
    totalBytes: 10
  };
  const sealed = await encryptHeader(key, header);
  assert(!sealed.includes('a.txt'), 'header must not be readable on the wire');
  assert.deepStrictEqual(await decryptHeader(imported, sealed), header);
  await expectReject(decryptHeader(key, sealed, 1), null, 'header replayed at another position');
  const sealedSecond = await encryptHeader(key, { ...header, fileIndex: 1, fileCount: 2 }, 1);
  assert.strictEqual((await decryptHeader(key, sealedSecond, 1)).fileIndex, 1);
  await expectReject(decryptHeader(key, sealedSecond, 0), null, 'second header read as first');
  const wrongKey = await generateAESKey();
  await expectReject(decryptHeader(wrongKey, sealed), null, 'wrong key header');
  const tampered = base64UrlToBytes(sealed);
  tampered[0] ^= 1;
  await expectReject(decryptHeader(key, bytesToBase64Url(tampered)), null, 'tampered header');
  console.log('  ✅ Header is confidential, authenticated, and bound to the link key.\n');

  console.log('Test 4: Header validation and file name sanitising...');
  assert.deepStrictEqual(
    validateFileHeader({ ...header, fileSize: 0, totalChunks: 1 }).fileSize,
    0
  );
  assert.throws(() => validateFileHeader({ ...header, totalChunks: 5 }), /chunk count/);
  assert.throws(() => validateFileHeader({ ...header, fileSize: -1 }), /size/);
  assert.throws(() => validateFileHeader({ ...header, fileSize: 1.5 }), /size/);
  assert.throws(() => validateFileHeader(null), /Malformed/);
  // Batch rules: position, count and total size must be coherent and stay fixed mid-session
  assert.throws(() => validateFileHeader({ ...header, fileIndex: 1 }), /out of order/);
  assert.throws(() => validateFileHeader(header, { fileIndex: 1 }), /out of order/);
  assert.throws(() => validateFileHeader({ ...header, fileCount: 0 }), /file count/);
  assert.throws(() => validateFileHeader({ ...header, fileCount: 1001 }), /file count/);
  assert.throws(() => validateFileHeader({ ...header, totalBytes: 5 }), /batch size/);
  assert.throws(() => validateFileHeader({ ...header, totalBytes: 2 ** 60 }), /batch size/);
  assert.throws(
    () =>
      validateFileHeader({ ...header, fileIndex: 1, fileCount: 3 }, { fileIndex: 1, fileCount: 2 }),
    /count changed/
  );
  assert.throws(
    () => validateFileHeader({ ...header, totalBytes: 99 }, { fileIndex: 0, totalBytes: 10 }),
    /batch size changed/
  );
  assert.strictEqual(
    validateFileHeader(
      { ...header, fileIndex: 1, fileCount: 2, totalBytes: 30 },
      { fileIndex: 1, fileCount: 2, totalBytes: 30 }
    ).fileIndex,
    1
  );
  assert.strictEqual(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeFileName('C:\\Users\\x\\evil.exe'), 'evil.exe');
  assert.strictEqual(sanitizeFileName('..hidden'), 'hidden');
  assert.strictEqual(sanitizeFileName(''), 'downloaded-file');
  assert.strictEqual(sanitizeFileName(42), 'downloaded-file');
  assert(sanitizeFileName('x'.repeat(500) + '.pdf').endsWith('.pdf'));
  assert(sanitizeFileName('x'.repeat(500) + '.pdf').length <= 200);
  console.log('  ✅ Bad sizes, mismatched chunk counts and path tricks are rejected.\n');

  console.log('Test 5: Receiver enforces the declared file shape...');
  const size = CHUNK + 100;
  const fileHeader = { fileSize: size, totalChunks: 2 };
  const plain = crypto.randomBytes(size);
  const c0 = await encryptChunk(
    key,
    plain.buffer.slice(plain.byteOffset, plain.byteOffset + CHUNK),
    0
  );
  const c1 = await encryptChunk(
    key,
    plain.buffer.slice(plain.byteOffset + CHUNK, plain.byteOffset + size),
    1
  );

  let out = await runReceiver(imported, fileHeader, [c0, c1]);
  assert(out.result, 'valid stream completes');
  assert.deepStrictEqual(Buffer.from(await out.result.blob.arrayBuffer()), plain);

  out = await runReceiver(imported, fileHeader, [c0, c1, c1]);
  assert(out.result, 'completion is reported before the extra frame');
  out = await runReceiver(imported, fileHeader, [c0, c1.slice(0, 50)]);
  assert(out.error && /unexpected size/.test(out.error.message), 'short last chunk rejected');
  out = await runReceiver(imported, fileHeader, [c1, c0]);
  assert(out.error, 'reordered chunks fail authentication');
  const flipped = new Uint8Array(c0.slice(0));
  flipped[10] ^= 0xff;
  out = await runReceiver(imported, fileHeader, [flipped.buffer, c1]);
  assert(out.error, 'bit flip fails authentication');
  out = await runReceiver(imported, fileHeader, [new ArrayBuffer(CHUNK + 17)]);
  assert(out.error && /Invalid encrypted chunk size/.test(out.error.message), 'oversized frame');
  out = await runReceiver(imported, { fileSize: CHUNK, totalChunks: 1 }, [c0, c0]);
  assert(out.result, 'single-chunk file completes on its declared chunk');
  const exact = crypto.randomBytes(CHUNK * 2);
  const e0 = await encryptChunk(
    key,
    exact.buffer.slice(exact.byteOffset, exact.byteOffset + CHUNK),
    0
  );
  const e1 = await encryptChunk(
    key,
    exact.buffer.slice(exact.byteOffset + CHUNK, exact.byteOffset + CHUNK * 2),
    1
  );
  out = await runReceiver(imported, { fileSize: CHUNK * 2, totalChunks: 2 }, [e0, e1]);
  assert(out.result, 'exact 64 KB multiple completes');
  assert.deepStrictEqual(Buffer.from(await out.result.blob.arrayBuffer()), exact);
  console.log('  ✅ Tampering, reordering, truncation and oversize frames are rejected.\n');

  console.log('Test 5b: Multi-file nonce ranges and receiver sinks...');
  assert.deepStrictEqual(
    deriveNonce(nonceIndex(0, 7)),
    deriveNonce(7),
    'file 0 keeps legacy nonces'
  );
  assert.notDeepStrictEqual(deriveNonce(nonceIndex(0, 0)), deriveNonce(nonceIndex(1, 0)));
  const seen = new Set();
  for (let f = 0; f < 5; f++) {
    for (let c = 0; c < 5; c++)
      seen.add(Buffer.from(deriveNonce(nonceIndex(f, c))).toString('hex'));
    seen.add(Buffer.from(deriveNonce(nonceIndex(f, HEADER_NONCE_INDEX))).toString('hex'));
  }
  assert.strictEqual(seen.size, 30, 'no nonce repeats across files, chunks and headers');
  assert.throws(() => nonceIndex(-1, 0), RangeError);
  assert.throws(() => nonceIndex(2 ** 32, 0), RangeError);

  const one = { fileSize: CHUNK, totalChunks: 1 };
  const second = await encryptChunk(
    key,
    plain.buffer.slice(plain.byteOffset, plain.byteOffset + CHUNK),
    nonceIndex(1, 0)
  );
  out = await runReceiver(imported, one, [second], { fileIndex: 1 });
  assert(out.result, 'second file decrypts under its own nonce range');
  out = await runReceiver(imported, one, [second], { fileIndex: 0 });
  assert(out.error, 'file 1 data is rejected when read as file 0');
  out = await runReceiver(imported, one, [c0], { fileIndex: 1 });
  assert(out.error, 'file 0 data replayed as file 1 is rejected');

  const events = [];
  const spy = {
    kind: 'spy',
    async write(buffer) {
      events.push(`write ${buffer.byteLength}`);
    },
    async finalize() {
      events.push('finalize');
      return new Blob([]);
    },
    async abort() {
      events.push('abort');
    },
    async cleanup() {}
  };
  out = await runReceiver(imported, fileHeader, [c0, c1], { sink: spy });
  assert.deepStrictEqual(events, [`write ${CHUNK}`, 'write 100', 'finalize']);
  assert.strictEqual(out.result.storage, 'spy');
  events.length = 0;
  out = await runReceiver(imported, fileHeader, [flipped.buffer, c1], { sink: spy });
  assert(out.error && events.includes('abort'), 'sink is aborted when a chunk fails');

  assert.strictEqual((await createReceiverSink(10 ** 10)).kind, 'memory', 'no disk API in Node');
  const memory = new MemorySink();
  await memory.write(new Uint8Array([1, 2]).buffer);
  await memory.write(new Uint8Array([3]).buffer);
  assert.deepStrictEqual(
    Buffer.from(await (await memory.finalize('text/plain')).arrayBuffer()),
    Buffer.from([1, 2, 3])
  );
  console.log('  ✅ Per-file nonce ranges, replay rejection, pluggable sinks.\n');

  console.log('Test 6: Static file allowlist...');
  assert(resolveStaticFile('/'), 'index is served');
  assert(resolveStaticFile('/app.js'), 'public script is served');
  assert(resolveStaticFile('/fileWorker.js'), 'allowlisted root script is served');
  for (const bad of [
    '/server.js',
    '/package.json',
    '/.git/config',
    '/node_modules/ws/package.json',
    '/test.js',
    '/../server.js',
    '/%2e%2e/server.js',
    '/..%2fserver.js',
    '/public/../server.js',
    '/%00',
    '/a\\..\\server.js'
  ]) {
    assert.strictEqual(resolveStaticFile(bad), null, `${bad} must not be served`);
  }
  console.log('  ✅ Only public/ and the five browser scripts are reachable.\n');

  console.log('Test 7: ICE config...');
  const stunOnly = buildIceConfig({}, 0);
  assert.strictEqual(stunOnly.iceServers.length, 1);
  const turn = buildIceConfig(
    {
      TURN_URL: 'turn:t.example:3478, turns:t.example:5349',
      TURN_SECRET: 'sekret',
      TURN_TTL: '600'
    },
    1_000_000
  );
  const turnEntry = turn.iceServers[1];
  assert.deepStrictEqual(turnEntry.urls, ['turn:t.example:3478', 'turns:t.example:5349']);
  assert.strictEqual(turnEntry.username, String(1000 + 600));
  assert.strictEqual(
    turnEntry.credential,
    crypto.createHmac('sha1', 'sekret').update('1600').digest('base64'),
    'matches coturn use-auth-secret'
  );
  assert(!JSON.stringify(turn).includes('sekret'), 'secret itself is never exposed');
  const fixed = buildIceConfig({ TURN_URL: 'turn:t:1', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  assert.strictEqual(fixed.iceServers[1].username, 'u');
  assert.strictEqual(
    buildIceConfig({ TURN_URL: 'turn:t:1' }).iceServers.length,
    1,
    'no creds, no TURN'
  );
  console.log('  ✅ STUN default, static TURN and time-limited TURN credentials.\n');

  console.log('Test 8: HTTP responses...');
  const app = createSignalingServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  try {
    const page = await get(port, '/');
    assert.strictEqual(page.status, 200);
    const csp = page.headers['content-security-policy'];
    assert(/script-src 'self'/.test(csp));
    assert(!/unsafe-inline|googleapis|gstatic/.test(csp), 'strict CSP, no third-party hosts');
    assert.strictEqual(page.headers['cache-control'], 'no-store');
    for (const asset of ['/vendor/qrcode.js', '/favicon.svg', '/style.css', '/app.js']) {
      assert.strictEqual((await get(port, asset)).status, 200, `${asset} is served`);
    }
    const html = page.body;
    // The strict CSP forbids inline styles and scripts, so the markup must not rely on them
    assert(!/\sstyle=/i.test(html), 'no inline style attributes');
    assert(!/<style[\s>]/i.test(html), 'no <style> blocks');
    assert(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'no inline scripts');
    assert(!/fonts\.googleapis|fonts\.gstatic/.test(html), 'page makes no third-party requests');
    assert.strictEqual(page.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(page.headers['cache-control'], 'no-store');
    for (const hidden of ['/.git/config', '/server.js', '/package.json', '/%2e%2e/server.js']) {
      assert.strictEqual((await get(port, hidden)).status, 404, `${hidden} must be 404`);
    }
    assert.strictEqual((await get(port, '/fileWorker.js')).status, 200);
    const ice = JSON.parse((await get(port, '/ice-config')).body);
    assert(Array.isArray(ice.iceServers) && ice.iceServers.length >= 1);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
  console.log('  ✅ Security headers present; project files outside the allowlist return 404.\n');

  console.log('🎉 ALL PROTOCOL & HARDENING TESTS PASSED!');
}

run().catch((err) => {
  console.error('❌ Protocol test failed:', err);
  process.exit(1);
});
