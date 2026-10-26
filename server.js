'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// Constants & Configuration
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 8080;
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const HEARTBEAT_INTERVAL_MS = 30000;
// SDP offers/answers are a few KB; anything near this size is not signaling traffic
const MAX_SIGNALING_PAYLOAD_BYTES = 64 * 1024;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS, 10) || 10000;

const PUBLIC_DIR = path.join(__dirname, 'public');

// Browser scripts that live next to server.js because Node tests also require() them.
// Only these exact files are served from the project root; nothing else outside public/ is reachable.
const ROOT_SCRIPTS = new Set([
  'fileWorker.js',
  'fileChunker.js',
  'chunkCrypto.js',
  'webrtcSender.js',
  'webrtcReceiver.js'
]);

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:global.stun.twilio.com:3478'
];

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
};

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
 * Builds the ICE server list handed to browsers.
 *
 * Environment:
 *   STUN_URLS      comma-separated STUN URLs (default: public STUN servers)
 *   TURN_URL       comma-separated TURN URLs, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349"
 *   TURN_SECRET    coturn `static-auth-secret`: issues short-lived credentials per request (HMAC-SHA1)
 *   TURN_TTL       lifetime in seconds of those credentials (default 3600)
 *   TURN_USERNAME / TURN_CREDENTIAL   static long-term credentials, used when TURN_SECRET is unset
 *
 * @param {object} [env]
 * @param {number} [nowMs]
 * @returns {{ iceServers: object[] }}
 */
function buildIceConfig(env = process.env, nowMs = Date.now()) {
  const list = (value) =>
    (value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const stunUrls = list(env.STUN_URLS);
  const iceServers = [{ urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS }];

  const turnUrls = list(env.TURN_URL);
  if (turnUrls.length > 0) {
    if (env.TURN_SECRET) {
      const ttl = parseInt(env.TURN_TTL, 10) || 3600;
      const username = String(Math.floor(nowMs / 1000) + ttl);
      const credential = crypto
        .createHmac('sha1', env.TURN_SECRET)
        .update(username)
        .digest('base64');
      iceServers.push({ urls: turnUrls, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
      iceServers.push({
        urls: turnUrls,
        username: env.TURN_USERNAME,
        credential: env.TURN_CREDENTIAL
      });
    }
  }

  return { iceServers };
}

/**
 * Abuse limits. Every value can be overridden with an environment variable or options.limits.
 * Per-connection and global limits always apply. Per-IP limits only apply when the address is
 * trustworthy, see clientIp().
 */
function resolveLimits(env = process.env, overrides = {}) {
  const num = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxRooms: num(env.MAX_ROOMS, MAX_ROOMS),
    maxConnections: num(env.MAX_CONNECTIONS, 1000),
    maxConnectionsPerIp: num(env.MAX_CONNECTIONS_PER_IP, 8),
    maxRoomsPerIpPerMinute: num(env.MAX_ROOMS_PER_IP_PER_MIN, 10),
    maxMessagesPerWindow: num(env.MAX_MESSAGES_PER_10S, 100),
    maxFailedJoins: num(env.MAX_FAILED_JOINS, 5),
    maxIceMissesPerMinute: num(env.MAX_ICE_MISSES_PER_MIN, 60),
    maxPeersPerRoom: num(env.MAX_PEERS_PER_ROOM, 8),
    maxRoomRelays: num(env.MAX_ROOM_RELAYS, 2000),
    roomMaxAgeMs: num(env.ROOM_MAX_AGE_MIN, 60) * 60 * 1000,
    trustProxyHops: parseInt(env.TRUST_PROXY_HOPS, 10) > 0 ? parseInt(env.TRUST_PROXY_HOPS, 10) : 0,
    ...overrides
  };
}

/**
 * The address to apply per-IP limits to, or null when it cannot be known safely.
 *
 * Behind a reverse proxy every socket comes from the proxy, so keying limits by socket address
 * would put all visitors in one bucket and lock everyone out. X-Forwarded-For entries are
 * appended by each proxy and the leftmost ones can be forged by the client. So behind a proxy the
 * per-IP limits stay off until TRUST_PROXY_HOPS says how many proxies to trust, and then the
 * entry that many places from the right is used.
 *
 * @param {http.IncomingMessage} req
 * @param {number} trustProxyHops
 * @returns {string|null}
 */
function clientIp(req, trustProxyHops) {
  const forwarded = req.headers['x-forwarded-for'];
  if (!forwarded) return req.socket.remoteAddress || null;
  if (trustProxyHops > 0) {
    const parts = String(forwarded)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts[parts.length - trustProxyHops] || null;
  }
  return null;
}

const METERED_CACHE_MS = 10 * 60 * 1000;
const METERED_RETRY_MS = 30 * 1000;
const METERED_TIMEOUT_MS = 4000;
const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):/i;

/**
 * Keeps only well-formed ICE server entries from an upstream response, so a bad or hostile
 * response can never hand browsers anything but STUN/TURN URLs and plain credentials.
 * @param {unknown} list
 * @returns {object[]}
 */
function sanitizeIceServers(list) {
  if (!Array.isArray(list)) return [];
  const servers = [];
  for (const entry of list.slice(0, 10)) {
    if (!entry || typeof entry !== 'object') continue;
    const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).filter(
      (u) => typeof u === 'string' && ICE_URL_PATTERN.test(u) && u.length < 200
    );
    if (urls.length === 0) continue;
    const server = { urls };
    if (typeof entry.username === 'string') server.username = entry.username;
    if (typeof entry.credential === 'string') server.credential = entry.credential;
    servers.push(server);
  }
  return servers;
}

