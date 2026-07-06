#!/usr/bin/env node
/**
 * PFA Engine — SFX trim+fade envelope test suite
 *
 * Verifies the Web Audio automation sequence produced by
 * PFATrack._applySfxFadeEnvelope (index.js) for a one-shot SFX voice gain.
 *
 * Reference behavior = editor RegionClip._apply_fades (core/region_clip.py):
 *   - fade_in:  linear amplitude ramp 0 -> target over [start, start + fade_in]
 *   - fade_out: linear amplitude ramp target -> 0 ending at the window end,
 *               starting at (start + playLen - fade_out); one-shot only
 *   - fades clamped to fit inside the window (ratio preserved)
 *
 * Real footsteps_simple_variations numbers are used where possible
 * (run/Track 2 clip: offset 0.038, len 0.538, fade_in 0.0167, fade_out 0.2098).
 *
 * Pure port of the envelope helper (mirrors index.js) — tested against a mock
 * AudioParam, matching the house convention (see test-fade-curves-chain.js).
 *
 * Usage: node test-sfx-fades.js
 */

let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(msg) { passed++; console.log(`    ✓ ${msg}`); }
function fail(msg) { failed++; console.log(`    ✗ FAIL: ${msg}`); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }
function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) <= tol) ok(`${msg} (got ${a.toFixed(5)}, expected ${b.toFixed(5)})`);
  else fail(`${msg} (got ${a}, expected ${b} ±${tol})`);
}

