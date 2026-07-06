#!/usr/bin/env node
/**
 * PFA Engine — spatial DISTANCE LPF (3D air absorption, Godot-parity highshelf).
 *
 * Godot's AudioStreamPlayer3D always runs an "attenuation filter": a highshelf
 * at attenuation_filter_cutoff_hz whose gain deepens from 0 dB toward
 * attenuation_filter_db as the distance multiplier falls —
 *   db = (1 − min(1, att)) × lpfDb            (audio_stream_player_3d.cpp)
 * The web engine now mirrors it per voice (BiquadFilterNode 'highshelf'
 * between voiceGain and the panner, retargeted each _updateSpatialVoices
 * frame), driven by SHARED flat editor keys lpf_enabled / lpf_cutoff_hz /
 * lpf_db. ON by default with Godot's node defaults (5000 Hz / −24 dB).
 *
 * Locks:
 *   1. _distanceLpfDb math: open at/inside min_distance, half-depth at
 *      att 0.5, full lpfDb at/past max_distance.
 *   2. Config plumbing: _SPATIAL_DEFAULTS ON, _eventSpatialToCfg snake_case
 *      mapping (including false), merge precedence (game cfg wins).
 *   3. _spawnSpatialVoice wiring: 3D ⇒ highshelf voiceGain→lpf→panner→event
 *      gain seeded from the spawn distance; OFF/2D/db=0/no-createBiquadFilter
 *      ⇒ no filter node, direct voiceGain→panner.
 *   4. _updateSpatialVoices integration: live distance retargets the shelf
 *      gain (50 ms smoothing); voices without a filter stay untouched.
 *
 * Loads the REAL src/index.js (not a port).
 * Usage: node test-spatial-lpf.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, _mergeSpatialConfig, _eventSpatialToCfg,'
       + ' _SPATIAL_DEFAULTS, _computeDistanceAttenuation, _distanceLpfDb };';
  return new Function('window', src)(undefined);
}
const { PFA, _mergeSpatialConfig, _eventSpatialToCfg, _SPATIAL_DEFAULTS,
        _computeDistanceAttenuation, _distanceLpfDb } = loadEngine();

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function sub(t){console.log('\n  ─── '+t+' ───');}
function ok(m){passed++;console.log('    ✓ '+m);}
function fail(m){failed++;console.log('    ✗ FAIL: '+m);}
function assert(c,m){if(c)ok(m);else fail(m);}
function near(a,b,eps=1e-3){return Math.abs(a-b)<eps;}

const ATT = { model: 'inverse', minDistance: 1.0, maxDistance: 50.0, rolloff: 1.0 };

header('1. _distanceLpfDb math (Godot: db = (1 − min(1, att)) × lpfDb)');

assert(_distanceLpfDb(1.0, -24) === 0, 'att 1 (at/inside min_distance) → 0 dB, filter fully open');
assert(_distanceLpfDb(1.5, -24) === 0, 'att > 1 clamps to 1 → still 0 dB (no positive shelf gain)');
assert(_distanceLpfDb(0.0, -24) === -24, 'att 0 (at/past max_distance) → full lpfDb');
assert(near(_distanceLpfDb(0.5, -24), -12), 'att 0.5 → half depth (−12 dB)');
assert(near(_distanceLpfDb(0.5, -60), -30), 'depth scales with lpfDb (−60 → −30 at half)');
assert(_distanceLpfDb(0.25, 0) === 0, 'lpfDb 0 → always 0 dB (a mathematical no-op)');

sub('folded with the inverse distance curve (min 1, max 50, rolloff 1)');
let att = _computeDistanceAttenuation(1.0, ATT);
assert(_distanceLpfDb(att, -24) === 0, 'dist = min_distance → open (0 dB)');
att = _computeDistanceAttenuation(10.0, ATT);
assert(near(_distanceLpfDb(att, -24), -21.6), `dist 10 → att 0.1 → −21.6 dB (got ${_distanceLpfDb(att, -24).toFixed(2)})`);
att = _computeDistanceAttenuation(50.0, ATT);
assert(near(_distanceLpfDb(att, -24), -24), 'dist = max_distance → fully closed (−24 dB)');

header('2. Config plumbing');

sub('defaults');
assert(_SPATIAL_DEFAULTS.lpfEnabled === true, '_SPATIAL_DEFAULTS.lpfEnabled = true (Godot has always filtered)');
assert(_SPATIAL_DEFAULTS.lpfCutoffHz === 5000, '_SPATIAL_DEFAULTS.lpfCutoffHz = 5000 (Godot node default)');
assert(_SPATIAL_DEFAULTS.lpfDb === -24, '_SPATIAL_DEFAULTS.lpfDb = −24 (Godot node default)');

sub('_eventSpatialToCfg snake_case mapping');
let cfg = _eventSpatialToCfg({ enabled: true, lpf_enabled: false, lpf_cutoff_hz: 2500, lpf_db: -12 });
assert(cfg.lpfEnabled === false, 'lpf_enabled FALSE maps through (not swallowed by a truthiness check)');
assert(cfg.lpfCutoffHz === 2500 && cfg.lpfDb === -12, 'lpf_cutoff_hz / lpf_db map to camelCase');
cfg = _eventSpatialToCfg({ enabled: true, mode: '3D' });
assert(cfg.lpfEnabled === undefined, 'absent keys are NOT written (defaults stay in charge)');

sub('merge precedence (defaults ← event ← game)');
let merged = _mergeSpatialConfig(null, null);
assert(merged.lpfEnabled === true && merged.lpfCutoffHz === 5000 && merged.lpfDb === -24,
  'no event/game config → ON with Godot defaults');
merged = _mergeSpatialConfig(null, _eventSpatialToCfg({ enabled: true, lpf_cutoff_hz: 2500 }));
assert(merged.lpfCutoffHz === 2500 && merged.lpfEnabled === true && merged.lpfDb === -24,
  'event overrides cutoff only — enabled/db keep defaults');
merged = _mergeSpatialConfig({ lpfCutoffHz: 1200 }, _eventSpatialToCfg({ enabled: true, lpf_cutoff_hz: 2500 }));
assert(merged.lpfCutoffHz === 1200, 'game-passed config wins over the event');
merged = _mergeSpatialConfig({ lpfEnabled: false }, _eventSpatialToCfg({ enabled: true, lpf_db: -30 }));
assert(merged.lpfEnabled === false && merged.lpfDb === -30, 'game can switch the filter off');

header('3. _spawnSpatialVoice wiring');

function nodeStub(extra = {}) {
  return Object.assign({ _connectedTo: null,
    connect(t){ this._connectedTo = t; }, disconnect(){} }, extra);
}
function mkSpawnStub({ noBiquad = false } = {}) {
  const stub = {
    _listenerPos: { x: 0, y: 0, z: 0 }, _worldScale: 1,
    _nextSpatialId: 1, _spatialVoices: [],
    _now: () => 0,
    _scheduleSmartReloop() {},
    ctx: {
      createPanner: () => nodeStub({
        panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0,
        rolloffFactor: 0, positionX: { value: 0 }, positionY: { value: 0 },
        positionZ: { value: 0 },
      }),
      createStereoPanner: () => nodeStub({ pan: { setValueAtTime() {} } }),
      createGain: () => nodeStub({ gain: { setValueAtTime() {} } }),
    },
  };
  if (!noBiquad) {
    stub.ctx.createBiquadFilter = () => {
      const n = nodeStub({ type: '', frequency: { value: 0 }, gain: { value: 0 } });
      stub._lastBiquad = n; stub._biquads = (stub._biquads || 0) + 1;
      return n;
    };
  }
  return stub;
}
function mkTrack() {
  return {
    _sources: [],
    triggerSfxSpatial: () => ({
      source: { playbackRate: { value: 1 }, stop() {} },
      voiceGain: nodeStub({ gain: { value: 1, setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {} } }),
      track: { _sources: [] }, loopMode: null, clipLen: 0, target: 1,
    }),
  };
}
function mkEvent() {
  return { currentLevel: 0, _eventGain: nodeStub(), _activeVoices: [], releaseFade: null };
}
function spawn(stub, cfgPatch = {}, pos = { x: 10, y: 0, z: 0 }, is3D = true) {
  const cfg = _mergeSpatialConfig(cfgPatch, null);
  cfg.mode = is3D ? '3D' : '2D';
  const track = mkTrack();
  return PFA.prototype._spawnSpatialVoice.call(stub, mkEvent(), track, pos, cfg, is3D, 0, null);
}

sub('3D with defaults → highshelf in the chain');
let st = mkSpawnStub();
let v = spawn(st, {});
assert(st._biquads === 1, 'one BiquadFilterNode created');
assert(st._lastBiquad.type === 'highshelf', "type = 'highshelf' (Godot mixes its filter as a highshelf)");
assert(st._lastBiquad.frequency.value === 5000, 'frequency = lpfCutoffHz (5000)');
assert(near(st._lastBiquad.gain.value, -21.6), `gain seeded from spawn distance 10 → −21.6 dB (got ${st._lastBiquad.gain.value.toFixed(2)})`);
assert(v._voiceGain._connectedTo === st._lastBiquad, 'voiceGain → lpf');
assert(st._lastBiquad._connectedTo === v._pannerNode, 'lpf → panner');
assert(v._lpf === st._lastBiquad, 'voice._lpf holds the filter for the per-frame loop');

sub('opt-outs → NO filter node, direct voiceGain → panner');
st = mkSpawnStub();
v = spawn(st, { lpfEnabled: false });
assert(!st._biquads && v._lpf === null && v._voiceGain._connectedTo === v._pannerNode,
  'lpfEnabled false → no node, direct chain');
st = mkSpawnStub();
v = spawn(st, { lpfDb: 0 });
assert(!st._biquads && v._lpf === null, 'lpfDb 0 → no node (mathematical no-op shortcut)');
st = mkSpawnStub();
v = spawn(st, {}, { x: 10, y: 0, z: 0 }, false);
assert(!st._biquads && v._lpf === null, '2D voice → no filter (Godot 2D has no attenuation filter)');
st = mkSpawnStub({ noBiquad: true });
v = spawn(st, {});
assert(v._lpf === null && v._voiceGain._connectedTo === v._pannerNode,
  'ctx without createBiquadFilter → graceful no-filter (stub/legacy contexts)');

header('4. _updateSpatialVoices integration');

function gainParam(v0 = 0) {
  return { value: v0, _calls: [],
    setTargetAtTime(val, t, tc) { this._calls.push({ val, t, tc }); } };
}
function mkVoice(mode, cfgPatch = {}, pos = { x: 10, y: 0, z: 0 }, withLpf = true) {
  const cfg = _mergeSpatialConfig(cfgPatch, null);
  cfg.mode = mode;
  return {
    isPlaying: () => true, _emitter: null, _mode: mode, _cfg: cfg,
    _pos: { x: pos.x, y: pos.y, z: pos.z || 0 },
    _pannerNode: mode === '3D'
      ? { positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } }
      : { pan: { setValueAtTime() {} } },
    _distanceGain: mode === '2D' ? { gain: { setValueAtTime() {} } } : null,
    _source: { playbackRate: { value: 1 } },
    _basePlaybackRate: 1, _dopPrev: null,
    _lpf: (mode === '3D' && withLpf) ? { gain: gainParam(0), frequency: { value: 5000 } } : null,
  };
}
function mkStub(voices) {
  let now = 0;
  const stub = {
    _listenerPos: { x: 0, y: 0, z: 0 }, _worldScale: 1,
    _spatialVoices: voices, _listenerPrev: undefined,
    _now: () => now,
    _tick(t) { now = t; PFA.prototype._updateSpatialVoices.call(stub); },
  };
  return stub;
}

sub('live distance drives the shelf gain');
v = mkVoice('3D');
st = mkStub([v]);
st._tick(0);
let calls = v._lpf.gain._calls;
assert(calls.length === 1 && near(calls[0].val, -21.6),
  `dist 10 → setTargetAtTime(−21.6) (got ${calls[0] ? calls[0].val.toFixed(2) : '—'})`);
assert(near(calls[0].tc, 0.05), '50 ms smoothing time-constant (doppler pattern)');
v._pos.x = 1.0;   // walk in to min_distance
st._tick(0.1);
assert(near(calls[1].val, 0), 'dist = min_distance → retargets to 0 dB (open)');
v._pos.x = 80;    // beyond max_distance
st._tick(0.2);
assert(near(calls[2].val, -24), 'dist past max_distance → retargets to full −24 dB');

sub('listener motion closes the filter too');
v = mkVoice('3D', {}, { x: 5, y: 0, z: 0 });
st = mkStub([v]);
st._tick(0);
const d0 = _distanceLpfDb(_computeDistanceAttenuation(5, ATT), -24);
assert(near(v._lpf.gain._calls[0].val, d0), `listener at 0 / source at 5 → ${d0.toFixed(2)} dB`);
st._listenerPos.x = -45; // now 50 away
st._tick(0.1);
assert(near(v._lpf.gain._calls[1].val, -24), 'listener walks away to max_distance → −24 dB');

sub('voices without a filter stay untouched');
v = mkVoice('3D', {}, { x: 10, y: 0, z: 0 }, false); // off → _lpf null
const v2d = mkVoice('2D');
st = mkStub([v, v2d]);
st._tick(0);
st._tick(0.1);
ok('no-filter 3D + 2D voices update without errors (nothing to retarget)');

sub('custom depth');
v = mkVoice('3D', { lpfDb: -60 });
v._cfg.lpfDb = -60;
st = mkStub([v]);
st._tick(0);
assert(near(v._lpf.gain._calls[0].val, -54), 'lpfDb −60 at dist 10 → −54 dB (depth scales)');

console.log('\n' + '═'.repeat(70));
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed ? 1 : 0);
