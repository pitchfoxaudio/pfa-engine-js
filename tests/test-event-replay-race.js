#!/usr/bin/env node
/**
 * PFA Engine — stop()→play() replay race (deferred-teardown generation guard)
 *
 * Bug: PFAEvent.stop() ramps the event gain to ~0 (20ms anti-click) and then,
 * via setTimeout(…, 25), tears the track sources down. That timer re-reads the
 * track's CURRENT sources at fire time and was generation-agnostic — so a play()
 * landing inside the 25ms window had its FRESH AudioBufferSourceNodes stopped by
 * the stale timer. Symptom: event reads isPlaying=true at full gain, yet silent.
 * (Hit live by fox-run replaying its menu music immediately after stopAll().)
 *
 * Fix mirrors FMOD/Wwise per-voice lifecycle — a new voice supersedes the prior
 * one's pending release: play()/stop() bump _stopGen; the deferred teardown only
 * runs if its captured generation is still current. play() already tears down the
 * prior sources synchronously (playMusic / prestartAllLevels call stopAll /
 * stopAllLevels first), so skipping the stale deferred teardown leaks nothing.
 *
 * Loads the REAL src/index.js (not a port) and drives PFAEvent.play()/stop()
 * against spy tracks that model "creating a source self-cleans the old one".
 *
 * Usage: node test-event-replay-race.js
 */

const fs = require('fs');
const path = require('path');

// ── Load the real PFAEvent from source ───────────────────────────────
function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFATrack };';
  return new Function('window', src)(undefined);
}
const { PFAEvent } = loadEngine();

// ── Tiny test harness (house convention) ─────────────────────────────
let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── Recording mock AudioParam (event gain) ───────────────────────────
function mkRecParam(initial = 0.0001) {
  return {
    value: initial,
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v) { this.value = v; },
    setValueCurveAtTime(arr) { this.value = arr[arr.length - 1]; },
    cancelScheduledValues() {},
    cancelAndHoldAtTime() {},
  };
}

// ── Spy track: models the real source lifecycle the teardown touches ──
// "current" is the live audio for this track. Creating a source (playMusic /
// prestartAllLevels — both stopAll/stopAllLevels FIRST in the real engine)
// self-cleans the old one and installs a fresh one. stopAll/stopAllLevels kill
// whatever is current (this is exactly what the deferred teardown calls).
function mkSpyTrack(behavior = 'level_specific') {
  const t = {
    levelBehavior: behavior,
    current: null,
    _kill() { if (t.current) t.current.stopped = true; },
    _fresh() { t._kill(); t.current = { stopped: false }; return t.current; },
    stopAll() { t._kill(); },
    stopAllLevels() { t._kill(); },
    playMusic() { return t._fresh(); },         // real playMusic() calls stopAll() first
    prestartAllLevels() { return t._fresh(); }, // real prestartAllLevels() calls stopAllLevels() first
    activateLevel() {},
  };
  return t;
}

// Build a real PFAEvent, swap in a spy track, stub the event-level collaborators
// so play()/stop() reduce to "ramp the event gain + drive the track sources".
function mkRaceEvent(behavior = 'level_specific') {
  let T = 0;
  const engine = {
    _now: () => T,
    ctx: { get currentTime() { return T; }, createGain: () => ({ gain: mkRecParam(1), connect() {}, disconnect() {} }) },
  };
  const ev = new PFAEvent('e', { type: 'music', tracks: [] }, engine);
  ev.tracks = [mkSpyTrack(behavior)];
  ev.useNodes = false;
  ev.nodeGraph = null;
  ev._eventGain = { gain: mkRecParam(0.0001), connect() {}, disconnect() {} };
  ev._ensureGain = () => {};
  ev._tweenEventGain = () => {};
  ev._startConductor = () => {};
  ev._stopConductor = () => {};
  ev._stopAllSubLevels = () => {};
  ev._emitTransitionInfo = () => {};
  return ev;
}

(async () => {
  // ═══════════════════════════════════════════════════════════════════
  header('1. Replay inside the 25ms anti-click window — level_specific');
  // ═══════════════════════════════════════════════════════════════════
  {
    const ev = mkRaceEvent('level_specific');
    const track = ev.tracks[0];

    ev.play();
    const first = track.current;
    assert(first && !first.stopped, 'play() installs a live source');

    ev.stop();                 // schedules deferred teardown (gen captured)
    ev.play();                 // replay synchronously — inside the 25ms window
    const second = track.current;
    assert(second && second !== first, 'replay installs a NEW source');
    assert(first.stopped === true, 'old source torn down synchronously by play() (no leak)');

    await wait(60);            // let the stale deferred teardown fire (or skip)
    assert(second.stopped === false, 'FIX: stale deferred teardown did NOT kill the replay source');
    assert(ev.isPlaying === true, 'event still marked playing after the window');
  }

  // ═══════════════════════════════════════════════════════════════════
  header('2. Replay inside the window — always_play (playMusic path)');
  // ═══════════════════════════════════════════════════════════════════
  {
    const ev = mkRaceEvent('always_play');
    const track = ev.tracks[0];

    ev.play();
    const first = track.current;
    ev.stop();
    ev.play();
    const second = track.current;
    assert(second !== first, 'replay installs a new source (always_play)');

    await wait(60);
    assert(second.stopped === false, 'FIX: replay source survives the stale teardown (always_play)');
  }

  // ═══════════════════════════════════════════════════════════════════
  header('3. Plain stop (no replay) still tears down — anti-click intact');
  // ═══════════════════════════════════════════════════════════════════
  {
    const ev = mkRaceEvent('level_specific');
    const track = ev.tracks[0];
    ev.play();
    const src = track.current;
    ev.stop();
    assert(src.stopped === false, 'source still alive immediately after stop() (20ms anti-click in flight)');
    await wait(60);
    assert(src.stopped === true, 'source torn down after the deferred window when no replay supersedes it');
  }

  // ═══════════════════════════════════════════════════════════════════
  header('4. Double stop (no replay) — last stop owns the teardown');
  // ═══════════════════════════════════════════════════════════════════
  {
    const ev = mkRaceEvent('level_specific');
    const track = ev.tracks[0];
    ev.play();
    const src = track.current;
    ev.stop();                 // gen N  → teardown N (will be superseded)
    ev.stop();                 // gen N+1 → teardown N+1 (authoritative)
    await wait(60);
    assert(src.stopped === true, 'sources torn down exactly once by the last stop (guard does not block normal teardown)');
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log(`  RESULT: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(70));
  process.exit(failed === 0 ? 0 : 1);
})();
