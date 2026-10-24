# EphemeralShare 🚀

> **Zero-Retention, End-to-End Encrypted P2P File Sharing over WebRTC**

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
- **Key Never Touches the Server**: The sender generates the key in the browser and puts it only in the share link's URL fragment (`/#ROOM.KEY`). Browsers do not send fragments to servers, and the key is never sent over signaling or the data channel. A bare room code is not enough to receive a file.
- **Authenticated Header**: File name, size and type travel AES-GCM encrypted under a reserved nonce, so a relay cannot read or alter them. The receiver validates them, sanitises the file name, and rejects chunks that exceed or do not match the declared size.
- **Delivery Confirmation**: The transfer counts as complete only after the receiver has decrypted and verified every chunk and sent back an acknowledgement.

### 3. ⚡ WebRTC & Network Backpressure

- **DataChannel Config**: `binaryType = 'arraybuffer'` with ordered delivery.
- **High Watermark (1 MB)**: When `dataChannel.bufferedAmount > 1048576`, the sender signals the Web Worker to pause reading.
- **Low Watermark (256 KB)**: Hooked into `dataChannel.onbufferedamountlow` (`bufferedAmountLowThreshold = 262144`) to resume file slicing.
- **Connection Lifecycles**: Gracefully handles ICE state transitions (`disconnected`, `failed`, `closed`) to terminate background tasks immediately.

### 4. 🗄️ Zero-Retention WebSocket Signaling

- **6-Character Room Codes**: Cryptographically secure, collision-free alphanumeric codes (`[A-Z0-9]{6}`).
- **Strict 2-Peer Scope**: Rooms are limited to exactly 2 peers; third-party join requests are rejected.
- **Blind Relay**: The server only inspects the `type` property (`offer`, `answer`, `ice-candidate`) and never logs, reads, or stores SDPs or candidates.
- **Instant Teardown**: The moment one peer disconnects or encounters an error, the room is deleted from server memory and the remaining peer is disconnected. Both browsers leave the room as soon as the data channel opens, so the link stops working once the peers are connected.
- **Locked-Down Static Hosting**: Only `public/` and the five shared browser scripts are served. `.git`, `server.js`, `package.json` and everything else return 404. Responses carry a strict CSP, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

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
├── webrtcReceiver.js             # RTCDataChannel file receiver, chunk validation, memory/disk sinks
├── public/
│   ├── index.html                # Semantic, accessible markup (tabs, landmarks, SVG icon sprite)
│   ├── style.css                 # Design tokens, light/dark themes, components, reduced motion
│   ├── app.js                    # UI state, transfer list, speed/ETA, QR rendering
│   ├── webrtcManager.js          # WebRTC P2P client coordinator, multi-file protocol
│   ├── favicon.svg               # App icon
│   └── vendor/qrcode.js          # QR encoder (qrcode-generator, MIT), vendored; no CDN
├── test.js                       # Signaling server integration tests
├── test-chunker.js               # Strict 64 KB chunking tests
├── test-crypto.js                # AES-GCM 256-bit cryptographic unit tests
├── test-webrtc-backpressure.js   # WebRTC backpressure flow control tests
├── test-resilience.js            # Metered TURN, server limits, client retry/keepalive/reconnect tests
├── render.yaml                   # Render Blueprint (free web service)
├── test-protocol.js              # Key transport, headers, receiver validation, sinks, server hardening tests
├── e2e/                          # Real-browser suites (Playwright + axe): transfers, failures, accessibility
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
2. Drop one or more files (or use **browse**).
3. A room is created immediately. Click **Copy Link**, or show the QR code for a phone.
4. Send the full link (`http://localhost:8080/#BQ5UJO.<key>`) to the receiver over any channel. The part after `#` is the decryption key.
5. The receiver opens the link (or pastes it into the Receive tab) and presses **Connect and download**. The browsers connect directly and the files are decrypted, verified and downloaded one after another.

The room and link are single-use. A room carries one batch of files.

