#!/usr/bin/env node
/**
 * PFA Engine — per-trigger INTENSITY / velocity test suite.
 *
 * Intensity = per-trigger hit strength, like a MIDI note's velocity. The game
 * passes a normalized intensity 0..1 to trigger()/triggerSpatial(); the authored
 * event.intensity curve (config.json `intensity` block) maps it to a per-voice gain
 * multiplier + pitch-semitone offset, applied ON TOP of the random variation.
 *
 * Locks:
 *   1. _intensityShape — the four curve shapes (linear/exp/log/s_curve).
 *   2. _intensityToGainPitch — disabled/absent ⇒ neutral {1,0}; the reference table
 *      (shared with the Godot engine + the design doc); clamp to [0,1]; default 1.0.
 *   3. PFAEvent parses config.json `intensity` (null when absent).
 *   4. Integration: triggerSfx folds gainMult into the voice target + pitchSt into
 *      playbackRate, over the random variation.
 *
 * Reference (must match doc «Intensity (velocity) feature — design + curve
 * reference» AND the Godot test_intensity.gd):
 *   vol_db=[-18,0] exp  → v0 gain 0.125893, v0.5 0.211349, v1 1.0
 *   pitch_st=[-1,2] lin → v0 −1 st, v0.5 0.5 st, v1 2 st
 *
 * Loads the REAL src/index.js (not a port). Usage: node test-intensity.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack, _intensityShape, _intensityToGainPitch };';
  return new Function('window', src)(undefined);
}
const { PFAEvent, PFATrack, _intensityShape, _intensityToGainPitch } = loadEngine();

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function sub(t){console.log('\n  ─── '+t+' ───');}
function ok(m){passed++;console.log('    ✓ '+m);}
function fail(m){failed++;console.log('    ✗ FAIL: '+m);}
function assert(c,m){if(c)ok(m);else fail(m);}
function near(a,b,eps=1e-5){return Math.abs(a-b)<eps;}

// ═════════════════════════════════════════════════════════════════════
header('1. _intensityShape — curve shapes');
// ═════════════════════════════════════════════════════════════════════
sub('endpoints: every shape maps 0→0 and 1→1');
for (const c of ['linear','exponential','logarithmic','s_curve']) {
  assert(near(_intensityShape(c,0),0) && near(_intensityShape(c,1),1), `${c}: 0→0, 1→1`);
}
sub('midpoint t=0.5');
assert(near(_intensityShape('linear',0.5),0.5),      'linear(0.5)=0.5');
assert(near(_intensityShape('exponential',0.5),0.25),'exponential(0.5)=0.25 (t²)');
assert(near(_intensityShape('logarithmic',0.5),0.75),'logarithmic(0.5)=0.75 (2t−t²)');
assert(near(_intensityShape('s_curve',0.5),0.5),     's_curve(0.5)=0.5 (smoothstep)');
assert(near(_intensityShape('bogus',0.4),0.4),       'unknown curve falls back to linear');

// ═════════════════════════════════════════════════════════════════════
header('2. _intensityToGainPitch — mapping + reference table');
// ═════════════════════════════════════════════════════════════════════
sub('disabled / absent ⇒ neutral {gainMult:1, pitchSt:0}');
assert((r=>near(r.gainMult,1)&&near(r.pitchSt,0))(_intensityToGainPitch(0.3,null)), 'null cfg → neutral');
assert((r=>near(r.gainMult,1)&&near(r.pitchSt,0))(_intensityToGainPitch(0.3,{enabled:false,vol_db:[-18,0]})), 'enabled:false → neutral');

const VC = { enabled:true, vol_db:[-18,0], vol_curve:'exponential', pitch_st:[-1,2], pitch_curve:'linear' };
sub('reference values (shared with Godot + design doc)');
assert(near(_intensityToGainPitch(0.0,VC).gainMult, 0.125893), 'v=0 → gainMult 0.125893 (−18 dB)');
assert(near(_intensityToGainPitch(0.5,VC).gainMult, 0.211349), 'v=0.5 → gainMult 0.211349 (−13.5 dB)');
assert(near(_intensityToGainPitch(1.0,VC).gainMult, 1.0),      'v=1 → gainMult 1.0 (0 dB)');
assert(near(_intensityToGainPitch(0.0,VC).pitchSt, -1.0), 'v=0 → pitchSt −1 st');
assert(near(_intensityToGainPitch(0.5,VC).pitchSt,  0.5), 'v=0.5 → pitchSt 0.5 st');
assert(near(_intensityToGainPitch(1.0,VC).pitchSt,  2.0), 'v=1 → pitchSt 2 st');

sub('clamp + default');
assert(near(_intensityToGainPitch(-0.5,VC).gainMult, _intensityToGainPitch(0,VC).gainMult), 'intensity < 0 clamps to 0');
assert(near(_intensityToGainPitch(1.5,VC).gainMult,  _intensityToGainPitch(1,VC).gainMult), 'intensity > 1 clamps to 1');
assert(near(_intensityToGainPitch(undefined,VC).gainMult, 1.0), 'undefined intensity ⇒ 1.0 (full hit)');
assert(near(_intensityToGainPitch(null,VC).pitchSt, 2.0),        'null intensity ⇒ 1.0 (full hit)');

// ═════════════════════════════════════════════════════════════════════
header('3. PFAEvent parses config.json `intensity`');
// ═════════════════════════════════════════════════════════════════════
{
  const ev = new PFAEvent('hit', { type:'sfx', tracks:[], intensity:VC }, { ctx:{}, _now:()=>0 });
  assert(ev.intensity && ev.intensity.enabled === true, 'event.intensity parsed from config');
  const ev2 = new PFAEvent('plain', { type:'sfx', tracks:[] }, { ctx:{}, _now:()=>0 });
  assert(ev2.intensity === null, 'absent intensity ⇒ null (zero behaviour change)');
}

// ═════════════════════════════════════════════════════════════════════
header('4. Integration — triggerSfx folds intensity into gain + pitch');
// ═════════════════════════════════════════════════════════════════════
// Recording mocks: capture the per-voice gain target + source playbackRate.
function mkRecParam(){ const p={value:1,_last:1,
  setValueAtTime(v){p._last=v;}, linearRampToValueAtTime(v){p._last=v;},
  exponentialRampToValueAtTime(){}, cancelScheduledValues(){}}; return p; }
function mkRecGain(){ return { gain: mkRecParam(), connect(){}, disconnect(){} }; }
const created = { gains: [], sources: [] };
function mkRecSource(){ const s={ buffer:null, loop:false, loopStart:0, loopEnd:0,
  playbackRate:{value:1}, detune:{value:0}, connect(){}, start(){}, stop(){}, onended:null };
  created.sources.push(s); return s; }
function mkEngine(){ return { ctx:{
  createBufferSource: mkRecSource,
  createGain(){ const g=mkRecGain(); created.gains.push(g); return g; },
  currentTime:0 }, _now:()=>0 }; }

function makeTrack(){
  const t = new PFATrack({ name:'ball', level_behavior:'always_play', samples:['a'] }, mkEngine());
  t._sharedBuffers = [{ idx:0, duration:1 }];   // one variation, no randomization
  return t;
}

// Warm up so _ensureGain builds the cached _trackGain; then reset so the only NEW
// gain/source created by the measured trigger is the voice's.
function measure(track, iv){
  track.triggerSfx(0, mkRecGain());        // warm-up (builds _trackGain)
  created.gains.length = 0; created.sources.length = 0;
  track.triggerSfx(0, mkRecGain(), iv);
  const voiceGain = created.gains[created.gains.length - 1];
  const source = created.sources[created.sources.length - 1];
  return { target: voiceGain.gain._last, rate: source.playbackRate.value };
}

sub('neutral (no iv) leaves the voice unscaled');
{
  const m = measure(makeTrack(), null);
  assert(near(m.target, 1.0), 'no intensity → voice target 1.0');
  assert(near(m.rate, 1.0),   'no intensity → playbackRate 1.0');
}
sub('intensity scales gain (dB) + pitch (semitones)');
{
  const iv = _intensityToGainPitch(0.0, VC);   // softest hit
  const m = measure(makeTrack(), iv);
  assert(near(m.target, 0.125893), 'soft hit → voice target = gainMult 0.125893');
  assert(near(m.rate, Math.pow(2,-1/12)), 'soft hit → playbackRate = 2^(−1/12)');
}
{
  const iv = _intensityToGainPitch(1.0, VC);   // hardest hit
  const m = measure(makeTrack(), iv);
  assert(near(m.target, 1.0), 'hard hit → voice target 1.0 (0 dB)');
  assert(near(m.rate, Math.pow(2,2/12)), 'hard hit → playbackRate = 2^(2/12)');
}

console.log('\n'+'─'.repeat(70));
console.log(`  Intensity: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
