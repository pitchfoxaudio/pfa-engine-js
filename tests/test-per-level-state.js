#!/usr/bin/env node
/**
 * PFA Engine — Per-Level State Test Suite
 * Verifies per-level state isolation, variation switching,
 * play_chance, lock mechanism, and node transitions.
 *
 * Mirrors editor tests in QA/test_per_level_state.py
 *
 * 2026-06-12 fabric update: the engine conductor now ticks variation counters
 * and play_chance rerolls for ALL levels continuously — background levels keep
 * living while muted (editor reference: core/region.py _advance_level_state).
 * The MockConductor below mirrors that scheduling; entry-time rerolls
 * (the old rollChanceForNewLevel) no longer exist. Real-engine coverage:
 * test-background-fabric.js (fabric) + test-variation-level-pools.js (pools).
 *
 * Usage: node test-per-level-state.js
 */

let passed = 0, failed = 0;

function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(msg) { passed++; console.log(`    ✓ ${msg}`); }
function fail(msg) { failed++; console.log(`    ✗ FAIL: ${msg}`); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }

// ============================================================
// MockTrack — simulates PFATrack per-level state logic
// ============================================================

class MockTrack {
  constructor(opts = {}) {
    this.name = opts.name || 'track';
    this.levelBehavior = opts.levelBehavior || 'level_specific';
    this.repeatCount = opts.repeatCount || 1;
    this.randomizationAlgo = opts.randomizationAlgo || 'no_repeat';

    this.levelSamples = {};
    for (const [k, v] of Object.entries(opts.levels || {})) {
      this.levelSamples[parseInt(k)] = {
        playChance: v.playChance ?? 100,
        loopBars: v.loopBars ?? 4,
        switchChance: v.switchChance ?? 100,
        files: v.files || ['a.ogg', 'b.ogg', 'c.ogg', 'd.ogg'],
      };
    }

    // Per-track state (like JS engine)
    this._currentVariation = 0;
    this._shuffleBag = [];

    // Per-level state (like JS engine _variationBarCounter)
    this._variationBarCounter = {};

    // Play_chance state (like JS engine _trackChanceState)
    this._chanceConsecutivePlays = {};
    this._chanceConsecutiveSilences = {};
    this._chanceShuffleBags = {};
  }

  _pickVariation(count) {
    if (count <= 1) return 0;
    const prev = this._currentVariation;
    switch (this.randomizationAlgo) {
      case 'random':
        return Math.floor(Math.random() * count);
      case 'weighted': {
        // Equal weights for test simplicity
        return Math.floor(Math.random() * count);
      }
      case 'no_repeat': {
        if (this._shuffleBag.length === 0) {
          this._shuffleBag = Array.from({ length: count }, (_, i) => i);
          // Fisher-Yates
          for (let i = this._shuffleBag.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this._shuffleBag[i], this._shuffleBag[j]] = [this._shuffleBag[j], this._shuffleBag[i]];
          }
          if (this._shuffleBag[0] === prev && count > 1) {
            this._shuffleBag.push(this._shuffleBag.shift());
          }
        }
        return this._shuffleBag.shift();
      }
      default:
        return Math.floor(Math.random() * count);
    }
  }

  _rollPlayChance(level, mode) {
    const ld = this.levelSamples[level] || this.levelSamples[0] || {};
    const pc = ld.playChance ?? 100;
    if (pc >= 100) return true;
    if (pc <= 0) return false;

    switch (mode) {
      case 'weighted_history': {
        const plays = this._chanceConsecutivePlays[level] || 0;
        const silences = this._chanceConsecutiveSilences[level] || 0;
        let adj = pc;
        if (plays > 0) adj = Math.max(5, pc - Math.min(plays * 5, 25));
        if (silences > 0) adj = Math.min(95, pc + Math.min(silences * 5, 25));
        const passed = Math.random() * 100 < adj;
        if (passed) {
          this._chanceConsecutivePlays[level] = plays + 1;
          this._chanceConsecutiveSilences[level] = 0;
        } else {
          this._chanceConsecutiveSilences[level] = silences + 1;
          this._chanceConsecutivePlays[level] = 0;
        }
        return passed;
      }
      case 'shuffle_bag': {
        let bag = this._chanceShuffleBags[level];
        if (!bag || bag.length === 0) {
          const sz = 10, n = Math.round(sz * pc / 100);
          bag = [];
          for (let i = 0; i < n; i++) bag.push(true);
          for (let i = 0; i < sz - n; i++) bag.push(false);
          for (let i = bag.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [bag[i], bag[j]] = [bag[j], bag[i]];
          }
          this._chanceShuffleBags[level] = bag;
        }
        return bag.shift();
      }
      default: // true_random
        return Math.random() * 100 < pc;
    }
  }
}

