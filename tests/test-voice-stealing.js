#!/usr/bin/env node
/**
 * PFA Engine — voice stealing by AUDIBILITY (JS phase of the sess122 contract).
 *
 * Canon: godot/test_voice_stealing.gd header + engine commit 1080201. The defect
 * (FV-08 prep): at max_instances the engine evicted the OLDEST voice
 * (_activeVoices.shift()) regardless of loudness — a full-strength break shot
 * (intensity 1.0) lived 0.032 s of 0.536 s because weak follow-up collisions
 * stole it. Industry (FMOD/Wwise) steals by priority+audibility; age is only a
 * tie-break.
 *
 * Contract locked here (user-approved 07.08, no new authored knobs):
 *   1. Steal the LEAST AUDIBLE voice: score = pre_amp × distance_factor
 *      (pre_amp = track × clip × rand × intensity; flat voices' factor = 1.0;
 *       spatial voices shaded by _computeDistanceAttenuation at the listener —
 *       the SAME curve the web path plays, so ranking = audibility).
 *   2. Honest rejection: a candidate strictly quieter than every would-be victim
 *      does NOT start (it would be inaudible anyway — and must not kill anything).
 *   3. Equal scores → oldest dies (byte-parity with the old behavior in
 *      homogeneous scenes: footsteps etc. hear no change).
 *   4. A rejected trigger does NOT stamp the cooldown clock; a FRESH event with a
 *      long cooldown fires immediately (_lastTriggerTime init −Infinity, not 0).
 *   5. ONE cap per event: flat (trigger) + spatial (triggerSpatial/emitter) voices
 *      count together in _activeVoices — and the score ranks ACROSS both kinds.
 *   6. Flat steals are click-free: release() ramps voiceGain to 0 over the
 *      anti-click seam and lets the source stop itself — never a bare
 *      source.stop() cut. The voice leaves the pool at once (isActive false).
 *   7. A voice already releasing is not counted and not re-stolen.
 *   8. JS-specific (multitrack): a trigger spawns ONE VOICE PER TRACK — the gate
 *      steals down to the SPAWN SIZE (live + spawn − cap victims), so the cap
 *      holds for multi-track events too (the old code stole exactly 1 per
 *      trigger → the pool grew net +N−1 per trigger, unbounded in bursts).
 *      Rejection generalizes: candidate quieter than the LOUDEST would-be victim
 *      ⇒ reject (never kill a voice that outranks the newcomer).
 *
 * Loads the REAL src/index.js (not a port).
 * Usage: node test-voice-stealing.js
 */

const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack, PFASpatialVoice, _computeDistanceAttenuation };';
  return new Function('window', src)(undefined);
}
const { PFA, PFAEvent, PFATrack, PFASpatialVoice, _computeDistanceAttenuation } = loadEngine();

let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }
function near(a, b, eps = 1e-4) { return Math.abs(a - b) < eps; }

// ─────────────────────────────────────────────────────────────────────
// Mock Web Audio — house convention (params carry .value + an event log).
// ─────────────────────────────────────────────────────────────────────
function mkParam(v = 1) {
  return {
    value: v, _e: [],
    setValueAtTime(val, t) { this._e.push({ kind: 'set', val, t }); this.value = val; },
    linearRampToValueAtTime(val, t) { this._e.push({ kind: 'lin', val, t }); this.value = val; },
    exponentialRampToValueAtTime(val, t) { this._e.push({ kind: 'exp', val, t }); this.value = val; },
    cancelScheduledValues(t) { this._e.push({ kind: 'cancel', t }); },
    setTargetAtTime(val, t, tc) { this._e.push({ kind: 'target', val, t, tc }); this.value = val; },
  };
}
function mkGain() {
  return { gain: mkParam(1), context: { currentTime: 0 }, connect() {}, disconnect() {} };
}
function mkSource() {
  return {
    buffer: null, loop: false, loopStart: 0, loopEnd: 0,
    playbackRate: { value: 1 }, detune: { value: 0 },
    started: false, stopped: false,
    connect() {}, start() { this.started = true; },
    stop() { this.stopped = true; }, onended: null,
  };
}

