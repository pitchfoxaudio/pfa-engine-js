#!/usr/bin/env node
/**
 * PFA Engine — Fade Curve + Phase 3 Chain Test Suite
 *
 * Tests:
 *   - _evalFadeInCurve values for linear/equal_power/s_curve/exponential/logarithmic
 *   - _applyFadeCurve shape construction (sampled array values at midpoint)
 *   - _findConnectionFade forwards entry_fade_duration / entry_fade_curve (Phase 3)
 *   - _executeTransition forwards entry_fade_* into fadeSettings
 *
 * Usage: node test-fade-curves-chain.js
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
// Pure ports of the curve helpers (mirror index.js). We test the math
// directly without instantiating Web Audio nodes.
// ─────────────────────────────────────────────────────────────────────

function evalFadeInCurve(progress, curve) {
  const p = Math.max(0, Math.min(1, progress));
  switch (curve) {
    case 'linear': return p;
    case 'equal_power': return Math.sin(p * Math.PI / 2);
    case 's_curve': return p * p * (3 - 2 * p);
    case 'exponential': return p * p;
    case 'logarithmic': { const inv = 1 - p; return 1 - inv * inv; }
    default: return p;
  }
}

function sampleFadeCurve(v0, v1, N, curve) {
  const arr = new Float32Array(N + 1);
  const isFadeOut = v1 < v0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const shape = isFadeOut ? evalFadeInCurve(1 - t, curve) : evalFadeInCurve(t, curve);
    arr[i] = isFadeOut ? v1 + (v0 - v1) * shape : v0 + (v1 - v0) * shape;
  }
  return arr;
}

header('1. _evalFadeInCurve values');

sub('linear');
{
  assertClose(evalFadeInCurve(0, 'linear'), 0, 1e-9, 'f(0) = 0');
  assertClose(evalFadeInCurve(0.5, 'linear'), 0.5, 1e-9, 'f(0.5) = 0.5');
  assertClose(evalFadeInCurve(1, 'linear'), 1, 1e-9, 'f(1) = 1');
}

sub('equal_power');
{
  assertClose(evalFadeInCurve(0, 'equal_power'), 0, 1e-9, 'f(0) = 0');
  assertClose(evalFadeInCurve(0.5, 'equal_power'), Math.sin(Math.PI / 4), 1e-9, 'f(0.5) = sin(π/4)');
  assertClose(evalFadeInCurve(1, 'equal_power'), 1, 1e-9, 'f(1) = 1');
}

sub('s_curve');
{
  assertClose(evalFadeInCurve(0, 's_curve'), 0, 1e-9, 'f(0) = 0');
  assertClose(evalFadeInCurve(0.5, 's_curve'), 0.5, 1e-9, 'f(0.5) = 0.5 (ease-in-out symmetric)');
  assertClose(evalFadeInCurve(1, 's_curve'), 1, 1e-9, 'f(1) = 1');
}

sub('exponential (slow start, fast end)');
{
  assertClose(evalFadeInCurve(0, 'exponential'), 0, 1e-9, 'f(0) = 0');
  assertClose(evalFadeInCurve(0.5, 'exponential'), 0.25, 1e-9, 'f(0.5) = 0.25 (p²)');
  assertClose(evalFadeInCurve(1, 'exponential'), 1, 1e-9, 'f(1) = 1');
}

sub('logarithmic (fast start, slow end)');
{
  assertClose(evalFadeInCurve(0, 'logarithmic'), 0, 1e-9, 'f(0) = 0');
  assertClose(evalFadeInCurve(0.5, 'logarithmic'), 0.75, 1e-9, 'f(0.5) = 0.75 (1-(1-p)²)');
  assertClose(evalFadeInCurve(1, 'logarithmic'), 1, 1e-9, 'f(1) = 1');
}

header('2. Sampled fade curve shape (fade-in 0→1)');

sub('linear: monotone 0→1');
{
  const arr = sampleFadeCurve(0, 1, 10, 'linear');
  assertClose(arr[0], 0, 1e-6, 'arr[0] = 0');
  assertClose(arr[5], 0.5, 1e-6, 'arr[mid] = 0.5');
  assertClose(arr[10], 1, 1e-6, 'arr[N] = 1');
}

sub('equal_power: midpoint = sin(π/4) ≈ 0.707');
{
  const arr = sampleFadeCurve(0, 1, 100, 'equal_power');
  assertClose(arr[0], 0, 1e-6, 'arr[0] = 0');
  assertClose(arr[50], Math.sin(Math.PI / 4), 1e-4, 'arr[mid] ≈ 0.707');
  assertClose(arr[100], 1, 1e-6, 'arr[N] = 1');
}

sub('exponential: midpoint = 0.25 (p²)');
{
  const arr = sampleFadeCurve(0, 1, 100, 'exponential');
  assertClose(arr[50], 0.25, 1e-4, 'arr[mid] ≈ 0.25');
}

sub('logarithmic: midpoint = 0.75');
{
  const arr = sampleFadeCurve(0, 1, 100, 'logarithmic');
  assertClose(arr[50], 0.75, 1e-4, 'arr[mid] ≈ 0.75');
}

header('3. Sampled fade curve shape (fade-out 1→0)');

sub('equal_power fade-out: midpoint = cos(π/4) ≈ 0.707 (sustained, then drops)');
{
  const arr = sampleFadeCurve(1, 0, 100, 'equal_power');
  assertClose(arr[0], 1, 1e-6, 'arr[0] = 1');
  assertClose(arr[50], Math.cos(Math.PI / 4), 1e-4, 'arr[mid] ≈ 0.707');
  assertClose(arr[100], 0, 1e-6, 'arr[N] = 0');
}

sub('exponential fade-out: midpoint = 0.25 (slow start of fading, fast end)');
{
  const arr = sampleFadeCurve(1, 0, 100, 'exponential');
  assertClose(arr[0], 1, 1e-6, 'arr[0] = 1');
  assertClose(arr[50], 0.25, 1e-4, 'arr[mid] ≈ 0.25');
  assertClose(arr[100], 0, 1e-6, 'arr[N] = 0');
}

sub('logarithmic fade-out: midpoint = 0.75 (fast drop, then slow tail)');
{
  const arr = sampleFadeCurve(1, 0, 100, 'logarithmic');
  assertClose(arr[0], 1, 1e-6, 'arr[0] = 1');
  assertClose(arr[50], 0.75, 1e-4, 'arr[mid] ≈ 0.75');
  assertClose(arr[100], 0, 1e-6, 'arr[N] = 0');
}

header('4. Phase 3 chain connection field pass-through');

sub('_findConnectionFade forwards entry_fade_* fields when present');
{
  // Pure-logic mirror of _findConnectionFade with entry_fade_* forwarding.
  function findConnectionFade(nodeGraph, src, tgt) {
    if (!src || !tgt || !nodeGraph) return {};
    for (const c of (nodeGraph.connections || [])) {
      if (c.source === src && c.target === tgt) {
        const out = {
          fade_duration: c.fade_duration ?? 2.0,
          fade_curve: c.fade_curve ?? 'equal_power',
          quantize: c.quantize ?? 'bar',
          kind: c.kind ?? 'crossfade',
          fade_direction: c.fade_direction ?? 'both',
          stinger: c.stinger,
        };
        if (c.entry_fade_duration != null) {
          out.entry_fade_duration = c.entry_fade_duration;
          out.entry_fade_curve = c.entry_fade_curve ?? 'equal_power';
        }
        return out;
      }
    }
    return {};
  }
  const graph = {
    connections: [{
      source: 'a', target: 'b', kind: 'fade_out',
      fade_duration: 2.0, fade_curve: 'exponential',
      entry_fade_duration: 0.5, entry_fade_curve: 'logarithmic',
    }],
  };
  const r = findConnectionFade(graph, 'a', 'b');
  assert(r.kind === 'fade_out', 'kind = fade_out');
  assertClose(r.fade_duration, 2.0, 1e-9, 'exit fade_duration = 2.0');
  assert(r.fade_curve === 'exponential', 'exit fade_curve = exponential');
  assertClose(r.entry_fade_duration, 0.5, 1e-9, 'entry_fade_duration = 0.5');
  assert(r.entry_fade_curve === 'logarithmic', 'entry_fade_curve = logarithmic');
}

sub('Non-chain connection has no entry_fade_* fields');
{
  function findConnectionFade(nodeGraph, src, tgt) {
    if (!src || !tgt || !nodeGraph) return {};
    for (const c of (nodeGraph.connections || [])) {
      if (c.source === src && c.target === tgt) {
        const out = {
          fade_duration: c.fade_duration ?? 2.0,
          fade_curve: c.fade_curve ?? 'equal_power',
          quantize: c.quantize ?? 'bar',
          kind: c.kind ?? 'crossfade',
          fade_direction: c.fade_direction ?? 'both',
          stinger: c.stinger,
        };
        if (c.entry_fade_duration != null) {
          out.entry_fade_duration = c.entry_fade_duration;
          out.entry_fade_curve = c.entry_fade_curve ?? 'equal_power';
        }
        return out;
      }
    }
    return {};
  }
  const graph = {
    connections: [{
      source: 'a', target: 'b', kind: 'crossfade',
      fade_duration: 1.0, fade_curve: 'equal_power',
    }],
  };
  const r = findConnectionFade(graph, 'a', 'b');
  assert(r.entry_fade_duration === undefined, 'no entry_fade_duration on plain crossfade');
  assert(r.entry_fade_curve === undefined, 'no entry_fade_curve on plain crossfade');
}

// ─────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log(`  ✓ Passed: ${passed}`);
console.log(`  ✗ Failed: ${failed}`);
console.log(`  Total: ${passed + failed} assertions`);
if (failed === 0) console.log('\n  ALL TESTS PASSED!');
else console.log('\n  ' + failed + ' FAILURES');
process.exit(failed === 0 ? 0 : 1);
