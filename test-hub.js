'use strict';

/**
 * SenderHub (one sender, several receivers) against mock WebSocket, RTCPeerConnection, data
 * channel and Worker objects: connection setup per receiver, encrypt-once fan-out, pace set by the
 * slowest receiver, confirmations, and a receiver failing without stopping the others.
 */

const assert = require('assert');

global.Inspector = require('./public/inspector');
Object.assign(global, require('./chunkCrypto'));
global.WebRTCFileSender = require('./webrtcSender').WebRTCFileSender;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (title) => console.log(`\n${title}`);
const pass = (msg) => console.log(`  ✅ ${msg}`);

// ---------------------------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------------------------
class MockWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor() {
    this.readyState = 0;
    this.sent = [];
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  serverSend(obj) {
    this.onmessage({ data: JSON.stringify(obj) });
  }
}

class MockDC {
  constructor(label) {
    this.label = label;
    this.id = 0;
    this.ordered = true;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
    this.listeners = {};
    this.failSend = false;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn();
  }
  send(data) {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(data);
  }
  open() {
    this.readyState = 'open';
    if (this.onopen) this.onopen();
  }
  remoteClose() {
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
  }
  close() {
    this.readyState = 'closed';
  }
  receive(obj) {
    this.onmessage({ data: JSON.stringify(obj) });
  }
}

class MockPC {
  static instances = [];
  constructor() {
    this.iceConnectionState = 'new';
    this.remoteDescription = null;
    this.listeners = {};
    this.channels = [];
    this.candidates = [];
    this.closed = false;
    MockPC.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  createDataChannel(label) {
    const dc = new MockDC(label);
    this.channels.push(dc);
    return dc;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\nfake-offer' };
  }
  async setLocalDescription(d) {
    this.localDescription = d;
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c) {
    this.candidates.push(c);
  }
  close() {
    this.closed = true;
  }
  setIce(state) {
    this.iceConnectionState = state;
    this.fire('iceconnectionstatechange');
  }
}

class MockWorker {
  static instances = [];
  constructor() {
    this.posted = [];
    this.terminated = false;
    MockWorker.instances.push(this);
  }
  postMessage(m) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data) {
    this.onmessage({ data });
  }
}

global.WebSocket = MockWebSocket;
global.RTCPeerConnection = MockPC;
global.Worker = MockWorker;

const { SenderHub, FanOutChannel } = require('./public/senderHub');

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const FILE = (name, size) => ({ name, size, type: 'application/octet-stream' });

async function makeHub(maxPeers, extra = {}) {
  MockWebSocket.instances = [];
  MockPC.instances = [];
  MockWorker.instances = [];
  const events = {
    created: null,
    joined: [],
    peerStates: [],
    ready: 0,
    files: [],
    errors: [],
    progress: [],
    started: [],
    disconnected: 0,
    roomClosed: 0
  };
  const hub = new SenderHub({
    wsUrl: 'ws://mock',
    rtcConfig: { iceServers: [] },
    keepAliveMs: 0,
    statsIntervalMs: 0,
    reconnectGraceMs: 60,
    slowPeerMs: 120,
    onRoomCreated: (code, max) => (events.created = { code, max }),
    onPeerJoined: (p) => events.joined.push(p),
    onPeerState: (s) => events.peerStates.push(s),
    onPeerProgress: (p) => events.progress.push(p),
    onReady: () => events.ready++,
    onRoomClosed: () => events.roomClosed++,
    onFileTransferStart: (i) => events.started.push(i),
    onFileComplete: (r) => events.files.push(r),
    onError: (m) => events.errors.push(m),
    onP2PDisconnected: () => events.disconnected++,
    ...extra
  });
  await hub.createRoom(maxPeers);
  const ws = MockWebSocket.instances[0];
  ws.serverSend({ type: 'created', roomCode: 'ROOM42', maxPeers });
  await hub._signalingQueue;
  return { hub, events, ws };
}

