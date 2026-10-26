'use strict';

(function (root) {
  /**
   * Strict Network Backpressure Watermarks per Architectural Specifications:
   * - High Watermark (Pause): 1 MB (1,048,576 bytes)
   * - Low Watermark (Resume): 256 KB (262,144 bytes)
   */
  const BUFFER_HIGH_WATERMARK = 1048576; // 1 MB (1 * 1024 * 1024 bytes)
  const BUFFER_LOW_WATERMARK = 262144; // 256 KB (256 * 1024 bytes)

  /**
   * WebRTCFileSender handles streaming encrypted ArrayBuffer chunks across an RTCDataChannel
   * with strict network backpressure management hooked to a Web Worker.
   */
  class WebRTCFileSender {
    /**
     * @param {RTCDataChannel} dataChannel Open RTCDataChannel instance
     * @param {object} [options]
     * @param {Worker} [options.worker] Web Worker instance running fileWorker.js
     * @param {RTCPeerConnection} [options.peerConnection] RTCPeerConnection for ICE lifecycle monitoring
     * @param {boolean} [options.tolerateDisconnect] Do not treat ICE "disconnected" as fatal (it may recover)
     * @param {number} [options.highWatermark] Buffer bytes threshold to pause (default: 1,048,576 / 1MB)
     * @param {number} [options.lowWatermark] Buffer bytes threshold to resume (default: 262,144 / 256KB)
     * @param {Function} [options.onProgress] Callback ({ bytesSent, chunksSent, chunkIndex, isLast, totalChunks, bufferedAmount, isPaused })
     * @param {Function} [options.onComplete] Callback ({ bytesSent, chunksSent, totalChunks, fileSize })
     * @param {Function} [options.onError] Callback (Error)
     * @param {Function} [options.onBackpressureChange] Callback (isPaused: boolean, currentBufferedAmount: number)
     */
    constructor(dataChannel, options = {}) {
      if (!dataChannel) {
        throw new TypeError('An RTCDataChannel instance is required');
      }

      this.dataChannel = dataChannel;
      this.peerConnection = options.peerConnection || null;
      this.worker = options.worker || null;
      this.tolerateDisconnect = !!options.tolerateDisconnect;
      this.highWatermark =
        typeof options.highWatermark === 'number' ? options.highWatermark : BUFFER_HIGH_WATERMARK;
      this.lowWatermark =
        typeof options.lowWatermark === 'number' ? options.lowWatermark : BUFFER_LOW_WATERMARK;

      this.isWorkerPaused = false;
      this.isTransferring = false;
      this.fileMetadata = null;
      this.bytesSent = 0;
      this.chunksSent = 0;

      // Event hooks
      this.onProgress = options.onProgress || null;
      this.onChunk = options.onChunk || null; // every encrypted chunk, for the Developers tab
      this.fileIndex = 0;
      this.onComplete = options.onComplete || null;
      this.onError = options.onError || null;
      this.onBackpressureChange = options.onBackpressureChange || null;

      this._setupDataChannel();
      this._setupPeerConnection();
      if (this.worker) {
        this._setupWorker();
      }
    }

    /**
     * Configures RTCDataChannel binary type, low threshold, and event listeners.
     * @private
     */
    _setupDataChannel() {
      // 1. Mandatory DataChannel configuration
      this.dataChannel.binaryType = 'arraybuffer';

      // 2. Set low threshold to 256KB
      this.dataChannel.bufferedAmountLowThreshold = this.lowWatermark;

      // 3. Hook onbufferedamountlow event to resume worker
      this.dataChannel.onbufferedamountlow = () => {
        this._handleBufferedAmountLow();
      };

      // 4. Hook error and close events. Real channels get listeners so the owner's own
      // onerror/onclose handlers are not overwritten; minimal channel stubs fall back to properties.
      const onError = (event) => {
        const err =
          event && event.error ? event.error : new Error('RTCDataChannel error encountered');
        this._handleError(err);
      };
      const onClose = () => {
        if (this.isTransferring) {
          this._handleError(new Error('RTCDataChannel closed unexpectedly during file transfer'));
        }
      };

      if (typeof this.dataChannel.addEventListener === 'function') {
        this.dataChannel.addEventListener('error', onError);
        this.dataChannel.addEventListener('close', onClose);
      } else {
        this.dataChannel.onerror = onError;
        this.dataChannel.onclose = onClose;
      }
    }

    /**
     * Configures RTCPeerConnection ICE state monitoring for non-happy-path lifecycle handling.
     * @private
     */
    _setupPeerConnection() {
      if (!this.peerConnection) return;

      const handleIceChange = () => {
        const state = this.peerConnection.iceConnectionState;
        // "disconnected" can heal by itself. An owner that manages a grace period opts out here.
        if (state === 'disconnected' && this.tolerateDisconnect) return;
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          this._handleError(new Error(`RTCPeerConnection ICE state transitioned to "${state}"`));
        }
      };

      // Listener only: assigning oniceconnectionstatechange as well would fire this twice and
      // overwrite the owner's handler.
      if (typeof this.peerConnection.addEventListener === 'function') {
        this.peerConnection.addEventListener('iceconnectionstatechange', handleIceChange);
      } else {
        this.peerConnection.oniceconnectionstatechange = handleIceChange;
      }
    }

    /**
     * Configures message routing between Web Worker and the sender logic.
     * @private
     */
    _setupWorker() {
      this.worker.onmessage = (e) => {
        const data = e.data;
        if (!data || typeof data !== 'object') return;

        switch (data.type) {
          case 'STARTED':
            this.fileMetadata = data;
            break;

          case 'ENCRYPTED_CHUNK':
            this.sendChunk(data.encryptedChunk, data.chunkIndex, data.isLast, data.totalChunks);
            break;

          case 'COMPLETE':
            this.isTransferring = false;
            if (typeof this.onComplete === 'function') {
              this.onComplete({
                bytesSent: this.bytesSent,
                chunksSent: this.chunksSent,
                totalChunks: data.totalChunks,
                fileSize: data.fileSize
              });
            }
            break;

          case 'ERROR':
            this._handleError(new Error(data.error || 'Worker error during file processing'));
            break;

          case 'ABORTED':
            this.isTransferring = false;
            break;
        }
      };

      this.worker.onerror = (err) => {
        this._handleError(err instanceof Error ? err : new Error('Web Worker unhandled exception'));
      };
    }

    /**
     * Resumes Web Worker reading when bufferedAmount falls below the 256KB threshold.
     * @private
     */
    _handleBufferedAmountLow() {
      if (this.isWorkerPaused) {
        this.isWorkerPaused = false;
        if (this.worker) {
          this.worker.postMessage({ type: 'RESUME' });
        }
        if (typeof this.onBackpressureChange === 'function') {
          this.onBackpressureChange(false, this.dataChannel.bufferedAmount);
        }
      }
    }

    /**
     * Transmits an encrypted ArrayBuffer chunk over the RTCDataChannel and enforces backpressure.
     *
     * @param {ArrayBuffer} encryptedChunk
     * @param {number} chunkIndex
     * @param {boolean} [isLast]
     * @param {number} [totalChunks]
     */
    sendChunk(encryptedChunk, chunkIndex, isLast = false, totalChunks = 0) {
      if (this.dataChannel.readyState !== 'open') {
        this._handleError(
          new Error(
            `Cannot send chunk: RTCDataChannel is in "${this.dataChannel.readyState}" state`
          )
        );
        return;
      }

      // 1. Transmit ArrayBuffer chunk
      try {
        this.dataChannel.send(encryptedChunk);
      } catch (err) {
        this._handleError(err instanceof Error ? err : new Error('RTCDataChannel send failed'));
        return;
      }

      const byteLength = encryptedChunk.byteLength || 0;
      this.bytesSent += byteLength;
      this.chunksSent++;

      // Plaintext bytes covered so far (ciphertext carries 16 extra tag bytes per chunk), so UIs can
      // show progress against the real file size. Only known once the worker reported the file size.
      const fileSize = this.fileMetadata ? this.fileMetadata.fileSize : null;
      const fileBytesQueued =
        typeof fileSize === 'number'
          ? Math.min(fileSize, (chunkIndex + 1) * 65536)
          : this.bytesSent;

      if (typeof this.onChunk === 'function') {
        this.onChunk({
          fileIndex: this.fileIndex,
          chunkIndex,
          totalChunks,
          cipher: encryptedChunk
        });
      }

      if (typeof this.onProgress === 'function') {
        this.onProgress({
          fileBytesQueued,
          bytesSent: this.bytesSent,
          chunksSent: this.chunksSent,
          chunkIndex,
          isLast,
          totalChunks,
          bufferedAmount: this.dataChannel.bufferedAmount,
          isPaused: this.isWorkerPaused
        });
      }

      // 2. Strict Backpressure check: If bufferedAmount exceeds 1MB, signal Web Worker to pause reading
      if (this.dataChannel.bufferedAmount > this.highWatermark && !this.isWorkerPaused) {
        this.isWorkerPaused = true;
        if (this.worker) {
          this.worker.postMessage({ type: 'PAUSE' });
        }
        if (typeof this.onBackpressureChange === 'function') {
          this.onBackpressureChange(true, this.dataChannel.bufferedAmount);
        }
      }
    }

    /**
     * Initiates sending a file through the Web Worker pipeline.
     *
     * @param {File|Blob} file File or Blob to send
     * @param {CryptoKey|ArrayBuffer} [key] Optional AES key
     * @param {number} [fileIndex] Position of the file in the session; selects its nonce range
     */
    sendFile(file, key = null, fileIndex = 0) {
      if (!file) {
        throw new TypeError('File or Blob object is required to start sending');
      }
      if (this.dataChannel.readyState !== 'open') {
        throw new Error(
          `Cannot start transfer: RTCDataChannel is in "${this.dataChannel.readyState}" state`
        );
      }
      if (!this.worker) {
        throw new Error('Worker instance is required to initiate sendFile');
      }

      this.isTransferring = true;
      this.fileIndex = fileIndex;
      this.bytesSent = 0;
      this.chunksSent = 0;
      this.isWorkerPaused = false;
      this.fileMetadata = null;

      this.worker.postMessage({
        type: 'START',
        file,
        key,
        fileIndex
      });
    }

    /**
     * Pauses the transmission manually.
     */
    pause() {
      if (!this.isWorkerPaused) {
        this.isWorkerPaused = true;
        if (this.worker) {
          this.worker.postMessage({ type: 'PAUSE' });
        }
        if (typeof this.onBackpressureChange === 'function') {
          this.onBackpressureChange(true, this.dataChannel.bufferedAmount);
        }
      }
    }

    /**
     * Resumes the transmission manually.
     */
    resume() {
      if (this.isWorkerPaused) {
        this.isWorkerPaused = false;
        if (this.worker) {
          this.worker.postMessage({ type: 'RESUME' });
        }
        if (typeof this.onBackpressureChange === 'function') {
          this.onBackpressureChange(false, this.dataChannel.bufferedAmount);
        }
      }
    }

    /**
     * Cancels the active transmission.
     * @param {string} [reason]
     */
    cancel(reason = 'Transfer cancelled by client') {
      this.isTransferring = false;
      if (this.worker) {
        this.worker.postMessage({ type: 'ABORT', reason });
      }
    }

    /**
     * Internal error handling and teardown.
     * @private
     */
    _handleError(err) {
      this.isTransferring = false;
      if (this.worker) {
        this.worker.postMessage({ type: 'ABORT', reason: err.message });
      }
      if (typeof this.onError === 'function') {
        this.onError(err);
      }
    }
  }

  const api = { WebRTCFileSender, BUFFER_HIGH_WATERMARK, BUFFER_LOW_WATERMARK };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
