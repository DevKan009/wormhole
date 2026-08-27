'use strict';

const assert = require('assert');
const { CHUNK_SIZE, FlowController, readFileChunksDetailed } = require('./fileChunker');

const {
  deriveNonce,
  generateAESKey,
  exportRawKey,
  importRawKey,
  encryptChunk,
  decryptChunk,
  readAndEncryptFileChunks
} = require('./chunkCrypto');

// Helper to create test Blobs of arbitrary sizes
function createTestBlob(sizeInBytes) {
  const buffer = new Uint8Array(sizeInBytes);
  for (let i = 0; i < sizeInBytes; i++) {
    buffer[i] = (i * 31) % 256;
  }
  return new Blob([buffer], { type: 'application/octet-stream' });
}

async function runTests() {
  console.log('🧪 Starting WebCrypto AES-GCM 256-Bit Chunk Encryption Tests...\n');

  // Test 1: Deterministic 96-bit (12-byte) Nonce Derivation Sequence
  console.log('Test 1: Deterministic 96-bit nonce derivation sequence...');
  const nonce0 = deriveNonce(0);
  assert.strictEqual(nonce0.byteLength, 12, 'Nonce must be exactly 12 bytes (96 bits)');
  assert.deepStrictEqual(
    Array.from(nonce0),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Chunk 0 nonce must start at 0'
  );

  const nonce1 = deriveNonce(1);
  assert.strictEqual(nonce1.byteLength, 12);
  assert.deepStrictEqual(Array.from(nonce1), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

  const nonce255 = deriveNonce(255);
  assert.deepStrictEqual(Array.from(nonce255), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]);

  const nonce256 = deriveNonce(256);
  assert.deepStrictEqual(Array.from(nonce256), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);

  const nonce65536 = deriveNonce(65536);
  assert.deepStrictEqual(Array.from(nonce65536), [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);

  // Negative and invalid checks
  assert.throws(() => deriveNonce(-1), /must be non-negative/);
  assert.throws(() => deriveNonce('invalid'), /TypeError/);
  console.log('  ✅ 96-bit big-endian counter nonces verified from 0 upwards.\n');

  // Test 2: 256-bit AES-GCM Key Generation and Raw Key Export/Import
  console.log('Test 2: AES-GCM 256-bit key generation, export, and import...');
  const key = await generateAESKey();
  assert(key, 'Key generated');
  assert.strictEqual(key.algorithm.name, 'AES-GCM');
  assert.strictEqual(key.algorithm.length, 256);

  const rawKeyBuffer = await exportRawKey(key);
  assert.strictEqual(
    rawKeyBuffer.byteLength,
    32,
    'Exported raw key must be exactly 32 bytes (256 bits)'
  );

  const importedKey = await importRawKey(rawKeyBuffer);
  assert.strictEqual(importedKey.algorithm.name, 'AES-GCM');
  assert.strictEqual(importedKey.algorithm.length, 256);
  console.log('  ✅ 256-bit key generation and 32-byte raw export/import verified.\n');

  // Test 3: Single Chunk Encryption & 16-Byte Auth Tag Expansion
  console.log('Test 3: Single chunk encryption & 16-byte buffer expansion...');
  const rawChunk = new Uint8Array(65536);
  rawChunk.fill(0x42);

  const encryptedChunk = await encryptChunk(key, rawChunk.buffer, 0);
  assert.strictEqual(
    encryptedChunk.byteLength,
    65536 + 16,
    'AES-GCM 64KB raw chunk must result in exactly 65,552 bytes (64KB + 16-byte tag)'
  );
  console.log(
    `  ✅ 65,536 bytes raw -> ${encryptedChunk.byteLength} bytes encrypted (+16 byte tag).\n`
  );

  // Test 4: Round-Trip Decryption & Data Integrity
  console.log('Test 4: Round-trip chunk decryption & authenticity verification...');
  const decryptedChunk = await decryptChunk(key, encryptedChunk, 0);
  assert.strictEqual(decryptedChunk.byteLength, 65536);
  const decryptedView = new Uint8Array(decryptedChunk);
  assert(
    decryptedView.every((b) => b === 0x42),
    'Decrypted chunk data matches plaintext'
  );
  console.log('  ✅ Decrypted chunk byte-for-byte identical to original.\n');

  // Test 5: Nonce Mismatch & Tamper Protection
  console.log('Test 5: Nonce mismatch and tamper rejection...');
  // 5a. Nonce mismatch (decrypt chunk 0 with nonce for chunk 1)
  let nonceMismatchFailed = false;
  try {
    await decryptChunk(key, encryptedChunk, 1);
  } catch (err) {
    nonceMismatchFailed = true;
  }
  assert(nonceMismatchFailed, 'Decrypting with incorrect chunk index must fail authentication');

  // 5b. Tamper single byte in ciphertext
  const tampered = new Uint8Array(encryptedChunk.slice(0));
  tampered[10] ^= 0xff;
  let tamperFailed = false;
  try {
    await decryptChunk(key, tampered.buffer, 0);
  } catch (err) {
    tamperFailed = true;
  }
  assert(tamperFailed, 'Decrypting tampered ciphertext must fail authentication tag check');
  console.log('  ✅ Nonce mismatches and tampered ciphertext correctly rejected by AES-GCM.\n');

  // Test 6: Full File Sequential Chunked Encryption and Decryption
  console.log('Test 6: Multi-chunk file sequential encryption & streaming...');
  const fileSize = 65536 * 3 + 12345; // 3 full chunks + 1 remainder chunk (208,953 bytes)
  const testBlob = createTestBlob(fileSize);
  const originalBytes = new Uint8Array(await testBlob.arrayBuffer());

  const encryptedChunks = [];
  for await (const chunkMeta of readAndEncryptFileChunks(testBlob, key)) {
    assert(chunkMeta.encryptedChunk instanceof ArrayBuffer);
    assert.strictEqual(chunkMeta.chunkIndex, encryptedChunks.length);
    encryptedChunks.push(chunkMeta);
  }

  assert.strictEqual(encryptedChunks.length, 4, 'Must yield 4 chunks (3 full + 1 remainder)');
  assert.strictEqual(encryptedChunks[0].byteLength, 65536 + 16);
  assert.strictEqual(encryptedChunks[1].byteLength, 65536 + 16);
  assert.strictEqual(encryptedChunks[2].byteLength, 65536 + 16);
  assert.strictEqual(encryptedChunks[3].byteLength, 12345 + 16);

  // Decrypt all chunks and reassemble
  const reassembled = new Uint8Array(fileSize);
  let writeOffset = 0;
  for (const chunkMeta of encryptedChunks) {
    const decrypted = await decryptChunk(key, chunkMeta.encryptedChunk, chunkMeta.chunkIndex);
    reassembled.set(new Uint8Array(decrypted), writeOffset);
    writeOffset += decrypted.byteLength;
  }

  assert.strictEqual(writeOffset, fileSize);
  assert.deepStrictEqual(
    Array.from(reassembled),
    Array.from(originalBytes),
    'Reassembled decrypted file matches source'
  );
  console.log(
    '  ✅ 4 encrypted chunks sequentially streamed, decrypted, and reassembled with 100% fidelity.\n'
  );

  // Test 7: Pause and Resume with Encryption Active
  console.log('Test 7: Pause/Resume backpressure with active encryption...');
  const controller = new FlowController();
  const pauseBlob = createTestBlob(65536 * 6);
  const receivedEncrypted = [];

  const readEncPromise = (async () => {
    for await (const meta of readAndEncryptFileChunks(pauseBlob, key, { controller })) {
      receivedEncrypted.push(meta.chunkIndex);
      if (meta.chunkIndex === 1) {
        controller.pause();
      }
    }
  })();

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(controller.isPaused, true);
  assert.deepStrictEqual(receivedEncrypted, [0, 1]);

  controller.resume();
  await readEncPromise;
  assert.deepStrictEqual(receivedEncrypted, [0, 1, 2, 3, 4, 5]);
  console.log('  ✅ Sequential encryption cleanly paused and resumed via FlowController.\n');

  console.log('🎉 ALL WEB CRYPTO AES-GCM TESTS PASSED! 100% compliant with specifications.');
}

runTests().catch((err) => {
  console.error('❌ Crypto test suite failed:', err);
  process.exit(1);
});
