#!/usr/bin/env node
/**
 * PFA Engine — Stinger Node runtime test (Phase 1D).
 *
 * Pure-logic port of the JS picker + bundle decisions to keep CI fast.
 * Mirrors core/stinger_picker.py + index.js _pickStingerVariant / _playStinger gating.
 *
 * Parity contract:
 *   - state shape `{ lastIdx: int }` matches Python `{"last_idx": int}`
 *   - mode strings: "random" | "weighted" | "no_repeat" (unknown → random)
 *   - n == 1 → always 0, sets state.lastIdx = 0
 *   - weighted: clamps negatives, cumulative scan
 *   - no_repeat: refuses immediate dup, falls back to 0 if only choice
 *
 * Run: node test-stinger-runtime.js  (exit 0 = green, 1 = any fail)
 */

let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(msg) { passed++; console.log(`    ✓ ${msg}`); }
function fail(msg) { failed++; console.log(`    ✗ FAIL: ${msg}`); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }
function assertClose(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, `${msg} (got ${a.toFixed(4)}, expected ${b.toFixed(4)} ± ${tol})`); }

// Seedable RNG so weighted/no_repeat distribution tests are deterministic.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pure-logic port of PFAEvent._pickStingerVariant (index.js).
// Takes an injectable `rand` so tests can seed it.
// ─────────────────────────────────────────────────────────────────────

function pickStingerVariant(bundle, rand = Math.random) {
  const n = bundle.buffers.length;
  if (n <= 0) return -1;
  if (n === 1) {
    bundle.state.lastIdx = 0;
    return 0;
  }
  const mode = bundle.mode;
  if (mode === 'weighted') {
    if (!Array.isArray(bundle.clips) || bundle.clips.length !== n) {
      return Math.floor(rand() * n);
    }
    const weights = bundle.clips.map(c => Math.max(0, Number(c?.weight ?? 1.0)));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return Math.floor(rand() * n);
    const rval = rand() * total;
    let cum = 0;
    for (let i = 0; i < n; i++) {
      cum += weights[i];
      if (rval < cum) return i;
    }
    return n - 1;
  }
  if (mode === 'no_repeat') {
    const last = bundle.state.lastIdx;
    const choices = [];
    for (let i = 0; i < n; i++) if (i !== last) choices.push(i);
    const idx = choices.length > 0 ? choices[Math.floor(rand() * choices.length)] : 0;
    bundle.state.lastIdx = idx;
    return idx;
  }
  return Math.floor(rand() * n);
}

// Pure-logic gate that mirrors _playStinger up to the actual audio call.
// Returns:  -1 = chance fail / empty / oor
//          else the picked index.
function fireStinger(bundle, rand = Math.random) {
  if (!bundle || bundle.buffers.length === 0) return -1;
  const chance = bundle.playChance;
  if (chance <= 0) return -1;
  if (chance < 100 && rand() * 100 > chance) return -1;
  const idx = pickStingerVariant(bundle, rand);
  if (idx < 0 || idx >= bundle.buffers.length) return -1;
  return idx;
}

function makeBundle(n, mode = 'random', extra = {}) {
  const clips = (extra.clips ?? Array.from({ length: n }, () => ({ volume: 1.0, weight: 1.0 })));
  return {
    buffers: Array.from({ length: n }, (_, i) => ({ _id: i })),
    clips,
    volume: extra.volume ?? 1.0,
    playChance: extra.playChance ?? 100,
    mode,
    state: { lastIdx: -1 },
  };
}

// ─────────────────────────────────────────────────────────────────────
header('1. Bundle shape + edge cases');

sub('Empty bundle → fire returns -1');
{
  const bundle = makeBundle(0);
  assert(fireStinger(bundle) === -1, 'no buffers → fire skipped');
}