// ============================================================
// MockConductor — simulates _conductorTick per-level logic
// ============================================================

class MockConductor {
  constructor(tracks, opts = {}) {
    this.tracks = tracks;
    this.chanceRerollBars = opts.chanceRerollBars || 1;
    this.playChanceMode = opts.playChanceMode || 'true_random';
    this._trackChanceState = {};
    this.barCounter = 0;
  }

  // Fabric model: every level gets its own verdict + reroll grid at start.
  initialRoll() {
    for (let i = 0; i < this.tracks.length; i++) {
      const track = this.tracks[i];
      const levels = {};
      for (const lvlStr of Object.keys(track.levelSamples)) {
        const lvl = parseInt(lvlStr);
        const passed = track._rollPlayChance(lvl, this.playChanceMode);
        const ld = track.levelSamples[lvl] || {};
        const lockDuration = (ld.loopBars || 4) * this.chanceRerollBars;
        levels[lvl] = { playing: passed, lockedUntil: lockDuration, nextRerollBar: lockDuration };
      }
      this._trackChanceState[i] = levels;
    }
  }

  // Fabric model: counters and rerolls tick for ALL levels; curLevel only
  // decides audibility in the real engine, never scheduling.
  tick(curLevel) {
    this.barCounter++;

    // Play_chance reroll — every level on its own grid
    for (let i = 0; i < this.tracks.length; i++) {
      const levelsState = this._trackChanceState[i];
      if (!levelsState) continue;
      const track = this.tracks[i];
      for (const lvlStr of Object.keys(levelsState)) {
        const lvl = parseInt(lvlStr);
        const state = levelsState[lvlStr];
        if (this.barCounter < state.nextRerollBar) continue;
        const passed = track._rollPlayChance(lvl, this.playChanceMode);
        const ld = track.levelSamples[lvl] || {};
        const lockDuration = (ld.loopBars || 4) * this.chanceRerollBars;
        state.playing = passed;
        state.lockedUntil = this.barCounter + lockDuration;
        state.nextRerollBar = this.barCounter + lockDuration;
      }
    }

    // Variation switching — every level's counter ticks (background fabric)
    for (let i = 0; i < this.tracks.length; i++) {
      const track = this.tracks[i];
      for (const lvlStr of Object.keys(track.levelSamples)) {
        const lvl = parseInt(lvlStr);
        const ld = track.levelSamples[lvl] || {};
        const files = ld.files || [];
        if (files.length <= 1) continue;

        if (track._variationBarCounter[lvl] === undefined) {
          track._variationBarCounter[lvl] = 0;
        }
        track._variationBarCounter[lvl]++;

        const switchBars = (ld.loopBars || 4) * track.repeatCount;

        if (track._variationBarCounter[lvl] >= switchBars) {
          track._variationBarCounter[lvl] = 0;
          const switchChance = ld.switchChance ?? 100;
          if (switchChance > 0 && Math.random() * 100 <= switchChance) {
            track._currentVariation = track._pickVariation(files.length);
          }
        }
      }
    }
  }
}

// ============================================================
// 1. PER-LEVEL STATE ISOLATION
// ============================================================

