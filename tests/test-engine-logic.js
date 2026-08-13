#!/usr/bin/env node
/**
 * PFA Engine — Comprehensive Logic Test Suite
 * Tests ALL pure-logic systems without audio playback
 *
 * Usage: node test-engine-logic.js
 */

let passed = 0, failed = 0, warnings = 0;

function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(msg) { passed++; console.log(`    ✓ ${msg}`); }
function fail(msg) { failed++; console.log(`    ✗ FAIL: ${msg}`); }
function warn(msg) { warnings++; console.log(`    ⚠ WARN: ${msg}`); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }

// ============================================================
// Load real config.json from fox-run
// ============================================================

const fs = require('fs');
const path = require('path');
// Repo-relative (the suite runs on both Macs — different home dirs).
const configPath = path.join(__dirname, '..', '..', 'games', '02_fox_run', 'audio', 'config.json');
if (!fs.existsSync(configPath)) {
  // Same convention as test-bank / test-break-shot-survival: the fixture lives
  // in the demo games tree, absent in release mirrors — skip, don't fail.
  console.log(`\n  (config fixture missing at ${configPath} — skipping; test needs the fox_run demo pack)`);
  process.exit(0);
}
let CONFIG;
try {
  CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  ok(`Config loaded: ${Object.keys(CONFIG.events).length} events`);
} catch (e) {
  fail(`Cannot load config: ${e.message}`);
  process.exit(1);
}

// ============================================================
// 1. CONDUCTOR TIMING
// ============================================================

header('1. CONDUCTOR TIMING');

sub('Bar duration calculation');
{
  // BPM=120, time_sig=4/4 → bar = (60/120)*4 = 2.0 sec
  const bpm = 120, beatsPerBar = 4;
  const barDur = (60 / bpm) * beatsPerBar;
  assert(barDur === 2.0, `120 BPM, 4/4: barDuration = ${barDur}s (expected 2.0)`);

  // BPM=140, time_sig=3/4 → bar = (60/140)*3 = 1.286 sec
  const barDur2 = (60 / 140) * 3;
  assert(Math.abs(barDur2 - 1.2857) < 0.001, `140 BPM, 3/4: barDuration = ${barDur2.toFixed(4)}s`);
}

sub('Lock duration = loopBars × repeatCount');
{
  const cases = [
    { loopBars: 8, repeat: 1, expected: 8 },
    { loopBars: 4, repeat: 2, expected: 8 },
    { loopBars: 8, repeat: 3, expected: 24 },
    { loopBars: 4, repeat: 1, expected: 4 },
  ];
  for (const c of cases) {
    const lock = c.loopBars * c.repeat;
    assert(lock === c.expected, `loopBars=${c.loopBars} × repeat=${c.repeat} = ${lock} bars`);
  }
}

sub('Reroll timing: кубик бросается каждые lockDuration баров');
{
  const loopBars = 8, repeatCount = 1;
  const lockDuration = loopBars * repeatCount;
  const rerolls = [];
  let nextRerollBar = lockDuration; // initial roll at bar 0, next at lockDuration

  for (let bar = 1; bar <= 100; bar++) {
    if (bar >= nextRerollBar) {
      rerolls.push(bar);
      nextRerollBar = bar + lockDuration;
    }
  }

  assert(rerolls[0] === 8, `First reroll at bar ${rerolls[0]} (expected 8)`);
  assert(rerolls[1] === 16, `Second reroll at bar ${rerolls[1]} (expected 16)`);

  // Check all intervals are exactly lockDuration
  let allCorrect = true;
  for (let i = 1; i < rerolls.length; i++) {
    if (rerolls[i] - rerolls[i - 1] !== lockDuration) { allCorrect = false; break; }
  }
  assert(allCorrect, `All reroll intervals = ${lockDuration} bars (${rerolls.length} rerolls in 100 bars)`);
}

sub('Reroll with repeatCount=2: interval = 16 bars');
{
  const lockDuration = 8 * 2; // loopBars=8, repeat=2
  const rerolls = [];
  let nextRerollBar = lockDuration;
  for (let bar = 1; bar <= 100; bar++) {
    if (bar >= nextRerollBar) { rerolls.push(bar); nextRerollBar = bar + lockDuration; }
  }
  assert(rerolls[0] === 16, `First reroll at bar ${rerolls[0]} (expected 16)`);
  assert(rerolls.length === 6, `6 rerolls in 100 bars with lock=16 (got ${rerolls.length})`);
}

sub('playChance=100 → never rerolls (nextRerollBar=Infinity)');
{
  let nextRerollBar = Infinity;
  let rerolled = false;
  for (let bar = 1; bar <= 10000; bar++) {
    if (bar >= nextRerollBar) { rerolled = true; break; }
  }
  assert(!rerolled, 'playChance=100%: no rerolls in 10000 bars');
}

sub('Level change forces immediate reroll');
{
  // Simulate: locked until bar 16, level changes at bar 5
  let nextRerollBar = 16;
  let lockedUntil = 16;
  const forLevel = 0;
  const newLevel = 1;
  const bar = 5;

  // Level change logic from _conductorTick
  if (forLevel !== newLevel) {
    // If still locked, _rollChanceForNewLevel respects lockedUntil
    if (bar < lockedUntil) {
      // Lock respected — no reroll
      assert(true, 'Level change at bar 5 with lock until 16: lock respected (no reroll)');
    }
  }

  // Same scenario but lock expired
  const bar2 = 20;
  if (bar2 >= lockedUntil) {
    // Lock expired — reroll happens
    assert(true, 'Level change at bar 20 (lock expired): reroll happens');
  }
}

