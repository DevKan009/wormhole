'use strict';

/**
 * WebRTC P2P Client Connection & File Transfer Manager
 * Coordinates Signaling WebSocket, ICE negotiation, DataChannel framing,
 * off-thread Web Worker chunk encryption, and E2EE decryption.
 *
 * Key handling: the sender generates the AES-GCM key locally and puts it only in the share link's
 * URL fragment (#ROOM.KEY). Browsers never send fragments to a server, and the key is never sent
 * over signaling or the data channel.
 */

const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ]
};

const RAW_CHUNK_SIZE = 65536;
const MAX_FILE_NAME_LENGTH = 200;
const MAX_FILES_PER_SESSION = 1000;

/**
 * Turns an untrusted remote file name into a safe download name.
 * @param {unknown} name
 * @returns {string}
 */
function sanitizeFileName(name) {
  let clean = typeof name === 'string' ? name : '';
  // Drop any path component and control characters
  clean = clean.split(/[\\/]/).pop();
  clean = clean.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  clean = clean.replace(/^\.+/, '');
  if (clean.length > MAX_FILE_NAME_LENGTH) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
    clean = clean.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext;
  }
  return clean || 'downloaded-file';
}

/**
 * Validates the decrypted (but still untrusted) file header.
 * @param {any} header
 * @param {{ fileIndex?: number, fileCount?: number|null, totalBytes?: number|null }} [expected]
 *   What the session already established: the position this header must have, and the batch
 *   shape announced by the first header (later headers must repeat it).
 * @returns {{ fileName: string, fileSize: number, fileType: string, totalChunks: number,
 *   fileIndex: number, fileCount: number, totalBytes: number }}
 */
function validateFileHeader(header, expected = {}) {
  if (!header || typeof header !== 'object') {
    throw new Error('Malformed file header');
  }
  const { fileSize, totalChunks, fileIndex, fileCount, totalBytes } = header;
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new Error('Malformed file header: invalid size');
  }
  if (totalChunks !== (Math.ceil(fileSize / RAW_CHUNK_SIZE) || 1)) {
    throw new Error('Malformed file header: chunk count does not match size');
  }
  if (fileIndex !== (expected.fileIndex ?? 0)) {
    throw new Error('Malformed file header: file is out of order');
  }
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > MAX_FILES_PER_SESSION) {
    throw new Error('Malformed file header: invalid file count');
  }
  if (expected.fileCount != null && fileCount !== expected.fileCount) {
    throw new Error('Malformed file header: file count changed mid-session');
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes < fileSize) {
    throw new Error('Malformed file header: invalid batch size');
  }
  if (expected.totalBytes != null && totalBytes !== expected.totalBytes) {
    throw new Error('Malformed file header: batch size changed mid-session');
  }
  const fileType =
    typeof header.fileType === 'string' && header.fileType.length <= 255
      ? header.fileType
      : 'application/octet-stream';
  return {
    fileName: sanitizeFileName(header.fileName),
    fileSize,
    fileType,
    totalChunks,
    fileIndex,
    fileCount,
    totalBytes
  };
}

class WebRTCManager {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || this._getDefaultWsUrl();
    this.rtcConfig = options.rtcConfig || null;
    this._fixedRtcConfig = Boolean(options.rtcConfig);

    // Hosting on free tiers means the signaling server may be asleep. Keep trying for a while and
    // tell the user why it is slow. Times are in ms and overridable for tests.
    this.signalingRetry = {
      slowAfterMs: 3000,
      deadlineMs: 90000,
      delaysMs: [1000, 2000, 3000, 5000],
      ...(options.signalingRetry || {})
    };
    // While waiting for the peer, send a small message now and then. Hosts that put idle services
    // to sleep count incoming WebSocket messages as activity.
    this.keepAliveMs = options.keepAliveMs ?? 25000;
    // A brief network blip (ICE "disconnected") often heals by itself. Wait this long before giving up.
    this.reconnectGraceMs = options.reconnectGraceMs ?? 20000;