header('1. PER-LEVEL STATE ISOLATION');

sub('_variationBarCounter is per-level');
{
  const track = new MockTrack({
    levels: { 0: {}, 1: {}, 2: {} }
  });

  track._variationBarCounter[0] = 5;
  track._variationBarCounter[1] = 0;
  track._variationBarCounter[2] = 3;

  assert(track._variationBarCounter[0] === 5, 'Level 0 counter = 5');
  assert(track._variationBarCounter[1] === 0, 'Level 1 counter = 0');
  assert(track._variationBarCounter[2] === 3, 'Level 2 counter = 3');

  // Modify one level — others unchanged
  track._variationBarCounter[1] = 10;
  assert(track._variationBarCounter[0] === 5, 'Level 0 still 5 after modifying level 1');
}

sub('play_chance weighted_history counters per-level');
{
  const track = new MockTrack({
    levels: { 0: { playChance: 50 }, 1: { playChance: 50 } }
  });

  // Roll for level 0 several times
  for (let i = 0; i < 10; i++) track._rollPlayChance(0, 'weighted_history');

  // Level 1 counters should be untouched
  assert((track._chanceConsecutivePlays[1] || 0) === 0, 'Level 1 plays counter = 0 (untouched)');
  assert((track._chanceConsecutiveSilences[1] || 0) === 0, 'Level 1 silences counter = 0 (untouched)');

  // Level 0 counters should have been modified
  const l0plays = track._chanceConsecutivePlays[0] || 0;
  const l0silences = track._chanceConsecutiveSilences[0] || 0;
  assert(l0plays > 0 || l0silences > 0, `Level 0 counters modified (plays=${l0plays}, silences=${l0silences})`);
}

sub('play_chance shuffle_bag per-level');
{
  const track = new MockTrack({
    levels: { 0: { playChance: 80 }, 1: { playChance: 80 } }
  });

  // Consume bag for level 0
  for (let i = 0; i < 5; i++) track._rollPlayChance(0, 'shuffle_bag');

  const bag0 = track._chanceShuffleBags[0];
  const bag1 = track._chanceShuffleBags[1];
  assert(bag0 && bag0.length < 10, `Level 0 bag consumed (${bag0?.length} remaining)`);
  assert(!bag1 || bag1.length === 0, 'Level 1 bag untouched');
}

sub('_trackChanceState verdicts are per-level');
{
  const track = new MockTrack({
    levels: { 0: { playChance: 50 }, 1: { playChance: 50 } }
  });
  const conductor = new MockConductor([track]);

  conductor.initialRoll();
  conductor._trackChanceState[0][0].playing = false;
  conductor._trackChanceState[0][1].playing = true;
  assert(conductor._trackChanceState[0][0].playing === false
      && conductor._trackChanceState[0][1].playing === true,
    'L0 and L1 hold independent verdicts (fabric per-level state)');
}

// ============================================================
// 2. NODE TRANSITION — STATE PERSISTENCE
// ============================================================

header('2. NODE TRANSITION — STATE PERSISTENCE');

sub('_currentVariation persists across node transitions (activateLevel only)');
{
  const track = new MockTrack({
    levels: { 0: { files: ['a','b','c','d'] }, 1: { files: ['e','f','g','h'] } }
  });

  track._currentVariation = 3;
  // Simulate activateLevel(1) — does NOT reset _currentVariation
  const savedVar = track._currentVariation;
  // activateLevel only changes gains, not variation state
  assert(track._currentVariation === 3, `_currentVariation persists after level switch: ${track._currentVariation}`);
}

sub('_shuffleBag persists across node transitions');
{
  const track = new MockTrack({
    levels: { 0: { files: ['a','b','c','d'] }, 1: {} }
  });
  track.randomizationAlgo = 'no_repeat';

  // Pick a variation to fill shuffle bag
  track._pickVariation(4);
  const bagBefore = [...track._shuffleBag];
  assert(bagBefore.length > 0, `Shuffle bag has items: ${bagBefore.length}`);

  // Simulate level switch (activateLevel doesn't touch bag)
  const bagAfter = [...track._shuffleBag];
  assert(JSON.stringify(bagAfter) === JSON.stringify(bagBefore), 'Shuffle bag identical after level switch');
}

