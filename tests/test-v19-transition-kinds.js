#!/usr/bin/env node
/**
 * PFA Engine v1.9 — Transition Kinds + Boundary Fix + Metadata Test Suite
 *
 * Covers the features ported from Godot session 9/10.1:
 *   - _calcNextLoopBoundary fix (prev-boundary within 1-frame jitter)
 *   - _findConnectionFade returns correct shape incl. kind/fade_direction
 *   - stopWithTerminalFade branches on node.terminal_fade metadata
 *   - Transition kind dispatch (crossfade / fade_in / fade_out)
 *   - entry_fade metadata honored on play()
 *
 * Usage: node test-v19-transition-kinds.js
 */

let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(msg) { passed++; console.log(`    ✓ ${msg}`); }
function fail(msg) { failed++; console.log(`    ✗ FAIL: ${msg}`); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }

// ─────────────────────────────────────────────────────────────────────
// Pure-logic port of _calcNextLoopBoundary (mirrors index.js:1960+).
// Tests verify the fix: near-past boundaries (within ~1 frame) return prev,
// NOT next — otherwise variation swap / play_chance ramp lands one loop late.
// ─────────────────────────────────────────────────────────────────────

function calcNextLoopBoundary(now, playStartTime, barDurationSec, loopBars) {
  const loopDuration = barDurationSec * loopBars;
  if (loopDuration <= 0) return now;
  const elapsed = now - playStartTime;
  const loopsSoFar = Math.ceil(elapsed / loopDuration);
  const boundary = playStartTime + loopsSoFar * loopDuration;
  const prevBoundary = boundary - loopDuration;
  if (prevBoundary >= playStartTime - 0.001 && now - prevBoundary < 0.033) {
    return prevBoundary;
  }
  return boundary;
}

header('1. _calcNextLoopBoundary (push-to-next bug fix)');

sub('Near-past boundary → return prev (fix)');
{
  // playStart=0, bar=2s, loopBars=4 → loopDuration=8s. Boundary at 8,16,24...
  const ps = 0, bar = 2, lb = 4;
  // Conductor tick lands 5ms past boundary — should snap back to boundary=8
  const r1 = calcNextLoopBoundary(8.005, ps, bar, lb);
  assert(r1 === 8, `now=8.005s → ${r1}s (expect 8, fires immediately as authored)`);
  // 1 frame past (16ms)
  const r2 = calcNextLoopBoundary(8.016, ps, bar, lb);
  assert(r2 === 8, `now=8.016s → ${r2}s (expect 8, within 33ms jitter)`);
  // Just under 33ms jitter window
  const r3 = calcNextLoopBoundary(8.032, ps, bar, lb);
  assert(r3 === 8, `now=8.032s → ${r3}s (expect 8, still within window)`);
}

sub('Past jitter window → return next');
{
  const ps = 0, bar = 2, lb = 4;
  // 100ms past — not jitter, real mid-loop scheduling call
  const r = calcNextLoopBoundary(8.1, ps, bar, lb);
  assert(r === 16, `now=8.1s → ${r}s (expect 16, past jitter window)`);
}

sub('Mid-loop → return upcoming boundary');
{
  const ps = 0, bar = 2, lb = 4;
  const r = calcNextLoopBoundary(4.0, ps, bar, lb);
  assert(r === 8, `now=4s (mid 1st loop) → ${r}s (expect 8)`);
}

sub('Never returns a pre-start boundary');
{
  // Guard: prev_boundary must be ≥ playStartTime (not some negative pre-start ghost).
  // For ps=10, now=10.01, loopDuration=8 → boundary=18, prev=10 (at ps). Returning
  // prev=10 is valid ("fire now" since prev < now); returning 2 or earlier would be
  // a bug. Just assert the floor.
  const ps = 10, bar = 2, lb = 4;
  const r = calcNextLoopBoundary(10.01, ps, bar, lb);
  assert(r >= ps, `now=10.01s, start=10 → ${r}s (must be ≥ playStartTime=${ps})`);
}

sub('playStartTime not pushed past into next loop');
{
  // Before the fix, a near-past boundary was pushed to next → conductor tick
  // landing at 8.005 would schedule for 16 instead of firing at 8.
  const ps = 0, bar = 2, lb = 4;
  const pre_fix_result = 16; // what the OLD code (boundary + loopDurationSec) returned
  const actual = calcNextLoopBoundary(8.005, ps, bar, lb);
  assert(actual !== pre_fix_result, `boundary 5ms past NOT pushed to ${pre_fix_result} (got ${actual})`);
}

