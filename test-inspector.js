'use strict';

/**
 * The Developers tab's recorder: parsing, masking, sampling, secret scrubbing and the bounded
 * event buffer. No browser needed.
 */

const assert = require('assert');
const Inspector = require('./public/inspector');

const section = (title) => console.log(`\n${title}`);
const pass = (msg) => console.log(`  ✅ ${msg}`);

console.log('🧪 Starting Developers tab recorder tests...');

section('Test 1: ICE candidate and SDP parsing');
{
  const host = Inspector.parseCandidate(
    'candidate:842163049 1 udp 2113937151 192.168.1.6 59129 typ host generation 0'
  );
  assert.deepStrictEqual(
    {
      type: host.type,
      protocol: host.protocol,
      address: host.address,
      port: host.port,
      priority: host.priority
    },
    { type: 'host', protocol: 'udp', address: '192.168.1.6', port: 59129, priority: 2113937151 }
  );
  const srflx = Inspector.parseCandidate(
    'a=candidate:1 1 UDP 1677729535 203.0.113.5 41234 typ srflx raddr 10.0.0.2 rport 41234'
  );
  assert.strictEqual(srflx.type, 'srflx');
  assert.strictEqual(srflx.protocol, 'udp');
  assert.strictEqual(srflx.relatedAddress, '10.0.0.2');
  assert.strictEqual(srflx.relatedPort, 41234);
  const tcp = Inspector.parseCandidate(
    'candidate:9 1 tcp 1518280447 10.0.0.2 9 typ host tcptype active'
  );
  assert.strictEqual(tcp.tcpType, 'active');
  assert.strictEqual(Inspector.parseCandidate('garbage'), null);
  assert.strictEqual(Inspector.parseCandidate(undefined), null);

  const sdp = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=ice-ufrag:3N5Y',
    'a=ice-pwd:supersecretpassword123456',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 AA:BB:CC',
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    'a=candidate:842163049 1 udp 2113937151 192.168.1.6 59129 typ host'
  ].join('\r\n');
  const p = Inspector.parseSdp(sdp);
  assert.strictEqual(p.iceUfrag, '3N5Y');
  assert.strictEqual(p.fingerprintAlgorithm, 'sha-256');
  assert.strictEqual(p.fingerprint, 'AA:BB:CC');
  assert.strictEqual(p.setup, 'actpass');
  assert.strictEqual(p.sctpPort, 5000);
  assert.strictEqual(p.maxMessageSize, 262144);
  assert.strictEqual(p.media.length, 1);
  assert.strictEqual(p.candidates.length, 1);
  assert.strictEqual(Inspector.parseSdp(null).lines, 0);
  pass('host, srflx and tcp candidates, bad input, and the SDP facts are extracted');
}

section('Test 2: nonces and sampling');
{
  assert.strictEqual(Inspector.nonceHex(0, 0), '000000000000000000000000');
  assert.strictEqual(Inspector.nonceHex(0, 1), '000000000000000000000001');
  assert.strictEqual(Inspector.nonceHex(1, 0), '000000010000000000000000');
  assert.strictEqual(Inspector.nonceHex(0, (1n << 64n) - 1n), '00000000ffffffffffffffff');
  assert.strictEqual(Inspector.nonceHex(0, 255).length, 24);
  // Must agree with the nonce the cipher really uses
  const { nonceIndex } = require('./chunkCrypto');
  for (const [f, c] of [
    [0, 0],
    [3, 17],
    [7, 1000000]
  ]) {
    assert.strictEqual(BigInt('0x' + Inspector.nonceHex(f, c)), nonceIndex(f, c));
  }
  const sampled = [];
  for (let i = 0; i < 200; i++) if (Inspector.shouldSampleChunk(i, 200)) sampled.push(i);
  assert.deepStrictEqual(sampled, [0, 1, 2, 64, 128, 192, 199]);
  pass(
    'nonce layout matches the real cipher, and only the first, every 64th and last chunk are sampled'
  );
}

section('Test 3: masking');
{
  assert.strictEqual(Inspector.maskAddress('192.168.1.6'), '192.168.*.*');
  assert.strictEqual(Inspector.maskAddress('2001:db8:85a3:0:0:8a2e:370:7334'), '2001:db8::*');
  assert.strictEqual(
    Inspector.maskAddress('1b2c3d4e-0000-4000-8000-123456789abc.local'),
    '*.local'
  );
  assert.strictEqual(Inspector.maskAddress('stun.example.com'), 'stun.example.com');
  assert.strictEqual(
    Inspector.maskText('candidate 10.20.30.40 and 203.0.113.9 here'),
    'candidate 10.20.*.* and 203.0.*.* here'
  );
  pass('IPv4, IPv6 and mDNS addresses are masked, hostnames are left alone');
}