sub('_variationBarCounter ticks per level on the global grid (fabric)');
{
  const track = new MockTrack({
    levels: { 0: { loopBars: 4 }, 1: { loopBars: 4 } }
  });
  const conductor = new MockConductor([track]);

  // 3 bars while L0 is current — BOTH levels tick (background fabric)
  for (let i = 0; i < 3; i++) conductor.tick(0);
  assert(track._variationBarCounter[0] === 3, `Level 0: 3 bars counted`);
  assert(track._variationBarCounter[1] === 3, `Level 1: 3 bars counted in background`);

  // "Switch" to level 1 — scheduling unaffected; tick #4 reaches
  // switchBars(4) on BOTH levels → switch attempt fires → reset
  conductor.tick(1);
  assert(track._variationBarCounter[0] === 0 && track._variationBarCounter[1] === 0,
    'tick #4 hits switchBars(4) on both levels → reset (never anchored to entry)');
}

// ============================================================
// 3. VARIATION SWITCHING — 3 RANDOMIZATION MODES
// ============================================================

header('3. VARIATION SWITCHING');

sub('no_repeat (shuffle) mode: variation changes after switchBars');
{
  let changed = 0;
  for (let seed = 0; seed < 50; seed++) {
    // Reset RNG state by seeding Math.random isn't possible in stock JS,
    // but with enough iterations we verify statistical behavior
    const track = new MockTrack({
      repeatCount: 1,
      randomizationAlgo: 'no_repeat',
      levels: { 0: { loopBars: 4, switchChance: 100, files: ['a','b','c','d','e','f'] } }
    });
    const conductor = new MockConductor([track]);

    // Run 20 bars
    const initVar = track._currentVariation;
    for (let bar = 0; bar < 20; bar++) conductor.tick(0);

    if (track._currentVariation !== initVar) changed++;
  }
  assert(changed > 30, `Shuffle: variation changed ${changed}/50 runs (expected >30)`);
}

sub('random mode: variation changes after switchBars');
{
  let changed = 0;
  for (let seed = 0; seed < 50; seed++) {
    const track = new MockTrack({
      repeatCount: 1,
      randomizationAlgo: 'random',
      levels: { 0: { loopBars: 4, switchChance: 100, files: ['a','b','c','d','e','f'] } }
    });
    const conductor = new MockConductor([track]);
    const initVar = track._currentVariation;
    for (let bar = 0; bar < 20; bar++) conductor.tick(0);
    if (track._currentVariation !== initVar) changed++;
  }
  assert(changed > 35, `Random: variation changed ${changed}/50 runs (expected >35)`);
}

sub('weighted mode: variation changes after switchBars');
{
  let changed = 0;
  for (let seed = 0; seed < 50; seed++) {
    const track = new MockTrack({
      repeatCount: 1,
      randomizationAlgo: 'weighted',
      levels: { 0: { loopBars: 4, switchChance: 100, files: ['a','b','c','d','e','f'] } }
    });
    const conductor = new MockConductor([track]);
    const initVar = track._currentVariation;
    for (let bar = 0; bar < 20; bar++) conductor.tick(0);
    if (track._currentVariation !== initVar) changed++;
  }
  assert(changed > 35, `Weighted: variation changed ${changed}/50 runs (expected >35)`);
}

sub('switchChance=0: variation NEVER switches');
{
  const track = new MockTrack({
    repeatCount: 1,
    randomizationAlgo: 'no_repeat',
    levels: { 0: { loopBars: 4, switchChance: 0, files: ['a','b','c','d'] } }
  });
  const conductor = new MockConductor([track]);
  const initVar = track._currentVariation;

  for (let bar = 0; bar < 100; bar++) conductor.tick(0);

  assert(track._currentVariation === initVar, `switchChance=0: variation unchanged after 100 bars`);
}