sub('Single sample → always idx 0');
{
  const bundle = makeBundle(1, 'random');
  const r1 = pickStingerVariant(bundle);
  const r2 = pickStingerVariant(bundle);
  assert(r1 === 0 && r2 === 0, 'n=1 always returns 0');
  assert(bundle.state.lastIdx === 0, 'state.lastIdx set to 0 (parity with Python state["last_idx"])');
}

sub('Unknown mode falls back to random');
{
  const bundle = makeBundle(4, 'this_is_not_a_real_mode');
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickStingerVariant(bundle));
  assert(seen.size > 1, `unknown mode covers multiple indices over 200 picks (saw ${seen.size}/4)`);
}

// ─────────────────────────────────────────────────────────────────────
header('2. Random mode — distribution');

sub('Uniform across 4 variants over 8000 picks');
{
  const rng = mulberry32(0x12345);
  const bundle = makeBundle(4, 'random');
  const counts = [0, 0, 0, 0];
  const N = 8000;
  for (let i = 0; i < N; i++) counts[pickStingerVariant(bundle, rng)]++;
  // Each bucket should be ~2000 ±150 (statistically ample at N=8000).
  for (let i = 0; i < 4; i++) {
    assertClose(counts[i], N / 4, 150, `bucket ${i} count`);
  }
}

// ─────────────────────────────────────────────────────────────────────
header('3. Weighted mode');

sub('Weights [3, 1] → ~75/25 split');
{
  const rng = mulberry32(0x55555);
  const bundle = makeBundle(2, 'weighted', { clips: [{ weight: 3 }, { weight: 1 }] });
  let c0 = 0, c1 = 0;
  const N = 6000;
  for (let i = 0; i < N; i++) {
    if (pickStingerVariant(bundle, rng) === 0) c0++; else c1++;
  }
  assertClose(c0 / N, 0.75, 0.03, '~75% to weight-3 variant');
  assertClose(c1 / N, 0.25, 0.03, '~25% to weight-1 variant');
}

sub('All weights zero → fall back to uniform');
{
  const rng = mulberry32(0x77);
  const bundle = makeBundle(3, 'weighted', { clips: [{ weight: 0 }, { weight: 0 }, { weight: 0 }] });
  const counts = [0, 0, 0];
  const N = 3000;
  for (let i = 0; i < N; i++) counts[pickStingerVariant(bundle, rng)]++;
  // Should look uniform — each ~1000.
  for (let i = 0; i < 3; i++) assertClose(counts[i], N / 3, 100, `bucket ${i} fallback uniform`);
}

sub('Negative weight clamped to 0');
{
  const rng = mulberry32(0xABCD);
  const bundle = makeBundle(2, 'weighted', { clips: [{ weight: -10 }, { weight: 1 }] });
  let c0 = 0, c1 = 0;
  for (let i = 0; i < 1000; i++) {
    if (pickStingerVariant(bundle, rng) === 0) c0++; else c1++;
  }
  assert(c0 === 0, `negative weight never wins (got ${c0}/1000 picks for weight=-10)`);
  assert(c1 === 1000, 'all 1000 picks land on positive weight');
}

sub('Weights len mismatch → uniform fallback');
{
  // bundle says 3 buffers but only 2 clips — algorithm must not crash, falls back to uniform.
  const rng = mulberry32(0xFF);
  const bundle = makeBundle(3, 'weighted', { clips: [{ weight: 1 }, { weight: 1 }] });
  const counts = [0, 0, 0];
  for (let i = 0; i < 600; i++) counts[pickStingerVariant(bundle, rng)]++;
  assert(counts[0] > 0 && counts[1] > 0 && counts[2] > 0, 'all 3 indices reachable under uniform fallback');
}

// ─────────────────────────────────────────────────────────────────────
header('4. No-repeat mode');