section('Test 4: the key never reaches the log');
{
  Inspector.reset();
  const key = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
  Inspector.setSecret(key);
  const e = Inspector.emit('signaling', 'out', {
    type: 'x',
    payload: { nested: [`link #ROOM.${key}`, { deep: key }] }
  });
  Inspector.set('thing', { key });
  const dump = JSON.stringify(Inspector.snapshot());
  assert(!dump.includes(key), 'secret scrubbed everywhere');
  assert(dump.includes(Inspector.SECRET_PLACEHOLDER));
  assert.strictEqual(e.data.payload.nested[0], `link #ROOM.${Inspector.SECRET_PLACEHOLDER}`);
  assert.strictEqual(Inspector.getSecret(), key, 'the tab can still reveal it on request');
  Inspector.setSecret('short');
  assert.strictEqual(Inspector.getSecret(), null, 'implausibly short values are not registered');
  Inspector.reset();
  assert.strictEqual(Inspector.getSecret(), null, 'a new session forgets the secret');
  pass('a registered key is replaced in every event and state value, and forgotten on reset');
}

section('Test 5: buffer, listeners and reset');
{
  Inspector.reset();
  let notified = 0;
  const off = Inspector.subscribe(() => notified++);
  for (let i = 0; i < Inspector.MAX_EVENTS + 50; i++) Inspector.emit('flow', 'pause', { i });
  const snap = Inspector.snapshot();
  assert.strictEqual(snap.events.length, Inspector.MAX_EVENTS, 'bounded');
  assert.strictEqual(
    snap.events[snap.events.length - 1].data.i,
    Inspector.MAX_EVENTS + 49,
    'newest kept'
  );
  assert(snap.events[0].id < snap.events[1].id, 'ids increase');
  assert.strictEqual(notified, Inspector.MAX_EVENTS + 50);
  Inspector.set('k', 1);
  assert.strictEqual(Inspector.get('k'), 1);
  Inspector.clearEvents();
  assert.strictEqual(Inspector.snapshot().events.length, 0);
  assert.strictEqual(Inspector.get('k'), 1, 'clearing events keeps state');
  off();
  const before = notified;
  Inspector.emit('flow', 'pause');
  assert.strictEqual(notified, before, 'unsubscribed listeners are not called');
  Inspector.reset();
  assert.strictEqual(Inspector.get('k'), undefined);
  // A failing listener does not break recording
  const quiet = console.error;
  console.error = () => {};
  Inspector.subscribe(() => {
    throw new Error('boom');
  });
  assert.doesNotThrow(() => Inspector.emit('flow', 'pause'));
  console.error = quiet;
  pass('the buffer is bounded, listeners can unsubscribe or fail safely, reset clears state');
}

section('Test 6: stats summary');
{
  const reports = [
    {
      id: 'T',
      type: 'transport',
      selectedCandidatePairId: 'P',
      dtlsState: 'connected',
      iceState: 'connected',
      dtlsRole: 'server',
      tlsVersion: 'FEFC',
      dtlsCipher: 'TLS_AES_128_GCM_SHA256',
      srtpCipher: '',
      bytesSent: 10,
      bytesReceived: 20
    },
    {
      id: 'P',
      type: 'candidate-pair',
      state: 'succeeded',
      currentRoundTripTime: 0.0284,
      bytesSent: 100,
      bytesReceived: 200,
      availableOutgoingBitrate: 800000,
      localCandidateId: 'L',
      remoteCandidateId: 'R'
    },
    {
      id: 'L',
      type: 'local-candidate',
      candidateType: 'host',
      protocol: 'udp',
      address: '192.168.1.6',
      port: 1000
    },
    {
      id: 'R',
      type: 'remote-candidate',
      candidateType: 'relay',
      protocol: 'udp',
      ip: '203.0.113.7',
      port: 3478,
      relayProtocol: 'tls'
    },
    {
      id: 'D',
      type: 'data-channel',
      label: 'fileTransfer',
      state: 'open',
      messagesSent: 5,
      bytesSent: 50,
      messagesReceived: 6,
      bytesReceived: 60
    }
  ];
  const view = Inspector.summarizeStats(new Map(reports.map((r) => [r.id, r])));
  assert.strictEqual(view.transport.tlsVersion, 'DTLS 1.3');
  assert.strictEqual(view.transport.dtlsCipher, 'TLS_AES_128_GCM_SHA256');
  assert.strictEqual(view.pair.rttMs, 28);
  assert.strictEqual(view.pair.relayed, true, 'a relay candidate on either end means relayed');
  assert.strictEqual(view.pair.local.address, '192.168.1.6');
  assert.strictEqual(
    view.pair.remote.address,
    '203.0.113.7',
    'newer "ip" field name is accepted too'
  );
  assert.strictEqual(view.channel.messagesReceived, 6);

  const direct = Inspector.summarizeStats(
    new Map(reports.map((r) => [r.id, r.id === 'R' ? { ...r, candidateType: 'srflx' } : r]))
  );
  assert.strictEqual(direct.pair.relayed, false);

  const noTransportPair = Inspector.summarizeStats(
    new Map([['P', { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded' }]])
  );
  assert.strictEqual(noTransportPair.pair.state, 'succeeded', 'falls back to a nominated pair');
  const empty = Inspector.summarizeStats(new Map());
  assert.deepStrictEqual([empty.transport, empty.pair, empty.channel], [null, null, null]);
  pass('transport, selected path (direct vs relayed) and data channel are read from stats');
}

console.log('\n🎉 ALL DEVELOPERS TAB RECORDER TESTS PASSED!');
