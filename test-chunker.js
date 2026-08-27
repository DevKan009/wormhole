'use strict';

const assert = require('assert');
const {
  CHUNK_SIZE,
  FlowController,
  readSliceAsArrayBuffer,
  readFileChunks,
  readFileChunksDetailed
} = require('./fileChunker');

// Polyfill minimal FileReader for Node.js test environment if not present
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class MockFileReader {
    readAsArrayBuffer(blob) {
      if (typeof blob.arrayBuffer === 'function') {
        blob
          .arrayBuffer()
          .then((buf) => {
            this.result = buf;
            if (typeof this.onload === 'function') this.onload();
          })
          .catch((err) => {
            this.error = err;
            if (typeof this.onerror === 'function') this.onerror();
          });
      } else {
        const err = new Error('Blob.arrayBuffer not available on mock');
        this.error = err;
        if (typeof this.onerror === 'function') this.onerror();
      }
    }
  };
}

// Helper to create test Blobs/Files of arbitrary sizes
function createTestBlob(sizeInBytes) {
  const buffer = new Uint8Array(sizeInBytes);
  for (let i = 0; i < sizeInBytes; i++) {
    buffer[i] = i % 256;
  }
  return new Blob([buffer], { type: 'application/octet-stream' });
}

async function runTests() {
  console.log('🧪 Starting 64KB Web Worker Chunked File Reader Tests...\n');

  // Test 1: Constant Check
  console.log('Test 1: Strict chunk size verification...');
  assert.strictEqual(CHUNK_SIZE, 65536, 'CHUNK_SIZE must be strictly 65,536 bytes (64 KB)');
  console.log('  ✅ CHUNK_SIZE is 65,536 bytes.\n');

  // Test 2: Multi-Megabyte File Chunking (e.g. 200,000 bytes = 3 x 64KB + 3,392 bytes)
  console.log('Test 2: Multi-chunk file reading with readFileChunks...');
  const testSize = 200000;
  const testBlob = createTestBlob(testSize);
  const chunks = [];

  for await (const chunk of readFileChunks(testBlob)) {
    assert(chunk instanceof ArrayBuffer, 'Each yielded item must be an ArrayBuffer');
    chunks.push(chunk);
  }

  assert.strictEqual(
    chunks.length,
    Math.ceil(testSize / CHUNK_SIZE),
    'Chunk count must match ceil(size / 64KB)'
  );
  assert.strictEqual(chunks[0].byteLength, 65536, 'Chunk 0 must be exactly 65,536 bytes');
  assert.strictEqual(chunks[1].byteLength, 65536, 'Chunk 1 must be exactly 65,536 bytes');
  assert.strictEqual(chunks[2].byteLength, 65536, 'Chunk 2 must be exactly 65,536 bytes');
  assert.strictEqual(
    chunks[3].byteLength,
    testSize - 3 * 65536,
    'Chunk 3 (last) must be the exact remainder (3,392 bytes)'
  );

  const totalReadBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  assert.strictEqual(totalReadBytes, testSize, 'Total read bytes must match original file size');
  console.log(
    '  ✅ 200,000-byte file correctly yielded four individual 64KB ArrayBuffers with correct remainder.\n'
  );

  // Test 3: Exact multiple of 64KB (131,072 bytes = exactly 2 x 64KB)
  console.log('Test 3: Exact multiple of 64KB (128 KB file)...');
  const exactBlob = createTestBlob(65536 * 2);
  const exactChunks = [];
  for await (const chunk of readFileChunks(exactBlob)) {
    exactChunks.push(chunk);
  }
  assert.strictEqual(exactChunks.length, 2);
  assert.strictEqual(exactChunks[0].byteLength, 65536);
  assert.strictEqual(exactChunks[1].byteLength, 65536);
  console.log('  ✅ Exact multiple yielded 2 uniform 65,536 byte chunks.\n');

  // Test 4: Small file (< 64KB, e.g. 1024 bytes)
  console.log('Test 4: Small file (< 64KB)...');
  const smallBlob = createTestBlob(1024);
  const smallChunks = [];
  for await (const chunk of readFileChunks(smallBlob)) {
    smallChunks.push(chunk);
  }
  assert.strictEqual(smallChunks.length, 1);
  assert.strictEqual(smallChunks[0].byteLength, 1024);
  console.log('  ✅ Small file yielded 1 chunk of 1,024 bytes.\n');

  // Test 5: 0-byte file edge case
  console.log('Test 5: 0-byte empty file...');
  const emptyBlob = createTestBlob(0);
  const emptyChunks = [];
  for await (const chunk of readFileChunks(emptyBlob)) {
    emptyChunks.push(chunk);
  }
  assert.strictEqual(emptyChunks.length, 1);
  assert.strictEqual(emptyChunks[0].byteLength, 0);
  console.log('  ✅ 0-byte file handled safely without error.\n');

  // Test 6: Flow Controller - Pause and Resume Mechanism
  console.log('Test 6: External Pause and Resume Flow Control...');
  const largeBlob = createTestBlob(65536 * 8); // 8 chunks (512 KB)
  const controller = new FlowController();
  const receivedIndices = [];
  let wasPausedObserved = false;

  const readPromise = (async () => {
    for await (const { index } of readFileChunksDetailed(largeBlob, { controller })) {
      receivedIndices.push(index);

      // When reaching chunk index 2, pause the stream externally
      if (index === 2) {
        controller.pause();
      }
    }
  })();

  // Wait a small duration to allow loop to encounter paused state
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(controller.isPaused, true, 'Controller should report isPaused = true');
  assert.deepStrictEqual(receivedIndices, [0, 1, 2], 'Iteration must not advance while paused');
  wasPausedObserved = true;

  // Resume externally
  controller.resume();
  assert.strictEqual(controller.isPaused, false, 'Controller should report isPaused = false');

  await readPromise;
  assert.strictEqual(wasPausedObserved, true);
  assert.deepStrictEqual(
    receivedIndices,
    [0, 1, 2, 3, 4, 5, 6, 7],
    'All 8 chunks must be yielded sequentially after resuming'
  );
  console.log(
    '  ✅ Iteration paused cleanly at chunk 2, suspended reads, and resumed to completion on signal.\n'
  );

  // Test 7: Flow Controller - Abort / Cancellation
  console.log('Test 7: Abort / Cancellation...');
  const abortController = new FlowController();
  let caughtAbort = false;

  try {
    const abortBlob = createTestBlob(65536 * 10);
    for await (const chunk of readFileChunks(abortBlob, { controller: abortController })) {
      abortController.abort('Backpressure limit exceeded');
    }
  } catch (err) {
    caughtAbort = true;
    assert.strictEqual(err.message, 'Backpressure limit exceeded');
  }
  assert.strictEqual(caughtAbort, true, 'Abort must reject and terminate generator');
  console.log('  ✅ Generator cleanly aborted mid-iteration on signal.\n');

  // Test 8: Data Integrity Verification
  console.log('Test 8: Data byte verification across chunk boundaries...');
  const integritySize = 65536 * 3 + 12345;
  const integrityBlob = createTestBlob(integritySize);
  const reassembled = new Uint8Array(integritySize);
  let writePos = 0;

  for await (const chunk of readFileChunks(integrityBlob)) {
    reassembled.set(new Uint8Array(chunk), writePos);
    writePos += chunk.byteLength;
  }

  assert.strictEqual(writePos, integritySize);
  for (let i = 0; i < integritySize; i++) {
    assert.strictEqual(reassembled[i], i % 256, `Byte at index ${i} corrupted`);
  }
  console.log('  ✅ Reassembled byte stream is byte-for-byte identical to source data.\n');

  console.log('🎉 ALL 8 TESTS PASSED SUCCESSFULLY! Ready for Web Worker integration.');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