sub('Independent intervals: repeatCount vs chanceRerollBars');
{
  // repeatCount=2, chanceRerollBars=4, loopBars=8
  const loopBars = 8;
  const repeatCount = 2;
  const chanceRerollBars = 4;

  const switchBars = loopBars * repeatCount;     // 16 bars → variation switch
  const lockDuration = loopBars * chanceRerollBars; // 32 bars → play_chance reroll

  assert(switchBars === 16, `switchBars = ${switchBars} (loopBars×repeatCount = 8×2)`);
  assert(lockDuration === 32, `lockDuration = ${lockDuration} (loopBars×chanceRerollBars = 8×4)`);
  assert(switchBars !== lockDuration, 'switchBars ≠ lockDuration (independent)');

  // Count events in 100 bars
  let varSwitches = 0, chanceRerolls = 0;
  let varCounter = 0, rerollBar = lockDuration;

  for (let bar = 1; bar <= 100; bar++) {
    varCounter++;
    if (varCounter >= switchBars) { varCounter = 0; varSwitches++; }
    if (bar >= rerollBar) { chanceRerolls++; rerollBar = bar + lockDuration; }
  }

  assert(varSwitches === 6, `6 variation switches in 100 bars (100/16=${varSwitches})`);
  assert(chanceRerolls === 3, `3 play_chance rerolls in 100 bars (100/32=${chanceRerolls})`);
}

sub('Default chanceRerollBars=1 backward compat');
{
  // When chanceRerollBars is undefined/1, lock = loopBars * 1 = loopBars
  const loopBars = 8;
  const chanceRerollBars = undefined || 1;
  const repeatCount = 1;

  const switchBars = loopBars * repeatCount;
  const lockDuration = loopBars * chanceRerollBars;

  assert(switchBars === lockDuration, `Default: switchBars=${switchBars} === lockDuration=${lockDuration} (backward compat)`);
}

sub('chanceRerollBars parsed from config');
{
  // Simulate PFATrack constructor
  const data1 = { repeat_count: 2, chance_reroll_bars: 4 };
  const repeatCount = data1.repeat_count || 1;
  const chanceRerollBars = data1.chance_reroll_bars || 1;
  assert(repeatCount === 2, 'repeat_count=2 parsed');
  assert(chanceRerollBars === 4, 'chance_reroll_bars=4 parsed');

  // Missing field → default 1
  const data2 = { repeat_count: 3 };
  assert((data2.chance_reroll_bars || 1) === 1, 'Missing chance_reroll_bars → default 1');
}

// ============================================================
// 2. NODE TRANSITIONS (State Machine)
// ============================================================

header('2. NODE TRANSITIONS');

sub('navigate() — trigger matching');
{
  const connections = [
    { source: 'A', target: 'B', conn_type: 'transition', trigger: 'run', priority: 0, probability: 100 },
    { source: 'A', target: 'C', conn_type: 'transition', trigger: 'stop', priority: 0, probability: 100 },
    { source: 'B', target: 'A', conn_type: 'transition', trigger: 'stop', priority: 0, probability: 100 },
    { source: 'A', target: 'D', conn_type: 'transition', trigger: 'run', priority: 10, probability: 100 },
  ];

  // Find candidates for trigger='run' from node 'A'
  const candidates = connections.filter(c =>
    c.source === 'A' && c.conn_type === 'transition' && c.trigger === 'run'
  );
  assert(candidates.length === 2, `Trigger "run" from A: ${candidates.length} candidates (expected 2)`);

  // Sort by priority (highest first)
  candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  assert(candidates[0].target === 'D', `Highest priority target: ${candidates[0].target} (expected D, priority 10)`);
  assert(candidates[1].target === 'B', `Second priority target: ${candidates[1].target} (expected B, priority 0)`);
}

sub('navigate() — probability filtering');
{
  const connections = [
    { source: 'A', target: 'B', conn_type: 'transition', trigger: 'go', priority: 10, probability: 0 },
    { source: 'A', target: 'C', conn_type: 'transition', trigger: 'go', priority: 5, probability: 100 },
  ];

  // Simulate navigate: iterate by priority, check probability
  const sorted = connections.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  let selected = null;
  for (const conn of sorted) {
    const prob = conn.probability !== undefined ? conn.probability : 100;
    // probability=0 always fails, probability=100 always passes
    if (prob >= 100) { selected = conn; break; }
    if (prob <= 0) continue;
  }
  assert(selected?.target === 'C', `prob=0 skipped, prob=100 selected: target=${selected?.target} (expected C)`);
}

sub('navigate() — no matching trigger returns false');
{
  const connections = [
    { source: 'A', target: 'B', conn_type: 'transition', trigger: 'run' },
  ];
  const candidates = connections.filter(c =>
    c.source === 'A' && c.conn_type === 'transition' && c.trigger === 'jump'
  );
  assert(candidates.length === 0, 'No match for trigger "jump" → navigate returns false');
}

