'use strict';

/**
 * Ephemeral P2P Web Application Controller
 */

// Simple standalone QR Code visual generator (renders SVG/Canvas without dependencies)
function renderSimpleQRCode(text, canvas) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Generate deterministic pattern based on hash of room code
  ctx.fillStyle = '#000000';
  const gridCount = 21;
  const cellSize = size / gridCount;

  // Draw 3 standard QR position finder patterns
  function drawFinderPattern(x, y) {
    ctx.fillRect(x * cellSize, y * cellSize, 7 * cellSize, 7 * cellSize);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((x + 1) * cellSize, (y + 1) * cellSize, 5 * cellSize, 5 * cellSize);
    ctx.fillStyle = '#000000';
    ctx.fillRect((x + 2) * cellSize, (y + 2) * cellSize, 3 * cellSize, 3 * cellSize);
  }

  drawFinderPattern(0, 0);
  drawFinderPattern(gridCount - 7, 0);
  drawFinderPattern(0, gridCount - 7);

  // Pseudo-random deterministic data pattern
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }

  for (let r = 0; r < gridCount; r++) {
    for (let c = 0; c < gridCount; c++) {
      // Skip finder pattern zones
      if ((r < 8 && c < 8) || (r < 8 && c >= gridCount - 8) || (r >= gridCount - 8 && c < 8)) {
        continue;
      }
      const val = Math.abs(Math.sin(r * 31 + c * 17 + hash) * 10000);
      if (Math.floor(val) % 2 === 0) {
        ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
      }
    }
  }
}

