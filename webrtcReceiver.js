'use strict';

const { importRawKey, decryptChunk } =
  typeof module !== 'undefined' && typeof require === 'function'
    ? require('./chunkCrypto')
    : {
        importRawKey: self.importRawKey,
        decryptChunk: self.decryptChunk
      };

/**
 * WebRTCFileReceiver handles receiving encrypted ArrayBuffer chunks across an RTCDataChannel,
 * decrypting them sequentially with matching deterministic nonces, and assembling the final Blob/File.
 */
class WebRTCFileReceiver {
  /**
   * @param {RTCDataChannel} dataChannel
   * @param {object} [options]
   * @param {CryptoKey|ArrayBuffer} [options.key] AES-GCM 256-bit key
   * @param {number} [options.expectedTotalChunks] Total chunks expected
   * @param {string} [options.fileName] Name of the file being received
   * @param {string} [options.fileType] MIME type of the file
   * @param {Function} [options.onChunkReceived] Callback ({ chunkIndex, decryptedChunk, totalChunks, isLast })
   * @param {Function} [options.onProgress] Callback ({ bytesReceived, chunksReceived, totalChunks, progressPercentage })
   * @param {Function} [options.onComplete] Callback ({ blob, totalBytes, totalChunks, fileName })
   * @param {Function} [options.onError] Callback (Error)
   */
  constructor(dataChannel, options = {}) {
    if (!dataChannel) {
      throw new TypeError('An RTCDataChannel instance is required');
    }

    this.dataChannel = dataChannel;
    this.key = options.key || null;
    this.expectedTotalChunks = options.expectedTotalChunks || 0;
    this.fileName = options.fileName || 'received-file';
    this.fileType = options.fileType || 'application/octet-stream';

    this.chunksReceived = 0;
    this.bytesReceived = 0;
    this.decryptedChunks = [];
    this.isCompleted = false;
    this._messageQueue = Promise.resolve();

    this.onChunkReceived = options.onChunkReceived || null;
    this.onProgress = options.onProgress || null;
    this.onComplete = options.onComplete || null;
    this.onError = options.onError || null;

    this._setupDataChannel();
  }

  /**
   * Sets or updates the decryption key.
   * @param {CryptoKey|ArrayBuffer} key
   */
  async setKey(key) {
    if (key instanceof CryptoKey) {
      this.key = key;
    } else {
      this.key = await importRawKey(key);
    }
  }

  /**
   * Processes a single incoming message frame sequentially.
   * @private
   */
  async _processMessage(event) {
    const encryptedBuffer = event.data;
    if (!(encryptedBuffer instanceof ArrayBuffer)) {
      return;
    }

    if (!this.key) {
      throw new Error('Cannot decrypt chunk: AES key not yet provided to receiver');
    }

    const chunkIndex = this.chunksReceived;
    const decrypted = await decryptChunk(this.key, encryptedBuffer, chunkIndex);

    this.decryptedChunks.push(decrypted);
    this.bytesReceived += decrypted.byteLength;
    this.chunksReceived++;

    const isLast =
      (this.expectedTotalChunks > 0 && this.chunksReceived === this.expectedTotalChunks) ||
      encryptedBuffer.byteLength < 65536 + 16;

    if (typeof this.onChunkReceived === 'function') {
      this.onChunkReceived({
        chunkIndex,
        decryptedChunk: decrypted,
        totalChunks: this.expectedTotalChunks,
        isLast
      });
    }

    if (typeof this.onProgress === 'function') {
      const progressPercentage =
        this.expectedTotalChunks > 0
          ? Math.round((this.chunksReceived / this.expectedTotalChunks) * 100)
          : null;

      this.onProgress({
        bytesReceived: this.bytesReceived,
        chunksReceived: this.chunksReceived,
        totalChunks: this.expectedTotalChunks,
        progressPercentage
      });
    }

    if (isLast && !this.isCompleted) {
      this.isCompleted = true;
      const blob = new Blob(this.decryptedChunks, { type: this.fileType });
      if (typeof this.onComplete === 'function') {
        this.onComplete({
          blob,
          totalBytes: this.bytesReceived,
          totalChunks: this.chunksReceived,
          fileName: this.fileName
        });
      }
    }
  }

  /**
   * @private
   */
  _setupDataChannel() {
    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onmessage = (event) => {
      // Chain message processing sequentially to guarantee FIFO decryption
      this._messageQueue = this._messageQueue
        .then(() => this._processMessage(event))
        .catch((err) => {
          if (typeof this.onError === 'function') {
            this.onError(err);
          }
        });
    };

    this.dataChannel.onerror = (event) => {
      const err = event && event.error ? event.error : new Error('DataChannel error');
      if (typeof this.onError === 'function') {
        this.onError(err);
      }
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WebRTCFileReceiver };
}

if (typeof window !== 'undefined') {
  window.WebRTCFileReceiver = WebRTCFileReceiver;
}