    this._keepAliveTimer = null;
    this._graceTimer = null;
    this._epoch = 0; // bumped on reset so a stale connection attempt stops quietly
    this.ws = null;
    this.pc = null;
    this.dataChannel = null;
    this.fileSender = null;
    this.fileReceiver = null;
    this.worker = null;
    this.isInitiator = false;
    this.roomCode = null;
    this.peerConnected = false;

    this.cryptoKey = null; // AES-GCM key for this room (sender generates, receiver reads from link)
    this.keyBase64Url = null;

    this._signalingQueue = Promise.resolve();
    this._rxQueue = Promise.resolve();
    this._pendingCandidates = [];
    this._finished = false; // transfer finished or deliberately closed, so later closes are not errors
    this._failed = false;
    this._sendQueue = null; // sender: { files, index, totalBytes } once sendFiles() has started
    this._batch = null; // receiver: { fileCount, totalBytes, nextIndex } learnt from the first header

    // Callbacks
    this.onStateChange = options.onStateChange || (() => {});
    this.onRoomCreated = options.onRoomCreated || (() => {});
    this.onJoined = options.onJoined || (() => {});
    this.onPeerJoined = options.onPeerJoined || (() => {});
    this.onP2PConnected = options.onP2PConnected || (() => {});
    this.onP2PDisconnected = options.onP2PDisconnected || (() => {});
    this.onFileTransferStart = options.onFileTransferStart || (() => {});
    this.onFileProgress = options.onFileProgress || (() => {});
    this.onFileComplete = options.onFileComplete || (() => {});
    this.onBackpressureChange = options.onBackpressureChange || (() => {});
    this.onSignalingSlow = options.onSignalingSlow || (() => {});
    this.onConnectionStatus = options.onConnectionStatus || (() => {});
    this.onError = options.onError || (() => {});
  }

  _getDefaultWsUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }

  /**
   * Link fragment ("ROOM.KEY", without "#") for the sender to share. Null until a room exists.
   */
  getShareFragment() {
    if (!this.roomCode || !this.keyBase64Url) return null;
    return buildShareFragment(this.roomCode, this.keyBase64Url);
  }

  /**
   * ICE servers come from the server's /ice-config so TURN can be added without a client change.
   * The room code is sent along because the server only hands out TURN logins to people who are
   * in a real room. Falls back to public STUN if the endpoint is unavailable.
   */
  async _loadRtcConfig(roomCode) {
    if (this._fixedRtcConfig) return;
    try {
      const res = await fetch(`/ice-config?room=${encodeURIComponent(roomCode || '')}`, {
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const config = await res.json();
      if (!config || !Array.isArray(config.iceServers) || config.iceServers.length === 0) {
        throw new Error('empty ICE config');
      }
      this.rtcConfig = { iceServers: config.iceServers };
    } catch (err) {
      console.warn('Using default STUN configuration:', err);
      this.rtcConfig = DEFAULT_RTC_CONFIG;
    }
  }

  /**
   * Connect to the WebSocket signaling server, retrying while it wakes up.
   * Resolves once connected. Rejects (after reporting an error) when the deadline passes.
   */
  connectSignaling() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();

    const { slowAfterMs, deadlineMs, delaysMs } = this.signalingRetry;
    const epoch = this._epoch;
    const started = Date.now();
    let attempt = 0;

    return new Promise((resolve, reject) => {
      const slowTimer = setTimeout(() => {
        if (epoch === this._epoch) this.onSignalingSlow();
      }, slowAfterMs);
      const settle = (fn, arg) => {
        clearTimeout(slowTimer);
        fn(arg);
      };

      const tryOnce = () => {
        this._openSocket().then(
          () => settle(resolve),
          (err) => {
            const delay = delaysMs[Math.min(attempt++, delaysMs.length - 1)];
            const outOfTime = Date.now() - started + delay > deadlineMs;
            if (epoch !== this._epoch) {
              settle(reject, err); // reset or disconnected meanwhile: stop without reporting
            } else if (outOfTime) {
              this._reportError('Could not reach the signaling server');
              settle(reject, err);
            } else {
              this.onSignalingSlow();
              setTimeout(tryOnce, delay);
            }
          }
        );
      };
      tryOnce();
    });
  }

  /**
   * One connection attempt. Rejects if the socket errors or closes before it opened.
   */
  _openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this.onStateChange('SIGNALING_CONNECTED');
        this._startKeepAlive(ws);
        resolve();
      };

      ws.onerror = (err) => {
        if (!opened) {
          if (this.ws === ws) this.ws = null;
          reject(err);
        }
      };

      ws.onclose = () => {
        if (!opened) {
          if (this.ws === ws) this.ws = null;
          reject(new Error('Signaling socket closed before opening'));
          return;
        }
        this._stopKeepAlive();
        if (this.ws !== ws) return;
        this.ws = null;
        this.onStateChange('SIGNALING_DISCONNECTED');
        // Signaling is only needed to set up the connection. Once the peers are connected (or the
        // transfer is over) a closed signaling socket is expected: each side leaves the room as soon
        // as its data channel opens, and the server then drops the other socket. The other side's
        // channel may not have fired onopen yet, so an ICE state of checking/connected also counts.
        const ice = this.pc ? this.pc.iceConnectionState : 'none';
        const negotiated = ice === 'checking' || ice === 'connected' || ice === 'completed';
        if (!this.peerConnected && !this._finished && !negotiated) {
          this._teardownP2P();
          this._reportError('Signaling connection closed before the peer connected');
          this.onP2PDisconnected();
        }
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.error('Failed to parse signaling message:', err);
          return;
        }
        // Handle strictly in arrival order: handlers await WebRTC calls, and an ICE candidate must
        // never be processed before the offer/answer that precedes it.
        this._signalingQueue = this._signalingQueue
          .then(() => this._handleSignalingMessage(msg))
          .catch((err) => {
            console.error('Signaling handler failed:', err);
            this._reportError(err.message || 'Signaling error');
          });
      };
    });
  }

  _startKeepAlive(ws) {
    this._stopKeepAlive();
    if (!(this.keepAliveMs > 0)) return;
    this._keepAliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && !this.peerConnected) {
        ws.send('{"type":"ping"}');
      }
    }, this.keepAliveMs);
  }

  _stopKeepAlive() {
    clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }

  /**
   * Create a new 6-character room. The AES key is generated here and never leaves this browser
   * except inside the share link fragment.
   */
  async createRoom() {
    this._resetSession();
    this.cryptoKey = await generateAESKey();
    this.keyBase64Url = await keyToBase64Url(this.cryptoKey);
    await this.connectSignaling();
    this.isInitiator = true;
    this.ws.send(JSON.stringify({ type: 'create' }));
  }

  /**
   * Join an existing room. `keyBase64Url` comes from the link fragment.
   */
  async joinRoom(code, keyBase64Url) {
    this._resetSession();
    if (!keyBase64Url) {
      this._reportError('This link has no decryption key. Ask the sender for the full share link.');
      return;
    }
    try {
      this.cryptoKey = await keyFromBase64Url(keyBase64Url);
    } catch (err) {
      this._reportError(err.message || 'Invalid encryption key in link');
      return;
    }
    this.keyBase64Url = keyBase64Url;
    await this.connectSignaling();
    this.isInitiator = false;
    const cleanCode = (code || '').trim().toUpperCase();
    this.ws.send(JSON.stringify({ type: 'join', roomCode: cleanCode }));
  }

  /**
   * Signaling Message Dispatcher
   */
  async _handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'created':
        this.roomCode = msg.roomCode;
        this.onRoomCreated(msg.roomCode);
        // Messages are handled in order, so the config is ready before any peer-joined arrives
        await this._loadRtcConfig(msg.roomCode);
        break;

      case 'joined':
        this.roomCode = msg.roomCode;
        this.onJoined(msg.roomCode);
        await this._loadRtcConfig(msg.roomCode);
        this._initPeerConnection();
        break;

      case 'peer-joined':
        this.onPeerJoined(msg.roomCode);
        // Initiator creates offer once peer has joined
        this._initPeerConnection();
        await this._createAndSendOffer();
        break;

      case 'offer':
        if (!this.isInitiator) {
          await this._handleOffer(msg);
        }
        break;

      case 'answer':
        if (this.isInitiator) {
          await this._handleAnswer(msg);
        }
        break;

      case 'ice-candidate':
        await this._handleRemoteCandidate(msg.candidate);
        break;

      case 'pong':
        break;

      case 'error':
        this._reportError(msg.message || 'Signaling server error');
        break;
    }
  }

  /**
   * Initialize RTCPeerConnection and ICE handling
   */
  _initPeerConnection() {
    if (this.pc) return;

    const pc = new RTCPeerConnection(this.rtcConfig || DEFAULT_RTC_CONFIG);
    this.pc = pc;

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          })
        );
      }
    });

    // Listener (not the on-property): WebRTCFileSender watches the same event on the same pc.
    pc.addEventListener('iceconnectionstatechange', () => {
      if (this.pc !== pc) return;
      const state = pc.iceConnectionState;
      this.onStateChange(`ICE_${state.toUpperCase()}`);
      if (state === 'disconnected') {
        this._beginReconnectGrace();
      } else if (state === 'connected' || state === 'completed') {
        this._endReconnectGrace(true);
      } else if (state === 'failed' || state === 'closed') {
        this._endReconnectGrace(false);
        this._handleConnectionLost(`Peer connection ${state}`);
      }
    });

    if (this.isInitiator) {
      // Initiator creates data channel
      this.dataChannel = pc.createDataChannel('fileTransfer', {
        ordered: true
      });
      this._setupDataChannel(this.dataChannel);
    } else {
      // Receiver waits for data channel from initiator
      pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
  }

  async _createAndSendOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.ws.send(
      JSON.stringify({
        type: 'offer',
        sdp: offer.sdp
      })
    );
  }

  async _handleOffer(msg) {
    if (!this.pc) this._initPeerConnection();
    await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    await this._flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.ws.send(
      JSON.stringify({
        type: 'answer',
        sdp: answer.sdp
      })
    );
  }

  async _handleAnswer(msg) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    await this._flushPendingCandidates();
  }

  /**
   * Candidates that arrive before the remote description is set are held back.
   */
  async _handleRemoteCandidate(candidate) {
    if (!candidate) return;
    if (!this.pc || !this.pc.remoteDescription) {
      this._pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      console.error('Error adding received ICE candidate:', e);
    }
  }

  async _flushPendingCandidates() {
    const pending = this._pendingCandidates;
    this._pendingCandidates = [];
    for (const candidate of pending) {
      await this._handleRemoteCandidate(candidate);
    }
  }

  /**
   * Setup RTCDataChannel event routing
   */
  _setupDataChannel(dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 262144; // 256 KB

    dc.onopen = () => {
      this.peerConnected = true;
      this.onStateChange('P2P_CONNECTED');
      // The room has done its job. Leaving now destroys it on the server immediately, so the
      // link cannot be used by anyone else.
      this._closeSignaling();
      this.onP2PConnected();
    };

    dc.onclose = () => {
      this.peerConnected = false;
      this.onStateChange('P2P_DISCONNECTED');
      this._handleConnectionLost('Data channel closed');
    };

    dc.onerror = (err) => {
      // After the last file is confirmed (or after a failure was already reported) the other side
      // closes the channel on purpose, which browsers surface as an error event. Not worth a log.
      if (this._finished || this._failed) return;
      console.error('DataChannel error:', err);
      this._reportError('Data channel connection error');
    };

    // Every frame goes through one queue so the (async) header decryption finishes before the
    // first chunk is routed to the receiver.
    dc.onmessage = (event) => {
      this._rxQueue = this._rxQueue
        .then(() => this._handleDataMessage(event))
        .catch((err) => this._failTransfer(err));
    };
  }

  async _handleDataMessage(event) {
    if (typeof event.data === 'string') {
      let control;
      try {
        control = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!control || typeof control !== 'object') return;

      if (control.type === 'FILE_HEADER' && !this.isInitiator) {
        await this._handleFileHeader(control);
      } else if (control.type === 'FILE_ACK' && this.isInitiator) {
        this._handleFileAck(control);
      }
      return;
    }

    if (!this.fileReceiver) {
      throw new Error('Received data before a file header');
    }
    await this.fileReceiver.handleMessage(event);
  }

  /**
   * Receiver: decrypt and validate the header for the next file, then start accepting its chunks.
   */
  async _handleFileHeader(control) {
    if (this.fileReceiver) {
      throw new Error('Unexpected file header while a file is still arriving');
    }
    // The expected position is part of the header's nonce. A header that does not authenticate
    // under the link's key at this position is rejected by AES-GCM.
    const fileIndex = this._batch ? this._batch.nextIndex : 0;
    let rawHeader;
    try {
      rawHeader = await decryptHeader(this.cryptoKey, control.header, fileIndex);
    } catch {
      throw new Error(
        'Could not decrypt the file: the key in the link is wrong or data was altered'
      );
    }
    const header = validateFileHeader(rawHeader, {
      fileIndex,
      fileCount: this._batch ? this._batch.fileCount : null,
      totalBytes: this._batch ? this._batch.totalBytes : null
    });
    if (!this._batch) {
      this._batch = { fileCount: header.fileCount, totalBytes: header.totalBytes, nextIndex: 0 };
    }
    this._batch.nextIndex = fileIndex + 1;
    const isLast = fileIndex === header.fileCount - 1;
    const batchInfo = {
      fileName: header.fileName,
      fileSize: header.fileSize,
      fileIndex,
      fileCount: header.fileCount,
      totalBytes: header.totalBytes
    };

    // Large files stream to temporary disk storage when the browser allows it
    const sink = await createReceiverSink(header.fileSize);

    this.fileReceiver = new WebRTCFileReceiver(this.dataChannel, {
      key: this.cryptoKey,
      bindChannel: false,
      fileIndex,
      sink,
      expectedTotalChunks: header.totalChunks,
      expectedFileSize: header.fileSize,
      fileName: header.fileName,
      fileType: header.fileType,
      onProgress: (p) => {
        this.onFileProgress({ ...p, ...batchInfo, isReceiver: true });
      },
      onComplete: (res) => {
        this.fileReceiver = null;
        if (isLast) this._finished = true;
        this._sendControl({ type: 'FILE_ACK', ok: true, fileIndex });
        this.onFileComplete({ ...res, ...batchInfo, isLast, isReceiver: true });
      },
      onError: (err) => this._failTransfer(err)
    });

    this.onFileTransferStart({
      ...batchInfo,
      totalChunks: header.totalChunks,
      isReceiver: true
    });
  }

  /**
   * Sender: the receiver confirmed (or rejected) the file it just got.
   */
  _handleFileAck(control) {
    if (this._finished || this._failed) return;
    if (!control.ok) {
      this._failTransfer(new Error('The receiver rejected the transfer'));
      return;
    }
    const queue = this._sendQueue;
    if (!queue || control.fileIndex !== queue.index) {
      this._failTransfer(new Error('Unexpected acknowledgement from the receiver'));
      return;
    }
    const file = queue.files[queue.index];
    const isLast = queue.index === queue.files.length - 1;
    if (isLast) {
      this._finished = true;
      if (this.fileSender) this.fileSender.isTransferring = false;
    }
    this.onFileComplete({
      fileName: file.name,
      fileSize: file.size,
      fileIndex: queue.index,
      fileCount: queue.files.length,
      totalBytes: queue.totalBytes,
      isLast,
      isReceiver: false
    });
    if (!isLast) {
      this._sendNextFile().catch((err) => this._failTransfer(err));
    }
  }

  _sendControl(obj) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify(obj));
      } catch (err) {
        console.error('Failed to send control message:', err);
      }
    }
  }

  /**
   * Convenience wrapper for a single file.
   */
  sendFile(file) {
    return this.sendFiles(file ? [file] : []);
  }

  /**
   * Send one or more files over the DataChannel, one after another, using a Web Worker and
   * AES-GCM 256-bit. The next file starts only after the receiver confirmed the previous one.
   * A room carries a single batch: each file has its own nonce range under the shared key.
   * @param {File[]|FileList} files
   */
  async sendFiles(files) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('P2P connection is not established');
    }
    const list = Array.from(files || []);
    if (list.length === 0) {
      throw new Error('No file provided');
    }
    if (list.length > MAX_FILES_PER_SESSION) {
      throw new Error(`Too many files, the limit is ${MAX_FILES_PER_SESSION} per transfer`);
    }
    if (this._sendQueue || !this.cryptoKey) {
      throw new Error('Files were already sent in this room');
    }
    this._sendQueue = {
      files: list,
      index: -1,
      totalBytes: list.reduce((sum, f) => sum + f.size, 0)
    };

    // One worker and one sender serve every file in the batch
    if (this.worker) {
      this.worker.terminate();
    }
    this.worker = new Worker('/fileWorker.js');

    this.fileSender = new WebRTCFileSender(this.dataChannel, {
      worker: this.worker,
      peerConnection: this.pc,
      tolerateDisconnect: true, // the manager owns the reconnect grace period
      onProgress: (p) => {
        const queue = this._sendQueue;
        const file = queue.files[queue.index];
        const buffered = p.bufferedAmount || 0;
        this.onFileProgress({
          ...p,
          // Plaintext bytes that have left the send buffer
          bytesSent: Math.max(0, p.fileBytesQueued - buffered),
          fileName: file.name,
          fileSize: file.size,
          fileIndex: queue.index,
          fileCount: queue.files.length,
          totalBytes: queue.totalBytes,
          isReceiver: false
        });
      },
      onComplete: () => {
        // Everything is queued. A file is only done once the receiver confirms it.
        this.onStateChange('AWAITING_RECEIVER_CONFIRMATION');
      },
      onError: (err) => this._failTransfer(err),
      onBackpressureChange: (isPaused, bufferedAmount) => {
        this.onBackpressureChange(isPaused, bufferedAmount);
      }
    });

    await this._sendNextFile();
  }

  /**
   * Sender: announce and stream the next file in the queue.
   */
  async _sendNextFile() {
    const queue = this._sendQueue;
    queue.index++;
    const fileIndex = queue.index;
    const file = queue.files[fileIndex];
    const totalChunks = Math.ceil(file.size / RAW_CHUNK_SIZE) || 1;

    // The header (name, size, type, position, batch shape) is authenticated by the link's key
    const header = await encryptHeader(
      this.cryptoKey,
      {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        totalChunks,
        fileIndex,
        fileCount: queue.files.length,
        totalBytes: queue.totalBytes
      },
      fileIndex
    );
    if (this._failed || !this.dataChannel) return;
    this.dataChannel.send(JSON.stringify({ type: 'FILE_HEADER', header }));

    this.onFileTransferStart({
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      fileIndex,
      fileCount: queue.files.length,
      totalBytes: queue.totalBytes,
      isReceiver: false
    });

    this.fileSender.sendFile(file, this.cryptoKey, fileIndex);
  }

  /**
   * Pause current send transfer
   */
  pauseTransfer() {
    if (this.fileSender) {
      this.fileSender.pause();
    }
  }

  /**
   * Resume current send transfer
   */
  resumeTransfer() {
    if (this.fileSender) {
      this.fileSender.resume();
    }
  }

  /**
   * Cancel transfer & close connections
   */
  cancelTransfer() {
    if (this.fileSender) {
      this.fileSender.cancel();
    }
    this._teardownP2P();
  }

  /**
   * Report an error once and tear everything down.
   */
  _failTransfer(err) {
    if (this._finished || this._failed) return;
    this._failed = true;
    // Tell the other side so it does not wait forever
    this._sendControl({ type: 'FILE_ACK', ok: false });
    this._reportError(err && err.message ? err.message : 'Transfer failed');
    this._teardownP2P();
    this.onP2PDisconnected();
  }

  /**
   * The peer connection or data channel went away.
   */
  /**
   * ICE "disconnected" is often a short blip (Wi-Fi roaming, a congested mobile link) that recovers
   * on its own. Wait for it instead of failing. Sending slows down by itself meanwhile: the data
   * channel's buffer stops draining, so the sender's backpressure pauses reading.
   */
  _beginReconnectGrace() {
    if (this._finished || this._failed || this._graceTimer) return;
    this.onConnectionStatus('reconnecting');
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      this._handleConnectionLost('Peer connection did not recover');
    }, this.reconnectGraceMs);
  }

  _endReconnectGrace(recovered) {
    if (!this._graceTimer) return;
    clearTimeout(this._graceTimer);
    this._graceTimer = null;
    if (recovered) this.onConnectionStatus('connected');
  }

  _handleConnectionLost(reason) {
    if (this._finished || this._failed) return;
    this._failed = true;
    this._teardownP2P();
    this._reportError(`Connection lost: ${reason}`);
    this.onP2PDisconnected();
  }

  _reportError(message) {
    this.onError(message);
  }

  _closeSignaling() {
    this._stopKeepAlive();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      // Only detach handlers from a socket that finished opening. One that is still connecting
      // must be able to fail, or the pending connect attempt would never settle.
      if (ws.readyState === WebSocket.OPEN) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
      }
      try {
        ws.close();
      } catch {}
    }
  }

  _teardownP2P() {
    clearTimeout(this._graceTimer);
    this._graceTimer = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    const dc = this.dataChannel;
    const pc = this.pc;
    this.dataChannel = null;
    this.pc = null;
    this.peerConnected = false;
    if (dc) {
      dc.onclose = null;
      dc.onerror = null;
      dc.onmessage = null;
      try {
        dc.close();
      } catch {}
    }
    if (pc) {
      try {
        pc.close();
      } catch {}
    }
  }

  _resetSession() {
    this._epoch++;
    this._teardownP2P();
    this._closeSignaling();
    this._signalingQueue = Promise.resolve();
    this._rxQueue = Promise.resolve();
    this._pendingCandidates = [];
    this._finished = false;
    this._failed = false;
    this._sendQueue = null;
    this._batch = null;
    this.fileSender = null;
    this.fileReceiver = null;
    this.cryptoKey = null;
    this.keyBase64Url = null;
    this.roomCode = null;
  }

  /**
   * Complete teardown and disconnect. Closing is deliberate, so it is not reported as an error.
   */
  disconnect() {
    this._epoch++;
    this._finished = true;
    this._teardownP2P();
    this._closeSignaling();
    this.roomCode = null;
    this.isInitiator = false;
    this.cryptoKey = null;
    this.keyBase64Url = null;
  }
}

// Pure helpers are exported for Node tests; the class itself needs browser APIs.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sanitizeFileName, validateFileHeader, WebRTCManager };
}

// Global attachment
if (typeof window !== 'undefined') {
  window.WebRTCManager = WebRTCManager;
  window.sanitizeFileName = sanitizeFileName;
  window.validateFileHeader = validateFileHeader;
}