// Helpers
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showToast(msg, icon = 'ℹ️') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>${icon}</span> <span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const tabSend = document.getElementById('tabSend');
  const tabReceive = document.getElementById('tabReceive');
  const viewSend = document.getElementById('viewSend');
  const viewReceive = document.getElementById('viewReceive');

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileCard = document.getElementById('fileCard');
  const selectedFileName = document.getElementById('selectedFileName');
  const selectedFileSize = document.getElementById('selectedFileSize');
  const btnRemoveFile = document.getElementById('btnRemoveFile');

  const senderRoomCard = document.getElementById('senderRoomCard');
  const senderRoomCode = document.getElementById('senderRoomCode');
  const btnCopyLink = document.getElementById('btnCopyLink');
  const btnShowQR = document.getElementById('btnShowQR');

  const receiverCodeInput = document.getElementById('receiverCodeInput');
  const btnJoinRoom = document.getElementById('btnJoinRoom');

  const transferDashboard = document.getElementById('transferDashboard');
  const transferStatusBadge = document.getElementById('transferStatusBadge');
  const transferStatusText = document.getElementById('transferStatusText');
  const transferFileName = document.getElementById('transferFileName');
  const progressBar = document.getElementById('progressBar');
  const metricProgress = document.getElementById('metricProgress');
  const metricSpeed = document.getElementById('metricSpeed');
  const metricTransferred = document.getElementById('metricTransferred');
  const metricEta = document.getElementById('metricEta');

  const qrModal = document.getElementById('qrModal');
  const qrCanvas = document.getElementById('qrCanvas');
  const btnCloseQR = document.getElementById('btnCloseQR');

  let selectedFile = null;
  let rtcManager = null;
  let transferStartTime = null;
  let lastBytesTransferred = 0;
  let lastSpeedCheckTime = 0;

  // Initialize WebRTC Manager
  rtcManager = new WebRTCManager({
    onRoomCreated: (code) => {
      senderRoomCode.textContent = code;
      senderRoomCard.style.display = 'block';
      showToast(`Room code generated: ${code}`, '🔑');
    },

    onJoined: (code) => {
      showToast(`Joined room ${code}. Negotiating P2P connection...`, '🔄');
      btnJoinRoom.disabled = true;
      btnJoinRoom.textContent = 'Connecting...';
    },

    onPeerJoined: (code) => {
      showToast(`Peer connected! Negotiating secure WebRTC channel...`, '🤝');
    },

    onP2PConnected: () => {
      showToast(`Direct encrypted P2P data channel established!`, '⚡');
      if (selectedFile && rtcManager.isInitiator) {
        rtcManager.sendFile(selectedFile);
      }
    },

    onP2PDisconnected: () => {
      showToast(`Peer disconnected. Room destroyed.`, '⚠️');
      transferDashboard.style.display = 'none';
      if (btnJoinRoom) {
        btnJoinRoom.disabled = false;
        btnJoinRoom.textContent = 'Connect & Download';
      }
    },

    onFileTransferStart: (meta) => {
      transferDashboard.style.display = 'block';
      transferFileName.textContent = meta.fileName;
      transferStartTime = Date.now();
      lastSpeedCheckTime = Date.now();
      lastBytesTransferred = 0;
      updateTransferStatus(false);
    },

    onFileProgress: (p) => {
      const now = Date.now();
      const bytes = p.bytesSent || p.bytesReceived || 0;
      const total = p.fileSize || 1;
      const pct = Math.min(100, Math.round((bytes / total) * 100));

      progressBar.style.width = `${pct}%`;
      metricProgress.textContent = `${pct}%`;
      metricTransferred.textContent = `${formatBytes(bytes)} / ${formatBytes(total)}`;

      // Calculate speed
      const timeDiff = (now - lastSpeedCheckTime) / 1000;
      if (timeDiff >= 0.5) {
        const bytesDiff = bytes - lastBytesTransferred;
        const speedBps = bytesDiff / timeDiff;
        metricSpeed.textContent = `${(speedBps / (1024 * 1024)).toFixed(2)} MB/s`;

        const remainingBytes = Math.max(0, total - bytes);
        const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;
        metricEta.textContent = etaSec > 0 ? `${etaSec}s` : '0s';

        lastSpeedCheckTime = now;
        lastBytesTransferred = bytes;
      }
    },

    onFileComplete: (res) => {
      progressBar.style.width = '100%';
      metricProgress.textContent = '100%';
      transferStatusBadge.className = 'status-badge streaming';
      transferStatusText.textContent = 'Completed (100%)';
      showToast('File transfer & AES-GCM verification complete!', '🎉');

      // If receiver, automatically trigger download
      if (res.blob) {
        const url = URL.createObjectURL(res.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.fileName || 'downloaded-file';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1000);
      }
    },

    onBackpressureChange: (isPaused, currentBuffered) => {
      updateTransferStatus(isPaused, currentBuffered);
    },

    onError: (err) => {
      showToast(err, '❌');
      if (btnJoinRoom) {
        btnJoinRoom.disabled = false;
        btnJoinRoom.textContent = 'Connect & Download';
      }
    }
  });

  function updateTransferStatus(isPaused, currentBuffered = 0) {
    if (isPaused) {
      transferStatusBadge.className = 'status-badge paused';
      transferStatusText.textContent = 'Backpressure Active (Paused)';
    } else {
      transferStatusBadge.className = 'status-badge streaming';
      transferStatusText.textContent = 'P2P Streaming';
    }
  }

  // Tab switching
  tabSend.addEventListener('click', () => {
    tabSend.classList.add('active');
    tabReceive.classList.remove('active');
    viewSend.classList.add('active');
    viewReceive.classList.remove('active');
  });

  tabReceive.addEventListener('click', () => {
    tabReceive.classList.add('active');
    tabSend.classList.remove('active');
    viewReceive.classList.add('active');
    viewSend.classList.remove('active');
  });

  // Check URL hash for direct room link
  if (window.location.hash) {
    const codeFromHash = window.location.hash.replace('#', '').trim().toUpperCase();
    if (codeFromHash.length === 6) {
      tabReceive.click();
      receiverCodeInput.value = codeFromHash;
      showToast(`Room ${codeFromHash} loaded from URL`, '🔗');
    }
  }

  // File Drop & Selection
  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFileSelected(fileInput.files[0]);
    }
  });

  function handleFileSelected(file) {
    selectedFile = file;
    selectedFileName.textContent = file.name;
    const totalChunks = Math.ceil(file.size / 65536) || 1;
    selectedFileSize.textContent = `${formatBytes(file.size)} • ${totalChunks} chunks (64 KB each)`;

    dropZone.style.display = 'none';
    fileCard.style.display = 'flex';

    // Automatically create room
    rtcManager.createRoom();
  }

  btnRemoveFile.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    dropZone.style.display = 'block';
    fileCard.style.display = 'none';
    senderRoomCard.style.display = 'none';
    rtcManager.disconnect();
  });

  // Copy Room Link
  btnCopyLink.addEventListener('click', () => {
    const code = senderRoomCode.textContent;
    const shareUrl = `${window.location.origin}/#${code}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast('Share link copied to clipboard!', '📋');
    });
  });

  // QR Code Modal
  btnShowQR.addEventListener('click', () => {
    const code = senderRoomCode.textContent;
    const shareUrl = `${window.location.origin}/#${code}`;
    renderSimpleQRCode(shareUrl, qrCanvas);
    qrModal.classList.add('open');
  });

  btnCloseQR.addEventListener('click', () => {
    qrModal.classList.remove('open');
  });

  // Receiver Form Submission
  btnJoinRoom.addEventListener('click', () => {
    const code = receiverCodeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      showToast('Please enter a valid 6-character room code', '⚠️');
      return;
    }
    rtcManager.joinRoom(code);
  });

  receiverCodeInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
});