/** Engine stub: real PFA prototype methods over a mock Web Audio surface.
 *  Copying the whole prototype keeps the stub honest as the engine grows. */
function mkEngine() {
  const eng = {
    _now: () => 0,
    _worldScale: 1,
    _listenerPos: { x: 0, y: 0, z: 0 },
    _listenerMode: '2D',
    _spatialVoices: [], _emitters: [], _nextSpatialId: 1,
    _events: {},
    _getEvent(n) { return this._events[n] || null; },
    ctx: {
      get currentTime() { return 0; },
      _gains: [], _sources: [],
      createGain() { const g = mkGain(); this._gains.push(g); return g; },
      createBufferSource() { const s = mkSource(); this._sources.push(s); return s; },
      createStereoPanner: () => ({ pan: mkParam(0), connect() {}, disconnect() {} }),
      createPanner: () => ({
        panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0,
        rolloffFactor: 0, positionX: { value: 0 }, positionY: { value: 0 },
        positionZ: { value: 0 }, connect() {}, disconnect() {},
      }),
    },
  };
  for (const k of Object.getOwnPropertyNames(PFA.prototype)) {
    if (k !== 'constructor' && typeof PFA.prototype[k] === 'function' && !eng[k]) {
      eng[k] = PFA.prototype[k];
    }
  }
  return eng;
}

// Intensity curve −40..0 dB linear → intensity 1.0 = gain 1.0, 0.05 ≈ 0.0126.
const INTENSITY_CFG = {
  enabled: true, vol_db: [-40, 0], vol_curve: 'linear',
  pitch_st: [0, 0], pitch_curve: 'linear',
};
const SP = {
  enabled: true, mode: '2D', model: 'inverse',
  min_distance: 1.0, max_distance: 50.0, rolloff: 1.0,
  panning_model: 'equalpower', max_pan: 1.0,
};

function mkTrackData(name = 't0', volume = 1.0) {
  // Deterministic randomization surface: no randomization block ⇒ neutral rolls
  // (volume 1.0, delay 0), chance 100 ⇒ always plays.
  return {
    name, volume, level_behavior: 'level_specific',
    levels: { 0: { samples: [name + '.wav'], switch_chance: 100, play_chance: 100 } },
  };
}

/** Real PFAEvent + real PFATracks over fake buffers (variation-test pattern). */
function mkEvent(eng, name, { cap = 3, cooldown = 0, tracks = 1, trackVolumes = null, spatial = SP } = {}) {
  const data = {
    type: 'sfx', volume: 1.0, max_instances: cap, cooldown_ms: cooldown,
    intensity: INTENSITY_CFG,
    tracks: Array.from({ length: tracks }, (_, i) =>
      mkTrackData('t' + i, trackVolumes ? trackVolumes[i] : 1.0)),
  };
  if (spatial) data.spatial = spatial;
  const ev = new PFAEvent(name, data, eng);
  for (const t of ev.tracks) t._buffers[0] = [{ duration: 0.5 }];
  ev.buffersLoaded = true;
  ev.loadBuffers = async () => {};
  ev._ensureGain = () => {};
  ev._eventGain = mkGain();
  ev._eventGainTarget = () => 1.0;
  eng._events[name] = ev;
  return ev;
}