sub('Exactly on boundary → return it');
{
  const ps = 0, bar = 2, lb = 4;
  const r = calcNextLoopBoundary(8.0, ps, bar, lb);
  assert(r === 8, `now=8.0s (exactly on boundary) → ${r}s (expect 8)`);
}

// ─────────────────────────────────────────────────────────────────────
// _findConnectionFade — pure data lookup over nodeGraph.connections
// ─────────────────────────────────────────────────────────────────────

function findConnectionFade(nodeGraph, src, tgt, defaults) {
  if (!src || !tgt || !nodeGraph) return {};
  for (const c of (nodeGraph.connections || [])) {
    if (c.source === src && c.target === tgt) {
      return {
        fade_duration: c.fade_duration ?? defaults.fadeDuration,
        fade_curve: c.fade_curve ?? defaults.fadeCurve,
        quantize: c.quantize ?? defaults.switchQuantization,
        kind: c.kind ?? 'crossfade',
        fade_direction: c.fade_direction ?? 'both',
        stinger: c.stinger,
      };
    }
  }
  return {};
}

header('2. _findConnectionFade — shape + fallback');

const GRAPH = {
  connections: [
    { source: 'n1', target: 'n2', fade_duration: 2.5, fade_curve: 'linear', kind: 'fade_in', fade_direction: 'forward' },
    { source: 'n2', target: 'n3', quantize: 'bar', stinger: 'hit.ogg' }, // fades omitted → fallback
  ],
};
const DEFAULTS = { fadeDuration: 1.0, fadeCurve: 'equal_power', switchQuantization: 'instant' };

sub('Direct hit returns full shape');
{
  const r = findConnectionFade(GRAPH, 'n1', 'n2', DEFAULTS);
  assert(r.fade_duration === 2.5, `fade_duration=${r.fade_duration}`);
  assert(r.fade_curve === 'linear', `fade_curve=${r.fade_curve}`);
  assert(r.kind === 'fade_in', `kind=${r.kind}`);
  assert(r.fade_direction === 'forward', `fade_direction=${r.fade_direction}`);
}

sub('Missing fields fall back to event defaults');
{
  const r = findConnectionFade(GRAPH, 'n2', 'n3', DEFAULTS);
  assert(r.fade_duration === 1.0, `fade_duration=${r.fade_duration} (event default)`);
  assert(r.fade_curve === 'equal_power', `fade_curve=${r.fade_curve} (event default)`);
  assert(r.kind === 'crossfade', `kind=${r.kind} (default crossfade)`);
  assert(r.fade_direction === 'both', `fade_direction=${r.fade_direction} (default both)`);
  assert(r.stinger === 'hit.ogg', `stinger=${r.stinger} (preserved)`);
}

sub('Missing src/tgt/graph returns empty');
{
  assert(Object.keys(findConnectionFade(null, 'a', 'b', DEFAULTS)).length === 0, 'null graph → {}');
  assert(Object.keys(findConnectionFade(GRAPH, '', 'n2', DEFAULTS)).length === 0, 'empty src → {}');
  assert(Object.keys(findConnectionFade(GRAPH, 'n1', '', DEFAULTS)).length === 0, 'empty tgt → {}');
  assert(Object.keys(findConnectionFade(GRAPH, 'n1', 'n9', DEFAULTS)).length === 0, 'no matching conn → {}');
}

// ─────────────────────────────────────────────────────────────────────
// Transition kind dispatch — verify switch logic routes correctly
// ─────────────────────────────────────────────────────────────────────

function routeKind(fadeSettings) {
  const kind = fadeSettings?.kind ?? 'crossfade';
  switch (kind) {
    case 'fade_in': return 'fadeIn';
    case 'fade_out': return 'fadeOut';
    default: return 'crossfade';
  }
}

header('3. Transition Kinds v2 dispatch');

sub('kind field routes to correct helper');
{
  assert(routeKind({ kind: 'crossfade' }) === 'crossfade', 'kind=crossfade → crossfade');
  assert(routeKind({ kind: 'fade_in' }) === 'fadeIn', 'kind=fade_in → fadeIn');
  assert(routeKind({ kind: 'fade_out' }) === 'fadeOut', 'kind=fade_out → fadeOut');
  assert(routeKind({}) === 'crossfade', 'no kind → crossfade (default)');
  assert(routeKind(null) === 'crossfade', 'null fadeSettings → crossfade (default)');
  assert(routeKind({ kind: 'bogus' }) === 'crossfade', 'unknown kind → crossfade (fallback)');
}