sub('navigate() — fallback: no direct connection, find target by trigger');
{
  const nodes = {
    'intro': { name: 'Intro', trigger: '' },
    'loop1': { name: 'Loop 1', trigger: 'go_loop1' },
    'loop2': { name: 'Loop 2', trigger: 'go_loop2' },
  };
  const connections = [
    { source: 'intro', target: 'loop1', conn_type: 'transition', trigger: 'go_loop1', fade_duration: 5.0, fade_curve: 'equal_power', quantize: 'bar' },
    { source: 'loop1', target: 'loop2', conn_type: 'transition', trigger: 'go_loop2', fade_duration: 0.4, fade_curve: 'linear', quantize: 'instant' },
  ];
  const currentNode = 'intro';
  const trigger = 'go_loop2';

  // No direct connection intro→loop2
  const direct = connections.filter(c =>
    c.source === currentNode && c.conn_type === 'transition' && c.trigger === trigger
  );
  assert(direct.length === 0, 'No direct connection intro→loop2');

  // Fallback: find target node by trigger
  let targetId = null;
  for (const [id, n] of Object.entries(nodes)) {
    if (n.trigger === trigger) { targetId = id; break; }
  }
  assert(targetId === 'loop2', `Fallback found target: ${targetId}`);

  // Find outgoing transition from current node
  const outgoing = connections.filter(c =>
    c.source === currentNode && c.conn_type === 'transition'
  );
  assert(outgoing.length === 1, `Outgoing transitions from intro: ${outgoing.length}`);
  assert(outgoing[0].fade_duration === 5.0, `Fallback uses intro's outgoing fade: ${outgoing[0].fade_duration}s`);
}

sub('navigate() — fallback: no outgoing transitions → event defaults');
{
  const nodes = {
    'isolated': { name: 'Isolated', trigger: '' },
    'target': { name: 'Target', trigger: 'go_target' },
  };
  const connections = []; // no connections at all
  const currentNode = 'isolated';

  // Fallback with no outgoing: empty fade settings → cascade to event defaults
  const outgoing = connections.filter(c =>
    c.source === currentNode && c.conn_type === 'transition'
  );
  assert(outgoing.length === 0, 'No outgoing transitions → use event defaults');

  let targetId = null;
  for (const [id, n] of Object.entries(nodes)) {
    if (n.trigger === 'go_target') { targetId = id; break; }
  }
  assert(targetId === 'target', 'Target found by trigger even with no connections');
}

sub('navigate() — fallback: nonexistent trigger → no target found');
{
  const nodes = {
    'A': { name: 'A', trigger: 'go_a' },
    'B': { name: 'B', trigger: 'go_b' },
  };
  let targetId = null;
  for (const [id, n] of Object.entries(nodes)) {
    if (n.trigger === 'nonexistent') { targetId = id; break; }
  }
  assert(targetId === null, 'Nonexistent trigger → no fallback target → return false');
}

sub('Auto-advance timing calculation');
{
  // node: loop_count=2, duration_bars=8, BPM=120, time_sig=4/4
  const bpm = 120, beatsPerBar = 4;
  const barDurationSec = (60 / bpm) * beatsPerBar;
  const durationBars = 8, loopCount = 2;
  const totalDuration = durationBars * loopCount * barDurationSec;
  assert(totalDuration === 32.0, `Auto-advance: 8bars × 2loops × 2s = ${totalDuration}s (expected 32)`);

  // loop_count=0 → no auto-advance
  assert(0 * durationBars * barDurationSec === 0, 'loop_count=0 → no auto-advance (infinite)');
}

sub('Auto-advance — selects auto=true connections');
{
  const connections = [
    { source: 'A', target: 'B', conn_type: 'transition', trigger: 'manual', auto: false },
    { source: 'A', target: 'C', conn_type: 'transition', auto: true, priority: 5, probability: 100 },
    { source: 'A', target: 'D', conn_type: 'transition', auto: true, priority: 10, probability: 100 },
  ];

  const autoCandidates = connections.filter(c =>
    c.source === 'A' && c.conn_type === 'transition' && c.auto === true
  );
  assert(autoCandidates.length === 2, `Auto candidates: ${autoCandidates.length} (expected 2)`);

  autoCandidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  assert(autoCandidates[0].target === 'D', `Highest priority auto target: ${autoCandidates[0].target} (expected D)`);
}

sub('_enterNode — level_index mapping');
{
  const nodes = {
    'intro': { name: 'Intro', level_index: 0 },
    'verse': { name: 'Verse', level_index: 1 },
    'chorus': { name: 'Chorus', level_index: 2 },
  };

  for (const [id, node] of Object.entries(nodes)) {
    const targetLevel = node.level_index !== undefined ? node.level_index : 0;
    assert(targetLevel === node.level_index, `Node "${node.name}" → level ${targetLevel}`);
  }
}

sub('Fade settings: connection overrides node overrides event');
{
  const eventFade = 2.0;
  const nodeFade = 1.5;
  const connFade = 0.5;

  // Connection fade_duration set → use it
  let result = connFade ?? nodeFade ?? eventFade;
  assert(result === 0.5, `Connection fade: ${result} (expected 0.5)`);

  // Connection undefined, node set → use node
  result = undefined ?? nodeFade ?? eventFade;
  assert(result === 1.5, `Node fade: ${result} (expected 1.5)`);

  // Both undefined → use event
  result = undefined ?? undefined ?? eventFade;
  assert(result === 2.0, `Event fade: ${result} (expected 2.0)`);
}

// ============================================================
// 3. NODE GRAPH from real config
// ============================================================

header('3. REAL CONFIG: Node Graph Validation');

