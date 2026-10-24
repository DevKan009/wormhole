'use strict';

// Wrapped in a closure so loading this file as a <script> or via importScripts() never creates
// top-level lexical bindings that collide with other scripts.
(function (root) {
  /**
   * Strict 64 KB (65,536 bytes) chunk size per architectural requirements
   */
  const CHUNK_SIZE = 64 * 1024; // 65,536 bytes

  /**
   * Controller to pause, resume, and abort asynchronous file iteration.
   * Designed to integrate seamlessly with WebRTC backpressure (bufferedAmount / onbufferedamountlow).
   */
  class FlowController {
    constructor() {
      this._isPaused = false;
      this._isAborted = false;
      this._abortReason = null;
      this._resumePromise = null;
      this._resolveResume = null;
    }

    /**
     * Returns true if the iteration is currently paused.
     * @returns {boolean}
     */
    get isPaused() {
      return this._isPaused;
    }

    /**
     * Returns true if the iteration has been aborted.
     * @returns {boolean}
     */
    get isAborted() {
      return this._isAborted;
    }

    /**
     * Pauses the chunk reader. Subsequent reads will wait until resume() is invoked.
     */
    pause() {
      if (this._isPaused || this._isAborted) return;
      this._isPaused = true;
      this._resumePromise = new Promise((resolve) => {
        this._resolveResume = resolve;
      });
    }

    /**
     * Resumes the chunk reader if paused.
     */
    resume() {
      if (!this._isPaused || this._isAborted) return;
      this._isPaused = false;
      if (this._resolveResume) {
        const resolve = this._resolveResume;
        this._resolveResume = null;
        this._resumePromise = null;
        resolve();
      }
    }

    /**
     * Aborts the reader immediately.
     * @param {Error|string} [reason]
     */
    abort(reason = new Error('Operation aborted')) {
      this._isAborted = true;
      this._abortReason = typeof reason === 'string' ? new Error(reason) : reason;
      if (this._resolveResume) {
        const resolve = this._resolveResume;
        this._resolveResume = null;
        this._resumePromise = null;
        resolve(); // unblock wait to throw abort error
      }
    }

    /**
     * Suspends execution if paused, or throws if aborted.
     * @returns {Promise<void>}
     */
    async waitIfPaused() {
      if (this._isAborted) {
        throw this._abortReason || new Error('Operation aborted');
      }
      if (this._isPaused && this._resumePromise) {
        await this._resumePromise;
        if (this._isAborted) {
          throw this._abortReason || new Error('Operation aborted');
        }
      }
    }
  }

  /**
   * Reads a single Blob/File slice into an ArrayBuffer using FileReader with fallback.
   * @param {Blob} slice
   * @returns {Promise<ArrayBuffer>}
   */
  function readSliceAsArrayBuffer(slice) {
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('FileReader read error'));
        reader.onabort = () => reject(new Error('FileReader read aborted'));
        reader.readAsArrayBuffer(slice);
      });
    }

    // Fallback for modern environments supporting Blob.prototype.arrayBuffer
    if (slice && typeof slice.arrayBuffer === 'function') {
      return slice.arrayBuffer();
    }

    return Promise.reject(new Error('No ArrayBuffer reader available in this environment'));
  }

  /**
   * Asynchronous iterator yielding strict 64 KB (65,536 bytes) ArrayBuffers from a File or Blob.
   * Never loads more than one 64 KB slice into memory at any given time.
   *
   * @param {Blob|File} file The File or Blob object to read
   * @param {object} [options]
   * @param {FlowController} [options.controller] FlowController instance to pause/resume/abort reading
   * @param {AbortSignal} [options.signal] Standard AbortSignal
   * @param {number} [options.chunkSize] Chunk size in bytes (defaults to 65,536)
   * @returns {AsyncGenerator<ArrayBuffer, void, unknown>}
   */
  async function* readFileChunks(file, options = {}) {
    if (!file || typeof file.size !== 'number') {
      throw new TypeError('Valid File or Blob object with a numeric size is required');
    }

    const chunkSize = options.chunkSize || CHUNK_SIZE;
    const controller = options.controller || null;
    const signal = options.signal || null;
    const fileSize = file.size;

    let offset = 0;

    // Handle 0-byte file edge case
    if (fileSize === 0) {
      if (controller) await controller.waitIfPaused();
      if (signal && signal.aborted) throw new Error('Operation aborted');
      yield new ArrayBuffer(0);
      return;
    }

    while (offset < fileSize) {
      // 1. Check external abort signal
      if (signal && signal.aborted) {
        throw signal.reason
          ? typeof signal.reason === 'string'
            ? new Error(signal.reason)
            : signal.reason
          : new Error('Operation aborted');
      }

      // 2. Await pause signal if flow control is active (e.g. WebRTC backpressure)
      if (controller) {
        await controller.waitIfPaused();
      }

      // 3. Slice strictly up to chunkSize bytes (O(1) reference slice, 0 memory overhead)
      const end = Math.min(offset + chunkSize, fileSize);
      const slice = file.slice(offset, end);

      // 4. Read only this slice into an ArrayBuffer
      const arrayBuffer = await readSliceAsArrayBuffer(slice);

      // 5. Yield single 64KB ArrayBuffer
      yield arrayBuffer;

      // 6. Advance byte offset
      offset = end;
    }
  }

  /**
   * Asynchronous iterator yielding rich chunk metadata alongside the 64 KB ArrayBuffer.
   *
   * @param {Blob|File} file
   * @param {object} [options]
   * @returns {AsyncGenerator<{ chunk: ArrayBuffer, index: number, offset: number, byteLength: number, isLast: boolean, totalChunks: number }, void, unknown>}
   */
  async function* readFileChunksDetailed(file, options = {}) {
    if (!file || typeof file.size !== 'number') {
      throw new TypeError('Valid File or Blob object with a numeric size is required');
    }

    const chunkSize = options.chunkSize || CHUNK_SIZE;
    const controller = options.controller || null;
    const signal = options.signal || null;
    const fileSize = file.size;
    const totalChunks = Math.ceil(fileSize / chunkSize) || 1;

    let offset = 0;
    let chunkIndex = 0;

    if (fileSize === 0) {
      if (controller) await controller.waitIfPaused();
      if (signal && signal.aborted) throw new Error('Operation aborted');
      yield {
        chunk: new ArrayBuffer(0),
        index: 0,
        offset: 0,
        byteLength: 0,
        isLast: true,
        totalChunks: 1
      };
      return;
    }

    while (offset < fileSize) {
      if (signal && signal.aborted) {
        throw signal.reason
          ? typeof signal.reason === 'string'
            ? new Error(signal.reason)
            : signal.reason
          : new Error('Operation aborted');
      }

      if (controller) {
        await controller.waitIfPaused();
      }

      const end = Math.min(offset + chunkSize, fileSize);
      const slice = file.slice(offset, end);
      const arrayBuffer = await readSliceAsArrayBuffer(slice);
      const isLast = end >= fileSize;

      yield {
        chunk: arrayBuffer,
        index: chunkIndex,
        offset,
        byteLength: arrayBuffer.byteLength,
        isLast,
        totalChunks
      };

      offset = end;
      chunkIndex++;
    }
  }

  const api = {
    CHUNK_SIZE,
    FlowController,
    readSliceAsArrayBuffer,
    readFileChunks,
    readFileChunksDetailed
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
