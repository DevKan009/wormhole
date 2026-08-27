'use strict';

const assert = require('assert');
const { WebRTCFileSender, BUFFER_HIGH_WATERMARK, BUFFER_LOW_WATERMARK } = require('./webrtcSender');
const { WebRTCFileReceiver } = require('./webrtcReceiver');
const { generateAESKey, exportRawKey, encryptChunk, decryptChunk } = require('./chunkCrypto');

// Mock EventEmitter / WebRTC primitives for testing in Node.js
class MockDataChannel {
  constructor() {
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.readyState = 'open';
    this.sentData = [];
    this.onbufferedamountlow = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  send(data) {
    if (this.readyState !== 'open') {
      throw new Error(`DataChannel readyState is ${this.readyState}`);
    }
    this.sentData.push(data);
    this.bufferedAmount += data.byteLength || 0;

    // If a receiver is connected, deliver asynchronously
    if (this.peerChannel && typeof this.peerChannel.onmessage === 'function') {
      setTimeout(() => {
        this.peerChannel.onmessage({ data });
      }, 0);
    }
  }

  // Helper to simulate buffer draining over network
  drain(bytesToDrain) {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytesToDrain);
    if (
      this.bufferedAmount <= this.bufferedAmountLowThreshold &&
      typeof this.onbufferedamountlow === 'function'
    ) {
      this.onbufferedamountlow();
    }
  }
}

