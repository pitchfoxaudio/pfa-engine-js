#!/usr/bin/env node
/**
 * PFA Engine — a spatial voice's RELEASE FADE must not be pruned mid-ramp (regression).
 *
 * Bug (latent until the 3D bomb-throw scene's `bomb_flight` used emitter.destroy()
 * with an authored release_fade): PFASpatialVoice.stop() scheduled the gain ramp but
 * set `this._playing = false` SYNCHRONOUSLY. `_updateSpatialVoices` prunes any voice
 * whose isPlaying() is false on the NEXT frame, calling `_cleanup()` (which
 * DISCONNECTS its nodes) — so the release-fade ramp was cut to silence within ~1
 * frame (a 2s and a 4s release sounded identical = an instant anti-click cut).
 *
 * Fix: keep `_playing = true` through the ramp (+ a `_stopping` re-entry guard); mark
 * finished only when the post-ramp timeout fires. P8: there is no instant branch left —
 * every stop is floored to SPATIAL_STOP_FLOOR_MS (a bare source.stop() on a loop cut
 * mid-wave is the ball_roll click), so a releaseMs-0 stop rides the same keep-alive ramp.
 *
 * Loads the REAL src/index.js (not a port). Usage: node test-spatial-release-prune.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFASpatialVoice };';
  return new Function('window', src)(undefined);
}
const { PFA, PFASpatialVoice } = loadEngine();

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function sub(t){console.log('\n  ─── '+t+' ───');}
function ok(m){passed++;console.log('    ✓ '+m);}
function fail(m){failed++;console.log('    ✗ FAIL: '+m);}
function assert(c,m){if(c)ok(m);else fail(m);}

function recParam(v=1){
  return { value:v, _e:[],
    setValueAtTime(val,t){this._e.push({val,t,kind:'set'});this.value=val;},
    linearRampToValueAtTime(val,t){this._e.push({val,t,kind:'lin'});this.value=val;},
    cancelScheduledValues(){},
  };
}
// A 2D spatial voice with just-enough mock nodes for both stop() and the
// _updateSpatialVoices 2D branch (distance gain + pan) + _cleanup (disconnect).
function mkVoice(releaseMs){
  const voiceGain    = { gain: recParam(1), context:{ currentTime:0 }, connect(){}, disconnect(){} };
  const distanceGain = { gain: recParam(1), disconnect(){} };
  const pannerNode   = { pan:  recParam(0), disconnect(){} };
  let stopped = 0;
  const source = { onended:null, stop(){ stopped++; } };
  const cfg = { attenuation:{ minDistance:0.5, maxDistance:50, model:'inverse', rolloff:1 }, maxPan:1 };
  const v = new PFASpatialVoice(1, source, pannerNode, distanceGain, voiceGain,
    null, '2D', { x:2, y:0, z:0 }, cfg, null, releaseMs);
  return { v, voiceGain, distanceGain, getStopped:()=>stopped };
}
function mkEngine(voices){
  return { _listenerPos:{x:0,y:0,z:0}, _worldScale:1, _now:()=>0, _spatialVoices:voices.slice() };
}
function frame(engine){ PFA.prototype._updateSpatialVoices.call(engine); }

// ── 1. A fade-stop is NOT pruned mid-ramp (the bug) ──────────────────
header('1. release fade survives _updateSpatialVoices (the bug)');
{
  const realST = setTimeout, realCT = clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => {};
  try {
    const { v, voiceGain, getStopped } = mkVoice(2000);   // 2s authored release
    const engine = mkEngine([v]);

    v.stop();                                              // no arg → use the 2s release
    sub('stop() schedules the ramp but the voice stays "playing"');
    assert(v.isPlaying() === true, 'still playing right after a fade-stop (was FALSE pre-fix → got pruned)');
    const ramp = voiceGain.gain._e.find(e => e.kind === 'lin' && e.val === 0);
    assert(!!ramp && Math.abs(ramp.t - 2.005) < 1e-6, '2s ramp to 0 scheduled (ends ~2.005s)');
    assert(timers.length === 1 && Math.abs(timers[0].ms - 2010) < 1, 'source.stop deferred to ramp end (~2010ms)');

    sub('a frame mid-fade does NOT prune or disconnect the voice');
    frame(engine);
    assert(engine._spatialVoices.includes(v), 'voice survives the frame during the fade (THE FIX)');
    assert(v.isPlaying() === true, 'still playing one frame in');
    frame(engine);
    assert(engine._spatialVoices.includes(v), 'still tracked several frames in');

    sub('after the ramp elapses: source stops, voice ends, next frame prunes it');
    timers[0].fn();                                        // fire the post-ramp timeout
    assert(v.isPlaying() === false, 'voice marked finished once the ramp elapsed');
    assert(getStopped() === 1, 'underlying source stopped at ramp end (not before)');
    frame(engine);
    assert(!engine._spatialVoices.includes(v), 'voice pruned only AFTER the fade (clean teardown)');
  } finally {
    global.setTimeout = realST; global.clearTimeout = realCT;
  }
}

// ── 2. releaseMs 0 → floored anti-click micro-ramp (P8, no hard cut) ──
header('2. releaseMs-0 stop rides the floored micro-ramp (no instant cut)');
{
  const realST = setTimeout, realCT = clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => {};
  try {
    const { v, voiceGain, getStopped } = mkVoice(0);       // no release authored
    const engine = mkEngine([v]);
    v.stop();                                              // → 20ms anti-click floor
    assert(v.isPlaying() === true, 'voice survives the stop call (ramp owns it — was a hard cut pre-P8)');
    const ramp = voiceGain.gain._e.find(e => e.kind === 'lin' && e.val === 0);
    assert(!!ramp && Math.abs(ramp.t - 0.025) < 1e-6, '20ms floor ramp scheduled (ends ~0.025s)');
    assert(getStopped() === 0, 'source.stop deferred to ramp end (no mid-wave cut)');
    frame(engine);
    assert(engine._spatialVoices.includes(v), 'not pruned during the micro-ramp');
    timers[0].fn();                                        // ramp elapsed
    assert(v.isPlaying() === false && getStopped() === 1, 'stopped cleanly after the floor ramp');
    frame(engine);
    assert(!engine._spatialVoices.includes(v), 'pruned after the ramp (clean teardown)');
  } finally {
    global.setTimeout = realST; global.clearTimeout = realCT;
  }
}

// ── 3. _stopping guard — a 2nd stop during the fade is a no-op ───────
header('3. re-entry guard: a second stop mid-fade does not re-ramp');
{
  const realST = setTimeout, realCT = clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => {};
  try {
    const { v, voiceGain } = mkVoice(2000);
    v.stop();
    const rampsAfter1 = voiceGain.gain._e.filter(e => e.kind === 'lin').length;
    const timersAfter1 = timers.length;
    v.stop();                                              // second call mid-fade
    assert(voiceGain.gain._e.filter(e => e.kind === 'lin').length === rampsAfter1,
      'no extra ramp scheduled by a 2nd stop (guarded)');
    assert(timers.length === timersAfter1, 'no extra deferred source.stop scheduled');
  } finally {
    global.setTimeout = realST; global.clearTimeout = realCT;
  }
}

// ── summary ──────────────────────────────────────────────────────────
console.log('\n'+'═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed ? 1 : 0);
