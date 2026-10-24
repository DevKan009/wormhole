'use strict';

(function (root) {
  const { importRawKey, decryptChunk, nonceIndex } =
    typeof module !== 'undefined' && typeof require === 'function'
      ? require('./chunkCrypto')
      : root;

  const RAW_CHUNK_SIZE = 65536;
  const TAG_LENGTH = 16;
  const MAX_ENCRYPTED_CHUNK = RAW_CHUNK_SIZE + TAG_LENGTH;

  // Files at least this large are spooled to the browser's private disk storage instead of RAM
  const DISK_SINK_MIN_BYTES = 64 * 1024 * 1024;
  const DISK_FILE_PREFIX = 'efs-';
  const STALE_DISK_FILE_MS = 60 * 60 * 1000;

  /**
   * Collects decrypted chunks in memory and assembles a Blob. Fine for small and medium files.
   */
  class MemorySink {
    constructor() {
      this.chunks = [];
      this.kind = 'memory';
    }

    async write(buffer) {
      this.chunks.push(buffer);
    }

    async finalize(type) {
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];
      return blob;
    }

    async abort() {
      this.chunks = [];
    }

    async cleanup() {}
  }

  /**
   * Streams decrypted chunks into a temporary file in the origin-private file system (OPFS), so
   * receiving a file never needs the whole file in RAM. The file never leaves the user's device
   * and is deleted after the download (and stale leftovers are purged on the next visit).
   */
  class DiskSink {
    constructor(dir, name, handle, writable) {
      this.dir = dir;
      this.name = name;
      this.handle = handle;
      this.writable = writable;
      this.kind = 'disk';
    }

    async write(buffer) {
      await this.writable.write(buffer);
    }

    async finalize(type) {
      await this.writable.close();
      const file = await this.handle.getFile();
      // slice() keeps the data disk-backed and lets us set the MIME type
      return file.slice(0, file.size, type);
    }

    async abort() {
      try {
        await this.writable.abort();
      } catch {}
      await this.cleanup();
    }

    async cleanup() {
      try {
        await this.dir.removeEntry(this.name);
      } catch {}
    }
  }

  function diskSinkSupported() {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.storage &&
      typeof navigator.storage.getDirectory === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' &&
      typeof FileSystemFileHandle.prototype.createWritable === 'function'
    );
  }

  /**
   * Picks where received bytes go: disk for large files when the browser supports it,
   * memory otherwise (or if disk storage is unavailable at runtime).
   * @param {number} fileSize
   * @param {{ diskThresholdBytes?: number }} [options]
   * @returns {Promise<MemorySink|DiskSink>}
   */
  async function createReceiverSink(fileSize, options = {}) {
    const threshold =
      typeof options.diskThresholdBytes === 'number'
        ? options.diskThresholdBytes
        : DISK_SINK_MIN_BYTES;
    if (fileSize >= threshold && diskSinkSupported()) {
      try {
        const dir = await navigator.storage.getDirectory();
        const name = `${DISK_FILE_PREFIX}${crypto.randomUUID()}`;
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        return new DiskSink(dir, name, handle, writable);
      } catch (err) {
        console.warn('Disk-backed receive unavailable, using memory:', err);
      }
    }
    return new MemorySink();
  }

  /**
   * Removes leftover temporary files from crashed or closed sessions. Only files older than an
   * hour are touched, so a transfer running in another tab is never affected.
   */
  async function purgeStaleDiskFiles() {
    if (!diskSinkSupported()) return;
    try {
      const dir = await navigator.storage.getDirectory();
      for await (const [name, handle] of dir.entries()) {
        if (!name.startsWith(DISK_FILE_PREFIX) || handle.kind !== 'file') continue;
        const file = await handle.getFile();
        if (Date.now() - file.lastModified > STALE_DISK_FILE_MS) {
          await dir.removeEntry(name);
        }
      }
    } catch {}
  }

  /**
   * WebRTCFileReceiver handles receiving encrypted ArrayBuffer chunks across an RTCDataChannel,
   * decrypting them sequentially with matching deterministic nonces, and assembling the final Blob/File.
   *
   * Incoming frames are checked against the declared file shape. A frame that does not fit
   * (too many chunks, wrong size, failed authentication) aborts the transfer.
   */
  class WebRTCFileReceiver {
    /**
     * @param {RTCDataChannel} dataChannel
     * @param {object} [options]
     * @param {CryptoKey|ArrayBuffer} [options.key] AES-GCM 256-bit key. A raw key is imported on first use.
     * @param {number} [options.expectedTotalChunks] Total chunks expected
     * @param {number} [options.expectedFileSize] Exact plaintext size in bytes, enforced chunk by chunk
     * @param {string} [options.fileName] Name of the file being received
     * @param {string} [options.fileType] MIME type of the file
     * @param {number} [options.fileIndex] Position of this file in the session (selects its nonce range)
     * @param {MemorySink|DiskSink} [options.sink] Where decrypted bytes go (default: memory)
     * @param {boolean} [options.bindChannel] Set to false to feed frames through handleMessage() yourself
     * @param {Function} [options.onChunkReceived] Callback ({ chunkIndex, decryptedChunk, totalChunks, isLast })
     * @param {Function} [options.onProgress] Callback ({ bytesReceived, chunksReceived, totalChunks, progressPercentage })
     * @param {Function} [options.onComplete] Callback ({ blob, totalBytes, totalChunks, fileName })
     * @param {Function} [options.onControl] Callback (string) for non-binary frames
     * @param {Function} [options.onError] Callback (Error)
     */
    constructor(dataChannel, options = {}) {
      if (!dataChannel) {
        throw new TypeError('An RTCDataChannel instance is required');
      }

      this.dataChannel = dataChannel;
      this.key = options.key || null;
      this.expectedTotalChunks = options.expectedTotalChunks || 0;
      this.expectedFileSize =
        typeof options.expectedFileSize === 'number' ? options.expectedFileSize : null;
      this.fileName = options.fileName || 'received-file';
      this.fileType = options.fileType || 'application/octet-stream';

      this.fileIndex = Number.isInteger(options.fileIndex) ? options.fileIndex : 0;
      this.sink = options.sink || new MemorySink();

      this.chunksReceived = 0;
      this.bytesReceived = 0;
      this.isCompleted = false;
      this.isFailed = false;
      this._messageQueue = Promise.resolve();

      this.onChunkReceived = options.onChunkReceived || null;
      this.onProgress = options.onProgress || null;
      this.onComplete = options.onComplete || null;
      this.onControl = options.onControl || null;
      this.onError = options.onError || null;

      if (options.bindChannel !== false) {
        this._setupDataChannel();
      }
    }

    /**
     * Sets or updates the decryption key.
     * @param {CryptoKey|ArrayBuffer} key
     */
    async setKey(key) {
      this.key = await this._resolveKey(key);
    }

    async _resolveKey(key) {
      if (typeof CryptoKey !== 'undefined' && key instanceof CryptoKey) return key;
      // Raw 256-bit key bytes (ArrayBuffer / Uint8Array), or a CryptoKey from a foreign realm
      if (key && (key instanceof ArrayBuffer || ArrayBuffer.isView(key))) {
        return importRawKey(key, false);
      }
      return key;
    }

    /**
     * Queues one incoming frame so frames are processed strictly in arrival order.
     * @param {{ data: ArrayBuffer|string }} event
     * @returns {Promise<void>}
     */
    handleMessage(event) {
      this._messageQueue = this._messageQueue
        .then(() => this._processMessage(event))
        .catch((err) => this._fail(err));
      return this._messageQueue;
    }

    /**
     * @private
     */
    _fail(err) {
      if (this.isFailed) return;
      this.isFailed = true;
      Promise.resolve(this.sink.abort()).catch(() => {});
      if (typeof this.onError === 'function') {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }

    /**
     * Processes a single incoming message frame sequentially.
     * @private
     */
    async _processMessage(event) {
      if (this.isFailed) return;

      const encryptedBuffer = event.data;
      if (typeof encryptedBuffer === 'string') {
        if (typeof this.onControl === 'function') this.onControl(encryptedBuffer);
        return;
      }
      if (!(encryptedBuffer instanceof ArrayBuffer)) {
        return;
      }

      if (!this.key) {
        throw new Error('Cannot decrypt chunk: AES key not yet provided to receiver');
      }
      this.key = await this._resolveKey(this.key);

      const total = this.expectedTotalChunks;
      const chunkIndex = this.chunksReceived;

      // Shape checks run before any decryption work so garbage is rejected cheaply
      if (this.isCompleted || (total > 0 && chunkIndex >= total)) {
        throw new Error('Received more data than the sender declared');
      }
      const encryptedLength = encryptedBuffer.byteLength;
      if (encryptedLength < TAG_LENGTH || encryptedLength > MAX_ENCRYPTED_CHUNK) {
        throw new Error(`Invalid encrypted chunk size: ${encryptedLength} bytes`);
      }
      if (this.expectedFileSize !== null && total > 0) {
        const expectedPlain =
          chunkIndex < total - 1
            ? RAW_CHUNK_SIZE
            : this.expectedFileSize - (total - 1) * RAW_CHUNK_SIZE;
        if (encryptedLength - TAG_LENGTH !== expectedPlain) {
          throw new Error(`Chunk ${chunkIndex} has an unexpected size`);
        }
      }

      const decrypted = await decryptChunk(
        this.key,
        encryptedBuffer,
        nonceIndex(this.fileIndex, chunkIndex)
      );

      await this.sink.write(decrypted);
      this.bytesReceived += decrypted.byteLength;
      this.chunksReceived++;

      const isLast =
        total > 0 ? this.chunksReceived === total : encryptedLength < MAX_ENCRYPTED_CHUNK;

      if (
        isLast &&
        this.expectedFileSize !== null &&
        this.bytesReceived !== this.expectedFileSize
      ) {
        throw new Error('Received size does not match the declared file size');
      }

      if (typeof this.onChunkReceived === 'function') {
        this.onChunkReceived({
          chunkIndex,
          decryptedChunk: decrypted,
          totalChunks: total,
          isLast
        });
      }

      if (typeof this.onProgress === 'function') {
        const progressPercentage =
          total > 0 ? Math.round((this.chunksReceived / total) * 100) : null;

        this.onProgress({
          bytesReceived: this.bytesReceived,
          chunksReceived: this.chunksReceived,
          totalChunks: total,
          progressPercentage
        });
      }

      if (isLast && !this.isCompleted) {
        this.isCompleted = true;
        const blob = await this.sink.finalize(this.fileType);
        if (typeof this.onComplete === 'function') {
          this.onComplete({
            blob,
            cleanup: () => this.sink.cleanup(),
            storage: this.sink.kind,
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
        this.handleMessage(event);
      };

      this.dataChannel.onerror = (event) => {
        const err = event && event.error ? event.error : new Error('DataChannel error');
        this._fail(err);
      };
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      WebRTCFileReceiver,
      MemorySink,
      createReceiverSink,
      purgeStaleDiskFiles,
      DISK_SINK_MIN_BYTES
    };
  } else {
    Object.assign(root, {
      WebRTCFileReceiver,
      createReceiverSink,
      purgeStaleDiskFiles,
      DISK_SINK_MIN_BYTES
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