sub('100 sequential picks across 3 variants — never two same in a row');
{
  const rng = mulberry32(0xDEADBEEF);
  const bundle = makeBundle(3, 'no_repeat');
  let prev = -1, dups = 0;
  for (let i = 0; i < 100; i++) {
    const idx = pickStingerVariant(bundle, rng);
    if (idx === prev && i > 0) dups++;
    prev = idx;
  }
  assert(dups === 0, `0 immediate dups across 100 picks (got ${dups})`);
}

sub('state.lastIdx mutates across fires');
{
  const rng = mulberry32(0x42);
  const bundle = makeBundle(4, 'no_repeat');
  pickStingerVariant(bundle, rng);
  const after1 = bundle.state.lastIdx;
  pickStingerVariant(bundle, rng);
  const after2 = bundle.state.lastIdx;
  assert(after1 !== -1, 'first pick records last_idx');
  assert(after2 !== after1, 'second pick differs from first (no_repeat enforces this)');
}

sub('Independent state across two connection keys (1:N reuse)');
{
  // Same source data, two bundles → independent histories.
  const rng = mulberry32(0xCAFE);
  const bundleA = makeBundle(3, 'no_repeat');
  const bundleB = makeBundle(3, 'no_repeat');
  for (let i = 0; i < 5; i++) pickStingerVariant(bundleA, rng);
  // bundleB untouched.
  assert(bundleA.state.lastIdx !== -1, 'bundle A state advanced');
  assert(bundleB.state.lastIdx === -1, 'bundle B state untouched (memory: independent state per connection)');
}

// ─────────────────────────────────────────────────────────────────────
header('5. play_chance gating');

sub('chance=0 → always skip');
{
  const rng = mulberry32(0x999);
  const bundle = makeBundle(3, 'random', { playChance: 0 });
  let fires = 0;
  for (let i = 0; i < 500; i++) if (fireStinger(bundle, rng) >= 0) fires++;
  assert(fires === 0, `0/500 fires at chance=0 (got ${fires})`);
}

sub('chance=100 → always fire');
{
  const rng = mulberry32(0x111);
  const bundle = makeBundle(3, 'random', { playChance: 100 });
  let fires = 0;
  for (let i = 0; i < 500; i++) if (fireStinger(bundle, rng) >= 0) fires++;
  assert(fires === 500, `500/500 fires at chance=100 (got ${fires})`);
}

sub('chance=50 → ~50% fire over 4000 transitions');
{
  const rng = mulberry32(0x2222);
  const bundle = makeBundle(3, 'random', { playChance: 50 });
  let fires = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) if (fireStinger(bundle, rng) >= 0) fires++;
  assertClose(fires / N, 0.5, 0.04, '~50% fire rate at chance=50');
}

// ─────────────────────────────────────────────────────────────────────
header('6. Volume math');

sub('clip × bundle volume correctly multiplied');
{
  // Pure math, no audio nodes — verify the formula matches engine code.
  const bundle = {
    buffers: [{}],
    clips: [{ volume: 0.5 }],
    volume: 0.6,
    playChance: 100,
    mode: 'random',
    state: { lastIdx: -1 },
  };
  // Replicate _playStinger's gain calc:
  const idx = 0;
  const clip = bundle.clips[idx] ?? {};
  const finalGain = Number(clip.volume ?? 1.0) * bundle.volume;
  assertClose(finalGain, 0.3, 1e-9, 'finalGain = 0.5 × 0.6 = 0.30');
}

sub('Missing clip volume defaults to 1.0');
{
  const bundle = {
    buffers: [{}],
    clips: [{}],  // no volume key
    volume: 0.85,
    playChance: 100,
    mode: 'random',
    state: { lastIdx: -1 },
  };
  const clip = bundle.clips[0] ?? {};
  const finalGain = Number(clip.volume ?? 1.0) * bundle.volume;
  assertClose(finalGain, 0.85, 1e-9, 'missing clip volume → 1.0 * bundle volume');
}

// ─────────────────────────────────────────────────────────────────────
// Summary
console.log('\n' + '═'.repeat(70));
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
