// End-to-end test for the meeting-app server.
// Exercises every socket event and HTTP endpoint with multiple simulated clients.
const io = require('socket.io-client');
const http = require('http');

const SERVER = 'http://localhost:3000';
let passes = 0, fails = 0;

function assert(cond, msg) {
  if (cond) { console.log('  ✓', msg); passes++; }
  else { console.log('  ✗', msg); fails++; }
}

function connect() {
  return new Promise((res, rej) => {
    const s = io(SERVER, { transports: ['websocket'], forceNew: true, reconnection: false });
    const timer = setTimeout(() => rej(new Error('connect timeout')), 3000);
    s.on('connect', () => { clearTimeout(timer); res(s); });
    s.on('connect_error', (e) => { clearTimeout(timer); rej(e); });
  });
}

function joinAs(s, room, name) {
  return new Promise(r => s.emit('join', { roomId: room, name }, r));
}

function emitWithAck(s, event, payload) {
  return new Promise(r => s.emit(event, payload, r));
}

function listenOnce(s, event, timeoutMs = 1500) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + event)), timeoutMs);
    s.once(event, (data) => { clearTimeout(t); res(data); });
  });
}

// Waits for a `peers` event that satisfies the predicate. Necessary because
// joining a room itself fires a peers broadcast, so a naive once() would
// catch the stale snapshot from the join instead of the post-change one.
function waitForPeers(s, predicate, timeoutMs = 2000) {
  return new Promise((res, rej) => {
    let handler;
    const t = setTimeout(() => { s.off('peers', handler); rej(new Error('timeout waiting for matching peers')); }, timeoutMs);
    handler = (msg) => {
      try {
        if (predicate(msg)) { clearTimeout(t); s.off('peers', handler); res(msg); }
      } catch (e) { /* keep waiting */ }
    };
    s.on('peers', handler);
  });
}

const get = (path) => new Promise((res, rej) => {
  http.get(SERVER + path, (r) => {
    let body = ''; r.on('data', c => body += c); r.on('end', () => res({ status: r.statusCode, body }));
  }).on('error', rej);
});

