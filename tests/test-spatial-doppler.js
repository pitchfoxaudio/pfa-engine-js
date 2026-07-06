#!/usr/bin/env node
/**
 * PFA Engine — spatial DOPPLER (3D pitch-from-velocity, opt-in via spatial.doppler).
 *
 * Editor authors a SHARED flat `spatial.doppler` (0 = off, 1 = physical, >1
 * stylized). Web Audio's PannerNode doppler was removed from the spec, so the
 * engine computes it manually in _updateSpatialVoices: velocities derive from
 * per-frame position deltas (the game's setListener* call is the tick), the
 * ratio f' = f·(c + vLis·û)/(c − vSrc·û) multiplies ON TOP of the voice's
 * spawn-time playbackRate (pitch/rate randomization preserved).
 *
 * Locks:
 *   1. _dopplerRatio math: approach >1 / recede <1 / perpendicular ≈1 /
 *      listener-side motion / amount scaling / teleport + ratio clamps.
 *   2. Config plumbing: _SPATIAL_DEFAULTS.doppler=0, _eventSpatialToCfg maps
 *      snake_case doppler, _mergeSpatialConfig precedence (game cfg wins).
 *   3. _updateSpatialVoices integration: 3D voice with doppler>0 retunes
 *      playbackRate from movement (composing with a non-1 base rate); first
 *      frame only seeds; 2D / doppler-0 voices stay untouched; stale dt skips.
 *
 * Loads the REAL src/index.js (not a port).
 * Usage: node test-spatial-doppler.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, _dopplerRatio, _DOPPLER_C, _mergeSpatialConfig,'
       + ' _eventSpatialToCfg, _SPATIAL_DEFAULTS };';
  return new Function('window', src)(undefined);
}
const { PFA, _dopplerRatio, _DOPPLER_C, _mergeSpatialConfig,
        _eventSpatialToCfg, _SPATIAL_DEFAULTS } = loadEngine();

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function sub(t){console.log('\n  ─── '+t+' ───');}
function ok(m){passed++;console.log('    ✓ '+m);}
function fail(m){failed++;console.log('    ✗ FAIL: '+m);}
function assert(c,m){if(c)ok(m);else fail(m);}
function near(a,b,eps=1e-3){return Math.abs(a-b)<eps;}

const C = _DOPPLER_C; // 343

header('1. _dopplerRatio math');

sub('radial source motion');
// Source approaching the listener at 10% of c → f' = c/(c−0.1c) = 1.111…
let r = _dopplerRatio({x:0.1*C,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},1);
assert(near(r, 1/0.9), `source approaching at 0.1c → ratio ${r.toFixed(4)} ≈ 1.1111`);
// Source receding at 10% of c → f' = c/(c+0.1c) = 0.909…
r = _dopplerRatio({x:-0.1*C,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},1);
assert(near(r, 1/1.1), `source receding at 0.1c → ratio ${r.toFixed(4)} ≈ 0.9091`);

sub('radial listener motion (the PR#108051 case — fixed source, moving listener)');
// Listener at x=10 moving toward the source (−x) at 0.1c → f' = (c+0.1c)/c = 1.1
r = _dopplerRatio({x:0,y:0,z:0},{x:-0.1*C,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},1);
assert(near(r, 1.1), `listener approaching at 0.1c → ratio ${r.toFixed(4)} = 1.1`);
r = _dopplerRatio({x:0,y:0,z:0},{x:0.1*C,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},1);
assert(near(r, 0.9), `listener receding at 0.1c → ratio ${r.toFixed(4)} = 0.9`);

sub('geometry');
// Perpendicular motion: source moving in +y while the listener sits on +x → no radial component.
r = _dopplerRatio({x:0,y:50,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},1);
assert(near(r, 1.0), 'perpendicular motion → ratio 1 (no radial velocity)');
// Same velocity both ends (riding together) → no relative motion.
r = _dopplerRatio({x:30,y:0,z:0},{x:30,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},1);
assert(near(r, 1.0), 'source+listener moving together → ratio 1');
// Coincident positions → degenerate direction → 1.
r = _dopplerRatio({x:50,y:0,z:0},{x:0,y:0,z:0},{x:5,y:5,z:5},{x:5,y:5,z:5},1);
assert(r === 1.0, 'coincident source/listener → ratio 1 (no blow-up)');
// 3D diagonal: approach along y/z too.
r = _dopplerRatio({x:0,y:0.1*C/Math.SQRT2,z:0.1*C/Math.SQRT2},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:0,y:10,z:10},1);
assert(near(r, 1/0.9), '3D diagonal approach uses full xyz radial projection');

sub('amount scaling + clamps');
r = _dopplerRatio({x:0.1*C,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},0);
assert(r === 1.0, 'amount 0 → ratio 1 (off)');
const full = 1/0.9 - 1;
r = _dopplerRatio({x:0.1*C,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},0.5);
assert(near(r, 1 + full*0.5), 'amount 0.5 → half the deviation from 1');
r = _dopplerRatio({x:0.1*C,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},2);
assert(near(r, 1 + full*2), 'amount 2 → doubled (stylized)');
// A teleport spike (velocity ≫ c) must cap at 0.9c then clamp to ≤ 4.
r = _dopplerRatio({x:100*C,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},1);
assert(r <= 4.0 && r > 1, `teleport spike capped → ratio ${r.toFixed(2)} ≤ 4`);
r = _dopplerRatio({x:-100*C,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:10,y:0,z:0},1);
assert(r >= 0.25 && r < 1, `reverse spike clamped → ratio ${r.toFixed(2)} ≥ 0.25`);

header('2. Config plumbing (defaults → event block → game override)');

assert(_SPATIAL_DEFAULTS.doppler === 0, '_SPATIAL_DEFAULTS.doppler = 0 (off, zero behaviour change)');
let cfg = _eventSpatialToCfg({enabled: true, mode: '3D', doppler: 1.5});
assert(cfg.doppler === 1.5, '_eventSpatialToCfg maps snake_case doppler → cfg.doppler');
cfg = _eventSpatialToCfg({enabled: true, mode: '3D'});
assert(cfg.doppler === undefined, 'absent doppler key → not written (never clobbers the default)');
let m = _mergeSpatialConfig(null, {doppler: 1.0});
assert(m.doppler === 1.0, 'event block sets doppler through the merge');
m = _mergeSpatialConfig({doppler: 2.0}, {doppler: 1.0});
assert(m.doppler === 2.0, 'game-passed cfg overrides the event value');
m = _mergeSpatialConfig(null, null);
assert(m.doppler === 0, 'no layers → doppler stays 0');

header('3. _updateSpatialVoices integration (stub engine + fake voices)');

function rateParam(v = 1) {
  return { value: v, _calls: [],
    setTargetAtTime(val, t, tc) { this._calls.push({val, t, tc}); this.value = val; } };
}
function mkVoice(mode, doppler, base = 1.0) {
  return {
    isPlaying: () => true, _cleanup(){},
    _emitter: null, _mode: mode,
    _pos: {x: 10, y: 0, z: 0},
    _cfg: _mergeSpatialConfig({mode, doppler}, null),
    _pannerNode: mode === '3D'
      ? {positionX: {value: 0}, positionY: {value: 0}, positionZ: {value: 0}}
      : {pan: {setValueAtTime(){}}},
    _distanceGain: mode === '2D' ? {gain: {setValueAtTime(){}}} : null,
    _source: {playbackRate: rateParam(base)},
    _basePlaybackRate: base,
    _dopPrev: null,
  };
}
function mkStub(voices) {
  let now = 0;
  const stub = {
    _listenerPos: {x: 0, y: 0, z: 0}, _worldScale: 1,
    _spatialVoices: voices, _listenerPrev: undefined,
    _now: () => now,
    _tick(t) { now = t; PFA.prototype._updateSpatialVoices.call(stub); },
  };
  return stub;
}

sub('moving source retunes playbackRate');
let v = mkVoice('3D', 1.0);
let st = mkStub([v]);
st._tick(0.0);
assert(v._source.playbackRate._calls.length === 0, 'first frame only seeds (no rate write)');
v._pos.x = 10 - 34.3 * 0.1; // 0.1c toward the listener over 0.1 s
st._tick(0.1);
let calls = v._source.playbackRate._calls;
assert(calls.length === 1 && near(calls[0].val, 1/0.9), `approach → setTargetAtTime(${calls[0] ? calls[0].val.toFixed(4) : '—'}) ≈ 1.1111`);
v._pos.x += 34.3 * 0.1;     // turn around: recede at 0.1c
st._tick(0.2);
assert(near(calls[1].val, 1/1.1), `recede → target ${calls[1].val.toFixed(4)} ≈ 0.9091`);

sub('listener-side motion (fixed source)');
v = mkVoice('3D', 1.0);
st = mkStub([v]);
st._tick(0.0);
st._listenerPos.x = 34.3 * 0.1; // listener steps toward the source
st._tick(0.1);
assert(near(v._source.playbackRate._calls[0].val, 1.1), 'listener approaching a static source → ratio 1.1');

sub('composition + opt-outs');
v = mkVoice('3D', 1.0, 1.5);   // randomized pitch base 1.5
st = mkStub([v]);
st._tick(0.0);
v._pos.x = 10 - 34.3 * 0.1;
st._tick(0.1);
assert(near(v._source.playbackRate._calls[0].val, 1.5 / 0.9), 'doppler multiplies ON TOP of the spawn-time rate (1.5 × 1.111)');
v = mkVoice('3D', 0);          // doppler off
const v2d = mkVoice('2D', 1.0); // 2D never dopplers
st = mkStub([v, v2d]);
st._tick(0.0);
v._pos.x = 5; v2d._pos.x = 5;
st._tick(0.1);
assert(v._source.playbackRate._calls.length === 0, 'doppler 0 → playbackRate untouched');
assert(v2d._source.playbackRate._calls.length === 0, '2D voice → playbackRate untouched (3D-only feature)');

sub('stale clock');
v = mkVoice('3D', 1.0);
st = mkStub([v]);
st._tick(0.0);
v._pos.x = 5;
st._tick(1.0); // dt 1.0 s > 0.5 cap (tab suspend) → skip, reseed
assert(v._source.playbackRate._calls.length === 0, 'dt > 0.5 s → doppler skipped (no spike after a stall)');
v._pos.x = 5 - 34.3 * 0.1;
st._tick(1.1); // clock healthy again
assert(v._source.playbackRate._calls.length === 1, 'next healthy frame resumes doppler');

console.log('\n' + '═'.repeat(70));
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed ? 1 : 0);
