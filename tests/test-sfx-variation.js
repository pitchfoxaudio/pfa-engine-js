#!/usr/bin/env node
/**
 * PFA Engine — SFX variation-switching test suite
 *
 * Verifies the 2026-06-01 SFX-trigger fix (see project_sfx_engine_gaps):
 *   Gap 1 — always_play / level_conditional SFX are no longer rejected by the
 *           levelSamples guard in triggerSfx / triggerSfxSpatial (they kept their
 *           samples in the shared pool, so levelSamples is empty for them).
 *   Gap 2 — SFX picks a FRESH sample variation per trigger via _pickVariation,
 *           gated by switch_chance — editor parity with core/sfx_event.py trigger()
 *           (rolls switch_chance, then switch_variation() → pick_random_variation).
 *
 * Loads the REAL engine source (src/index.js): strips the two trailing ESM export
 * lines and evals the text, so we exercise the shipped PFATrack — not a hand port.
 * (index.js is ESM inside an untyped package, so Node can't require() it directly;
 * the rest of the suite pure-ports for that reason. Here we eval the real text.)
 *
 * Usage: node test-sfx-variation.js
 */

const fs = require('fs');
const path = require('path');

// ── Load the real PFATrack class from source ─────────────────────────
function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  // Strip the only thing Node-CJS can't parse: the trailing ESM exports.
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack };';
  // window passed as undefined → the browser-global block at the tail is skipped.
  return new Function('window', src)(undefined);
}
const { PFATrack } = loadEngine();

// ── Tiny test harness (house convention) ─────────────────────────────
let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }

// ── Mock Web Audio — only the surface triggerSfx actually touches ─────
function mkParam() {
  return {
    value: 1,
    setValueAtTime() {}, linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
  };
}
function mkGain() { return { gain: mkParam(), connect() {}, disconnect() {} }; }
function mkSource() {
  return {
    buffer: null, loop: false, loopStart: 0, loopEnd: 0,
    playbackRate: { value: 1 }, detune: { value: 0 },
    connect() {}, start() {}, stop() {}, onended: null,
  };
}
function mkEngine() {
  return { ctx: { createBufferSource: mkSource, createGain: mkGain, currentTime: 0 }, _now: () => 0 };
}

// Fake AudioBuffers carry their variation index so the test can see which was chosen.
function fakeBuffers(n) { return Array.from({ length: n }, (_, i) => ({ idx: i, duration: 1 })); }

// Construct a real PFATrack and wire fake buffers into the correct pool.
function makeTrack(data, varCount) {
  const track = new PFATrack(data, mkEngine());
  if (data.level_behavior === 'always_play' || data.level_behavior === 'level_conditional') {
    track._sharedBuffers = fakeBuffers(varCount);
  } else {
    for (const k of Object.keys(data.levels || {})) track._buffers[parseInt(k)] = fakeBuffers(varCount);
  }
  return track;
}

// Collect N per-trigger variation picks via the REAL _getBufferAndClip(level, pick=true).
function pickSeq(track, level, n) {
  const seq = [];
  for (let i = 0; i < n; i++) seq.push(track._getBufferAndClip(level, true).buffer.idx);
  return seq;
}

// ═════════════════════════════════════════════════════════════════════
header('1. Gap 1 — always_play / level_conditional SFX fire (were rejected)');
// ═════════════════════════════════════════════════════════════════════
{
  const t = makeTrack({ name: 'cement', level_behavior: 'always_play', samples: ['a'] }, 1);
  assert(t.triggerSfx(0, mkGain()) !== null, 'always_play triggerSfx returns a voice (was null before fix)');
  assert(t.triggerSfx(3, mkGain()) !== null, 'always_play fires on an arbitrary level index too');
  const sp = t.triggerSfxSpatial(0);
  assert(sp !== null && !!sp.source && !!sp.voiceGain, 'always_play triggerSfxSpatial returns a voice');
}
sub('level_conditional also passes the guard');
{
  const t = makeTrack({ name: 'lc', level_behavior: 'level_conditional', samples: ['a', 'b'] }, 2);
  assert(t.triggerSfx(0, mkGain()) !== null, 'level_conditional triggerSfx fires');
}
sub('level_specific guard still rejects when there are genuinely no samples');
{
  const t = makeTrack({ name: 'empty', level_behavior: 'level_specific', levels: {} }, 0);
  assert(t.triggerSfx(0, mkGain()) === null, 'empty level_specific returns null (guard intact)');
}
sub('level_specific with samples fires');
{
  const t = makeTrack({ name: 'water', level_behavior: 'level_specific', levels: { '0': { samples: ['a', 'b'] } } }, 2);
  assert(t.triggerSfx(0, mkGain()) !== null, 'level_specific with level-0 samples fires');
}

