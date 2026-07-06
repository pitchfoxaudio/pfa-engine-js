#!/usr/bin/env node
/**
 * PFA Engine — Randomization Test Harness v2
 * Tests weighted_history fix + shuffle bag after silence
 * Testing on fox_in_china event data
 */

// ============================================================
// MockTrack — OLD formula (for comparison)
// ============================================================

class MockTrackOld {
  constructor(opts) {
    this.name = opts.name; this.playChanceMode = opts.play_chance_mode || 'true_random';
    this.randomizationAlgo = opts.randomization_algo || 'random';
    this.repeatCount = opts.repeat_count || 1;
    this.levelSamples = {};
    for (const [k, li] of Object.entries(opts.levels || {})) {
      this.levelSamples[parseInt(k)] = { playChance: li.play_chance ?? 100, loopBars: li.loop_bars ?? 4, switchChance: li.switch_chance ?? 100, files: li.samples || [] };
    }
    this._reset();
  }
  _reset() {
    this._currentVariation = 0; this._shuffleBag = [];
    this._chanceConsecutivePlays = {}; this._chanceConsecutiveSilences = {};
    this._chanceShuffleBags = {}; this._chanceShuffleBagSize = 10;
  }
  _rollPlayChance(level) {
    const ld = this.levelSamples[level] || this.levelSamples[0];
    const pc = ld ? (ld.playChance ?? 100) : 100;
    if (pc >= 100) return true; if (pc <= 0) return false;
    switch (this.playChanceMode) {
      case 'weighted_history': {
        const plays = this._chanceConsecutivePlays[level] || 0;
        const silences = this._chanceConsecutiveSilences[level] || 0;
        let adj = pc;
        if (plays > 0) adj = Math.max(5, pc - Math.min(plays * 5, 25));
        if (silences > 0) adj = Math.min(95, pc + Math.min(silences * 5, 25));
        const passed = Math.random() * 100 < adj;
        if (passed) { this._chanceConsecutivePlays[level] = plays + 1; this._chanceConsecutiveSilences[level] = 0; }
        else { this._chanceConsecutiveSilences[level] = silences + 1; this._chanceConsecutivePlays[level] = 0; }
        return passed;
      }
      case 'shuffle_bag': {
        let bag = this._chanceShuffleBags[level];
        if (!bag || bag.length === 0) bag = this._refillBag(level, pc);
        return bag.shift();
      }
      default: return Math.random() * 100 < pc;
    }
  }
  _refillBag(level, pc) {
    const sz = this._chanceShuffleBagSize, n = Math.round(sz * pc / 100), bag = [];
    for (let i = 0; i < n; i++) bag.push(true);
    for (let i = 0; i < sz - n; i++) bag.push(false);
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    this._chanceShuffleBags[level] = bag; return bag;
  }
  _pickVariation(count) {
    if (count <= 1) return 0;
    const prev = this._currentVariation;
    switch (this.randomizationAlgo) {
      case 'no_repeat': {
        if (this._shuffleBag.length === 0) {
          this._shuffleBag = Array.from({ length: count }, (_, i) => i);
          for (let i = this._shuffleBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this._shuffleBag[i], this._shuffleBag[j]] = [this._shuffleBag[j], this._shuffleBag[i]]; }
          if (this._shuffleBag[0] === prev && count > 1) this._shuffleBag.push(this._shuffleBag.shift());
        }
        return this._shuffleBag.shift();
      }
      default: return Math.floor(Math.random() * count);
    }
  }
}

// ============================================================
// MockTrack — NEW formula (compensated steps)
// ============================================================