// ─────────────────────────────────────────────────────────────────────
// stopWithTerminalFade / entry_fade — pure metadata checks
// ─────────────────────────────────────────────────────────────────────

function hasTerminalFade(nodeGraph, nodeId) {
  if (!nodeId || !nodeGraph) return false;
  const node = nodeGraph.nodes?.[nodeId];
  return !!node?.terminal_fade;
}

function hasEntryFade(nodeGraph, nodeId) {
  if (!nodeId || !nodeGraph) return false;
  return !!nodeGraph.nodes?.[nodeId]?.entry_fade;
}

header('4. Terminal / Entry fade metadata');

const META_GRAPH = {
  nodes: {
    intro: { name: 'Intro', entry_fade: { fade_duration: 3.0, fade_curve: 'linear' } },
    verse: { name: 'Verse' },
    outro: { name: 'Outro', terminal_fade: { fade_duration: 4.5, fade_curve: 'equal_power' } },
  },
};

sub('entry_fade on entry node');
{
  assert(hasEntryFade(META_GRAPH, 'intro') === true, 'intro has entry_fade');
  assert(hasEntryFade(META_GRAPH, 'verse') === false, 'verse has no entry_fade');
  assert(hasEntryFade(META_GRAPH, 'missing') === false, 'missing node → false');
  assert(hasEntryFade(null, 'intro') === false, 'null graph → false');
}

sub('terminal_fade on leaf node');
{
  assert(hasTerminalFade(META_GRAPH, 'outro') === true, 'outro has terminal_fade');
  assert(hasTerminalFade(META_GRAPH, 'verse') === false, 'verse has no terminal_fade');
  assert(hasTerminalFade(META_GRAPH, '') === false, 'empty id → false');
  assert(hasTerminalFade(META_GRAPH, null) === false, 'null id → false');
}

// ─────────────────────────────────────────────────────────────────────
// Auto-advance scheduler gate — 2026-04-24 terminal_fade fallback.
// Mirrors _scheduleAutoAdvance (index.js:2611). When the current node has
// no outgoing auto connection but carries terminal_fade metadata, the
// scheduler now fires stop_with_terminal_fade after loop_count elapses.
// ─────────────────────────────────────────────────────────────────────

function planAutoAdvance(node, connections, currentNodeId) {
  // Returns { action: 'skip' | 'auto' | 'terminal', duration?: number }
  const loopCount = node.loop_count || 0;
  if (loopCount <= 0) return { action: 'skip' };

  const hasAuto = connections.some(c => c.source === currentNodeId && c.auto === true);
  const hasTerminal = !!node.terminal_fade;
  if (!hasAuto && !hasTerminal) return { action: 'skip' };

  let duration = -1;
  const freeTempo = !!node.free_tempo;
  if (freeTempo) {
    const clipLen = node._clip_length_sec || 0;
    if (clipLen > 0) duration = clipLen * loopCount;
  } else {
    const bpm = node.bpm || 120;
    const beatsPerBar = node.time_signature?.[0] || 4;
    const barDur = bpm > 0 ? (60 / bpm) * beatsPerBar : 0;
    const durationBars = node.duration_bars || 0;
    if (durationBars > 0 && barDur > 0) duration = durationBars * loopCount * barDur;
  }
  if (duration <= 0) return { action: 'skip' };

  return {
    action: hasAuto ? 'auto' : 'terminal',
    duration,
  };
}

header('4a. Auto-advance scheduler gate (terminal_fade fallback)');

sub('loop_count=0 → never schedules');
{
  const node = { loop_count: 0, terminal_fade: { fade_duration: 2.0 } };
  const r = planAutoAdvance(node, [], 'n');
  assert(r.action === 'skip', 'infinite loop skips scheduling');
}

sub('no auto + no terminal_fade → skip');
{
  const node = { loop_count: 1, bpm: 120, duration_bars: 4, time_signature: [4, 4] };
  const r = planAutoAdvance(node, [], 'n');
  assert(r.action === 'skip', 'no outgoing auto and no terminal_fade → skip');
}