> **Known limitations**
>
> - Files of 64 MiB or more are written to a temporary file in the browser's private storage (OPFS) instead of RAM. Browsers without OPFS `createWritable` support fall back to memory, so very large files are then limited by RAM. Temporary files are removed after the download and purged on the next visit if left behind.
> - Folders cannot be dropped, only files. A batch is limited to 1000 files.
> - A short network interruption is tolerated: the transfer pauses ("Reconnecting…") and continues if the connection returns within 20 seconds. A longer outage ends the transfer, and there is no resume yet. Start over with a new link.
> - Both people must keep the tab open. On phones the screen is kept awake during a transfer where the browser allows it.

### Running beyond localhost

- **HTTPS is required.** Browsers expose WebCrypto only on HTTPS or `localhost`, so the app cannot encrypt when opened over plain `http://<lan-ip>:8080`. Either terminate TLS in a reverse proxy, or let the server do it:

  ```bash
  HTTPS_KEY=/path/key.pem HTTPS_CERT=/path/cert.pem npm start
  ```

- **TURN relay** (needed when both peers are behind strict NATs, for example two phones on different mobile networks or a locked-down office network). Without it those pairs cannot connect. The server hands ICE servers to browsers at `GET /ice-config`. Configure with environment variables:

  | Variable                           | Meaning                                                                         |
  | ---------------------------------- | ------------------------------------------------------------------------------- |
  | `METERED_APP`, `METERED_API_KEY`   | Free Metered relay (see below). The key stays on the server                     |
  | `STUN_URLS`                        | Comma-separated STUN URLs (default: public Google/Twilio STUN)                  |
  | `TURN_URL`                         | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478`                    |
  | `TURN_SECRET`                      | coturn `static-auth-secret`; the server issues short-lived credentials per page |
  | `TURN_TTL`                         | Lifetime of those credentials in seconds (default 3600)                         |
  | `TURN_USERNAME`, `TURN_CREDENTIAL` | Static credentials, used only when `TURN_SECRET` is unset                       |

  **Who gets the TURN login.** Browsers have to receive it, so it can never be fully secret. `/ice-config` only includes TURN when the request names a room that currently exists (`/ice-config?room=CODE`, sent by the app after a room is created or joined). Anyone else gets STUN only. Lookups of rooms that do not exist are capped (`MAX_ICE_MISSES_PER_MIN`, default 60) so the endpoint cannot be used to probe for live room codes. A determined attacker can still create a room and obtain the login, so the provider's quota remains the final cap.

  For coturn, set `use-auth-secret` and `static-auth-secret=<same value as TURN_SECRET>`. Relayed traffic is still end-to-end encrypted. Relaying is slower than a direct connection and counts against the provider's quota.

- **Limits** (all optional environment variables):

  | Variable                                             | Default | Meaning                                                             |
  | ---------------------------------------------------- | ------- | ------------------------------------------------------------------- |
  | `PORT`                                               | 8080    | Port to listen on                                                   |
  | `MAX_ROOMS`                                          | 10000   | Simultaneous rooms                                                  |
  | `MAX_CONNECTIONS`                                    | 1000    | Simultaneous WebSocket connections                                  |
  | `ROOM_MAX_AGE_MIN`                                   | 60      | A room that is still open after this many minutes is deleted        |
  | `MAX_MESSAGES_PER_10S`                               | 100     | Per connection. Flooding closes it                                  |
  | `MAX_FAILED_JOINS`                                   | 5       | Wrong room codes allowed per connection (stops code guessing)       |
  | `MAX_ICE_MISSES_PER_MIN`                             | 60      | `/ice-config` lookups of rooms that do not exist, all clients       |
  | `MAX_CONNECTIONS_PER_IP`, `MAX_ROOMS_PER_IP_PER_MIN` | 8, 10   | Per address. Only active when the address is trustworthy, see below |
  | `TRUST_PROXY_HOPS`                                   | unset   | How many reverse proxies sit in front of the server                 |

  **Per-address limits and proxies.** Behind a reverse proxy every connection looks like it comes from the proxy, so limiting by address would lock everyone out. The server therefore leaves per-address limits off whenever it sees an `X-Forwarded-For` header and `TRUST_PROXY_HOPS` is unset, and logs one warning (it never logs addresses). Set `TRUST_PROXY_HOPS` to the number of proxies you trust and the server uses the entry that many places from the right of `X-Forwarded-For`. Do not guess: with too small a number clients can forge their address, and with too large a number the limits are skipped. The per-connection and global limits above apply either way.

## ☁️ Deploying on Render (free)

The repository includes a `render.yaml` Blueprint.

1. Push the repo to GitHub, then in Render choose **New → Blueprint** and select it. It builds with `npm ci --omit=dev` and checks `/health`.
2. **TURN (recommended).** Create a free account at [Metered](https://www.metered.ca/), open **TURN Server → Credentials → New credential**, and copy the username and password. In the Render dashboard set `TURN_URL` (`turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp`), `TURN_USERNAME` and `TURN_CREDENTIAL`. (Accounts that expose an API key can use `METERED_APP` and `METERED_API_KEY` instead.) The server gives the TURN login only to browsers that name a live room, see below. The free plan includes 500 MB of relayed data a month, and TURN stops until the next cycle once it is used up (direct connections are unaffected). Only transfers that cannot connect directly use the relay.
3. Test it for real: open the link on a laptop on Wi-Fi and on a phone using mobile data.

How the free tier shapes the app:

- **The service sleeps** after 15 minutes without an HTTP request or WebSocket message, and takes about a minute to wake. While a sender waits for the receiver the page sends a small keepalive message every 25 seconds, so a waiting room is not lost. If the server is asleep when someone picks a file, the page retries for up to 90 seconds and says "Waking up the server".
- **Optional:** a free uptime monitor (for example UptimeRobot) requesting `/health` every 5 minutes keeps the service awake, which avoids even the first-visit delay. One always-on service fits inside the 750 free hours a month.
- **Restarts and deploys** drop rooms that are still waiting, but never a transfer in progress: once two browsers are connected they no longer need the server.
- **Per-address limits** stay off on Render until you set `TRUST_PROXY_HOPS`. Check Render's current documentation for how many proxies it puts in front of your service before setting it.

---

## 🧪 Testing

Fast unit and server tests (no browser needed):

```bash
npm test
```

Real-browser suites. These start the app on a free port and drive two browser sessions. They need Chrome installed (or set `E2E_CHANNEL=msedge`):

```bash
npm run e2e
```

Set `E2E_SHOTS=./e2e-shots` to keep screenshots. The browser is launched with mDNS host-candidate hiding turned off, because two sessions on one machine otherwise cannot always resolve each other's `.local` names.

### Test Coverage:

- **`e2e/transfer.js`**: five files over a real WebRTC connection (2 MB, 300 KB, exactly two chunks, 70 MB through disk-backed storage, 0 bytes), each verified byte for byte with SHA-256; confirms the key never appears in a signaling message and is stripped from the address bar, and that the strict CSP produces no console errors.
- **`e2e/wakeup.js`**: the server goes away after the page loads and returns seconds later. The page explains the delay, keeps retrying, then creates the room and completes a transfer.
- **`e2e/ui.js`**: axe accessibility audits of every screen in light and dark, keyboard tab navigation and focus ring, inline validation, wrong key, expired link, sender dropping mid-transfer, and reset.
- **`test-resilience.js`**: Metered credential fetching (caching, back-off, stale-on-error, key never logged, host-injection guards), every server limit against a real WebSocket server (flood, code guessing, per-address and global caps, room creation rate, room expiry, proxy handling), and the client's retry, keepalive and reconnect-grace logic.
- **`test-protocol.js`**: base64url key transport, share-link parsing, encrypted header (tamper and wrong-key rejection), header validation and file-name sanitising, multi-file nonce ranges and replay rejection, receiver rejection of reordered, truncated, oversize and tampered chunks, the static-file allowlist (`/.git/config`, `/server.js` → 404), ICE/TURN config, and security headers.
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
