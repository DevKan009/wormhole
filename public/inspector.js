'use strict';

/**
 * Inspector: a bounded, in-page record of what the app is doing, for the Developers tab.
 *
 * Everything stays in this page. Nothing here is sent anywhere. The app code calls emit() and set()
 * at the real points where it signals, negotiates, encrypts and moves data, so the Developers tab
 * shows what actually happens and not a simulation.
 *
 * The encryption key is a secret. setSecret() registers it, and every value passed to emit() or
 * set() is scrubbed so the key cannot reach the log by accident. Only the key *fingerprint* is
 * ever recorded. The Developers tab can reveal the key on request, from the secret itself.
 */
(function (root) {
  const MAX_EVENTS = 600;
  const SECRET_PLACEHOLDER = '[key hidden]';

  let seq = 0;
  let events = [];
  let state = {};
  let secret = null;
  const listeners = new Set();

  function scrub(value, depth = 0) {
    if (secret && typeof value === 'string') {
      return value.includes(secret) ? value.split(secret).join(SECRET_PLACEHOLDER) : value;
    }
    if (value === null || typeof value !== 'object' || depth > 6) return value;
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) out[key] = scrub(value[key], depth + 1);
    return out;
  }

  function notify(change) {
    for (const fn of listeners) {
      try {
        fn(change);
      } catch (err) {
        console.error('Inspector listener failed:', err);
      }
    }
  }

  /**
   * Records one event.
   * @param {string} cat Category: signaling, sdp, ice, channel, crypto, transfer, flow
   * @param {string} type What happened, e.g. "offer" or "chunk-encrypt"
   * @param {object} [data]
   * @param {string|null} [peer] Which receiver, when sending to several
   */
  function emit(cat, type, data = {}, peer = null) {
    const event = { id: ++seq, t: Date.now(), cat, type, peer, data: scrub(data) };
    events.push(event);
    if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
    notify({ event });
    return event;
  }

  /** Stores the latest value of something that is state rather than an event (selected path...). */
  function set(key, value) {
    state[key] = scrub(value);
    notify({ key });
  }

  function get(key) {
    return state[key];
  }

  function snapshot() {
    return { events: events.slice(), state: { ...state } };
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Forgets events, keeps current state. */
  function clearEvents() {
    events = [];
    notify({ cleared: true });
  }

  /** New session: forget everything, including the registered secret. */
  function reset() {
    events = [];
    state = {};
    secret = null;
    notify({ reset: true });
  }

  function setSecret(value) {
    secret = typeof value === 'string' && value.length >= 16 ? value : null;
  }

  function getSecret() {
    return secret;
  }

  // -----------------------------------------------------------------------------------------
  // Pure helpers (also used by tests)
  // -----------------------------------------------------------------------------------------

  /** Lower-case hex of the first `max` bytes of a buffer or typed array. */
  function hex(bytes, max = bytes.byteLength) {
    const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    const n = Math.min(max, view.byteLength);
    let out = '';
    for (let i = 0; i < n; i++) out += view[i].toString(16).padStart(2, '0');
    return out;
  }

  /** The 96-bit AES-GCM nonce for a chunk: file index in the high 32 bits, chunk index below. */
  function nonceHex(fileIndex, chunkIndex) {
    const value = (BigInt(fileIndex) << 64n) | BigInt(chunkIndex);
    return value.toString(16).padStart(24, '0');
  }

  /** Which chunks of a file get a row in the log: the first few, every 64th, and the last. */
  function shouldSampleChunk(chunkIndex, totalChunks) {
    return chunkIndex < 3 || chunkIndex % 64 === 0 || chunkIndex === totalChunks - 1;
  }

  /** Hides the host part of an address for screen sharing: 192.168.1.5 -> 192.168.*.* */
  function maskAddress(address) {
    if (typeof address !== 'string' || address === '') return address;
    if (/\.local$/i.test(address)) return '*.local';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
      const [a, b] = address.split('.');
      return `${a}.${b}.*.*`;
    }
    if (address.includes(':')) {
      const groups = address.split(':').filter(Boolean);
      return `${groups.slice(0, 2).join(':')}::*`;
    }
    return address;
  }

  /**
   * Splits an ICE candidate line ("candidate:842163049 1 udp 1677729535 203.0.113.5 41234 typ
   * srflx raddr 10.0.0.2 rport 41234 ...") into its fields.
   */
  function parseCandidate(line) {
    if (typeof line !== 'string') return null;
    const text = line.replace(/^a=/, '').replace(/^candidate:/, '');
    const parts = text.trim().split(/\s+/);
    if (parts.length < 8 || parts[6] !== 'typ') return null;
    const out = {
      foundation: parts[0],
      component: Number(parts[1]),
      protocol: parts[2].toLowerCase(),
      priority: Number(parts[3]),
      address: parts[4],
      port: Number(parts[5]),
      type: parts[7]
    };
    for (let i = 8; i + 1 < parts.length; i += 2) {
      if (parts[i] === 'raddr') out.relatedAddress = parts[i + 1];
      else if (parts[i] === 'rport') out.relatedPort = Number(parts[i + 1]);
      else if (parts[i] === 'tcptype') out.tcpType = parts[i + 1];
    }
    return out;
  }

  /** Pulls the interesting facts out of an SDP blob. */
  function parseSdp(sdp) {
    const out = {
      lines: 0,
      iceUfrag: null,
      icePwd: null,
      fingerprint: null,
      fingerprintAlgorithm: null,
      setup: null,
      mid: null,
      media: [],
      sctpPort: null,
      maxMessageSize: null,
      iceOptions: null,
      candidates: []
    };
    if (typeof sdp !== 'string') return out;
    const lines = sdp.split(/\r?\n/).filter(Boolean);
    out.lines = lines.length;
    for (const line of lines) {
      let m;
      if (line.startsWith('m=')) out.media.push(line.slice(2));
      else if ((m = /^a=ice-ufrag:(.+)$/.exec(line))) out.iceUfrag = m[1];
      else if ((m = /^a=ice-pwd:(.+)$/.exec(line))) out.icePwd = m[1];
      else if ((m = /^a=ice-options:(.+)$/.exec(line))) out.iceOptions = m[1];
      else if ((m = /^a=fingerprint:(\S+) (.+)$/.exec(line))) {
        out.fingerprintAlgorithm = m[1];
        out.fingerprint = m[2];
      } else if ((m = /^a=setup:(.+)$/.exec(line))) out.setup = m[1];
      else if ((m = /^a=mid:(.+)$/.exec(line))) out.mid = m[1];
      else if ((m = /^a=sctp-port:(\d+)$/.exec(line))) out.sctpPort = Number(m[1]);
      else if ((m = /^a=max-message-size:(\d+)$/.exec(line))) out.maxMessageSize = Number(m[1]);
      else if (line.startsWith('a=candidate:')) {
        const candidate = parseCandidate(line);
        if (candidate) out.candidates.push(candidate);
      }
    }
    return out;
  }

  /** Masks addresses inside raw SDP / candidate text. */
  function maskText(text) {
    return String(text)
      .replace(/\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, '$1.$2.*.*')
      .replace(/\b[0-9a-f-]{36}\.local\b/gi, '*.local');
  }

  const TLS_VERSIONS = { FEFF: 'DTLS 1.0', FEFD: 'DTLS 1.2', FEFC: 'DTLS 1.3' };

  /**
   * Reduces an RTCStatsReport (anything with forEach(value, key)) to the selected network path,
   * the DTLS transport and the data channel.
   */
  function summarizeStats(report) {
    const byId = new Map();
    report.forEach((r) => byId.set(r.id, r));
    let transport = null;
    let channel = null;
    byId.forEach((r) => {
      if (r.type === 'transport' && !transport) transport = r;
      else if (r.type === 'data-channel' && !channel) channel = r;
    });

    let pair =
      transport && transport.selectedCandidatePairId
        ? byId.get(transport.selectedCandidatePairId)
        : null;
    if (!pair) {
      byId.forEach((r) => {
        if (
          !pair &&
          r.type === 'candidate-pair' &&
          (r.selected || (r.nominated && r.state === 'succeeded'))
        ) {
          pair = r;
        }
      });
    }
    const local = pair ? byId.get(pair.localCandidateId) : null;
    const remote = pair ? byId.get(pair.remoteCandidateId) : null;
    const shape = (c) =>
      c
        ? {
            type: c.candidateType,
            protocol: c.protocol,
            address: c.address || c.ip || null,
            port: c.port,
            relayProtocol: c.relayProtocol || null,
            networkType: c.networkType || null
          }
        : null;

    return {
      transport: transport
        ? {
            dtlsState: transport.dtlsState,
            iceState: transport.iceState || null,
            dtlsRole: transport.dtlsRole || null,
            tlsVersion: TLS_VERSIONS[transport.tlsVersion] || transport.tlsVersion || null,
            dtlsCipher: transport.dtlsCipher || null,
            srtpCipher: transport.srtpCipher || null,
            bytesSent: transport.bytesSent || 0,
            bytesReceived: transport.bytesReceived || 0
          }
        : null,
      pair: pair
        ? {
            state: pair.state,
            rttMs:
              typeof pair.currentRoundTripTime === 'number'
                ? Math.round(pair.currentRoundTripTime * 1000)
                : null,
            availableOutgoingBitrate: pair.availableOutgoingBitrate || null,
            bytesSent: pair.bytesSent || 0,
            bytesReceived: pair.bytesReceived || 0,
            local: shape(local),
            remote: shape(remote),
            relayed:
              (local && local.candidateType === 'relay') ||
              (remote && remote.candidateType === 'relay') ||
              false
          }
        : null,
      channel: channel
        ? {
            label: channel.label,
            state: channel.state,
            messagesSent: channel.messagesSent || 0,
            bytesSent: channel.bytesSent || 0,
            messagesReceived: channel.messagesReceived || 0,
            bytesReceived: channel.bytesReceived || 0
          }
        : null
    };
  }

  const api = {
    summarizeStats,
    emit,
    set,
    get,
    snapshot,
    subscribe,
    clearEvents,
    reset,
    setSecret,
    getSecret,
    hex,
    nonceHex,
    shouldSampleChunk,
    maskAddress,
    maskText,
    parseCandidate,
    parseSdp,
    MAX_EVENTS,
    SECRET_PLACEHOLDER
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Inspector = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