async function run() {
  // -- HTTP --
  console.log('\n[HTTP endpoints]');
  const h = await get('/health');
  assert(h.status === 200 && JSON.parse(h.body).ok === true, '/health returns {ok:true}');
  const idx = await get('/');
  assert(idx.status === 200 && idx.body.includes('Meeting Room'), '/ serves index');
  const sum = await new Promise(r => {
    const req = http.request(SERVER + '/api/summarize', { method: 'POST' }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => r({ status: res.statusCode, body: b }));
    });
    req.end();
  });
  assert(sum.status === 400, '/api/summarize without audio returns 400');

  // -- Name validation --
  console.log('\n[Name validation]');
  const v1 = await connect();
  assert((await joinAs(v1, 'rv-' + Date.now(), '')).error === 'name_required', 'empty name rejected');
  assert((await joinAs(v1, 'rv-' + Date.now(), '   ')).error === 'name_required', 'whitespace name rejected');
  assert((await joinAs(v1, 'rv-' + Date.now(), 'x'.repeat(41))).error === 'name_too_long', 'too-long name rejected');
  assert((await joinAs(v1, '', 'Alice')).error === 'invalid_room', 'empty room id rejected');
  const okRes = await joinAs(v1, 'rv-' + Date.now(), 'Alice');
  assert(okRes.ok === true && okRes.hostId === okRes.selfId, 'first joiner becomes host');
  v1.disconnect();

  // -- Duplicate name (case-insensitive) --
  console.log('\n[Duplicate name]');
  const dupRoom = 'dup-' + Date.now();
  const da = await connect();
  await joinAs(da, dupRoom, 'Alice');
  const db = await connect();
  assert((await joinAs(db, dupRoom, 'Alice')).error === 'name_taken', 'exact dup rejected');
  assert((await joinAs(db, dupRoom, 'ALICE')).error === 'name_taken', 'uppercase dup rejected');
  assert((await joinAs(db, dupRoom, 'alice')).error === 'name_taken', 'lowercase dup rejected');
  assert((await joinAs(db, dupRoom, '  Alice  ')).error === 'name_taken', 'whitespace-padded dup rejected');
  assert((await joinAs(db, dupRoom, 'Bob')).ok === true, 'different name accepted');
  da.disconnect(); db.disconnect();

  // -- Host election & transfer --
  console.log('\n[Host election & transfer]');
  const room = 'host-' + Date.now();
  const ha = await connect();
  const haRes = await joinAs(ha, room, 'Host-A');
  const hb = await connect();
  const hbRes = await joinAs(hb, room, 'Host-B');
  const hc = await connect();
  const hcRes = await joinAs(hc, room, 'Host-C');
  assert(hbRes.hostId === haRes.selfId && hcRes.hostId === haRes.selfId, 'all see A as host');
  const w1 = waitForPeers(hb, m => m.hostId === hbRes.selfId, 3000);
  ha.disconnect();
  await w1;
  assert(true, 'B promoted after A leaves');
  const w2 = waitForPeers(hc, m => m.hostId === hcRes.selfId, 3000);
  hb.disconnect();
  await w2;
  assert(true, 'C promoted after B leaves');
  hc.disconnect();

  // -- State sync --
  console.log('\n[State sync]');
  const sroom = 'state-' + Date.now();
  const sa = await connect(); const saRes = await joinAs(sa, sroom, 'A');
  const sb = await connect(); await joinAs(sb, sroom, 'B');
  let pred = waitForPeers(sb, m => { const a = m.peers.find(p => p.id === saRes.selfId); return a && a.mic === false; });
  sa.emit('state', { mic: false });
  await pred;
  assert(true, 'mic-off state broadcast');
  pred = waitForPeers(sb, m => { const a = m.peers.find(p => p.id === saRes.selfId); return a && a.cam === false && a.handRaised === true; });
  sa.emit('state', { cam: false, handRaised: true });
  await pred;
  assert(true, 'multi-key state patch applied');
  pred = waitForPeers(sb, m => { const a = m.peers.find(p => p.id === saRes.selfId); return a && a.sharing === true && a.cam === false; });
  sa.emit('state', { sharing: true });
  await pred;
  assert(true, 'patch is additive, not replacing');
  sa.disconnect(); sb.disconnect();

  // -- Force-mute (host-only enforcement) --
  console.log('\n[Force-mute]');
  const fmroom = 'fm-' + Date.now();
  const fma = await connect(); const fmaRes = await joinAs(fma, fmroom, 'A'); // host
  const fmb = await connect(); const fmbRes = await joinAs(fmb, fmroom, 'B');
  const fmc = await connect(); await joinAs(fmc, fmroom, 'C');
  // Host mutes B
  const fmw = listenOnce(fmb, 'forced-mute', 2000);
  fma.emit('force-mute', { to: fmbRes.selfId });
  const fmEvt = await fmw;
  assert(fmEvt.from === fmaRes.selfId, 'host can force-mute');
  // Non-host C tries to mute B — should NOT fire
  let cMutedB = false;
  fmb.once('forced-mute', () => { cMutedB = true; });
  fmc.emit('force-mute', { to: fmbRes.selfId });
  await new Promise(r => setTimeout(r, 400));
  assert(cMutedB === false, 'non-host force-mute ignored');
  fma.disconnect(); fmb.disconnect(); fmc.disconnect();

  // -- Reactions --
  console.log('\n[Reactions]');
  const rxroom = 'rx-' + Date.now();
  const rxa = await connect(); const rxaRes = await joinAs(rxa, rxroom, 'A');
  const rxb = await connect(); await joinAs(rxb, rxroom, 'B');
  const rxw = listenOnce(rxb, 'reaction', 2000);
  rxa.emit('reaction', { emoji: '👍' });
  const rxEvt = await rxw;
  assert(rxEvt.emoji === '👍' && rxEvt.from === rxaRes.selfId, 'reaction broadcast');
  const rxw2 = listenOnce(rxb, 'reaction', 2000);
  rxa.emit('reaction', { emoji: 'xxxxxxxxxx' });  // 10 chars > 8 limit
  const rxEvt2 = await rxw2;
  assert(rxEvt2.emoji.length === 8, 'long emoji truncated to 8 chars');
  rxa.disconnect(); rxb.disconnect();

  // -- Chat --
  console.log('\n[Chat]');
  const croom = 'chat-' + Date.now();
  const ca = await connect(); const caRes = await joinAs(ca, croom, 'A');
  const cb = await connect(); await joinAs(cb, croom, 'B');
  const cw = listenOnce(cb, 'chat', 2000);
  ca.emit('chat', { message: 'hi there' });
  const cMsg = await cw;
  assert(cMsg.message === 'hi there' && cMsg.name === 'A' && cMsg.from === caRes.selfId, 'chat received');
  const cw2 = listenOnce(cb, 'chat', 2000);
  ca.emit('chat', { message: 'x'.repeat(3000) });
  const cMsg2 = await cw2;
  assert(cMsg2.message.length === 2000, 'chat truncated at 2000 chars');
  ca.disconnect(); cb.disconnect();

  // -- Signal relay (WebRTC SDP/ICE) --
  console.log('\n[Signal relay]');
  const sigroom = 'sig-' + Date.now();
  const siga = await connect(); const sigaRes = await joinAs(siga, sigroom, 'A');
  const sigb = await connect(); const sigbRes = await joinAs(sigb, sigroom, 'B');
  const sigw = listenOnce(sigb, 'signal', 2000);
  const payload = { description: { type: 'offer', sdp: 'fake' } };
  siga.emit('signal', { to: sigbRes.selfId, data: payload });
  const sigEvt = await sigw;
  assert(sigEvt.from === sigaRes.selfId && JSON.stringify(sigEvt.data) === JSON.stringify(payload), 'signal relayed verbatim');
  siga.disconnect(); sigb.disconnect();

  // -- Rename validation --
  console.log('\n[Rename]');
  const rnroom = 'rn-' + Date.now();
  const rna = await connect(); await joinAs(rna, rnroom, 'Alice');
  const rnb = await connect(); await joinAs(rnb, rnroom, 'Bob');
  assert((await emitWithAck(rna, 'rename', { name: 'Alicia' })).ok === true, 'rename to free name');
  assert((await emitWithAck(rna, 'rename', { name: 'Bob' })).error === 'name_taken', 'rename to taken name');
  assert((await emitWithAck(rna, 'rename', { name: '' })).error === 'invalid_name', 'empty rename rejected');
  rna.disconnect(); rnb.disconnect();

  // -- Disconnect cleanup --
  console.log('\n[Disconnect cleanup]');
  const droom = 'd-' + Date.now();
  const da2 = await connect(); await joinAs(da2, droom, 'A');
  const db2 = await connect(); const db2Res = await joinAs(db2, droom, 'B');
  const dw = listenOnce(da2, 'peer-left', 2000);
  db2.disconnect();
  const dEvt = await dw;
  assert(dEvt.id === db2Res.selfId, 'peer-left emitted on disconnect');
  da2.disconnect();
  // Wait for room to be cleaned up
  await new Promise(r => setTimeout(r, 200));
  const fresh = await connect();
  const freshRes = await joinAs(fresh, droom, 'A');  // same name as previous host — should work because room is gone
  assert(freshRes.ok === true && freshRes.hostId === freshRes.selfId, 'room recycled after all peers leave');
  fresh.disconnect();

  // -- Summary --
  console.log('\n[Summary]');
  console.log('passes: ' + passes + ', fails: ' + fails);
  process.exit(fails ? 1 : 0);
}

run().catch(err => { console.error('Test crashed:', err); process.exit(2); });
