#!/usr/bin/env node
/**
 * PFA Engine — break-shot survival on the REAL billiards pack (JS half of the
 * sess122 parity scenario; Godot side: godot/test_break_shot_survival.gd).
 *
 * FV-08 prep measured (web, 06.08): a break shot created 44 ball_hit voices and
 * the age-based steal killed 16 — among them the intensity-1.000 main strike,
 * alive 0.032 s of 0.536 s. The break turned into a rustle. This replays that
 * shape against the shipped JS engine + the REAL exported pack
 * (games/04_billiards/audio/config.json, max_instances 8, −26..0 dB intensity):
 *
 *   t=0        the MAIN strike, intensity 1.0 (cue ball into the rack)
 *   t=15..465  a cascade of 30 weak follow-up collisions, intensity 0.08–0.55
 *
 * The cascade triples (intensity, dx, dz) are the EXACT seeded sequence of the
 * Godot test (RandomNumberGenerator seed 0xB111A4D5) — both engines face the
 * identical break. Per-voice volume/rate randomization stays live (authored in
 * the pack; the Godot run had it live too), so spawned/stolen/rejected counts
 * carry ±a-few jitter across runs — the LOCKED verdicts don't:
 *   • the main strike survives the whole cascade — never released;
 *   • every stolen voice is quieter than the main strike;
 *   • the cascade produces SOME steals or rejections (real cap pressure).
 *
 * Godot measurement for comparison (09.08 post-steal-seam-fix 4f4da76, 3 runs —
 * unseeded voice rand): 31 triggers → 17-22 spawned, 8-12 stolen (loudest
 * 0.41-0.45), 9-14 rejected, main SURVIVED every run (07.08 pre-fix family was
 * 21-22 / 11-12 / 9-10 — same distribution: the seam fix changes the victim's
 * FADE length, not the gate's decisions). JS at the matched cadence
 * (STEP_MS=20.7, Godot's measured step): 19-21 / 9-10 / 10-12; JS default
 * 15 ms step post-fix (09.08, 3 runs): 17-19 / 8-10 / 12-14 — the
 * distributions overlap; the ~1 residual reject is the pack's DELIBERATE
 * per-platform attenuation split (godot{} override min 1.05/rolloff 1.0 vs
 * web 0.6/0.1 — each engine ranks with the curve it plays).
 *
 * Natural voice death is modeled honestly: mock sources end (dur ÷ playbackRate)
 * after start — the pack's clip windows (0.415–0.708 s) free slots late in the
 * cascade exactly like real AudioBufferSourceNodes do.
 *
 * Skips (0 asserts) when the pack is missing — test-bank convention.
 * Usage: node test-break-shot-survival.js
 */

const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent, PFAGroup };';
  return new Function('window', src)(undefined);
}
const { PFA, PFAEvent } = loadEngine();

let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── Mock Web Audio with HONEST source lifetimes ──────────────────────
function mkParam(v = 1) {
  return {
    value: v,
    setValueAtTime(val) { this.value = val; },
    linearRampToValueAtTime(val) { this.value = val; },
    exponentialRampToValueAtTime(val) { this.value = val; },
    setTargetAtTime(val) { this.value = val; },
    cancelScheduledValues() {},
  };
}
function mkGain() {
  return { gain: mkParam(1), context: { currentTime: 0 }, connect() {}, disconnect() {} };
}
/** A source that ENDS like a real AudioBufferSourceNode: a windowed start
 *  (offset, dur) fires onended after dur ÷ playbackRate of wall-clock. */
function mkSource() {
  return {
    buffer: null, loop: false, loopStart: 0, loopEnd: 0,
    playbackRate: { value: 1 }, detune: { value: 0 },
    started: false, stopped: false, _endTimer: null,
    connect() {},
    start(when, offset, dur) {
      this.started = true;
      const rate = (this.playbackRate && this.playbackRate.value) || 1;
      const len = (dur > 0) ? dur : (this.buffer && this.buffer.duration) || 0;
      if (len > 0) {
        this._endTimer = setTimeout(() => {
          this.stopped = true;
          if (this.onended) this.onended();
        }, (len / rate) * 1000);
      }
    },
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      if (this._endTimer) clearTimeout(this._endTimer);
      if (this.onended) this.onended();
    },
    onended: null,
  };
}

