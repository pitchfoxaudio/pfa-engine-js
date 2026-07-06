#!/usr/bin/env node
/**
 * PFA Engine — event-fade curve-overlap regression suite
 *
 * Guards the 2026-06-01 freeze fix. Since v1.9.3 non-linear event fades render as
 * `setValueCurveAtTime`, which reserves an exclusion window [t0, t0+dur]: Web Audio
 * throws NotSupportedError if ANY later automation lands inside it. A game firing a
 * fade twice in quick succession (fox-run: `pfa.stop('fox_fly', 0.15)` on a jump-land
 * repeated on a crystal) made the 2nd `fadeOut` throw out of the Phaser update loop →
 * hard freeze. Fix: route fadeIn/fadeOut through `_tweenEventGain`, which calls
 * `cancelScheduledValues(0)` before re-anchoring — wiping the running curve so the new
 * fade schedules cleanly.
 *
 * The stock test mocks are no-ops, so they can't catch this. Here we build a
 * zone-ENFORCING mock AudioParam that replicates the browser's exclusion + the STRICT
 * cancelScheduledValues semantics (a curve whose startTime < cancelTime is NOT removed —
 * which is exactly why the fix must cancel from 0, not from `now`). We then exercise the
 * REAL PFAEvent.fadeIn/fadeOut (evaled from src/index.js, not a port).
 *
 * Usage: node test-event-fade-overlap.js
 */

const fs = require('fs');
const path = require('path');

// ── Load the real PFAEvent from source (same loader as test-sfx-variation) ──
function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack };';
  return new Function('window', src)(undefined);
}
const { PFAEvent, PFATrack } = loadEngine();

// ── Tiny test harness (house convention) ─────────────────────────────
let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }
function assertNoThrow(fn, m) { try { fn(); ok(m); } catch (e) { fail(m + ' — threw: ' + e.message); } }
function assertThrows(fn, m) { try { fn(); fail(m + ' — did NOT throw'); } catch (e) { ok(m); } }

// ── Zone-enforcing mock AudioParam (replicates the browser) ───────────
// curves: reserved [start,end] windows from setValueCurveAtTime.
// events: times of set/ramp points (a curve also can't be scheduled over them).
// Exclusion is the open interval (start, end): an anchor AT a curve's own startTime
// is legal (the standard `setValueAtTime(v0, t0); setValueCurveAtTime(arr, t0, d)` idiom).
function mkZoneParam(initial = 1) {
  const curves = [];
  const events = [];
  const inCurve = (t) => curves.some(c => c.start < t && t < c.end);
  const overlapsCurve = (t0, end) => curves.some(c => c.start < end && t0 < c.end);
  const NSE = () => { const e = new Error('setValueAtTime overlaps setValueCurveAtTime'); e.name = 'NotSupportedError'; return e; };
  return {
    value: initial,
    _curves: curves,
    _events: events,
    setValueAtTime(v, t) { if (inCurve(t)) throw NSE(); events.push(t); this.value = v; },
    linearRampToValueAtTime(v, t) { if (inCurve(t)) throw NSE(); events.push(t); this.value = v; },
    exponentialRampToValueAtTime(v, t) { if (inCurve(t)) throw NSE(); events.push(t); this.value = v; },
    setValueCurveAtTime(arr, t0, dur) {
      const end = t0 + dur;
      if (overlapsCurve(t0, end)) throw NSE();
      if (events.some(e => e > t0 && e < end)) throw NSE();
      curves.push({ start: t0, end });
      this.value = arr[arr.length - 1];
    },
    // STRICT spec: only events/curves whose (start)time >= cancelTime are removed.
    cancelScheduledValues(cancelTime) {
      for (let i = curves.length - 1; i >= 0; i--) if (curves[i].start >= cancelTime) curves.splice(i, 1);
      for (let i = events.length - 1; i >= 0; i--) if (events[i] >= cancelTime) events.splice(i, 1);
    },
    // cancelAndHoldAtTime: drop events/curves after holdTime; TRUNCATE a curve straddling
    // holdTime to end AT holdTime (and hold its value there). Crucially it does NOT throw when
    // holdTime lands inside a live curve — that is exactly why _applyChanceGain uses it to
    // schedule a future ramp across an in-flight level fade without the setValueAtTime overlap.
    cancelAndHoldAtTime(holdTime) {
      for (let i = curves.length - 1; i >= 0; i--) {
        if (curves[i].start >= holdTime) curves.splice(i, 1);
        else if (curves[i].end > holdTime) curves[i].end = holdTime;
      }
      for (let i = events.length - 1; i >= 0; i--) if (events[i] > holdTime) events.splice(i, 1);
    },
  };
}

