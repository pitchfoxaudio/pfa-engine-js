#!/usr/bin/env node
/**
 * PFA Engine — config.json INTAKE audit tests (pre-release checklist #3,
 * 2026-07-07: how the engine READS events/groups/tracks/clips).
 *
 * Two families:
 *
 * 1. AUTHORED-ZERO preservation (red-proven). The editor exports volume 0.0
 *    (fader at bottom), fade_duration 0.0 (instant level switch) — real UI
 *    states (main_window volume_slider/crossfade_slider both setRange(0, …)).
 *    Godot reads them via Dictionary.get(key, default) which preserves an
 *    explicit 0; the JS `data.x || default` idiom silently replaced 0 with the
 *    default: a muted event/group/sub-level played at FULL volume on web while
 *    Godot correctly played silence. PFATrack already used `??` — events,
 *    groups and sub-levels didn't.
 *
 * 2. LEGACY-CONFIG tolerance pins (green). Pre-0b40049/2ec2ef7 projects could
 *    export duplicate group names, dangling group→event refs, events in two
 *    groups. Pin the intake semantics BOTH engines share so they can't drift:
 *    duplicate group name → last wins; dangling refs → ignored, no throw;
 *    event in 2 groups → FIRST group's volume (both engines break at first
 *    match); empty/missing sections → defaults, no throw.
 *
 * Drives the REAL PFA.loadPack() (fetch stubbed, ctx faked — parse path only,
 * no Web Audio), same eval-the-source pattern as test-variation-level-pools.js.
 *
 * Run: node tests/test-config-intake.js   (exit 0 green / 1 red)
 */

const fs = require('fs');
const path = require('path');

// ── Load the real classes from source ────────────────────────────────
function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack, PFAGroup };';
  return new Function('window', src)(undefined);
}
const { PFA, PFATrack } = loadEngine();

// ── Tiny test harness (house convention) ─────────────────────────────
let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }
function assertEq(a, b, m) { assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

function mkEngine() {
  return { ctx: { currentTime: 0 }, _now: () => 0 };
}

// Exporter-shaped config (schema 1.1): zeros where the UI can author them +
// the legacy shapes (duplicate group, dangling ref, double membership).
const CONFIG = {
  version: '1.1',
  project: 'intake-audit',
  audio_format: 'ogg',
  bpm: 120,
  sample_rate: 44100,
  groups: [
    { name: 'Zero', volume: 0.0, events: ['music_zero', 'ghost_event'] },
    { name: 'Dup', volume: 0.25, events: ['music_plain'] },
    { name: 'Dup', volume: 0.5, events: [] },
    { name: 'First', volume: 0.8, events: ['music_two_groups'] },
    { name: 'Second', volume: 0.3, events: ['music_two_groups'] },
  ],
  events: {
    music_zero: {
      type: 'music', volume: 0.0,
      levels: [{ name: 'L0' }],
      bpm: 100, time_signature: [4, 4], fade_duration: 0.0,
      fade_curve: 'linear', switch_quantization: 'bar',
      start_fade: { duration: 0.0, curve: 'equal_power' },
      release_fade: { duration: 0.0, curve: 'equal_power' },
      tracks: [{
        name: 'T', volume: 0.0, level_behavior: 'level_specific',
        levels: { '0': {
          samples: [], loop_bars: 8, switch_chance: 0, play_chance: 0,
          clips: [{ source_offset: 0.0, source_play_length: 4.0, loop_mode: 'loop_source',
                    fade_in: 0.0, fade_out: 0.0, volume: 0.0, weight: 0.0 }],
        } },
        repeat_count: 1, chance_reroll_bars: 1,
        play_chance_mode: 'true_random', randomization_algo: 'random',
        chance_fade_mode: 'instant', chance_fade_duration: 0.0,
      }],
      sub_levels: { '0': [
        { name: 'ghosts', volume: 0.0,
          tracks: [{ name: 'ST', volume: 0.25, level_behavior: 'level_specific', levels: {} }] },
      ] },
    },
    music_plain: {
      type: 'music', volume: 1.0, levels: [{ name: 'L0' }], tracks: [],
      bpm: 120, time_signature: [4, 4], fade_duration: 2.0,
      fade_curve: 'equal_power', switch_quantization: 'bar',
      start_fade: { duration: 0.0, curve: 'equal_power' },
      release_fade: { duration: 0.0, curve: 'equal_power' },
    },
    music_two_groups: {
      type: 'music', volume: 1.0, levels: [{ name: 'L0' }], tracks: [],
      bpm: 120, time_signature: [4, 4], fade_duration: 2.0,
      fade_curve: 'equal_power', switch_quantization: 'bar',
      start_fade: { duration: 0.0, curve: 'equal_power' },
      release_fade: { duration: 0.0, curve: 'equal_power' },
    },
    // Minimal SFX event — optional fields absent (missing-field tolerance).
    sfx_min: { type: 'sfx', volume: 1.0, levels: [{ name: 'L0' }], tracks: [] },
  },
};

async function loadPFA(config) {
  const pfa = new PFA();
  pfa.ctx = { currentTime: 0 };  // pre-set: loadPack skips init() (no Web Audio in Node)
  globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(config)) });
  const loadedOk = await pfa.loadPack('mem/config.json');
  return { pfa, loadedOk };
}

