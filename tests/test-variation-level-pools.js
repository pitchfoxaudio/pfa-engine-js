#!/usr/bin/env node
/**
 * PFA Engine — per-level variation rotation pools (china-L2 "stuck variations
 * on first entry" regression, 2026-06-12 user re-test round 2, feedback №3).
 *
 * Root cause (was identical in JS and Godot): PFATrack kept ONE _currentVariation
 * + ONE no_repeat shuffle bag per track, shared across ALL levels. The editor
 * reference keeps them PER LEVEL (LevelState.current_variation_index +
 * _variation_shuffle_bag, core/multisample.py:43-68). With 5 variations on one
 * level and 2 on another (the user's Strings_t_1 config), bag entries minted on
 * the 5-pool (indices 2..4) popped on the 2-pool:
 *   - music path: buffers[3] === undefined → _switchVariation bailed → the
 *     variation "stuck" a full extra loop per stale entry;
 *   - SFX path: Math.min clamped the read → fairness broke (repeats in a row).
 *
 * Loads the REAL src/index.js (same eval pattern as test-sfx-variation.js) and
 * drives the real _pickVariation / _getBufferAndClip exactly как их зовут
 * conductor/_switchVariation и triggerSfx. The same file red-fails on the
 * pre-fix engine (stale picks land out of range / repeats appear).
 *
 * Run: node tests/test-variation-level-pools.js   (exit 0 green / 1 red)
 */

const fs = require('fs');
const path = require('path');

// ── Load the real PFATrack class from source ─────────────────────────
function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack };';
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

function mkEngine() {
  return { ctx: { currentTime: 0 }, _now: () => 0 };
}
function fakeBuffers(n) { return Array.from({ length: n }, (_, i) => ({ idx: i, duration: 1 })); }

// Mirror of the user's repro shape: big pool rotates first, then we enter the
// small pool. 7 picks on the 5-pool leave 3 distinct leftovers in a shared bag —
// at most two of {0..4} are < 2, so at least ONE leftover is out of range for
// the 2-pool. Deterministic red on the unfixed engine.
const BIG_LEVEL = 0, SMALL_LEVEL = 1, BIG_N = 5, SMALL_N = 2;

function makeMusicTrack() {
  const track = new PFATrack({
    name: 'pool_test',
    level_behavior: 'level_specific',
    randomization_algo: 'no_repeat',   // editor "Shuffle" — the user's config
    repeat_count: 1,
    levels: {
      [BIG_LEVEL]: { samples: [], loop_bars: 1, switch_chance: 100, play_chance: 100 },
      [SMALL_LEVEL]: { samples: [], loop_bars: 1, switch_chance: 100, play_chance: 100 },
    },
  }, mkEngine());
  track._buffers[BIG_LEVEL] = fakeBuffers(BIG_N);
  track._buffers[SMALL_LEVEL] = fakeBuffers(SMALL_N);
  return track;
}

// The conductor's pick, exactly as _switchVariation issues it for a
// level_specific track (poolKey = level).
function conductorPick(track, level) {
  const buffers = track._buffers[level] || track._buffers[0];
  const clips = track.levelClips[level] || track.levelClips[0] || [];
  return track._pickVariation(buffers, clips, level);
}

header('Per-level variation pools (china L2 first-entry regression)');

// ───── 1. THE repro: first entry on the small pool stays in range + alternates ─────
{
  sub('5-pool warm-up → enter 2-pool: every pick in range, strict alternation');
  const track = makeMusicTrack();
  for (let i = 0; i < 7; i++) conductorPick(track, BIG_LEVEL);

  const picks = [];
  for (let i = 0; i < 6; i++) picks.push(conductorPick(track, SMALL_LEVEL));

  assert(picks.every(p => p >= 0 && p < SMALL_N),
    `all first-entry picks within the 2-pool (got [${picks}])`);
  const noStuck = picks.every((p, i) => i === 0 || p !== picks[i - 1]);
  assert(noStuck,
    `no_repeat n=2 alternates strictly from the FIRST boundary (got [${picks}])`);
}

// ───── 2. Round trip: big → small → big coverage → small alternates immediately ─────
{
  sub('Round trip: big pool still covers all 5; small re-entry alternates');
  const track = makeMusicTrack();
  for (let i = 0; i < 4; i++) conductorPick(track, BIG_LEVEL);
  for (let i = 0; i < 3; i++) conductorPick(track, SMALL_LEVEL);

  const seen = new Set();
  for (let i = 0; i < 10; i++) seen.add(conductorPick(track, BIG_LEVEL));
  assert(seen.size === BIG_N,
    `big pool unpoisoned by small-pool activity — all ${BIG_N} visited (saw [${[...seen]}])`);

  const picks = [];
  for (let i = 0; i < 4; i++) picks.push(conductorPick(track, SMALL_LEVEL));
  const noStuck = picks.every((p, i) => p >= 0 && p < SMALL_N && (i === 0 || p !== picks[i - 1]));
  assert(noStuck, `small pool re-entry alternates in range (got [${picks}])`);
}

// ───── 3. SFX path via the real _getBufferAndClip(level, pick=true) ─────
{
  sub('SFX per-trigger picks: 2-pool never repeats after 5-pool warm-up');
  const track = makeMusicTrack();
  // Warm the big pool through the real SFX trigger path.
  for (let i = 0; i < 7; i++) track._getBufferAndClip(BIG_LEVEL, true);

  const reported = [];
  for (let i = 0; i < 12; i++) {
    reported.push(track._getBufferAndClip(SMALL_LEVEL, true).variation);
  }
  assert(reported.every(v => v >= 0 && v < SMALL_N),
    `reported variations within the 2-pool (got [${reported}])`);
  const noRepeat = reported.every((v, i) => i === 0 || v !== reported[i - 1]);
  assert(noRepeat,
    `no_repeat honored on the small pool — no immediate repeats (got [${reported}])`);
  // Both small-pool variations actually play (the "иногда дорожка молчит" guard:
  // a clamped stale index over-selects one variation and can starve the other).
  assert(new Set(reported).size === SMALL_N,
    `both small-pool variations heard over 12 triggers (saw [${[...new Set(reported)]}])`);
}

// ───── 4. Shared pool unaffected (always_play keeps ONE rotation) ─────
{
  sub('always_play track still rotates one shared pool');
  const track = new PFATrack({
    name: 'shared_test',
    level_behavior: 'always_play',
    randomization_algo: 'no_repeat',
  }, mkEngine());
  track._sharedBuffers = fakeBuffers(3);
  const seen = new Set();
  for (let i = 0; i < 9; i++) {
    seen.add(track._getBufferAndClip(0, true).variation);
  }
  assert(seen.size === 3, `shared pool visits all 3 variations (saw [${[...seen]}])`);
}

console.log('\n' + '═'.repeat(70));
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
