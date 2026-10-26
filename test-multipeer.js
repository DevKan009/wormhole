'use strict';

/**
 * Signaling for one sender and several receivers: slots, addressing, who can talk to whom, leaving,
 * locking and limits. Runs against a real server. Rooms for one receiver keep their original
 * behaviour, which test.js covers.
 */

const assert = require('assert');
const { WebSocket } = require('ws');
const { createSignalingServer } = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (title) => console.log(`\n${title}`);
const pass = (msg) => console.log(`  ✅ ${msg}`);

async function listen(options) {
  const app = createSignalingServer(options);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  app.url = `ws://127.0.0.1:${app.server.address().port}`;
  return app;
}

function connect(app) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(app.url);
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

const send = (ws, obj) => ws.send(JSON.stringify(obj));
const last = (ws, type) => [...ws.messages].reverse().find((m) => m.type === type);
const count = (ws, type) => ws.messages.filter((m) => m.type === type).length;

async function createRoom(app, maxPeers) {
  const host = await connect(app);
  send(host, maxPeers === undefined ? { type: 'create' } : { type: 'create', maxPeers });
  await waitFor(() => last(host, 'created') || last(host, 'error'), 'create reply');
  return host;
}

async function joinRoom(app, code) {
  const guest = await connect(app);
  send(guest, { type: 'join', roomCode: code });
  await waitFor(() => last(guest, 'joined') || last(guest, 'error'), 'join reply');
  return guest;
}

const closeAll = async (app, sockets) => {
  for (const ws of sockets) ws.close();
  await new Promise((resolve) => app.close(resolve));
};

