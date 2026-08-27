'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// Constants & Configuration
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 8080;
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEARTBEAT_INTERVAL_MS = 30000;

// Allowed signaling message types for direct 2-peer pass-through
const SIGNALING_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'candidate', 'ice_candidate']);

// MIME Types for Static File Serving
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * Generate a cryptographically secure, collision-free 6-character alphanumeric room code.
 * @param {Map<string, Set<WebSocket>>} existingRooms
 * @returns {string} 6-character room code
 */
function generateRoomCode(existingRooms) {
  const maxAttempts = 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const randomIndex = crypto.randomInt(0, ROOM_CODE_CHARS.length);
      code += ROOM_CODE_CHARS[randomIndex];
    }
    if (!existingRooms || !existingRooms.has(code)) {
      return code;
    }
  }
  throw new Error('Exhausted attempts while generating unique room code');
}

/**
 * Helper to safely send JSON stringified message to a WebSocket.
 * @param {WebSocket} ws
 * @param {object} message
 */
function sendJSON(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Serves static files from public/ and workspace root for workers/modules.
 */
function handleHttpRequest(req, res, rooms) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Parse requested pathname
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeRooms: rooms.size }));
    return;
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  // Prevent directory traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');

  // Try public/ first, then workspace root
  let targetFile = path.join(__dirname, 'public', safePath);
  if (!fs.existsSync(targetFile)) {
    targetFile = path.join(__dirname, safePath);
  }

  if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    const ext = path.extname(targetFile).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(targetFile).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
}

/**
 * Creates and initializes the WebRTC Signaling Server and HTTP Static Host.
 * @param {object} [options]
 * @param {http.Server} [options.server] Optional existing HTTP server
 * @param {number} [options.port] Optional port
 * @param {number} [options.heartbeatInterval] Heartbeat interval in ms
 * @returns {{ server: http.Server, wss: WebSocketServer, rooms: Map<string, Set<WebSocket>>, close: Function }}
 */
function createSignalingServer(options = {}) {
  // Ephemeral room registry: roomCode -> Set<WebSocket> (max 2 peers)
  const rooms = new Map();

  const server =
    options.server ||
    http.createServer((req, res) => {
      handleHttpRequest(req, res, rooms);
    });

  const wss = new WebSocketServer({ server });

  /**
   * Instantly cleans up room and disconnects partner peer if one side disconnects.
   * @param {WebSocket} ws
   */
  function handlePeerDisconnect(ws) {
    const roomCode = ws.roomCode;
    if (!roomCode) return;

    // Detach room reference from disconnecting socket
    ws.roomCode = null;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Immediately remove room from registry (zero retention)
    rooms.delete(roomCode);

    // Drop and clean up the remaining peer immediately
    for (const peer of room) {
      if (peer !== ws) {
        peer.roomCode = null;
        if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) {
          try {
            peer.close(1000, 'Peer disconnected');
          } catch {
            peer.terminate();
          }
        }
      }
    }

    room.clear();
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.roomCode = null;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (rawBuffer, isBinary) => {
      let parsed;
      try {
        parsed = JSON.parse(rawBuffer.toString());
      } catch {
        sendJSON(ws, { type: 'error', message: 'Invalid JSON payload' });
        return;
      }

      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        sendJSON(ws, { type: 'error', message: 'Malformed message: "type" is required' });
        return;
      }

      const { type } = parsed;

      // 1. Room Creation
      if (type === 'create' || type === 'create-room') {
        if (ws.roomCode) {
          sendJSON(ws, { type: 'error', message: 'Already in a room' });
          return;
        }

        const roomCode = generateRoomCode(rooms);
        const room = new Set([ws]);
        rooms.set(roomCode, room);
        ws.roomCode = roomCode;

        sendJSON(ws, { type: 'created', roomCode });
        return;
      }

      // 2. Room Joining
      if (type === 'join' || type === 'join-room') {
        if (ws.roomCode) {
          sendJSON(ws, { type: 'error', message: 'Already in a room' });
          return;
        }

        const requestedCode = (parsed.roomCode || parsed.room || '')
          .toString()
          .trim()
          .toUpperCase();
        if (!requestedCode || requestedCode.length !== ROOM_CODE_LENGTH) {
          sendJSON(ws, { type: 'error', message: 'Invalid 6-character room code format' });
          return;
        }

        const room = rooms.get(requestedCode);
        if (!room) {
          sendJSON(ws, { type: 'error', message: 'Room not found or expired' });
          return;
        }

        if (room.size >= 2) {
          sendJSON(ws, { type: 'error', message: 'Room is full' });
          return;
        }

        room.add(ws);
        ws.roomCode = requestedCode;

        // Confirm join to the joiner
        sendJSON(ws, { type: 'joined', roomCode: requestedCode });

        // Notify the creator that the peer has joined so WebRTC offer negotiation can begin
        for (const peer of room) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            sendJSON(peer, { type: 'peer-joined', roomCode: requestedCode });
          }
        }
        return;
      }

      // 3. Signaling Message Routing: 'offer', 'answer', 'ice-candidate'
      if (SIGNALING_TYPES.has(type)) {
        const roomCode = ws.roomCode;
        if (!roomCode || !rooms.has(roomCode)) {
          sendJSON(ws, { type: 'error', message: 'Not in an active room' });
          return;
        }

        const room = rooms.get(roomCode);
        let delivered = false;

        // Relay the unmodified raw payload directly to the other peer only
        for (const peer of room) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(rawBuffer, { binary: isBinary });
            delivered = true;
          }
        }

        if (!delivered) {
          sendJSON(ws, { type: 'error', message: 'Peer is not connected' });
        }
        return;
      }

      // 4. Explicit Leave
      if (type === 'leave' || type === 'leave-room') {
        handlePeerDisconnect(ws);
        return;
      }

      // Unknown Type
      sendJSON(ws, { type: 'error', message: `Unsupported message type: ${type}` });
    });

    ws.on('close', () => {
      handlePeerDisconnect(ws);
    });

    ws.on('error', () => {
      handlePeerDisconnect(ws);
    });
  });

  // Heartbeat interval to detect stale/dead TCP sockets
  const heartbeatInterval = options.heartbeatInterval || HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        handlePeerDisconnect(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatInterval);

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
  });

  /**
   * Graceful server close
   */
  function close(callback) {
    clearInterval(heartbeatTimer);
    for (const ws of wss.clients) {
      try {
        ws.terminate();
      } catch {}
    }
    wss.close(() => {
      server.close(callback);
    });
  }

  return { server, wss, rooms, close };
}

// Start standalone server when executed directly
if (require.main === module) {
  const { server } = createSignalingServer();
  server.listen(DEFAULT_PORT, () => {
    console.log(`[WebRTC Signaling Server & Web App] Running at http://localhost:${DEFAULT_PORT}`);
  });

  const shutdown = () => {
    console.log('\n[WebRTC Signaling Server] Shutting down...');
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  createSignalingServer,
  generateRoomCode,
  ROOM_CODE_LENGTH,
  ROOM_CODE_CHARS,
  SIGNALING_TYPES
};