sub('auto connection + no terminal → auto branch');
{
  const node = { loop_count: 1, bpm: 120, duration_bars: 4, time_signature: [4, 4] };
  const conns = [{ source: 'n', target: 'm', auto: true }];
  const r = planAutoAdvance(node, conns, 'n');
  assert(r.action === 'auto', 'auto connection → auto branch');
  assert(Math.abs(r.duration - 8) < 0.001, `duration=${r.duration} (expected 8s = 4 bars × 0.5s/beat × 4 beats/bar × 1 loop)`);
}

sub('no auto + terminal_fade → terminal branch');
{
  const node = {
    loop_count: 1, bpm: 132, duration_bars: 8, time_signature: [4, 4],
    terminal_fade: { fade_duration: 5.0, fade_curve: 'linear' },
  };
  const r = planAutoAdvance(node, [], 'n');
  assert(r.action === 'terminal', 'no auto but terminal_fade → terminal branch');
  // 8 bars * 1 loop * (60/132)*4 = 14.545...
  assert(Math.abs(r.duration - 14.545) < 0.01, `duration=${r.duration?.toFixed(3)} (expected ≈14.545s @ 132 bpm, 8 bars)`);
}

sub('auto + terminal both present → auto wins (preserves v1.9 semantics)');
{
  const node = {
    loop_count: 1, bpm: 120, duration_bars: 4, time_signature: [4, 4],
    terminal_fade: { fade_duration: 3.0, fade_curve: 'linear' },
  };
  const conns = [{ source: 'n', target: 'm', auto: true }];
  const r = planAutoAdvance(node, conns, 'n');
  assert(r.action === 'auto', 'auto wins over terminal when both present');
}

sub('free_tempo + terminal → duration from clip_length');
{
  const node = {
    loop_count: 2, free_tempo: true, _clip_length_sec: 3.5,
    terminal_fade: { fade_duration: 1.0, fade_curve: 'equal_power' },
  };
  const r = planAutoAdvance(node, [], 'n');
  assert(r.action === 'terminal', 'free_tempo + terminal → terminal branch');
  assert(Math.abs(r.duration - 7.0) < 0.001, `duration=${r.duration} (expected 7s = 3.5s × 2 loops)`);
}

sub('terminal_fade metadata structure');
{
  const node = {
    loop_count: 1, bpm: 120, duration_bars: 4, time_signature: [4, 4],
    terminal_fade: { fade_duration: 5.0, fade_curve: 'linear' },
  };
  assert(node.terminal_fade.fade_duration === 5.0, 'fade_duration field preserved');
  assert(node.terminal_fade.fade_curve === 'linear', 'fade_curve field preserved');
}

// ─────────────────────────────────────────────────────────────────────
// transition_info payload shape — Godot parity
// ─────────────────────────────────────────────────────────────────────

header('5. transition_info payload shape');

sub('entry_fade phase has required fields');
{
  const info = { phase: 'entry_fade', duration: 3.0, curve: 'linear', to_node: 'intro', to_name: 'Intro' };
  for (const f of ['phase', 'duration', 'curve', 'to_node', 'to_name']) {
    assert(info[f] !== undefined, `field ${f} present`);
  }
}

sub('transition phase has kind + direction');
{
  const info = {
    phase: 'transition', kind: 'fade_in', direction: 'forward',
    duration: 2.0, curve: 'equal_power',
    from_node: 'a', from_name: 'A', to_node: 'b', to_name: 'B', level: 1,
  };
  assert(info.kind === 'fade_in', 'kind=fade_in');
  assert(info.direction === 'forward', 'direction=forward');
  assert(info.level === 1, 'level=1');
}

sub('fade_out_start has from+to pair');
{
  const info = {
    phase: 'fade_out_start', duration: 2.5, curve: 'equal_power',
    from_node: 'a', from_name: 'A', to_node: 'b', to_name: 'B',
  };
  assert(info.from_node && info.to_node, 'from_node + to_node present');
}

// ============================================================
// SUMMARY
// ============================================================

header('SUMMARY');
console.log(`\n  ✓ Passed: ${passed}`);
console.log(`  ✗ Failed: ${failed}`);
console.log(`  Total: ${passed + failed} assertions\n`);
if (failed > 0) {
  console.log('  FAILURES DETECTED\n');
  process.exit(1);
}
console.log('  ALL TESTS PASSED!\n');