function liveCount(ev) {
  return ev._activeVoices.filter(v => v.isActive()).length;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {

// ═════════════════════════════════════════════════════════════════════
header('1. Spatial cap: the QUIETEST voice is stolen — the loud break shot survives');
// ═════════════════════════════════════════════════════════════════════
{
  const eng = mkEngine();
  mkEvent(eng, 'ball_hit', { cap: 3 });
  // Age order: loud (the break shot) first, then medium, then quiet.
  const loud = await eng.triggerSpatial('ball_hit', 0, 0, { intensity: 1.0 });
  const mid = await eng.triggerSpatial('ball_hit', 0, 0, { intensity: 0.5 });
  const quiet = await eng.triggerSpatial('ball_hit', 0, 0, { intensity: 0.15 });
  assert(loud && mid && quiet, 'three voices up (cap 3)');
  // 4th trigger, louder than the quietest live voice → must steal `quiet`.
  const next = await eng.triggerSpatial('ball_hit', 0, 0, { intensity: 0.4 });
  assert(next !== null, 'audible candidate spawns');
  assert(quiet._stopping === true, 'QUIETEST voice was released');
  assert(!loud._stopping,
    'the OLDEST (loudest) voice survives — this is the sess121 defect pin');
  assert(!mid._stopping, 'mid voice untouched');
}

// ═════════════════════════════════════════════════════════════════════
header('2. Honest rejection — inaudible candidate does not start, kills nothing');
// ═════════════════════════════════════════════════════════════════════
{
  const eng = mkEngine();
  const ev = mkEvent(eng, 'hits', { cap: 3 });
  const a = await eng.triggerSpatial('hits', 0, 0, { intensity: 1.0 });
  const b = await eng.triggerSpatial('hits', 0, 0, { intensity: 0.8 });
  const c = await eng.triggerSpatial('hits', 0, 0, { intensity: 0.6 });
  const reject = await eng.triggerSpatial('hits', 0, 0, { intensity: 0.05 });
  assert(reject === null, 'inaudible candidate rejected (no voice spawned)');
  for (const v of [a, b, c]) {
    assert(v && !v._stopping, 'live voice untouched by the rejected trigger');
  }
  assert(liveCount(ev) === 3, `pool still holds exactly 3 live voices (got ${liveCount(ev)})`);
}

// ═════════════════════════════════════════════════════════════════════
header('3. Equal scores → the OLDEST dies (homogeneous scenes keep today\'s behavior)');
// ═════════════════════════════════════════════════════════════════════
{
  const eng = mkEngine();
  mkEvent(eng, 'steps', { cap: 2 });
  const first = await eng.triggerSpatial('steps', 0, 0, { intensity: 0.5 });
  const second = await eng.triggerSpatial('steps', 0, 0, { intensity: 0.5 });
  const third = await eng.triggerSpatial('steps', 0, 0, { intensity: 0.5 });
  assert(third !== null, 'equal-score candidate is NOT rejected (not strictly quieter)');
  assert(first._stopping === true, 'oldest of the equals released');
  assert(!second._stopping, 'younger equal survives');
}

// ═════════════════════════════════════════════════════════════════════
header('4. Rejection leaves the cooldown clock alone · fresh event fires');
// ═════════════════════════════════════════════════════════════════════
{
  sub('a FRESH event with a long cooldown fires immediately (init −Infinity, not 0)');
  const eng = mkEngine();
  const ev = mkEvent(eng, 'cool', { cap: 1, cooldown: 1e9 });
  // _lastTriggerTime = 0 would block this for the process's first cooldown_ms
  // (performance.now() − 0 < 1e9) — the Godot-phase latent fix, JS parity.
  const played = ev.trigger(1.0);
  assert(played.length === 1, 'first voice up (fresh event fires despite a long cooldown)');

  sub('a rejected trigger is a non-event: no cooldown stamp, nothing dies');
  const backdated = performance.now() - 2e9;   // cooldown window open
  ev._lastTriggerTime = backdated;
  const reject = ev.trigger(0.05);
  assert(reject.length === 0, 'quiet candidate rejected against the loud voice');
  assert(ev._lastTriggerTime === backdated,
    'the reject did NOT stamp the cooldown clock');
  const retry = ev.trigger(1.0);
  assert(retry.length === 1,
    'equal-loudness retry passes — the reject did NOT stamp the cooldown clock');
}

// ═════════════════════════════════════════════════════════════════════
header('5. Flat trigger: quietest voice stolen (score wrapper), not oldest');
// ═════════════════════════════════════════════════════════════════════
{
  const eng = mkEngine();
  const ev = mkEvent(eng, 'flat', { cap: 2, spatial: null });
  ev.trigger(1.0);
  const loudV = ev._activeVoices[ev._activeVoices.length - 1];
  ev.trigger(0.2);
  const quietV = ev._activeVoices[ev._activeVoices.length - 1];
  assert(loudV && quietV && loudV !== quietV, 'two flat voices up');
  assert(typeof loudV.score === 'function' && typeof quietV.score === 'function',
    'flat voice wrappers carry a score() (pre-amp meta)');
  if (typeof loudV.score === 'function' && typeof quietV.score === 'function') {
    assert(loudV.score() > quietV.score(), 'flat scores rank loud > quiet');
  }
  ev.trigger(0.6);
  assert(!quietV.isActive(), 'QUIET flat voice left the pool');
  assert(loudV.isActive(), 'loud old flat voice survives');
}

// ═════════════════════════════════════════════════════════════════════
header('6. Flat steal = silence-release (click-free), not a bare source.stop()');
// ═════════════════════════════════════════════════════════════════════
{
  const eng = mkEngine();
  const ev = mkEvent(eng, 'seam', { cap: 1, spatial: null });
  ev.trigger(0.3);
  // ctx._gains: [trackGain, victimVoiceGain] — triggerSfx creates the shared
  // track gain first, then the per-voice gain.
  const victimGain = eng.ctx._gains[1];
  const victimSource = eng.ctx._sources[0];
  assert(victimSource && victimSource.started, 'victim voice playing');
  ev.trigger(1.0);
  assert(victimSource.stopped === false,
    'stolen flat voice is NOT hard-stopped in the steal frame (no click)');
  const ramp = victimGain.gain._e.filter(e => e.kind === 'lin' && e.val === 0);
  assert(ramp.length > 0, 'victim voiceGain ramps to 0 (silence-release seam)');
  const victimW = ev._activeVoices.find(v => !v.isActive());
  assert(victimW !== undefined, 'stolen voice left the pool at once (isActive false)');
  await wait(50);
  assert(victimSource.stopped === true,
    'victim source stopped by its own lifecycle after the seam');
}

// ═════════════════════════════════════════════════════════════════════
header('7. ONE pool: flat + spatial rank together — score wins across kinds');
// ═════════════════════════════════════════════════════════════════════
{
  const eng = mkEngine();
  const ev = mkEvent(eng, 'mixed', { cap: 2 });
  // Spatial LOUD voice first (it is the OLDEST — the old code would shift() it).
  const spatialLoud = await eng.triggerSpatial('mixed', 0, 0, { intensity: 1.0 });
  assert(spatialLoud !== null, 'spatial voice up');
  // Flat QUIET voice second — pool now 2/2 (1 spatial + 1 flat).
  const flatPlayed = ev.trigger(0.2);
  assert(flatPlayed.length === 1, 'flat voice up on a spatial-enabled event');
  const flatW = ev._activeVoices[ev._activeVoices.length - 1];
  // Third trigger (mid loudness) must steal the quiet FLAT voice — the YOUNGER
  // one — because the pool ranks by audibility, not age, across both kinds.
  const third = await eng.triggerSpatial('mixed', 0, 0, { intensity: 0.5 });
  assert(third !== null, 'mid candidate spawns');
  assert(!flatW.isActive(), 'the quiet FLAT voice was the victim across pools');
  assert(!spatialLoud._stopping, 'loud spatial voice survives (older but louder)');
  assert(liveCount(ev) <= 2, `unified live count ≤ cap (got ${liveCount(ev)})`);
}

// ═════════════════════════════════════════════════════════════════════
header('8. Distance factor ranks voices — far voice scores lower, candidate shaded too');
// ═════════════════════════════════════════════════════════════════════
{
  sub('equal gain, different distance → the FAR voice is the victim');
  const eng = mkEngine();
  mkEvent(eng, 'dist', { cap: 2 });
  // near FIRST (oldest — the old code would shift() it), far second.
  const nearV = await eng.triggerSpatial('dist', 1, 0, { intensity: 0.5 });
  const farV = await eng.triggerSpatial('dist', 30, 0, { intensity: 0.5 });
  assert(nearV && farV, 'near + far voices up (equal pre-amp)');
  const cand = await eng.triggerSpatial('dist', 0, 0, { intensity: 0.5 });
  assert(cand !== null, 'listener-position candidate spawns');
  assert(farV._stopping === true, 'FAR voice was the victim (distance shades the score)');
  assert(!nearV._stopping, 'near voice survives despite being oldest');

  sub('candidate score is shaded by ITS OWN distance (reject at the radius edge)');
  const eng2 = mkEngine();
  mkEvent(eng2, 'edge', { cap: 1 });
  const live = await eng2.triggerSpatial('edge', 0, 0, { intensity: 0.5 });
  assert(live !== null, 'listener-position voice up');
  // Full intensity but at 49.99 of max_distance 50 (inside the 10% taper) —
  // attenuation ≈ 0.00004 ⇒ far below the live 0.1 ⇒ reject.
  const reject = await eng2.triggerSpatial('edge', 49.99, 0, { intensity: 1.0 });
  assert(reject === null, 'radius-edge candidate rejected (its distance kills its score)');
  assert(!live._stopping, 'live voice untouched');

  sub('attenuation curve sanity (far-but-inside > 0)');
  const att = _computeDistanceAttenuation(30, { model: 'inverse', minDistance: 1, maxDistance: 50, rolloff: 1 });
  assert(att > 0, `far-but-inside-radius attenuation still > 0 (got ${att.toFixed(5)})`);
}

// ═════════════════════════════════════════════════════════════════════
header('9. Multitrack cap (JS): steal down to SPAWN SIZE — the cap holds');
// ═════════════════════════════════════════════════════════════════════
{
  sub('2-track flat event, cap 2: a louder trigger replaces BOTH old voices');
  const eng = mkEngine();
  const ev = mkEvent(eng, 'multi', { cap: 2, tracks: 2, spatial: null });
  const p1 = ev.trigger(0.5);
  assert(p1.length === 2, 'trigger spawns one voice per track (2)');
  const [oldA, oldB] = ev._activeVoices.slice(-2);
  const p2 = ev.trigger(1.0);
  assert(p2.length === 2, 'louder trigger spawns both its voices');
  assert(!oldA.isActive() && !oldB.isActive(), 'BOTH old voices were stolen (spawn-size steal)');
  assert(liveCount(ev) <= 2,
    `cap holds for a multi-track event (live ${liveCount(ev)} ≤ 2; old code grew net +1/trigger)`);

  sub('multi-victim honesty: reject when ANY would-be victim outranks the candidate');
  const eng2 = mkEngine();
  const ev2 = mkEvent(eng2, 'honest', { cap: 2, tracks: 2, trackVolumes: [1.0, 0.3], spatial: null });
  const first = ev2.trigger(1.0);   // scores 1.0 (t0) and 0.3 (t1)
  assert(first.length === 2, 'two live voices at different track volumes');
  const [vLoud, vQuiet] = ev2._activeVoices.slice(-2);
  const rejected = ev2.trigger(0.5);   // candidate 0.1 — fitting 2 would kill the 1.0 voice
  assert(rejected.length === 0,
    'mid candidate rejected: fitting its spawn would kill a LOUDER voice');
  assert(vLoud.isActive() && vQuiet.isActive(), 'both live voices untouched by the reject');

  sub('equal-boundary candidate passes (not strictly quieter) and replaces both');
  const p3 = ev2.trigger(1.0);   // candidate 1.0 = loudest victim → pass
  assert(p3.length === 2, 'equal-loudness trigger passes');
  assert(!vLoud.isActive() && !vQuiet.isActive(), 'both victims released');
  assert(liveCount(ev2) <= 2, `cap still holds (live ${liveCount(ev2)})`);

  sub('2-track SPATIAL event, cap 2: unified pool holds too');
  const eng3 = mkEngine();
  const ev3 = mkEvent(eng3, 'multisp', { cap: 2, tracks: 2 });
  const s1 = await eng3.triggerSpatial('multisp', 0, 0, { intensity: 0.5 });
  assert(s1 !== null, 'first spatial trigger up (2 voices)');
  const s2 = await eng3.triggerSpatial('multisp', 0, 0, { intensity: 1.0 });
  assert(s2 !== null, 'louder spatial trigger passes');
  assert(liveCount(ev3) <= 2,
    `spatial multitrack cap holds (live ${liveCount(ev3)} ≤ 2)`);

  sub('spawn EXCEEDS cap: trigger admits nothing rather than blow past the ceiling');
  const eng4 = mkEngine();
  const ev4 = mkEvent(eng4, 'over', { cap: 2, tracks: 3, spatial: null });
  const over = ev4.trigger(1.0);
  assert(over.length === 0,
    'live 0: a 3-voice hit cannot fit cap 2 — rejected atomically (no partial timbre)');
  assert(liveCount(ev4) === 0, 'nothing spawned on the reject');
  const eng5 = mkEngine();
  const ev5 = mkEvent(eng5, 'over2', { cap: 2, tracks: 3, spatial: null });
  ev5.maxInstances = 3;
  const fit = ev5.trigger(1.0);
  assert(fit.length === 3, 'same event fits exactly when cap equals its spawn size');
  ev5.maxInstances = 2;
  const again = ev5.trigger(1.0);
  assert(again.length === 0 && liveCount(ev5) === 3,
    'cap lowered below spawn: rejected, and the live voices were NOT culled for a doomed hit');
}

// ═════════════════════════════════════════════════════════════════════
header('10. Steal release semantics — anti-click seam + honest ramp start (sess125)');
// ═════════════════════════════════════════════════════════════════════
// Defect B: the spatial wrapper's release() delegated to voice.stop() no-arg =
// the AUTHORED release_fade (ball_roll: 600 ms). The cap slot frees at once but
// the sound hangs the whole fade (574 ms of audibility measured) → "audible ≤
// cap" broke, and a smaller cap meant MORE steals ⇒ MORE overlapping authored
// tails ⇒ LOUDER (cap-knob inversion, +4.78 dB). A steal must be the anti-click
// seam; the authored fade belongs to game-driven stop()/destroy() only.
// Defect A (web-only): the release path trusted a raw gain.value read for the
// ramp start. A voice younger than ~5 ms still reports the GainNode DEFAULT
// (1.0) — its quiet scheduled target hasn't LANDED yet (sess125 microprobe:
// 0–1 ms → 1.0, ≥5 ms → target) — and cancelScheduledValues wipes the pending
// target, so the victim released from FULL SCALE: 7/7 break-shot victims aged
// 0–0.1 ms, +28–36 dB over authored. The voice gain never legitimately exceeds
// its own spawn target (envelope 0→target→0, crossfades ramp TO target), so
// the ramp start must clamp to it.
{
  const eng = mkEngine();
  const ev = mkEvent(eng, 'tail', { cap: 1 });
  ev.releaseFade = { duration: 0.6, curve: 'equal_power' };

  sub('B: a STOLEN spatial voice dies over the seam, not the authored 600 ms');
  const victim = await eng.triggerSpatial('tail', 0, 0, { intensity: 0.5 });
  assert(victim !== null, 'victim voice up (cap 1, authored release 600 ms)');
  // Young-voice window: the real GainNode still reports the constructor
  // default 1.0 — the envelope's quiet target is scheduled but not landed.
  victim._voiceGain.gain.value = 1.0;
  const g = victim._voiceGain.gain;
  const mark = g._e.length;
  const thief = await eng.triggerSpatial('tail', 0, 0, { intensity: 1.0 });
  assert(thief !== null, 'louder candidate steals');
  assert(victim._stopping === true, 'victim releasing (slot freed)');
  const set = g._e.slice(mark).find(e => e.kind === 'set');
  const ramp = g._e.slice(mark).find(e => e.kind === 'lin' && e.val === 0);
  assert(set && ramp, 'release scheduled a set + ramp-to-zero on the victim gain');
  const durMs = set && ramp ? (ramp.t - set.t) * 1000 : NaN;
  assert(set && ramp && durMs <= 25,
    `steal fade is the anti-click seam (${durMs.toFixed(1)} ms ≤ 25), not the authored 600 ms`);

  sub('A: the release ramp starts from the voice\'s _target, never the raw 1.0 read');
  assert(set && set.val <= victim._target + 1e-9,
    `ramp start ≤ _target (${set ? set.val : '—'} vs target ${victim._target})`);
}
{
  sub('A-flat: the flat wrapper clamps its ramp start to the spawn target too');
  const eng = mkEngine();
  const ev = mkEvent(eng, 'flat_race', { cap: 1, spatial: null });
  const gBefore = eng.ctx._gains.length;
  ev.trigger(0.5);   // quiet flat voice — envelope target 0.1
  assert(liveCount(ev) === 1, 'quiet flat voice up (cap 1)');
  // The voice gain is the fresh gain carrying the scheduled envelope set(0.1).
  const fg = eng.ctx._gains.slice(gBefore)
    .find(gn => gn.gain._e.some(e => e.kind === 'set' && e.val < 1));
  assert(fg != null, 'found the flat voice gain (scheduled quiet envelope)');
  const target = fg.gain._e.find(e => e.kind === 'set' && e.val < 1).val;
  fg.gain.value = 1.0;   // pre-landing window: the node still reports 1.0
  const mark = fg.gain._e.length;
  ev.trigger(1.0);       // steals the quiet voice through the flat release()
  const set = fg.gain._e.slice(mark).find(e => e.kind === 'set');
  const ramp = fg.gain._e.slice(mark).find(e => e.kind === 'lin' && e.val === 0);
  assert(set && ramp, 'flat steal scheduled set + ramp-to-zero');
  assert(set && set.val <= target + 1e-9,
    `flat ramp start ≤ spawn target (${set ? set.val : '—'} vs ${target})`);
}
{
  sub('control: game-driven stop() (no-arg) still fades over the AUTHORED release');
  const eng = mkEngine();
  const ev = mkEvent(eng, 'tail2', { cap: 8 });
  ev.releaseFade = { duration: 0.6, curve: 'equal_power' };
  const v = await eng.triggerSpatial('tail2', 0, 0, { intensity: 1.0 });
  assert(v !== null, 'voice up');
  const g = v._voiceGain.gain;
  const mark = g._e.length;
  v.stop();   // no-arg = the authored release path — the steal fix must not touch it
  const set = g._e.slice(mark).find(e => e.kind === 'set');
  const ramp = g._e.slice(mark).find(e => e.kind === 'lin' && e.val === 0);
  const durMs = set && ramp ? (ramp.t - set.t) * 1000 : NaN;
  assert(set && ramp && near(durMs, 600, 1),
    `no-arg stop() keeps the authored 600 ms fade (got ${durMs.toFixed(1)} ms)`);
}
{
  sub('cap N ⇒ every victim is scheduled silent within the seam (audible ≤ cap)');
  const eng = mkEngine();
  const ev = mkEvent(eng, 'bound', { cap: 2 });
  ev.releaseFade = { duration: 0.6, curve: 'equal_power' };
  const a = await eng.triggerSpatial('bound', 0, 0, { intensity: 0.4 });
  const b = await eng.triggerSpatial('bound', 0, 0, { intensity: 0.5 });
  assert(a && b, 'pool full (2/2, authored release 600 ms)');
  const c = await eng.triggerSpatial('bound', 0, 0, { intensity: 0.9 });
  const d = await eng.triggerSpatial('bound', 0, 0, { intensity: 1.0 });
  assert(c && d, 'both louder triggers pass');
  assert(a._stopping && b._stopping, 'both quiet voices were the victims');
  for (const [name, v] of [['a', a], ['b', b]]) {
    const set = v._voiceGain.gain._e.filter(e => e.kind === 'set').pop();
    const ramp = v._voiceGain.gain._e.filter(e => e.kind === 'lin' && e.val === 0).pop();
    const durMs = set && ramp ? (ramp.t - set.t) * 1000 : NaN;
    assert(set && ramp && durMs <= 25,
      `victim ${name} scheduled silent within the seam (${durMs.toFixed(1)} ms ≤ 25)`);
  }
  assert(liveCount(ev) <= 2, `live pool ≤ cap (${liveCount(ev)})`);
}

// ═════════════════════════════════════════════════════════════════════
header('Summary');
// ═════════════════════════════════════════════════════════════════════
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
