#!/usr/bin/env node
/**
 * test-reverb.js — algorithmic Freeverb reverb send-bus (P5 Reverb T1, web).
 *
 * Mirrors the Godot reference (godot/test_reverb.gd) and locks the WEB-specific
 * divergences proven in the sess8 audit:
 *   L1  bus built only when config.reverb_zones present (opt-in; else no bus)
 *   L2  default_zone applied at load: wet + active name
 *   L3  REAL predelay — predelay.delayTime == predelay_ms / 1000 (clean delay)
 *   L4  REAL decay (RT60) — comb feedback = 10^(-3·D/decay); longer decay ⇒ more fb
 *   L5  HONEST damping — high damping ⇒ LOWER comb cutoff (NOT inverted like Godot)
 *   L6  spread — spread>0 offsets the right channel; spread=0 ⇒ L==R (mono)
 *   L7  setReverbZone(name,{fade:0}) snaps wet; null/''/unknown ⇒ dry
 *   L8  setReverbZone(name,{fade>0}) ramps wet linearly to the zone wet
 *   L9  per-zone godot{} override IGNORED on web; predelay_feedback unused
 *   L10 per-event routing — enabled&&send>0 ⇒ send gain == send, wired to bus.input
 *   L11 no zones ⇒ no bus, opted-in event still dry (zero behaviour change)
 *   L12 reload — rebuild dedupes the bus; dropping zones frees bus + event sends
 *
 * Hand-rolled harness (no framework): loads the REAL src/index.js with a stub
 * AudioContext. Run: node tests/test-reverb.js   (exit 0 = green, 1 = any fail)
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

// ── AudioContext stub ────────────────────────────────────────────────
function recParam(initial) {
  const p = { value: initial === undefined ? 0 : initial, _e: [] };
  p.setValueAtTime = (v, t) => { p.value = v; p._e.push(['set', v, t]); return p; };
  p.linearRampToValueAtTime = (v, t) => { p._e.push(['lin', v, t]); return p; };
  p.exponentialRampToValueAtTime = (v, t) => { p._e.push(['exp', v, t]); return p; };
  p.setTargetAtTime = (v, t, c) => { p._e.push(['tgt', v, t, c]); return p; };
  p.setValueCurveAtTime = (a, t, d) => { p._e.push(['curve', a, t, d]); return p; };
  p.cancelScheduledValues = (t) => { p._e.push(['cancel', t]); return p; };
  return p;
}
function mkNode(type) {
  const n = { _type: type, _conns: [] };
  n.connect = (dest, o, i) => { n._conns.push({ dest, o, i }); return dest; };
  n.disconnect = () => { n._conns.length = 0; };
  if (type === 'gain') n.gain = recParam(1);
  if (type === 'delay') n.delayTime = recParam(0);
  if (type === 'biquad') { n.type = 'lowpass'; n.frequency = recParam(350); n.Q = recParam(1); n.gain = recParam(0); n.detune = recParam(0); }
  return n;
}
function mkCtx() {
  const ctx = { currentTime: 0, sampleRate: 48000, state: 'running' };
  ctx.createGain = () => mkNode('gain');
  ctx.createDelay = () => mkNode('delay');
  ctx.createBiquadFilter = () => mkNode('biquad');
  ctx.createIIRFilter = (ff, fb) => { const n = mkNode('iir'); n._ff = ff; n._fb = fb; return n; };
  ctx.createChannelMerger = () => mkNode('merger');
  ctx.createStereoPanner = () => { const x = mkNode('panner'); x.pan = recParam(0); return x; };
  ctx.createPanner = () => mkNode('panner');
  return ctx;
}

// Build a PFA wired to a stub ctx, with the given config; runs _loadReverbZones.
function mkEngine(config) {
  const pfa = new PFA();
  pfa.ctx = mkCtx();
  pfa.masterGain = pfa.ctx.createGain();
  pfa.events = {};
  pfa.groups = {};
  pfa.config = config;
  pfa._loadReverbZones();
  return pfa;
}

// ── Mirror of the engine's mapping math (regression locks) ───────────
const REF = 44100, COMB0 = 1116;
function combDelay0(room) { return (COMB0 / REF) * (0.5 + room); }
function combFb(delaySec, decay) {
  if (decay <= 0 || delaySec <= 0) return 0;
  return Math.max(0, Math.min(0.992, Math.pow(10, (-3 * delaySec) / decay)));
}
function dampCoef(d) { return Math.min(0.95, Math.max(0, Math.min(1, d)) * 0.9); } // one-pole coef, high = darker

// ── Test zones ───────────────────────────────────────────────────────
const ZONES = {
  hall:   { room_size: 0.75, decay: 3.9, damping: 0.4, wet: 0.36, dry: 1.0, spread: 1.0, hipass: 0.02, predelay_ms: 20.0, predelay_feedback: 0.0 },
  short:  { room_size: 0.3,  decay: 0.5, damping: 0.5, wet: 0.20, dry: 1.0, spread: 1.0, hipass: 0.0,  predelay_ms: 5.0,  predelay_feedback: 0.0 },
  long:   { room_size: 0.3,  decay: 4.0, damping: 0.5, wet: 0.20, dry: 1.0, spread: 1.0, hipass: 0.0,  predelay_ms: 5.0,  predelay_feedback: 0.0 },
  bright: { room_size: 0.5,  decay: 2.0, damping: 0.1, wet: 0.30, dry: 1.0, spread: 1.0, hipass: 0.0,  predelay_ms: 0.0,  predelay_feedback: 0.0 },
  dark:   { room_size: 0.5,  decay: 2.0, damping: 0.9, wet: 0.30, dry: 1.0, spread: 1.0, hipass: 0.0,  predelay_ms: 0.0,  predelay_feedback: 0.0 },
  mono:   { room_size: 0.5,  decay: 2.0, damping: 0.5, wet: 0.30, dry: 1.0, spread: 0.0, hipass: 0.0,  predelay_ms: 0.0,  predelay_feedback: 0.0 },
  wide:   { room_size: 0.5,  decay: 2.0, damping: 0.5, wet: 0.30, dry: 1.0, spread: 1.0, hipass: 0.0,  predelay_ms: 0.0,  predelay_feedback: 0.0 },
  // godot{} override + predelay_feedback that the WEB engine must ignore:
  godcheck: { room_size: 0.4, decay: 1.5, damping: 0.6, wet: 0.5, dry: 1.0, spread: 1.0, hipass: 0.1, predelay_ms: 8.0, predelay_feedback: 0.9,
    godot: { room_size: 0.9, damping: 0.9, wet: 0.9, dry: 1.0, spread: 1.0, hipass: 0.0 } },
};
const FULL_CONFIG = () => ({ reverb_zones: { default_zone: 'hall', zones: JSON.parse(JSON.stringify(ZONES)) }, events: {} });

// ── Assert harness ───────────────────────────────────────────────────
let passed = 0, failed = 0;
function header(t) { console.log('\n' + '═'.repeat(70)); console.log('  ' + t); console.log('═'.repeat(70)); }
function sub(t) { console.log('\n  ─── ' + t + ' ───'); }
function ok(m) { passed++; console.log('    ✓ ' + m); }
function fail(m) { failed++; console.log('    ✗ FAIL: ' + m); }
function assert(c, m) { if (c) ok(m); else fail(m); }
function near(a, b, eps = 1e-4) { return Math.abs(a - b) < eps; }

function main() {
  header('PFA Reverb — algorithmic Freeverb send-bus');

  // ── L1 / L2: build + default zone ──
  sub('L1/L2 bus built from reverb_zones + default zone applied');
  {
    const pfa = mkEngine(FULL_CONFIG());
    assert(pfa.reverbBus != null, 'reverb bus built when reverb_zones present');
    assert(pfa.reverbBus.combsL.length === 8 && pfa.reverbBus.combsR.length === 8, '8 + 8 stereo comb filters');
    assert(pfa.reverbBus.apL.length === 4 && pfa.reverbBus.apR.length === 4, '4 + 4 series allpass diffusers');
    assert(pfa.getReverbZone() === 'hall', "active zone == default_zone ('hall')");
    assert(near(pfa.reverbBus.wetGain.gain.value, 0.36), 'wetGain == hall.wet (0.36) at load, no fade');
    assert(pfa.reverbBus.wetGain._conns.some(c => c.dest === pfa.masterGain), 'wetGain connected to masterGain');
  }

  // ── L3: real predelay ──
  sub('L3 real predelay — delayTime == predelay_ms / 1000');
  {
    const pfa = mkEngine(FULL_CONFIG());
    assert(near(pfa.reverbBus.predelay.delayTime.value, 0.020), 'hall predelay 20 ms → 0.020 s');
    pfa.setReverbZone('short', { fade: 0 });
    assert(near(pfa.reverbBus.predelay.delayTime.value, 0.005), 'short predelay 5 ms → 0.005 s');
    pfa.setReverbZone('bright', { fade: 0 });
    assert(near(pfa.reverbBus.predelay.delayTime.value, 0.0), 'bright predelay 0 ms → 0.0 s');
  }

  // ── L4: real decay (RT60) drives comb feedback ──
  sub('L4 real decay — comb feedback = 10^(-3·D/decay), longer decay ⇒ more fb');
  {
    const pfa = mkEngine(FULL_CONFIG());
    pfa.setReverbZone('short', { fade: 0 });
    const fbShort = pfa.reverbBus.combsL[0].fb.gain.value;
    const expShort = combFb(combDelay0(0.3), 0.5);
    assert(near(fbShort, expShort, 1e-3), `short comb[0] fb == formula (${fbShort.toFixed(4)} ≈ ${expShort.toFixed(4)})`);
    pfa.setReverbZone('long', { fade: 0 });
    const fbLong = pfa.reverbBus.combsL[0].fb.gain.value;
    const expLong = combFb(combDelay0(0.3), 4.0);
    assert(near(fbLong, expLong, 1e-3), `long comb[0] fb == formula (${fbLong.toFixed(4)} ≈ ${expLong.toFixed(4)})`);
    assert(fbLong > fbShort, `longer decay ⇒ higher feedback (${fbLong.toFixed(3)} > ${fbShort.toFixed(3)})`);
    assert(fbLong < 1.0, 'feedback clamped < 1 for stability');
  }

  // ── L5: HONEST damping via one-pole coef (the key anti-Godot lock) ──
  sub('L5 honest damping — high damping ⇒ DARKER (higher one-pole coef), NOT inverted');
  {
    const pfa = mkEngine(FULL_CONFIG());
    pfa.setReverbZone('bright', { fade: 0 });
    const cBright = pfa.reverbBus.combsL[0].dampCoef;
    pfa.setReverbZone('dark', { fade: 0 });
    const cDark = pfa.reverbBus.combsL[0].dampCoef;
    assert(cDark > cBright, `damping 0.9 darker (higher coef) than 0.1 (${cDark.toFixed(3)} > ${cBright.toFixed(3)}) — web is NOT inverted`);
    assert(near(cBright, dampCoef(0.1), 1e-6), 'bright coef == mapping(0.1)');
    assert(near(cDark, dampCoef(0.9), 1e-6), 'dark coef == mapping(0.9)');
    // one-pole coef is always < 1 → comb feedback loop stays stable (no biquad overshoot)
    assert(cDark < 1 && cBright < 1, 'damping coef < 1 (in-loop one-pole gain ≤ 1, no self-oscillation)');
  }

  // ── L6: spread / stereo width ──
  sub('L6 spread — spread>0 offsets right channel; spread=0 ⇒ L==R');
  {
    const pfa = mkEngine(FULL_CONFIG());
    pfa.setReverbZone('mono', { fade: 0 });
    assert(near(pfa.reverbBus.combsL[0].delay.delayTime.value, pfa.reverbBus.combsR[0].delay.delayTime.value),
      'spread=0 → L and R comb delays equal (mono)');
    pfa.setReverbZone('wide', { fade: 0 });
    const dL = pfa.reverbBus.combsL[0].delay.delayTime.value;
    const dR = pfa.reverbBus.combsR[0].delay.delayTime.value;
    assert(dR > dL, `spread=1 → R comb delay longer than L (${dR.toFixed(5)} > ${dL.toFixed(5)})`);
  }

  // ── L7: setReverbZone immediate + dry on null/unknown ──
  sub('L7 setReverbZone snaps wet; null/unknown ⇒ dry');
  {
    const pfa = mkEngine(FULL_CONFIG());
    pfa.setReverbZone('short', { fade: 0 });
    assert(near(pfa.reverbBus.wetGain.gain.value, 0.20) && pfa.getReverbZone() === 'short', 'switch → short wet 0.20, active short');
    pfa.setReverbZone(null, { fade: 0 });
    assert(near(pfa.reverbBus.wetGain.gain.value, 0.0) && pfa.getReverbZone() === '', 'null → wet 0, active ""');
    pfa.setReverbZone('hall', { fade: 0 });
    pfa.setReverbZone('nonexistent', { fade: 0 });
    assert(near(pfa.reverbBus.wetGain.gain.value, 0.0) && pfa.getReverbZone() === '', 'unknown zone → wet 0, active ""');
  }

  // ── L8: fade ramps wet linearly ──
  sub('L8 setReverbZone(fade>0) ramps wet linearly');
  {
    const pfa = mkEngine(FULL_CONFIG());
    pfa.setReverbZone(null, { fade: 0 });
    const wp = pfa.reverbBus.wetGain.gain;
    wp._e.length = 0;
    pfa.setReverbZone('hall', { fade: 0.5 });
    const setE = wp._e.find(e => e[0] === 'set'); // anchor (scheduled at _now())
    const lin = wp._e.find(e => e[0] === 'lin');
    assert(lin != null, 'a linearRampToValueAtTime was scheduled');
    assert(lin && near(lin[1], 0.36), 'ramps toward hall.wet (0.36)');
    assert(setE && lin && near(lin[2] - setE[2], 0.5), 'ramp duration == fade (0.5), from the anchor');
  }

  // ── L9: godot{} override + predelay_feedback ignored on web ──
  sub('L9 godot{} override and predelay_feedback ignored on web');
  {
    const pfa = mkEngine(FULL_CONFIG());
    pfa.setReverbZone('godcheck', { fade: 0 });
    assert(near(pfa.reverbBus.wetGain.gain.value, 0.5), 'wet uses NEUTRAL 0.5, not godot 0.9');
    const dL = pfa.reverbBus.combsL[0].delay.delayTime.value;
    assert(near(dL, combDelay0(0.4), 1e-5), 'comb delay uses NEUTRAL room_size 0.4, not godot 0.9');
    assert(near(pfa.reverbBus.predelay.delayTime.value, 0.008), 'real predelay 8 ms applied (feedback schema-only, ignored)');
  }

  // ── L10: per-event routing ──
  sub('L10 per-event reverb send routing (opt-in, honors magnitude)');
  {
    const pfa = mkEngine(FULL_CONFIG());
    const mkEv = (reverb) => { const e = new PFAEvent('e', { type: 'music', reverb }, pfa); pfa.events['e'] = e; e._ensureGain(); return e; };

    let e = mkEv({ enabled: true, send: 0.6 });
    assert(e._reverbSend != null && near(e._reverbSend.gain.value, 0.6), 'enabled & send 0.6 → send gain 0.6');
    assert(e._reverbSend && e._reverbSend._conns.some(c => c.dest === pfa.reverbBus.input), 'send wired into reverb bus input');
    assert(e._eventGain._conns.some(c => c.dest === e._reverbSend), 'send taps off _eventGain (inherits fades)');

    e = mkEv({ enabled: false, send: 0.6 });
    assert(e._reverbSend == null, 'enabled=false → no send (dry on master)');
    e = mkEv({ enabled: true, send: 0.0 });
    assert(e._reverbSend == null, 'send=0 → no send');
    e = mkEv(null);
    assert(e._reverbSend == null, 'no reverb block → no send');
  }

  // ── L11: no zones ⇒ no bus, still dry ──
  sub('L11 no reverb_zones ⇒ no bus, opted-in event stays dry');
  {
    const pfa = mkEngine({ events: {} });
    assert(pfa.reverbBus == null, 'no bus built without reverb_zones');
    assert(pfa.getReverbZone() === '', 'active zone ""');
    const e = new PFAEvent('e', { type: 'music', reverb: { enabled: true, send: 0.8 } }, pfa);
    pfa.events['e'] = e; e._ensureGain();
    assert(e._reverbSend == null, 'opted-in event creates NO send when there is no bus');
    pfa.setReverbZone('whatever'); // must not throw
    ok('setReverbZone is a safe no-op with no bus');
  }

  // ── L12: reload dedupe + drop frees ──
  sub('L12 reload — rebuild dedupes; dropping zones frees bus + event sends');
  {
    const pfa = mkEngine(FULL_CONFIG());
    const e = new PFAEvent('e', { type: 'music', reverb: { enabled: true, send: 0.5 } }, pfa);
    pfa.events['e'] = e; e._ensureGain();
    assert(e._reverbSend != null, 'event opted in before reload');
    const firstBus = pfa.reverbBus;

    pfa.config = FULL_CONFIG();
    pfa._loadReverbZones();
    assert(pfa.reverbBus != null && pfa.reverbBus !== firstBus, 'reload rebuilds a single fresh bus (old freed)');
    assert(e._reverbSend == null, 'reload cleared the stale event send (re-created on next play)');

    pfa.config = { events: {} };
    pfa._loadReverbZones();
    assert(pfa.reverbBus == null, 'reload dropping reverb_zones frees the bus');
    assert(pfa.getReverbZone() === '', 'active zone reset to ""');
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`  RESULT: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(70));
  process.exit(failed ? 1 : 0);
}

main();
