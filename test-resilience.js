'use strict';

/**
 * Hosting resilience: Metered TURN credentials, server abuse limits, and the client's behaviour
 * when the server is asleep or the network is bumpy. No browser needed.
 */

const assert = require('assert');
const http = require('http');
const { WebSocket } = require('ws');
const {
  createSignalingServer,
  createIceConfigProvider,
  sanitizeIceServers,
  resolveLimits,
  clientIp
} = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (title) => console.log(`\n${title}`);
const pass = (msg) => console.log(`  ✅ ${msg}`);

// ---------------------------------------------------------------------------------------------
// Metered credentials
// ---------------------------------------------------------------------------------------------
async function testMetered() {
  section('Test 1: Metered TURN credentials via the server');

  const API_KEY = 'sup3r-secret-key';
  const env = { METERED_APP: 'MyApp.metered.live', METERED_API_KEY: API_KEY };
  const meteredServers = [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: 'u', credential: 'c' },
    { urls: ['turns:global.relay.metered.ca:443?transport=tcp'], username: 'u', credential: 'c' }
  ];

  let calls = [];
  let clock = 1_000_000;
  const fetchOk = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => meteredServers };
  };
  const options = { fetchImpl: fetchOk, now: () => clock, cacheMs: 1000, retryMs: 500 };

  const get = createIceConfigProvider(env, options);
  const first = await get();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(
    calls[0],
    `https://myapp.metered.live/api/v1/turn/credentials?apiKey=${API_KEY}`
  );
  assert.strictEqual(
    first.iceServers.length,
    1 + meteredServers.length,
    'STUN default plus Metered'
  );
  assert.deepStrictEqual(first.iceServers[3].urls, [
    'turns:global.relay.metered.ca:443?transport=tcp'
  ]);
  pass('fetches with the app name normalised and merges with the default STUN servers');

  await get();
  await get();
  assert.strictEqual(calls.length, 1, 'cached');
  clock += 1500;
  await get();
  assert.strictEqual(calls.length, 2, 'refreshed after the cache expires');
  pass('credentials are cached and refreshed after expiry');

  const burst = createIceConfigProvider(env, { ...options, now: () => clock });
  calls = [];
  await Promise.all([burst(), burst(), burst(), burst()]);
  assert.strictEqual(calls.length, 1, 'concurrent requests share one upstream call');
  pass('concurrent requests share a single upstream call');

  // Failure handling
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    let fail = true;
    let failCalls = 0;
    const flaky = createIceConfigProvider(env, {
      now: () => clock,
      cacheMs: 1000,
      retryMs: 500,
      fetchImpl: async () => {
        failCalls++;
        if (fail)
          throw new Error(
            `fetch failed for https://x/?apiKey=${API_KEY}`.replace(API_KEY, 'REDACTED')
          );
        return { ok: true, status: 200, json: async () => meteredServers };
      }
    });
    const stunOnly = await flaky();
    assert.strictEqual(stunOnly.iceServers.length, 1, 'degrades to STUN only');
    await flaky();
    await flaky();
    assert.strictEqual(failCalls, 1, 'backs off instead of hammering a failing upstream');
    clock += 600;
    fail = false;
    const recovered = await flaky();
    assert.strictEqual(recovered.iceServers.length, 4, 'recovers after the retry delay');
    fail = true;
    clock += 5000;
    const stale = await flaky();
    assert.strictEqual(stale.iceServers.length, 4, 'keeps serving the last good credentials');
    pass('degrades to STUN, backs off, recovers, and serves stale credentials during an outage');

    const httpError = createIceConfigProvider(env, {
      now: () => clock,
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
    });
    assert.strictEqual((await httpError()).iceServers.length, 1);
    assert(!warnings.some((w) => w.includes(API_KEY)), 'the API key is never logged');
    assert(
      warnings.some((w) => w.includes('HTTP 401')),
      'the reason is logged'
    );
    pass('a rejected key degrades safely and is logged without the key');
  } finally {
    console.warn = realWarn;
  }

  // Configuration safety
  for (const bad of [
    {},
    { METERED_APP: 'myapp' },
    { METERED_API_KEY: 'k' },
    { METERED_APP: 'evil.example.com/x?', METERED_API_KEY: 'k' },
    { METERED_APP: 'a b', METERED_API_KEY: 'k' }
  ]) {
    calls = [];
    const off = createIceConfigProvider(bad, options);
    assert.strictEqual((await off()).iceServers.length, 1);
    assert.strictEqual(calls.length, 0, `no request for ${JSON.stringify(bad)}`);
  }
  pass('missing or malformed settings never trigger a request (no host injection)');

  assert.deepStrictEqual(
    sanitizeIceServers([
      { urls: 'javascript:alert(1)' },
      { urls: ['turn:ok.example:3478', 'http://evil.example'], username: 'u', credential: 7 },
      null,
      'turn:string.example',
      { urls: 'x'.repeat(300) }
    ]),
    [{ urls: ['turn:ok.example:3478'], username: 'u' }]
  );
  assert.deepStrictEqual(sanitizeIceServers('nope'), []);
  assert.strictEqual(sanitizeIceServers(new Array(50).fill({ urls: 'stun:a.example' })).length, 10);
  pass('upstream responses are reduced to plain STUN/TURN entries (max 10)');
}