// A real PFAEvent without running its full constructor — we only drive the fade path.
function mkEvent(volume = 1) {
  let T = 0;
  const gainParam = mkZoneParam(volume);
  // ctx.currentTime tracks T — _tweenEventGain anchors at ctx.currentTime (no lookahead).
  const engine = { _now: () => T, ctx: { get currentTime() { return T; }, createGain: () => ({ gain: gainParam, connect() {}, disconnect() {} }) }, masterGain: {} };
  const ev = Object.create(PFAEvent.prototype);
  ev.engine = engine;
  ev.volume = volume;
  ev.groupGain = 1;
  ev.isPlaying = false;             // timer callback's `if (this.isPlaying) this.stop()` stays a no-op
  ev._fadeOutTimer = null;
  ev._eventGain = { gain: gainParam, connect() {}, disconnect() {} };
  ev.stop = () => {};
  ev._advance = (dt) => { T += dt; };
  ev._gainParam = gainParam;
  ev._clearTimer = () => { if (ev._fadeOutTimer) { clearTimeout(ev._fadeOutTimer); ev._fadeOutTimer = null; } };
  return ev;
}

// ═════════════════════════════════════════════════════════════════════
header('1. Mock fidelity — it really enforces the browser exclusion zone');
// ═════════════════════════════════════════════════════════════════════
{
  const p = mkZoneParam(1);
  assertNoThrow(() => { p.setValueAtTime(1, 0); p.setValueCurveAtTime([1, 0.0001], 0, 0.15); },
    'anchor AT the curve startTime is legal (standard idiom)');
  assertThrows(() => p.setValueAtTime(0.5, 0.05),
    'setValueAtTime at t=0.05 inside active curve [0,0.15] THROWS (this is the bug)');
  assertThrows(() => p.setValueCurveAtTime([0.5, 0.0001], 0.05, 0.15),
    'a 2nd overlapping curve also THROWS');
}
{
  sub('STRICT cancelScheduledValues — why the fix must cancel from 0, not now');
  const p = mkZoneParam(1);
  p.setValueAtTime(1, 0); p.setValueCurveAtTime([1, 0.0001], 0, 0.15);
  p.cancelScheduledValues(0.05);   // curve startTime 0 < 0.05 → NOT removed
  assertThrows(() => p.setValueAtTime(0.5, 0.05),
    'cancelScheduledValues(now=0.05) leaves the running curve → still throws');
  const p2 = mkZoneParam(1);
  p2.setValueAtTime(1, 0); p2.setValueCurveAtTime([1, 0.0001], 0, 0.15);
  p2.cancelScheduledValues(0);     // startTime 0 >= 0 → removed
  assertNoThrow(() => p2.setValueAtTime(0.5, 0.05),
    'cancelScheduledValues(0) wipes the running curve → no throw');
}

// ═════════════════════════════════════════════════════════════════════
header('2. The freeze repro — rapid event fadeOut no longer throws');
// ═════════════════════════════════════════════════════════════════════
{
  const ev = mkEvent(1);
  assertNoThrow(() => ev.fadeOut(0.15), 'first fadeOut(0.15) schedules cleanly');
  ev._clearTimer();
  ev._advance(0.05);                                  // 50ms later, still inside the 150ms curve
  assertNoThrow(() => ev.fadeOut(0.15), 'second fadeOut 50ms later — NO throw (was the freeze)');
  ev._clearTimer();
  assert(ev._gainParam._curves.length === 1, 'old curve was cancelled, exactly one active curve remains');
}
{
  sub('jump-land-jump hammer — 6 fades within one fade window');
  const ev = mkEvent(1);
  assertNoThrow(() => {
    for (let i = 0; i < 6; i++) { ev.fadeOut(0.15); ev._clearTimer(); ev._advance(0.02); }
  }, 'six fadeOut(0.15) at 20ms spacing — no NotSupportedError');
}