async function main() {
  console.log('🧪 Starting multi-receiver signaling tests...');

  section('Test 1: choosing how many people');
  {
    const app = await listen({});
    const sockets = [];
    const host = await createRoom(app, 3);
    sockets.push(host);
    assert.strictEqual(last(host, 'created').maxPeers, 3);

    for (const bad of [0, 9, 'x', 2.5, -1, null]) {
      const ws = await createRoom(app, bad);
      sockets.push(ws);
      assert.strictEqual(
        last(ws, 'error').message.startsWith('maxPeers must be'),
        true,
        `rejects ${bad}`
      );
      assert(!last(ws, 'created'), `no room for ${bad}`);
    }
    const one = await createRoom(app);
    sockets.push(one);
    assert.strictEqual(last(one, 'created').maxPeers, 1, 'default is one receiver');
    await closeAll(app, sockets);

    const small = await listen({ limits: { maxPeersPerRoom: 2 } });
    const tooMany = await createRoom(small, 3);
    assert(last(tooMany, 'error'), 'the server operator can lower the cap');
    const fine = await createRoom(small, 2);
    assert(last(fine, 'created'));
    await closeAll(small, [tooMany, fine]);
    pass(
      '1 to 8 whole numbers are accepted (default 1), anything else is refused, cap is configurable'
    );
  }

  section('Test 2: slots, ids and "room is full"');
  {
    const app = await listen({});
    const host = await createRoom(app, 3);
    const code = last(host, 'created').roomCode;
    const guests = [];
    for (let i = 0; i < 3; i++) guests.push(await joinRoom(app, code));
    await waitFor(() => count(host, 'peer-joined') === 3, 'three peer-joined');

    const ids = guests.map((g) => last(g, 'joined').peerId);
    assert.strictEqual(new Set(ids).size, 3, 'every receiver gets its own id');
    assert(ids.every((id) => /^[0-9a-f]{8}$/.test(id) && id !== 'host'));
    assert.deepStrictEqual(
      host.messages.filter((m) => m.type === 'peer-joined').map((m) => m.peerId),
      ids,
      'the sender is told each id in order'
    );
    assert.deepStrictEqual(
      host.messages.filter((m) => m.type === 'peer-joined').map((m) => m.joined),
      [1, 2, 3]
    );
    assert(guests.every((g) => last(g, 'joined').maxPeers === 3));

    const fourth = await joinRoom(app, code);
    assert.strictEqual(last(fourth, 'error').message, 'Room is full');
    await closeAll(app, [host, ...guests, fourth]);
    pass('three receivers fit, each gets a unique id, the fourth is told the room is full');
  }

  section('Test 3: who can talk to whom');
  {
    const app = await listen({});
    const host = await createRoom(app, 3);
    const code = last(host, 'created').roomCode;
    const [a, b, c] = [
      await joinRoom(app, code),
      await joinRoom(app, code),
      await joinRoom(app, code)
    ];
    const [idA, idB] = [last(a, 'joined').peerId, last(b, 'joined').peerId];
    await waitFor(() => count(host, 'peer-joined') === 3, 'joined');

    // Sender -> one receiver
    send(host, { type: 'offer', sdp: 'for-a', to: idA });
    await waitFor(() => last(a, 'offer'), 'a gets the offer');
    await sleep(60);
    assert.strictEqual(last(a, 'offer').sdp, 'for-a');
    assert.strictEqual(last(a, 'offer').from, 'host', 'stamped as from the sender');
    assert(!last(b, 'offer') && !last(c, 'offer'), 'nobody else sees it');

    // Sender without a recipient, or with an unknown one
    send(host, { type: 'offer', sdp: 'x' });
    send(host, { type: 'offer', sdp: 'x', to: 'deadbeef' });
    await waitFor(() => count(host, 'error') === 2, 'two errors');
    assert(
      host.messages
        .filter((m) => m.type === 'error')
        .every((m) => m.message === 'Peer is not connected')
    );

    // Receiver -> sender only, with a stamp that cannot be forged
    send(a, { type: 'answer', sdp: 'from-a', from: 'host', to: idB });
    await waitFor(() => last(host, 'answer'), 'host gets the answer');
    await sleep(60);
    assert.strictEqual(last(host, 'answer').from, idA, 'the real id replaces a forged one');
    assert(!last(b, 'answer') && !last(c, 'answer'), 'receivers cannot message each other');

    // Candidates behave the same way
    send(b, { type: 'ice-candidate', candidate: { candidate: 'c1' } });
    await waitFor(() => last(host, 'ice-candidate'), 'candidate');
    assert.strictEqual(last(host, 'ice-candidate').from, idB);
    await closeAll(app, [host, a, b, c]);
    pass('messages are addressed by id, stamped by the server, and never pass between receivers');
  }

  section('Test 4: a receiver leaving, and slots staying used');
  {
    const app = await listen({});
    const host = await createRoom(app, 2);
    const code = last(host, 'created').roomCode;
    const a = await joinRoom(app, code);
    const b = await joinRoom(app, code);
    const idA = last(a, 'joined').peerId;
    await waitFor(() => count(host, 'peer-joined') === 2, 'joined');

    a.close();
    await waitFor(() => last(host, 'peer-left'), 'peer-left');
    assert.strictEqual(last(host, 'peer-left').peerId, idA);
    await sleep(60);
    assert(!host.closeInfo && !b.closeInfo, 'the room and the other receiver are unaffected');
    assert(app.rooms.has(code), 'room still exists');

    send(host, { type: 'offer', sdp: 'still-works', to: last(b, 'joined').peerId });
    await waitFor(() => last(b, 'offer'), 'b still reachable');

    const late = await joinRoom(app, code);
    assert.strictEqual(
      last(late, 'error').message,
      'Room is full',
      'a left slot is not handed to a stranger'
    );
    await closeAll(app, [host, b, late]);
    pass('a leaving receiver is reported, the others carry on, and its slot is not reusable');
  }

  section('Test 5: the sender leaving ends everything');
  {
    const app = await listen({});
    const host = await createRoom(app, 3);
    const code = last(host, 'created').roomCode;
    const a = await joinRoom(app, code);
    const b = await joinRoom(app, code);
    host.close();
    await waitFor(() => a.closeInfo && b.closeInfo, 'receivers closed');
    assert.strictEqual(a.closeInfo.reason, 'Peer disconnected');
    assert(!app.rooms.has(code), 'room deleted immediately (zero retention)');
    await closeAll(app, [a, b]);
    pass('when the sender leaves, every receiver is dropped and the room is deleted');
  }

  section('Test 6: locking the room');
  {
    const app = await listen({});
    const host = await createRoom(app, 4);
    const code = last(host, 'created').roomCode;
    const a = await joinRoom(app, code);
    // Only the sender may lock
    send(a, { type: 'lock' });
    await waitFor(() => last(a, 'error'), 'lock refused');
    assert.strictEqual(last(a, 'error').message, 'Only the sender can lock the room');
    const early = await joinRoom(app, code);
    assert(last(early, 'joined'), 'still open after a refused lock');

    send(host, { type: 'lock' });
    await sleep(60);
    const late = await joinRoom(app, code);
    assert.strictEqual(last(late, 'error').message, 'This transfer has already started');
    await closeAll(app, [host, a, early, late]);
    pass('only the sender can lock, and a locked room refuses newcomers even with slots free');
  }

  section('Test 7: relay cap per room');
  {
    const app = await listen({ limits: { maxRoomRelays: 3 } });
    const host = await createRoom(app, 2);
    const code = last(host, 'created').roomCode;
    const a = await joinRoom(app, code);
    const idA = last(a, 'joined').peerId;
    await waitFor(() => last(host, 'peer-joined'), 'joined');
    for (let i = 0; i < 5; i++)
      send(host, { type: 'ice-candidate', candidate: { candidate: `c${i}` }, to: idA });
    await waitFor(() => last(host, 'error'), 'cap error');
    assert.strictEqual(last(host, 'error').message, 'Too many messages in this room');
    assert.strictEqual(count(a, 'ice-candidate'), 3, 'only the first three were relayed');
    await closeAll(app, [host, a]);
    pass('a room cannot relay more than the configured number of messages');
  }

  section('Test 8: one receiver keeps the original behaviour');
  {
    const app = await listen({});
    const host = await createRoom(app);
    const code = last(host, 'created').roomCode;
    const a = await joinRoom(app, code);
    await waitFor(() => last(host, 'peer-joined'), 'joined');
    const payload = { type: 'offer', sdp: 'exact', extra: { n: 1 } };
    send(host, payload);
    await waitFor(() => last(a, 'offer'), 'offer');
    assert.deepStrictEqual(last(a, 'offer'), payload, 'relayed exactly as sent');
    a.close();
    await waitFor(() => host.closeInfo, 'host closed');
    assert(!app.rooms.has(code), 'either side leaving still deletes a one-receiver room');
    await closeAll(app, [host]);
    pass('a one-receiver room still relays raw payloads and dies when either side leaves');
  }

  console.log('\n🎉 ALL MULTI-RECEIVER SIGNALING TESTS PASSED!');
}

main().catch((err) => {
  console.error('❌ Multi-receiver test suite failed:', err);
  process.exit(1);
});
