#!/usr/bin/env node
/**
 * PFA Engine — a live-ducked event STAYS ducked across every _eventGain re-apply (web).
 *
 * Live solo/mute in the Event Mixer rides duck(evt, 0, 0.1) / unduck. Godot folds the
 * duck target into the event amp (pfa_event.gd _effective_event_amp / combined_sfx_db),
 * so voices honor a live mute. The JS engine only honored the duck in setGroupVolume;
 * FIVE other writers slammed _eventGain back to volume×groupGain ignoring _isDucked,
 * so the event un-muted itself — the "web solo/mute muted some events but not others"
 * regression (SFX/spatial that keep re-triggering popped back to full while sustained
 * music stayed ducked).
 *
 * Duck-blind writers pinned here (src/index.js — all now route _eventGainTarget()):
 *   trigger()      — SFX one-shot re-fire            (§1, §4, §5)
 *   _updateGain()  — setVolume / setEventVolume      (§2)
 *   fadeIn()       — event fade-in                   (§3)
 *   play() entry   — fresh music start ramp          (§6)
 *   triggerSpatial — spatial one-shot                (§7)
 * Plus duck() saves _preDuckVolume only on the FIRST duck (§8, Godot parity:
 * `if _duck_saved_volume < 0`), and green pins for the release paths (§9).
 *
 * Sentinel pattern: after arming the duck we perturb the node gain to 0.99 and clear
 * the scheduling log, so a writer that becomes a NO-OP (skips its write when ducked)
 * fails the assertion too — the writer must ACTIVELY land on the ducked target.
 *
 * Loads the REAL src/index.js (not a port).  Run: cd js && node tests/test-live-duck-persist.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFAEvent };';
  return new Function('window', src)(undefined);
}
const { PFA, PFAEvent } = loadEngine();

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function ok(m){passed++;console.log('    ✓ '+m);}
function fail(m){failed++;console.log('    ✗ FAIL: '+m);}
function assert(c,m){if(c)ok(m);else fail(m);}
function near(a,b,eps=1e-3){return Math.abs(a-b)<eps;}

// Fake AudioParam mirroring the last scheduled target into .value (pattern from
// test-group-volume-live.js) so we can read the target the engine last committed.
function recParam(v=1){
  return { value:v, _e:[],
    setValueAtTime(val){this._e.push({val,kind:'set'});this.value=val;},
    linearRampToValueAtTime(val){this._e.push({val,kind:'lin'});this.value=val;},
    setValueCurveAtTime(arr){const val=arr[arr.length-1];this._e.push({val,kind:'curve'});this.value=val;},
    cancelScheduledValues(){},
  };
}
function lastTarget(p){ return p._e.length ? p._e[p._e.length-1].val : p.value; }

function mkPfa(){
  const pfa = Object.create(PFA.prototype);
  pfa.ctx = { get currentTime(){return 0;},
    createGain:()=>({gain:recParam(1),connect(){},disconnect(){}}) };
  pfa.events = {}; pfa.groups = {};
  pfa.masterGain = { gain: recParam(1), connect(){}, disconnect(){} };
  pfa._masterVolume = 1.0;
  return pfa;
}
// A triggerable event with a mocked _eventGain and no tracks (per-track loops are
// harmless no-ops — we only observe the event-gain write).
function mkEvent(pfa, name, type, vol=1.0, groupGain=1.0){
  const ev = new PFAEvent(name, {type, volume:vol}, pfa);
  ev.groupGain = groupGain;
  ev.buffersLoaded = true;                 // skip async loadBuffers
  ev._eventGain = { gain: recParam(vol*groupGain), connect(){}, disconnect(){} };
  pfa.events[name] = ev;
  return ev;
}
const mkSfx = (pfa, name, vol=1.0, gg=1.0) => mkEvent(pfa, name, 'sfx', vol, gg);
// Perturb the node so a no-op writer cannot pass: gain ≠ full AND ≠ duck target,
// scheduling log cleared — the writer under test must actively land the target.
function sentinel(ev){ ev._eventGain.gain.value = 0.99; ev._eventGain.gain._e.length = 0; }

async function main(){

// ── 1. A ducked SFX stays silent when it is re-triggered ─────────────
header('1. duck(0) survives pfa.trigger() — SFX one-shot re-fire');
{
  const pfa = mkPfa();
  const sfx = mkSfx(pfa, 'coin', 1.0);
  pfa.duck('coin', 0.0, 0.1);
  assert(sfx._isDucked === true && sfx._duckLevel === 0.0, 'duck armed (_isDucked / _duckLevel=0)');
  assert(lastTarget(sfx._eventGain.gain) <= 0.001, 'gain rode down to ~0 on duck');
  sentinel(sfx);
  await pfa.trigger('coin');
  assert(lastTarget(sfx._eventGain.gain) <= 0.001,
    'triggering a ducked SFX actively lands the gain at ~0 (not full, not a no-op)'); // RED pre-fix
}

// ── 2. A ducked event stays silent across a live volume re-apply ─────
header('2. duck(0) survives setEventVolume / setVolume [_updateGain]');
{
  const pfa = mkPfa();
  const sfx = mkSfx(pfa, 'coin', 1.0);
  pfa.duck('coin', 0.0, 0.1);
  sentinel(sfx);
  pfa.setEventVolume('coin', 0.7);
  assert(lastTarget(sfx._eventGain.gain) <= 0.001,
    'setEventVolume on a ducked event actively lands the gain at ~0'); // RED pre-fix
  // Note: unduck() restores the PRE-DUCK snapshot (_preDuckVolume, Godot parity);
  // the 0.7 authored here applies on the next re-fire/_updateGain AFTER unduck.
  assert(near(sfx.volume, 0.7), 'authored volume is stored (applies on next re-apply post-unduck)');
}

// ── 3. A ducked event stays silent across fadeIn() ───────────────────
header('3. duck(0) survives fadeIn()');
{
  const pfa = mkPfa();
  const sfx = mkSfx(pfa, 'amb', 1.0);
  pfa.duck('amb', 0.0, 0.05);
  sentinel(sfx);
  sfx.fadeIn(0.5, 'equal_power');
  assert(lastTarget(sfx._eventGain.gain) <= 0.001,
    'fadeIn on a ducked event ramps to ~0, not to full volume×groupGain'); // RED pre-fix
}

// ── 4. Duck honors a PARTIAL level, not just full mute ───────────────
header('4. partial duck level is honored on re-trigger (duck 0.3)');
{
  const pfa = mkPfa();
  const sfx = mkSfx(pfa, 'coin', 1.0);
  pfa.duck('coin', 0.3, 0.1);
  sentinel(sfx);
  await pfa.trigger('coin');
  assert(near(lastTarget(sfx._eventGain.gain), 0.3, 1e-2),
    're-triggered ducked SFX lands at duckLevel×groupGain = 0.3 (not full, not 0)'); // RED pre-fix
}

// ── 5. groupGain is folded into the ducked target ────────────────────
header('5. ducked target = duckLevel × groupGain (group fold)');
{
  const pfa = mkPfa();
  const sfx = mkSfx(pfa, 'coin', 1.0, 0.5);   // groupGain 0.5
  pfa.duck('coin', 0.3, 0.1);
  sentinel(sfx);
  await pfa.trigger('coin');
  assert(near(lastTarget(sfx._eventGain.gain), 0.15, 1e-2),
    're-trigger lands at 0.3 × 0.5 = 0.15'); // RED pre-fix
}

// ── 6. Fresh music start while ducked settles at the duck level ──────
header('6. duck(0.3) survives play() — fresh-start entry ramp');
{
  const pfa = mkPfa();
  const mus = mkEvent(pfa, 'theme', 'music', 1.0);
  pfa.duck('theme', 0.3, 0.1);
  sentinel(mus);
  try { const r = pfa.play('theme'); if (r && r.catch) r.catch(()=>{}); } catch(e) {}
  assert(near(lastTarget(mus._eventGain.gain), 0.3, 1e-2),
    'entry ramp of a ducked music event settles at 0.3, not full'); // RED pre-fix
}

// ── 7. Spatial one-shot while ducked stays at the duck level ─────────
header('7. duck(0.3) survives triggerSpatial() — spatial one-shot');
{
  const pfa = mkPfa();
  const sfx = mkSfx(pfa, 'steps', 1.0);
  pfa.duck('steps', 0.3, 0.1);
  sentinel(sfx);
  // No await: the ducked gain write is in the synchronous prefix (buffersLoaded=true);
  // the voice machinery beyond it may reject on the minimal mock — irrelevant here.
  try { const r = pfa.triggerSpatial('steps', 1, 0, {}); if (r && r.catch) r.catch(()=>{}); } catch(e) {}
  assert(near(lastTarget(sfx._eventGain.gain), 0.3, 1e-2),
    'spatial one-shot on a ducked event lands at 0.3, not full'); // RED pre-fix
}

// ── 8. Stacked ducks restore the ORIGINAL volume (first-save parity) ──
header('8. re-duck without unduck keeps the FIRST _preDuckVolume (Godot parity)');
{
  const pfa = mkPfa();
  const sfx = mkSfx(pfa, 'coin', 1.0);
  pfa.duck('coin', 0.0, 0.1);          // saves _preDuckVolume = 1.0
  pfa.setEventVolume('coin', 0.9);     // authored volume changes mid-duck (node stays ~0)
  pfa.duck('coin', 0.3, 0.1);          // re-duck must NOT re-save (old code saved 0.9)
  pfa.unduck('coin', 0.1);
  assert(near(lastTarget(sfx._eventGain.gain), 1.0, 1e-2),
    'unduck after stacked ducks restores the ORIGINAL 1.0 (not the mid-duck 0.9)'); // RED pre-fix
}

// ── 9. GREEN PINS — must hold before AND after the fix ───────────────
header('9. GREEN pins: not-ducked & release paths unchanged');
{
  // 9a: un-ducked trigger still goes to FULL volume×groupGain
  const pfa = mkPfa();
  const sfx = mkSfx(pfa, 'coin', 0.8, 0.5);   // full target = 0.4
  await pfa.trigger('coin');
  assert(near(lastTarget(sfx._eventGain.gain), 0.4, 1e-2),
    '9a un-ducked trigger → full volume×groupGain (0.8×0.5=0.4)');

  // 9b: authored volume 0 stays exactly 0 when not ducked (preserve authored zero)
  const pfa2 = mkPfa();
  const zero = mkSfx(pfa2, 'silent', 0.0, 1.0);
  await pfa2.trigger('silent');
  assert(lastTarget(zero._eventGain.gain) === 0,
    '9b authored volume 0 → trigger sets exactly 0 (no anti-click floor when un-ducked)');

  // 9c: unduck restores exactly the pre-duck snapshot (Godot parity)
  const pfa3 = mkPfa();
  const sfx3 = mkSfx(pfa3, 'coin', 1.0);
  pfa3.duck('coin', 0.0, 0.1);
  pfa3.unduck('coin', 0.1);
  assert(near(lastTarget(sfx3._eventGain.gain), 1.0, 1e-2),
    '9c unduck restores the pre-duck 1.0 (mute is releasable)');

  // 9d: setGroupVolume on a ducked member does NOT lift the duck (already-correct path)
  const pfa4 = mkPfa();
  const sfx4 = mkSfx(pfa4, 'coin', 1.0, 1.0);
  pfa4.groups = { Main: { name:'Main', volume:1.0, eventNames:['coin'] } };
  pfa4.duck('coin', 0.0, 0.1);
  sentinel(sfx4);
  pfa4.setGroupVolume('Main', 0.9);
  assert(lastTarget(sfx4._eventGain.gain) <= 0.001,
    '9d group-volume move on a ducked member actively re-lands ~0 (setGroupVolume duck-aware)');
}

console.log('\n' + '═'.repeat(70));
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
process.exit(failed ? 1 : 0);
}
main().catch(e=>{ console.error('FATAL', e); process.exit(1); });
