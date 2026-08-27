# EphemeralShare 🚀

> **Zero-Retention, End-to-End Encrypted P2P File Sharing over WebRTC**

[![Tests](https://img.shields.io/badge/tests-23%20passed-10b981.svg)](#testing)
[![Encryption](https://img.shields.io/badge/encryption-AES--GCM%20256--bit-00f2fe.svg)](#cryptographic-protocol)
[![WebRTC](<https://img.shields.io/badge/webrtc-DataChannel%20(ArrayBuffer)-4facfe.svg>)](#network-backpressure)
[![License](https://img.shields.io/badge/license-MIT-8a2387.svg)](#license)

**EphemeralShare** is a secure, ephemeral peer-to-peer file sharing application (Wormhole clone). Files are sliced and encrypted off the main thread in a dedicated Web Worker, streamed directly between browsers over encrypted WebRTC DataChannels, and reassembled on the receiving device. **Zero bytes of file payload or encryption keys ever touch or reside on the server.**

---

## 🌟 Key Architecture & Security Highlights

### 1. 🛡️ Memory & Thread Isolation

- **No Whole-File Buffering**: Files are never loaded in full into memory as an `ArrayBuffer` or `Blob`.
- **Dedicated Web Worker**: All disk slicing and cryptographic encryption occur off the main UI thread.
- **Strict 64 KB Slices**: Files are read in strict `65,536-byte` chunks using async iteration.
- **Zero-Copy Transferable Objects**: Emits `[ArrayBuffer]` transfer lists across Web Worker boundaries, immediately releasing worker memory without garbage collection spikes.

### 2. 🔐 Cryptographic Protocol (WebCrypto API)

- **Cipher**: AES-GCM with 256-bit keys generated via `window.crypto.subtle`.
- **Deterministic 96-Bit Nonce (IV)**: Each chunk is encrypted with a unique, incrementing 12-byte big-endian counter starting at `0` for chunk 0 (`0x000000000000000000000000`). Never reuses key/nonce pairs.
- **Framing & Authentication**: AES-GCM appends a 16-byte authentication tag per slice. Each 64 KB raw chunk encrypts to exactly 65,552 bytes.

### 3. ⚡ WebRTC & Network Backpressure

- **DataChannel Config**: `binaryType = 'arraybuffer'` with ordered delivery.
- **High Watermark (1 MB)**: When `dataChannel.bufferedAmount > 1048576`, the sender signals the Web Worker to pause reading.
- **Low Watermark (256 KB)**: Hooked into `dataChannel.onbufferedamountlow` (`bufferedAmountLowThreshold = 262144`) to resume file slicing.
- **Connection Lifecycles**: Gracefully handles ICE state transitions (`disconnected`, `failed`, `closed`) to terminate background tasks immediately.

### 4. 🗄️ Zero-Retention WebSocket Signaling

- **6-Character Room Codes**: Cryptographically secure, collision-free alphanumeric codes (`[A-Z0-9]{6}`).
- **Strict 2-Peer Scope**: Rooms are limited to exactly 2 peers; third-party join requests are rejected.
- **Blind Relay**: The server only inspects the `type` property (`offer`, `answer`, `ice-candidate`) and never logs, reads, or stores SDPs or candidates.
- **Instant Teardown**: The moment one peer disconnects or encounters an error, the room is deleted from server memory and the remaining peer is disconnected.

---

## 🏗️ Architecture Diagram

```
+----------------------------------------------------------------------------------------------------+
|                                    SENDER BROWSER (Initiator)                                      |
|                                                                                                    |
|  [ File Object ]                                                                                   |
|         |                                                                                          |
|         v                                                                                          |
|  [ Dedicated Web Worker ] --------------------------------------------------------------------+    |
|    - Strict 64 KB (65,536 bytes) Slicing (FileReader / Blob)                                   |    |
|    - AES-GCM (256-bit) Sequential Encryption with 96-Bit Nonce Sequence (Counter starting @ 0)|    |
|    - FlowController (Pause / Resume / Abort)                                                  |    |
|         |                                                                                     |    |
|         | (Transferable Objects - 0 Memory Retain)                                            |    |
|         v                                                                                     |    |
|  [ WebRTCFileSender ]                                                                         |    |
|    - DataChannel (binaryType = 'arraybuffer')                                                 |    |
|    - High Watermark: 1 MB (1,048,576 B) -> postMessage('PAUSE') -----------------------------+    |
|    - Low Watermark: 256 KB (262,144 B) -> onbufferedamountlow -> postMessage('RESUME') ------+    |
+----------------------------------------------------------------------------------------------------+
                                      |
                                      | (Direct P2P Encrypted RTCDataChannel)
                                      v
+----------------------------------------------------------------------------------------------------+
|                                   RECEIVER BROWSER (Peer B)                                        |
|                                                                                                    |
|  [ WebRTCFileReceiver ]                                                                            |
|    - Sequential Message Queue (FIFO Processing)                                                   |
|    - AES-GCM (256-bit) Decryption using matching 96-bit Nonce Counter                             |
|    - Blob Reassembly & Automatic Download Trigger                                                  |
+----------------------------------------------------------------------------------------------------+
                                      ^
                                      |
                   +--------------------------------------+
                   |    Node.js WebSocket Signaling       |
                   |   (Zero Retention / Ephemeral Map)   |
                   |  - 6-Char Alphanumeric Room Codes    |
                   |  - Max 2 Peers per Room              |
                   |  - Pure Pass-Through (offer/answer)  |
                   |  - Instant Teardown on Disconnect    |
                   +--------------------------------------+
```

---

## 📁 Repository Structure

```
.
├── server.js                     # WebSocket signaling server + static asset HTTP host
├── fileChunker.js                # 64 KB async file chunker with FlowController
├── chunkCrypto.js                # WebCrypto AES-GCM 256-bit encryption & 96-bit nonce derivation
├── fileWorker.js                 # Off-main-thread Web Worker file reader & encryptor
├── webrtcSender.js               # RTCDataChannel file sender with 1MB/256KB backpressure
├── webrtcReceiver.js             # RTCDataChannel file receiver with sequential decryption
├── public/
│   ├── index.html                # Semantic HTML5 UI layout
│   ├── style.css                 # Dark glassmorphism styling & animations
│   ├── app.js                    # UI event listener, speed metrics & QR generator
│   └── webrtcManager.js          # WebRTC P2P client coordinator
├── test.js                       # Signaling server integration tests
├── test-chunker.js               # Strict 64 KB chunking tests
├── test-crypto.js                # AES-GCM 256-bit cryptographic unit tests
├── test-webrtc-backpressure.js   # WebRTC backpressure flow control tests
├── .gitignore                    # Git ignore file (includes PROJECT_CONTEXT.md)
├── .prettierrc                   # Prettier code formatting rules
├── .prettierignore               # Prettier ignore file
└── package.json                  # Project dependencies and test scripts
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js `v18.0.0` or higher

### 1. Installation

```bash
npm install
```

### 2. Start the Server

```bash
npm start
```

The server will start at **`http://localhost:8080`** (or your custom `PORT` environment variable).

### 3. Usage

1. Open `http://localhost:8080` on your sending device.
2. Drag and drop any file (e.g. 50 MB, 500 MB, or 1 GB).
3. A unique 6-character room code (e.g. `BQ5UJO`) is generated immediately.
4. Share the direct link (`http://localhost:8080/#BQ5UJO`) or QR code with the receiver.
5. On the receiving device, the WebRTC P2P connection connects automatically, streaming and decrypting chunks with instant download.

---

## 🧪 Testing

Run the full automated test suite containing 23 tests across 4 domains:

```bash
npm test
```

### Test Coverage:

- **`test.js`**: 6-character alphanumeric code generation, room join lifecycle, 2-peer enforcement, instant teardown on disconnect, and malformed payload handling.
- **`test-chunker.js`**: Strict 65,536-byte chunk size verification, remainder handling, `FlowController` pause/resume, and zero-memory accumulation.
- **`test-crypto.js`**: 96-bit big-endian deterministic nonces, AES-GCM 256-bit key export/import, 16-byte tag expansion (`65,536` $\rightarrow$ `65,552` bytes), ciphertext tamper detection, and round-trip decryption.
- **`test-webrtc-backpressure.js`**: `RTCDataChannel` `binaryType = 'arraybuffer'`, 1 MB high watermark pause dispatch, 256 KB low watermark resume dispatch, ICE disconnect abort handling, and end-to-end P2P delivery.

---

## 🎨 Code Formatting

Format the codebase with Prettier:

```bash
# Format all files
npm run format

# Check formatting
npm run format:check
```

---

## 📄 License

MIT
