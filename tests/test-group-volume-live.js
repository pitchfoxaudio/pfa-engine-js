#!/usr/bin/env node
/**
 * PFA Engine — LIVE group volume (the 2026-06-11 mixer gap).
 *
 * A live `set_group_volume` used to only write `event.groupGain`, which playing
 * voices never re-read — music tracks AND spatial voices all hang off
 * `event._eventGain` (gain = volume × groupGain, applied on play/setVolume),
 * so the group fader was dead on running audio until the next volume event.
 * JS mirror of the Godot live-mix gap fixed in e1de7c8.
 *
 * Locks:
 *   1. setGroupVolume still writes group.volume + member groupGain (back-compat).
 *   2. setGroupVolume RE-APPLIES volume×groupGain to a PLAYING _eventGain.
 *   3. Ducked members (live mute = duck 0) re-target duckLevel×groupGain — a
 *      group fader move can NOT lift an active duck; duck() stores _duckLevel.
 *   4. unduck after a group change restores volume×NEW groupGain.
 *   5. Never-played members (no _eventGain) and unknown groups don't crash.
 *   6. setMasterVolume stays live on the masterGain node (regression lock).
 *
 * Loads the REAL src/index.js (not a port).
 * Usage: node test-group-volume-live.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent };';
  return new Function('window', src)(undefined);
}
const { PFA, PFAEvent } = loadEngine();

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function ok(m){passed++;console.log('    ✓ '+m);}
function fail(m){failed++;console.log('    ✗ FAIL: '+m);}
function assert(c,m){if(c)ok(m);else fail(m);}
function near(a,b,eps=1e-4){return Math.abs(a-b)<eps;}

function recParam(v=1){
  return { value:v, _e:[],
    setValueAtTime(val,t){this._e.push({val,t,kind:'set'});this.value=val;},
    linearRampToValueAtTime(val,t){this._e.push({val,t,kind:'lin'});this.value=val;},
    setValueCurveAtTime(arr,t,d){const val=arr[arr.length-1];this._e.push({val,t,d,kind:'curve'});this.value=val;},
    cancelScheduledValues(){},
  };
}
function lastTarget(p){ return p._e.length ? p._e[p._e.length-1].val : p.value; }

function mkPfa(){
  const pfa = Object.create(PFA.prototype);
  pfa.ctx = { get currentTime(){return 0;},
    createGain:()=>({gain:recParam(1),connect(){},disconnect(){}}) };
  pfa.events = {};
  pfa.groups = {};
  pfa.masterGain = { gain: recParam(1), connect(){}, disconnect(){} };
  pfa._masterVolume = 1.0;
  return pfa;
}

function mkEvent(pfa, name, vol=1.0, playing=true){
  const ev = new PFAEvent(name, {type:'music', volume:vol}, pfa);
  ev.groupGain = 1.0;
  ev._eventGain = playing ? { gain: recParam(vol), connect(){}, disconnect(){} } : null;
  pfa.events[name] = ev;
  return ev;
}

function main(){

// ── 1. Property writes (back-compat) ─────────────────────────────────
header('1. setGroupVolume property writes (back-compat)');
{
  const pfa = mkPfa();
  const a = mkEvent(pfa, 'a', 1.0), b = mkEvent(pfa, 'b', 0.8);
  const out = mkEvent(pfa, 'outsider', 1.0);
  pfa.groups.Music = { volume: 1.0, eventNames: ['a', 'b'] };
  pfa.setGroupVolume('Music', 0.5);
  assert(near(pfa.groups.Music.volume, 0.5), 'group.volume updated');
  assert(near(a.groupGain, 0.5) && near(b.groupGain, 0.5), 'member groupGain updated');
  assert(near(out.groupGain, 1.0), 'non-member untouched');
}

// ── 2. LIVE re-apply on playing _eventGain ───────────────────────────
header('2. LIVE re-apply to playing _eventGain (the gap)');
{
  const pfa = mkPfa();
  const a = mkEvent(pfa, 'a', 1.0), b = mkEvent(pfa, 'b', 0.8);
  pfa.groups.Music = { volume: 1.0, eventNames: ['a', 'b'] };
  pfa.setGroupVolume('Music', 0.5);
  assert(near(a._eventGain.gain.value, 0.5),
    'playing member a: node gain re-applied 1.0×0.5 = 0.5 (was dead before fix)');
  assert(near(b._eventGain.gain.value, 0.4),
    'playing member b: node gain re-applied 0.8×0.5 = 0.4');
  assert(a._eventGain.gain._e.length > 0,
    'gain automation actually scheduled (not just property write)');
  pfa.setGroupVolume('Music', 1.0);
  assert(near(a._eventGain.gain.value, 1.0) && near(b._eventGain.gain.value, 0.8),
    'moving the fader back restores volume×1.0');
}

// ── 3. Duck interplay (live mute = duck 0) ───────────────────────────
header('3. Ducked members stay ducked through a group fader move');
{
  const pfa = mkPfa();
  const a = mkEvent(pfa, 'a', 1.0), b = mkEvent(pfa, 'b', 1.0);
  pfa.groups.Music = { volume: 1.0, eventNames: ['a', 'b'] };
  pfa.duck('a', 0.0, 0.1);                       // live mute
  assert(a._isDucked === true, 'duck sets _isDucked');
  assert(a._duckLevel === 0.0, 'duck stores _duckLevel (needed for group re-apply)');
  pfa.setGroupVolume('Music', 0.8);
  assert(lastTarget(a._eventGain.gain) <= 0.001,
    'muted (ducked-0) member is NOT lifted by the group fader');
  assert(near(lastTarget(b._eventGain.gain), 0.8),
    'unducked sibling re-applies 1.0×0.8 = 0.8');
}
{
  const pfa = mkPfa();
  const b = mkEvent(pfa, 'b', 1.0);
  pfa.groups.Music = { volume: 1.0, eventNames: ['b'] };
  pfa.duck('b', 0.3, 0.1);                       // partial duck
  assert(near(b._duckLevel, 0.3), 'partial duck stores its level');
  pfa.setGroupVolume('Music', 0.5);
  assert(near(lastTarget(b._eventGain.gain), 0.15),
    'ducked member re-targets duckLevel×NEW groupGain = 0.3×0.5');
}

// ── 4. unduck restores against the NEW groupGain ─────────────────────
header('4. unduck after a group change');
{
  const pfa = mkPfa();
  const a = mkEvent(pfa, 'a', 1.0);
  pfa.groups.Music = { volume: 1.0, eventNames: ['a'] };
  pfa.duck('a', 0.0, 0.1);
  pfa.setGroupVolume('Music', 0.5);
  pfa.unduck('a', 0.1);
  assert(near(lastTarget(a._eventGain.gain), 0.5),
    'unduck target = volume×NEW groupGain (1.0×0.5)');
  assert(a._isDucked === false, 'unduck clears _isDucked');
}

// ── 5. Robustness ────────────────────────────────────────────────────
header('5. Robustness (no _eventGain / unknown group)');
{
  const pfa = mkPfa();
  const c = mkEvent(pfa, 'c', 1.0, /*playing=*/false);
  pfa.groups.Music = { volume: 1.0, eventNames: ['c', 'ghost'] };
  let threw = false;
  try { pfa.setGroupVolume('Music', 0.25); } catch (e) { threw = true; }
  assert(!threw, 'never-played member + missing event: no crash');
  assert(near(c.groupGain, 0.25), 'property still written for future plays');
  threw = false;
  try { pfa.setGroupVolume('Nope', 0.5); } catch (e) { threw = true; }
  assert(!threw, 'unknown group: silent no-op');
}

// ── 6. Master regression lock ────────────────────────────────────────
header('6. setMasterVolume stays live (regression lock)');
{
  const pfa = mkPfa();
  pfa.setMasterVolume(0.42);
  assert(near(pfa.masterGain.gain.value, 0.42), 'masterGain node updated immediately');
  assert(near(pfa._masterVolume, 0.42), '_masterVolume tracked');
}

console.log('\n' + '═'.repeat(70));
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed ? 1 : 0);
}

main();
