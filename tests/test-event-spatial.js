#!/usr/bin/env node
/**
 * PFA Engine — per-event SPATIAL attenuation (read from the config.json `spatial`).
 *
 * Editor side authors a per-event `spatial` block (snake_case):
 *   { enabled, mode, model, min_distance, max_distance, rolloff, panning_model, max_pan }
 * This suite locks the engine side:
 *   1. PFAEvent parses `spatial` (default null when absent).
 *   2. _eventSpatialToCfg maps the snake_case block → the engine's camelCase cfg,
 *      returning null when absent/disabled (contributes nothing to the merge).
 *   3. _mergeSpatialConfig precedence: _SPATIAL_DEFAULTS ← event.spatial ← game cfg
 *      (single-arg call stays back-compatible).
 *   4. triggerSpatial reads event.spatial as the DEFAULT (2D distance gain + 3D
 *      PannerNode), a game-passed config overrides, and the game may pass only
 *      POSITION.
 *   5. Spatial release: a no-arg voice.stop() falls back to the event's
 *      release_fade; an explicit ms overrides; every stop is floored to the
 *      anti-click SPATIAL_STOP_FLOOR_MS (P8: 0 = "fastest click-free", not a cut).
 *   6. createEmitter stores the RAW game cfg (not pre-merged) so event.spatial
 *      can still win at trigger time.
 *
 * Loads the REAL src/index.js (not a port).
 * Usage: node test-event-spatial.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack, PFASpatialEmitter, PFASpatialVoice,'
       + ' _mergeSpatialConfig, _eventSpatialToCfg, _computeDistanceAttenuation, _SPATIAL_DEFAULTS };';
  return new Function('window', src)(undefined);
}
const E = loadEngine();
const { PFA, PFAEvent, PFATrack, PFASpatialEmitter, PFASpatialVoice,
        _mergeSpatialConfig, _eventSpatialToCfg, _computeDistanceAttenuation, _SPATIAL_DEFAULTS } = E;

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function sub(t){console.log('\n  ─── '+t+' ───');}
function ok(m){passed++;console.log('    ✓ '+m);}
function fail(m){failed++;console.log('    ✗ FAIL: '+m);}
function assert(c,m){if(c)ok(m);else fail(m);}
function near(a,b,eps=1e-4){return Math.abs(a-b)<eps;}

// fox-run footsteps values
const SP = {
  enabled:true, mode:'2D', model:'inverse',
  min_distance:0.5, max_distance:4.0, rolloff:1.0,
  panning_model:'equalpower', max_pan:1.0,
};

function recParam(v=1){
  return { value:v, _e:[],
    setValueAtTime(val,t){this._e.push({val,t,kind:'set'});this.value=val;},
    linearRampToValueAtTime(val,t){this._e.push({val,t,kind:'lin'});this.value=val;},
    cancelScheduledValues(){},
  };
}

function mkStub(){
  return {
    _now:()=>0, _worldScale:1, _nextSpatialId:1, _spatialVoices:[], _emitters:[],
    _listenerPos:{x:0,y:0,z:0}, _listenerMode:'2D',
    _spawnSpatialVoice: PFA.prototype._spawnSpatialVoice,
    _scheduleSmartReloop: PFA.prototype._scheduleSmartReloop,
    _startSmartLoop: PFA.prototype._startSmartLoop,
    ctx:{ get currentTime(){return 0;},
      createStereoPanner:()=>({pan:recParam(0),connect(){}}),
      createGain:()=>({gain:recParam(1),connect(){},disconnect(){}}),
      createPanner:()=>({panningModel:'',distanceModel:'',refDistance:0,maxDistance:0,
        rolloffFactor:0,positionX:{value:0},positionY:{value:0},positionZ:{value:0},connect(){}}),
    },
  };
}

function mkEvent(stub, spatial, releaseFade){
  const data = { type:'sfx', volume:1.0 };
  if (spatial) data.spatial = spatial;
  if (releaseFade) data.release_fade = releaseFade;
  const ev = new PFAEvent('e', data, {});
  ev.buffersLoaded = true;
  ev.loadBuffers = async()=>{};
  ev._checkCanTrigger = ()=>true;
  ev._ensureGain = ()=>{};
  ev._eventGain = { gain: recParam(1), connect(){}, disconnect(){} };
  ev.groupGain = 1.0;
  ev.currentLevel = 0;
  ev.tracks = [{
    triggerSfxSpatial:()=>({
      source:{ onended:null, stop(){} },
      voiceGain: stub.ctx.createGain(),
      track:{ _sources:[] },
    }),
  }];
  return ev;
}

async function main(){

// ── 1. PFAEvent parses `spatial` ─────────────────────────────────────
header('1. PFAEvent.spatial parse');
assert(new PFAEvent('e',{type:'sfx'},{}).spatial === null,
  'absent spatial → null (engine falls back to defaults)');
{
  const ev = new PFAEvent('e',{type:'sfx', spatial:SP},{});
  assert(ev.spatial && ev.spatial.enabled === true && ev.spatial.max_distance === 4.0,
    'present spatial parsed verbatim (snake_case retained on the event)');
}

// ── 2. _eventSpatialToCfg snake→camel ────────────────────────────────
header('2. _eventSpatialToCfg (snake_case → camelCase)');
assert(_eventSpatialToCfg(null) === null, 'null → null');
assert(_eventSpatialToCfg({enabled:false, max_distance:4}) === null, 'disabled → null (ignored in merge)');
{
  const c = _eventSpatialToCfg(SP);
  assert(c.mode === '2D' && c.panningModel === 'equalpower' && c.maxPan === 1.0, 'top-level keys mapped');
  assert(c.attenuation.minDistance === 0.5 && c.attenuation.maxDistance === 4.0
    && c.attenuation.model === 'inverse' && c.attenuation.rolloff === 1.0, 'attenuation keys mapped (min/max/model/rolloff)');
}
{
  const c = _eventSpatialToCfg({enabled:true, max_distance:9}); // partial
  assert(c.attenuation.maxDistance === 9 && c.attenuation.minDistance === undefined,
    'partial block copies ONLY present keys (no undefined written)');
}

// ── 3. _mergeSpatialConfig precedence ────────────────────────────────
header('3. _mergeSpatialConfig precedence: defaults ← event ← game');
{
  const m = _mergeSpatialConfig(undefined, undefined);
  assert(m.attenuation.maxDistance === 50.0 && m.mode === '2D', 'no layers → _SPATIAL_DEFAULTS');
}
{
  const m = _mergeSpatialConfig(undefined, _eventSpatialToCfg(SP));
  assert(m.attenuation.maxDistance === 4.0 && m.attenuation.minDistance === 0.5,
    'event layer overrides defaults (game cfg absent)');
}
{
  const m = _mergeSpatialConfig({attenuation:{minDistance:1.0}}, _eventSpatialToCfg(SP));
  assert(m.attenuation.minDistance === 1.0, 'game cfg overrides event (minDistance)');
  assert(m.attenuation.maxDistance === 4.0, 'event value kept where game cfg is silent (maxDistance)');
}
{
  const m = _mergeSpatialConfig({attenuation:{maxDistance:99}});
  assert(m.attenuation.maxDistance === 99 && m.attenuation.minDistance === 1.0,
    'back-compat: single-arg call = defaults ← game cfg (unchanged behaviour)');
}

// ── 4. triggerSpatial reads event.spatial (end-to-end) ───────────────
header('4. triggerSpatial — event.spatial applied to the real voice');
sub('2D: distance gain reflects event.spatial (no game cfg)');
{
  const stub = mkStub();
  const ev = mkEvent(stub, SP);
  stub._getEvent = ()=>ev;
  // listener (0,0), source (2,0): inverse, min0.5 max4 → 0.5/(0.5+1*(2-0.5)) = 0.25
  const voice = await PFA.prototype.triggerSpatial.call(stub, 'e', 2, 0);
  assert(voice && voice._mode === '2D', 'voice created in 2D');
  assert(voice._cfg.attenuation.maxDistance === 4.0, 'voice cfg took event.spatial maxDistance (4, not default 50)');
  assert(near(voice._distanceGain.gain.value, 0.25), `2D distance gain = 0.25 from event.spatial (got ${voice._distanceGain.gain.value})`);
}
sub('2D: game cfg overrides event.spatial');
{
  const stub = mkStub();
  const ev = mkEvent(stub, SP);
  stub._getEvent = ()=>ev;
  // override minDistance→1: 1/(1+1*(2-1)) = 0.5
  const voice = await PFA.prototype.triggerSpatial.call(stub, 'e', 2, 0, { attenuation:{ minDistance:1.0 } });
  assert(voice._cfg.attenuation.minDistance === 1.0, 'game cfg minDistance won');
  assert(near(voice._distanceGain.gain.value, 0.5), `distance gain reflects override = 0.5 (got ${voice._distanceGain.gain.value})`);
}
sub('2D: no event.spatial → engine defaults (unchanged)');
{
  const stub = mkStub();
  const ev = mkEvent(stub, null);
  stub._getEvent = ()=>ev;
  // defaults min1 max50: 1/(1+1*(2-1)) = 0.5
  const voice = await PFA.prototype.triggerSpatial.call(stub, 'e', 2, 0);
  assert(voice._cfg.attenuation.maxDistance === 50.0, 'falls back to _SPATIAL_DEFAULTS');
  assert(near(voice._distanceGain.gain.value, 0.5), 'default attenuation applied');
}
sub('3D: PannerNode configured from event.spatial');
{
  const stub = mkStub();
  const ev = mkEvent(stub, { enabled:true, mode:'3D', model:'inverse',
    min_distance:2, max_distance:80, rolloff:1.5, panning_model:'HRTF', max_pan:1.0 });
  stub._getEvent = ()=>ev;
  const voice = await PFA.prototype.triggerSpatial.call(stub, 'e', 1, 2, 3);
  assert(voice._mode === '3D', 'voice created in 3D (event mode 3D + z given)');
  assert(voice._pannerNode.maxDistance === 80 && voice._pannerNode.refDistance === 2
    && near(voice._pannerNode.rolloffFactor,1.5) && voice._pannerNode.panningModel === 'HRTF',
    'PannerNode took event.spatial (maxDistance/refDistance/rolloff/panningModel)');
}

// ── 5. Spatial release coupling (voice.stop) ─────────────────────────
header('5. voice.stop() falls back to event release_fade');
function mkVoice(releaseMs){
  const vg = { gain: recParam(1), context:{ currentTime:0 } };
  let stopped = 0;
  const src = { onended:null, stop(){ stopped++; } };
  const v = new PFASpatialVoice(1, src, null, null, vg, null, '2D', {x:0,y:0,z:0}, _SPATIAL_DEFAULTS, null, releaseMs);
  return { v, vg, src, getStopped:()=>stopped };
}
{
  const { v, vg } = mkVoice(200);            // releaseMs = 200
  v.stop();                                   // no arg → use releaseMs
  const ramp = vg.gain._e.find(e=>e.kind==='lin' && e.val===0);
  assert(!!ramp, 'no-arg stop() schedules a fade to 0 (uses event release)');
  assert(near(ramp.t, 0.205), `fade ends at ~now+0.005+0.200 = 0.205 (got ${ramp && ramp.t})`);
}
{
  const { v, vg } = mkVoice(200);
  v.stop(100);                                // explicit override
  const ramp = vg.gain._e.find(e=>e.kind==='lin' && e.val===0);
  assert(ramp && near(ramp.t, 0.105), 'explicit ms overrides release_fade (ends ~0.105)');
}
{
  // P8 anti-click floor: releaseMs 0 must NOT hard-cut (a loop cut mid-wave clicks —
  // the web-billiards ball_roll repro). The stop is floored to SPATIAL_STOP_FLOOR_MS.
  const { v, vg, getStopped } = mkVoice(0);   // no release authored
  v.stop();                                   // → floored micro-fade, not instant
  const ramp = vg.gain._e.find(e=>e.kind==='lin' && e.val===0);
  assert(!!ramp && near(ramp.t, 0.025), `releaseMs 0 → 20ms anti-click ramp (ends ~0.025, got ${ramp && ramp.t})`);
  assert(getStopped() === 0, 'source NOT stopped synchronously (deferred to ramp end)');
}
{
  const { v, vg } = mkVoice(200);
  v.stop(0);                                  // explicit 0 (emitter.destroy(0) path)
  const ramp = vg.gain._e.find(e=>e.kind==='lin' && e.val===0);
  assert(!!ramp && near(ramp.t, 0.025), 'explicit stop(0) is floored too (destroy(0)/re-rack click-free)');
}
{
  const { v, vg } = mkVoice(5);               // authored release BELOW the floor
  v.stop();
  const ramp = vg.gain._e.find(e=>e.kind==='lin' && e.val===0);
  assert(!!ramp && near(ramp.t, 0.025), 'sub-floor release_fade (5ms) floored to 20ms');
}
sub('triggerSpatial wires releaseMs from event.release_fade');
{
  const stub = mkStub();
  const ev = mkEvent(stub, SP, { duration:0.15, curve:'linear' });
  stub._getEvent = ()=>ev;
  const voice = await PFA.prototype.triggerSpatial.call(stub, 'e', 1, 0);
  assert(voice._releaseMs === 150, `voice carries release_fade 0.15s → 150ms (got ${voice._releaseMs})`);
}

// ── 6. createEmitter stores RAW cfg (event.spatial can still win) ─────
header('6. createEmitter stores raw cfg (not pre-merged)');
{
  const stub = mkStub();
  const e1 = PFA.prototype.createEmitter.call(stub, undefined);
  assert(e1._cfg === null, 'no config → _cfg null (so event.spatial fully applies)');
  const e2 = PFA.prototype.createEmitter.call(stub, { attenuation:{ maxDistance:7 } });
  assert(e2._cfg && e2._cfg.attenuation.maxDistance === 7 && e2._cfg.attenuation.minDistance === undefined,
    'partial config stored RAW (not back-filled with defaults)');
}

// ── 7. Spatial AMBIENCE loops (music events); SFX stays one-shot ──────
// triggerSfxSpatial loops a MUSIC-type event's loop_source clip seamlessly
// (continuous spatial ambience: campfire / lamp hum / wind), while a SFX-type
// event stays single-shot exactly as before (fox-run footsteps/hits). Gate is the
// EVENT TYPE, not loop_mode (the editor bakes ALL clips as 'loop_source', so
// loop_mode alone would wrongly loop every spatial SFX). Drives the REAL PFATrack.
header('7. triggerSfxSpatial — ambience loops, SFX one-shot');

function recSource(){
  return { buffer:null, loop:false, loopStart:0, loopEnd:0, _startArgs:null,
    playbackRate:{value:1}, detune:{value:0},
    connect(){}, stop(){}, onended:null,
    start(...a){ this._startArgs = a; } };
}
function mkTrackEngine(){
  return { _now:()=>0, ctx:{ currentTime:0,
    createBufferSource:()=>recSource(),
    createGain:()=>({ gain:recParam(1), connect(){}, disconnect(){} }) } };
}
// Real PFATrack: level_specific, one loop_source clip (offset 0.5, playLen 30,
// fade_in 1.0, fade_out 2.0), one injected buffer; _parentEvent.type drives loop.
function makeAmbienceTrack(eventType, clipOverrides, loopCfg, levelOverrides){
  const level0 = Object.assign({ samples:['x'], play_chance:100, switch_chance:100,
    clips:[ Object.assign({ source_offset:0.5, source_play_length:30,
      loop_mode:'loop_source', fade_in:1.0, fade_out:2.0 }, clipOverrides||{}) ] }, levelOverrides||{});
  const t = new PFATrack({ name:'amb', level_behavior:'level_specific', levels:{ '0':level0 } }, mkTrackEngine());
  t._buffers[0] = [{ idx:0, duration:60 }];
  t._parentEvent = { type:eventType, loop: loopCfg || null };
  return t;
}

sub('MUSIC ambience → source loops the clip region (no duration arg)');
{
  const r = makeAmbienceTrack('music').triggerSfxSpatial(0);
  assert(r && r.source.loop === true, 'music event → source.loop = true');
  assert(near(r.source.loopStart, 0.5) && near(r.source.loopEnd, 30.5),
    `loopStart/End = clip window [0.5, 30.5] (got [${r.source.loopStart}, ${r.source.loopEnd}])`);
  assert(r.source._startArgs && r.source._startArgs.length === 2,
    `start() has NO duration arg when looping (got ${r.source._startArgs && r.source._startArgs.length} args)`);
}
sub('SFX event → one-shot, unchanged (regression guard for fox-run)');
{
  const r = makeAmbienceTrack('sfx').triggerSfxSpatial(0);
  assert(r && r.source.loop === false, 'sfx event → source.loop = false (one-shot)');
  assert(r.source._startArgs && r.source._startArgs.length === 3 && near(r.source._startArgs[2], 30),
    'start() keeps the playLength duration arg (one-shot trim) — unchanged');
}
sub('MUSIC clip explicitly one_shot → does NOT loop (loop_mode override)');
{
  const r = makeAmbienceTrack('music', { loop_mode:'one_shot' }).triggerSfxSpatial(0);
  assert(r && r.source.loop === false, 'music + loop_mode one_shot → plays once (no loop)');
}
sub('looping ambience drops the window-end fade-OUT (keeps fade-IN)');
{
  const r = makeAmbienceTrack('music').triggerSfxSpatial(0);
  const ev = r.voiceGain.gain._e;
  assert(ev.some(e=>e.kind==='lin' && e.val>0), 'fade-IN ramp to target present (start fade applies once)');
  assert(!ev.some(e=>e.kind==='lin' && e.val===0), 'NO fade-OUT ramp to 0 (would mute the loop after one pass)');
}
sub('SFX one-shot still gets the window-end fade-OUT (unchanged)');
{
  const r = makeAmbienceTrack('sfx').triggerSfxSpatial(0);
  assert(r.voiceGain.gain._e.some(e=>e.kind==='lin' && e.val===0), 'one-shot SFX keeps its fade-OUT');
}

// ── 8. Explicit event.loop flag (SFX) — seamless vs smart vs off ─────
header('8. event.loop flag — seamless native loop vs smart re-trigger');

sub('SFX + loop{enabled, seamless} → native loop of one variation');
{
  const r = makeAmbienceTrack('sfx', null, { enabled:true, mode:'seamless' }).triggerSfxSpatial(0);
  assert(r && r.loopMode === 'seamless', `loopMode 'seamless' (got ${r && r.loopMode})`);
  assert(r.source.loop === true, 'source natively loops');
  assert(near(r.source.loopStart, 0.5) && near(r.source.loopEnd, 30.5), 'loop region = clip window');
}
sub('SFX + loop{enabled, smart} → plays ONCE here (re-trigger owned by triggerSpatial)');
{
  const r = makeAmbienceTrack('sfx', null, { enabled:true, mode:'smart' }).triggerSfxSpatial(0);
  assert(r && r.loopMode === 'smart', `loopMode 'smart' (got ${r && r.loopMode})`);
  assert(r.source.loop === false, 'source does NOT native-loop (one pass per cycle)');
  assert(r.source._startArgs && r.source._startArgs.length === 3, 'plays the trim window once (duration arg present)');
  assert(near(r.clipLen, 30), `clipLen = 30 (the re-loop period) (got ${r.clipLen})`);
  assert(r.target === 1, 'target gain returned for the crossfade');
}
sub('SFX + loop{enabled:false} → one-shot (unchanged)');
{
  const r = makeAmbienceTrack('sfx', null, { enabled:false, mode:'smart' }).triggerSfxSpatial(0);
  assert(r && r.loopMode === null, 'disabled loop → loopMode null');
  assert(r.source.loop === false, 'source one-shot');
}
sub('one_shot clip overrides the loop flag → never loops');
{
  const r = makeAmbienceTrack('sfx', { loop_mode:'one_shot' }, { enabled:true, mode:'seamless' }).triggerSfxSpatial(0);
  assert(r && r.loopMode === null, 'one_shot clip → loopMode null even with loop enabled');
  assert(r.source.loop === false, 'source one-shot');
}
sub('skipPlayChance — the re-loop bypasses the play_chance roll (never gaps)');
{
  const mk = () => makeAmbienceTrack('sfx', null, { enabled:true, mode:'smart' }, { play_chance:0 });
  assert(mk().triggerSfxSpatial(0, false) === null, 'play_chance 0 + normal trigger → null (rolled out)');
  assert(mk().triggerSfxSpatial(0, true) !== null, 'play_chance 0 + skipPlayChance → still fires (no gap)');
}

// ── 9. Smart re-loop scheduler — chain a re-trigger, crossfade, clean up ──
header('9. smart loop scheduler');
{
  const realST = setTimeout, realCT = clearTimeout;
  const timers = []; let cleared = 0;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => { cleared++; };
  try {
    const stub = mkStub();
    const track = makeAmbienceTrack('sfx', null, { enabled:true, mode:'smart' });
    const event = { currentLevel:0, tracks:[track], _eventGain:{}, _activeVoices:[] };
    const cfg = _mergeSpatialConfig(undefined, undefined); // 2D defaults
    const v0 = stub._spawnSpatialVoice(event, track, {x:1,y:0,z:0}, cfg, false, 0, null);

    sub('smart spawn schedules a re-loop at clipLen − crossfade');
    assert(!!v0 && stub._spatialVoices.length === 1, 'initial smart voice registered');
    assert(timers.length === 1 && Math.abs(timers[0].ms - (30 - 0.08) * 1000) < 1,
      `re-loop timer ≈ 29920ms (got ${timers[0] && timers[0].ms})`);

    sub('firing the re-loop spawns the next variation + crossfades + stops the old');
    timers[0].fn();
    const v1 = stub._spatialVoices[stub._spatialVoices.length - 1];
    assert(stub._spatialVoices.length === 2, 'a second voice was spawned by the re-loop');
    assert(v0._playing === false, 'old voice stopped at the seam');
    const ramp = v1._voiceGain.gain._e.find(e => e.kind === 'lin' && e.val === 1);
    assert(ramp && Math.abs(ramp.t - 0.08) < 1e-6, 'new voice crossfades in 0→target over 80ms');
    assert(timers.slice(1).some(t => Math.abs(t.ms - (30 - 0.08) * 1000) < 1),
      'the new voice scheduled its OWN next re-loop (chain continues)');

    sub('stop() cancels a pending re-loop (chain ends, no leak)');
    const before = cleared;
    v1.stop(0);
    assert(cleared > before, 'stop() cleared the pending re-loop timer');
  } finally {
    global.setTimeout = realST; global.clearTimeout = realCT;
  }
}

// ── 10. Smart loop CONTROLLER (emitter) — per-cycle play_chance ──────
header('10. smart loop controller — play_chance per cycle = intermittent ambience');
{
  const realST = setTimeout, realCT = clearTimeout;
  const timers = []; let cleared = 0;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => { cleared++; };
  const fire = () => timers[timers.length - 1].fn();
  try {
    const stub = mkStub();
    const track = makeAmbienceTrack('sfx', null, { enabled:true, mode:'smart' });
    let roll = true; track._rollPlayChance = () => roll; // control play/silent per cycle
    const emitter = { _pos:{x:1,y:0,z:0}, _destroyed:false, _smartLoops:[] };
    const event = { currentLevel:0, tracks:[track], _eventGain:{}, _activeVoices:[], loop:{enabled:true,mode:'smart'} };
    const cfg = _mergeSpatialConfig(undefined, undefined);

    sub('first cycle ALWAYS plays + registers on the emitter');
    const ctrl = stub._startSmartLoop(event, track, cfg, false, 0, emitter, 0);
    assert(ctrl && ctrl.active && stub._spatialVoices.length === 1, 'first tick spawned a voice (always plays)');
    assert(emitter._smartLoops.length === 1, 'controller registered on emitter._smartLoops');
    assert(timers.length === 1 && Math.abs(timers[0].ms - (30 - 0.08) * 1000) < 1, 'next slot scheduled at clipLen−cross');

    sub('a SILENT cycle (play_chance fail) spawns NO voice but keeps the loop alive');
    roll = false; const n1 = stub._spatialVoices.length;
    fire();
    assert(stub._spatialVoices.length === n1, 'silent slot: no new voice');
    assert(ctrl.active === null, 'no active voice during a silent slot');
    assert(timers.length >= 2, 'loop survives the silent slot (next cycle still scheduled)');

    sub('a PLAY cycle spawns the next (switched) variation again');
    roll = true; const n2 = stub._spatialVoices.length;
    fire();
    assert(stub._spatialVoices.length === n2 + 1, 'play slot spawned a voice');

    sub('controller stops on emitter.destroy (no leak, stale ticks bail)');
    emitter._destroyed = true;
    emitter._smartLoops.forEach(c => { c.stopped = true; if (c.timer) clearTimeout(c.timer); });
    assert(cleared > 0, 'pending timer cleared on destroy');
    const n3 = stub._spatialVoices.length;
    roll = true; fire(); // stale tick after stop
    assert(stub._spatialVoices.length === n3, 'a tick after stop spawns nothing');
  } finally {
    global.setTimeout = realST; global.clearTimeout = realCT;
  }
}

// ── 11. stopAll stops emitter smart-loop controllers (live-reload zombie guard) ──
// PFALiveConnect.reload calls stopAll() then swaps the pack; a controller that
// survives keeps re-spawning from the OLD event/track refs captured in its
// closure = zombie ambience playing the stale pack. Drives the REAL PFA.stopAll.
header('11. stopAll — smart-loop controllers die, emitters survive');
{
  const realST = setTimeout, realCT = clearTimeout;
  const timers = []; let cleared = 0;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => { cleared++; };
  const fire = () => timers[timers.length - 1].fn();
  try {
    const stub = mkStub();
    stub.events = {}; // no music events — spatial side only
    stub.stop = () => {};
    const track = makeAmbienceTrack('sfx', null, { enabled:true, mode:'smart' });
    track._rollPlayChance = () => true;
    const emitter = { _pos:{x:1,y:0,z:0}, _destroyed:false, _smartLoops:[] };
    stub._emitters.push(emitter);
    const event = { currentLevel:0, tracks:[track], _eventGain:{}, _activeVoices:[], loop:{enabled:true,mode:'smart'} };
    const cfg = _mergeSpatialConfig(undefined, undefined);
    const ctrl = stub._startSmartLoop(event, track, cfg, false, 0, emitter, 0);
    assert(ctrl && stub._spatialVoices.length === 1 && emitter._smartLoops.length === 1,
      'smart loop running on the emitter (precondition)');

    sub('stopAll() stops the controller AND its pending timer');
    const clearedBefore = cleared;
    PFA.prototype.stopAll.call(stub, 0);
    assert(ctrl.stopped === true, 'controller flagged stopped');
    assert(cleared > clearedBefore, 'pending re-loop timer cleared');
    assert(emitter._smartLoops.length === 0, 'emitter._smartLoops emptied');
    assert(stub._spatialVoices.length === 0, 'spatial voices stopped + pruned (unchanged behavior)');
    assert(stub._emitters.length === 1 && emitter._destroyed === false,
      'emitter itself SURVIVES (belongs to the game object)');

    sub('a stale tick after stopAll spawns nothing (no zombie)');
    const n = stub._spatialVoices.length;
    fire(); // the timer captured before stopAll
    assert(stub._spatialVoices.length === n, 'stale tick bails — no voice from the old pack');
  } finally {
    global.setTimeout = realST; global.clearTimeout = realCT;
  }
}

// ── E2 (P3 2D audit): taper to silence at max_distance ───────────────
header('E2 — boundary taper: no step at max_distance');
{
  const ATT = { model:'inverse', minDistance:1.0, maxDistance:50.0, rolloff:1.0 };

  sub('curve untouched inside 90% of the radius');
  assert(near(_computeDistanceAttenuation(25, ATT), 1/25), 'mid-range inverse unchanged (d=25 → 1/25)');
  assert(near(_computeDistanceAttenuation(45, ATT), 1/45), 'taper starts only PAST 0.9×max (d=45 untouched)');

  sub('the step is closed (~2% → 0 jump becomes a ramp)');
  const justInside = _computeDistanceAttenuation(49.95, ATT);
  assert(justInside < 0.005, `just inside max (d=49.95) → ${justInside.toFixed(5)} < 0.005`);
  assert(justInside > 0, 'still nonzero INSIDE the radius');

  sub('monotone through the taper zone; exact 0 at/past max');
  let prev = _computeDistanceAttenuation(45, ATT), mono = true;
  for (const d of [46, 47, 48, 49, 49.5, 49.9]) {
    const v = _computeDistanceAttenuation(d, ATT);
    if (v > prev + 1e-12) mono = false;
    prev = v;
  }
  assert(mono, 'gain only decreases across 45 → 49.9');
  assert(_computeDistanceAttenuation(50, ATT) === 0 && _computeDistanceAttenuation(60, ATT) === 0,
    'at/past max stays exactly 0 (unchanged)');

  sub('untouched paths stay untouched');
  const FREE = { model:'inverse', minDistance:1.0, maxDistance:0, rolloff:1.0 };
  assert(_computeDistanceAttenuation(1000, FREE) > 0, 'maxDistance 0 ⇒ infinite tail, no taper');
  const LIN = { model:'linear', minDistance:1.0, maxDistance:50.0, rolloff:0.5 };
  assert(near(_computeDistanceAttenuation(25, LIN), 1 - 0.5*24/49), 'linear mid-range unchanged');
  assert(_computeDistanceAttenuation(49.95, LIN) < 0.01,
    'linear rolloff<1 also lands at ~0 (was a 0.5-high step at the boundary)');
}

// ── summary ──────────────────────────────────────────────────────────
console.log('\n'+'═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed ? 1 : 0);

}

main().catch(e=>{ console.error('FATAL', e); process.exit(1); });
