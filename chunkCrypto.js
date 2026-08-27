'use strict';

/**
 * Helper to obtain the WebCrypto subtle interface across Browser, Web Worker, and Node.js environments.
 * @returns {SubtleCrypto}
 */
function getSubtleCrypto() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    return window.crypto.subtle;
  }
  if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) {
    return self.crypto.subtle;
  }
  try {
    const nodeCrypto = require('crypto');
    if (nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) {
      return nodeCrypto.webcrypto.subtle;
    }
  } catch {}
  throw new Error('WebCrypto API (crypto.subtle) is not available in this environment');
}

/**
 * Derives a strict, deterministic 96-bit (12-byte) initialization vector (IV / Nonce)
 * formatted as a big-endian counter starting at 0 for chunk 0.
 *
 * Example:
 *   chunk 0: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
 *   chunk 1: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]
 *
 * @param {number|bigint} chunkIndex Non-negative chunk index counter
 * @returns {Uint8Array} 12-byte Uint8Array IV
 */
function deriveNonce(chunkIndex) {
  if (typeof chunkIndex !== 'number' && typeof chunkIndex !== 'bigint') {
    throw new TypeError('chunkIndex must be a non-negative number or BigInt');
  }
  const bigIndex = BigInt(chunkIndex);
  if (bigIndex < 0n) {
    throw new RangeError('chunkIndex must be non-negative');
  }

  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);

  // Bytes 0..3: High 32 bits (bits 64..95)
  const high32 = Number(bigIndex >> 64n);
  view.setUint32(0, high32, false);

  // Bytes 4..11: Low 64 bits (bits 0..63)
  const low64 = bigIndex & 0xffffffffffffffffn;
  view.setBigUint64(4, low64, false);

  return iv;
}

/**
 * Generates a cryptographically secure 256-bit AES-GCM CryptoKey.
 * @returns {Promise<CryptoKey>}
 */
async function generateAESKey() {
  const subtle = getSubtleCrypto();
  return subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256
    },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Exports a CryptoKey to a raw 32-byte ArrayBuffer for secure P2P key exchange.
 * @param {CryptoKey} cryptoKey
 * @returns {Promise<ArrayBuffer>}
 */
async function exportRawKey(cryptoKey) {
  const subtle = getSubtleCrypto();
  return subtle.exportKey('raw', cryptoKey);
}

/**
 * Imports a raw 32-byte (256-bit) ArrayBuffer or Uint8Array into an AES-GCM CryptoKey.
 * @param {ArrayBuffer|Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
async function importRawKey(rawKey) {
  const subtle = getSubtleCrypto();
  const keyBuffer = rawKey instanceof Uint8Array ? rawKey.buffer : rawKey;
  return subtle.importKey(
    'raw',
    keyBuffer,
    {
      name: 'AES-GCM',
      length: 256
    },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a single 64KB ArrayBuffer chunk using AES-GCM (256-bit) with a deterministic 96-bit nonce.
 * Appends a 16-byte authentication tag to the ciphertext (65,536 bytes raw -> 65,552 bytes encrypted).
 *
 * @param {CryptoKey} cryptoKey 256-bit AES-GCM key
 * @param {ArrayBuffer} chunkArrayBuffer Raw plaintext chunk
 * @param {number|bigint} chunkIndex Chunk index (used for deterministic nonce derivation)
 * @returns {Promise<ArrayBuffer>} Ciphertext + 16-byte tag
 */
async function encryptChunk(cryptoKey, chunkArrayBuffer, chunkIndex) {
  const subtle = getSubtleCrypto();
  const iv = deriveNonce(chunkIndex);

  return subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      tagLength: 128 // 16-byte authentication tag
    },
    cryptoKey,
    chunkArrayBuffer
  );
}

/**
 * Decrypts a single encrypted chunk ArrayBuffer using AES-GCM (256-bit) with the matching deterministic nonce.
 *
 * @param {CryptoKey} cryptoKey 256-bit AES-GCM key
 * @param {ArrayBuffer} encryptedBuffer Ciphertext + tag (e.g. 65,552 bytes)
 * @param {number|bigint} chunkIndex Matching chunk index
 * @returns {Promise<ArrayBuffer>} Decrypted raw ArrayBuffer (e.g. 65,536 bytes)
 */
async function decryptChunk(cryptoKey, encryptedBuffer, chunkIndex) {
  const subtle = getSubtleCrypto();
  const iv = deriveNonce(chunkIndex);

  return subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      tagLength: 128
    },
    cryptoKey,
    encryptedBuffer
  );
}

/**
 * Asynchronous iterator that reads a file in strict 64 KB chunks and sequentially encrypts each chunk.
 * Guarantees zero whole-file memory buffering.
 *
 * @param {Blob|File} file
 * @param {CryptoKey} cryptoKey
 * @param {object} [options]
 * @param {import('./fileChunker').FlowController} [options.controller] FlowController for pause/resume
 * @param {AbortSignal} [options.signal] Standard AbortSignal
 * @returns {AsyncGenerator<{ encryptedChunk: ArrayBuffer, chunkIndex: number, offset: number, byteLength: number, isLast: boolean, totalChunks: number }, void, unknown>}
 */
async function* readAndEncryptFileChunks(file, cryptoKey, options = {}) {
  // Safe import / reference for fileChunker functions
  const { readFileChunksDetailed } =
    typeof module !== 'undefined' && typeof require === 'function'
      ? require('./fileChunker')
      : { readFileChunksDetailed: self.readFileChunksDetailed };

  for await (const chunkInfo of readFileChunksDetailed(file, options)) {
    const { chunk, index, offset, isLast, totalChunks } = chunkInfo;

    // Encrypt individual chunk sequentially
    const encrypted = await encryptChunk(cryptoKey, chunk, index);

    yield {
      encryptedChunk: encrypted,
      chunkIndex: index,
      offset,
      byteLength: encrypted.byteLength,
      isLast,
      totalChunks
    };
  }
}

// Module exports for Node / bundler environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getSubtleCrypto,
    deriveNonce,
    generateAESKey,
    exportRawKey,
    importRawKey,
    encryptChunk,
    decryptChunk,
    readAndEncryptFileChunks
  };
}

// Global attachment for Web Worker context
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.getSubtleCrypto = getSubtleCrypto;
  self.deriveNonce = deriveNonce;
  self.generateAESKey = generateAESKey;
  self.exportRawKey = exportRawKey;
  self.importRawKey = importRawKey;
  self.encryptChunk = encryptChunk;
  self.decryptChunk = decryptChunk;
  self.readAndEncryptFileChunks = readAndEncryptFileChunks;
}