/** Guest joins: the hub makes a connection for it and offers. Returns its mock pc and channel. */
async function guestJoins(ctx, peerId, joined) {
  ctx.ws.serverSend({
    type: 'peer-joined',
    roomCode: 'ROOM42',
    peerId,
    joined,
    maxPeers: ctx.hub.maxPeers
  });
  await ctx.hub._signalingQueue;
  const pc = MockPC.instances[MockPC.instances.length - 1];
  ctx.ws.serverSend({ type: 'answer', from: peerId, sdp: `answer-${peerId}` });
  await ctx.hub._signalingQueue;
  return { pc, dc: pc.channels[0] };
}

async function connected(maxPeers, extra) {
  const ctx = await makeHub(maxPeers, extra);
  const guests = [];
  for (let i = 1; i <= maxPeers; i++) {
    const g = await guestJoins(ctx, `peer${i}`, i);
    g.dc.open();
    guests.push(g);
  }
  return { ...ctx, guests };
}

const stateOf = (events, peerId) => {
  const all = events.peerStates.filter((s) => s.peerId === peerId);
  return all[all.length - 1];
};

/** Starts sending and feeds the first file's chunks through the mock worker. */
async function startSending(ctx, files = [FILE('a.bin', 70000)]) {
  await ctx.hub.sendFiles(files);
  return MockWorker.instances[0];
}