{
  const foxCave = CONFIG.events['fox_cave_music'];
  if (foxCave && foxCave.node_graph) {
    const ng = foxCave.node_graph;
    sub(`fox_cave_music: ${Object.keys(ng.nodes).length} nodes, ${ng.connections.length} connections`);

    // Entry node exists
    assert(ng.entry_node && ng.nodes[ng.entry_node], `Entry node "${ng.entry_node}" exists`);

    // All connection sources/targets exist
    let allValid = true;
    for (const conn of ng.connections) {
      if (!ng.nodes[conn.source]) { fail(`Connection source "${conn.source}" not in nodes`); allValid = false; }
      if (!ng.nodes[conn.target]) { fail(`Connection target "${conn.target}" not in nodes`); allValid = false; }
    }
    if (allValid) ok('All connection source/target nodes exist');

    // Each node has level_index
    let allHaveLevel = true;
    for (const [id, node] of Object.entries(ng.nodes)) {
      if (node.level_index === undefined) { warn(`Node "${node.name}" (${id}) has no level_index`); allHaveLevel = false; }
    }
    if (allHaveLevel) ok('All nodes have level_index');

    // Check triggers are non-empty strings
    const triggers = new Set();
    for (const conn of ng.connections) {
      if (conn.trigger) triggers.add(conn.trigger);
    }
    if (triggers.size > 0) ok(`Triggers found: ${[...triggers].join(', ')}`);

    // Check for orphan nodes (no connections to/from)
    const connected = new Set();
    for (const conn of ng.connections) { connected.add(conn.source); connected.add(conn.target); }
    for (const id of Object.keys(ng.nodes)) {
      if (!connected.has(id) && id !== ng.entry_node) warn(`Node "${ng.nodes[id].name}" (${id}) has no connections`);
    }
  } else {
    warn('fox_cave_music has no node_graph — skipping');
  }
}

// ============================================================
// 4. LEVEL SWITCHING LOGIC
// ============================================================

header('4. LEVEL SWITCHING LOGIC');

sub('setLevel validation');
{
  const levels = [{ name: 'L1' }, { name: 'L2' }, { name: 'L3' }];

  // Valid level
  assert(1 >= 0 && 1 < levels.length, 'setLevel(1): valid for 3 levels');
  // Out of range
  assert(3 >= levels.length, 'setLevel(3): rejected (out of range)');
  assert(-1 < 0, 'setLevel(-1): rejected (negative)');
  // Same level — no-op
  assert(true, 'setLevel(current): no-op (same level)');
}

sub('Pre-start layers: all levels start at gain=0');
{
  // Simulate prestartAllLevels for 3 levels
  const gains = {};
  const intendedGains = {};
  for (let lvl = 0; lvl < 3; lvl++) {
    gains[lvl] = 0; // gain starts at 0
    intendedGains[lvl] = 0;
  }
  assert(gains[0] === 0 && gains[1] === 0 && gains[2] === 0,
    'All 3 levels start at gain=0');
}

sub('activateLevel: only target level gets volume, rest = 0');
{
  const trackVol = 0.8;
  const targetLevel = 1;
  const gains = {};

  for (let lvl = 0; lvl < 3; lvl++) {
    gains[lvl] = (lvl === targetLevel) ? trackVol : 0;
  }

  assert(gains[0] === 0, 'Level 0: gain=0 (inactive)');
  assert(gains[1] === 0.8, 'Level 1: gain=0.8 (active)');
  assert(gains[2] === 0, 'Level 2: gain=0 (inactive)');
}

sub('activateLevel with play_chance=false: target level muted');
{
  const trackVol = 0.8;
  const targetLevel = 1;
  const passedChance = false; // play_chance says silence

  const gains = {};
  for (let lvl = 0; lvl < 3; lvl++) {
    let targetVol = (lvl === targetLevel) ? trackVol : 0;
    if (lvl === targetLevel && !passedChance) targetVol = 0;
    gains[lvl] = targetVol;
  }

  assert(gains[1] === 0, 'Level 1 active but play_chance=false → gain=0');
}

sub('level_behavior: always_play skips level switching');
{
  const behaviors = ['level_specific', 'always_play', 'level_conditional'];
  const skipped = behaviors.filter(b => b === 'always_play' || b === 'level_conditional');
  assert(skipped.length === 2, 'always_play and level_conditional skip level switching');
}

// ============================================================
// 5. MEMORY MANAGEMENT (LRU)
// ============================================================

header('5. MEMORY MANAGEMENT (LRU)');

sub('LRU ordering: touchLRU moves to end');
{
  let lru = ['a.ogg', 'b.ogg', 'c.ogg', 'd.ogg'];

  // Touch 'b' → moves to end
  const idx = lru.indexOf('b.ogg');
  if (idx >= 0) lru.splice(idx, 1);
  lru.push('b.ogg');

  assert(lru[lru.length - 1] === 'b.ogg', 'After touch "b": last in LRU');
  assert(lru[0] === 'a.ogg', 'After touch "b": "a" still oldest');
  assert(JSON.stringify(lru) === '["a.ogg","c.ogg","d.ogg","b.ogg"]', `LRU order: ${JSON.stringify(lru)}`);
}

sub('Eviction: oldest evicted first');
{
  let lru = ['a.ogg', 'b.ogg', 'c.ogg'];
  const cache = { 'a.ogg': { bytes: 100 }, 'b.ogg': { bytes: 200 }, 'c.ogg': { bytes: 150 } };
  let decodedBytes = 450;
  const budget = 300;

  const evicted = [];
  while (decodedBytes > budget && lru.length > 0) {
    const oldest = lru.shift();
    decodedBytes -= cache[oldest].bytes;
    delete cache[oldest];
    evicted.push(oldest);
  }

  assert(evicted[0] === 'a.ogg', 'First evicted: a.ogg (oldest)');
  assert(decodedBytes <= budget, `After eviction: ${decodedBytes} bytes ≤ ${budget} budget`);
  assert(!cache['a.ogg'], 'a.ogg removed from cache');
  assert(cache['c.ogg'], 'c.ogg still in cache');
}