function mkEngine() {
  const eng = {
    _now: () => performance.now() / 1000,
    _worldScale: 1,
    _listenerPos: { x: 0, y: 0, z: 0 },
    _listenerMode: '2D',
    _spatialVoices: [], _emitters: [], _nextSpatialId: 1,
    events: {},
    _getEvent(n) { return this.events[n] || null; },
    ctx: {
      get currentTime() { return performance.now() / 1000; },
      createGain: mkGain,
      createBufferSource: mkSource,
      createStereoPanner: () => ({ pan: mkParam(0), connect() {}, disconnect() {} }),
      createPanner: () => ({
        panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0,
        rolloffFactor: 0, positionX: { value: 0 }, positionY: { value: 0 },
        positionZ: { value: 0 }, connect() {}, disconnect() {},
      }),
      createBiquadFilter: () => ({
        type: '', frequency: mkParam(0), gain: mkParam(0), connect() {}, disconnect() {},
      }),
    },
  };
  for (const k of Object.getOwnPropertyNames(PFA.prototype)) {
    if (k !== 'constructor' && typeof PFA.prototype[k] === 'function' && !eng[k]) {
      eng[k] = PFA.prototype[k];
    }
  }
  return eng;
}

// The Godot test's cascade, seed 0xB111A4D5 — extracted 1:1 (intensity, dx, dz).
const CASCADE = [
  [0.316630572080612, -0.146525025367737, 0.0560831427574158],
  [0.415411293506622, 0.156295537948608, -0.22769333422184],
  [0.427509486675262, 0.187656402587891, -0.115262806415558],
  [0.321923553943634, -0.204525768756866, 0.0932348072528839],
  [0.226939767599106, -0.112312823534012, -0.240270540118217],
  [0.140242218971252, 0.0460951328277588, 0.105607897043228],
  [0.375670850276947, 0.147205293178558, -0.103721097111702],
  [0.20008111000061, 0.246957063674927, -0.199485525488853],
  [0.50301593542099, 0.290931522846222, -0.10351075232029],
  [0.407311856746674, 0.0445030331611633, 0.216890543699265],
  [0.311550498008728, -0.0702697187662125, 0.00653818249702454],
  [0.503235042095184, 0.0151561498641968, -0.0845610797405243],
  [0.251372158527374, -0.274913102388382, 0.139403849840164],
  [0.252123236656189, 0.164812624454498, 0.097140908241272],
  [0.264856457710266, -0.0429604649543762, -0.0961177945137024],
  [0.36566174030304, -0.144122317433357, 0.00682505965232849],
  [0.475874185562134, -0.0468665063381195, -0.0430476665496826],
  [0.506085634231567, 0.186722129583359, 0.237498790025711],
  [0.381686508655548, -0.0563055723905563, 0.0159539580345154],
  [0.175827205181122, -0.180233776569366, -0.019962266087532],
  [0.134707733988762, -0.0201069116592407, 0.221498131752014],
  [0.178800314664841, -0.113856792449951, -0.228811696171761],
  [0.166946202516556, -0.082359254360199, -0.136731296777725],
  [0.228834569454193, -0.209877252578735, 0.207453012466431],
  [0.448394417762756, 0.255370676517487, 0.100044965744019],
  [0.229172170162201, 0.18922746181488, 0.155580461025238],
  [0.549143314361572, 0.0676942765712738, -0.229884028434753],
  [0.38824725151062, -0.126386925578117, -0.225989133119583],
  [0.111007861793041, 0.132847785949707, 0.12016373872757],
  [0.379568815231323, 0.192629724740982, -0.113101616501808],
];