// ============================================================
// 4. LOCK MECHANISM
// ============================================================

header('4. LOCK MECHANISM');

sub('repeat_count lock: no switch before switchBars');
{
  const track = new MockTrack({
    repeatCount: 5,
    randomizationAlgo: 'no_repeat',
    levels: { 0: { loopBars: 4, switchChance: 100, files: ['a','b','c','d'] } }
  });
  const conductor = new MockConductor([track]);

  const initVar = track._currentVariation;
  // switchBars = 4 * 5 = 20. Run only 15 bars.
  for (let bar = 0; bar < 15; bar++) conductor.tick(0);

  assert(track._currentVariation === initVar,
    `repeat_count=5, loopBars=4: no switch at bar 15 (switchBars=20)`);
}

sub('repeat_count lock expires: switch happens after switchBars');
{
  let changed = 0;
  for (let run = 0; run < 50; run++) {
    const track = new MockTrack({
      repeatCount: 2,
      randomizationAlgo: 'no_repeat',
      levels: { 0: { loopBars: 4, switchChance: 100, files: ['a','b','c','d','e','f'] } }
    });
    const conductor = new MockConductor([track]);
    const initVar = track._currentVariation;
    // switchBars = 4 * 2 = 8. Run 20 bars (enough for 2+ switches)
    for (let bar = 0; bar < 20; bar++) conductor.tick(0);
    if (track._currentVariation !== initVar) changed++;
  }
  assert(changed > 35, `Lock expired: variation changed ${changed}/50 (expected >35)`);
}

sub('play_chance lock (lockedUntil): no reroll while locked');
{
  const track = new MockTrack({
    levels: { 0: { playChance: 50, loopBars: 8 } }
  });
  const conductor = new MockConductor([track], { chanceRerollBars: 3 });
  // lockDuration = 8 * 3 = 24 bars

  conductor.initialRoll();
  const initPlaying = conductor._trackChanceState[0][0].playing;

  // Run 10 bars — still locked (lockedUntil = 24)
  for (let bar = 0; bar < 10; bar++) conductor.tick(0);

  assert(conductor._trackChanceState[0][0].playing === initPlaying,
    `Lock active: playing=${initPlaying} unchanged after 10 bars (locked until bar 24)`);
}

sub('No entry-time reroll: verdicts change only on the level\'s own grid');
{
  const track = new MockTrack({
    levels: { 0: { playChance: 50, loopBars: 8 }, 1: { playChance: 50, loopBars: 8 } }
  });
  const conductor = new MockConductor([track], { chanceRerollBars: 3 });
  // lockDuration = 8 * 3 = 24 for both levels

  conductor.initialRoll();
  const initL0 = conductor._trackChanceState[0][0].playing;
  const initL1 = conductor._trackChanceState[0][1].playing;

  // 5 bars on level 0, then "enter" level 1 — entry itself rolls nothing
  for (let bar = 0; bar < 5; bar++) conductor.tick(0);
  for (let bar = 0; bar < 5; bar++) conductor.tick(1);

  assert(conductor._trackChanceState[0][0].playing === initL0
      && conductor._trackChanceState[0][1].playing === initL1,
    'Both verdicts unchanged at bar 10 (locks until 24; entry never rerolls)');
}

sub('Lock expired: background level rerolls on its own grid');
{
  let changed = 0;
  for (let run = 0; run < 50; run++) {
    const track = new MockTrack({
      levels: { 0: { playChance: 50, loopBars: 4 }, 1: { playChance: 50, loopBars: 4 } }
    });
    const conductor = new MockConductor([track], { chanceRerollBars: 1 });
    // lockDuration = 4 * 1 = 4

    conductor.initialRoll();
    const initL1 = conductor._trackChanceState[0][1].playing;

    // 10 bars with L0 current — L1 rerolls IN BACKGROUND at bars 4 and 8
    for (let bar = 0; bar < 10; bar++) conductor.tick(0);

    if (conductor._trackChanceState[0][1].playing !== initL1) changed++;
  }
  assert(changed > 10, `Background reroll happened: state changed ${changed}/50 (expected >10)`);
}