const chunk = (n = 65552) => new ArrayBuffer(n);
const feed = (worker, buf, chunkIndex, totalChunks, isLast = false) =>
  worker.emit({ type: 'ENCRYPTED_CHUNK', encryptedChunk: buf, chunkIndex, isLast, totalChunks });

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------
async function main() {
  const quietWarn = console.warn;
  const quietError = console.error;
  console.warn = () => {};

  console.log('🧪 Starting multi-receiver sender tests...');

  section('Test 1: room and a connection per receiver');
  {
    const ctx = await makeHub(3);
    assert.deepStrictEqual(ctx.ws.sent[0], { type: 'create', maxPeers: 3 }, 'asks for 3 slots');
    assert.deepStrictEqual(ctx.events.created, { code: 'ROOM42', max: 3 });

    const a = await guestJoins(ctx, 'peer1', 1);
    const b = await guestJoins(ctx, 'peer2', 2);
    assert.strictEqual(MockPC.instances.length, 2, 'one RTCPeerConnection per receiver');
    assert(a.pc !== b.pc);
    const offers = ctx.ws.sent.filter((m) => m.type === 'offer');
    assert.deepStrictEqual(
      offers.map((o) => o.to),
      ['peer1', 'peer2'],
      'each offer is addressed'
    );
    assert.strictEqual(
      a.pc.remoteDescription.sdp,
      'answer-peer1',
      'answers go to the right connection'
    );
    assert.strictEqual(b.pc.remoteDescription.sdp, 'answer-peer2');
    assert.deepStrictEqual(
      ctx.events.joined.map((j) => j.label),
      ['Person 1', 'Person 2']
    );

    // Candidates are addressed, and routed by sender
    a.pc.fire('icecandidate', {
      candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host' }
    });
    const cand = ctx.ws.sent.filter((m) => m.type === 'ice-candidate');
    assert.strictEqual(cand[0].to, 'peer1');
    ctx.ws.serverSend({ type: 'ice-candidate', from: 'peer2', candidate: { candidate: 'x' } });
    await ctx.hub._signalingQueue;
    assert.deepStrictEqual(b.pc.candidates, [{ candidate: 'x' }]);
    assert.deepStrictEqual(a.pc.candidates, [], 'other receivers do not get it');
    ctx.hub.disconnect();
    pass(
      'create asks for the slots, each guest gets its own connection, offer, answer and candidates'
    );
  }

  section('Test 2: ready only when every slot is settled');
  {
    const ctx = await makeHub(2);
    const a = await guestJoins(ctx, 'peer1', 1);
    a.dc.open();
    assert.strictEqual(ctx.events.ready, 0, 'one of two is not enough');
    const b = await guestJoins(ctx, 'peer2', 2);
    b.dc.open();
    assert.strictEqual(ctx.events.ready, 1, 'both connected');
    assert.strictEqual(stateOf(ctx.events, 'peer1').state, 'connected');

    // A slot that fails also settles the room
    const ctx2 = await makeHub(2);
    const c = await guestJoins(ctx2, 'peer1', 1);
    c.dc.open();
    const d = await guestJoins(ctx2, 'peer2', 2);
    d.pc.setIce('failed');
    assert.strictEqual(stateOf(ctx2.events, 'peer2').state, 'failed');
    assert.strictEqual(ctx2.events.ready, 1, 'ready with the one who made it');
    ctx.hub.disconnect();
    ctx2.hub.disconnect();
    pass('readiness waits for every slot, and counts a failed slot as settled');
  }

  section('Test 3: encrypt once, send to everyone');
  {
    const ctx = await connected(3);
    const worker = await startSending(ctx);
    const [a, b, c] = ctx.guests.map((g) => g.dc);

    assert(
      ctx.ws.sent.some((m) => m.type === 'lock'),
      'room is locked to newcomers'
    );
    assert(ctx.ws.readyState === 3, 'signaling is closed once everyone has a direct channel');
    const headers = [a, b, c].map((dc) => dc.sent[0]);
    assert(
      headers.every((h) => h === headers[0]),
      'identical header for everyone'
    );
    assert.strictEqual(JSON.parse(headers[0]).type, 'FILE_HEADER');
    assert.strictEqual(worker.posted[0].type, 'START');
    assert.strictEqual(MockWorker.instances.length, 1, 'one worker serves everyone');

    worker.emit({ type: 'STARTED', fileSize: 70000, totalChunks: 2 });
    const buf = chunk();
    feed(worker, buf, 0, 2);
    assert(
      a.sent[1] === buf && b.sent[1] === buf && c.sent[1] === buf,
      'the same encrypted chunk reaches all three'
    );
    assert.strictEqual(ctx.events.started.length, 1);
    ctx.hub.disconnect();
    pass(
      'one header and one set of encrypted chunks go to every receiver, signaling closes after the lock'
    );
  }

  section('Test 4: the slowest receiver sets the pace');
  {
    const ctx = await connected(3);
    const worker = await startSending(ctx);
    const [a, b] = ctx.guests.map((g) => g.dc);
    worker.emit({ type: 'STARTED', fileSize: 500000, totalChunks: 8 });

    b.bufferedAmount = 2 * 1024 * 1024; // one slow receiver
    feed(worker, chunk(), 0, 8);
    assert(
      worker.posted.some((m) => m.type === 'PAUSE'),
      'paused because of the slow one'
    );

    a.fire('bufferedamountlow');
    assert(
      !worker.posted.some((m) => m.type === 'RESUME'),
      'a fast receiver draining does not resume it'
    );
    b.bufferedAmount = 100000;
    b.fire('bufferedamountlow');
    assert(
      worker.posted.some((m) => m.type === 'RESUME'),
      'resumes once the slowest has drained'
    );

    // The slow one disappearing also lets it go on
    const resumesBefore = worker.posted.filter((m) => m.type === 'RESUME').length;
    b.bufferedAmount = 2 * 1024 * 1024;
    feed(worker, chunk(), 1, 8);
    assert(worker.posted.filter((m) => m.type === 'PAUSE').length === 2, 'paused again');
    b.remoteClose();
    assert(
      worker.posted.filter((m) => m.type === 'RESUME').length === resumesBefore + 1,
      'dropping the slow receiver resumes reading'
    );
    ctx.hub.disconnect();
    pass(
      'pauses when any queue is over 1 MB, resumes only when all are low, and when the slow one leaves'
    );
  }

  section('Test 5: a file is done when everyone has confirmed it');
  {
    const ctx = await connected(3);
    const worker = await startSending(ctx, [FILE('one.bin', 1000), FILE('two.bin', 2000)]);
    const dcs = ctx.guests.map((g) => g.dc);

    worker.emit({ type: 'STARTED', fileSize: 1000, totalChunks: 1 });
    feed(worker, chunk(1016), 0, 1, true);
    worker.emit({ type: 'COMPLETE', totalChunks: 1, fileSize: 1000 });
    await sleep(20); // the next file starts without waiting for confirmations
    assert.strictEqual(ctx.events.started.length, 2, 'file 2 started before file 1 was confirmed');
    assert.strictEqual(ctx.events.files.length, 0);

    dcs[0].receive({ type: 'FILE_ACK', ok: true, fileIndex: 0 });
    dcs[1].receive({ type: 'FILE_ACK', ok: true, fileIndex: 0 });
    assert.strictEqual(ctx.events.files.length, 0, 'two of three is not enough');
    dcs[2].receive({ type: 'FILE_ACK', ok: true, fileIndex: 0 });
    assert.strictEqual(ctx.events.files.length, 1);
    assert.strictEqual(ctx.events.files[0].fileIndex, 0);
    assert.strictEqual(ctx.events.files[0].isLast, false);

    worker.emit({ type: 'STARTED', fileSize: 2000, totalChunks: 1 });
    feed(worker, chunk(2016), 0, 1, true);
    worker.emit({ type: 'COMPLETE', totalChunks: 1, fileSize: 2000 });
    for (const dc of dcs) dc.receive({ type: 'FILE_ACK', ok: true, fileIndex: 1 });
    assert.strictEqual(ctx.events.files.length, 2);
    assert.strictEqual(ctx.events.files[1].isLast, true);
    assert.strictEqual(ctx.hub._finished, true);
    assert.strictEqual(stateOf(ctx.events, 'peer3').state, 'done');
    assert.deepStrictEqual(ctx.events.errors, []);
    ctx.hub.disconnect();
    pass(
      'files complete in order only after every receiver confirms, and the next one does not wait'
    );
  }

  section('Test 6: a receiver failing does not stop the others');
  {
    const ctx = await connected(3);
    const worker = await startSending(ctx);
    const [a, b, c] = ctx.guests.map((g) => g.dc);
    worker.emit({ type: 'STARTED', fileSize: 1000, totalChunks: 1 });
    feed(worker, chunk(1016), 0, 1, true);
    worker.emit({ type: 'COMPLETE', totalChunks: 1, fileSize: 1000 });

    b.remoteClose();
    assert.strictEqual(stateOf(ctx.events, 'peer2').state, 'failed');
    assert.strictEqual(stateOf(ctx.events, 'peer2').reason, 'Data channel closed');
    assert.deepStrictEqual(ctx.events.errors, [], 'not a transfer error');
    a.receive({ type: 'FILE_ACK', ok: true, fileIndex: 0 });
    assert.strictEqual(ctx.events.files.length, 0, 'still waiting for the third');
    c.receive({ type: 'FILE_ACK', ok: true, fileIndex: 0 });
    assert.strictEqual(ctx.events.files.length, 1, 'finishes with the receivers that are left');
    assert.strictEqual(ctx.events.files[0].isLast, true);
    ctx.hub.disconnect();

    // A rejection and a wrong confirmation also only drop that receiver
    const ctx2 = await connected(3);
    const w2 = await startSending(ctx2);
    const [x, y, z] = ctx2.guests.map((g) => g.dc);
    w2.emit({ type: 'STARTED', fileSize: 1000, totalChunks: 1 });
    x.receive({ type: 'FILE_ACK', ok: false, fileIndex: 0 });
    y.receive({ type: 'FILE_ACK', ok: true, fileIndex: 5 });
    assert.strictEqual(stateOf(ctx2.events, 'peer1').reason, 'The receiver rejected the transfer');
    assert.strictEqual(
      stateOf(ctx2.events, 'peer2').reason,
      'Unexpected acknowledgement from the receiver'
    );
    assert.strictEqual(stateOf(ctx2.events, 'peer3').state, 'sending');
    assert.deepStrictEqual(ctx2.events.errors, []);
    assert.strictEqual(ctx2.events.disconnected, 0);
    z.close();
    ctx2.hub.disconnect();
    pass(
      'closed, rejecting and misbehaving receivers are dropped one by one, with no transfer error'
    );
  }

  section('Test 7: everyone failing ends the transfer');
  {
    const ctx = await connected(2);
    const worker = await startSending(ctx);
    worker.emit({ type: 'STARTED', fileSize: 1000, totalChunks: 1 });
    ctx.guests[0].dc.remoteClose();
    assert.deepStrictEqual(ctx.events.errors, []);
    ctx.guests[1].dc.remoteClose();
    assert.strictEqual(ctx.events.errors.length, 1);
    assert(/Every receiver disconnected/.test(ctx.events.errors[0]));
    assert.strictEqual(ctx.events.disconnected, 1);
    assert(worker.terminated, 'worker stopped');
    assert(
      ctx.guests.every((g) => g.pc.closed),
      'every connection closed'
    );
    pass(
      'with nobody left the transfer fails once, with a clear message, and everything is closed'
    );
  }

  section('Test 8: starting early and late arrivals');
  {
    const ctx = await makeHub(3);
    const a = await guestJoins(ctx, 'peer1', 1);
    a.dc.open();
    const b = await guestJoins(ctx, 'peer2', 2); // still connecting
    assert.strictEqual(ctx.events.ready, 0);
    await ctx.hub.sendFiles([FILE('a.bin', 1000)]);
    assert.strictEqual(
      stateOf(ctx.events, 'peer2').state,
      'failed',
      'someone still connecting is dropped'
    );
    assert.strictEqual(stateOf(ctx.events, 'peer2').reason, 'Did not connect in time');
    assert(b.pc.closed);
    assert.strictEqual(stateOf(ctx.events, 'peer1').state, 'sending');

    // The socket is closed by now, so this can only happen through a late in-flight message
    await ctx.hub._handleSignalingMessage({
      type: 'peer-joined',
      peerId: 'late',
      joined: 3,
      maxPeers: 3
    });
    assert.strictEqual(ctx.hub.links.has('late'), false, 'newcomers after the start are ignored');

    await assert.rejects(ctx.hub.sendFiles([FILE('b.bin', 5)]), /already sent/);
    ctx.hub.disconnect();

    const empty = await makeHub(2);
    await assert.rejects(empty.hub.sendFiles([FILE('a.bin', 5)]), /Nobody is connected yet/);
    await assert.rejects(empty.hub.sendFiles([]), /No files selected/);
    empty.hub.disconnect();
    pass(
      'Start now drops anyone still connecting, later arrivals are ignored, nothing starts with nobody'
    );
  }

  section('Test 9: stalled receivers and connection blips');
  {
    const ctx = await connected(2, { slowPeerMs: 100 });
    const worker = await startSending(ctx);
    worker.emit({ type: 'STARTED', fileSize: 1000, totalChunks: 1 });
    const [a, b] = ctx.guests;
    // b's queue holds data and never moves
    b.dc.bufferedAmount = 500000;
    a.dc.bufferedAmount = 0;
    ctx.hub._checkStalls();
    await sleep(60);
    ctx.hub._checkStalls();
    assert.strictEqual(stateOf(ctx.events, 'peer2').state, 'sending', 'not yet');
    await sleep(130);
    ctx.hub._checkStalls();
    assert.strictEqual(stateOf(ctx.events, 'peer2').state, 'failed');
    assert.strictEqual(stateOf(ctx.events, 'peer2').reason, 'Stopped receiving data');
    assert.strictEqual(stateOf(ctx.events, 'peer1').state, 'sending', 'the other one carries on');
    ctx.hub.disconnect();

    // A queue that drains is not stalled
    const ctx2 = await connected(1, { slowPeerMs: 100 });
    await startSending(ctx2);
    const only = ctx2.guests[0];
    only.dc.bufferedAmount = 500000;
    ctx2.hub._checkStalls();
    await sleep(60);
    only.dc.bufferedAmount = 300000;
    ctx2.hub._checkStalls();
    await sleep(60);
    only.dc.bufferedAmount = 100000;
    ctx2.hub._checkStalls();
    await sleep(60);
    ctx2.hub._checkStalls();
    assert.strictEqual(stateOf(ctx2.events, 'peer1').state, 'sending', 'a draining queue is fine');
    ctx2.hub.disconnect();

    // Blip that recovers, and one that does not
    const ctx3 = await connected(2, { reconnectGraceMs: 60 });
    await startSending(ctx3);
    const [p, q] = ctx3.guests;
    p.pc.setIce('disconnected');
    assert.strictEqual(stateOf(ctx3.events, 'peer1').reconnecting, true);
    await sleep(20);
    p.pc.setIce('connected');
    assert.strictEqual(stateOf(ctx3.events, 'peer1').reconnecting, false);
    await sleep(80);
    assert.strictEqual(stateOf(ctx3.events, 'peer1').state, 'sending', 'recovered, still in');
    q.pc.setIce('disconnected');
    await sleep(90);
    assert.strictEqual(stateOf(ctx3.events, 'peer2').state, 'failed');
    assert.strictEqual(stateOf(ctx3.events, 'peer2').reason, 'Connection did not recover');
    ctx3.hub.disconnect();
    pass(
      'a stuck queue is dropped after the limit, a draining one is not, and blips get their grace period'
    );
  }

  section('Test 10: a receiver that finished may leave');
  {
    const ctx = await connected(2);
    const worker = await startSending(ctx);
    const [a, b] = ctx.guests.map((g) => g.dc);
    worker.emit({ type: 'STARTED', fileSize: 1000, totalChunks: 1 });
    feed(worker, chunk(1016), 0, 1, true);
    worker.emit({ type: 'COMPLETE', totalChunks: 1, fileSize: 1000 });
    a.receive({ type: 'FILE_ACK', ok: true, fileIndex: 0 });
    a.remoteClose(); // receiver A is done and closes its side
    assert.strictEqual(stateOf(ctx.events, 'peer1').state, 'done', 'finished, not failed');
    assert.deepStrictEqual(ctx.events.errors, []);
    b.receive({ type: 'FILE_ACK', ok: true, fileIndex: 0 });
    assert.strictEqual(ctx.events.files.length, 1);
    assert.strictEqual(ctx.events.files[0].isLast, true);
    ctx.hub.disconnect();
    pass('a receiver closing after it confirmed everything is not counted as a failure');
  }

  section('Test 11: signaling dropping early, and per-peer progress');
  {
    const ctx = await makeHub(3);
    const a = await guestJoins(ctx, 'peer1', 1);
    a.dc.open();
    ctx.ws.readyState = 3;
    ctx.ws.onclose();
    assert.strictEqual(ctx.events.roomClosed, 1, 'told the room closed while someone is connected');
    assert.deepStrictEqual(ctx.events.errors, [], 'not an error when someone is already connected');
    ctx.hub.disconnect();

    const lone = await makeHub(2);
    await guestJoins(lone, 'peer1', 1); // never connects
    lone.ws.readyState = 3;
    lone.ws.onclose();
    assert(
      /Signaling connection closed/.test(lone.events.errors[0]),
      'an error when nobody connected'
    );

    const ctx2 = await connected(2);
    const worker = await startSending(ctx2);
    ctx2.guests[1].dc.bufferedAmount = 40000;
    ctx2.guests[0].dc.bufferedAmount = 0;
    worker.emit({ type: 'STARTED', fileSize: 70000, totalChunks: 2 });
    feed(worker, chunk(), 0, 2);
    const byPeer = Object.fromEntries(ctx2.events.progress.map((p) => [p.peerId, p.bytes]));
    assert(byPeer.peer1 > byPeer.peer2, 'each receiver gets its own progress figure');
    assert(byPeer.peer2 >= 0);
    ctx2.hub.disconnect();
    pass(
      'an early signaling drop is only an error when nobody connected, progress is tracked per receiver'
    );
  }

  section('Test 12: FanOutChannel on its own');
  {
    const mk = (state = 'open', buffered = 0) => {
      const dc = new MockDC('x');
      dc.readyState = state;
      dc.bufferedAmount = buffered;
      return dc;
    };
    const errors = [];
    const fan = new FanOutChannel((id, err) => errors.push([id, err.message]));
    const a = mk();
    const b = mk('open', 5000);
    const c = mk('closed', 9e9);
    fan.add('a', a);
    fan.add('b', b);
    fan.add('c', c);
    assert.strictEqual(fan.readyState, 'open');
    assert.strictEqual(
      fan.bufferedAmount,
      5000,
      'closed channels are ignored, fullest open one counts'
    );
    fan.bufferedAmountLowThreshold = 1234;
    assert([a, b, c].every((d) => d.bufferedAmountLowThreshold === 1234));
    fan.send('hello');
    assert.deepStrictEqual(
      [a.sent.length, b.sent.length, c.sent.length],
      [1, 1, 0],
      'closed channels are skipped'
    );
    b.failSend = true;
    fan.send('again');
    assert.deepStrictEqual(
      errors,
      [['b', 'send failed']],
      'a failing channel is reported, others still get it'
    );
    assert.strictEqual(a.sent.length, 2);

    let lows = 0;
    fan.onbufferedamountlow = () => lows++;
    b.bufferedAmount = 2000;
    a.fire('bufferedamountlow');
    assert.strictEqual(lows, 0, 'not while any queue is above the threshold');
    b.bufferedAmount = 100;
    b.fire('bufferedamountlow');
    assert.strictEqual(lows, 1);
    fan.remove('b');
    assert.strictEqual(lows, 2, 'removing a channel re-checks');
    a.readyState = 'closed';
    assert.strictEqual(fan.readyState, 'closed');
    pass(
      'buffer level, threshold, sending, failures and the low-water callback behave as one channel'
    );
  }

  section('Test 13: the Developers recorder sees receivers and never the key');
  {
    const ctx = await connected(2, { statsIntervalMs: 0 });
    const worker = await startSending(ctx);
    worker.emit({ type: 'STARTED', fileSize: 1000, totalChunks: 1 });
    feed(worker, chunk(1016), 0, 1, true);
    const snap = Inspector.snapshot();
    const peers = snap.state.peers;
    assert.deepStrictEqual(
      peers.map((p) => p.label),
      ['Person 1', 'Person 2']
    );
    assert(peers.every((p) => p.state === 'sending'));
    assert(snap.events.some((e) => e.cat === 'crypto' && e.type === 'chunk-encrypt'));
    assert(
      snap.events.some((e) => e.peer === 'peer1'),
      'events are tagged with the receiver'
    );
    const key = ctx.hub.keyBase64Url;
    assert(!JSON.stringify(snap).includes(key), 'the key is not in any event');
    const out = snap.events.filter((e) => e.cat === 'signaling' && e.type === 'out');
    assert(
      out.length >= 3 && out.every((e) => e.data.containsKey === false),
      'and not in any message to the server'
    );
    ctx.hub.disconnect();
    pass(
      'events carry the receiver, peers are listed, and the key is in nothing sent to the server'
    );
  }

  console.warn = quietWarn;
  console.error = quietError;
  console.log('\n🎉 ALL MULTI-RECEIVER SENDER TESTS PASSED!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Multi-receiver sender tests failed:', err);
  process.exit(1);
});
