'use strict';

/**
 * Web Worker for reading files in strict 64 KB chunks, sequentially encrypting each chunk
 * with AES-GCM (256-bit) using a deterministic 96-bit counter nonce, and streaming
 * the encrypted chunks via Transferable Objects with pause/resume flow control.
 */

// If running in a browser Web Worker, import dependencies
if (typeof importScripts === 'function') {
  try {
    if (typeof FlowController === 'undefined') importScripts('./fileChunker.js');
    if (typeof encryptChunk === 'undefined') importScripts('./chunkCrypto.js');
  } catch {}
}

// Module imports for Node.js worker_threads / testing environments
const { FlowController, readFileChunksDetailed, CHUNK_SIZE } =
  typeof module !== 'undefined' && typeof require === 'function'
    ? require('./fileChunker')
    : {
        FlowController: self.FlowController,
        readFileChunksDetailed: self.readFileChunksDetailed,
        CHUNK_SIZE: self.CHUNK_SIZE || 65536
      };

const { generateAESKey, importRawKey, exportRawKey, encryptChunk } =
  typeof module !== 'undefined' && typeof require === 'function'
    ? require('./chunkCrypto')
    : {
        generateAESKey: self.generateAESKey,
        importRawKey: self.importRawKey,
        exportRawKey: self.exportRawKey,
        encryptChunk: self.encryptChunk
      };

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

      currentController = new FlowController();
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
        for await (const chunkInfo of readFileChunksDetailed(file, {
          controller: currentController
        })) {
          const { chunk, index, offset, isLast } = chunkInfo;

          // Encrypt with 96-bit deterministic counter nonce (starting at 0)
          const encryptedChunk = await encryptChunk(cryptoKey, chunk, index);

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
        if (currentController && currentController.isAborted) {
          self.postMessage({ type: 'ABORTED', reason: err.message });
        } else {
          self.postMessage({ type: 'ERROR', error: err.message || 'Error during file encryption' });
        }
      } finally {
        isProcessing = false;
        currentController = null;
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