/**
 * Returns an async function that produces the ICE config for /ice-config.
 *
 * On top of buildIceConfig() it can pull TURN credentials from Metered (free Open Relay plan):
 *   METERED_APP      your Metered app name, e.g. "myapp" for myapp.metered.live
 *   METERED_API_KEY  the API key from the Metered dashboard. It stays on the server.
 * Credentials are cached for ten minutes and refreshed lazily. If Metered is unreachable the
 * response degrades to STUN-only (or the last good credentials) instead of failing.
 *
 * @param {object} [env]
 * @param {{ fetchImpl?: Function, now?: () => number, cacheMs?: number, retryMs?: number }} [options]
 * @returns {() => Promise<{ iceServers: object[] }>}
 */
function createIceConfigProvider(env = process.env, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const cacheMs = options.cacheMs ?? METERED_CACHE_MS;
  const retryMs = options.retryMs ?? METERED_RETRY_MS;

  const app = (env.METERED_APP || '')
    .trim()
    .replace(/\.metered\.live$/i, '')
    .toLowerCase();
  const apiKey = (env.METERED_API_KEY || '').trim();
  const meteredEnabled = /^[a-z0-9-]+$/.test(app) && apiKey.length > 0;

  let cache = null; // { servers, at }
  let retryAfter = 0;
  let inflight = null;

  async function refresh() {
    try {
      const url = `https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(METERED_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const servers = sanitizeIceServers(await res.json());
      if (servers.length === 0) throw new Error('response had no usable ICE servers');
      cache = { servers, at: now() };
    } catch (err) {
      retryAfter = now() + retryMs;
      // Message only: the request URL contains the API key and must never be logged
      console.warn(`[ice-config] Could not refresh Metered credentials: ${err.message}`);
    }
  }

  return async function getIceConfig() {
    const config = buildIceConfig(env, now());
    if (!meteredEnabled) return config;

    const stale = !cache || now() - cache.at > cacheMs;
    if (stale && now() >= retryAfter) {
      inflight = inflight || refresh().finally(() => (inflight = null));
      await inflight;
    }
    return cache ? { iceServers: [...config.iceServers, ...cache.servers] } : config;
  };
}

/**
 * Resolves a request pathname to a servable file, or null.
 * Only public/ (with a containment check) and the ROOT_SCRIPTS allowlist are reachable.
 * @param {string} pathname URL pathname (still percent-encoded)
 * @returns {string|null} absolute file path
 */
function resolveStaticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return null;
  }
  if (decoded === '/') {
    decoded = '/index.html';
  }

  const name = decoded.slice(1);
  if (ROOT_SCRIPTS.has(name)) {
    return path.join(__dirname, name);
  }

  const target = path.resolve(PUBLIC_DIR, '.' + decoded);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return null;
  }
  try {
    return fs.statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

/**
 * Serves the web app, /health and /ice-config. Nothing here touches signaling or payload data.
 */
function handleHttpRequest(req, res, rooms, getIceConfig, guard) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Parse requested pathname
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/health') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeRooms: rooms.size }));
    return;
  }

  if (pathname === '/ice-config') {
    // TURN logins are only handed to someone who names a room that currently exists, so a plain
    // request (a scraper, curl) gets STUN only. Looking up rooms that do not exist is counted and
    // capped: otherwise this endpoint would let anyone probe for live room codes.
    const code = (parsedUrl.searchParams.get('room') || '').trim().toUpperCase();
    const known = code.length > 0 && rooms.has(code);
    if (!known && guard && !guard.allowMiss()) {
      res.writeHead(429, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      res.end('Too Many Requests');
      return;
    }
    const config = known
      ? getIceConfig().catch(() => buildIceConfig())
      : Promise.resolve(buildIceConfig({ STUN_URLS: process.env.STUN_URLS }));
    config.then((body) => {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    return;
  }

  const targetFile = resolveStaticFile(pathname);
  if (targetFile) {
    const ext = path.extname(targetFile).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentType });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(targetFile)
      .on('error', () => res.destroy())
      .pipe(res);
    return;
  }

  res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
}

/**
 * Creates and initializes the WebRTC Signaling Server and HTTP Static Host.
 * @param {object} [options]
 * @param {http.Server} [options.server] Optional existing HTTP server
 * @param {{ key: string|Buffer, cert: string|Buffer }} [options.tls] Serve HTTPS/WSS with this key pair
 * @param {number} [options.port] Optional port
 * @param {number} [options.heartbeatInterval] Heartbeat interval in ms
 * @param {number} [options.maxRooms] Cap on simultaneous rooms
 * @param {Function} [options.iceConfigProvider] Async function returning the /ice-config payload
 * @param {object} [options.limits] Overrides for resolveLimits() (tests, tuning)
 * @returns {{ server: http.Server, wss: WebSocketServer, rooms: Map<string, Set<WebSocket>>, close: Function }}
 */
function createSignalingServer(options = {}) {
  // Ephemeral room registry: roomCode -> Set<WebSocket> (max 2 peers)
  const rooms = new Map();
  const limits = resolveLimits(process.env, {
    ...(options.maxRooms ? { maxRooms: options.maxRooms } : {}),
    ...(options.limits || {})
  });
  const maxRooms = limits.maxRooms;
  const connectionsPerIp = new Map(); // ip -> open sockets
  const roomCreations = new Map(); // ip -> { windowStart, count }
  let warnedAboutProxy = false;

  const getIceConfig = options.iceConfigProvider || createIceConfigProvider();
  // Lookups of unknown rooms through /ice-config, counted over a sliding minute
  const iceMisses = [];
  const iceGuard = {
    allowMiss() {
      const now = Date.now();
      while (iceMisses.length > 0 && now - iceMisses[0] > 60000) iceMisses.shift();
      if (iceMisses.length >= limits.maxIceMissesPerMinute) return false;
      iceMisses.push(now);
      return true;
    }
  };
  const requestHandler = (req, res) => {
    handleHttpRequest(req, res, rooms, getIceConfig, iceGuard);
  };
  const server =
    options.server ||
    (options.tls
      ? https.createServer(options.tls, requestHandler)
      : http.createServer(requestHandler));

  const wss = new WebSocketServer({ server, maxPayload: MAX_SIGNALING_PAYLOAD_BYTES });

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

    // In a room for several receivers one of them leaving (they do so as soon as their direct
    // connection is up) must not end the others' setup. Only the sender leaving ends the room.
    if (room.maxPeers > 1 && ws !== room.host) {
      room.delete(ws);
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        sendJSON(room.host, { type: 'peer-left', roomCode, peerId: ws.peerId });
      }
      return;
    }

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

  function rejectSocket(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.roomCode = null;
    ws.failedJoins = 0;
    ws.messageWindowStart = Date.now();
    ws.messageCount = 0;

    // Global and per-address connection caps
    if (wss.clients.size > limits.maxConnections) {
      rejectSocket(ws, 1013, 'Server is busy, try again later');
      return;
    }
    const ip = clientIp(req, limits.trustProxyHops);
    ws.limitKey = ip;
    if (ip === null && req.headers['x-forwarded-for'] && !warnedAboutProxy) {
      warnedAboutProxy = true;
      const entries = String(req.headers['x-forwarded-for']).split(',').length;
      console.warn(
        `[limits] Requests arrive through a proxy (X-Forwarded-For has ${entries} entries) but ` +
          'TRUST_PROXY_HOPS is not set, so per-address limits are off. Set TRUST_PROXY_HOPS to the ' +
          'number of proxies in front of this server to enable them.'
      );
    }
    if (ip !== null) {
      const open = (connectionsPerIp.get(ip) || 0) + 1;
      connectionsPerIp.set(ip, open);
      // Registered before any rejection so a refused socket still gives its slot back
      ws.on('close', () => {
        const remaining = (connectionsPerIp.get(ip) || 1) - 1;
        if (remaining <= 0) connectionsPerIp.delete(ip);
        else connectionsPerIp.set(ip, remaining);
      });
      if (open > limits.maxConnectionsPerIp) {
        rejectSocket(ws, 1008, 'Too many connections from this address');
        return;
      }
    }

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (rawBuffer, isBinary) => {
      // Per-connection flood control: signaling is a handful of messages per session
      const now = Date.now();
      if (now - ws.messageWindowStart > 10000) {
        ws.messageWindowStart = now;
        ws.messageCount = 0;
      }
      if (++ws.messageCount > limits.maxMessagesPerWindow) {
        rejectSocket(ws, 1008, 'Too many messages');
        return;
      }

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

        if (rooms.size >= maxRooms) {
          sendJSON(ws, { type: 'error', message: 'Server is busy, try again later' });
          return;
        }

        if (ws.limitKey) {
          const entry = roomCreations.get(ws.limitKey);
          if (!entry || now - entry.windowStart > 60000) {
            roomCreations.set(ws.limitKey, { windowStart: now, count: 1 });
          } else if (++entry.count > limits.maxRoomsPerIpPerMinute) {
            sendJSON(ws, { type: 'error', message: 'Too many rooms created, wait a minute' });
            return;
          }
        }

        // How many people the sender wants to send to (default 1). One link, one key, that many slots.
        let maxPeers = 1;
        if (parsed.maxPeers !== undefined) {
          maxPeers = Number(parsed.maxPeers);
          if (!Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > limits.maxPeersPerRoom) {
            sendJSON(ws, {
              type: 'error',
              message: `maxPeers must be a whole number from 1 to ${limits.maxPeersPerRoom}`
            });
            return;
          }
        }

        const roomCode = generateRoomCode(rooms);
        const room = new Set([ws]);
        room.createdAt = now;
        room.maxPeers = maxPeers;
        room.host = ws;
        room.guestsEver = 0; // joins ever made: a slot is not freed when someone leaves
        room.locked = false;
        room.relays = 0;
        rooms.set(roomCode, room);
        ws.roomCode = roomCode;
        ws.peerId = 'host';

        sendJSON(ws, { type: 'created', roomCode, maxPeers });
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
        if (!ROOM_CODE_PATTERN.test(requestedCode)) {
          sendJSON(ws, { type: 'error', message: 'Invalid 6-character room code format' });
          return;
        }

        const room = rooms.get(requestedCode);
        if (!room) {
          // Guessing codes is the only way to find someone else's room, so cap the misses
          if (++ws.failedJoins >= limits.maxFailedJoins) {
            rejectSocket(ws, 1008, 'Too many failed attempts');
            return;
          }
          sendJSON(ws, { type: 'error', message: 'Room not found or expired' });
          return;
        }

        if (room.guestsEver >= room.maxPeers || room.size >= room.maxPeers + 1) {
          sendJSON(ws, { type: 'error', message: 'Room is full' });
          return;
        }
        if (room.locked) {
          sendJSON(ws, { type: 'error', message: 'This transfer has already started' });
          return;
        }

        room.add(ws);
        room.guestsEver++;
        ws.roomCode = requestedCode;
        ws.peerId = crypto.randomBytes(4).toString('hex');

        // Confirm join to the joiner
        sendJSON(ws, {
          type: 'joined',
          roomCode: requestedCode,
          peerId: ws.peerId,
          maxPeers: room.maxPeers
        });

        // Notify the creator that the peer has joined so WebRTC offer negotiation can begin
        for (const peer of room) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            sendJSON(peer, {
              type: 'peer-joined',
              roomCode: requestedCode,
              peerId: ws.peerId,
              joined: room.guestsEver,
              maxPeers: room.maxPeers
            });
          }
        }
        return;
      }

      // 2b. The sender closes the room to newcomers (everyone expected has arrived, or it starts
      // with fewer people than planned).
      if (type === 'lock') {
        const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
        if (!room || room.host !== ws) {
          sendJSON(ws, { type: 'error', message: 'Only the sender can lock the room' });
          return;
        }
        room.locked = true;
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

        if (room.maxPeers === 1) {
          // One receiver: relay the unmodified raw payload directly to the other peer only
          for (const peer of room) {
            if (peer !== ws && peer.readyState === WebSocket.OPEN) {
              peer.send(rawBuffer, { binary: isBinary });
              delivered = true;
            }
          }
        } else {
          // Several receivers: the sender talks to each receiver by id, and receivers can only
          // talk to the sender. The server stamps who a message is from, so it cannot be forged.
          if (++room.relays > limits.maxRoomRelays) {
            sendJSON(ws, { type: 'error', message: 'Too many messages in this room' });
            return;
          }
          let target = room.host;
          if (ws === room.host) {
            target = null;
            for (const peer of room) {
              if (peer !== ws && peer.peerId === parsed.to) target = peer;
            }
          }
          if (target && target !== ws && target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({ ...parsed, from: ws.peerId }));
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

      // 5. Keepalive. Clients send this while waiting so that hosts which put idle services to
      // sleep (they count incoming WebSocket messages as activity) keep the room alive.
      if (type === 'ping') {
        sendJSON(ws, { type: 'pong' });
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
    // Rooms are meant to live for minutes. Anything older is abandoned or abusive, so free it.
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - (room.createdAt || now) > limits.roomMaxAgeMs) {
        for (const peer of room) {
          sendJSON(peer, { type: 'error', message: 'Room not found or expired' });
        }
        const [first] = room;
        if (first) {
          for (const peer of [...room]) rejectSocket(peer, 1000, 'Room expired');
          handlePeerDisconnect(first);
        } else {
          rooms.delete(code);
        }
      }
    }
    for (const [ip, entry] of roomCreations) {
      if (now - entry.windowStart > 60000) roomCreations.delete(ip);
    }

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
  // Browsers only expose WebCrypto on HTTPS or localhost. For any other host, serve TLS directly
  // (HTTPS_KEY / HTTPS_CERT: paths to PEM files) or put a TLS-terminating proxy in front.
  let tls;
  if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
    tls = {
      key: fs.readFileSync(process.env.HTTPS_KEY),
      cert: fs.readFileSync(process.env.HTTPS_CERT)
    };
  }
  const { server } = createSignalingServer({ tls });
  server.listen(DEFAULT_PORT, () => {
    const scheme = tls ? 'https' : 'http';
    console.log(
      `[WebRTC Signaling Server & Web App] Running at ${scheme}://localhost:${DEFAULT_PORT}`
    );
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
  buildIceConfig,
  createIceConfigProvider,
  sanitizeIceServers,
  resolveStaticFile,
  resolveLimits,
  clientIp,
  generateRoomCode,
  ROOM_CODE_LENGTH,
  ROOM_CODE_CHARS,
  SIGNALING_TYPES
};
