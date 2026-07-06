#!/usr/bin/env node
/**
 * PFA Engine — per-event Start fade + Release fade
 *
 * Editor side (committed 3ca9b45 on the editor repo) authors two new per-event
 * fades, DISTINCT from the level-crossfade fade_duration:
 *   - start_fade   {duration, curve} — applied on play()/event entry
 *   - release_fade {duration, curve} — applied on stop()
 * FMOD AHDSR-release / Wwise Stop-Action analog. This suite locks the engine side:
 *
 *   1. PFAEvent parses start_fade/release_fade (defaults {0, equal_power}).
 *   2. play() fades the event gain in over start_fade.duration/curve — but a node
 *      entry fade_in marker OVERRIDES it (node > event, mirrors the editor's
 *      _event_start_fade_overridden); a plain node graph with no entry fade still
 *      uses start_fade.
 *   3. PFA.stop(name) resolves the fade from the event's release_fade; an explicit
 *      `fade` arg is a per-call OVERRIDE (Wwise-style); duration 0 → immediate
 *      stop (anti-click floor). Back-compat: an event with no release_fade stops
 *      immediately exactly as before.
 *
 * We eval the REAL src/index.js (not a port) and drive play()/stop() against a
 * recording mock AudioParam (same loader/mock family as test-event-fade-overlap).
 *
 * Usage: node test-event-start-release-fade.js
 */

const fs = require('fs');
const path = require('path');

// ── Load the real PFA/PFAEvent from source ───────────────────────────
function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack };';
  return new Function('window', src)(undefined);
}
const { PFA, PFAEvent } = loadEngine();

// ── Tiny test harness (house convention) ─────────────────────────────
let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }
function near(a, b, eps = 1e-4) { return Math.abs(a - b) < eps; }

// ── Recording mock AudioParam — captures curve windows + ramp/set events ──
// _curves: { start, end } from setValueCurveAtTime (non-linear fades).
// _events: { t, v, kind } from setValueAtTime / linearRampToValueAtTime (linear).
function mkRecParam(initial = 1) {
  return {
    value: initial,
    _curves: [],
    _events: [],
    setValueAtTime(v, t) { this._events.push({ t, v, kind: 'set' }); this.value = v; },
    linearRampToValueAtTime(v, t) { this._events.push({ t, v, kind: 'lin' }); this.value = v; },
    exponentialRampToValueAtTime(v, t) { this._events.push({ t, v, kind: 'exp' }); this.value = v; },
    setValueCurveAtTime(arr, t0, dur) { this._curves.push({ start: t0, end: t0 + dur }); this.value = arr[arr.length - 1]; },
    cancelScheduledValues() { /* recording mock — keep history for assertions */ },
  };
}

// Build a real PFAEvent (full constructor → real start_fade/release_fade parse),
// then attach a mock event gain + stub the heavy collaborators so play() reduces
// to "decide the entry fade, ramp the event gain". _enterNode / _startConductor
// are downstream of the start-fade decision, so stubbing them is safe.
function mkPlayableEvent(data) {
  let T = 0;
  const gainParam = mkRecParam(0.0001);
  const engine = {
    _now: () => T,
    ctx: { get currentTime() { return T; }, createGain: () => ({ gain: mkRecParam(1), connect() {}, disconnect() {} }) },
    masterGain: {},
  };
  const ev = new PFAEvent('e', data, engine);
  ev._eventGain = { gain: gainParam, connect() {}, disconnect() {} };
  ev._ensureGain = () => {};
  ev._startConductor = () => {};
  ev._enterNode = () => {};
  ev._emitTransitionInfo = () => {};
  ev._gainParam = gainParam;
  return ev;
}

// Drive PFA.prototype.stop against a spy event without the full PFA constructor.
function mkPfaStop(releaseFade) {
  const calls = { fadeOut: null, stop: 0, stopped: null };
  const event = {
    releaseFade,
    fadeOut: (dur, curve) => { calls.fadeOut = { dur, curve }; },
    stop: () => { calls.stop++; },
  };
  const pfa = Object.create(PFA.prototype);
  pfa._getEvent = () => event;
  pfa.onEventStopped = (n) => { calls.stopped = n; };
  return { pfa, calls };
}

// ═════════════════════════════════════════════════════════════════════
header('1. Config parsing — start_fade / release_fade on PFAEvent');
// ═════════════════════════════════════════════════════════════════════
{
  const ev = new PFAEvent('e', {
    start_fade: { duration: 2.5, curve: 's_curve' },
    release_fade: { duration: 1.0, curve: 'linear' },
  }, {});
  assert(near(ev.startFade.duration, 2.5), 'startFade.duration parsed (2.5)');
  assert(ev.startFade.curve === 's_curve', 'startFade.curve parsed (s_curve)');
  assert(near(ev.releaseFade.duration, 1.0), 'releaseFade.duration parsed (1.0)');
  assert(ev.releaseFade.curve === 'linear', 'releaseFade.curve parsed (linear)');
}
{
  sub('defaults when the config omits the fields');
  const ev = new PFAEvent('e', {}, {});
  assert(near(ev.startFade.duration, 0.0), 'startFade defaults to duration 0');
  assert(ev.startFade.curve === 'equal_power', 'startFade defaults to equal_power');
  assert(near(ev.releaseFade.duration, 0.0), 'releaseFade defaults to duration 0');
  assert(ev.releaseFade.curve === 'equal_power', 'releaseFade defaults to equal_power');
}