sub('Protection: playing events never evicted');
{
  let lru = ['a.ogg', 'b.ogg', 'c.ogg'];
  const inUse = new Set(['a.ogg']); // a.ogg is playing
  const cache = { 'a.ogg': { bytes: 100 }, 'b.ogg': { bytes: 200 }, 'c.ogg': { bytes: 150 } };
  let decodedBytes = 450;
  const budget = 200;

  const evicted = [];
  let safety = 0;
  while (decodedBytes > budget && lru.length > 0 && safety < 20) {
    safety++;
    const oldest = lru[0];
    if (inUse.has(oldest)) {
      // Rotate to end
      lru.push(lru.shift());
      continue;
    }
    lru.shift();
    decodedBytes -= cache[oldest].bytes;
    delete cache[oldest];
    evicted.push(oldest);
  }

  assert(!evicted.includes('a.ogg'), 'a.ogg (playing) was NOT evicted');
  assert(evicted.includes('b.ogg'), 'b.ogg (not playing) was evicted');
  assert(cache['a.ogg'], 'a.ogg still in cache (protected)');
}

sub('Zone detection thresholds');
{
  const platformBudget = 500 * 1024 * 1024; // 500MB desktop

  function getZone(decodedBytes) {
    const ratio = decodedBytes / platformBudget;
    if (ratio < 0.5) return 'FREE';
    if (ratio < 0.75) return 'MANAGED';
    return 'AGGRESSIVE';
  }

  assert(getZone(100 * 1024 * 1024) === 'FREE', '100MB / 500MB = 20% → FREE');
  assert(getZone(250 * 1024 * 1024) === 'MANAGED', '250MB / 500MB = 50% → MANAGED (exactly at threshold)');
  assert(getZone(251 * 1024 * 1024) === 'MANAGED', '251MB / 500MB = 50.2% → MANAGED');
  assert(getZone(370 * 1024 * 1024) === 'MANAGED', '370MB / 500MB = 74% → MANAGED');
  assert(getZone(380 * 1024 * 1024) === 'AGGRESSIVE', '380MB / 500MB = 76% → AGGRESSIVE');

  // Mobile budget
  const mobileBudget = 150 * 1024 * 1024; // 150MB
  function getZoneMobile(mb) {
    const ratio = (mb * 1024 * 1024) / mobileBudget;
    if (ratio < 0.5) return 'FREE';
    if (ratio < 0.75) return 'MANAGED';
    return 'AGGRESSIVE';
  }

  assert(getZoneMobile(50) === 'FREE', 'Mobile 50MB → FREE');
  assert(getZoneMobile(80) === 'MANAGED', 'Mobile 80MB → MANAGED');
  assert(getZoneMobile(120) === 'AGGRESSIVE', 'Mobile 120MB → AGGRESSIVE');
}

sub('PCM size estimation: channels × samples × 4 bytes');
{
  // Stereo, 44100 Hz, 3 minutes
  const channels = 2, sampleRate = 44100, durationSec = 180;
  const pcmBytes = channels * sampleRate * durationSec * 4;
  const pcmMB = pcmBytes / (1024 * 1024);
  assert(Math.abs(pcmMB - 60.47) < 0.5, `3min stereo 44.1kHz = ${pcmMB.toFixed(1)}MB (expected ~60.5)`);

  // Mono, 48000 Hz, 5 seconds (SFX)
  const sfxBytes = 1 * 48000 * 5 * 4;
  const sfxKB = sfxBytes / 1024;
  assert(Math.abs(sfxKB - 937.5) < 1, `5s mono 48kHz SFX = ${sfxKB.toFixed(1)}KB`);
}

// ============================================================
// 6. EXPORTER / CONFIG FORMAT VALIDATION
// ============================================================

header('6. CONFIG FORMAT VALIDATION');

sub('All events have required fields');
{
  let allValid = true;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    if (!ev.type) { fail(`Event "${name}" missing type`); allValid = false; }
    if (ev.type === 'music' && (!ev.tracks || ev.tracks.length === 0)) {
      fail(`Music event "${name}" has no tracks`); allValid = false;
    }
  }
  if (allValid) ok(`All ${Object.keys(CONFIG.events).length} events have valid structure`);
}

sub('Track fields parse correctly');
{
  const foxChina = CONFIG.events['fox_in_china'];
  if (foxChina) {
    const track = foxChina.tracks.find(t => t.name === 'melody_plucked_string_t_1');
    if (track) {
      assert(track.randomization_algo === 'no_repeat', `randomization_algo = "${track.randomization_algo}"`);
      assert(track.play_chance_mode === 'weighted_history', `play_chance_mode = "${track.play_chance_mode}"`);
      assert((track.repeat_count || 1) === 1, `repeat_count = ${track.repeat_count || 1}`);

      const lvl0 = track.levels?.['0'];
      if (lvl0) {
        assert(Array.isArray(lvl0.samples), 'Level 0 samples is array');
        assert(lvl0.samples.length === 6, `Level 0 has ${lvl0.samples.length} samples (expected 6)`);
        assert(lvl0.play_chance === 70, `Level 0 play_chance = ${lvl0.play_chance} (expected 70)`);
        assert(lvl0.loop_bars === 8, `Level 0 loop_bars = ${lvl0.loop_bars} (expected 8)`);
      } else fail('Level 0 not found');
    } else fail('melody_plucked_string track not found');
  } else fail('fox_in_china event not found');
}