// ═════════════════════════════════════════════════════════════════════
header('2. Gap 2 — SFX picks a fresh variation per trigger (algorithms live)');
// ═════════════════════════════════════════════════════════════════════

sub('random — visits ALL variations, ~uniform, NOT stuck on #0 (the bug)');
{
  const t = makeTrack({ name: 'r', level_behavior: 'always_play', randomization_algo: 'random', samples: ['a', 'b', 'c'] }, 3);
  const seq = pickSeq(t, 0, 3000);
  const counts = [0, 0, 0]; seq.forEach(i => counts[i]++);
  assert(counts.every(c => c > 0), `all 3 variations chosen (counts ${counts})`);
  assert(counts[0] < 3000, 'NOT stuck on variation #0 (the old behaviour)');
  const maxDev = Math.max(...counts.map(c => Math.abs(c / 3000 - 1 / 3)));
  assert(maxDev < 0.05, `roughly uniform (max dev ${(maxDev * 100).toFixed(1)}pp < 5pp)`);
}

sub('no_repeat — never same twice in a row; each bag of 4 is a full permutation');
{
  const t = makeTrack({ name: 'nr', level_behavior: 'always_play', randomization_algo: 'no_repeat', samples: ['a', 'b', 'c', 'd'] }, 4);
  const seq = pickSeq(t, 0, 400);
  let repeats = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) repeats++;
  assert(repeats === 0, `no consecutive repeats across 400 picks (found ${repeats})`);
  let badBags = 0;
  for (let i = 0; i < seq.length; i += 4) {
    if (seq.slice(i, i + 4).slice().sort().join('') !== '0123') badBags++;
  }
  assert(badBags === 0, `every 4-pick shuffle bag is a permutation of {0,1,2,3} (bad bags ${badBags})`);
}

sub('weighted — distribution follows clip weights [8,1,1]');
{
  const t = makeTrack({
    name: 'w', level_behavior: 'always_play', randomization_algo: 'weighted',
    samples: ['a', 'b', 'c'], clips: [{ weight: 8 }, { weight: 1 }, { weight: 1 }],
  }, 3);
  const seq = pickSeq(t, 0, 5000);
  const counts = [0, 0, 0]; seq.forEach(i => counts[i]++);
  const p0 = counts[0] / 5000;
  assert(Math.abs(p0 - 0.8) < 0.04, `variation 0 ≈ 80% (got ${(p0 * 100).toFixed(1)}%)`);
  assert(counts[1] > 0 && counts[2] > 0, `light variations still appear (${counts[1]}, ${counts[2]})`);
}

sub('switch_chance gate — 0 keeps the current variation (editor parity)');
{
  const t = makeTrack({
    name: 'g0', level_behavior: 'level_specific', randomization_algo: 'random',
    levels: { '0': { samples: ['a', 'b', 'c'], switch_chance: 0 } },
  }, 3);
  const seq = pickSeq(t, 0, 200);
  assert(seq.every(i => i === 0), 'switch_chance=0 → never re-picks, stays on variation 0');
}
sub('switch_chance 100 (default) — re-picks every trigger, cycles all');
{
  const t = makeTrack({
    name: 'g100', level_behavior: 'level_specific', randomization_algo: 'random',
    levels: { '0': { samples: ['a', 'b', 'c'], switch_chance: 100 } },
  }, 3);
  const distinct = new Set(pickSeq(t, 0, 1000));
  assert(distinct.size === 3, `switch_chance=100 → cycles all variations (saw ${distinct.size})`);
}

sub('single variation — no error, always #0');
{
  const t = makeTrack({ name: 'one', level_behavior: 'always_play', randomization_algo: 'no_repeat', samples: ['a'] }, 1);
  assert(pickSeq(t, 0, 50).every(i => i === 0), 'single-variation track always returns #0');
}

sub('music path unaffected — pick=false leaves the pool current to the Conductor');
{
  const t = makeTrack({ name: 'mus', level_behavior: 'always_play', randomization_algo: 'random', samples: ['a', 'b', 'c'] }, 3);
  t.setCurrentVariation('shared', 1); // pretend the Conductor set it
  const seq = [];
  for (let i = 0; i < 100; i++) seq.push(t._getBufferAndClip(0).buffer.idx); // pick defaults false
  assert(seq.every(i => i === 1), 'pick=false (music) keeps the pool current fixed');
}

// ── Result ───────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed ? 1 : 0);
