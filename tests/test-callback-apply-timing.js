#!/usr/bin/env node
/**
 * PFA Engine — callback timing at the APPLY point + crossfadeTo entry ramp.
 *
 * Two contracts locked here (Godot addon carries the same semantics via its
 * node_applied / level_applied signals and _entry_fade_override):
 *
 *   1. onLevelChanged / onNodeChanged fire when the change is APPLIED — on the
 *      bar/beat quantized path that is the boundary, not the wrapper call; the
 *      payload always carries the post-change node/level. A wrapper that
 *      synthesizes the callback synchronously reports state the event has not
 *      reached (and, for navigate, the OLD node id). Instant navigate must fire
 *      the callback exactly ONCE (the apply point already reports it — the old
 *      wrapper double-fired).
 *
 *   2. crossfadeTo(event, duration): the explicit duration owns the fresh-start
 *      entry ramp. fadeIn(duration) + play() lets play()'s 20 ms anti-click
 *      ramp cancel and replace the caller's tween — the incoming side hits full
 *      volume ~instantly while the outgoing side fades for `duration` (the
 *      "one-sided crossfade" defect).
 *
 * Loads the REAL src/index.js (not a port).
 * Usage: node test-callback-apply-timing.js
 */

const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack };';
  return new Function('window', src)(undefined);
}
const { PFA, PFAEvent } = loadEngine();

let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Mock Web Audio (house convention: params carry .value + an event log) ──
function mkParam(v = 1) {
  return {
    value: v, _e: [],
    setValueAtTime(val, t) { this._e.push({ kind: 'set', val, t }); this.value = val; },
    linearRampToValueAtTime(val, t) { this._e.push({ kind: 'lin', val, t }); this.value = val; },
    exponentialRampToValueAtTime(val, t) { this._e.push({ kind: 'exp', val, t }); this.value = val; },
    setValueCurveAtTime(arr, t, dur) { this._e.push({ kind: 'curve', t, dur, end: arr[arr.length - 1] }); this.value = arr[arr.length - 1]; },
    cancelScheduledValues(t) { this._e.push({ kind: 'cancel', t }); },
    setTargetAtTime(val, t, tc) { this._e.push({ kind: 'target', val, t, tc }); this.value = val; },
  };
}
function mkGain() {
  return { gain: mkParam(1), connect() {}, disconnect() {} };
}

/** Engine stub: real PFA prototype methods over a mock Web Audio surface. */
function mkEngine() {
  const eng = {
    _now() { return this.ctx.currentTime; },
    _events: {},
    events: {},   // crossfadeTo scans this.events (the real PFA's public map)
    _getEvent(n) { return this._events[n] || null; },
    onLevelChanged: null,
    onNodeChanged: null,
    onEventStarted: null,
    masterGain: mkGain(),
    ctx: {
      currentTime: 0,
      _gains: [],
      createGain() { const g = mkGain(); this._gains.push(g); return g; },
    },
  };
  for (const k of Object.getOwnPropertyNames(PFA.prototype)) {
    if (k !== 'constructor' && typeof PFA.prototype[k] === 'function' && !eng[k]) {
      eng[k] = PFA.prototype[k];
    }
  }
  return eng;
}

function mkMusicEvent(eng, name, data = {}) {
  const ev = new PFAEvent(name, {
    type: 'music', volume: 1.0, bpm: 240, time_signature: [4, 4],
    levels: ['calm', 'action', 'boss'], tracks: [], ...data,
  }, eng);
  ev.buffersLoaded = true;
  ev.loadBuffers = async () => {};
  eng._events[name] = ev;
  eng.events[name] = ev;
  return ev;
}

const GRAPH = {
  entry_node: 'a',
  nodes: {
    a: { name: 'Alpha', level_index: 0 },
    b: { name: 'Beta', level_index: 0 },
  },
  connections: [
    { source: 'a', target: 'b', conn_type: 'transition', trigger: 'go',
      quantize: 'instant', kind: 'crossfade', fade_duration: 0 },
    { source: 'a', target: 'b', conn_type: 'transition', trigger: 'go_bar',
      quantize: 'bar', kind: 'crossfade', fade_duration: 0 },
  ],
};

