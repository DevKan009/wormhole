'use strict';

const assert = require('assert');
const http = require('http');
const { WebSocket } = require('ws');
const {
  createSignalingServer,
  generateRoomCode,
  ROOM_CODE_LENGTH,
  ROOM_CODE_CHARS
} = require('./server');

const TEST_PORT = 8999;
const WS_URL = `ws://localhost:${TEST_PORT}`;
const HTTP_URL = `http://localhost:${TEST_PORT}`;

function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws) {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

function waitForClose(ws) {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function runTests() {
  console.log('🧪 Starting WebRTC Signaling Server Test Suite...\n');

  // Start test server instance
  const { server, rooms, close } = createSignalingServer({ heartbeatInterval: 10000 });
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));

  try {
    // Test 1: Room Code Generator Unit Test
    console.log('Test 1: Room code generator properties...');
    const generatedCodes = new Set();
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode(generatedCodes);
      assert.strictEqual(code.length, ROOM_CODE_LENGTH, 'Code length must be 6');
      assert.match(
        code,
        /^[A-Z0-9]{6}$/,
        'Code must contain only uppercase alphanumeric characters'
      );
      assert(!generatedCodes.has(code), 'Code must be unique');
      generatedCodes.add(code);
    }
    console.log('  ✅ 500 unique 6-character alphanumeric room codes verified.\n');

    // Test 2: HTTP Health check endpoint
    console.log('Test 2: HTTP /health and / endpoints...');
    const healthRes = await new Promise((resolve, reject) => {
      http
        .get(`${HTTP_URL}/health`, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
        })
        .on('error', reject);
    });
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(healthRes.data.status, 'ok');
    assert.strictEqual(healthRes.data.activeRooms, 0);
    console.log('  ✅ HTTP health check returned 200 OK and valid JSON.\n');

    // Test 3: Room Creation Flow
    console.log('Test 3: WebSocket room creation...');
    const peer1 = await createClient();
    peer1.send(JSON.stringify({ type: 'create' }));
    const createdMsg = await waitForMessage(peer1);
    assert.strictEqual(createdMsg.type, 'created');
    assert.match(createdMsg.roomCode, /^[A-Z0-9]{6}$/);
    const roomCode = createdMsg.roomCode;
    assert(rooms.has(roomCode), 'Room must be registered in server rooms Map');
    assert.strictEqual(rooms.get(roomCode).size, 1);
    console.log(`  ✅ Room "${roomCode}" created successfully.\n`);

    // Test 4: Rejection of Invalid Room Join
    console.log('Test 4: Joining non-existent / invalid room...');
    const nonExistentClient = await createClient();
    nonExistentClient.send(JSON.stringify({ type: 'join', roomCode: 'NONEX9' }));
    const errorMsg = await waitForMessage(nonExistentClient);
    assert.strictEqual(errorMsg.type, 'error');
    assert.strictEqual(errorMsg.message, 'Room not found or expired');
    nonExistentClient.close();
    console.log('  ✅ Non-existent room join rejected correctly.\n');

    // Test 5: Peer 2 Joining Room Flow
    console.log('Test 5: Peer 2 joins active room...');
    const peer2 = await createClient();

    // Set up message listener on peer1 for 'peer-joined' notification
    const peer1Promise = waitForMessage(peer1);

    peer2.send(JSON.stringify({ type: 'join', roomCode }));
    const peer2JoinedMsg = await waitForMessage(peer2);
    const peer1NotifiedMsg = await peer1Promise;

    assert.strictEqual(peer2JoinedMsg.type, 'joined');
    assert.strictEqual(peer2JoinedMsg.roomCode, roomCode);
    assert.strictEqual(peer1NotifiedMsg.type, 'peer-joined');
    assert.strictEqual(peer1NotifiedMsg.roomCode, roomCode);
    assert.strictEqual(rooms.get(roomCode).size, 2);
    console.log('  ✅ Peer 2 joined and Peer 1 received "peer-joined" notification.\n');

    // Test 6: Room Full (Capacity Limit 2 Peers)
    console.log('Test 6: Rejecting 3rd peer from full room...');
    const peer3 = await createClient();
    peer3.send(JSON.stringify({ type: 'join', roomCode }));
    const fullErrorMsg = await waitForMessage(peer3);
    assert.strictEqual(fullErrorMsg.type, 'error');
    assert.strictEqual(fullErrorMsg.message, 'Room is full');
    peer3.close();
    console.log('  ✅ 3rd peer rejected from full 2-peer room.\n');

    // Test 7: WebRTC Signaling Routing (offer, answer, ice-candidate)
    console.log('Test 7: Direct 2-peer WebRTC signaling routing...');

    // 7a. Offer from Peer 1 -> Peer 2
    const offerPayload = {
      type: 'offer',
      sdp: 'v=0\r\no=- 4611731400 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=sendrecv\r\n',
      timestamp: Date.now()
    };
    const peer2OfferPromise = waitForMessage(peer2);
    peer1.send(JSON.stringify(offerPayload));
    const receivedOffer = await peer2OfferPromise;
    assert.deepStrictEqual(
      receivedOffer,
      offerPayload,
      'Peer 2 must receive exact unmodified offer payload'
    );
    console.log('  ✅ Offer passed through directly without modification.');

    // 7b. Answer from Peer 2 -> Peer 1
    const answerPayload = {
      type: 'answer',
      sdp: 'v=0\r\no=- 9876543210 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=recvonly\r\n',
      secretVerification: 'zero-retention-check'
    };
    const peer1AnswerPromise = waitForMessage(peer1);
    peer2.send(JSON.stringify(answerPayload));
    const receivedAnswer = await peer1AnswerPromise;
    assert.deepStrictEqual(
      receivedAnswer,
      answerPayload,
      'Peer 1 must receive exact unmodified answer payload'
    );
    console.log('  ✅ Answer passed through directly without modification.');

    // 7c. ICE Candidate from Peer 1 -> Peer 2
    const iceCandidate1 = {
      type: 'ice-candidate',
      candidate: 'candidate:842163049 1 udp 1677729535 192.168.1.100 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0
    };
    const peer2CandidatePromise = waitForMessage(peer2);
    peer1.send(JSON.stringify(iceCandidate1));
    const receivedCandidate1 = await peer2CandidatePromise;
    assert.deepStrictEqual(receivedCandidate1, iceCandidate1);
    console.log('  ✅ ICE candidate (Peer 1 -> Peer 2) passed through directly.');

    // 7d. ICE Candidate from Peer 2 -> Peer 1
    const iceCandidate2 = {
      type: 'ice-candidate',
      candidate: 'candidate:123456789 1 udp 2122260223 10.0.0.2 65432 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0
    };
    const peer1CandidatePromise = waitForMessage(peer1);
    peer2.send(JSON.stringify(iceCandidate2));
    const receivedCandidate2 = await peer1CandidatePromise;
    assert.deepStrictEqual(receivedCandidate2, iceCandidate2);
    console.log('  ✅ ICE candidate (Peer 2 -> Peer 1) passed through directly.\n');

    // Test 8: Instant Room Deletion & Peer Teardown on Disconnect (Peer 1 disconnects)
    console.log('Test 8: Instant room destruction and partner peer teardown on disconnect...');
    const peer2ClosePromise = waitForClose(peer2);

    // Disconnect peer1
    peer1.close();

    const peer2CloseResult = await peer2ClosePromise;
    assert.strictEqual(peer2CloseResult.code, 1000);
    assert.strictEqual(peer2CloseResult.reason, 'Peer disconnected');
    assert(!rooms.has(roomCode), 'Room must be immediately deleted from registry');
    assert.strictEqual(rooms.size, 0, 'Zero rooms must remain in memory');
    console.log('  ✅ Room deleted instantly and partner peer dropped with close code 1000.\n');

    // Test 8b: Reverse Disconnect (Peer 2 creates room, Peer 1 joins, Peer 2 disconnects)
    console.log('Test 8b: Reverse disconnect teardown (Joiner disconnects)...');
    const pA = await createClient();
    pA.send(JSON.stringify({ type: 'create' }));
    const pACreated = await waitForMessage(pA);
    const pB = await createClient();
    const pAPeerJoinedPromise = waitForMessage(pA);
    pB.send(JSON.stringify({ type: 'join', roomCode: pACreated.roomCode }));
    await waitForMessage(pB);
    await pAPeerJoinedPromise;

    const pAClosePromise = waitForClose(pA);
    // Peer B (joiner) disconnects
    pB.close();
    const pACloseResult = await pAClosePromise;
    assert.strictEqual(pACloseResult.code, 1000);
    assert.strictEqual(pACloseResult.reason, 'Peer disconnected');
    assert(!rooms.has(pACreated.roomCode), 'Room must be purged when joiner disconnects');
    assert.strictEqual(rooms.size, 0, 'Zero rooms remain in memory');
    console.log('  ✅ Room purged and creator dropped when joiner disconnects.\n');

    // Test 9: Malformed JSON and Error Handling
    console.log('Test 9: Malformed JSON and bad requests...');
    const badClient = await createClient();
    badClient.send('INVALID_NOT_JSON');
    const badJsonMsg = await waitForMessage(badClient);
    assert.strictEqual(badJsonMsg.type, 'error');
    assert.strictEqual(badJsonMsg.message, 'Invalid JSON payload');

    badClient.send(JSON.stringify({ type: 'unknown-cmd' }));
    const unknownTypeMsg = await waitForMessage(badClient);
    assert.strictEqual(unknownTypeMsg.type, 'error');
    assert(unknownTypeMsg.message.includes('Unsupported message type'));

    badClient.close();
    console.log('  ✅ Invalid payloads and unsupported types safely handled.\n');

    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! 100% compliant with specifications.');
  } finally {
    await new Promise((resolve) => close(resolve));
  }
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
