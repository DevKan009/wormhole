'use strict';

/**
 * SenderHub: one sender, up to 8 receivers, one link and one key.
 *
 * Every receiver gets its own RTCPeerConnection and data channel straight from the sender, so
 * files still never touch a server. What changes is the sender's upload: each file is read and
 * encrypted ONCE and the same encrypted chunks are written to every receiver's channel. That is
 * safe because the same key, nonce and data always give the same ciphertext, so no nonce is ever
 * reused for different data. Upload bandwidth is the real cost, and it grows with the receiver
 * count.
 *
 * Pace: the slowest receiver sets it. Reading pauses while ANY channel has more than 1 MB queued
 * and resumes when ALL are below 256 KB. A receiver whose queue does not move for 20 seconds is
 * dropped so one bad connection cannot stall the others. One receiver failing never stops the rest.
 *
 * It extends WebRTCManager and reuses its signaling retry, keepalive, key handling and tracing.
 * The receiving side is unchanged: it behaves exactly as when sending to one person.
 */
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const shared = isNode ? require('./webrtcManager') : null;
  const Base = isNode ? shared.WebRTCManager : root.WebRTCManager;
  const H = isNode ? shared.helpers : root.WebRTCHelpers;
  const INSPECTOR = typeof Inspector !== 'undefined' ? Inspector : null;

  const LOW_WATERMARK = 262144;
  const HEADER_NONCE_INDEX = (1n << 64n) - 1n;
  const PEER_PROGRESS_MS = 100;
  const STALL_CHECK_MS = 2000;

  /**
   * Looks like one data channel to WebRTCFileSender but writes to many. A channel that cannot be
   * written to is reported through onSendError and left out from then on.
   */
  class FanOutChannel {
    constructor(onSendError = () => {}) {
      this.channels = new Map(); // id -> RTCDataChannel
      this.onSendError = onSendError;
      this.binaryType = 'arraybuffer';
      this.onbufferedamountlow = null;
      this._threshold = LOW_WATERMARK;
    }

    add(id, dc) {
      this.channels.set(id, dc);
      dc.bufferedAmountLowThreshold = this._threshold;
      const onLow = () => this.check();
      if (typeof dc.addEventListener === 'function')
        dc.addEventListener('bufferedamountlow', onLow);
      else dc.onbufferedamountlow = onLow;
    }

    remove(id) {
      this.channels.delete(id);
      // The slowest channel may have been the one holding the sender back
      this.check();
    }

    get readyState() {
      for (const dc of this.channels.values()) if (dc.readyState === 'open') return 'open';
      return 'closed';
    }

    /** The fullest queue: the slowest receiver decides when to pause and resume. */
    get bufferedAmount() {
      let max = 0;
      for (const dc of this.channels.values()) {
        if (dc.readyState === 'open') max = Math.max(max, dc.bufferedAmount || 0);
      }
      return max;
    }

    set bufferedAmountLowThreshold(value) {
      this._threshold = value;
      for (const dc of this.channels.values()) dc.bufferedAmountLowThreshold = value;
    }

    get bufferedAmountLowThreshold() {
      return this._threshold;
    }

    send(data) {
      for (const [id, dc] of this.channels) {
        if (dc.readyState !== 'open') continue;
        try {
          dc.send(data);
        } catch (err) {
          this.onSendError(id, err);
        }
      }
    }

    /** Fires the "low" callback only when every queue has drained below the threshold. */
    check() {
      if (
        this.bufferedAmount <= this._threshold &&
        typeof this.onbufferedamountlow === 'function'
      ) {
        this.onbufferedamountlow();
      }
    }

    // The sender attaches error/close listeners itself; each receiver's own channel handlers cover that
    addEventListener() {}
  }

  class SenderHub extends Base {
    constructor(options = {}) {
      super(options);
      this.maxPeers = options.maxPeers || 2;
      this.slowPeerMs = options.slowPeerMs ?? 20000;
      this.links = new Map(); // peerId -> link
      this._labelSeq = 0;
      this._started = false;
      this._fan = null;
      this._stallTimer = null;
      this._peerProgressAt = 0;

      this.onPeerState = options.onPeerState || (() => {});
      this.onPeerProgress = options.onPeerProgress || (() => {});
      this.onReady = options.onReady || (() => {}); // every expected person has connected or failed
      this.onRoomClosed = options.onRoomClosed || (() => {}); // the server dropped the room early
    }

    // -----------------------------------------------------------------------------------------
    // Room and signaling
    // -----------------------------------------------------------------------------------------

    /**
     * Create a room with `maxPeers` slots. One key, one link. Receivers fill the slots as they open it.
     */
    async createRoom(maxPeers = this.maxPeers) {
      this.maxPeers = maxPeers;
      this._resetSession();
      if (INSPECTOR) INSPECTOR.set('session', { role: 'sender', roomCode: null, maxPeers });
      this.cryptoKey = await generateAESKey();
      this.keyBase64Url = await keyToBase64Url(this.cryptoKey);
      await this._traceKey('generated in this browser');
      await this.connectSignaling();
      this.isInitiator = true;
      this._sendSignal({ type: 'create', maxPeers });
    }

    _resetSession() {
      super._resetSession();
      this.links = new Map();
      this._labelSeq = 0;
      this._started = false;
      this._fan = null;
    }

    // People are waiting for friends to arrive. That is idle time a free host would sleep through.
    _wantsKeepAlive() {
      return !this._started;
    }

    _handleSignalingClosed() {
      if (this._started || this._finished) return;
      const connected = this._connectedLinks();
      if (connected.length > 0) {
        // The room is gone, so nobody else can join. Carry on with whoever is here.
        this.onRoomClosed({ connected: connected.length });
        return;
      }
      this._teardownP2P();
      this._reportError('Signaling connection closed before the peer connected');
      this.onP2PDisconnected();
    }

    async _handleSignalingMessage(msg) {
      switch (msg.type) {
        case 'created':
          this.roomCode = msg.roomCode;
          if (msg.maxPeers) this.maxPeers = msg.maxPeers;
          this._traceSession();
          this.onRoomCreated(msg.roomCode, this.maxPeers);
          await this._loadRtcConfig(msg.roomCode);
          break;

        case 'peer-joined':
          await this._addLink(msg);
          break;

        case 'peer-left': {
          // Receivers leave the room on purpose once their direct channel is open. Only someone
          // who leaves before that has actually dropped out.
          const link = this.links.get(msg.peerId);
          if (link && link.state === 'connecting') this._failLink(link, 'Left before connecting');
          break;
        }

        case 'answer': {
          const link = this.links.get(msg.from);
          if (!link || !link.pc) break;
          await link.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          if (this._isFirst(link)) this._traceSdp('remote', 'answer', msg.sdp);
          for (const candidate of link.pendingCandidates.splice(0)) {
            await this._addRemoteCandidate(link, candidate);
          }
          break;
        }

        case 'ice-candidate': {
          const link = this.links.get(msg.from);
          if (!link || !msg.candidate) break;
          if (INSPECTOR && this._isFirst(link) && typeof msg.candidate.candidate === 'string') {
            this._trace(
              'ice',
              'candidate-remote',
              {
                raw: msg.candidate.candidate,
                parsed: INSPECTOR.parseCandidate(msg.candidate.candidate)
              },
              link.id
            );
          }
          if (!link.pc || !link.pc.remoteDescription) link.pendingCandidates.push(msg.candidate);
          else await this._addRemoteCandidate(link, msg.candidate);
          break;
        }

        case 'pong':
          break;

        case 'error':
          // Messages to someone who just left are expected and harmless
          if (msg.message !== 'Peer is not connected') {
            this._reportError(msg.message || 'Signaling server error');
          }
          break;
      }
    }

    async _addRemoteCandidate(link, candidate) {
      try {
        await link.pc.addIceCandidate(candidate);
      } catch (err) {
        console.error('Error adding received ICE candidate:', err);
      }
    }

    // -----------------------------------------------------------------------------------------
    // One link per receiver
    // -----------------------------------------------------------------------------------------

    _isFirst(link) {
      return link.index === 0;
    }

    _connectedLinks() {
      return [...this.links.values()].filter((l) => l.state === 'connected');
    }

    /** Links that are part of the transfer: they connected and have not failed. */
    _activeLinks() {
      return [...this.links.values()].filter(
        (l) => l.state === 'connected' || l.state === 'sending' || l.state === 'done'
      );
    }

    _setLinkState(link, state, reason = null) {
      link.state = state;
      if (reason) link.reason = reason;
      this._publishPeers();
      this.onPeerState(this._describeLink(link));
    }

    _describeLink(link) {
      const pair = link.stats && link.stats.pair;
      return {
        peerId: link.id,
        label: link.label,
        state: link.state,
        reconnecting: Boolean(link.graceTimer),
        reason: link.reason || null,
        path: pair ? (pair.relayed ? 'relayed' : 'direct') : null,
        rttMs: pair ? pair.rttMs : null,
        acked: link.acked,
        bytes: link.bytes || 0
      };
    }

    _publishPeers() {
      if (!INSPECTOR) return;
      INSPECTOR.set(
        'peers',
        [...this.links.values()].map((l) => this._describeLink(l))
      );
    }

    async _addLink(msg) {
      const peerId = msg.peerId;
      if (!peerId || this.links.has(peerId) || this._started) return;
      const index = this.links.size;
      const link = {
        id: peerId,
        index,
        label: `Person ${++this._labelSeq}`,
        state: 'connecting',
        pc: null,
        dc: null,
        acked: 0,
        bytes: 0,
        reason: null,
        pendingCandidates: [],
        graceTimer: null,
        statsTimer: null,
        stats: null,
        lastBuffered: 0,
        stallSince: null,
        closed: false
      };
      this.links.set(peerId, link);
      this._trace('transfer', 'peer-joined', { label: link.label }, peerId);
      this.onPeerJoined({
        peerId,
        label: link.label,
        joined: msg.joined || this.links.size,
        maxPeers: this.maxPeers
      });
      this._setLinkState(link, 'connecting');

      const pc = new RTCPeerConnection(this.rtcConfig || H.DEFAULT_RTC_CONFIG);
      link.pc = pc;

      pc.addEventListener('icecandidate', (event) => {
        if (link.closed) return;
        if (event.candidate) {
          if (INSPECTOR && this._isFirst(link)) {
            this._trace(
              'ice',
              'candidate-local',
              {
                raw: event.candidate.candidate,
                parsed: INSPECTOR.parseCandidate(event.candidate.candidate)
              },
              peerId
            );
          }
          this._sendSignal({ type: 'ice-candidate', candidate: event.candidate, to: peerId });
        } else if (this._isFirst(link)) {
          this._trace('ice', 'gathering-done', {}, peerId);
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        if (link.closed || link.pc !== pc) return;
        const state = pc.iceConnectionState;
        this._trace('ice', 'state', { state }, peerId);
        if (state === 'disconnected') {
          this._beginLinkGrace(link);
        } else if (state === 'connected' || state === 'completed') {
          this._endLinkGrace(link, true);
        } else if (state === 'failed' || state === 'closed') {
          this._endLinkGrace(link, false);
          this._failLink(link, `Connection ${state}`);
        }
      });

      const dc = pc.createDataChannel('fileTransfer', { ordered: true });
      link.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW_WATERMARK;
      dc.onopen = () => {
        if (link.closed || link.state !== 'connecting') return;
        this._trace(
          'channel',
          'open',
          {
            label: dc.label,
            id: dc.id,
            ordered: dc.ordered,
            binaryType: dc.binaryType,
            bufferedAmountLowThreshold: dc.bufferedAmountLowThreshold,
            maxMessageSize: pc.sctp ? pc.sctp.maxMessageSize : null
          },
          peerId
        );
        this._setLinkState(link, 'connected');
        this._startLinkStats(link);
        this._maybeReady();
      };
      dc.onclose = () => {
        if (link.closed) return;
        this._trace('channel', 'close', {}, peerId);
        // A receiver that has everything closes its side on purpose
        if (link.state !== 'done') this._failLink(link, 'Data channel closed');
      };
      dc.onerror = (err) => {
        if (link.closed || this._finished || this._failed) return;
        console.error('DataChannel error:', err);
      };
      dc.onmessage = (event) => this._handleLinkMessage(link, event);

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (this._isFirst(link)) this._traceSdp('local', 'offer', offer.sdp);
        this._requireSent({ type: 'offer', sdp: offer.sdp, to: peerId });
      } catch (err) {
        this._failLink(link, err.message || 'Could not start the connection');
      }
    }

    /** Everyone expected has either connected or failed: time to start, unless someone is still pending. */
    _maybeReady() {
      if (this._started || this.links.size < this.maxPeers) return;
      const all = [...this.links.values()];
      if (all.some((l) => l.state === 'connecting')) return;
      const connected = this._connectedLinks().length;
      if (connected > 0) this.onReady({ connected, maxPeers: this.maxPeers });
    }

    _beginLinkGrace(link) {
      if (link.graceTimer || this._finished || this._failed) return;
      link.graceTimer = setTimeout(() => {
        link.graceTimer = null;
        this._failLink(link, 'Connection did not recover');
      }, this.reconnectGraceMs);
      this._publishPeers();
      this.onPeerState(this._describeLink(link));
    }

    _endLinkGrace(link, recovered) {
      if (!link.graceTimer) return;
      clearTimeout(link.graceTimer);
      link.graceTimer = null;
      if (recovered) {
        this._publishPeers();
        this.onPeerState(this._describeLink(link));
      }
    }

    _closeLink(link) {
      link.closed = true;
      clearTimeout(link.graceTimer);
      link.graceTimer = null;
      clearInterval(link.statsTimer);
      link.statsTimer = null;
      const { dc, pc } = link;
      link.dc = null;
      link.pc = null;
      if (dc) {
        dc.onopen = dc.onclose = dc.onerror = dc.onmessage = null;
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

    /**
     * One receiver is out. Everyone else carries on. Only when nobody is left does the transfer fail.
     */
    _failLink(link, reason) {
      // A receiver that already has everything may go away at any time without it being a failure
      if (!link || link.state === 'failed' || link.state === 'done' || this._finished) return;
      this._trace('transfer', 'peer-failed', { reason, label: link.label }, link.id);
      this._closeLink(link);
      if (this._fan) this._fan.remove(link.id);
      this._setLinkState(link, 'failed', reason);
      if (this._failed) return;
      if (this._started) {
        if (this._activeLinks().length === 0) {
          this._failTransfer(new Error(`Every receiver disconnected (${reason})`));
          return;
        }
        // The files may now be complete for everyone who is left
        this._completeFiles();
      } else {
        this._maybeReady();
      }
    }

    /** Once a second per link: network path, DTLS and bytes, for the Developers tab and the list. */
    _startLinkStats(link) {
      if (
        !INSPECTOR ||
        !(this.statsIntervalMs > 0) ||
        !link.pc ||
        typeof link.pc.getStats !== 'function'
      ) {
        return;
      }
      const pc = link.pc;
      let prev = null;
      let series = [];
      let pairTraced = false;
      let dtlsTraced = false;
      const tick = async () => {
        if (link.closed || link.pc !== pc) return;
        let view;
        try {
          view = INSPECTOR.summarizeStats(await pc.getStats());
        } catch {
          return;
        }
        const now = Date.now();
        const sent = view.pair ? view.pair.bytesSent : 0;
        const received = view.pair ? view.pair.bytesReceived : 0;
        let sentPerSec = 0;
        let recvPerSec = 0;
        if (prev && now > prev.t) {
          const seconds = (now - prev.t) / 1000;
          sentPerSec = Math.max(0, (sent - prev.sent) / seconds);
          recvPerSec = Math.max(0, (received - prev.received) / seconds);
        }
        prev = { t: now, sent, received };
        series = [...series.slice(-59), { t: now, sent: sentPerSec, recv: recvPerSec }];
        link.stats = { ...view, sentPerSec, recvPerSec };
        // The single-connection panels follow the first receiver, the Connections panel lists all
        if (this._isFirst(link)) {
          INSPECTOR.set('stats', link.stats);
          INSPECTOR.set('series', series);
        }
        if (view.pair && !pairTraced) {
          pairTraced = true;
          this._trace('ice', 'pair-selected', view.pair, link.id);
        }
        if (view.transport && view.transport.dtlsState === 'connected' && !dtlsTraced) {
          dtlsTraced = true;
          this._trace('ice', 'dtls', view.transport, link.id);
        }
        this._publishPeers();
      };
      link.statsTimer = setInterval(tick, this.statsIntervalMs);
      tick();
    }

    // -----------------------------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------------------------

    /**
     * Start sending to everyone who has connected. Anyone still connecting is dropped and the room
     * is closed to newcomers.
     */
    async sendFiles(files) {
      const list = Array.from(files || []);
      if (list.length === 0) throw new Error('No files selected');
      if (list.length > H.MAX_FILES_PER_SESSION) {
        throw new Error(`Too many files, the limit is ${H.MAX_FILES_PER_SESSION} per transfer`);
      }
      if (this._sendQueue || !this.cryptoKey)
        throw new Error('Files were already sent in this room');
      const ready = this._connectedLinks();
      if (ready.length === 0) throw new Error('Nobody is connected yet');

      this._started = true;
      this._sendSignal({ type: 'lock' });
      for (const link of [...this.links.values()]) {
        if (link.state === 'connecting') this._failLink(link, 'Did not connect in time');
      }
      // Everyone who is coming has a direct channel. The server is not needed any more.
      this._closeSignaling();
      this.peerConnected = true;
      this.onStateChange('P2P_CONNECTED');

      this._sendQueue = {
        files: list,
        index: -1,
        completed: 0, // files confirmed by every receiver still in
        bytesBefore: 0,
        totalBytes: list.reduce((sum, f) => sum + f.size, 0)
      };
      for (const link of ready) this._setLinkState(link, 'sending');

      if (this.worker) this.worker.terminate();
      this.worker = new Worker('/fileWorker.js');
      this._fan = new FanOutChannel((id, err) =>
        this._failLink(this.links.get(id), (err && err.message) || 'Could not send')
      );
      for (const link of ready) this._fan.add(link.id, link.dc);

      this.fileSender = new WebRTCFileSender(this._fan, {
        worker: this.worker,
        tolerateDisconnect: true, // each link has its own reconnect grace period
        onChunk: (info) => this._traceChunk('encrypt', info),
        onProgress: (p) => this._onSendProgress(p),
        onComplete: () => {
          // The file is fully queued for everyone. Confirmations come later, per receiver, and the
          // next file does not wait for them.
          const queue = this._sendQueue;
          if (queue.index < queue.files.length - 1) {
            this._sendNextFile().catch((err) => this._failTransfer(err));
          } else {
            this.onStateChange('AWAITING_RECEIVER_CONFIRMATION');
          }
        },
        onError: (err) => this._failTransfer(err),
        onBackpressureChange: (isPaused, bufferedAmount) => {
          this._trace('flow', isPaused ? 'pause' : 'resume', { bufferedAmount });
          this.onBackpressureChange(isPaused, bufferedAmount);
        }
      });

      this._stallTimer = setInterval(() => this._checkStalls(), STALL_CHECK_MS);
      await this._sendNextFile();
    }

    _onSendProgress(p) {
      const queue = this._sendQueue;
      if (!queue) return;
      const file = queue.files[queue.index];
      const slowest = p.bufferedAmount || 0;
      this.onFileProgress({
        ...p,
        // What has left the fullest queue: the pace of the slowest receiver
        bytesSent: Math.max(0, p.fileBytesQueued - slowest),
        fileName: file.name,
        fileSize: file.size,
        fileIndex: queue.index,
        fileCount: queue.files.length,
        totalBytes: queue.totalBytes,
        isReceiver: false
      });

      const now = Date.now();
      if (now - this._peerProgressAt < PEER_PROGRESS_MS && !p.isLast) return;
      this._peerProgressAt = now;
      for (const link of this._activeLinks()) {
        if (!link.dc || link.state === 'done') continue;
        const bytes = queue.bytesBefore + p.fileBytesQueued - (link.dc.bufferedAmount || 0);
        link.bytes = Math.max(0, Math.min(queue.totalBytes, bytes));
        this.onPeerProgress({
          peerId: link.id,
          label: link.label,
          bytes: link.bytes,
          totalBytes: queue.totalBytes
        });
      }
    }

    /**
     * A receiver whose queue has not moved for slowPeerMs is stuck. Drop it, and let the others go on.
     */
    _checkStalls() {
      const now = Date.now();
      for (const link of this._activeLinks()) {
        if (!link.dc || link.state !== 'sending' || link.graceTimer) {
          link.stallSince = null;
          continue;
        }
        const buffered = link.dc.bufferedAmount || 0;
        if (buffered > 0 && buffered >= link.lastBuffered && link.lastBuffered > 0) {
          if (link.stallSince === null) link.stallSince = now;
          if (now - link.stallSince > this.slowPeerMs) {
            this._failLink(link, 'Stopped receiving data');
            continue;
          }
        } else {
          link.stallSince = null;
        }
        link.lastBuffered = buffered;
      }
    }

    async _sendNextFile() {
      const queue = this._sendQueue;
      queue.index++;
      const fileIndex = queue.index;
      const file = queue.files[fileIndex];
      queue.bytesBefore = queue.files.slice(0, fileIndex).reduce((sum, f) => sum + f.size, 0);
      const totalChunks = Math.ceil(file.size / H.RAW_CHUNK_SIZE) || 1;

      // The header is the same for everyone, so it is encrypted once
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
      if (this._failed || !this._fan) return;
      this._fan.send(JSON.stringify({ type: 'FILE_HEADER', header }));
      this._trace('crypto', 'header-encrypt', {
        fileIndex,
        nonce: INSPECTOR ? INSPECTOR.nonceHex(fileIndex, HEADER_NONCE_INDEX) : null,
        plaintext: {
          fileName: file.name,
          fileSize: file.size,
          totalChunks,
          fileCount: queue.files.length
        },
        ciphertextChars: header.length,
        ciphertextPreview: header.slice(0, 40)
      });
      this._trace('transfer', 'file-start', {
        fileIndex,
        fileName: file.name,
        fileSize: file.size,
        totalChunks
      });
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

    // -----------------------------------------------------------------------------------------
    // Confirmations
    // -----------------------------------------------------------------------------------------

    _handleLinkMessage(link, event) {
      if (typeof event.data !== 'string') return;
      let control;
      try {
        control = JSON.parse(event.data);
      } catch {
        return;
      }
      if (control && control.type === 'FILE_ACK') this._handleLinkAck(link, control);
    }

    _handleLinkAck(link, control) {
      if (this._finished || this._failed || link.state === 'failed') return;
      this._trace(
        'transfer',
        'ack-received',
        { fileIndex: control.fileIndex, ok: control.ok },
        link.id
      );
      if (!control.ok) {
        this._failLink(link, 'The receiver rejected the transfer');
        return;
      }
      const queue = this._sendQueue;
      if (!queue || control.fileIndex !== link.acked || control.fileIndex > queue.index) {
        this._failLink(link, 'Unexpected acknowledgement from the receiver');
        return;
      }
      link.acked++;
      link.stallSince = null;
      if (link.acked === queue.files.length) {
        link.bytes = queue.totalBytes;
        this._setLinkState(link, 'done');
        this.onPeerProgress({
          peerId: link.id,
          label: link.label,
          bytes: queue.totalBytes,
          totalBytes: queue.totalBytes
        });
      } else {
        this._publishPeers();
      }
      this._completeFiles();
    }

    /** A file is complete when every receiver still in has confirmed it. */
    _completeFiles() {
      const queue = this._sendQueue;
      if (!queue || this._finished) return;
      const active = this._activeLinks();
      if (active.length === 0) return;
      const confirmedByAll = Math.min(...active.map((l) => l.acked));
      while (queue.completed < confirmedByAll) {
        const fileIndex = queue.completed++;
        const file = queue.files[fileIndex];
        const isLast = fileIndex === queue.files.length - 1;
        if (isLast) {
          this._finished = true;
          if (this.fileSender) this.fileSender.isTransferring = false;
        }
        this.onFileComplete({
          fileName: file.name,
          fileSize: file.size,
          fileIndex,
          fileCount: queue.files.length,
          totalBytes: queue.totalBytes,
          isLast,
          isReceiver: false
        });
      }
    }

    // -----------------------------------------------------------------------------------------
    // Teardown
    // -----------------------------------------------------------------------------------------

    // Tell every receiver, not just one, when something goes wrong
    _sendControl(obj) {
      if (this._fan) this._fan.send(JSON.stringify(obj));
    }

    _teardownP2P() {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
      for (const link of this.links.values()) this._closeLink(link);
      this._fan = null;
      super._teardownP2P();
    }
  }

  if (isNode) {
    module.exports = { SenderHub, FanOutChannel };
  } else {
    root.SenderHub = SenderHub;
    root.FanOutChannel = FanOutChannel;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
