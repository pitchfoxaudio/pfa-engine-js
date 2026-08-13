#!/usr/bin/env node
/**
 * PFA Engine — PFALiveConnect (the editor Live Connect client).
 *
 * Locks the protocol contract the 2026-06-10 P2 audit documented
 * (doc «Live Connect — protocol audit + roadmap» in the editor repo):
 *   1. Dispatch: each editor message type → the right PFA API call;
 *      set_solo / hot_swap / config_update / unknown types are IGNORED silently.
 *   2. set_level passes (event, level) ONLY — the authored event fade rules
 *      (the editor no longer sends a fade field; older editors might).
 *   3. reload chain: stopAll(0.5) → clear events/groups → loadPack(basePath
 *      + '/config.json') → preloadAll, with the _reloading re-entry guard.
 *   4. hello on connect: {type:'hello', platform:'web', engine:PFA.VERSION,
 *      pack:<config.project>} is sent as the first frame after open.
 *   5. Reconnect: scheduled at 5s on close; disconnect() cancels it.
 *
 * Loads the REAL src/index.js (not a port).
 * Usage: node test-live-connect.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFALiveConnect };';
  return new Function('window', src)(undefined);
}
const { PFA, PFALiveConnect } = loadEngine();

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function sub(t){console.log('\n  ─── '+t+' ───');}
function ok(m){passed++;console.log('    ✓ '+m);}
function fail(m){failed++;console.log('    ✗ FAIL: '+m);}
function assert(c,m){if(c)ok(m);else fail(m);}

// Stub PFA that records every call the live client makes.
function mkPfa(){
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
  return { calls,
    config: { project: 'stub_pack' }, basePath: '/audio',
    events: { music_forest: 1 }, groups: { Music: 1 }, loaded: true,
    stopAll: rec('stopAll'), loadPack: rec('loadPack'), preloadAll: rec('preloadAll'),
    setEventVolume: rec('setEventVolume'), setLevel: rec('setLevel'),
    play: rec('play'), stop: rec('stop'), trigger: rec('trigger'),
    setGroupVolume: rec('setGroupVolume'), setMasterVolume: rec('setMasterVolume'),
    duck: rec('duck'), unduck: rec('unduck'),
  };
}

// Fake browser WebSocket (node 18 has none) — captures sends, manual open/close.
class FakeWS {
  constructor(url){ FakeWS.last = this; this.url = url; this.readyState = FakeWS.CONNECTING; this.sent = []; }
  send(d){ this.sent.push(d); }
  close(){ this.readyState = 3; if (this.onclose) this.onclose(); }
}
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1;
global.WebSocket = FakeWS;

async function main(){

// ── 1. Dispatch — every protocol type → the right API call ──────────
header('1. dispatch: editor message → PFA API');
{
  const pfa = mkPfa();
  const lc = new PFALiveConnect(pfa);
  const N = () => pfa.calls.length;

  lc._handleMessage({ type:'set_volume', event:'music_forest', volume:0.7531 });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["setEventVolume","music_forest",0.7531]', 'set_volume → setEventVolume(event, volume)');

  lc._handleMessage({ type:'play', event:'music_forest' });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["play","music_forest"]', 'play → play(event)');

  lc._handleMessage({ type:'stop', event:'music_forest', fade:2.0 });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["stop","music_forest",2]', 'stop → stop(event, fade)');

  lc._handleMessage({ type:'trigger', event:'sfx_footstep' });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["trigger","sfx_footstep"]', 'trigger → trigger(event)');

  lc._handleMessage({ type:'set_mute', event:'music_forest', muted:true });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["duck","music_forest",0,0.1]', 'set_mute true → duck(event, 0, 0.1)');

  lc._handleMessage({ type:'set_mute', event:'music_forest', muted:false });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["unduck","music_forest",0.1]', 'set_mute false → unduck(event, 0.1)');

  lc._handleMessage({ type:'duck', event:'music_forest', level:0.3, fade:0.5 });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["duck","music_forest",0.3,0.5]', 'duck → duck(event, level, fade)');

  lc._handleMessage({ type:'unduck', event:'music_forest', fade:0.25 });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["unduck","music_forest",0.25]', 'unduck → unduck(event, fade)');

  lc._handleMessage({ type:'unduck', event:'music_forest' });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["unduck","music_forest",0.1]', 'unduck without fade → 0.1 default (solo-restore path)');

  lc._handleMessage({ type:'set_master_volume', volume:0.85 });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["setMasterVolume",0.85]', 'set_master_volume → setMasterVolume(volume)');

  lc._handleMessage({ type:'set_group_volume', group:'Music', volume:0.6 });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["setGroupVolume","Music",0.6]', 'set_group_volume → setGroupVolume(group, volume)');

  sub('ignored types — no call, no throw');
  const before = N();
  lc._handleMessage({ type:'set_solo', event:'music_forest', solo:true });
  lc._handleMessage({ type:'hot_swap', event:'e', track:0, level:1, sample:0, url:'x' });
  lc._handleMessage({ type:'config_update', config:{} });
  lc._handleMessage({ type:'unknown_future_type', x:1 });
  lc._handleMessage({ type:'welcome', message:'PFA Live Connect', version:'1.0' });
  lc._handleMessage({ nottype:'no type field' });
  assert(N() === before, 'set_solo / hot_swap / config_update / unknown / welcome / typeless → zero API calls');

  sub('welcome master handshake — a late-join client learns the current master');
  lc._handleMessage({ type:'welcome', message:'PFA Live Connect', version:'1.1', master_volume:0.7 });
  assert(JSON.stringify(pfa.calls.at(-1)) === '["setMasterVolume",0.7]',
    'welcome WITH master_volume → setMasterVolume(volume)');
  // The bare-welcome case (old editor, no key) stays a zero-call no-op — pinned
  // in the ignored-types block above.
}

// ── 2. set_level contract — authored fade wins, no fade forwarded ────
header('2. set_level: (event, level) only');
{
  const pfa = mkPfa();
  const lc = new PFALiveConnect(pfa);
  lc._handleMessage({ type:'set_level', event:'music_forest', level:2, fade:1.5 });
  const call = pfa.calls.at(-1);
  assert(call[0] === 'setLevel' && call[1] === 'music_forest' && call[2] === 2,
    'setLevel(event, level) called');
  assert(call.length === 3, `no fade forwarded — the EVENT's authored fade rules (got ${call.length - 1} args)`);
}

// ── 3. reload chain + re-entry guard ─────────────────────────────────
header('3. reload: stopAll → clear → loadPack → preloadAll (+ guard)');
{
  const realST = setTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  try {
    const pfa = mkPfa();
    const lc = new PFALiveConnect(pfa);

    lc._handleMessage({ type:'reload' });
    assert(JSON.stringify(pfa.calls[0]) === '["stopAll",0.5]', 'stopAll(0.5) immediately');
    assert(timers.length === 1 && timers[0].ms === 600, 'pack swap deferred 600ms (lets the fade ring out)');
    assert(lc._reloading === true, '_reloading guard armed');

    sub('a second reload during the swap is skipped (guard)');
    const t = timers.length;
    lc._handleMessage({ type:'reload' });
    assert(timers.length === t && pfa.calls.filter(c => c[0]==='stopAll').length === 1,
      'no second stopAll / timer while reloading');

    sub('firing the deferred swap');
    let reloadedFired = 0;
    lc.onReload(() => { reloadedFired++; });
    await timers[0].fn();
    assert(Object.keys(pfa.events).length === 0 && Object.keys(pfa.groups).length === 0 && pfa.loaded === false,
      'events/groups/loaded cleared before the re-load');
    assert(JSON.stringify(pfa.calls[1]) === '["loadPack","/audio/config.json"]',
      'loadPack(basePath + /config.json) — re-reads from disk');
    assert(pfa.calls[2] && pfa.calls[2][0] === 'preloadAll', 'preloadAll after loadPack');
    assert(lc._reloading === false, 'guard released after completion');
    assert(reloadedFired === 1, 'onReload callback fired once (game re-triggers its ambiences)');
  } finally {
    global.setTimeout = realST;
  }
}

// ── 4. hello on connect ──────────────────────────────────────────────
header('4. hello: first frame after open');
{
  const pfa = mkPfa();
  const lc = new PFALiveConnect(pfa);
  lc.connect();
  const ws = FakeWS.last;
  assert(ws && ws.url === 'ws://localhost:9264', 'connects to ws://localhost:9264 (default port)');
  ws.readyState = FakeWS.OPEN;
  ws.onopen();
  assert(ws.sent.length === 1, 'exactly one frame sent on open');
  const hello = JSON.parse(ws.sent[0] || '{}');
  assert(hello.type === 'hello', 'frame is a hello');
  assert(hello.platform === 'web', 'platform: web');
  assert(hello.engine === PFA.VERSION, `engine: PFA.VERSION (${PFA.VERSION})`);
  assert(hello.pack === 'stub_pack', 'pack: config.project');
  assert(lc.connected === true, 'connected flag set');
  lc.disconnect();

  sub('no config loaded yet → pack: null (hello still sent)');
  const lc2 = new PFALiveConnect({ });
  lc2.connect();
  const ws2 = FakeWS.last;
  ws2.readyState = FakeWS.OPEN;
  ws2.onopen();
  const hello2 = JSON.parse(ws2.sent[0] || '{}');
  assert(hello2.type === 'hello' && hello2.pack === null, 'pack null when no config');
  lc2.disconnect();
}

// ── 5. reconnect scheduling ──────────────────────────────────────────
header('5. reconnect: 5s on close; disconnect() cancels');
{
  const realST = setTimeout, realCT = clearTimeout;
  const timers = []; let cleared = 0;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => { cleared++; };
  try {
    const pfa = mkPfa();
    const lc = new PFALiveConnect(pfa);
    const statuses = [];
    lc.onStatusChange(s => statuses.push(s));
    lc.connect();
    const ws = FakeWS.last;
    ws.readyState = FakeWS.OPEN;
    ws.onopen();
    ws.close(); // server gone
    assert(statuses.at(-1) === false, 'status callback fired false on close');
    assert(timers.some(t => t.ms === 5000), 'reconnect scheduled at 5000ms');
    const c0 = cleared;
    lc.disconnect();
    assert(cleared > c0, 'disconnect() cancels the pending reconnect');
  } finally {
    global.setTimeout = realST; global.clearTimeout = realCT;
  }
}

// ── summary ──────────────────────────────────────────────────────────
console.log('\n'+'═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed ? 1 : 0);

}

main().catch(e=>{ console.error('FATAL', e); process.exit(1); });