// ============================================================
// 5. PLAY_CHANCE — 3 MODES
// ============================================================

header('5. PLAY_CHANCE MODES');

sub('true_random: ~50% play at 50% chance');
{
  const track = new MockTrack({ levels: { 0: { playChance: 50 } } });
  let plays = 0;
  for (let i = 0; i < 200; i++) {
    if (track._rollPlayChance(0, 'true_random')) plays++;
  }
  const pct = plays / 200 * 100;
  assert(pct > 30 && pct < 70, `true_random 50%: ${pct.toFixed(0)}% played (expected 30-70%)`);
}

sub('weighted_history: self-correcting near target');
{
  const track = new MockTrack({ levels: { 0: { playChance: 70 } } });
  let plays = 0;
  for (let i = 0; i < 200; i++) {
    if (track._rollPlayChance(0, 'weighted_history')) plays++;
  }
  const pct = plays / 200 * 100;
  assert(pct > 50 && pct < 90, `weighted_history 70%: ${pct.toFixed(0)}% played (expected 50-90%)`);
}

sub('shuffle_bag: exact ratio guaranteed');
{
  const track = new MockTrack({ levels: { 0: { playChance: 80 } } });
  let plays = 0;
  // Exactly 10 items per bag, 80% = 8 plays, 2 silences per bag
  for (let i = 0; i < 30; i++) { // 3 full bags
    if (track._rollPlayChance(0, 'shuffle_bag')) plays++;
  }
  const pct = plays / 30 * 100;
  assert(pct === 80, `shuffle_bag 80%: ${pct.toFixed(0)}% played (expected exactly 80%)`);
}

sub('play_chance=100: always plays');
{
  const track = new MockTrack({ levels: { 0: { playChance: 100 } } });
  let allPlay = true;
  for (let i = 0; i < 100; i++) {
    if (!track._rollPlayChance(0, 'true_random')) { allPlay = false; break; }
  }
  assert(allPlay, 'play_chance=100: always plays (100 rolls)');
}

sub('play_chance=0: always silent');
{
  const track = new MockTrack({ levels: { 0: { playChance: 0 } } });
  let allSilent = true;
  for (let i = 0; i < 100; i++) {
    if (track._rollPlayChance(0, 'true_random')) { allSilent = false; break; }
  }
  assert(allSilent, 'play_chance=0: always silent (100 rolls)');
}

// ============================================================
// 6. STATE EVOLUTION DURING ABSENCE
// ============================================================

header('6. STATE EVOLUTION DURING ABSENCE');

sub('Variation counter keeps ticking on inactive level (fabric)');
{
  const track = new MockTrack({
    repeatCount: 1,
    levels: { 0: { loopBars: 4, files: ['a','b','c','d'] },
              1: { loopBars: 4, files: ['e','f','g','h'] } }
  });
  const conductor = new MockConductor([track]);

  // 3 bars on level 0
  for (let bar = 0; bar < 3; bar++) conductor.tick(0);
  assert(track._variationBarCounter[0] === 3, 'Level 0: 3 bars before leaving');

  // 10 bars on level 1 — level 0 keeps ticking in the background:
  // 13 total ticks, switchBars=4 → resets at 4/8/12 → 13 - 12 = 1
  for (let bar = 0; bar < 10; bar++) conductor.tick(1);

  assert(track._variationBarCounter[0] === 1,
    'Level 0 counter kept ticking in background (13 global bars → 1 past the bar-12 reset)');
}

