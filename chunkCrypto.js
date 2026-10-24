'use strict';

/**
 * AES-GCM chunk cryptography and share-link helpers.
 *
 * Wrapped in a closure so that loading this file as a classic <script> or via importScripts()
 * never creates top-level lexical bindings that collide with other scripts. Exports go to
 * module.exports under Node and onto the global object in browsers and Web Workers.
 */
(function (root) {
  /**
   * Helper to obtain the WebCrypto subtle interface across Browser, Web Worker, and Node.js environments.
   * @returns {SubtleCrypto}
   */
  function getSubtleCrypto() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto.subtle;
    }
    try {
      const nodeCrypto = require('crypto');
      if (nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) {
        return nodeCrypto.webcrypto.subtle;
      }
    } catch {}
    throw new Error(
      'WebCrypto (crypto.subtle) is unavailable. Browsers only expose it on HTTPS or localhost.'
    );
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
   * Exports a CryptoKey to a raw 32-byte ArrayBuffer.
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
   * @param {boolean} [extractable] Whether the imported key may be exported again (default true)
   * @returns {Promise<CryptoKey>}
   */
  async function importRawKey(rawKey, extractable = true) {
    const subtle = getSubtleCrypto();
    const keyBuffer = ArrayBuffer.isView(rawKey)
      ? rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength)
      : rawKey;
    return subtle.importKey(
      'raw',
      keyBuffer,
      {
        name: 'AES-GCM',
        length: 256
      },
      extractable,
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
    const { readFileChunksDetailed } =
      typeof module !== 'undefined' && typeof require === 'function'
        ? require('./fileChunker')
        : root;

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

  // ---------------------------------------------------------------------------------------------
  // Key transport and authenticated file header
  // ---------------------------------------------------------------------------------------------

  /**
   * Low 64 bits of the nonce reserved for a file's header. Data chunks use their chunk index
   * (always < 2^53), so the header can never share a key/nonce pair with a data chunk.
   */
  const HEADER_NONCE_INDEX = (1n << 64n) - 1n;

  /**
   * Nonce counter for one chunk of one file in a multi-file session: the file index fills the
   * high 32 bits and the chunk index the low 64 bits, so every file gets its own nonce range under
   * the shared key and no key/nonce pair is ever reused.
   * @param {number} fileIndex 0-based position of the file in the session
   * @param {number|bigint} chunkIndex
   * @returns {bigint}
   */
  function nonceIndex(fileIndex, chunkIndex) {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 0xffffffff) {
      throw new RangeError('fileIndex must be an integer between 0 and 2^32-1');
    }
    return (BigInt(fileIndex) << 64n) | BigInt(chunkIndex);
  }

  /** Length of a base64url-encoded 32-byte key without padding. */
  const KEY_BASE64URL_LENGTH = 43;

  /**
   * @param {Uint8Array|ArrayBuffer} input
   * @returns {string} URL-safe base64 without padding
   */
  function bytesToBase64Url(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * @param {string} text URL-safe base64 (padding optional)
   * @returns {Uint8Array}
   */
  function base64UrlToBytes(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) {
      throw new Error('Invalid base64url string');
    }
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * @param {CryptoKey} cryptoKey
   * @returns {Promise<string>} base64url of the raw 256-bit key, for the URL fragment
   */
  async function keyToBase64Url(cryptoKey) {
    return bytesToBase64Url(await exportRawKey(cryptoKey));
  }

  /**
   * @param {string} text base64url of a raw 256-bit key
   * @returns {Promise<CryptoKey>} Non-extractable AES-GCM key
   */
  async function keyFromBase64Url(text) {
    const bytes = base64UrlToBytes(text);
    if (bytes.length !== 32) {
      throw new Error('Encryption key in the link is malformed');
    }
    return importRawKey(bytes, false);
  }

  /**
   * Builds the URL fragment (without "#") that carries the room code and the key.
   * Browsers never send the fragment to the server.
   * @param {string} roomCode
   * @param {string} keyBase64Url
   * @returns {string}
   */
  function buildShareFragment(roomCode, keyBase64Url) {
    return `${roomCode}.${keyBase64Url}`;
  }

  /**
   * Parses a pasted share link, "#CODE.KEY", "CODE.KEY" or a bare "CODE".
   * @param {string} input
   * @returns {{ roomCode: string, key: string|null }|null} null if the input is not recognisable
   */
  function parseShareInput(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    const hashIndex = trimmed.lastIndexOf('#');
    const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : trimmed;
    const match = /^([A-Za-z0-9]{6})(?:\.([A-Za-z0-9_-]+))?$/.exec(fragment);
    if (!match) return null;
    const key = match[2] || null;
    if (key !== null && key.length !== KEY_BASE64URL_LENGTH) return null;
    return { roomCode: match[1].toUpperCase(), key };
  }

  /**
   * Encrypts the file metadata so a relay cannot alter the file name or size undetected.
   * @param {CryptoKey} cryptoKey
   * @param {object} header JSON-serialisable metadata
   * @param {number} [fileIndex] Position of the file in the session (selects the nonce range)
   * @returns {Promise<string>} base64url ciphertext
   */
  async function encryptHeader(cryptoKey, header, fileIndex = 0) {
    const plaintext = new TextEncoder().encode(JSON.stringify(header));
    const encrypted = await encryptChunk(
      cryptoKey,
      plaintext,
      nonceIndex(fileIndex, HEADER_NONCE_INDEX)
    );
    return bytesToBase64Url(encrypted);
  }

  /**
   * @param {CryptoKey} cryptoKey
   * @param {string} encoded base64url ciphertext produced by encryptHeader
   * @param {number} [fileIndex] Position the header is expected at
   * @returns {Promise<object>} Parsed metadata (still untrusted, validate before use)
   */
  async function decryptHeader(cryptoKey, encoded, fileIndex = 0) {
    const bytes = base64UrlToBytes(encoded);
    // The expected position is part of the nonce, so a header replayed at another position
    // in the session fails authentication.
    const plaintext = await decryptChunk(
      cryptoKey,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      nonceIndex(fileIndex, HEADER_NONCE_INDEX)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  const api = {
    getSubtleCrypto,
    deriveNonce,
    generateAESKey,
    exportRawKey,
    importRawKey,
    encryptChunk,
    decryptChunk,
    readAndEncryptFileChunks,
    HEADER_NONCE_INDEX,
    nonceIndex,
    bytesToBase64Url,
    base64UrlToBytes,
    keyToBase64Url,
    keyFromBase64Url,
    buildShareFragment,
    parseShareInput,
    encryptHeader,
    decryptHeader
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