class MockPeerConnection {
  constructor() {
    this.iceConnectionState = 'connected';
    this.oniceconnectionstatechange = null;
    this.listeners = {};
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  setState(newState) {
    this.iceConnectionState = newState;
    if (typeof this.oniceconnectionstatechange === 'function') {
      this.oniceconnectionstatechange();
    }
    if (this.listeners['iceconnectionstatechange']) {
      this.listeners['iceconnectionstatechange'].forEach((h) => h());
    }
  }
}

class MockWorker {
  constructor() {
    this.messages = [];
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(msg) {
    this.messages.push(msg);
  }

  emitMessage(data) {
    if (typeof this.onmessage === 'function') {
      this.onmessage({ data });
    }
  }
}

async function runTests() {
  console.log('🧪 Starting WebRTC Client Backpressure & Sender Tests...\n');

  // Test 1: Constants Verification
  console.log('Test 1: Backpressure threshold constants...');
  assert.strictEqual(
    BUFFER_HIGH_WATERMARK,
    1048576,
    'High watermark must be strictly 1 MB (1,048,576 bytes)'
  );
  assert.strictEqual(
    BUFFER_LOW_WATERMARK,
    262144,
    'Low watermark must be strictly 256 KB (262,144 bytes)'
  );
  console.log('  ✅ 1MB High and 256KB Low watermarks verified.\n');

  // Test 2: DataChannel Configuration
  console.log('Test 2: RTCDataChannel property initialization...');
  const dc = new MockDataChannel();
  const worker = new MockWorker();
  const pc = new MockPeerConnection();

  const sender = new WebRTCFileSender(dc, { worker, peerConnection: pc });
  assert.strictEqual(
    dc.binaryType,
    'arraybuffer',
    'DataChannel binaryType must be set to "arraybuffer"'
  );
  assert.strictEqual(
    dc.bufferedAmountLowThreshold,
    262144,
    'bufferedAmountLowThreshold must be set to 256KB (262,144 bytes)'
  );
  assert.strictEqual(
    typeof dc.onbufferedamountlow,
    'function',
    'onbufferedamountlow event must be hooked'
  );
  console.log(
    '  ✅ DataChannel initialized with binaryType = "arraybuffer" and threshold = 256KB.\n'
  );

  // Test 3: Backpressure High Watermark (> 1MB) Pause Trigger
  console.log('Test 3: Backpressure pause trigger when bufferedAmount > 1MB...');
  let backpressureChanges = [];
  sender.onBackpressureChange = (isPaused, currentBuffer) => {
    backpressureChanges.push({ isPaused, currentBuffer });
  };

  // Simulate sending 16 chunks of 65,552 bytes (approx 1,048,832 bytes > 1MB)
  const chunkSize = 65552;
  const chunkBuffer = new ArrayBuffer(chunkSize);

  for (let i = 0; i < 15; i++) {
    sender.sendChunk(chunkBuffer, i, false, 20);
  }
  // 15 * 65552 = 983,280 bytes (< 1MB) -> Should not be paused yet
  assert.strictEqual(sender.isWorkerPaused, false);
  assert.strictEqual(worker.messages.length, 0);

  // Send 16th chunk -> 16 * 65552 = 1,048,832 bytes (> 1MB threshold)
  sender.sendChunk(chunkBuffer, 15, false, 20);
  assert.strictEqual(sender.isWorkerPaused, true, 'Worker must be paused after passing 1MB');
  assert.strictEqual(worker.messages.length, 1);
  assert.deepStrictEqual(
    worker.messages[0],
    { type: 'PAUSE' },
    'Must send { type: "PAUSE" } to Web Worker'
  );
  console.log(
    `  ✅ Exceeded 1MB (${dc.bufferedAmount} bytes) -> Sent PAUSE signal to Web Worker.\n`
  );

  // Test 4: Backpressure Low Watermark (<= 256KB) Resume Trigger via onbufferedamountlow
  console.log('Test 4: Backpressure resume trigger via onbufferedamountlow (<= 256KB)...');
  // Drain partially to 500KB (still > 256KB)
  dc.drain(548832); // bufferedAmount is now 500,000 bytes
  assert.strictEqual(sender.isWorkerPaused, true, 'Worker must remain paused while buffer > 256KB');
  assert.strictEqual(worker.messages.length, 1); // No new message

  // Drain down to 200KB (<= 256KB threshold) -> fires onbufferedamountlow
  dc.drain(300000); // bufferedAmount is now 200,000 bytes <= 262,144
  assert.strictEqual(
    sender.isWorkerPaused,
    false,
    'Worker must be resumed after falling below 256KB'
  );
  assert.strictEqual(worker.messages.length, 2);
  assert.deepStrictEqual(
    worker.messages[1],
    { type: 'RESUME' },
    'Must send { type: "RESUME" } to Web Worker'
  );
  console.log(
    `  ✅ Drained below 256KB (${dc.bufferedAmount} bytes) -> onbufferedamountlow triggered RESUME signal.\n`
  );

  // Test 5: ICE Connection State Change Handling (Disconnected / Failed)
  console.log('Test 5: RTCPeerConnection failure lifecycle handling...');
  let caughtError = null;
  sender.onError = (err) => {
    caughtError = err;
  };

  pc.setState('disconnected');
  assert(caughtError, 'Error callback must be triggered on disconnected ICE state');
  assert(caughtError.message.includes('disconnected'));
  assert.deepStrictEqual(worker.messages[2], {
    type: 'ABORT',
    reason: 'RTCPeerConnection ICE state transitioned to "disconnected"'
  });
  console.log(
    '  ✅ PeerConnection ICE disconnection cleanly caught and ABORT signal dispatched to worker.\n'
  );

  // Test 6: End-to-End Sender -> DataChannel -> Receiver Verification
  console.log(
    'Test 6: End-to-end encrypted transfer with WebRTCFileSender & WebRTCFileReceiver...'
  );
  const sendDc = new MockDataChannel();
  const recvDc = new MockDataChannel();
  sendDc.peerChannel = recvDc;
  recvDc.peerChannel = sendDc;

  const key = await generateAESKey();
  const rawKey = await exportRawKey(key);

  const receiver = new WebRTCFileReceiver(recvDc, {
    key,
    expectedTotalChunks: 3,
    fileName: 'test-transfer.bin'
  });

  const senderInstance = new WebRTCFileSender(sendDc);

  const rawBytes = new Uint8Array(65536 * 2 + 1000);
  rawBytes.fill(0x7a);

  // Send 3 encrypted chunks
  const encrypted0 = await encryptChunk(key, rawBytes.buffer.slice(0, 65536), 0);
  const encrypted1 = await encryptChunk(key, rawBytes.buffer.slice(65536, 131072), 1);
  const encrypted2 = await encryptChunk(key, rawBytes.buffer.slice(131072), 2);

  const completionPromise = new Promise((resolve) => {
    receiver.onComplete = resolve;
  });

  senderInstance.sendChunk(encrypted0, 0, false, 3);
  sendDc.drain(65552);

  senderInstance.sendChunk(encrypted1, 1, false, 3);
  sendDc.drain(65552);

  senderInstance.sendChunk(encrypted2, 2, true, 3);
  sendDc.drain(encrypted2.byteLength);

  const completedResult = await completionPromise;
  assert.strictEqual(completedResult.totalChunks, 3);
  assert.strictEqual(completedResult.totalBytes, rawBytes.byteLength);

  const receivedArrayBuffer = await completedResult.blob.arrayBuffer();
  assert.deepStrictEqual(new Uint8Array(receivedArrayBuffer), rawBytes);
  console.log(
    '  ✅ End-to-end sender transmission, DataChannel delivery, and receiver decryption verified.\n'
  );

  console.log(
    '🎉 ALL WEBRTC BACKPRESSURE & CLIENT SENDER TESTS PASSED! 100% compliant with specifications.'
  );
}

runTests().catch((err) => {
  console.error('❌ Backpressure test failed:', err);
  process.exit(1);
});