// ═════════════════════════════════════════════════════════════════════
header('2. play() — Start fade applied to the event gain (Simple mode)');
// ═════════════════════════════════════════════════════════════════════
{
  const ev = mkPlayableEvent({ start_fade: { duration: 1.5, curve: 'equal_power' } });
  ev.play();
  const c = ev._gainParam._curves;
  assert(c.length === 1, 'one event-gain fade curve scheduled on fresh play');
  assert(c.length === 1 && near(c[0].end - c[0].start, 1.5), 'Start fade-in lasts start_fade.duration (1.5s), not the 0.02 floor');
}
{
  sub('no start_fade → keeps the ~20ms anti-click floor (back-compat)');
  const ev = mkPlayableEvent({});                  // defaults {0, equal_power}
  ev.play();
  const c = ev._gainParam._curves;
  assert(c.length === 1 && near(c[0].end - c[0].start, 0.02), 'entry ramp stays 0.02s when start_fade.duration is 0');
}

// ═════════════════════════════════════════════════════════════════════
header('3. play() — node graph entry fade OVERRIDES start_fade (node > event)');
// ═════════════════════════════════════════════════════════════════════
{
  const ev = mkPlayableEvent({
    use_nodes: true,
    node_graph: { entry_node: 'n1', nodes: { n1: { entry_fade: { fade_duration: 3.0, fade_curve: 's_curve' } } } },
    start_fade: { duration: 1.0, curve: 'equal_power' },
  });
  ev.play();
  const c = ev._gainParam._curves;
  assert(c.length === 1 && near(c[0].end - c[0].start, 3.0), 'entry fade_in (3.0s) wins — start_fade (1.0s) is ignored in node mode');
}
{
  sub('node graph WITHOUT an entry fade → start_fade still applies');
  const ev = mkPlayableEvent({
    use_nodes: true,
    node_graph: { entry_node: 'n1', nodes: { n1: {} } },   // plain loop, no entry_fade
    start_fade: { duration: 1.25, curve: 'equal_power' },
  });
  ev.play();
  const c = ev._gainParam._curves;
  assert(c.length === 1 && near(c[0].end - c[0].start, 1.25), 'start_fade (1.25s) applies when the entry node has no fade marker');
}

// ═════════════════════════════════════════════════════════════════════
header('4. PFA.stop() — release_fade resolution + override semantics');
// ═════════════════════════════════════════════════════════════════════
{
  sub('no arg → use the event release_fade');
  const { pfa, calls } = mkPfaStop({ duration: 1.2, curve: 's_curve' });
  pfa.stop('e');
  assert(calls.fadeOut !== null && near(calls.fadeOut.dur, 1.2), 'fadeOut uses release_fade.duration (1.2)');
  assert(calls.fadeOut && calls.fadeOut.curve === 's_curve', 'fadeOut uses release_fade.curve (s_curve)');
  assert(calls.stop === 0, 'did not take the immediate path');
  assert(calls.stopped === 'e', 'onEventStopped still fired');
}
{
  sub('release_fade duration 0 → immediate stop');
  const { pfa, calls } = mkPfaStop({ duration: 0.0, curve: 'equal_power' });
  pfa.stop('e');
  assert(calls.stop === 1 && calls.fadeOut === null, 'event.stop() (anti-click floor), no fadeOut');
}
{
  sub('explicit fade arg OVERRIDES release_fade (Wwise-style)');
  const { pfa, calls } = mkPfaStop({ duration: 2.0, curve: 'linear' });
  pfa.stop('e', 0.5);
  assert(calls.fadeOut !== null && near(calls.fadeOut.dur, 0.5), 'override duration (0.5) wins over release_fade (2.0)');
  assert(calls.fadeOut && calls.fadeOut.curve === 'linear', 'override keeps the authored release curve');
}
{
  sub('explicit fade arg of 0 → immediate, even if release_fade is set');
  const { pfa, calls } = mkPfaStop({ duration: 2.0, curve: 'equal_power' });
  pfa.stop('e', 0);
  assert(calls.stop === 1 && calls.fadeOut === null, 'stop(name, 0) forces immediate');
}
{
  sub('back-compat — event with NO release_fade stops immediately on stop(name)');
  const { pfa, calls } = mkPfaStop(undefined);
  pfa.stop('e');
  assert(calls.stop === 1 && calls.fadeOut === null, 'undefined release_fade → immediate (legacy behavior preserved)');
}

// ── Summary ──────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed === 0 ? 0 : 1);