(async () => {
  header('Config intake — authored zeros survive the parse (JS ?? Godot .get parity)');

  const { pfa, loadedOk } = await loadPFA(CONFIG);
  assert(loadedOk === true, 'loadPack succeeds on exporter-shaped config');

  sub('event fields');
  assertEq(pfa.events.music_zero.volume, 0.0, 'event volume 0.0 preserved (fader at bottom = silence, not full)');
  assertEq(pfa.events.music_zero.fadeDuration, 0.0, 'event fade_duration 0.0 preserved (instant level switch, not 2s)');

  sub('group fields');
  assertEq(pfa.groups.Zero.volume, 0.0, 'group volume 0.0 preserved');
  assertEq(pfa.events.music_zero.groupGain, 0.0, 'group volume 0.0 propagates to member event groupGain');

  sub('sub-level fields');
  const subLvl = pfa.events.music_zero._subLevelTracks['0_ghosts'];
  assert(!!subLvl, 'sub-level parsed under key "0_ghosts"');
  if (subLvl) assertEq(subLvl.volume, 0.0, 'sub-level volume 0.0 preserved');

  sub('track/clip fields (already ??-correct — pinned so they stay)');
  const track = pfa.events.music_zero.tracks[0];
  assertEq(track.volume, 0.0, 'track volume 0.0 preserved');
  assertEq(track.levelSamples[0].loopBars, 8, 'per-level loop_bars read');
  assertEq(track.levelSamples[0].switchChance, 0, 'switch_chance 0 preserved (never switch)');
  assertEq(track.levelSamples[0].playChance, 0, 'play_chance 0 preserved (never play)');
  assertEq(track.chanceFadeDuration, 0.0, 'chance_fade_duration 0.0 preserved');
  const clip = track.levelClips[0][0];
  assertEq(clip.volume, 0.0, 'clip volume 0.0 preserved');
  assertEq(clip.weight, 0.0, 'clip weight 0.0 preserved (variation never picked)');

  header('Legacy-config tolerance (pre-0b40049/2ec2ef7 exports) — parity pins');

  sub('duplicate group names → last wins (Godot: _groups[name] overwrite, same)');
  assertEq(Object.keys(pfa.groups).length, 4, 'duplicate "Dup" collapsed: 5 config groups → 4');
  assertEq(pfa.groups.Dup.volume, 0.5, 'last duplicate wins (first "Dup" settings dropped)');
  assertEq(pfa.events.music_plain.groupGain, 1.0, 'member of the DROPPED duplicate falls back to no-group gain');

  sub('event in two groups → FIRST group wins (both engines break at first match)');
  assertEq(pfa.events.music_two_groups.groupGain, 0.8, 'first matching group volume applied');

  sub('dangling group→event refs are ignored, never throw');
  let threw = false;
  try {
    pfa.setGroupVolume('Zero', 0.7);            // 'ghost_event' member does not exist
    await pfa.preloadGroup('Zero');             // preload of missing event = warn + return
    await pfa.preloadGroup('no_such_group');    // missing group = warn + return
    pfa.setGroupVolume('no_such_group', 0.5);
  } catch (e) { threw = true; console.log('      threw: ' + e.message); }
  assert(!threw, 'group APIs survive dangling refs and unknown group names');
  assertEq(pfa.events.music_zero.groupGain, 0.7, 'live group volume still applied to existing members');

  sub('missing optional fields → engine defaults (minimal SFX event)');
  const sfx = pfa.events.sfx_min;
  assertEq(sfx.maxInstances, 8, 'max_instances default 8');
  assertEq(sfx.cooldownMs, 0, 'cooldown_ms default 0');
  assertEq(sfx.volume, 1.0, 'volume default 1.0 when key absent');
  assert(sfx.spatial === null && sfx.reverb === null && sfx.intensity === null && sfx.loop === null,
    'absent opt-in blocks stay null');

  sub('missing groups/events sections entirely → empty, no throw');
  const { pfa: pfa2, loadedOk: ok2 } = await loadPFA({ version: '1.1', events: {} });
  assert(ok2 === true, 'config without groups key loads');
  assertEq(Object.keys(pfa2.groups).length, 0, 'no groups → {}');
  assertEq(Object.keys(pfa2.events).length, 0, 'no events → {}');

  header('Shared-pool (always_play) per-level metadata — engine side of the contract');

  sub('levels{} metadata WITHOUT samples feeds the shared variation cadence');
  // The conductor reads levelSamples[curLevel].loopBars/switchChance for shared
  // pools (index.js conductor tick + _calcNextLoopBoundary). The exporter is
  // being taught to emit this metadata for always_play tracks — pin that the
  // engine parses it and that metadata-only levels carry no buffers.
  const shared = new PFATrack({
    name: 'amb', volume: 1.0, level_behavior: 'always_play',
    samples: ['a.ogg', 'b.ogg'],
    clips: [{ source_offset: 0, source_play_length: 8.0, loop_mode: 'loop_source',
              fade_in: 0, fade_out: 0, volume: 1.0, weight: 1.0 }],
    levels: { '0': { loop_bars: 8, switch_chance: 40 }, '1': { loop_bars: 8, switch_chance: 100 } },
  }, mkEngine());
  assertEq(shared.sharedSampleFiles.length, 2, 'shared samples stay at track level');
  assertEq(shared.levelSamples[0].loopBars, 8, 'per-level loop_bars parsed for shared track');
  assertEq(shared.levelSamples[0].switchChance, 40, 'per-level switch_chance parsed for shared track');
  assertEq(shared.levelSamples[1].switchChance, 100, 'second level independent');
  assertEq(shared.levelSamples[0].files.length, 0, 'metadata-only level carries no files');

  header('master_volume intake — the authored master reaches the engine');

  sub('config.master_volume applied at load (exporter writes the key when ≠ 1.0)');
  const { pfa: pfaM, loadedOk: okM } = await loadPFA({ ...CONFIG, master_volume: 0.62 });
  assert(okM === true, 'config with master_volume loads');
  assertEq(pfaM._masterVolume, 0.62, 'loadPack applies config.master_volume');

  sub('absent key ⇒ unity (config is the source of truth — a reload resets a live-tweaked master)');
  assertEq(pfa._masterVolume, 1.0, 'no master_volume key → 1.0 (Godot pfa.gd parity)');

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log(`  RESULT: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(70));
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('UNCAUGHT: ', e); process.exit(1); });