// ---------------------------------------------------------------------------------------------
// Server limits
// ---------------------------------------------------------------------------------------------
async function listen(options) {
  const app = createSignalingServer(options);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  app.url = `ws://127.0.0.1:${app.server.address().port}`;
  return app;
}

function connect(app, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(app.url, { headers });
    ws.messages = [];
    ws.closeInfo = null;
    ws.on('message', (d) => ws.messages.push(JSON.parse(d.toString())));
    ws.on('close', (code, reason) => (ws.closeInfo = { code, reason: reason.toString() }));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitFor(fn, label, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function testServerLimits() {
  section('Test 2: Server abuse limits');

  assert.strictEqual(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }, 0), '9.9.9.9');
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1' }, socket: {} }, 0), null);
  const proxied = { headers: { 'x-forwarded-for': '6.6.6.6, 1.1.1.1, 2.2.2.2' }, socket: {} };
  assert.strictEqual(clientIp(proxied, 1), '2.2.2.2', 'one trusted proxy: last entry');
  assert.strictEqual(clientIp(proxied, 2), '1.1.1.1', 'two trusted proxies: second from the right');
  assert.strictEqual(clientIp(proxied, 9), null, 'more hops than entries: unknown');
  assert.strictEqual(resolveLimits({ MAX_ROOMS: '12', ROOM_MAX_AGE_MIN: '5' }).maxRooms, 12);
  assert.strictEqual(resolveLimits({ ROOM_MAX_AGE_MIN: '5' }).roomMaxAgeMs, 5 * 60 * 1000);
  assert.strictEqual(resolveLimits({ MAX_ROOMS: 'abc' }).maxRooms, 10000, 'garbage falls back');
  pass('client address resolution: direct, proxied with and without trust, bad config');

  // Keepalive
  let app = await listen({});
  let ws = await connect(app);
  ws.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => ws.messages.some((m) => m.type === 'pong'), 'pong');
  assert(!ws.messages.some((m) => m.type === 'error'), 'ping is not an error');
  ws.close();
  await new Promise((resolve) => app.close(resolve));
  pass('ping is answered with pong');

  // Message flood
  app = await listen({ limits: { maxMessagesPerWindow: 5 } });
  ws = await connect(app);
  for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => ws.closeInfo, 'flood close');
  assert.strictEqual(ws.closeInfo.code, 1008);
  await new Promise((resolve) => app.close(resolve));
  pass('a connection that floods the server is closed (1008)');

  // Room code guessing
  app = await listen({ limits: { maxFailedJoins: 3 } });
  ws = await connect(app);
  for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ type: 'join', roomCode: 'ZZZZZ' + i }));
  await waitFor(() => ws.closeInfo, 'guess close');
  assert.strictEqual(ws.closeInfo.code, 1008);
  assert.strictEqual(
    ws.messages.filter((m) => m.message === 'Room not found or expired').length,
    2
  );
  await new Promise((resolve) => app.close(resolve));
  pass('repeated wrong room codes close the connection');

  // Per-address connection cap, and slots are returned
  app = await listen({ limits: { maxConnectionsPerIp: 2 } });
  const a = await connect(app);
  const b = await connect(app);
  const c = await connect(app);
  await waitFor(() => c.closeInfo, 'third connection refused');
  assert.strictEqual(c.closeInfo.code, 1008);
  assert(a.readyState === WebSocket.OPEN && b.readyState === WebSocket.OPEN);
  a.close();
  await waitFor(() => a.closeInfo, 'first closed');
  await sleep(30);
  const d = await connect(app);
  await sleep(100);
  assert.strictEqual(d.readyState, WebSocket.OPEN, 'freed slot is reusable');
  for (const s of [b, d]) s.close();
  await new Promise((resolve) => app.close(resolve));
  pass('per-address connection cap holds and refused sockets do not leak slots');

  // Behind a proxy: off unless trusted
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    app = await listen({ limits: { maxConnectionsPerIp: 1, trustProxyHops: 0 } });
    const many = [];
    for (let i = 0; i < 4; i++) many.push(await connect(app, { 'x-forwarded-for': '203.0.113.7' }));
    await sleep(100);
    assert(
      many.every((s) => s.readyState === WebSocket.OPEN),
      'no lockout when the address is unknown'
    );
    assert.strictEqual(
      warns.filter((w) => w.includes('TRUST_PROXY_HOPS')).length,
      1,
      'warned once'
    );
    assert(!warns.join(' ').includes('203.0.113.7'), 'addresses are never logged');
    many.forEach((s) => s.close());
    await new Promise((resolve) => app.close(resolve));

    app = await listen({ limits: { maxConnectionsPerIp: 1, trustProxyHops: 1 } });
    const x1 = await connect(app, { 'x-forwarded-for': '198.51.100.1' });
    const x2 = await connect(app, { 'x-forwarded-for': '198.51.100.2' });
    const x3 = await connect(app, { 'x-forwarded-for': 'spoofed, 198.51.100.1' });
    await waitFor(() => x3.closeInfo, 'same trusted address refused');
    assert(x1.readyState === WebSocket.OPEN && x2.readyState === WebSocket.OPEN);
    assert.strictEqual(x3.closeInfo.code, 1008, 'forged leftmost entries do not help');
    [x1, x2].forEach((s) => s.close());
    await new Promise((resolve) => app.close(resolve));
  } finally {
    console.warn = realWarn;
  }
  pass('behind a proxy limits stay off until trusted; once trusted, forged entries are ignored');

  // Room creation rate
  app = await listen({ limits: { maxRoomsPerIpPerMinute: 2 } });
  const makers = [];
  for (let i = 0; i < 3; i++) {
    const s = await connect(app);
    s.send(JSON.stringify({ type: 'create' }));
    makers.push(s);
  }
  await waitFor(() => makers.every((s) => s.messages.length > 0), 'create replies');
  assert.deepStrictEqual(
    makers.map((s) => s.messages[0].type),
    ['created', 'created', 'error']
  );
  assert(/Too many rooms/.test(makers[2].messages[0].message));
  makers.forEach((s) => s.close());
  await new Promise((resolve) => app.close(resolve));
  pass('room creation per address per minute is capped');

  // Global connection cap
  app = await listen({ limits: { maxConnections: 2 } });
  const g1 = await connect(app);
  const g2 = await connect(app);
  const g3 = await connect(app);
  await waitFor(() => g3.closeInfo, 'global cap');
  assert.strictEqual(g3.closeInfo.code, 1013);
  [g1, g2].forEach((s) => s.close());
  await new Promise((resolve) => app.close(resolve));
  pass('the global connection cap refuses extra sockets (1013)');

  // Room max age
  app = await listen({ heartbeatInterval: 25, limits: { roomMaxAgeMs: 80 } });
  const owner = await connect(app);
  owner.send(JSON.stringify({ type: 'create' }));
  await waitFor(() => owner.messages.some((m) => m.type === 'created'), 'room created');
  assert.strictEqual(app.rooms.size, 1);
  await waitFor(() => owner.closeInfo, 'room expiry');
  assert.strictEqual(app.rooms.size, 0, 'expired room is deleted');
  assert(
    owner.messages.some((m) => /expired/.test(m.message || '')),
    'owner is told why'
  );
  await new Promise((resolve) => app.close(resolve));
  pass('abandoned rooms are deleted after their maximum age');

  // TURN logins only go to people in a room
  const withTurn = async () => ({
    iceServers: [
      { urls: ['stun:s.example:3478'] },
      { urls: ['turn:t.example:3478'], username: 'user', credential: 'secret' }
    ]
  });
  app = await listen({ iceConfigProvider: withTurn, limits: { maxIceMissesPerMinute: 3 } });
  const getIce = (query) =>
    new Promise((resolve, reject) => {
      const port = app.server.address().port;
      http
        .get(`http://127.0.0.1:${port}/ice-config${query}`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        })
        .on('error', reject);
    });
  ws = await connect(app);
  ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(() => ws.messages.some((m) => m.type === 'created'), 'room created');
  const liveCode = ws.messages.find((m) => m.type === 'created').roomCode;

  const noRoom = await getIce('');
  assert.strictEqual(noRoom.status, 200);
  assert.strictEqual(JSON.parse(noRoom.body).iceServers.length, 1, 'no room: STUN only');
  assert(!/secret|user/.test(noRoom.body), 'no TURN login without a room');
  const live = await getIce(`?room=${liveCode.toLowerCase()}`);
  assert.strictEqual(JSON.parse(live.body).iceServers.length, 2, 'live room (any case): TURN');
  assert(/secret/.test(live.body));

  // Probing for rooms is capped (1 miss so far, the limit is 3), real rooms keep working
  assert.strictEqual((await getIce('?room=ZZZZZZ')).status, 200);
  assert.strictEqual((await getIce('?room=YYYYYY')).status, 200);
  assert.strictEqual((await getIce('?room=XXXXXX')).status, 429, 'misses over the cap are refused');
  assert.strictEqual((await getIce(`?room=${liveCode}`)).status, 200, 'a real room still works');
  ws.close();
  await new Promise((resolve) => app.close(resolve));
  pass('TURN logins are only served for a live room; probing for rooms is capped');
}