async function main() {
  header('Break-shot survival — REAL billiards pack, audibility stealing (JS)');

  const cfgPath = path.join(__dirname, '..', '..', 'games', '04_billiards', 'audio', 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.log(`  (billiards pack missing at ${cfgPath} — skipping)`);
    console.log(`\n  PASSED: 0   FAILED: 0`);
    process.exit(0);
  }
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  const eng = mkEngine();
  // loadPack's parse loop, minus fetch (node) — real PFAEvent over the real config.
  const evData = config.events['ball_hit'];
  const ev = new PFAEvent('ball_hit', evData, eng);
  for (const t of ev.tracks) t._buffers[0] = t.levelSamples[0].files.map(() => ({ duration: 0.8 }));
  ev.buffersLoaded = true;
  ev.loadBuffers = async () => {};
  ev._ensureGain = () => {};
  ev._eventGain = mkGain();
  eng.events['ball_hit'] = ev;
  ok(`billiards pack loaded (max_instances ${ev.maxInstances} on ball_hit)`);

  // Listener above the table center — the pack's attenuation is deliberately
  // symbolic (min_distance ≈ table size), so intensity dominates the score.
  eng._listenerPos = { x: 1.12, y: 1.2, z: 0.56 };
  eng._listenerMode = '3D';

  // ── The break ──────────────────────────────────────────────────────
  const rack = { x: 1.6, y: 0.0, z: 0.56 };
  const main = await eng.triggerSpatial('ball_hit', rack.x, rack.y, rack.z, { intensity: 1.0 });
  assert(main !== null, 'main strike (intensity 1.0) spawned');

  const tracked = [];   // { voice, intensity, stolen }
  let rejected = 0;
  let spawned = 1;
  if (main) tracked.push({ voice: main, intensity: 1.0, stolen: false });

  // 15 ms = the scenario's NOMINAL cadence (Godot create_timer(0.015)). The
  // spawn/steal/reject counts are sensitive to the real wall span: clip windows
  // (0.415–0.708 s) start freeing slots naturally right at the cascade's edge,
  // and each harness's timer granularity lands elsewhere (measured 07.08:
  // node ≈ 16 ms/step = 481 ms, Godot headless ≈ 20.7 ms/step = 620 ms — hence
  // Godot's run spawns a few more / rejects a few fewer). STEP_MS overrides the
  // cadence for instrumented comparisons; the verdicts hold at any cadence.
  const STEP_MS = Number(process.env.STEP_MS || 15);

  let mainStolenMidCascade = false;
  for (const [v, dx, dz] of CASCADE) {
    await wait(STEP_MS);
    const p = await eng.triggerSpatial('ball_hit',
      rack.x + dx, rack.y, rack.z + dz, { intensity: v });
    if (p === null) {
      rejected += 1;
    } else {
      spawned += 1;
      tracked.push({ voice: p, intensity: v, stolen: false });
    }
    // Sweep: a released voice carries _stopping (steal path); a natural end
    // clears _playing WITHOUT _stopping — only steals count.
    for (const rec of tracked) {
      if (!rec.stolen && rec.voice._stopping) {
        rec.stolen = true;
        if (rec.intensity >= 0.999) mainStolenMidCascade = true;
      }
    }
  }

  // ── Verdicts ───────────────────────────────────────────────────────
  assert(!mainStolenMidCascade,
    'MAIN STRIKE SURVIVED the cascade (sess121: it lived 0.032 s of 0.536 s)');
  let stolen = 0;
  let loudestStolen = 0;
  for (const rec of tracked) {
    if (rec.stolen) {
      stolen += 1;
      loudestStolen = Math.max(loudestStolen, rec.intensity);
    }
  }
  assert(loudestStolen < 0.999,
    `every stolen voice was a weak follow-up (loudest stolen: ${loudestStolen.toFixed(2)})`);
  assert(stolen + rejected > 0,
    `the cap was under real pressure (steals ${stolen} + rejections ${rejected} > 0)`);

  // Measurement-cut numbers (FV-08) — real engine, real pack:
  console.log('\n  ── measurement ──');
  console.log(`  triggers: 31   spawned: ${spawned}   stolen: ${stolen}   rejected: ${rejected}`);
  console.log(`  main strike (intensity 1.000): ${mainStolenMidCascade ? 'STOLEN' : 'SURVIVED'}`);
  console.log(`  godot reference (09.08 post-fix, 3 runs): spawned 17-22   stolen 8-12   rejected 9-14   SURVIVED`);

  console.log('\n' + '═'.repeat(70));
  console.log(`  PASSED: ${passed}   FAILED: ${failed}`);
  console.log('═'.repeat(70));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