async function main() {

// ═════════════════════════════════════════════════════════════════════
header('1. onLevelChanged fires at the APPLY point');
// ═════════════════════════════════════════════════════════════════════
{
  sub('not playing: direct set still reports (synchronously, after the change)');
  const eng = mkEngine();
  const ev = mkMusicEvent(eng, 'm');
  const calls = [];
  eng.onLevelChanged = (n, l) => calls.push({ n, l, at: ev.currentLevel });
  eng.setLevel('m', 1);
  assert(calls.length === 1 && calls[0].l === 1, 'one callback with the new level');
  assert(calls[0].at === 1, 'currentLevel already switched when the callback ran');

  sub('instant playing path: applied now, reported now');
  ev.isPlaying = true;
  ev.switchQuantization = 'instant';
  eng.setLevel('m', 2);
  assert(calls.length === 2 && calls[1].l === 2 && calls[1].at === 2,
    'instant switch reported at apply');

  sub('bar-quantized path: NOT reported at the call — reported at the boundary');
  ev.switchQuantization = 'bar';
  ev._playStartTime = 0;
  eng.ctx.currentTime = 0.9;   // bar = 1 s at 240 bpm 4/4 → boundary at 1.0 s
  eng.setLevel('m', 0);
  assert(calls.length === 2, 'no synchronous callback for a scheduled switch');
  assert(ev.currentLevel === 2, 'level unchanged at call time');
  await sleep(220);            // boundary in 100 ms + margin
  assert(calls.length === 3 && calls[2].l === 0,
    'boundary apply reported the switch');
  assert(calls[2].at === 0, 'currentLevel already switched when the callback ran');
}

// ═════════════════════════════════════════════════════════════════════
header('2. onNodeChanged fires ONCE, at the APPLY point, with the NEW node');
// ═════════════════════════════════════════════════════════════════════
{
  sub('instant navigate: exactly one callback (apply point), new node id');
  const eng = mkEngine();
  const ev = mkMusicEvent(eng, 'g', { use_nodes: true });
  ev.useNodes = true;
  ev.nodeGraph = GRAPH;
  ev.currentNode = 'a';
  ev.isPlaying = true;
  const calls = [];
  eng.onNodeChanged = (n, id, nm) => calls.push({ id, nm, at: ev.currentNode });
  const matched = eng.navigate('g', 'go');
  assert(matched === true, 'navigate matched the instant connection');
  assert(calls.length === 1,
    `exactly one callback (got ${calls.length}; wrapper used to double-fire on instant)`);
  assert(calls[0] && calls[0].id === 'b' && calls[0].nm === 'Beta',
    'callback carries the NEW node id/name');
  assert(calls[0] && calls[0].at === 'b', 'currentNode already "b" when the callback ran');

  sub('bar-quantized navigate: nothing at the call, the boundary apply reports');
  const eng2 = mkEngine();
  const ev2 = mkMusicEvent(eng2, 'q', { use_nodes: true });
  ev2.useNodes = true;
  ev2.nodeGraph = GRAPH;
  ev2.currentNode = 'a';
  ev2.isPlaying = true;
  ev2._playStartTime = 0;
  eng2.ctx.currentTime = 0.9;  // boundary at 1.0 s
  const calls2 = [];
  eng2.onNodeChanged = (n, id, nm) => calls2.push({ id, at: ev2.currentNode });
  const matched2 = eng2.navigate('q', 'go_bar');
  assert(matched2 === true, 'quantized navigate matched');
  assert(calls2.length === 0,
    `no synchronous callback for a scheduled transition (got ${calls2.length}; old wrapper reported the OLD node here)`);
  assert(ev2.currentNode === 'a', 'node unchanged at call time');
  await sleep(220);
  assert(calls2.length === 1 && calls2[0].id === 'b',
    'boundary apply reported the transition with the NEW node');
  assert(calls2[0] && calls2[0].at === 'b', 'currentNode already "b" when the callback ran');
}

// ═════════════════════════════════════════════════════════════════════
header('3. crossfadeTo: the explicit duration owns the fresh-start entry ramp');
// ═════════════════════════════════════════════════════════════════════
{
  const eng = mkEngine();
  const oldEv = mkMusicEvent(eng, 'old');
  oldEv.isPlaying = true;
  oldEv._ensureGain();
  const fresh = mkMusicEvent(eng, 'fresh');
  await eng.crossfadeTo('fresh', 2.0);
  const log = fresh._eventGain.gain._e;
  const ramps = log.filter(e => e.kind === 'curve' || e.kind === 'lin');
  const last = ramps[ramps.length - 1];
  const lastDur = last ? (last.kind === 'curve' ? last.dur : last.t) : NaN;
  assert(last && Math.abs(lastDur - 2.0) < 1e-6,
    `final ramp on the incoming side spans the requested 2.0 s (got ${lastDur}; ` +
    `the old code left a 0.02 s anti-click ramp as the LAST word)`);
  assert(fresh._entryFadeOverride == null || Object.keys(fresh._entryFadeOverride).length === 0,
    'override consumed by the fresh start (no stale override for the next play)');
  const oldRamps = oldEv._eventGain.gain._e.filter(e => e.kind === 'curve');
  const oldLast = oldRamps[oldRamps.length - 1];
  assert(oldLast && Math.abs(oldLast.dur - 2.0) < 1e-6 && oldLast.end <= 0.0001,
    'outgoing side fades to silence over the same 2.0 s');
}

// ═════════════════════════════════════════════════════════════════════
header('Summary');
// ═════════════════════════════════════════════════════════════════════
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
