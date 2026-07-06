#!/usr/bin/env node
/**
 * PFA Engine — simple-mode level crossfade threads the authored fade_curve
 * (regression pin for da22d3b; Godot mirror: test_event_fades.gd §4 / 6f56bbc).
 *
 * Bug: _crossfadeLevel called track.activateLevel(level, fadeDuration) WITHOUT
 * the curve, so every simple-mode setLevel ramped with the equal_power default —
 * a front-loaded shape that sounds much faster than the authored duration even
 * when the editor's Curve dropdown said Linear (heard on the fox-run forest
 * layer: "fade стоит 5с, но срабатывает гораздо быстрее").
 *
 * Loads the REAL src/index.js and drives PFAEvent._crossfadeLevel / setLevel
 * against spy tracks that record what activateLevel receives.
 *
 * Usage: node test-level-crossfade-curve.js
 */

const fs = require('fs');
const path = require('path');

// ── Load the real classes from source (house convention) ─────────────
function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack };';
  return new Function('window', src)(undefined);
}
const { PFAEvent } = loadEngine();

// ── Tiny test harness (house convention) ─────────────────────────────
let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function assert(c, m) { if (c) { passed++; console.log('    ✓ ' + m); } else { failed++; console.log('    ✗ FAIL: ' + m); } }

function mkSpyTrack(behavior = 'level_specific') {
  return { levelBehavior: behavior, calls: [], activateLevel(level, fd, curve) { this.calls.push({ level, fd, curve }); } };
}

function mkEvent(data) {
  const engine = { _now: () => 0, ctx: { currentTime: 0, createGain: () => ({ gain: {}, connect() {}, disconnect() {} }) } };
  const ev = new PFAEvent('e', Object.assign({ type: 'music', tracks: [] }, data), engine);
  ev._emitTransitionInfo = () => {};
  return ev;
}

header('Simple-mode level crossfade — authored fade_curve threading (da22d3b)');

// ═════════════════════════════════════════════════════════════════════
sub('_crossfadeLevel passes the authored fadeCurve + fadeDuration');
{
  const ev = mkEvent({ fade_duration: 5.1, fade_curve: 'linear' });
  const always = mkSpyTrack('always_play');
  const spy = mkSpyTrack('level_specific');
  ev.tracks = [always, spy];
  ev._crossfadeLevel(0, 1);
  assert(always.calls.length === 0, 'always_play track skipped (no level ramp)');
  assert(spy.calls.length === 1, 'level_specific track activated exactly once');
  assert(spy.calls[0].curve === 'linear', `authored fade_curve (linear) threaded — NOT the equal_power default (got "${spy.calls[0].curve}")`);
  assert(spy.calls[0].fd === 5.1, `fade_duration (5.1s) threaded (got ${spy.calls[0].fd})`);
  assert(spy.calls[0].level === 1, 'target level threaded');
}

// ═════════════════════════════════════════════════════════════════════
sub('no authored curve → equal_power default (back-compat)');
{
  const ev = mkEvent({ fade_duration: 2.0 });   // no fade_curve in config
  const spy = mkSpyTrack('level_specific');
  ev.tracks = [spy];
  ev._crossfadeLevel(0, 1);
  assert(spy.calls.length === 1 && spy.calls[0].curve === 'equal_power', 'missing fade_curve defaults to equal_power (legacy configs unchanged)');
}

// ═════════════════════════════════════════════════════════════════════
sub('every editor curve name survives the trip');
{
  for (const curve of ['linear', 'equal_power', 's_curve', 'exponential', 'logarithmic']) {
    const ev = mkEvent({ fade_duration: 1.0, fade_curve: curve });
    const spy = mkSpyTrack('level_specific');
    ev.tracks = [spy];
    ev._crossfadeLevel(0, 1);
    assert(spy.calls[0].curve === curve, `"${curve}" reaches activateLevel verbatim`);
  }
}

// ═════════════════════════════════════════════════════════════════════
sub('setLevel instant path drives the same threading (music, playing)');
{
  const ev = mkEvent({ fade_duration: 3.0, fade_curve: 's_curve', levels: [{}, {}] });
  ev.levels = [{}, {}];
  ev.isPlaying = true;
  ev.switchQuantization = 'instant';
  const spy = mkSpyTrack('level_specific');
  ev.tracks = [spy];
  ev.setLevel(1);
  assert(spy.calls.length === 1 && spy.calls[0].curve === 's_curve', 'setLevel → _crossfadeLevel → activateLevel carries the authored curve end-to-end');
  assert(ev.currentLevel === 1, 'level switched');
}

console.log('\n' + '═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