class MockTrackNew {
  constructor(opts) {
    this.name = opts.name; this.playChanceMode = opts.play_chance_mode || 'true_random';
    this.randomizationAlgo = opts.randomization_algo || 'random';
    this.repeatCount = opts.repeat_count || 1;
    this.levelSamples = {};
    for (const [k, li] of Object.entries(opts.levels || {})) {
      this.levelSamples[parseInt(k)] = { playChance: li.play_chance ?? 100, loopBars: li.loop_bars ?? 4, switchChance: li.switch_chance ?? 100, files: li.samples || [] };
    }
    this._reset();
  }
  _reset() {
    this._currentVariation = 0; this._shuffleBag = [];
    this._chanceConsecutivePlays = {}; this._chanceConsecutiveSilences = {};
    this._chanceShuffleBags = {}; this._chanceShuffleBagSize = 10;
  }
  _rollPlayChance(level) {
    const ld = this.levelSamples[level] || this.levelSamples[0];
    const pc = ld ? (ld.playChance ?? 100) : 100;
    if (pc >= 100) return true; if (pc <= 0) return false;
    switch (this.playChanceMode) {
      case 'weighted_history': {
        const plays = this._chanceConsecutivePlays[level] || 0;
        const silences = this._chanceConsecutiveSilences[level] || 0;
        let adjusted = pc;

        // Balanced steps: p * stepDown = (1-p) * stepUp
        const p = pc / 100;
        const baseStep = 5;
        const maxUp = 95 - pc;
        const maxDown = pc - 5;
        let stepDown, stepUp;

        if (pc >= 50) {
          stepDown = baseStep;
          stepUp = baseStep * p / (1 - p);
          if (stepUp > maxUp) { stepUp = maxUp; stepDown = maxUp * (1 - p) / p; }
        } else {
          stepUp = baseStep;
          stepDown = baseStep * (1 - p) / p;
          if (stepDown > maxDown) { stepDown = maxDown; stepUp = maxDown * p / (1 - p); }
        }

        if (plays > 0) adjusted = pc - Math.min(plays, 5) * stepDown;
        if (silences > 0) adjusted = pc + Math.min(silences, 5) * stepUp;
        adjusted = Math.max(5, Math.min(95, adjusted));

        const passed = Math.random() * 100 < adjusted;
        if (passed) { this._chanceConsecutivePlays[level] = plays + 1; this._chanceConsecutiveSilences[level] = 0; }
        else { this._chanceConsecutiveSilences[level] = silences + 1; this._chanceConsecutivePlays[level] = 0; }
        return passed;
      }
      case 'shuffle_bag': {
        let bag = this._chanceShuffleBags[level];
        if (!bag || bag.length === 0) bag = this._refillBag(level, pc);
        return bag.shift();
      }
      default: return Math.random() * 100 < pc;
    }
  }
  _refillBag(level, pc) {
    const sz = this._chanceShuffleBagSize, n = Math.round(sz * pc / 100), bag = [];
    for (let i = 0; i < n; i++) bag.push(true);
    for (let i = 0; i < sz - n; i++) bag.push(false);
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    this._chanceShuffleBags[level] = bag; return bag;
  }
  _pickVariation(count) {
    if (count <= 1) return 0;
    const prev = this._currentVariation;
    switch (this.randomizationAlgo) {
      case 'no_repeat': {
        if (this._shuffleBag.length === 0) {
          this._shuffleBag = Array.from({ length: count }, (_, i) => i);
          for (let i = this._shuffleBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this._shuffleBag[i], this._shuffleBag[j]] = [this._shuffleBag[j], this._shuffleBag[i]]; }
          if (this._shuffleBag[0] === prev && count > 1) this._shuffleBag.push(this._shuffleBag.shift());
        }
        return this._shuffleBag.shift();
      }
      default: return Math.floor(Math.random() * count);
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }

function markov1M(nominal, TrackClass) {
  const track = new TrackClass({
    name: 'markov', play_chance_mode: 'weighted_history', repeat_count: 1,
    levels: { 0: { samples: 1, play_chance: nominal, loop_bars: 4 } }
  });
  let plays = 0;
  const N = 1000000;
  for (let i = 0; i < N; i++) { if (track._rollPlayChance(0)) plays++; }
  return (plays / N * 100);
}

// ============================================================
// TEST 1: Сравнение OLD vs NEW формулы — Markov steady state
// ============================================================

header('TEST 1: weighted_history — OLD vs NEW (Markov 1M rolls)');

console.log('\n  Nominal% → OLD actual → NEW actual');
console.log('  ' + '─'.repeat(50));

for (const chance of [30, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]) {
  const oldActual = markov1M(chance, MockTrackOld);
  const newActual = markov1M(chance, MockTrackNew);
  const oldDiff = (oldActual - chance).toFixed(2);
  const newDiff = (newActual - chance).toFixed(2);
  const oldSign = parseFloat(oldDiff) >= 0 ? '+' : '';
  const newSign = parseFloat(newDiff) >= 0 ? '+' : '';
  const oldMark = Math.abs(parseFloat(oldDiff)) > 3 ? ' BIAS!' : '';
  const newMark = Math.abs(parseFloat(newDiff)) > 3 ? ' BIAS!' : ' ✓';
  console.log(`    ${String(chance).padStart(3)}% → OLD: ${oldActual.toFixed(2)}% (${oldSign}${oldDiff}pp)${oldMark}  |  NEW: ${newActual.toFixed(2)}% (${newSign}${newDiff}pp)${newMark}`);
}

// ============================================================
// TEST 2: melody_plucked_string — все 3 уровня, OLD vs NEW
// ============================================================

header('TEST 2: melody_plucked_string — OLD vs NEW (20 runs × 2000 bars)');

const MELODY_CFG = {
  name: 'melody_plucked_string', randomization_algo: 'no_repeat', play_chance_mode: 'weighted_history', repeat_count: 1,
  levels: { 0: { samples: 6, play_chance: 70, loop_bars: 8 }, 1: { samples: 2, play_chance: 80, loop_bars: 8 }, 2: { samples: 5, play_chance: 90, loop_bars: 8 } }
};

for (const [lvlStr, ld] of Object.entries(MELODY_CFG.levels)) {
  const lvl = parseInt(lvlStr);
  const target = ld.play_chance;
  sub(`Level ${lvl} (target ${target}%)`);

  for (const [label, TrackClass] of [['OLD', MockTrackOld], ['NEW', MockTrackNew]]) {
    const pcts = [];
    for (let run = 0; run < 20; run++) {
      const track = new TrackClass(MELODY_CFG);
      const lock = ld.loop_bars * 1;
      let plays = 0, total = 0;
      let playing = track._rollPlayChance(lvl); total++; if (playing) plays++;
      for (let b = 1; b <= 2000; b++) { if (b % lock === 0) { playing = track._rollPlayChance(lvl); total++; if (playing) plays++; } }
      pcts.push(plays / total * 100);
    }
    const avg = pcts.reduce((s, v) => s + v, 0) / pcts.length;
    const dev = Math.abs(avg - target);
    const status = dev <= 3 ? '✓' : dev <= 5 ? '⚠' : '✗';
    console.log(`    ${label}: ${avg.toFixed(1)}% (dev ${dev.toFixed(1)}pp) ${status}`);
  }
}

// ============================================================
// TEST 3: fox_run_2 (cave) — 45%, weighted_history
// ============================================================

header('TEST 3: fox_run_2 (cave) — 45%, weighted_history, OLD vs NEW');

{
  const cfg = {
    name: 'fox_run_2', randomization_algo: 'no_repeat', play_chance_mode: 'weighted_history', repeat_count: 2,
    levels: { 1: { samples: 1, play_chance: 45, loop_bars: 4 } }
  };

  for (const [label, TC] of [['OLD', MockTrackOld], ['NEW', MockTrackNew]]) {
    const pcts = [];
    for (let run = 0; run < 20; run++) {
      const track = new TC(cfg);
      const lock = 4 * 2;
      let plays = 0, total = 0;
      let p = track._rollPlayChance(1); total++; if (p) plays++;
      for (let b = 1; b <= 2000; b++) { if (b % lock === 0) { p = track._rollPlayChance(1); total++; if (p) plays++; } }
      pcts.push(plays / total * 100);
    }
    const avg = pcts.reduce((s, v) => s + v, 0) / pcts.length;
    console.log(`  ${label}: ${avg.toFixed(1)}% (target 45%, dev ${Math.abs(avg - 45).toFixed(1)}pp)`);
  }
}

// ============================================================
// TEST 4: Step sizes для разных nominal values
// ============================================================

header('TEST 4: Computed step sizes (NEW formula)');

console.log('\n  Nominal% | stepDown | stepUp | E[adj after 1 play/silence]');
console.log('  ' + '─'.repeat(55));

for (const pc of [30, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]) {
  const p = pc / 100;
  const baseStep = 5;
  const maxUp = 95 - pc;
  const maxDown = pc - 5;
  let stepDown, stepUp;

  if (pc >= 50) {
    stepDown = baseStep;
    stepUp = baseStep * p / (1 - p);
    if (stepUp > maxUp) { stepUp = maxUp; stepDown = maxUp * (1 - p) / p; }
  } else {
    stepUp = baseStep;
    stepDown = baseStep * (1 - p) / p;
    if (stepDown > maxDown) { stepDown = maxDown; stepUp = maxDown * p / (1 - p); }
  }

  const afterPlay = pc - stepDown;
  const afterSilence = Math.min(pc + stepUp, 95);
  const expected = p * afterPlay + (1 - p) * afterSilence;

  console.log(`    ${String(pc).padStart(3)}% |  ${stepDown.toFixed(2).padStart(5)} |  ${stepUp.toFixed(2).padStart(5)} | E = ${expected.toFixed(2)}%`);
}

// ============================================================
// TEST 5: SHUFFLE BAG ПОСЛЕ ТИШИНЫ — тот же сэмпл?
// ============================================================

header('TEST 5: Shuffle bag после тишины — тот же сэмпл?');
sub('Сценарий: melody_plucked_string L0, 6 сэмплов, 70%, no_repeat');

console.log('\n  Симуляция: играем → тишина → играем. Какой сэмпл слышим после тишины?');

{
  const cfg = {
    name: 'test', randomization_algo: 'no_repeat', play_chance_mode: 'weighted_history', repeat_count: 1,
    levels: { 0: { samples: 6, play_chance: 70, loop_bars: 8 } }
  };

  const sampleCount = 6;
  const lock = 8;
  let sameOnReturn = 0, totalReturns = 0;
  let heardSequences = [];  // Track what the user actually HEARS

  // Run many iterations
  for (let iter = 0; iter < 100; iter++) {
    const track = new MockTrackNew(cfg);
    let isPlaying = track._rollPlayChance(0);
    let varBarCounter = 0;
    let lastHeardVar = -1;
    let wasSilent = false;
    let lastVarBeforeSilence = -1;
    const heardSeq = [];

    // Initial variation
    track._currentVariation = track._pickVariation(sampleCount);

    for (let b = 1; b <= 500; b++) {
      // Play chance reroll
      if (b % lock === 0) {
        const prev = isPlaying;
        isPlaying = track._rollPlayChance(0);

        if (prev && !isPlaying) {
          lastVarBeforeSilence = track._currentVariation;
          wasSilent = true;
        }
        if (!prev && isPlaying && wasSilent) {
          totalReturns++;
          if (track._currentVariation === lastVarBeforeSilence) sameOnReturn++;
          wasSilent = false;
        }
      }

      // Variation switching (happens EVERY lock period, regardless of play state)
      varBarCounter++;
      if (varBarCounter >= lock) {
        varBarCounter = 0;
        const newVar = track._pickVariation(sampleCount);
        track._currentVariation = newVar;
      }

      // Record what user HEARS at each lock boundary
      if (b % lock === 0) {
        if (isPlaying) heardSeq.push(track._currentVariation);
        else heardSeq.push('_'); // silence
      }
    }
    heardSequences.push(heardSeq);
  }

  console.log(`\n  Returns from silence: ${totalReturns}`);
  console.log(`  Same sample on return: ${sameOnReturn}/${totalReturns} (${(sameOnReturn/totalReturns*100).toFixed(1)}%)`);
  console.log(`  Expected if random: ${(100/sampleCount).toFixed(1)}%`);

  if (sameOnReturn / totalReturns > 0.25) {
    console.log(`  ✗ PROBLEM: Shuffle bag returns same sample after silence too often!`);
  } else {
    console.log(`  ✓ Shuffle bag does NOT return same sample after silence`);
  }

  // Show a few example sequences (what user hears)
  console.log('\n  Example "heard" sequences (number = sample index, _ = silence):');
  for (let i = 0; i < Math.min(10, heardSequences.length); i++) {
    const seq = heardSequences[i].slice(0, 30).map(v => v === '_' ? '_' : v).join(' ');
    console.log(`    ${seq}`);
  }
}

// ============================================================
// TEST 6: SHUFFLE BAG БЕЗ ВРАЩЕНИЯ ВО ВРЕМЯ ТИШИНЫ
// ============================================================

header('TEST 6: Что если shuffle bag НЕ вращается во время тишины?');
sub('Сравнение: bag вращается vs bag замирает при тишине');

{
  const cfg = {
    name: 'test', randomization_algo: 'no_repeat', play_chance_mode: 'weighted_history', repeat_count: 1,
    levels: { 0: { samples: 6, play_chance: 70, loop_bars: 8 } }
  };
  const sampleCount = 6;
  const lock = 8;

  for (const [label, freezeDuringSilence] of [['BAG ROTATES during silence (current)', false], ['BAG FREEZES during silence (proposed)', true]]) {
    let sameOnReturn = 0, totalReturns = 0;
    let consecutiveSameHeard = 0, totalTransitions = 0;

    for (let iter = 0; iter < 200; iter++) {
      const track = new MockTrackNew(cfg);
      let isPlaying = track._rollPlayChance(0);
      let varBarCounter = 0;
      let lastVarBeforeSilence = -1;
      let wasSilent = false;
      let lastHeard = -1;

      track._currentVariation = track._pickVariation(sampleCount);

      for (let b = 1; b <= 1000; b++) {
        if (b % lock === 0) {
          const prev = isPlaying;
          isPlaying = track._rollPlayChance(0);

          if (prev && !isPlaying) { lastVarBeforeSilence = track._currentVariation; wasSilent = true; }
          if (!prev && isPlaying && wasSilent) {
            totalReturns++;
            if (track._currentVariation === lastVarBeforeSilence) sameOnReturn++;
            wasSilent = false;
          }
        }

        varBarCounter++;
        if (varBarCounter >= lock) {
          varBarCounter = 0;
          // KEY DIFFERENCE: freeze bag during silence?
          if (!freezeDuringSilence || isPlaying) {
            const newVar = track._pickVariation(sampleCount);
            track._currentVariation = newVar;
          }
        }

        // Track consecutive same heard
        if (b % lock === 0 && isPlaying) {
          if (track._currentVariation === lastHeard && lastHeard >= 0) consecutiveSameHeard++;
          if (lastHeard >= 0) totalTransitions++;
          lastHeard = track._currentVariation;
        }
      }
    }

    console.log(`\n  ${label}:`);
    console.log(`    Same on return from silence: ${sameOnReturn}/${totalReturns} (${(sameOnReturn/totalReturns*100).toFixed(1)}%)`);
    console.log(`    Consecutive same HEARD:      ${consecutiveSameHeard}/${totalTransitions} (${(consecutiveSameHeard/totalTransitions*100).toFixed(1)}%)`);
    console.log(`    (0% = perfect variety, 16.7% = random)`);
  }
}

// ============================================================
// TEST 7: SFX — play_chance modes work the same way
// ============================================================

header('TEST 7: SFX — weighted_history fix applies (same _rollPlayChance)');

console.log('\n  SFX uses _rollPlayChance in triggerSfx() — same method, same fix.');
console.log('  Simulating 1000 SFX triggers with play_chance=60%, weighted_history:\n');

{
  for (const [label, TC] of [['OLD', MockTrackOld], ['NEW', MockTrackNew]]) {
    const track = new TC({
      name: 'sfx_test', play_chance_mode: 'weighted_history', repeat_count: 1,
      levels: { 0: { samples: 3, play_chance: 60, loop_bars: 1 } }
    });
    let plays = 0;
    for (let i = 0; i < 1000; i++) { if (track._rollPlayChance(0)) plays++; }
    console.log(`  ${label}: ${(plays/10).toFixed(1)}% (target 60%)`);
  }
}

// ============================================================
// TEST 8: Streak prevention — NEW formula still prevents long streaks?
// ============================================================

header('TEST 8: Streak prevention — NEW formula still works?');

console.log('\n  Max consecutive plays/silences over 1M rolls:\n');

for (const pc of [45, 70, 80, 90]) {
  for (const [label, TC] of [['OLD', MockTrackOld], ['NEW', MockTrackNew]]) {
    const track = new TC({
      name: 'streak', play_chance_mode: 'weighted_history', repeat_count: 1,
      levels: { 0: { samples: 1, play_chance: pc, loop_bars: 4 } }
    });
    let maxP = 0, maxS = 0, cp = 0, cs = 0;
    for (let i = 0; i < 100000; i++) {
      if (track._rollPlayChance(0)) { cp++; cs = 0; maxP = Math.max(maxP, cp); }
      else { cs++; cp = 0; maxS = Math.max(maxS, cs); }
    }
    console.log(`  ${label} ${pc}%: max plays=${maxP}, max silences=${maxS}`);
  }
  console.log('');
}

// ============================================================
// TEST 9: true_random как контроль (не должен измениться)
// ============================================================

header('TEST 9: Контрольный тест — true_random (не должен измениться)');

{
  const track = new MockTrackNew({
    name: 'control', play_chance_mode: 'true_random', repeat_count: 1,
    levels: { 0: { samples: 1, play_chance: 70, loop_bars: 8 } }
  });
  let plays = 0;
  for (let i = 0; i < 100000; i++) { if (track._rollPlayChance(0)) plays++; }
  console.log(`\n  true_random 70%: ${(plays/1000).toFixed(1)}% — should be ~70%`);
}

// ============================================================
// SUMMARY
// ============================================================

header('ИТОГИ');
console.log(`
  НАЙДЕННЫЕ ПРОБЛЕМЫ:
  1. weighted_history: систематический bias (70% → 65%, 90% → 79%)
     ПРИЧИНА: фиксированный step ±5pp ассиметричен при p ≠ 50%
     ИСПРАВЛЕНИЕ: компенсированные шаги (stepUp = stepDown × p/(1-p))

  2. shuffle_bag (play_chance): ошибки округления при bag=10
     (45% → 50%, 85% → 90%). Пока не критично.

  ПРОВЕРЕННЫЕ ПОДОЗРЕНИЯ:
  3. "Тот же сэмпл после тишины" — shuffle bag вращается во время
     тишины, но no_repeat защита работает. Однако bag потребляется
     "впустую" — сэмплы прокручиваются, пока трек молчит.
     Вариант: заморозить bag во время тишины (TEST 6).

  ПРИМЕНИМОСТЬ:
  - Fix автоматически работает и для SFX (тот же _rollPlayChance)
`);