// ═════════════════════════════════════════════════════════════════════
header('3. fadeIn — same guard, and interrupting a fade-out with a fade-in');
// ═════════════════════════════════════════════════════════════════════
{
  const ev = mkEvent(1);
  assertNoThrow(() => ev.fadeIn(0.15), 'first fadeIn schedules cleanly');
  ev._advance(0.05);
  assertNoThrow(() => ev.fadeIn(0.15), 'rapid second fadeIn — no throw');
}
{
  sub('fade-out then fade-in mid-window (crossfade-style on one event)');
  const ev = mkEvent(1);
  assertNoThrow(() => ev.fadeOut(0.2), 'fadeOut(0.2)');
  ev._clearTimer();
  ev._advance(0.08);
  assertNoThrow(() => ev.fadeIn(0.2), 'fadeIn(0.2) 80ms into the fade-out — no throw');
}

// ═════════════════════════════════════════════════════════════════════
header('4. Linear curve path never reserves a zone (v47 behavior preserved)');
// ═════════════════════════════════════════════════════════════════════
{
  const ev = mkEvent(1);
  assertNoThrow(() => {
    for (let i = 0; i < 6; i++) { ev.fadeOut(0.15, 'linear'); ev._clearTimer(); ev._advance(0.02); }
  }, 'rapid linear fadeOut — no zones, no throw');
  assert(ev._gainParam._curves.length === 0, 'linear fades schedule no setValueCurveAtTime windows');
}

// ═════════════════════════════════════════════════════════════════════
header('5. Sibling event-gain paths are guarded too (setVolume / duck / stop)');
// ═════════════════════════════════════════════════════════════════════
{
  // _updateGain IS the real setVolume() path — an instant set that must not
  // throw when called while a fade curve is active on the event gain.
  const ev = mkEvent(1);
  ev.fadeOut(0.2); ev._clearTimer(); ev._advance(0.05);
  assertNoThrow(() => ev._updateGain(), 'setVolume (_updateGain) mid-fade — cancel(0) guard, no throw');
}
{
  sub('duck/unduck route through _tweenEventGain(linear) — guarded mid-fade');
  const ev = mkEvent(1);
  ev.fadeOut(0.2); ev._clearTimer(); ev._advance(0.05);
  assertNoThrow(() => ev._tweenEventGain(0.3, 0.5, 'linear'), 'duck-style linear ramp mid-fade — no throw');
  ev._advance(0.05);
  assertNoThrow(() => ev._tweenEventGain(1.0, 0.5, 'linear'), 'unduck-style linear ramp mid-fade — no throw');
}
{
  sub('stop() anti-click (helper, 20ms) mid-fade');
  const ev = mkEvent(1);
  ev.fadeOut(0.2); ev._clearTimer(); ev._advance(0.05);
  assertNoThrow(() => ev._tweenEventGain(0.0001, 0.02, 'linear'), 'stop anti-click ramp mid-fade — no throw');
}

// ═════════════════════════════════════════════════════════════════════
header('6. Level-crossfade splice — rapid level switch within a fade (fox-run danger-zone freeze)');
// ═════════════════════════════════════════════════════════════════════
// PFATrack.activateLevel / _rampLevelGain schedule equal_power CURVES on the per-level
// gains. Switching level again within a fade window made the splice's
// linearRampToValueAtTime land inside the active curve → NotSupportedError → freeze.
// Real stack: _checkDangerZone → setLevel → _crossfadeLevel → activateLevel.
function mkTrackWith2Levels() {
  const ctx = { sampleRate: 48000, currentTime: 0, createGain: () => ({ gain: mkZoneParam(0), connect() {}, disconnect() {} }) };
  const t = Object.create(PFATrack.prototype);
  t.engine = { ctx, _now: () => ctx.currentTime };
  t.volume = 1;
  t._levelGains = { 0: { gain: mkZoneParam(0) }, 1: { gain: mkZoneParam(0) } };
  t._intendedGains = { 0: 0, 1: 0 };
  t._rampState = {};
  t._pendingChanceGain = null;
  t._parentEvent = null;
  t._advance = (dt) => { ctx.currentTime += dt; };
  return t;
}
{
  const t = mkTrackWith2Levels();
  assertNoThrow(() => t.activateLevel(0, 5.0), 'activateLevel(0, 5s) schedules per-level curves');
  t._advance(0.7);                                   // 0.7s into the 5s fade
  assertNoThrow(() => t.activateLevel(1, 5.0), 'activateLevel(1, 5s) 0.7s later — NO throw (was the danger-zone freeze)');
  t._advance(0.2);
  assertNoThrow(() => t.activateLevel(0, 5.0), 'flip back within the fade — no throw');
}
{
  sub('hammer: 6 level flips inside one fade window');
  const t = mkTrackWith2Levels();
  assertNoThrow(() => {
    for (let i = 0; i < 6; i++) { t.activateLevel(i % 2, 5.0); t._advance(0.1); }
  }, 'six rapid activateLevel within a 5s fade — no NotSupportedError');
}
{
  sub('instant (fd=0 floor) level swap during an active fade curve');
  const t = mkTrackWith2Levels();
  t.activateLevel(0, 5.0); t._advance(0.3);
  assertNoThrow(() => t.activateLevel(1, 0), 'fd=0 floor swap mid-curve — no throw');
}
{
  sub('_rampLevelGain (Transition Kinds v2 path) within a fade');
  const t = mkTrackWith2Levels();
  t.activateLevel(0, 5.0); t._advance(0.5);
  assertNoThrow(() => t._rampLevelGain(0, 0, 4.0), '_rampLevelGain mid-curve — no throw');
}

