#!/usr/bin/env node
/**
 * test-reverb-worklet.js — sample-accurate Freeverb AudioWorklet core (P5 web).
 *
 * The main test-reverb.js exercises the NATIVE-node fallback only (Node has no
 * AudioWorklet, so the engine falls back). This file isolates and executes the
 * worklet's `_REVERB_WORKLET_SRC` in a stub AudioWorkletGlobalScope (sampleRate +
 * AudioWorkletProcessor + registerProcessor) so the comb/allpass DELAY MATH is
 * actually covered. It locks the 2026-06-15 sample-rate fix:
 *
 *   W1  rate-invariance — comb/allpass delay TIMES are identical at 44.1k & 48k
 *       & 96k (delay lengths scale by sampleRate/44100), so the room sounds the
 *       same on any hardware (was: raw 44.1k counts ⇒ ~8.8% smaller room at 48k).
 *   W2  native parity — worklet delay TIMES == the native fallback's times
 *       (native = (base/44100)·sizeScale), at every rate.
 *   W3  no buffer clamp — at room_size=1, spread=1 the requested length never
 *       exceeds the allocated buffer (Comb.set's min-clamp is never the path),
 *       at 44.1k / 48k / 96k. (Also pins the pre-fix right-comb 3–4 sample clamp.)
 *   W4  RT60 from decay is rate-invariant (feedback uses delay-in-seconds).
 *   W5  spread=0 ⇒ L==R lengths (mono); spread>0 ⇒ R offset.
 *   W6  parameterDescriptors are the 4 k-rate character params.
 *
 * Hand-rolled harness. Run: node tests/test-reverb-worklet.js   (exit 0 = green)
 */

const fs = require('fs');
const path = require('path');

// Pull the worklet source string + native tuning constants out of the real engine.
function loadEngineBits() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { _REVERB_WORKLET_SRC, _FREEVERB };';
  return new Function('window', src)(undefined);
}
const { _REVERB_WORKLET_SRC, _FREEVERB } = loadEngineBits();
const REF = _FREEVERB.refRate; // 44100

// Instantiate the worklet processor FV at a given context sample rate.
function makeProcessor(sr) {
  let captured = null;
  const AudioWorkletProcessorStub = class { constructor() {} };
  const registerProcessor = (name, cls) => { captured = cls; };
  // sampleRate is a global in AudioWorkletGlobalScope → pass it as a binding.
  const fn = new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor',
    _REVERB_WORKLET_SRC + '\n;return { FV: (typeof FV !== "undefined" ? FV : null) };');
  const { FV } = fn(sr, AudioWorkletProcessorStub, registerProcessor);
  if (!captured) throw new Error('registerProcessor was not called by the worklet src');
  if (captured !== FV) throw new Error('captured processor !== FV');
  return new FV();
}

// Native-fallback delay TIME (seconds) for a comb, mirroring _applyReverbCharacter.
function nativeCombSec(base, ss, spreadSamples, right) {
  return ((base + (right ? spreadSamples : 0)) / REF) * ss;
}
function nativeAllpassSec(base, spreadSamples, right) {
  return (base + (right ? spreadSamples : 0)) / REF;
}

// ── tiny assert harness ──────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function approx(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b} ±${tol})`); }

const C = _FREEVERB.comb, A = _FREEVERB.allpass, SP = _FREEVERB.spread;
const RATES = [44100, 48000, 96000];

// ── W1 + W2 — rate-invariance & native parity ────────────────────────
// Character: room_size 0.7 → ss=1.2, decay 2.0, spread 1 → spreadSamples=23.
(() => {
  const rs = 0.7, dec = 2.0, dmp = 0.5, spr = 1.0;
  const ss = 0.5 + rs;
  const spreadSamples = Math.round(SP * spr);
  const TOL = 1e-4; // 100 µs — well under rounding error at any rate

  const procs = RATES.map((sr) => { const p = makeProcessor(sr); p.recompute(rs, dec, dmp, spr); return { sr, p }; });

  for (let i = 0; i < C.length; i++) {
    const wantL = nativeCombSec(C[i], ss, spreadSamples, false);
    const wantR = nativeCombSec(C[i], ss, spreadSamples, true);
    for (const { sr, p } of procs) {
      approx(p.cL[i].len / sr, wantL, TOL, `W2 comb${i} L time @${sr}`);
      approx(p.cR[i].len / sr, wantR, TOL, `W2 comb${i} R time @${sr}`);
    }
    // W1: the three rates agree with each other (rate-invariant room).
    const t = procs.map(({ sr, p }) => p.cL[i].len / sr);
    ok(Math.max(...t) - Math.min(...t) < TOL, `W1 comb${i} L rate-invariant (spread ${(Math.max(...t) - Math.min(...t)).toExponential(2)}s)`);
  }
  for (let i = 0; i < A.length; i++) {
    const wantL = nativeAllpassSec(A[i], spreadSamples, false);
    const wantR = nativeAllpassSec(A[i], spreadSamples, true);
    for (const { sr, p } of procs) {
      approx(p.aL[i].len / sr, wantL, TOL, `W2 allpass${i} L time @${sr}`);
      approx(p.aR[i].len / sr, wantR, TOL, `W2 allpass${i} R time @${sr}`);
    }
  }
})();