// ─────────────────────────────────────────────────────────────────────
// Mock AudioParam — records the automation event sequence.
// ─────────────────────────────────────────────────────────────────────
function makeParam() {
  const events = [];
  return {
    events,
    setValueAtTime(value, time) { events.push({ type: 'set', value, time }); },
    linearRampToValueAtTime(value, time) { events.push({ type: 'ramp', value, time }); },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pure port of PFATrack._applySfxFadeEnvelope (mirror of index.js).
// ─────────────────────────────────────────────────────────────────────
function applySfxFadeEnvelope(gainParam, target, startTime, playLen, clip) {
  let fadeIn = clip ? (clip.fadeIn || 0) : 0;
  let fadeOut = clip ? (clip.fadeOut || 0) : 0;

  if (fadeIn <= 0 && fadeOut <= 0) {
    gainParam.setValueAtTime(target, startTime);
    return;
  }

  if (playLen > 0 && fadeIn + fadeOut > playLen) {
    const scale = playLen / (fadeIn + fadeOut);
    fadeIn *= scale;
    fadeOut *= scale;
  }

  if (fadeIn > 0) {
    gainParam.setValueAtTime(0, startTime);
    gainParam.linearRampToValueAtTime(target, startTime + fadeIn);
  } else {
    gainParam.setValueAtTime(target, startTime);
  }

  if (fadeOut > 0) {
    gainParam.setValueAtTime(target, startTime + playLen - fadeOut);
    gainParam.linearRampToValueAtTime(0, startTime + playLen);
  }
}

const T0 = 10.0;       // scheduled start time (arbitrary ctx time)
const TARGET = 0.8;    // steady-state amplitude
const TOL = 1e-6;

header('1. No fades — steady gain');
{
  const p = makeParam();
  applySfxFadeEnvelope(p, TARGET, T0, 0.5, { fadeIn: 0, fadeOut: 0 });
  assert(p.events.length === 1, 'emits exactly one event');
  assert(p.events[0].type === 'set', 'event is setValueAtTime');
  assertClose(p.events[0].value, TARGET, TOL, 'value = target');
  assertClose(p.events[0].time, T0, TOL, 'time = startTime');
}

sub('null clip behaves like no fades');
{
  const p = makeParam();
  applySfxFadeEnvelope(p, TARGET, T0, 0.5, null);
  assert(p.events.length === 1 && p.events[0].type === 'set', 'one setValueAtTime, no crash on null clip');
  assertClose(p.events[0].value, TARGET, TOL, 'value = target');
}

header('2. Fade in only');
{
  const p = makeParam();
  applySfxFadeEnvelope(p, TARGET, T0, 0.5, { fadeIn: 0.05, fadeOut: 0 });
  assert(p.events.length === 2, 'two events (set 0 + ramp up)');
  assert(p.events[0].type === 'set', 'first is setValueAtTime');
  assertClose(p.events[0].value, 0, TOL, 'starts at 0');
  assertClose(p.events[0].time, T0, TOL, 'set at startTime');
  assert(p.events[1].type === 'ramp', 'second is linearRamp');
  assertClose(p.events[1].value, TARGET, TOL, 'ramps to target');
  assertClose(p.events[1].time, T0 + 0.05, TOL, 'ramp ends at start + fadeIn');
}

header('3. Fade out only');
{
  const p = makeParam();
  const playLen = 0.538;
  applySfxFadeEnvelope(p, TARGET, T0, playLen, { fadeIn: 0, fadeOut: 0.2 });
  assert(p.events.length === 3, 'three events (set target + set target@fadeStart + ramp 0)');
  assertClose(p.events[0].value, TARGET, TOL, 'opens at target');
  assertClose(p.events[0].time, T0, TOL, 'opens at startTime');
  assert(p.events[1].type === 'set', 'fade-out anchor is setValueAtTime');
  assertClose(p.events[1].time, T0 + playLen - 0.2, TOL, 'fade-out starts at end - fadeOut');
  assert(p.events[2].type === 'ramp', 'last is linearRamp');
  assertClose(p.events[2].value, 0, TOL, 'ramps to 0');
  assertClose(p.events[2].time, T0 + playLen, TOL, 'fade-out ends at window end');
}

header('4. Both fades — real footsteps run/Track 2 clip');
{
  const p = makeParam();
  const playLen = 0.538, fadeIn = 0.0167, fadeOut = 0.2098;
  applySfxFadeEnvelope(p, TARGET, T0, playLen, { fadeIn, fadeOut });
  assert(p.events.length === 4, 'four events (set 0, ramp up, set@fadeStart, ramp 0)');
  assertClose(p.events[0].value, 0, TOL, 'starts at 0');
  assertClose(p.events[1].value, TARGET, TOL, 'ramps up to target');
  assertClose(p.events[1].time, T0 + fadeIn, TOL, 'fade-in ends at start + fadeIn');
  assertClose(p.events[2].time, T0 + playLen - fadeOut, TOL, 'fade-out starts at end - fadeOut');
  assertClose(p.events[3].value, 0, TOL, 'ramps down to 0');
  assertClose(p.events[3].time, T0 + playLen, TOL, 'fade-out ends at window end');
  // Steady region exists between fades for this clip (fadeIn + fadeOut < playLen)
  assert(fadeIn + fadeOut < playLen, 'no clamp needed (sum < window)');
}

header('5. Overlapping fades — clamped to window, ratio preserved');
{
  const p = makeParam();
  const playLen = 0.5, fadeIn = 0.4, fadeOut = 0.4; // sum 0.8 > 0.5
  applySfxFadeEnvelope(p, TARGET, T0, playLen, { fadeIn, fadeOut });
  // scale = 0.5 / 0.8 = 0.625 → fadeIn' = 0.25, fadeOut' = 0.25
  const fInEnd = p.events[1].time - T0;
  const fOutStart = p.events[2].time - T0;
  assertClose(fInEnd, 0.25, 1e-5, 'clamped fade-in ends at 0.25 (0.4 × 0.625)');
  assertClose(fOutStart, 0.25, 1e-5, 'clamped fade-out starts at 0.25 (window - 0.25)');
  assert(fInEnd <= playLen && fOutStart >= 0, 'fades stay inside the window');
  assertClose(fInEnd, fOutStart, 1e-5, 'equal fades meet at the midpoint (triangle envelope)');
  assertClose(p.events[3].time - T0, playLen, TOL, 'fade-out still ends exactly at window end');
}

header('6. Fade-out positioning matches editor (fade_start = play_len - fade_out)');
{
  // Editor: result[i] *= 1 - (abs_pos - fade_start)/fade_out  for abs_pos in [fade_start, play_len)
  // Engine fade-out anchor time must equal start + (play_len - fade_out).
  const p = makeParam();
  const playLen = 1.0, fadeOut = 0.3;
  applySfxFadeEnvelope(p, TARGET, T0, playLen, { fadeIn: 0, fadeOut });
  const anchor = p.events[1]; // set target at fade start
  assertClose(anchor.time - T0, playLen - fadeOut, TOL, 'fade-out begins at play_len - fade_out (= 0.7)');
}

console.log('\n' + '═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