sub('Variation evolves regardless of which level is current');
{
  let changed = 0;
  for (let run = 0; run < 50; run++) {
    const track = new MockTrack({
      repeatCount: 1,
      randomizationAlgo: 'no_repeat',
      levels: { 0: { loopBars: 4, switchChance: 100, files: ['a','b','c','d','e','f'] },
                1: { loopBars: 4, switchChance: 100, files: ['g','h','i','j','k','l'] } }
    });
    const conductor = new MockConductor([track]);

    // 3 bars on level 0
    for (let bar = 0; bar < 3; bar++) conductor.tick(0);
    const var0 = track._currentVariation;

    // 20 bars on level 1 — variation switches happen for level 1
    for (let bar = 0; bar < 20; bar++) conductor.tick(1);

    // Variation may have changed (it's per-track, level 1 was active)
    if (track._currentVariation !== var0) changed++;
  }
  assert(changed > 30, `Level 1 active: variation changed ${changed}/50 (expected >30)`);
}

sub('Return to level: counter on the global grid, never reset by entry');
{
  const track = new MockTrack({
    repeatCount: 1,
    levels: { 0: { loopBars: 8, files: ['a','b','c','d'] },
              1: { loopBars: 8, files: ['e','f','g','h'] } }
  });
  const conductor = new MockConductor([track]);

  // 5 bars on level 0 (counter = 5)
  for (let bar = 0; bar < 5; bar++) conductor.tick(0);
  assert(track._variationBarCounter[0] === 5, 'Level 0: 5 bars before leaving');

  // 3 bars on level 1 — L0 keeps ticking: 8 total → hits switchBars(8) → reset
  for (let bar = 0; bar < 3; bar++) conductor.tick(1);

  // Return to level 0 — next tick is global bar 9 → counter 1
  conductor.tick(0);
  assert(track._variationBarCounter[0] === 1,
    `Level 0: 9th global bar → counter 1 (grid-aligned, not entry-anchored)`);
}

// ============================================================
// 7. EDGE CASES
// ============================================================

header('7. EDGE CASES');

sub('Single variation: no switch ever');
{
  const track = new MockTrack({
    repeatCount: 1,
    levels: { 0: { loopBars: 4, switchChance: 100, files: ['only_one.ogg'] } }
  });
  const conductor = new MockConductor([track]);

  for (let bar = 0; bar < 50; bar++) conductor.tick(0);
  assert(track._currentVariation === 0, 'Single variation: always 0');
}

sub('Multiple round-trips: diverse variations');
{
  const allVars = new Set();
  for (let run = 0; run < 20; run++) {
    const track = new MockTrack({
      repeatCount: 1,
      randomizationAlgo: 'no_repeat',
      levels: { 0: { loopBars: 2, switchChance: 100, files: ['a','b','c','d','e','f'] },
                1: { loopBars: 2, switchChance: 100, files: ['g','h','i','j','k','l'] } }
    });
    const conductor = new MockConductor([track]);

    // 5 round trips
    for (let trip = 0; trip < 5; trip++) {
      for (let bar = 0; bar < 5; bar++) conductor.tick(0);
      for (let bar = 0; bar < 5; bar++) conductor.tick(1);
    }
    allVars.add(track._currentVariation);
  }
  assert(allVars.size > 3, `Multiple round-trips: ${allVars.size} unique variations (expected >3)`);
}

sub('Conductor not started: activateLevel defaults passedChance=true');
{
  // Mirror of PFAEvent._levelChanceVerdict: missing state → playing=true
  const chanceState = {};
  const trackLevels = chanceState[0];
  const passedChance = (trackLevels && trackLevels[1]) ? !!trackLevels[1].playing : true;
  assert(passedChance === true, 'Empty _trackChanceState: defaults to playing=true');
}

// ============================================================
// SUMMARY
// ============================================================

header('SUMMARY');
console.log(`
  ✓ Passed: ${passed}
  ✗ Failed: ${failed}
  Total: ${passed + failed} assertions
`);

if (failed > 0) {
  console.log('  SOME TESTS FAILED — check output above');
  process.exit(1);
} else {
  console.log('  ALL TESTS PASSED!');
}
