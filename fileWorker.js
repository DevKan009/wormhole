'use strict';

/**
 * Web Worker for reading files in strict 64 KB chunks, sequentially encrypting each chunk
 * with AES-GCM (256-bit) using a deterministic 96-bit counter nonce, and streaming
 * the encrypted chunks via Transferable Objects with pause/resume flow control.
 *
 * Browser-only: it is loaded with `new Worker('/fileWorker.js')`. A failure to load the shared
 * scripts is deliberately fatal so it shows up as a worker error instead of a silent no-op.
 */
importScripts('./fileChunker.js', './chunkCrypto.js');

let currentController = null;
let isProcessing = false;

/**
 * Worker message dispatcher
 */
self.onmessage = async function (e) {
  const data = e.data;
  if (!data || typeof data !== 'object') return;

  const type = (data.type || data.action || '').toUpperCase();

  switch (type) {
    case 'START':
    case 'ENCRYPT_FILE': {
      const file = data.file || data.blob;
      if (!file) {
        self.postMessage({ type: 'ERROR', error: 'No File or Blob object provided' });
        return;
      }

      if (isProcessing && currentController) {
        currentController.abort(new Error('Previous operation cancelled by new read request'));
      }

      const fileIndex = Number.isInteger(data.fileIndex) ? data.fileIndex : 0;
      const controller = new FlowController();
      currentController = controller;
      isProcessing = true;

      try {
        // Resolve or generate AES-GCM 256-bit CryptoKey
        let cryptoKey;
        if (data.key instanceof CryptoKey) {
          cryptoKey = data.key;
        } else if (data.rawKey || data.key) {
          cryptoKey = await importRawKey(data.rawKey || data.key);
        } else {
          // Auto-generate 256-bit AES key if none provided
          cryptoKey = await generateAESKey();
          const rawKeyBuffer = await exportRawKey(cryptoKey);
          self.postMessage(
            {
              type: 'KEY_GENERATED',
              rawKey: rawKeyBuffer
            },
            [rawKeyBuffer]
          );
        }

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;

        self.postMessage({
          type: 'STARTED',
          fileName: file.name || 'unnamed',
          fileSize: file.size,
          fileType: file.type || 'application/octet-stream',
          rawChunkSize: CHUNK_SIZE,
          totalChunks
        });

        // Sequentially read and encrypt each chunk in strict 64 KB slices
        for await (const chunkInfo of readFileChunksDetailed(file, { controller })) {
          const { chunk, index, offset, isLast } = chunkInfo;

          // Encrypt with a 96-bit deterministic counter nonce: file index (high bits) and chunk
          // index (low bits), so each file in a session has its own nonce range
          const encryptedChunk = await encryptChunk(cryptoKey, chunk, nonceIndex(fileIndex, index));

          // Export encrypted ArrayBuffer with chunkIndex via zero-copy Transferable
          self.postMessage(
            {
              type: 'ENCRYPTED_CHUNK',
              chunkIndex: index,
              encryptedChunk,
              byteLength: encryptedChunk.byteLength, // 65,552 bytes for 64KB (16-byte tag expansion)
              offset,
              isLast,
              totalChunks
            },
            [encryptedChunk] // Transfers ownership and releases memory immediately in worker
          );
        }

        self.postMessage({ type: 'COMPLETE', totalChunks, fileSize: file.size });
      } catch (err) {
        if (controller.isAborted) {
          self.postMessage({ type: 'ABORTED', reason: err.message });
        } else {
          self.postMessage({ type: 'ERROR', error: err.message || 'Error during file encryption' });
        }
      } finally {
        // Only clear shared state if a newer START has not replaced this run's controller
        if (currentController === controller) {
          isProcessing = false;
          currentController = null;
        }
      }
      break;
    }

    case 'PAUSE': {
      if (currentController && !currentController.isPaused) {
        currentController.pause();
        self.postMessage({ type: 'PAUSED' });
      }
      break;
    }

    case 'RESUME': {
      if (currentController && currentController.isPaused) {
        currentController.resume();
        self.postMessage({ type: 'RESUMED' });
      }
      break;
    }

    case 'ABORT':
    case 'CANCEL': {
      if (currentController) {
        currentController.abort(data.reason || 'Aborted by controller or backpressure threshold');
      }
      break;
    }

    default:
      self.postMessage({ type: 'ERROR', error: `Unknown worker action: ${type}` });
  }
};
