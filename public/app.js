'use strict';

/**
 * EphemeralShare UI controller.
 * Owns the screen state; WebRTCManager owns the connection, encryption and protocol.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_FILES = 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function iconEl(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Transient confirmation. Errors never use this: they go to the persistent alert banner. */
function showToast(message, icon = 'info', durationMs = 3000) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.appendChild(iconEl(icon));
  const text = document.createElement('span');
  text.textContent = message; // textContent only: messages can include network-supplied text
  toast.appendChild(text);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, durationMs);
}

/** Turns technical error strings into something a person can act on. */
function friendlyError(message) {
  const m = String(message || '');
  if (/^Connection lost/i.test(m)) {
    return 'The connection to the other device dropped before the transfer finished. Nothing was stored on any server. Start over to try again.';
  }
  if (/Could not reach the signaling server/i.test(m)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (/Signaling connection closed/i.test(m)) {
    return 'The connection to the server closed before the other device joined. Start over to get a new link.';
  }
  if (/Room not found/i.test(m)) {
    return 'This link has expired or was already used. Ask the sender for a new one.';
  }
  if (/Room is full/i.test(m)) {
    return 'Someone has already opened this link. Ask the sender for a new one.';
  }
  if (/Could not decrypt/i.test(m)) {
    return "Couldn't decrypt the file. The link may be incomplete or altered. Ask the sender for a fresh link.";
  }
  if (/receiver rejected/i.test(m)) {
    return "The receiver couldn't verify the file, so the transfer was cancelled. Start over to try again.";
  }
  if (/no decryption key/i.test(m)) {
    return "That's only a room code. Paste the full link, it contains the key.";
  }
  return m || 'Something went wrong. Start over to try again.';
}

/** Draws a scannable QR code as a single SVG path (black on white, with the required quiet zone). */
function renderQrCode(container, text) {
  container.textContent = '';
  if (typeof qrcode !== 'function') return false;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code containing the share link');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#ffffff');
  const modules = document.createElementNS(SVG_NS, 'path');
  modules.setAttribute('d', path);
  modules.setAttribute('fill', '#000000');
  svg.append(bg, modules);
  container.appendChild(svg);
  return true;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  const modeCard = $('modeCard');
  const tabs = { send: $('tabSend'), receive: $('tabReceive') };
  const views = { send: $('viewSend'), receive: $('viewReceive') };

  const dropZone = $('dropZone');
  const fileInput = $('fileInput');
  const fileCard = $('fileCard');
  const fileCardTitle = $('fileCardTitle');
  const fileList = $('fileList');
  const btnAddMore = $('btnAddMore');
  const btnClearFiles = $('btnClearFiles');

  const shareCard = $('shareCard');
  const shareLinkInput = $('shareLinkInput');
  const btnCopyLink = $('btnCopyLink');
  const btnCopyLabel = $('btnCopyLabel');
  const senderRoomCode = $('senderRoomCode');
  const waitStatus = $('waitStatus');
  const waitStatusText = $('waitStatusText');
  const btnShowQR = $('btnShowQR');
  const qrPanel = $('qrPanel');
  const qrCode = $('qrCode');

  const receiverLinkInput = $('receiverLinkInput');
  const receiveHint = $('receiveHint');
  const btnJoinRoom = $('btnJoinRoom');
  const btnJoinLabel = $('btnJoinLabel');

  const noticeBox = $('noticeBox');
  const noticeText = $('noticeText');
  const alertBox = $('alertBox');
  const alertText = $('alertText');
  const btnAlertAction = $('btnAlertAction');

  const transferPanel = $('transferPanel');
  const transferTitle = $('transferTitle');
  const transferSubtitle = $('transferSubtitle');
  const transferBadge = $('transferBadge');
  const transferStatusText = $('transferStatusText');
  const overallBar = $('overallBar');
  const overallFill = $('overallFill');
  const metricProgress = $('metricProgress');
  const metricSpeed = $('metricSpeed');
  const metricTransferred = $('metricTransferred');
  const metricEta = $('metricEta');
  const transferList = $('transferList');
  const transferNote = $('transferNote');
  const transferActions = $('transferActions');
  const btnTransferReset = $('btnTransferReset');
  const btnTransferResetLabel = $('btnTransferResetLabel');

  let mode = 'send';
  let files = []; // sender: files chosen so far
  let locked = false; // sender: list is frozen once a receiver connects
  let roomRequested = false;
  let qrRendered = false;
  let xfer = null; // current transfer model, see initTransfer()
  let renderQueued = false;
  let disconnectTimer = null;

  const secureContext = window.isSecureContext && !!(window.crypto && window.crypto.subtle);

  // Clean up temporary files left behind by closed or crashed sessions
  if (typeof purgeStaleDiskFiles === 'function') purgeStaleDiskFiles();

  // -------------------------------------------------------------------------
  // Connection manager and its callbacks
  // -------------------------------------------------------------------------
  const rtcManager = new WebRTCManager({
    onSignalingSlow: () => {
      showNotice(
        'Waking up the server. Free hosting sleeps when idle, so this can take up to a minute. Hang tight.'
      );
    },

    onConnectionStatus: (status) => {
      if (!xfer || currentPhase !== 'transferring') return;
      if (status === 'reconnecting') {
        setBadge('Reconnecting…', 'warning');
        transferNote.hidden = false;
        transferNote.textContent =
          'The connection was interrupted. Keep this tab open and the transfer will continue if it comes back.';
      } else {
        setBadge(xfer.isReceiver ? 'Receiving' : 'Sending', 'info');
        refreshTransferNote();
      }
    },

    onRoomCreated: (code) => {
      hideNotice();
      senderRoomCode.textContent = code;
      shareLinkInput.value = shareLink() || '';
      shareCard.hidden = false;
      setWait('Waiting for the receiver to open the link…', true);
    },

    onJoined: () => {
      hideNotice();
      setHint('Joined. Opening a secure channel…', 'ok');
      btnJoinLabel.textContent = 'Connecting…';
    },

    onPeerJoined: () => {
      locked = true;
      renderFileList();
      setWait('Receiver connected. Opening a secure channel…', true);
    },

    onP2PConnected: () => {
      if (rtcManager.isInitiator && files.length > 0) {
        rtcManager.sendFiles(files).catch((err) => failWith(err.message));
      }
    },

    onP2PDisconnected: () => {
      markFailed();
    },

    onFileTransferStart: (info) => {
      cancelDisconnect();
      if (!xfer) initTransfer(info);
      const row = xfer.files[info.fileIndex];
      row.name = info.fileName;
      row.size = info.fileSize;
      row.state = 'active';
      row.bytes = 0;
      xfer.current = info.fileIndex;
      xfer.speed = 0;
      xfer.sample = { t: performance.now(), bytes: xfer.doneBytes };
      setBadge(info.isReceiver ? 'Receiving' : 'Sending', 'info');
      transferStatusText.textContent = info.isReceiver ? 'Receiving' : 'Sending';
      showTransferPanel();
      acquireWakeLock();
      renderTransferNow();
    },

    onFileProgress: (p) => {
      if (!xfer) return;
      const row = xfer.files[p.fileIndex];
      if (!row) return;
      row.bytes = Math.min(row.size, p.isReceiver ? p.bytesReceived : p.bytesSent);
      sampleSpeed();
      scheduleRender();
    },

    onFileComplete: (res) => {
      if (!xfer) return;
      const row = xfer.files[res.fileIndex];
      if (row) {
        row.state = 'done';
        row.bytes = row.size;
        xfer.doneBytes += row.size;
      }
      if (res.blob) downloadFile(res);
      if (res.isLast) {
        finishTransfer(res.isReceiver);
      } else {
        // Next file is announced by its own header
        setBadge('Between files', 'info');
        transferStatusText.textContent = res.isReceiver ? 'Receiving' : 'Sending';
      }
      renderTransferNow();
    },

    onStateChange: (state) => {
      if (state === 'AWAITING_RECEIVER_CONFIRMATION' && xfer && phase() === 'transferring') {
        transferStatusText.textContent = 'Waiting for receiver to confirm';
      }
    },

    onError: (message) => {
      failWith(message);
    }
  });

  function shareLink() {
    const fragment = rtcManager.getShareFragment();
    return fragment ? `${window.location.origin}/#${fragment}` : null;
  }

  // -------------------------------------------------------------------------
  // Phase and alert
  // -------------------------------------------------------------------------
  let currentPhase = 'idle'; // idle | waiting | transferring | done | failed
  function phase() {
    return currentPhase;
  }

  function showNotice(message) {
    noticeText.textContent = message;
    noticeBox.hidden = false;
  }

  function hideNotice() {
    noticeBox.hidden = true;
    noticeText.textContent = '';
  }

  // Keep the screen on while transferring: a phone that sleeps or backgrounds the tab drops the
  // connection. The lock is released by the browser when the tab is hidden, so take it again on return.
  let wakeLock = null;
  async function acquireWakeLock() {
    if (wakeLock || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch {
      wakeLock = null; // denied, for example in low-power mode: the transfer still works
    }
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentPhase === 'transferring')
      acquireWakeLock();
  });

  function showAlert(message, { action = true } = {}) {
    hideNotice();
    alertText.textContent = friendlyError(message);
    btnAlertAction.hidden = !action;
    alertBox.hidden = false;
  }

  function hideAlert() {
    alertBox.hidden = true;
    alertText.textContent = '';
  }

  /** First error wins: follow-up errors from the same failure must not overwrite its message. */
  function failWith(message) {
    if (currentPhase === 'failed' || currentPhase === 'done') return;
    showAlert(message);
    markFailed();
  }

  function markFailed() {
    if (currentPhase === 'done' || currentPhase === 'failed') return;
    currentPhase = 'failed';
    releaseWakeLock();
    cancelDisconnect();
    if (xfer) {
      for (const row of xfer.files) {
        if (row.state === 'active') row.state = 'failed';
      }
      setBadge('Stopped', 'danger');
      transferStatusText.textContent = 'Stopped';
      transferActions.hidden = true; // the alert offers "Start over"
      renderTransferNow();
    }
    setWait('Stopped', false);
    resetJoinButton();
  }

  btnAlertAction.addEventListener('click', () => fullReset());

  if (!secureContext) {
    showAlert(
      'Encryption is unavailable on this page. Open it over HTTPS (or at http://localhost) and try again.',
      { action: false }
    );
    fileInput.disabled = true;
    btnJoinRoom.disabled = true;
    dropZone.setAttribute('aria-disabled', 'true');
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------
  function setMode(next, { focus = false } = {}) {
    mode = next;
    for (const key of Object.keys(tabs)) {
      const selected = key === next;
      tabs[key].setAttribute('aria-selected', String(selected));
      tabs[key].tabIndex = selected ? 0 : -1;
      views[key].hidden = !selected;
    }
    if (focus) tabs[next].focus();
  }

  tabs.send.addEventListener('click', () => setMode('send'));
  tabs.receive.addEventListener('click', () => setMode('receive'));

  $('viewSend')
    .parentElement.querySelector('[role="tablist"]')
    .addEventListener('keydown', (e) => {
      const order = ['send', 'receive'];
      const index = order.indexOf(mode);
      let nextIndex = null;
      if (e.key === 'ArrowRight') nextIndex = (index + 1) % order.length;
      else if (e.key === 'ArrowLeft') nextIndex = (index + order.length - 1) % order.length;
      else if (e.key === 'Home') nextIndex = 0;
      else if (e.key === 'End') nextIndex = order.length - 1;
      if (nextIndex === null) return;
      e.preventDefault();
      setMode(order[nextIndex], { focus: true });
    });

  // -------------------------------------------------------------------------
  // Sender: choosing files
  // -------------------------------------------------------------------------
  function addFiles(list) {
    if (locked || !secureContext) return;
    const known = new Set(files.map((f) => `${f.name}|${f.size}|${f.lastModified}`));
    let skipped = 0;
    for (const file of Array.from(list)) {
      const id = `${file.name}|${file.size}|${file.lastModified}`;
      if (known.has(id)) continue;
      if (files.length >= MAX_FILES) {
        skipped++;
        continue;
      }
      known.add(id);
      files.push(file);
    }
    if (skipped > 0)
      showToast(`Only ${MAX_FILES} files per transfer. ${skipped} skipped.`, 'alert');
    renderFileList();
    if (files.length > 0 && !roomRequested) startRoom();
  }

  function startRoom() {
    roomRequested = true;
    hideAlert();
    currentPhase = 'waiting';
    qrRendered = false;
    rtcManager.createRoom().catch((err) => {
      failWith(err && err.message ? err.message : 'Could not create a room');
    });
  }

  function renderFileList() {
    const has = files.length > 0;
    dropZone.hidden = has;
    fileCard.hidden = !has;
    btnAddMore.hidden = locked;
    btnClearFiles.hidden = locked;
    if (!has) return;

    const total = files.reduce((sum, f) => sum + f.size, 0);
    fileCardTitle.textContent = `${plural(files.length, 'file')} · ${formatBytes(total)}`;

    fileList.textContent = '';
    files.forEach((file, index) => {
      const li = document.createElement('li');
      li.className = 'file-row';

      const glyph = document.createElement('span');
      glyph.className = 'file-glyph';
      glyph.appendChild(iconEl('file'));

      const main = document.createElement('span');
      main.className = 'file-main';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name;
      name.title = file.name;
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = formatBytes(file.size);
      main.append(name, meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.disabled = locked;
      remove.hidden = locked;
      remove.appendChild(iconEl('x'));
      remove.addEventListener('click', () => removeFile(index));

      li.append(glyph, main, remove);
      fileList.appendChild(li);
    });
  }

  function removeFile(index) {
    if (locked) return;
    files.splice(index, 1);
    if (files.length === 0) {
      fullReset();
    } else {
      renderFileList();
    }
  }

  btnClearFiles.addEventListener('click', () => fullReset());
  btnAddMore.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) addFiles(fileInput.files);
    fileInput.value = ''; // lets the same file be picked again later
  });

  // Drag and drop is a convenience only: the label/input is the keyboard- and touch-friendly path
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
    const onSend = mode === 'send' && !views.send.hidden && !modeCard.hidden;
    if (onSend && e.dataTransfer && e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  });
  dropZone.addEventListener('dragenter', () => dropZone.classList.add('is-dragover'));
  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('is-dragover');
  });

  // -------------------------------------------------------------------------
  // Sender: sharing
  // -------------------------------------------------------------------------
  function setWait(text, pulsing) {
    waitStatusText.textContent = text;
    waitStatus.querySelector('.dot').classList.toggle('dot-pulse', pulsing);
  }

  shareLinkInput.addEventListener('focus', () => shareLinkInput.select());

  btnCopyLink.addEventListener('click', async () => {
    const url = shareLink();
    if (!url) return;
    let copied = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {}
    if (!copied) {
      shareLinkInput.focus();
      shareLinkInput.select();
      copied = !!(document.execCommand && document.execCommand('copy'));
    }
    if (copied) {
      btnCopyLabel.textContent = 'Copied';
      setTimeout(() => (btnCopyLabel.textContent = 'Copy link'), 2000);
      showToast('Link copied', 'check');
    } else {
      showToast('Press Ctrl+C to copy the selected link', 'info', 5000);
    }
  });

  btnShowQR.addEventListener('click', () => {
    const open = qrPanel.hidden;
    qrPanel.hidden = !open;
    btnShowQR.setAttribute('aria-expanded', String(open));
    btnShowQR.querySelector('span').textContent = open ? 'Hide QR code' : 'Show QR code';
    if (open && !qrRendered) {
      const url = shareLink();
      if (url) qrRendered = renderQrCode(qrCode, url);
    }
  });

  // -------------------------------------------------------------------------
  // Receiver
  // -------------------------------------------------------------------------
  function setHint(text, tone) {
    receiveHint.textContent = text;
    if (tone) receiveHint.dataset.tone = tone;
    else delete receiveHint.dataset.tone;
    receiverLinkInput.setAttribute('aria-invalid', String(tone === 'error'));
  }

  function resetJoinButton() {
    btnJoinRoom.disabled = !secureContext;
    btnJoinLabel.textContent = 'Connect and download';
  }

  btnJoinRoom.addEventListener('click', () => {
    const parsed = parseShareInput(receiverLinkInput.value);
    if (!parsed) {
      setHint(
        'That doesn’t look like a share link. Paste the whole link from the sender.',
        'error'
      );
      receiverLinkInput.focus();
      return;
    }
    if (!parsed.key) {
      setHint('That’s only the room code. Paste the full link, it contains the key.', 'error');
      receiverLinkInput.focus();
      return;
    }
    hideAlert();
    setHint('Contacting the sender…', 'ok');
    btnJoinRoom.disabled = true;
    btnJoinLabel.textContent = 'Connecting…';
    currentPhase = 'waiting';
    rtcManager.joinRoom(parsed.roomCode, parsed.key).catch((err) => {
      failWith(err && err.message ? err.message : 'Could not join the room');
    });
  });

  receiverLinkInput.addEventListener('input', () => setHint('', null));
  receiverLinkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoinRoom.click();
  });

  // Opened from a share link: "#ROOM.KEY". The fragment never leaves the browser.
  if (window.location.hash) {
    const fromHash = parseShareInput(window.location.hash);
    if (fromHash) {
      setMode('receive');
      receiverLinkInput.value = window.location.href;
      setHint(
        fromHash.key
          ? 'Link detected. Press Connect and download to start.'
          : 'This link has no key. Ask the sender for the full link.',
        fromHash.key ? 'ok' : 'error'
      );
      // Keep the key out of the address bar and browser history from here on
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  // -------------------------------------------------------------------------
  // Transfer panel
  // -------------------------------------------------------------------------
  function initTransfer(info) {
    const count = info.fileCount;
    xfer = {
      isReceiver: info.isReceiver,
      count,
      totalBytes: info.totalBytes,
      doneBytes: 0,
      current: 0,
      speed: 0,
      sample: { t: performance.now(), bytes: 0 },
      files: Array.from({ length: count }, (_, i) => {
        const known = !info.isReceiver ? files[i] : null;
        return {
          name: known ? known.name : `File ${i + 1}`,
          size: known ? known.size : 0,
          state: 'queued',
          bytes: 0,
          sizeKnown: !!known
        };
      })
    };
    currentPhase = 'transferring';
    transferTitle.textContent = info.isReceiver ? 'Receiving' : 'Sending';
    transferSubtitle.textContent = `${plural(count, 'file')} · ${formatBytes(info.totalBytes)}`;
    refreshTransferNote();
    transferActions.hidden = true;
    buildTransferRows();
  }

  function showTransferPanel() {
    modeCard.hidden = true;
    transferPanel.hidden = false;
  }

  function buildTransferRows() {
    transferList.textContent = '';
    xfer.files.forEach((row, index) => {
      const li = document.createElement('li');
      li.className = 'xfer-row';
      li.dataset.index = String(index);

      const glyph = document.createElement('span');
      glyph.className = 'file-glyph';

      const main = document.createElement('span');
      main.className = 'file-main';
      const name = document.createElement('span');
      name.className = 'file-name';
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      main.append(name, meta);

      const state = document.createElement('span');
      state.className = 'xfer-state';

      const bar = document.createElement('div');
      bar.className = 'progress';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      bar.appendChild(fill);

      li.append(glyph, main, state, bar);
      transferList.appendChild(li);
    });
  }

  function sampleSpeed() {
    const now = performance.now();
    const elapsed = (now - xfer.sample.t) / 1000;
    if (elapsed < 0.5) return;
    const total = overallBytes();
    const instant = Math.max(0, (total - xfer.sample.bytes) / elapsed);
    xfer.speed = xfer.speed ? xfer.speed * 0.7 + instant * 0.3 : instant;
    xfer.sample = { t: now, bytes: total };
  }

  function overallBytes() {
    const active = xfer.files[xfer.current];
    return xfer.doneBytes + (active && active.state === 'active' ? active.bytes : 0);
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderTransferNow();
    });
  }

  function renderTransferNow() {
    if (!xfer) return;
    const total = xfer.totalBytes;
    const done = Math.min(total, overallBytes());
    const pct = total > 0 ? Math.floor((done / total) * 100) : phase() === 'done' ? 100 : 0;

    overallFill.style.width = `${pct}%`;
    overallBar.setAttribute('aria-valuenow', String(pct));
    metricProgress.textContent = `${pct}%`;
    metricTransferred.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
    metricSpeed.textContent = xfer.speed > 0 ? `${formatBytes(xfer.speed)}/s` : '–';
    const remaining = Math.max(0, total - done);
    metricEta.textContent =
      phase() === 'done'
        ? '0s'
        : xfer.speed > 0 && remaining > 0
          ? formatDuration(remaining / xfer.speed)
          : '–';

    xfer.files.forEach((row, index) => {
      const li = transferList.children[index];
      if (!li) return;
      li.dataset.state = row.state;
      const glyph = li.querySelector('.file-glyph');
      glyph.textContent = '';
      glyph.appendChild(
        iconEl(row.state === 'done' ? 'check' : row.state === 'failed' ? 'alert' : 'file')
      );
      li.querySelector('.file-name').textContent = row.name;
      li.querySelector('.file-name').title = row.name;
      const known = row.sizeKnown || row.state !== 'queued';
      li.querySelector('.file-meta').textContent = known ? formatBytes(row.size) : 'Waiting';
      const rowPct =
        row.state === 'done' ? 100 : row.size > 0 ? Math.floor((row.bytes / row.size) * 100) : 0;
      li.querySelector('.progress-fill').style.width = `${rowPct}%`;
      li.querySelector('.progress').setAttribute('aria-valuenow', String(rowPct));
      li.querySelector('.progress').setAttribute('aria-label', `${row.name} progress`);
      li.querySelector('.xfer-state').textContent =
        row.state === 'done'
          ? 'Done'
          : row.state === 'failed'
            ? 'Stopped'
            : row.state === 'active'
              ? `${rowPct}%`
              : 'Queued';
    });
  }

  function setBadge(text, tone) {
    transferBadge.dataset.tone = tone;
    transferStatusText.textContent = text;
  }

  /** Reminder shown for the whole transfer. Closing or backgrounding the tab drops the connection. */
  function refreshTransferNote() {
    if (!xfer) return;
    let text = 'Keep this tab open and your screen on until it finishes.';
    if (xfer.isReceiver && xfer.count > 1) {
      text +=
        ' Your browser may ask permission to download multiple files. Allow it to keep going.';
    }
    transferNote.textContent = text;
    transferNote.hidden = false;
  }

  function finishTransfer(isReceiver) {
    releaseWakeLock();
    currentPhase = 'done';
    setBadge('Complete', 'success');
    transferTitle.textContent = isReceiver ? 'Received' : 'Sent';
    transferSubtitle.textContent = isReceiver
      ? `${plural(xfer.count, 'file')} verified and downloaded`
      : `${plural(xfer.count, 'file')} delivered and verified`;
    transferNote.hidden = true;
    btnTransferResetLabel.textContent = isReceiver ? 'Receive more' : 'Send more files';
    transferActions.hidden = false;
    btnTransferReset.focus();
    showToast(isReceiver ? 'Download started' : 'Delivered and verified', 'check');
    // The room is single-use. Give the final confirmation a moment to flush, then drop everything.
    disconnectTimer = setTimeout(() => rtcManager.disconnect(), 1500);
  }

  function cancelDisconnect() {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }

  btnTransferReset.addEventListener('click', () => fullReset());

  function downloadFile(res) {
    const url = URL.createObjectURL(res.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.fileName || 'downloaded-file'; // already sanitised by the manager
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Large files are disk-backed: keep the URL and temp file around while the browser saves them
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    if (typeof res.cleanup === 'function') setTimeout(res.cleanup, 10 * 60 * 1000);
  }

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------
  function fullReset() {
    releaseWakeLock();
    hideNotice();
    cancelDisconnect();
    rtcManager.disconnect();
    files = [];
    locked = false;
    roomRequested = false;
    qrRendered = false;
    xfer = null;
    currentPhase = 'idle';

    hideAlert();
    transferPanel.hidden = true;
    transferList.textContent = '';
    transferActions.hidden = true;
    modeCard.hidden = false;

    shareCard.hidden = true;
    shareLinkInput.value = '';
    qrPanel.hidden = true;
    qrCode.textContent = '';
    btnShowQR.setAttribute('aria-expanded', 'false');
    btnShowQR.querySelector('span').textContent = 'Show QR code';
    setWait('Preparing a secure room…', true);

    receiverLinkInput.value = '';
    setHint('', null);
    resetJoinButton();
    renderFileList();
    tabs[mode].focus();
  }

  // The markup already starts on the Send tab. A share link (handled above) may have switched it.
  renderFileList();
});