// ═════════════════════════════════════════════════════════════════════
header('7. Level splice anchors at ctx.currentTime — NO lookahead gap (the click fix)');
// ═════════════════════════════════════════════════════════════════════
// The 221010f freeze fix wiped the curve correctly but anchored the new fade at
// now+lookahead. That [now, t0) gap is rendered by Web Audio at the NEW curve's
// TARGET — full volume on a fade-in ("громкость прорывается на полную"), silence on
// a fade-out. Verified the audible artifact + this fix against real Web Audio via
// OfflineAudioContext (suspend() mid-render). Here we lock the MECHANISM the mock can
// see: every splice schedules its anchor + curve at exactly ctx.currentTime.
{
  const t = mkTrackWith2Levels();
  t.activateLevel(0, 5.0);                 // level 0 fades up
  t._advance(0.7);                          // 0.7s into the fade
  const tNow = t.engine.ctx.currentTime;
  t.activateLevel(1, 5.0);                  // splice: L0 → 0 (fade-out), L1 → vol (fade-in)
  const g0 = t._levelGains[0].gain, g1 = t._levelGains[1].gain;
  assert(g1._events[g1._events.length - 1] === tNow, 'fade-in level anchors setValueAtTime at now (not now+lookahead)');
  assert(g1._curves[g1._curves.length - 1].start === tNow, 'fade-in level curve starts at now → no gap to render the target (full volume)');
  assert(g0._curves[g0._curves.length - 1].start === tNow, 'fade-out level curve also starts at now');
  assert(t._rampState[1].startTime === tNow, '_rampState.startTime tracks the now-anchor');
}
{
  sub('floor (fd=0) swap also anchors at now');
  const t = mkTrackWith2Levels();
  t.activateLevel(0, 5.0); t._advance(0.3);
  const tNow = t.engine.ctx.currentTime;
  t.activateLevel(1, 0);                     // instant swap → anti-click floor ramp
  const fe = t._levelGains[1].gain._events;  // [ setValueAtTime(now), linearRamp(now+floor) ]
  assert(fe[fe.length - 2] === tNow, 'floor swap anchors setValueAtTime at now (ramp endpoint follows)');
  assert(fe[fe.length - 1] === tNow + PFATrack._FADE_ANTICLICK_FLOOR, 'floor ramp ends at now + anti-click floor');
  assert(t._rampState[1].startTime === tNow, 'floor swap _rampState.startTime == now');
}
{
  sub('_rampLevelGain anchors at now too');
  const t = mkTrackWith2Levels();
  t.activateLevel(0, 5.0); t._advance(0.5);
  const tNow = t.engine.ctx.currentTime;
  t._rampLevelGain(0, 0, 4.0);
  assert(t._levelGains[0].gain._curves.slice(-1)[0].start === tNow, '_rampLevelGain curve starts at now');
  assert(t._rampState[0].startTime === tNow, '_rampLevelGain _rampState.startTime == now');
}