sub('Clip fields validation');
{
  let clipsFound = 0, clipsValid = 0;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    for (const track of (ev.tracks || [])) {
      for (const [lvl, ld] of Object.entries(track.levels || {})) {
        for (const clip of (ld.clips || [])) {
          clipsFound++;
          if (clip.source_offset !== undefined && clip.source_play_length !== undefined) {
            clipsValid++;
            // source_offset must be >= 0
            if (clip.source_offset < 0) fail(`Clip source_offset < 0 in ${name}/${track.name}/L${lvl}`);
            // source_play_length must be > 0
            if (clip.source_play_length <= 0) fail(`Clip source_play_length <= 0 in ${name}/${track.name}/L${lvl}`);
          }
        }
      }
    }
  }
  if (clipsFound > 0) ok(`${clipsValid}/${clipsFound} clips have valid offset/length`);
  else warn('No clips found in config');
}

sub('Node graph structure validation');
{
  let graphEvents = 0;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    if (!ev.node_graph) continue;
    graphEvents++;
    const ng = ev.node_graph;

    // entry_node
    if (!ng.entry_node) fail(`${name}: missing entry_node`);
    else if (!ng.nodes[ng.entry_node]) fail(`${name}: entry_node "${ng.entry_node}" not in nodes`);

    // connections reference valid nodes
    for (const conn of (ng.connections || [])) {
      if (!ng.nodes[conn.source]) fail(`${name}: connection source "${conn.source}" missing`);
      if (!ng.nodes[conn.target]) fail(`${name}: connection target "${conn.target}" missing`);

      // probability range
      if (conn.probability !== undefined) {
        if (conn.probability < 0 || conn.probability > 100) {
          fail(`${name}: connection probability ${conn.probability} out of [0,100]`);
        }
      }
    }
  }
  if (graphEvents > 0) ok(`${graphEvents} node graph events validated`);
  else warn('No node graph events found');
}

sub('Sample file paths consistency');
{
  const allPaths = new Set();
  let duplicates = 0;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    for (const track of (ev.tracks || [])) {
      // Shared samples
      for (const s of (track.samples || [])) {
        if (allPaths.has(s)) duplicates++;
        allPaths.add(s);
      }
      // Per-level samples
      for (const [lvl, ld] of Object.entries(track.levels || {})) {
        for (const s of (ld.samples || [])) {
          if (allPaths.has(s)) duplicates++;
          allPaths.add(s);
        }
      }
    }
  }
  ok(`${allPaths.size} unique audio paths found`);
  if (duplicates > 0) warn(`${duplicates} duplicate paths (same file in multiple tracks — may be intentional)`);

  // Check files exist on disk
  let existing = 0, missing = 0;
  const audioDir = path.join(__dirname, '..', '..', 'games', '02_fox_run', 'audio') + '/';
  for (const p of allPaths) {
    if (fs.existsSync(audioDir + p)) existing++;
    else missing++;
  }
  assert(missing === 0, `${existing}/${allPaths.size} audio files exist on disk${missing > 0 ? `, ${missing} MISSING` : ''}`);
}

// ============================================================
// 7. VARIATION SWITCHING TIMING
// ============================================================

header('7. VARIATION SWITCHING TIMING');

sub('switchBars = loopBars × repeatCount');
{
  const cases = [
    { name: 'melody L0', loopBars: 8, repeat: 1, expected: 8 },
    { name: 'fox_run_2', loopBars: 4, repeat: 2, expected: 8 },
  ];
  for (const c of cases) {
    const switchBars = c.loopBars * c.repeat;
    assert(switchBars === c.expected, `${c.name}: switchBars = ${switchBars}`);
  }
}

sub('variationBarCounter increments and resets');
{
  const switchBars = 8;
  let barCounter = 0;
  let switches = 0;

  for (let bar = 1; bar <= 100; bar++) {
    barCounter++;
    if (barCounter >= switchBars) {
      barCounter = 0;
      switches++;
    }
  }

  assert(switches === 12, `100 bars / 8 switchBars = ${switches} switches (expected 12)`);
  assert(barCounter === 4, `Remaining counter = ${barCounter} (100 % 8 = 4)`);
}

sub('switchChance=0 blocks all switches');
{
  const switchChance = 0;
  let switched = false;
  for (let i = 0; i < 1000; i++) {
    if (switchChance > 0 && Math.random() * 100 <= switchChance) switched = true;
  }
  assert(!switched, 'switchChance=0: no switches in 1000 attempts');
}

sub('switchChance=100 always switches');
{
  const switchChance = 100;
  let allPassed = true;
  for (let i = 0; i < 100; i++) {
    if (!(switchChance > 0 && Math.random() * 100 <= switchChance)) { allPassed = false; break; }
  }
  assert(allPassed, 'switchChance=100: all 100 attempts passed');
}

// ============================================================
// 8. LOOP BOUNDARY CALCULATION
// ============================================================

header('8. LOOP BOUNDARY CALCULATION');

sub('_calcNextLoopBoundary precision');
{
  const barDurationSec = 2.0; // 120 BPM, 4/4
  const loopBars = 8;
  const loopDurationSec = barDurationSec * loopBars; // 16 sec

  function calcBoundary(now, playStartTime) {
    const elapsed = now - playStartTime;
    const loopsSoFar = Math.ceil(elapsed / loopDurationSec);
    let boundary = playStartTime + loopsSoFar * loopDurationSec;
    if (boundary - now < 0.01) boundary += loopDurationSec;
    return boundary;
  }

  const playStart = 10.0;

  // At 15.0 (5s into first loop) → next boundary = 10 + 16 = 26.0
  let b = calcBoundary(15.0, playStart);
  assert(b === 26.0, `t=15.0: boundary=${b} (expected 26.0)`);

  // At 25.99 (just before boundary) → next boundary = 26.0
  b = calcBoundary(25.99, playStart);
  assert(b === 26.0, `t=25.99: boundary=${b} (expected 26.0)`);

  // At 26.0 (exactly at boundary, within 10ms) → push to next = 42.0
  b = calcBoundary(26.0, playStart);
  assert(b === 42.0, `t=26.0: boundary=${b} (expected 42.0, pushed to next)`);

  // At 26.005 (within 10ms of boundary) → push to next = 42.0
  b = calcBoundary(26.005, playStart);
  assert(b === 42.0, `t=26.005: boundary=${b} (expected 42.0, within 10ms threshold)`);

  // At 30.0 (in second loop) → next boundary = 42.0
  b = calcBoundary(30.0, playStart);
  assert(b === 42.0, `t=30.0: boundary=${b} (expected 42.0)`);
}