// ---------------------------------------------------------------------------------------------
// Client behaviour with a mock WebSocket
// ---------------------------------------------------------------------------------------------
class MockWebSocket {
  static OPEN = 1;
  static plan = []; // per attempt: 'open' or 'fail'
  static instances = [];

  constructor() {
    this.readyState = 0;
    this.sent = [];
    MockWebSocket.instances.push(this);
    const outcome = MockWebSocket.plan.shift() || 'open';
    setTimeout(() => {
      if (outcome === 'fail') {
        this.readyState = 3;
        if (this.onerror) this.onerror(new Error('connect failed'));
        if (this.onclose) this.onclose();
      } else {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }
    }, 0);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
}

async function testClient() {
  section('Test 3: Client retry, keepalive and reconnect grace');
  global.WebSocket = MockWebSocket;
  const { WebRTCManager } = require('./public/webrtcManager');

  const make = (extra = {}) => {
    const events = { slow: 0, errors: [], status: [], disconnected: 0 };
    const manager = new WebRTCManager({
      wsUrl: 'ws://mock',
      signalingRetry: { slowAfterMs: 20, deadlineMs: 400, delaysMs: [5, 5, 10] },
      keepAliveMs: 15,
      reconnectGraceMs: 40,
      onSignalingSlow: () => events.slow++,
      onError: (m) => events.errors.push(m),
      onConnectionStatus: (s) => events.status.push(s),
      onP2PDisconnected: () => events.disconnected++,
      ...extra
    });
    return { manager, events };
  };

  // Server asleep for two attempts, then up
  MockWebSocket.instances = [];
  MockWebSocket.plan = ['fail', 'fail', 'open'];
  let { manager, events } = make();
  await manager.connectSignaling();
  assert.strictEqual(MockWebSocket.instances.length, 3, 'three attempts');
  assert(events.slow >= 1, 'user is told the server is waking up');
  assert.deepStrictEqual(events.errors, [], 'no error when it eventually connects');
  assert.strictEqual(manager.ws.readyState, 1);
  pass('retries while the server wakes up, tells the user, and ends without an error');

  // Keepalive while waiting
  await sleep(80);
  const pings = manager.ws.sent.filter((s) => s === '{"type":"ping"}').length;
  assert(pings >= 3, `pings sent while waiting (${pings})`);
  manager.peerConnected = true;
  const before = manager.ws.sent.length;
  await sleep(50);
  assert.strictEqual(manager.ws.sent.length, before, 'no pings once the peers are connected');
  manager.peerConnected = false;
  manager._closeSignaling();
  assert.strictEqual(manager._keepAliveTimer, null, 'timer cleared on close');
  pass('keepalive pings flow while waiting, stop when connected, and stop on close');

  // Never comes up
  MockWebSocket.instances = [];
  MockWebSocket.plan = new Array(50).fill('fail');
  ({ manager, events } = make());
  await assert.rejects(manager.connectSignaling());
  assert(events.errors.includes('Could not reach the signaling server'));
  assert(MockWebSocket.instances.length < 50, 'gives up at the deadline');
  pass('gives up at the deadline with a clear error');

  // Reset while retrying
  MockWebSocket.instances = [];
  MockWebSocket.plan = new Array(50).fill('fail');
  ({ manager, events } = make());
  const pending = manager.connectSignaling().catch(() => 'stopped');
  await sleep(30);
  manager._resetSession();
  assert.strictEqual(await pending, 'stopped');
  const attemptsAtReset = MockWebSocket.instances.length;
  await sleep(60);
  assert.strictEqual(MockWebSocket.instances.length, attemptsAtReset, 'no further attempts');
  assert.deepStrictEqual(events.errors, [], 'a cancelled attempt is not an error');
  pass('cancelling during a retry stops quietly');

  // Reconnect grace
  ({ manager, events } = make());
  manager._beginReconnectGrace();
  assert.deepStrictEqual(events.status, ['reconnecting']);
  await sleep(15);
  manager._endReconnectGrace(true);
  await sleep(60);
  assert.deepStrictEqual(events.status, ['reconnecting', 'connected']);
  assert.deepStrictEqual(events.errors, [], 'a recovered blip is not an error');
  assert.strictEqual(manager._failed, false);
  pass('a brief ICE disconnect that recovers is not an error');

  ({ manager, events } = make());
  manager._beginReconnectGrace();
  manager._beginReconnectGrace(); // repeated events must not stack timers
  await sleep(90);
  assert.strictEqual(manager._failed, true);
  assert.deepStrictEqual(events.errors, ['Connection lost: Peer connection did not recover']);
  assert.strictEqual(events.disconnected, 1, 'reported once');
  pass('a disconnect that never recovers fails once after the grace period');

  ({ manager, events } = make());
  manager._finished = true;
  manager._beginReconnectGrace();
  await sleep(60);
  assert.deepStrictEqual(events.errors, [], 'disconnects after completion are ignored');
  pass('disconnects after a finished transfer are ignored');

  // The same behaviour through the real ICE event wiring
  class MockPeerConnection extends EventTarget {
    constructor() {
      super();
      this.iceConnectionState = 'new';
      this.closed = false;
    }
    createDataChannel() {
      return { readyState: 'connecting' };
    }
    close() {
      this.closed = true;
    }
    setIce(state) {
      this.iceConnectionState = state;
      this.dispatchEvent(new Event('iceconnectionstatechange'));
    }
  }
  global.RTCPeerConnection = MockPeerConnection;
  const withPc = () => {
    const made = make();
    made.manager.isInitiator = true;
    made.manager._initPeerConnection();
    made.manager.peerConnected = true;
    return made;
  };

  ({ manager, events } = withPc());
  let pc = manager.pc;
  pc.setIce('connected');
  pc.setIce('disconnected');
  assert.deepStrictEqual(events.status, ['reconnecting']);
  await sleep(15);
  pc.setIce('connected');
  await sleep(60);
  assert.deepStrictEqual(events.status, ['reconnecting', 'connected']);
  assert.deepStrictEqual(events.errors, []);
  assert.strictEqual(pc.closed, false, 'the connection is kept');
  pc.setIce('disconnected');
  pc.setIce('completed');
  assert.deepStrictEqual(
    events.status.slice(-2),
    ['reconnecting', 'connected'],
    'completed also counts as recovered'
  );
  pass('ICE disconnected then connected: transfer keeps going (real event path)');

  ({ manager, events } = withPc());
  pc = manager.pc;
  pc.setIce('disconnected');
  await sleep(90);
  assert.deepStrictEqual(events.errors, ['Connection lost: Peer connection did not recover']);
  assert.strictEqual(pc.closed, true, 'connection is torn down after the grace period');
  pass('ICE disconnected and never recovering ends the transfer after the grace period');

  ({ manager, events } = withPc());
  pc = manager.pc;
  pc.setIce('disconnected');
  pc.setIce('failed');
  assert.deepStrictEqual(
    events.errors,
    ['Connection lost: Peer connection failed'],
    'failed is immediate'
  );
  await sleep(80);
  assert.strictEqual(
    events.errors.length,
    1,
    'and the pending grace timer does not report it again'
  );
  assert.strictEqual(events.disconnected, 1);
  pass('ICE failed ends the transfer immediately, once');

  // The sender's own handler must not preempt the manager's grace period
  const { WebRTCFileSender } = require('./webrtcSender');
  const makeSender = (tolerate) => {
    const senderPc = new MockPeerConnection();
    const errors = [];
    const dc = { readyState: 'open', bufferedAmount: 0, addEventListener() {} };
    const worker = {
      messages: [],
      postMessage(m) {
        this.messages.push(m);
      }
    };
    new WebRTCFileSender(dc, {
      worker,
      peerConnection: senderPc,
      tolerateDisconnect: tolerate,
      onError: (e) => errors.push(e.message)
    });
    return { senderPc, errors, worker };
  };
  let s = makeSender(true);
  s.senderPc.setIce('disconnected');
  assert.deepStrictEqual(s.errors, [], 'tolerant sender ignores disconnected');
  s.senderPc.setIce('failed');
  assert.strictEqual(s.errors.length, 1, 'but still aborts on failed');
  assert(s.worker.messages.some((m) => m.type === 'ABORT'));
  s = makeSender(false);
  s.senderPc.setIce('disconnected');
  assert.strictEqual(s.errors.length, 1, 'default sender keeps the strict behaviour');
  pass('the sender ignores "disconnected" only when its owner manages the grace period');
}

(async () => {
  console.log('🧪 Starting hosting resilience tests...');
  await testMetered();
  await testServerLimits();
  await testClient();
  console.log('\n🎉 ALL RESILIENCE TESTS PASSED!');
})().catch((err) => {
  console.error('❌ Resilience test failed:', err);
  process.exit(1);
});