// ═════════════════════════════════════════════════════════════════════
header('8. Event-gain fade anchors at ctx.currentTime — NO lookahead (death-music stop pop fix)');
// ═════════════════════════════════════════════════════════════════════
// `_tweenEventGain` used to anchor at `_now()` (= ctx.currentTime + 5ms). That [now, anchor)
// gap is rendered by Web Audio at the gain's INTRINSIC value — full for a playing event — so a
// stop()/anti-click fired at the END of a fade-out (live ≈ 0 but intrinsic ≈ full) pops to FULL
// for those few ms: the death-music crossfade "прорвала громкость" click. Confirmed + fixed via
// OfflineAudioContext (peak 1.0 with the lookahead → ~0.04 without). Lock the mechanism the mock
// can see: every event fade anchors at ctx.currentTime, not now+lookahead.
{
  const ev = mkEvent(1);
  ev._advance(0.33);
  const tNow = ev.engine.ctx.currentTime;
  ev.fadeOut(0.15); ev._clearTimer();
  const e = ev._gainParam._events, c = ev._gainParam._curves;
  assert(e[e.length - 1] === tNow, 'fadeOut setValueAtTime anchors at ctx.currentTime (not now+lookahead)');
  assert(c[c.length - 1].start === tNow, 'fadeOut curve starts at ctx.currentTime → no gap to revert to intrinsic full');
}
{
  sub('fadeIn likewise — no 5ms pop-to-full at the start of an event fade-in');
  const ev = mkEvent(1);
  ev._advance(1.5);
  const tNow = ev.engine.ctx.currentTime;
  ev.fadeIn(0.3);
  const c = ev._gainParam._curves;
  assert(c[c.length - 1].start === tNow, 'fadeIn curve starts at ctx.currentTime');
}

// ═════════════════════════════════════════════════════════════════════
header('9. play_chance future boundary inside an active level fade — no freeze');
// ═════════════════════════════════════════════════════════════════════
// The Conductor schedules a play_chance gain change at a FUTURE musical boundary t0 on
// track._levelGains[level] (PFAEvent._applyChanceGain). If a level fade curve (activateLevel /
// _rampLevelGain) is in flight and its window straddles t0, the old cancelScheduledValues(t0) +
// setValueAtTime(prevIntended, t0) landed inside the live curve → NotSupportedError → the
// conductor tick threw and _scheduleNextBarTick never re-armed (latent freeze, same class as
// §2/§6). Fix: when a fade crosses t0, cancelAndHoldAtTime(t0) lets the curve run to t0, holds
// its real value, and ramps from there; otherwise keep the boundary-deferred anchor. Continuity
// verified against real Web Audio via OfflineAudioContext (fade-in preserved 0→0.707 through t0,
// then a clean ramp; common case holds prevIntended until t0 — boundary-aligned, no early ramp).
function mkEventOverTrack(track) {
  const ev = Object.create(PFAEvent.prototype);
  ev.engine = track.engine;          // share ctx so currentTime advances via track._advance
  return ev;
}
{
  // OVERLAP: level-0 fade-in [now=0 .. 5s] in flight; conductor fires at 0.7s, boundary t0=1.5 (inside)
  const t = mkTrackWith2Levels();
  t.chanceFadeMode = 'instant';
  t.activateLevel(0, 5.0);
  t._advance(0.7);
  const ev = mkEventOverTrack(t);
  assertNoThrow(() => ev._applyChanceGain(t, 0, false, 1.5),
    'future chance MUTE inside an active level fade — no throw (cancelAndHold path)');
  assert(t._pendingChanceGain && t._pendingChanceGain.startTime === 1.5,
    'pending chance ramp recorded at the boundary t0=1.5');
  assert(t._levelGains[0].gain._curves.every(c => c.end <= 1.5 + 1e-9),
    'the live fade curve was truncated at t0 — no window reserved past the boundary');
}
{
  sub('the OLD sequence would have thrown here (mechanism guard)');
  const t = mkTrackWith2Levels();
  t.activateLevel(0, 5.0);
  t._advance(0.7);
  const g = t._levelGains[0].gain;
  g.cancelScheduledValues(1.5);   // pre-fix step 1: curve start 0 < 1.5 → strict mock keeps it
  assertThrows(() => g.setValueAtTime(1.0, 1.5),
    'pre-fix cancelScheduledValues(t0) + setValueAtTime(prevIntended, t0) THROWS inside the live curve');
}
{
  sub('COMMON case (no fade crossing t0) still defers to the boundary');
  const t = mkTrackWith2Levels();
  t._intendedGains[0] = 0.5; t._levelGains[0].gain.value = 0.5;
  const ev = mkEventOverTrack(t);    // currentTime 0, no active fade, _rampState empty
  assertNoThrow(() => ev._applyChanceGain(t, 0, false, 1.0),
    'future chance mute with no active fade — no throw');
  assert(t._levelGains[0].gain._events.includes(1.0),
    'deferred: setValueAtTime anchored AT the boundary t0=1.0 (not ramped early from now)');
}

// ── Summary ───────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed === 0 ? 0 : 1);
