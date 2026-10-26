'use strict';

/**
 * Developers tab: draws the in-page recorder (inspector.js) as a live view of the connection and
 * the encryption, and owns the top navigation that switches to it. Read-only: it never changes how
 * a transfer behaves, and nothing it shows is sent anywhere.
 */
(function () {
  if (typeof document === 'undefined' || typeof Inspector === 'undefined') return;

  const $ = (id) => document.getElementById(id);
  const shell = $('shell');
  const viewTransfer = $('viewTransfer');
  const viewDev = $('viewDevelopers');
  const privacyAside = $('privacyAside');
  const navTransfer = $('navTransfer');
  const navDev = $('navDevelopers');
  if (!viewDev || !navDev) return;

  const RENDER_MIN_INTERVAL_MS = 200;
  const LOG_ROWS = 200;
  const CHUNK_ROWS = 40;

  let visible = false;
  let paused = false;
  let maskIps = false;
  let showKey = false;
  let sdpSide = 'local';
  let dirty = true;
  let queued = false;
  let lastRender = 0;
  const hiddenCats = new Set();

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------
  const bytes = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = n / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
  };
  const rate = (n) => (typeof n === 'number' && n > 0 ? `${bytes(n)}/s` : '0 B/s');
  const addr = (a) => (maskIps ? Inspector.maskAddress(a) : a);
  const masked = (text) => (maskIps ? Inspector.maskText(text) : text);
  const rel = (ms) => `+${(ms / 1000).toFixed(2)} s`;
  const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '–');

  function setText(el, value) {
    const text = value == null || value === '' ? '–' : String(value);
    if (el.textContent !== text) el.textContent = text;
  }

  function fillKv(dl, rows) {
    const frag = document.createDocumentFragment();
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value == null || value === '' ? '–' : String(value);
      frag.append(dt, dd);
    }
    dl.replaceChildren(frag);
  }

  const find = (events, cat, types) =>
    events.find((e) => e.cat === cat && (!types || types.includes(e.type)));

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------
  function renderSummary(events, state) {
    const session = state.session || {};
    setText($('devRole'), session.role || '–');
    setText($('devRoom'), session.roomCode || '–');

    const iceEvents = events.filter((e) => e.cat === 'ice' && e.type === 'state');
    const ice = iceEvents.length ? iceEvents[iceEvents.length - 1].data.state : null;
    setText($('devIce'), ice || (find(events, 'signaling', ['open']) ? 'signaling only' : '–'));

    const stats = state.stats;
    const pair = stats && stats.pair;
    if (pair) {
      const kind = pair.relayed ? 'Relayed (TURN)' : 'Direct';
      setText($('devPathKind'), `${kind}`);
      setText($('devRtt'), pair.rttMs == null ? '–' : `${pair.rttMs} ms`);
      setText($('devRate'), `${rate(stats.sentPerSec)} out, ${rate(stats.recvPerSec)} in`);
    } else {
      setText($('devPathKind'), '–');
      setText($('devRtt'), '–');
      setText($('devRate'), '–');
    }
  }

  const STEP_RULES = [
    ['signaling', (e) => e.cat === 'signaling' && e.type === 'open'],
    [
      'room',
      (e) => e.cat === 'signaling' && e.type === 'in' && ['created', 'joined'].includes(e.data.type)
    ],
    [
      'peer',
      (e) =>
        e.cat === 'signaling' && e.type === 'in' && ['peer-joined', 'joined'].includes(e.data.type)
    ],
    ['offer', (e) => e.cat === 'sdp' && e.type.endsWith('offer')],
    ['answer', (e) => e.cat === 'sdp' && e.type.endsWith('answer')],
    ['candidates', (e) => e.cat === 'ice' && e.type === 'candidate-local'],
    ['pair', (e) => e.cat === 'ice' && e.type === 'pair-selected'],
    ['dtls', (e) => e.cat === 'ice' && e.type === 'dtls'],
    ['channel', (e) => e.cat === 'channel' && e.type === 'open'],
    ['key', (e) => e.cat === 'crypto' && e.type === 'key'],
    ['header', (e) => e.cat === 'crypto' && e.type.startsWith('header-')],
    ['chunks', (e) => e.cat === 'crypto' && e.type.startsWith('chunk-')],
    ['ack', (e) => e.cat === 'transfer' && e.type.startsWith('ack-')]
  ];

  function renderSteps(events) {
    const t0 = events.length ? events[0].t : 0;
    for (const [key, test] of STEP_RULES) {
      const li = viewDev.querySelector(`[data-step="${key}"]`);
      if (!li) continue;
      const hit = events.find(test);
      const stateEl = li.querySelector('.step-state');
      li.dataset.done = hit ? 'true' : 'false';
      setText(stateEl, hit ? `done ${rel(hit.t - t0)}` : 'waiting');
    }
  }

  function renderSdp(state) {
    const entry = state[`sdp.${sdpSide}`];
    const kv = $('devSdpSummary');
    const raw = $('devSdpRaw');
    if (!entry) {
      fillKv(kv, [['Status', `No ${sdpSide === 'local' ? 'local' : 'remote'} description yet`]]);
      raw.textContent = '';
      return;
    }
    const p = entry.parsed;
    fillKv(kv, [
      ['Type', entry.type],
      ['Size', `${num(entry.sdp.length)} bytes, ${p.lines} lines`],
      ['Media', p.media.join(' | ')],
      ['Data channel port', p.sctpPort == null ? '–' : `sctp-port ${p.sctpPort}`],
      ['Max message size', p.maxMessageSize == null ? '–' : `${num(p.maxMessageSize)} bytes`],
      ['ICE user fragment', p.iceUfrag],
      ['ICE password', '[hidden]'],
      ['DTLS fingerprint', p.fingerprint ? `${p.fingerprintAlgorithm} ${p.fingerprint}` : null],
      ['DTLS role', p.setup],
      ['Candidates in SDP', p.candidates.length]
    ]);
    // The ICE password is a session credential. It is never needed on screen.
    raw.textContent = masked(entry.sdp.replace(/^(a=ice-pwd:).*$/gm, '$1[hidden]'));
  }

  function renderCandidates(events) {
    const body = $('devCandBody');
    const rows = events.filter(
      (e) => e.cat === 'ice' && (e.type === 'candidate-local' || e.type === 'candidate-remote')
    );
    const frag = document.createDocumentFragment();
    for (const e of rows) {
      const c = e.data.parsed;
      const tr = document.createElement('tr');
      tr.dataset.kind = c ? c.type : '';
      const cells = [
        e.type === 'candidate-local' ? 'ours' : 'theirs',
        c ? c.type : '?',
        c ? c.protocol : '?',
        c ? addr(c.address) : masked(e.data.raw),
        c ? c.port : '',
        c ? num(c.priority) : ''
      ];
      for (const value of cells) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      frag.append(tr);
    }
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'No candidates yet.';
      tr.append(td);
      frag.append(tr);
    }
    body.replaceChildren(frag);

    const config = find(events, 'ice', ['config']);
    const servers = config
      ? config.data.servers
          .map((s) => `${s.urls.join(', ')}${s.credentials ? ' (login hidden)' : ''}`)
          .join(' | ')
      : null;
    setText($('devIceServers'), servers ? `STUN / TURN servers used: ${servers}` : '');
  }

  const endpoint = (c) =>
    c
      ? `${c.type} ${c.protocol || ''} ${addr(c.address)}:${c.port}${c.relayProtocol ? ` via ${c.relayProtocol}` : ''}`.replace(
          /\s+/g,
          ' '
        )
      : '–';

  function renderPeers(state) {
    const peers = state.peers || [];
    const card = $('devPeersCard');
    card.hidden = peers.length === 0;
    if (!peers.length) return;
    const frag = document.createDocumentFragment();
    for (const p of peers) {
      const tr = document.createElement('tr');
      const cells = [
        p.label,
        p.reconnecting ? 'reconnecting' : p.state + (p.reason ? ` (${p.reason})` : ''),
        p.path || '–',
        p.rttMs == null ? '–' : `${p.rttMs} ms`,
        p.acked,
        bytes(p.bytes)
      ];
      for (const value of cells) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      frag.append(tr);
    }
    $('devPeersBody').replaceChildren(frag);
  }

  function renderPath(state) {
    const stats = state.stats;
    const pair = stats && stats.pair;
    if (!pair) {
      fillKv($('devPathKv'), [['Status', 'Waiting for a network path to be chosen']]);
      return;
    }
    fillKv($('devPathKv'), [
      ['State', pair.state],
      ['Our end', endpoint(pair.local)],
      ['Their end', endpoint(pair.remote)],
      ['Relayed through TURN', pair.relayed ? 'yes' : 'no, direct between the two browsers'],
      ['Round trip', pair.rttMs == null ? '–' : `${pair.rttMs} ms`],
      ['Sent on this path', bytes(pair.bytesSent)],
      ['Received on this path', bytes(pair.bytesReceived)],
      [
        'Estimated send capacity',
        pair.availableOutgoingBitrate ? `${bytes(pair.availableOutgoingBitrate / 8)}/s` : '–'
      ]
    ]);
  }

  function renderSecurity(events, state) {
    const t = state.stats && state.stats.transport;
    const open = find(events, 'channel', ['open']);
    const rows = t
      ? [
          ['DTLS state', t.dtlsState],
          ['Protocol', t.tlsVersion],
          ['Cipher suite', t.dtlsCipher],
          ['DTLS role', t.dtlsRole],
          ['ICE state', t.iceState]
        ]
      : [['Status', 'Waiting for the DTLS handshake']];
    if (open) {
      rows.push(
        ['Data channel', `"${open.data.label}", id ${open.data.id}`],
        ['Ordered, reliable', open.data.ordered ? 'yes' : 'no'],
        [
          'Max message size',
          open.data.maxMessageSize ? `${num(open.data.maxMessageSize)} bytes` : '–'
        ]
      );
    }
    fillKv($('devSecKv'), rows);
  }

  const HIDDEN_KEY = 'hidden (turn on "Show key (demo only)" to display it)';

  function renderCrypto(events, state) {
    const key = state.key;
    const secret = Inspector.getSecret();
    fillKv($('devKeyKv'), [
      ['Cipher', key ? `${key.algorithm}, ${key.bits}-bit key` : null],
      ['Key fingerprint', key ? `${key.fingerprint} (first 8 bytes of SHA-256)` : null],
      ['Where the key came from', key ? key.origin : null],
      ['Key value', secret ? (showKey ? secret : HIDDEN_KEY) : null]
    ]);

    const rows = events
      .filter(
        (e) => e.cat === 'crypto' && (e.type.startsWith('header-') || e.type.startsWith('chunk-'))
      )
      .slice(-CHUNK_ROWS)
      .reverse();
    const body = $('devChunkBody');
    const frag = document.createDocumentFragment();
    for (const e of rows) {
      const d = e.data;
      const isHeader = e.type.startsWith('header-');
      const label = e.type.replace('-', ' ');
      const cells = isHeader
        ? [
            label,
            d.fileIndex + 1,
            'header',
            d.nonce,
            d.plaintext ? `${d.plaintext.fileName} (${bytes(d.plaintext.fileSize)})` : '–',
            d.ciphertextChars == null ? '–' : `${num(d.ciphertextChars)} chars`,
            d.ciphertextPreview || (d.authenticated ? 'authenticated' : '–'),
            '–'
          ]
        : [
            label,
            d.fileIndex + 1,
            `${d.chunkIndex + 1} / ${d.totalChunks}`,
            d.nonce,
            `${num(d.plainBytes)} B`,
            `${num(d.cipherBytes)} B`,
            d.preview,
            d.ms == null ? '–' : `${d.ms} ms`
          ];
      const tr = document.createElement('tr');
      for (const value of cells) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      frag.append(tr);
    }
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = 'No encryption has happened yet. Send or receive a file.';
      tr.append(td);
      frag.append(tr);
    }
    body.replaceChildren(frag);

    const totals = state.totals;
    setText(
      $('devTotals'),
      totals
        ? `${num(totals.chunks)} chunks ${totals.kind === 'encrypt' ? 'encrypted' : 'decrypted'}: ${bytes(totals.plainBytes)} of data became ${bytes(totals.cipherBytes)} on the wire (16 bytes of authentication tag per chunk).`
        : ''
    );
  }

  function sparkPath(series, field, max) {
    if (series.length < 2) return '';
    const step = 300 / 59;
    return series
      .map(
        (p, i) =>
          `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(62 - (p[field] / max) * 60).toFixed(1)}`
      )
      .join(' ');
  }

  function renderFlow(events, state) {
    const series = state.series || [];
    const max = Math.max(1, ...series.map((p) => Math.max(p.sent, p.recv)));
    $('devSparkSent').setAttribute('d', sparkPath(series, 'sent', max));
    $('devSparkRecv').setAttribute('d', sparkPath(series, 'recv', max));

    const pauses = events.filter((e) => e.cat === 'flow' && e.type === 'pause').length;
    const resumes = events.filter((e) => e.cat === 'flow' && e.type === 'resume').length;
    const lastFlow = [...events].reverse().find((e) => e.cat === 'flow');
    const ch = state.stats && state.stats.channel;
    fillKv($('devFlowKv'), [
      ['Peak scale of graph', `${bytes(max)}/s`],
      ['Sender paused', `${pauses} times (buffer over 1 MB)`],
      ['Sender resumed', `${resumes} times (buffer under 256 KB)`],
      ['Last buffer level', lastFlow ? bytes(lastFlow.data.bufferedAmount) : '–'],
      [
        'Messages through the channel',
        ch ? `${num(ch.messagesSent)} out, ${num(ch.messagesReceived)} in` : '–'
      ]
    ]);
  }

  function renderServer(events) {
    const out = events.filter((e) => e.cat === 'signaling' && e.type === 'out');
    const check = $('devKeyCheck');
    if (!Inspector.getSecret()) {
      check.dataset.ok = '';
      setText(check, 'No key yet. Start or join a transfer.');
    } else if (out.some((e) => e.data.containsKey)) {
      check.dataset.ok = 'false';
      setText(check, 'WARNING: the key appeared in a message sent to the server.');
    } else {
      check.dataset.ok = 'true';
      setText(
        check,
        `Checked: the key is in none of the ${out.length} messages sent to the server.`
      );
    }

    const groups = new Map();
    for (const e of out) {
      const g = groups.get(e.data.type) || { count: 0, bytes: 0 };
      g.count++;
      g.bytes += e.data.bytes || 0;
      groups.set(e.data.type, g);
    }
    const list = $('devServerSent');
    const frag = document.createDocumentFragment();
    for (const [type, g] of groups) {
      const li = document.createElement('li');
      li.textContent = `${type} × ${g.count} (${num(g.bytes)} bytes)`;
      frag.append(li);
    }
    if (!groups.size) {
      const li = document.createElement('li');
      li.textContent = 'Nothing yet';
      frag.append(li);
    }
    list.replaceChildren(frag);
  }

  function describe(e) {
    const d = e.data;
    switch (`${e.cat}/${e.type}`) {
      case 'signaling/open':
        return `connected to ${d.url}`;
      case 'signaling/close':
        return 'signaling connection closed (expected once the direct channel is open)';
      case 'signaling/out':
      case 'signaling/in': {
        const arrow = e.type === 'out' ? 'to server' : 'from server';
        const extra = d.payload && d.payload.roomCode ? ` room ${d.payload.roomCode}` : '';
        const msg = d.payload && d.payload.message ? ` "${d.payload.message}"` : '';
        const cand =
          d.payload && d.payload.candidate && d.payload.candidate.candidate
            ? ` ${d.payload.candidate.candidate.split(' ').slice(2, 8).join(' ')}`
            : '';
        return `${arrow}: ${d.type}${extra}${msg}${cand} (${num(d.bytes)} bytes)`;
      }
      case 'ice/config':
        return `servers: ${d.servers.map((s) => s.urls.join(',')).join(' | ')}`;
      case 'ice/candidate-local':
      case 'ice/candidate-remote': {
        const c = d.parsed;
        const who = e.type === 'candidate-local' ? 'ours' : 'theirs';
        return c
          ? `${who}: ${c.type} ${c.protocol} ${addr(c.address)}:${c.port}`
          : `${who}: ${d.raw}`;
      }
      case 'ice/state':
        return `ICE connection: ${d.state}`;
      case 'ice/connection':
        return `peer connection: ${d.state}`;
      case 'ice/gathering':
        return `address gathering: ${d.state}`;
      case 'ice/gathering-done':
        return 'address gathering finished';
      case 'ice/signaling-state':
        return `negotiation state: ${d.state}`;
      case 'ice/pair-selected':
        return `path chosen: ${endpoint(d.local)} <-> ${endpoint(d.remote)}${d.relayed ? ' (relayed)' : ' (direct)'}`;
      case 'ice/dtls':
        return `DTLS connected: ${d.tlsVersion || ''} ${d.dtlsCipher || ''}`.trim();
      case 'channel/open':
        return `data channel "${d.label}" open`;
      case 'channel/close':
        return 'data channel closed';
      case 'crypto/key':
        return `${d.algorithm} key ready (${d.origin}), fingerprint ${d.fingerprint}`;
      case 'crypto/header-encrypt':
        return `file ${d.fileIndex + 1} header encrypted, nonce ${d.nonce}`;
      case 'crypto/header-decrypt':
        return `file ${d.fileIndex + 1} header decrypted and authenticated, nonce ${d.nonce}`;
      case 'crypto/chunk-encrypt':
      case 'crypto/chunk-decrypt':
        return `file ${d.fileIndex + 1} chunk ${d.chunkIndex + 1}/${d.totalChunks} ${e.type === 'chunk-encrypt' ? 'encrypted' : 'decrypted'}, nonce ${d.nonce}, ${num(d.cipherBytes)} B`;
      case 'transfer/file-start':
        return `file ${d.fileIndex + 1} started: ${d.fileName} (${bytes(d.fileSize)}, ${d.totalChunks} chunks)`;
      case 'transfer/file-done':
        return `file ${d.fileIndex + 1} complete: ${d.fileName} (${bytes(d.bytes)})`;
      case 'transfer/ack-sent':
        return `confirmation sent for file ${d.fileIndex + 1}`;
      case 'transfer/ack-received':
        return `confirmation received for file ${d.fileIndex + 1}${d.ok === false ? ' (rejected)' : ''}`;
      case 'transfer/peer-joined':
        return `${d.label} joined the room`;
      case 'transfer/peer-failed':
        return `${d.label} dropped out: ${d.reason}`;
      case 'flow/pause':
        return `sending paused, ${bytes(d.bufferedAmount)} waiting in the channel`;
      case 'flow/resume':
        return `sending resumed, ${bytes(d.bufferedAmount)} waiting`;
      default:
        if (e.cat === 'sdp') return `${e.type.replace('-', ' ')} (${num(d.bytes)} bytes)`;
        return `${e.type} ${JSON.stringify(d)}`;
    }
  }

  function renderLog(events, peers) {
    if (paused) return;
    const labels = new Map((peers || []).map((p) => [p.peerId, p.label]));
    const t0 = events.length ? events[0].t : 0;
    const shown = events.filter((e) => !hiddenCats.has(e.cat));
    const slice = shown.slice(-LOG_ROWS).reverse();
    const frag = document.createDocumentFragment();
    for (const e of slice) {
      const li = document.createElement('li');
      li.dataset.cat = e.cat;
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = rel(e.t - t0);
      const tag = document.createElement('span');
      tag.className = 'log-tag';
      tag.textContent = e.cat;
      const text = document.createElement('span');
      text.className = 'log-text';
      text.textContent = masked(
        (e.peer && labels.has(e.peer) ? `[${labels.get(e.peer)}] ` : '') + describe(e)
      );
      li.append(time, tag, text);
      frag.append(li);
    }
    $('devLog').replaceChildren(frag);
    setText($('devLogCount'), `${shown.length} events shown of ${events.length} kept`);
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------
  function render() {
    queued = false;
    dirty = false;
    lastRender = performance.now();
    const { events, state } = Inspector.snapshot();
    renderSummary(events, state);
    renderSteps(events);
    renderSdp(state);
    renderCandidates(events);
    renderPeers(state);
    renderPath(state);
    renderSecurity(events, state);
    renderCrypto(events, state);
    renderFlow(events, state);
    renderServer(events);
    renderLog(events, state.peers);
  }

  function schedule() {
    dirty = true;
    if (!visible || queued) return;
    queued = true;
    const wait = Math.max(0, RENDER_MIN_INTERVAL_MS - (performance.now() - lastRender));
    setTimeout(() => requestAnimationFrame(render), wait);
  }

  Inspector.subscribe(schedule);

  // -------------------------------------------------------------------------
  // Navigation and controls
  // -------------------------------------------------------------------------
  function show(view) {
    visible = view === 'developers';
    viewTransfer.hidden = visible;
    viewDev.hidden = !visible;
    if (privacyAside) privacyAside.hidden = visible;
    shell.classList.toggle('shell--wide', visible);
    if (visible) navDev.setAttribute('aria-current', 'page');
    else navDev.removeAttribute('aria-current');
    if (visible) navTransfer.removeAttribute('aria-current');
    else navTransfer.setAttribute('aria-current', 'page');
    if (visible) render();
  }

  navTransfer.addEventListener('click', () => show('transfer'));
  navDev.addEventListener('click', () => show('developers'));

  $('devMaskIps').addEventListener('change', (e) => {
    maskIps = e.target.checked;
    render();
  });
  $('devShowKey').addEventListener('change', (e) => {
    showKey = e.target.checked;
    render();
  });

  const btnPause = $('btnDevPause');
  btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPause.textContent = paused ? 'Resume log' : 'Pause log';
    render();
  });
  $('btnDevClear').addEventListener('click', () => {
    Inspector.clearEvents();
  });

  const sdpButtons = { local: $('devSdpLocal'), remote: $('devSdpRemote') };
  for (const side of Object.keys(sdpButtons)) {
    sdpButtons[side].addEventListener('click', () => {
      sdpSide = side;
      for (const [k, btn] of Object.entries(sdpButtons))
        btn.setAttribute('aria-pressed', String(k === side));
      render();
    });
  }

  viewDev.querySelectorAll('.dev-filters input[data-cat]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) hiddenCats.delete(box.dataset.cat);
      else hiddenCats.add(box.dataset.cat);
      render();
    });
  });

  $('btnDevCopy').addEventListener('click', async () => {
    const { events, state } = Inspector.snapshot();
    const sanitized = JSON.stringify(
      { exportedAt: new Date().toISOString(), events, state },
      null,
      2
    ).replace(/(a=ice-pwd:)[^\\\r\n"]*/g, '$1[hidden]');
    const text = maskIps ? Inspector.maskText(sanitized) : sanitized;
    const button = $('btnDevCopy');
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = 'Copy as JSON'), 1500);
  });

  // The recorder can hold a session from before this tab was opened. Draw it once when shown.
  dirty = true;
})();
