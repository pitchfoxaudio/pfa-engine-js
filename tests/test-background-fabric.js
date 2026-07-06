#!/usr/bin/env node
/**
 * PFA Engine — background fabric: variations + play_chance keep living on
 * INACTIVE levels (decided with the user 2026-06-12, china L2 re-test).
 *
 * Reference = the editor (core/region.py _advance_level_state: "Like JS engine
 * where all levels play continuously at gain=0 — variation switching and
 * play_chance keep ticking in the background"). Pre-fabric, the engines only
 * implemented the AUDIO half (muted phase-locked lanes); the DICE half ticked
 * for the current level alone:
 *   - first-ever entry to a level always heard variation #0 (deterministic);
 *   - the "play N times before switching" counter restarted AT ENTRY → the
 *     caught variation replayed one full extra loop before the first switch;
 *   - entry inherited the PREVIOUS level's stale play_chance verdict → a
 *     100%-chance level could enter silent until the next loop boundary.
 *
 * Loads the REAL src/index.js and drives the real _conductorTick /
 * _switchVariation / activateLevel. Red-fails on the pre-fabric engine.
 * Godot mirror: test_background_fabric.gd.
 *
 * Run: node tests/test-background-fabric.js   (exit 0 green / 1 red)
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
const { PFAEvent, PFATrack } = loadEngine();

// ── Tiny test harness (house convention) ─────────────────────────────
let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function assert(c, m) { if (c) { passed++; console.log('    ✓ ' + m); } else { failed++; console.log('    ✗ FAIL: ' + m); } }

// ── Stubs: just enough Web Audio for _switchVariation / activateLevel ─
function mkGainNode() {
  return {
    gain: {
      value: 0,
      setValueAtTime(v) { this.value = v; },
      linearRampToValueAtTime(v) { this.value = v; },
      setTargetAtTime() {},
      cancelScheduledValues() {},
    },
    connect() {}, disconnect() {},
  };
}
function mkCtx() {
  return {
    currentTime: 0,
    createGain: () => mkGainNode(),
    createBufferSource: () => ({
      buffer: null, loop: false, loopStart: 0, loopEnd: 0, onended: null,
      connect() {}, start() {}, stop() {},
    }),
  };
}
function mkEngine() { const ctx = mkCtx(); return { ctx, _now: () => ctx.currentTime }; }
function fakeBuffers(n) { return Array.from({ length: n }, (_, i) => ({ idx: i, duration: 1 })); }

// ── Fixture: ONE level_specific track with TWO levels (L0 current, L1 muted) ──
function buildFixture({ loopBars = 2, switchChance = 100, playChances = [100, 100] } = {}) {
  const engine = mkEngine();
  const ev = new PFAEvent('fabric_ev', { type: 'music', tracks: [] }, engine);
  ev._emitTransitionInfo = () => {};

  const track = new PFATrack({
    name: 'fabric_test',
    level_behavior: 'level_specific',
    randomization_algo: 'no_repeat',
    repeat_count: 1,
    levels: {
      0: { samples: [], loop_bars: loopBars, switch_chance: switchChance, play_chance: playChances[0] },
      1: { samples: [], loop_bars: loopBars, switch_chance: switchChance, play_chance: playChances[1] },
    },
  }, engine);
  track._parentEvent = ev;

  for (const lvl of [0, 1]) {
    track._buffers[lvl] = fakeBuffers(2);
    track._levelGains[lvl] = mkGainNode();
    track._variationGains[lvl] = mkGainNode();
  }
  // Current level audible, background muted — the freeze check reads gain.value.
  track._levelGains[0].gain.value = 1;
  track._levelGains[1].gain.value = 0;

  ev.tracks = [track];
  ev.currentLevel = 0;
  ev.isPlaying = true;
  ev._barDurationSec = 2.0;
  ev._barCounter = 0;
  ev._playStartTime = 0;
  ev._initialPlayChanceRoll();

  return { ev, track };
}

function tick(ev) { ev._barCounter += 1; ev._conductorTick(); }
function activeVariation(track, lvl) {
  // The lane's scheduled source carries the buffer of the variation that will
  // sound on entry; its idx is the observable "active variation" in JS.
  const src = track._levelSources[lvl];
  return src && src.buffer ? src.buffer.idx : 0;
}

header('Background fabric — variations + play_chance live on inactive levels (JS)');

// ═════════════════════════════════════════════════════════════════════
sub('Background L1 pool rotates 0→1 while L0 is current');
{
  const { ev, track } = buildFixture({ loopBars: 2 });
  for (let i = 0; i < 2; i++) tick(ev);   // switch_bars = 2 → boundary at tick 2
  assert(track.currentVariation(0) === 1, 'current level L0 rotated 0→1 (sanity)');
  assert(track.currentVariation(1) === 1, 'BACKGROUND level L1 pool rotated 0→1 (fabric alive)');
  assert(activeVariation(track, 1) === 1, 'L1 lane re-sourced to variation 1 — next entry unmutes 1, not 0');
}

// ═════════════════════════════════════════════════════════════════════
sub('Entering mid-cycle: first boundary after entry swaps (no double-play)');
{
  const { ev, track } = buildFixture({ loopBars: 2 });
  tick(ev);                       // bar 1 — mid-cycle for both levels
  ev.currentLevel = 1;            // entry (gain side irrelevant here)
  track._levelGains[1].gain.value = 1;   // lane unmuted by entry
  const atEntry = track.currentVariation(1);
  tick(ev);                       // bar 2 — L1's own loop boundary
  assert(track.currentVariation(1) !== atEntry,
    `L1 swapped at the FIRST boundary after entry (${atEntry} → ${track.currentVariation(1)})`);
}

// ═════════════════════════════════════════════════════════════════════
sub('Audibly-fading background lane vetoes the swap; silent lane swaps');
{
  const { ev, track } = buildFixture({ loopBars: 1 });   // every tick = boundary
  track._levelGains[1].gain.value = 0.5;   // as if mid fade-out after leaving L1
  tick(ev);
  assert(track.currentVariation(1) === 0, 'swap vetoed while lane audible (freeze window)');
  track._levelGains[1].gain.value = 0;     // fade finished
  tick(ev);
  assert(track.currentVariation(1) === 1, 'silent background lane rotates on the next boundary');
}

// ═════════════════════════════════════════════════════════════════════
sub('activateLevel gates by the TARGET level\'s verdict, not the stale one');
{
  const { ev, track } = buildFixture({ loopBars: 2 });
  // Force "L0 said silent" in whichever state shape the engine under test has
  // (old: per-track flat dict; new: per-level nested dict).
  const st = ev._trackChanceState[0];
  if ('playing' in st) st.playing = false;   // pre-fabric per-track shape
  else st[0].playing = false;                // fabric per-level shape
  track.activateLevel(1, 0);
  assert(track._intendedGains[1] === track.volume,
    `entering L1 (chance=100) targets full volume despite L0's silent verdict (got ${track._intendedGains[1]})`);
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
if (failed === 0) console.log('\n  ALL TESTS PASSED!');
process.exit(failed > 0 ? 1 : 0);