// ── W3 — no buffer clamp at the extremes (room=1, spread=1) ───────────
(() => {
  const rs = 1.0, dec = 6.0, dmp = 0.5, spr = 1.0;
  const ss = 0.5 + rs;                 // 1.5 (max)
  const spreadSamples = Math.round(SP * spr);
  for (const sr of RATES) {
    const p = makeProcessor(sr);
    p.recompute(rs, dec, dmp, spr);
    const rk = sr / REF;
    for (let i = 0; i < C.length; i++) {
      const wantR = Math.max(1, Math.round((C[i] + spreadSamples) * ss * rk));
      ok(p.cR[i].len === wantR, `W3 comb${i} R len not clamped @${sr} (got ${p.cR[i].len}, want ${wantR}, buf ${p.cR[i].b.length})`);
      ok(p.cR[i].len < p.cR[i].b.length, `W3 comb${i} R len < buffer @${sr}`);
    }
    for (let i = 0; i < A.length; i++) {
      const wantR = Math.max(1, Math.round((A[i] + spreadSamples) * rk));
      ok(p.aR[i].len === wantR, `W3 allpass${i} R len not clamped @${sr} (got ${p.aR[i].len}, want ${wantR}, buf ${p.aR[i].b.length})`);
    }
  }
})();

// ── W4 — RT60 from decay is rate-invariant (uses delay-in-seconds) ────
(() => {
  const rs = 0.7, dec = 2.5, dmp = 0.5, spr = 1.0;
  const p44 = makeProcessor(44100); p44.recompute(rs, dec, dmp, spr);
  const p48 = makeProcessor(48000); p48.recompute(rs, dec, dmp, spr);
  for (let i = 0; i < C.length; i++) {
    // feedbacks should match across rates (delay TIME is rate-invariant)
    approx(p44.cL[i].fb, p48.cL[i].fb, 5e-3, `W4 comb${i} feedback rate-invariant`);
    // and imply RT60 ≈ dec where not gain-clamped (0.992)
    const D = p48.cL[i].len / 48000, g = p48.cL[i].fb;
    if (g < 0.991) {
      const rt60 = (-3 * D) / Math.log10(g);
      approx(rt60, dec, dec * 0.02, `W4 comb${i} implied RT60 ≈ decay`);
    }
  }
})();

// ── W5 — spread mono/offset ───────────────────────────────────────────
(() => {
  const p0 = makeProcessor(48000); p0.recompute(0.7, 2.0, 0.5, 0.0); // spread 0
  const p1 = makeProcessor(48000); p1.recompute(0.7, 2.0, 0.5, 1.0); // spread 1
  for (let i = 0; i < C.length; i++) {
    ok(p0.cL[i].len === p0.cR[i].len, `W5 spread=0 comb${i} L==R (mono)`);
    ok(p1.cR[i].len > p1.cL[i].len, `W5 spread=1 comb${i} R offset > L`);
  }
})();

// ── W6 — parameterDescriptors ─────────────────────────────────────────
(() => {
  // Re-capture the class (not just an instance) to read the static getter.
  let cls = null;
  const fn = new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor',
    _REVERB_WORKLET_SRC + '\n;return FV;');
  cls = fn(48000, class { }, (n, c) => { });
  const names = cls.parameterDescriptors.map((d) => d.name).sort();
  ok(JSON.stringify(names) === JSON.stringify(['damping', 'decay', 'room_size', 'spread']),
    `W6 four character params present (${names.join(',')})`);
  ok(cls.parameterDescriptors.every((d) => d.automationRate === 'k-rate'), 'W6 all k-rate');
})();

// ── report ────────────────────────────────────────────────────────────
console.log(`\ntest-reverb-worklet: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