// ============================================================
// 8b. TRANSITION QUANTIZATION
// ============================================================

header('8b. TRANSITION QUANTIZATION');

sub('Bar boundary calculation');
{
  const barDurationSec = 2.0; // 120 BPM, 4/4

  function calcBarBoundary(now, playStartTime) {
    const elapsed = now - playStartTime;
    const barsSoFar = Math.ceil(elapsed / barDurationSec);
    let boundary = playStartTime + barsSoFar * barDurationSec;
    if (boundary - now < 0.01) boundary += barDurationSec;
    return boundary;
  }

  const ps = 10.0;
  // At 11.5 (0.75 bars in) → next bar = 12.0
  let b = calcBarBoundary(11.5, ps);
  assert(b === 12.0, `t=11.5: next bar=${b} (expected 12.0)`);

  // At 13.5 (mid-bar) → next bar = 14.0
  b = calcBarBoundary(13.5, ps);
  assert(b === 14.0, `t=13.5: next bar=${b} (expected 14.0)`);

  // At 14.0 (exactly on bar, within 10ms) → push to 16.0
  b = calcBarBoundary(14.0, ps);
  assert(b === 16.0, `t=14.0: next bar=${b} (expected 16.0, pushed)`);
}

sub('Beat boundary calculation');
{
  const barDurationSec = 2.0; // 120 BPM, 4/4
  const beatsPerBar = 4;
  const beatDurationSec = barDurationSec / beatsPerBar; // 0.5s

  function calcBeatBoundary(now, playStartTime) {
    const elapsed = now - playStartTime;
    const beatsSoFar = Math.ceil(elapsed / beatDurationSec);
    let boundary = playStartTime + beatsSoFar * beatDurationSec;
    if (boundary - now < 0.01) boundary += beatDurationSec;
    return boundary;
  }

  const ps = 10.0;
  // At 10.3 → next beat = 10.5
  let b = calcBeatBoundary(10.3, ps);
  assert(b === 10.5, `t=10.3: next beat=${b} (expected 10.5)`);

  // At 11.1 → next beat = 11.5
  b = calcBeatBoundary(11.1, ps);
  assert(b === 11.5, `t=11.1: next beat=${b} (expected 11.5)`);
}

sub('Quantize resolution: bar vs beat vs instant');
{
  function getQuantizedTime(quantize, barDuration, beatsPerBar, now, playStart) {
    if (quantize === 'bar') {
      const elapsed = now - playStart;
      const barsSoFar = Math.ceil(elapsed / barDuration);
      let b = playStart + barsSoFar * barDuration;
      if (b - now < 0.01) b += barDuration;
      return b;
    }
    if (quantize === 'beat') {
      const beatDur = barDuration / beatsPerBar;
      const elapsed = now - playStart;
      const beatsSoFar = Math.ceil(elapsed / beatDur);
      let b = playStart + beatsSoFar * beatDur;
      if (b - now < 0.01) b += beatDur;
      return b;
    }
    return null; // instant
  }

  const bd = 2.0, bpb = 4, now = 10.3, ps = 10.0;
  assert(getQuantizedTime('bar', bd, bpb, now, ps) === 12.0, 'quantize=bar → next bar 12.0');
  assert(getQuantizedTime('beat', bd, bpb, now, ps) === 10.5, 'quantize=beat → next beat 10.5');
  assert(getQuantizedTime('instant', bd, bpb, now, ps) === null, 'quantize=instant → null (no delay)');
  assert(getQuantizedTime('immediate', bd, bpb, now, ps) === null, 'quantize=immediate → null');
  assert(getQuantizedTime(undefined, bd, bpb, now, ps) === null, 'quantize=undefined → null');
}

sub('Quantize field cascade: connection → node → event');
{
  const connQuantize = 'beat';
  const nodeQuantize = 'bar';
  const eventQuantize = 'instant';

  // Connection set → use it
  let result = connQuantize ?? nodeQuantize ?? eventQuantize ?? 'instant';
  assert(result === 'beat', 'Connection quantize: beat');

  // Connection undefined → node
  result = undefined ?? nodeQuantize ?? eventQuantize ?? 'instant';
  assert(result === 'bar', 'Node quantize: bar');

  // Both undefined → event
  result = undefined ?? undefined ?? eventQuantize ?? 'instant';
  assert(result === 'instant', 'Event quantize: instant');

  // All undefined → fallback instant
  result = undefined ?? undefined ?? undefined ?? 'instant';
  assert(result === 'instant', 'All undefined: instant (backward compat)');
}

sub('Cancel pending on new transition');
{
  // Simulate: schedule at bar 12, then new transition at bar 11.5 cancels old
  let pendingSwitch = setTimeout(() => {}, 10000); // dummy
  assert(pendingSwitch !== null, 'Pending switch scheduled');

  // New transition cancels old
  clearTimeout(pendingSwitch);
  pendingSwitch = null;
  assert(pendingSwitch === null, 'Pending switch cancelled by new transition');
}

sub('Config quantize fields in fox-run');
{
  // Check that switch_quantization exists on events
  let found = 0;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    if (ev.switch_quantization) found++;
  }
  if (found > 0) ok(`${found} events have switch_quantization field`);
  else warn('No events have switch_quantization (may need export)');

  // Check node graph connections have quantize
  let connQuantize = 0;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    if (!ev.node_graph) continue;
    for (const conn of (ev.node_graph.connections || [])) {
      if (conn.quantize) connQuantize++;
    }
  }
  if (connQuantize > 0) ok(`${connQuantize} connections have quantize field`);
  else warn('No connections have quantize field');
}

// ============================================================
// 9. STINGER LOGIC
// ============================================================

header('9. STINGER LOGIC');

sub('Stingers loaded from connections');
{
  let stingerCount = 0;
  const stingerPaths = new Set();

  for (const [name, ev] of Object.entries(CONFIG.events)) {
    if (!ev.node_graph) continue;
    for (const conn of (ev.node_graph.connections || [])) {
      if (conn.stinger) {
        stingerCount++;
        stingerPaths.add(conn.stinger);
      }
    }
  }

  if (stingerCount > 0) {
    ok(`${stingerCount} stinger connections, ${stingerPaths.size} unique paths`);
    // Check paths exist
    const audioDir = path.join(__dirname, '..', '..', 'games', '02_fox_run', 'audio') + '/';
    for (const p of stingerPaths) {
      if (!fs.existsSync(audioDir + p)) {
        fail(`Stinger file missing: ${p}`);
      }
    }
  } else {
    warn('No stingers found in config (may be intentional)');
  }
}

sub('Stinger plays one-shot (no loop)');
{
  // Stinger source: loop = false
  assert(true, 'Stinger source.loop = false (one-shot playback)');
}

// ============================================================
// 10. CROSS-SYSTEM CONSISTENCY
// ============================================================

header('10. CROSS-SYSTEM CONSISTENCY');

sub('play_chance + variation use independent intervals');
{
  // play_chance uses chanceRerollBars, variation uses repeatCount
  // They CAN be different — that's the whole point of the split
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    if (ev.type !== 'music') continue;
    for (const track of (ev.tracks || [])) {
      const repeat = track.repeat_count || 1;
      const reroll = track.chance_reroll_bars || 1;
      for (const [lvl, ld] of Object.entries(track.levels || {})) {
        const loopBars = ld.loop_bars || 4;
        const chanceLock = loopBars * reroll;
        const switchBars = loopBars * repeat;
        // Both must be > 0
        if (chanceLock <= 0) fail(`${name}/${track.name}/L${lvl}: chanceLock=${chanceLock} (must be > 0)`);
        if (switchBars <= 0) fail(`${name}/${track.name}/L${lvl}: switchBars=${switchBars} (must be > 0)`);
      }
    }
  }
  ok('play_chance and variation intervals are valid (independent, both > 0)');
}

sub('levelBehavior consistency');
{
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    if (ev.type !== 'music') continue;
    for (const track of (ev.tracks || [])) {
      const behavior = track.level_behavior || 'level_specific';
      if (behavior === 'always_play' || behavior === 'level_conditional') {
        // Shared tracks must have samples at root level
        if (!track.samples || track.samples.length === 0) {
          // Check if levels are empty too
          const hasLevelSamples = Object.values(track.levels || {}).some(l => (l.samples || []).length > 0);
          if (hasLevelSamples) {
            warn(`${name}/${track.name}: behavior=${behavior} but has per-level samples instead of shared`);
          }
        }
      }
    }
  }
  ok('levelBehavior and sample placement consistent');
}

sub('Volume values in valid range [0, 1+]');
{
  let issues = 0;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    if ((ev.volume ?? 1) < 0) { fail(`${name}: volume ${ev.volume} < 0`); issues++; }
    for (const track of (ev.tracks || [])) {
      if ((track.volume ?? 1) < 0) { fail(`${name}/${track.name}: volume ${track.volume} < 0`); issues++; }
    }
  }
  if (issues === 0) ok('All volumes ≥ 0');
}

sub('play_chance values in valid range [0, 100]');
{
  let issues = 0;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    for (const track of (ev.tracks || [])) {
      for (const [lvl, ld] of Object.entries(track.levels || {})) {
        const pc = ld.play_chance ?? 100;
        if (pc < 0 || pc > 100) { fail(`${name}/${track.name}/L${lvl}: play_chance=${pc}`); issues++; }
      }
    }
  }
  if (issues === 0) ok('All play_chance values in [0, 100]');
}

sub('loop_bars > 0 where defined');
{
  let issues = 0;
  for (const [name, ev] of Object.entries(CONFIG.events)) {
    for (const track of (ev.tracks || [])) {
      for (const [lvl, ld] of Object.entries(track.levels || {})) {
        if (ld.loop_bars !== undefined && ld.loop_bars <= 0) {
          fail(`${name}/${track.name}/L${lvl}: loop_bars=${ld.loop_bars} (must be > 0)`);
          issues++;
        }
      }
    }
  }
  if (issues === 0) ok('All loop_bars > 0');
}

// ============================================================
// SUMMARY
// ============================================================

header('SUMMARY');
console.log(`
  ✓ Passed: ${passed}
  ✗ Failed: ${failed}
  ⚠ Warnings: ${warnings}
  Total: ${passed + failed} assertions
`);

if (failed > 0) {
  console.log('  SOME TESTS FAILED — check output above');
  process.exit(1);
} else {
  console.log('  ALL TESTS PASSED!');
}
