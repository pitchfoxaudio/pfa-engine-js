/**
 * PFA Engine — PitchFox Audio Engine
 * Adaptive music & SFX runtime for web games.
 * Uses Web Audio API.
 *
 * @example
 * import { PFA } from 'pfa-engine';
 *
 * const pfa = new PFA();
 * await pfa.loadPack('/audio/config.json');
 * pfa.play('main_theme');
 * pfa.setLevel('main_theme', 1);
 * pfa.trigger('coin');
 *
 * // Node graph navigation (Advanced mode)
 * pfa.navigate('main_theme', 'battle_start');
 *
 * // Sub-level toggle
 * pfa.toggleSubLevel('main_theme', 'drums', true);
 *
 * // Spatial audio (2D)
 * pfa.setWorldScale(100);  // 100 game units = 1 audio unit
 * pfa.setListener2D(player.x, player.y);
 * pfa.triggerSpatial('coin', coin.x, coin.y);
 *
 * // Spatial audio (3D)
 * pfa.setListener3D(cam.x, cam.y, cam.z, cam.fwdX, cam.fwdY, cam.fwdZ, cam.upX, cam.upY, cam.upZ);
 * pfa.triggerSpatial('explosion', pos.x, pos.y, pos.z);
 *
 * // Spatial emitter (for moving objects)
 * const emitter = pfa.createEmitter({ mode: '2D' });
 * emitter.setPosition2D(enemy.x, enemy.y);
 * emitter.trigger('enemy_idle');
 */

// ── Spatial Audio Utilities ──────────────────────────────────────────

const _SPATIAL_DEFAULTS = {
  mode: '2D',
  attenuation: { model: 'inverse', minDistance: 1.0, maxDistance: 50.0, rolloff: 1.0 },
  panningModel: 'equalpower',
  maxPan: 1.0,
  // Doppler amount — 3D pitch-from-velocity for moving sources/listener.
  // 0 = off (default, costs nothing); 1 = physical; >1 stylized. Web Audio's
  // PannerNode doppler was removed from the spec → computed manually per frame
  // in _updateSpatialVoices (velocity from position deltas).
  doppler: 0,
  // Distance LPF (3D only) — Godot-semantics air absorption: a per-voice
  // highshelf at lpfCutoffHz whose gain deepens from 0 dB toward lpfDb as the
  // distance attenuation falls: db = (1 − min(1, att)) × lpfDb (Godot source,
  // audio_stream_player_3d.cpp _update_panning; Godot mixes it as a highshelf
  // via set_playback_highshelf_params). ON by default = Godot's own node
  // defaults (5000 Hz / −24 dB): Godot has ALWAYS filtered like this, the web
  // engine now deliberately matches. Off (lpfEnabled false / lpfDb 0) ⇒ no
  // filter node at all. Godot 2D has no such filter → 2D untouched here too.
  lpfEnabled: true,
  lpfCutoffHz: 5000,
  lpfDb: -24,
};

function _mergeSpatialConfig(userCfg, eventCfg) {
  // Precedence (low→high): _SPATIAL_DEFAULTS → eventCfg (editor-authored, from
  // the config.json `spatial` block) → userCfg (game-passed override). Both
  // layers may be null/partial; only present keys override. Back-compat: called
  // with a single arg ⇒ identical to the original defaults←userCfg behaviour.
  const out = { ..._SPATIAL_DEFAULTS, attenuation: { ..._SPATIAL_DEFAULTS.attenuation } };
  for (const cfg of [eventCfg, userCfg]) {
    if (!cfg) continue;
    if (cfg.mode) out.mode = cfg.mode;
    if (cfg.attenuation) out.attenuation = { ...out.attenuation, ...cfg.attenuation };
    if (cfg.panningModel) out.panningModel = cfg.panningModel;
    if (cfg.maxPan != null) out.maxPan = cfg.maxPan;
    if (cfg.doppler != null) out.doppler = cfg.doppler;
    if (cfg.lpfEnabled != null) out.lpfEnabled = cfg.lpfEnabled;
    if (cfg.lpfCutoffHz != null) out.lpfCutoffHz = cfg.lpfCutoffHz;
    if (cfg.lpfDb != null) out.lpfDb = cfg.lpfDb;
  }
  return out;
}

/**
 * Convert an editor-authored config.json `spatial` block (snake_case, flat)
 * into the engine's internal cfg shape (camelCase, nested `attenuation`). Returns
 * null when absent or disabled so it contributes nothing to the merge (engine
 * keeps its own _SPATIAL_DEFAULTS). Only present keys are copied — never writes
 * `undefined` over a default.
 * @private
 */
function _eventSpatialToCfg(sp) {
  if (!sp || !sp.enabled) return null;
  const att = {};
  if (sp.model != null) att.model = sp.model;
  if (sp.min_distance != null) att.minDistance = sp.min_distance;
  if (sp.max_distance != null) att.maxDistance = sp.max_distance;
  if (sp.rolloff != null) att.rolloff = sp.rolloff;
  const cfg = { attenuation: att };
  if (sp.mode != null) cfg.mode = sp.mode;
  if (sp.panning_model != null) cfg.panningModel = sp.panning_model;
  if (sp.max_pan != null) cfg.maxPan = sp.max_pan;
  if (sp.doppler != null) cfg.doppler = sp.doppler;
  if (sp.lpf_enabled != null) cfg.lpfEnabled = sp.lpf_enabled;
  if (sp.lpf_cutoff_hz != null) cfg.lpfCutoffHz = sp.lpf_cutoff_hz;
  if (sp.lpf_db != null) cfg.lpfDb = sp.lpf_db;
  return cfg;
}

// ── Intensity (velocity) ─────────────────────────────────────────────
//
// Per-trigger hit strength, like a MIDI note's velocity. The game passes a
// normalized intensity 0..1; this AUTHORED curve (event.intensity, from the
// config.json `intensity` block) maps it to a per-voice gain multiplier + a
// pitch-semitone offset, applied ON TOP of the random variation. IDENTICAL math
// in the Godot engine (pfa_track.gd) — see doc «Intensity (velocity) feature —
// design + curve reference».
function _intensityShape(curve, t) {
  switch (curve) {
    case 'exponential': return t * t;               // slow→fast (perceptual loudness)
    case 'logarithmic': return t * (2 - t);         // = 2t − t²; fast→slow
    case 's_curve':     return t * t * (3 - 2 * t); // smoothstep; eased both ends
    default:            return t;                   // linear
  }
}

/**
 * Map a normalized intensity (0..1, default 1.0 when null/undefined) through an
 * event's authored `intensity` config → { gainMult, pitchSt }. Disabled / absent ⇒
 * the neutral { gainMult: 1, pitchSt: 0 } (zero behaviour change). vol_db / pitch_st
 * are [value at intensity 0, at intensity 1]; volume summed in dB → gain, pitch in
 * semitones → applied as a rate multiplier downstream.
 * @private
 */
function _intensityToGainPitch(intensity, cfg) {
  if (!cfg || !cfg.enabled) return { gainMult: 1.0, pitchSt: 0.0 };
  const t = Math.max(0, Math.min(1, intensity == null ? 1.0 : intensity));
  const vd = cfg.vol_db || [0, 0];
  const ps = cfg.pitch_st || [0, 0];
  const volDb = vd[0] + (vd[1] - vd[0]) * _intensityShape(cfg.vol_curve || 'linear', t);
  const pitchSt = ps[0] + (ps[1] - ps[0]) * _intensityShape(cfg.pitch_curve || 'linear', t);
  return { gainMult: Math.pow(10, volDb / 20), pitchSt };
}

// ── Reverb (algorithmic Freeverb send-bus) ───────────────────────────
//
// Web parity for the Godot reverb (pfa_reverb.gd), but HONEST where Godot's
// native AudioEffectReverb is quirky (sess8 audit). The neutral zone descriptor
// (config.json `reverb_zones.zones[name]`, snake_case, flat) is shared byte-for-
// byte with Godot; the WEB engine deliberately diverges on three keys:
//   • decay        — REAL RT60 in seconds. Godot ignores it (Freeverb has no
//                    explicit decay; room_size carries size). Here decay drives
//                    each comb's feedback gain: g = 10^(-3·D/decay) ⇒ a −60 dB
//                    tail exactly `decay` seconds long, independent of room_size.
//   • predelay_ms  — REAL predelay: a plain DelayNode before the network. Godot
//                    forces its predelay to 0 because there it is a feedback comb
//                    (reverb_filter.cpp:79) that rings as a comb-tone.
//   • damping      — used DIRECTLY (NOT inverted). Higher damping = darker tail
//                    (DAW convention). Godot does `effect.damping = 1.0 - damping`
//                    only because its native key is inverted-bright; web is honest.
// `predelay_feedback` is schema-only (always 0, never implemented here); `dry`
// is a parallel-send no-op on web (the dry path stays full on master); the
// per-zone `godot{}` override block is ignored. room_size scales the comb delay
// lengths (spaciousness); spread offsets the right channel for stereo width.
// The comb+allpass CORE runs in a sample-accurate AudioWorklet (_REVERB_WORKLET_SRC,
// loaded from a Blob URL → no asset file). A native-node graph is the fallback when
// AudioWorklet is unavailable; that fallback colors the tail (see _REVERB_WORKLET_SRC).

const _REVERB_DEFAULTS = {
  room_size: 0.7,
  decay: 1.0,          // seconds (RT60) — Web-only; drives comb feedback
  damping: 0.5,        // 0..1, HIGH = darker tail (NOT inverted, unlike Godot)
  wet: 0.3,
  dry: 1.0,            // parallel-send no-op on web (kept for schema parity)
  spread: 1.0,
  hipass: 0.0,         // 0..1 high-pass on the reverb send (pre-network), thins low rumble in the tail
  predelay_ms: 12.0,   // Web-only TRUE predelay (plain delay, no feedback)
  predelay_feedback: 0.0, // schema-only; never implemented on web
};

// Classic Freeverb (Jezar) tunings — sample counts at 44.1 kHz, scaled to
// seconds at apply time (DelayNode is rate-independent, so refRate is fixed).
const _FREEVERB = {
  comb: [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], // 8 parallel LBCF combs
  allpass: [556, 441, 341, 225],                          // 4 series allpass diffusers
  spread: 23,            // right-channel sample offset at spread=1 (stereo width)
  inputGain: 0.04,       // fixed input scaling into the comb network (tunable by ear)
  allpassFeedback: 0.5,  // Schroeder allpass coefficient
  refRate: 44100,        // the tunings are sample counts at this rate
};

// Sample-accurate Freeverb for an AudioWorkletProcessor. Native DelayNode feedback
// loops in Web Audio carry an irreducible one-render-quantum (128-frame) latency PER
// recirculation (spec: a DelayNode in a cycle is floored to one render quantum, and
// block processing only exposes the PREVIOUS block to a feedback edge). That +128
// detunes the combs and — worse — turns the fixed-delay Schroeder allpass diffusers
// into fixed-frequency resonators: a metallic, preset-independent "tube" tone (audit
// 2026-06-15: measured ~810/1865/2250 Hz on every preset; removing the allpass killed
// it). A worklet runs the canonical Freeverb sample-by-sample with NO loop latency, so
// the diffusers stay diffusers. Loaded from a Blob URL → no asset file (self-contained
// for <script> distribution). Input gain (0.04) + predelay + hipass stay native pre-
// stages; the worklet does comb+allpass only and receives its character via k-rate AudioParams (parameterData for init).
const _REVERB_WORKLET_SRC = `
const C=[1116,1188,1277,1356,1422,1491,1557,1617],A=[556,441,341,225],SP=23,APFB=0.5,REF=44100;
function fbg(dSec,dec){if(dec<=0||dSec<=0)return 0;return Math.max(0,Math.min(0.992,Math.pow(10,(-3*dSec)/dec)));}
function dcf(d){d=Math.max(0,Math.min(1,d));return Math.min(0.95,d*0.9);}
class Comb{constructor(m){this.b=new Float32Array(m);this.len=1;this.i=0;this.fb=0;this.damp=0;this.s=0;}
 set(len,f,dmp){this.len=Math.max(1,Math.min(this.b.length,len));if(this.i>=this.len)this.i=0;this.fb=f;this.damp=dmp;}
 proc(x){const o=this.b[this.i];this.s=o*(1-this.damp)+this.s*this.damp;this.b[this.i]=x+this.s*this.fb;if(++this.i>=this.len)this.i=0;return o;}}
class Ap{constructor(m){this.b=new Float32Array(m);this.len=1;this.i=0;}
 set(len){this.len=Math.max(1,Math.min(this.b.length,len));if(this.i>=this.len)this.i=0;}
 proc(x){const bo=this.b[this.i];const o=-x+bo;this.b[this.i]=x+bo*APFB;if(++this.i>=this.len)this.i=0;return o;}}
class FV extends AudioWorkletProcessor{
 static get parameterDescriptors(){return [
  {name:'room_size',defaultValue:0.7,minValue:0,maxValue:1,automationRate:'k-rate'},
  {name:'decay',defaultValue:1,minValue:0.05,maxValue:60,automationRate:'k-rate'},
  {name:'damping',defaultValue:0.5,minValue:0,maxValue:1,automationRate:'k-rate'},
  {name:'spread',defaultValue:1,minValue:0,maxValue:1,automationRate:'k-rate'}];}
 constructor(){super();
  const rk=sampleRate/REF; // tunings are 44.1k sample counts → size buffers to the context rate so the room is rate-invariant
  this.cL=[];this.cR=[];for(let i=0;i<C.length;i++){const m=Math.ceil((C[i]+SP)*1.5*rk)+8;this.cL.push(new Comb(m));this.cR.push(new Comb(m));}
  this.aL=[];this.aR=[];for(let i=0;i<A.length;i++){const m=Math.ceil((A[i]+SP)*rk)+8;this.aL.push(new Ap(m));this.aR.push(new Ap(m));}
  this.prs=-1;this.pdec=-1;this.pdmp=-1;this.psp=-1;}
 recompute(rs,dec,dmp,spr){const sr=sampleRate;const rk=sr/REF;const ss=0.5+Math.max(0,Math.min(1,rs));
  const sp=Math.round(SP*Math.max(0,Math.min(1,spr)));const co=dcf(dmp);const dd=Math.max(0.05,dec);
  for(let i=0;i<C.length;i++){const lp=Math.max(1,Math.round(C[i]*ss*rk)),rp=Math.max(1,Math.round((C[i]+sp)*ss*rk));
   this.cL[i].set(lp,fbg(lp/sr,dd),co);this.cR[i].set(rp,fbg(rp/sr,dd),co);}
  for(let i=0;i<A.length;i++){this.aL[i].set(Math.max(1,Math.round(A[i]*rk)));this.aR[i].set(Math.max(1,Math.round((A[i]+sp)*rk)));}}
 process(inputs,outputs,parameters){const out=outputs[0];if(!out||!out[0])return true;
  const rs=parameters.room_size[0],dec=parameters.decay[0],dmp=parameters.damping[0],spr=parameters.spread[0];
  if(rs!==this.prs||dec!==this.pdec||dmp!==this.pdmp||spr!==this.psp){this.recompute(rs,dec,dmp,spr);this.prs=rs;this.pdec=dec;this.pdmp=dmp;this.psp=spr;}
  const inp=inputs[0];const n=out[0].length;const ch=(inp&&inp[0])?inp[0]:null;const oL=out[0],oR=out[1]||out[0];
  for(let s=0;s<n;s++){const x=ch?ch[s]:0;let l=0,r=0;
   for(let i=0;i<this.cL.length;i++){l+=this.cL[i].proc(x);r+=this.cR[i].proc(x);}
   for(let i=0;i<this.aL.length;i++){l=this.aL[i].proc(l);r=this.aR[i].proc(r);}
   oL[s]=l;oR[s]=r;}
  return true;}}
registerProcessor('pfa-freeverb',FV);
`;

/**
 * Resolve a raw zone descriptor (from config.json) into a full character object:
 * defaults ← present flat keys. Ignores the optional per-zone `godot{}` override
 * (native AudioEffectReverb, Godot-only) and any extra keys. Mirrors the merge
 * order of _mergeSpatialConfig — only present keys override a default.
 * @private
 */
function _resolveReverbZone(raw) {
  const out = { ..._REVERB_DEFAULTS };
  if (raw) {
    for (const k of Object.keys(_REVERB_DEFAULTS)) {
      if (raw[k] != null) out[k] = raw[k];
    }
  }
  return out;
}

/**
 * Comb feedback gain for a target RT60. A comb of delay D seconds with feedback
 * g decays 60 dB after T = D·ln(0.001)/ln(g) seconds; inverting for g at T=decay
 * gives g = 10^(−3·D/decay). Clamped < 1 for stability. NOTE: this drives the
 * NATIVE-fallback combs only; on that path each feedback loop carries an irreducible
 * +128-sample (one render quantum) latency that detunes/colors the tail. The default
 * AudioWorklet core (_REVERB_WORKLET_SRC) has no such latency and computes its own
 * feedback internally.
 * @private
 */
function _reverbCombFeedback(delaySec, decaySec) {
  if (decaySec <= 0 || delaySec <= 0) return 0;
  const g = Math.pow(10, (-3 * delaySec) / decaySec);
  // < 1 for stability. The in-loop damping is a true one-pole (gain ≤ 1), so the
  // loop is stable for any g < 1; 0.992 covers the full EAX decay range (up to
  // ~10 s, e.g. Hangar) on every comb while staying below unity. (Verified stable
  // AND non-clipping: worst case — saturated feedback, wet=1, full-scale input —
  // peaks 0.88.)
  return Math.max(0, Math.min(0.992, g));
}

/** Damping → ONE-POLE lowpass coefficient in the comb feedback. HIGH damping =
 * darker (higher coef). Honest DAW convention — NOT inverted. A one-pole has gain
 * ≤ 1 at EVERY frequency; Web Audio's BiquadFilter lowpass instead overshoots
 * ~1.2× (measured, all Q) which inside the comb feedback loop pushes loop gain > 1
 * → self-oscillation/blow-up. So damping uses a true one-pole (IIRFilterNode),
 * exactly like the original Freeverb. @private */
function _reverbDampingCoef(damping) {
  const d = Math.max(0, Math.min(1, damping));
  return Math.min(0.95, d * 0.9); // d=0 → open/bright, d=1 → 0.9 (dark); always < 1 (stable)
}

/** hipass (0..1) → high-pass cutoff (Hz) on the reverb send (pre-network). 0 = effectively off. @private */
function _reverbHipassCutoff(hipass) {
  const h = Math.max(0, Math.min(1, hipass));
  if (h <= 0) return 20;
  return 20 * Math.pow(30, h); // h=0 → 20 Hz, h=1 → 600 Hz
}

/**
 * Compute distance-based attenuation for 2D spatial audio.
 * Returns gain multiplier [0..1].
 */
function _computeDistanceAttenuation(distance, att) {
  const { model, minDistance, maxDistance, rolloff } = att;
  if (distance <= minDistance) return 1.0;
  if (maxDistance > 0 && distance >= maxDistance) return 0.0;

  let gain;
  switch (model) {
    case 'linear':
      gain = (maxDistance <= minDistance) ? 1.0
        : Math.max(0, 1.0 - rolloff * (distance - minDistance) / (maxDistance - minDistance));
      break;
    case 'exponential':
      gain = Math.pow(distance / minDistance, -rolloff);
      break;
    case 'inverse':
    default:
      gain = minDistance / (minDistance + rolloff * (distance - minDistance));
  }
  // Boundary taper: close the curve to 0 over the LAST 10% of the radius
  // instead of stepping from the curve value (~2-5% for the default inverse,
  // up to 0.5 for linear with rolloff<1) straight to silence at maxDistance —
  // that step pops when a voice crosses the radius at speed. The curve inside
  // 90% of the radius is untouched; maxDistance <= 0 keeps the infinite tail.
  // (Godot's 2D curve reaches 0 at max by construction — this is the web
  // path's own boundary fix, not a curve copy.)
  if (maxDistance > 0) {
    const taperStart = maxDistance * 0.9;
    if (distance > taperStart) gain *= (maxDistance - distance) / (maxDistance - taperStart);
  }
  return gain;
}

/**
 * Distance-LPF gain in dB for a voice's highshelf filter — Godot semantics
 * (audio_stream_player_3d.cpp): db = (1 − min(1, att)) × lpfDb. Fully open
 * (0 dB) at/inside min_distance, deepening toward lpfDb as the distance
 * attenuation `att` falls toward 0 (fully closed at/past max_distance).
 */
function _distanceLpfDb(att, lpfDb) {
  return (1 - Math.min(1, att)) * lpfDb;
}

/**
 * Compute 2D stereo pan from horizontal offset.
 * Returns pan value [-1..+1].
 */
function _computePan2D(listenerX, sourceX, maxDistance, worldScale) {
  const dx = (sourceX - listenerX) / worldScale;
  if (maxDistance <= 0) return 0;
  return Math.max(-1, Math.min(1, dx / maxDistance));
}

/**
 * Compute 2D distance in audio units.
 */
function _distance2D(lx, ly, sx, sy, scale) {
  const dx = (sx - lx) / scale;
  const dy = (sy - ly) / scale;
  return Math.sqrt(dx * dx + dy * dy);
}

const _DOPPLER_C = 343; // speed of sound, audio units (= meters) per second

/**
 * Doppler pitch ratio from source/listener velocities (audio units/s) and
 * positions (any uniform unit — only the direction is used):
 *   f' = f × (c + vListener·û) / (c − vSource·û),  û = unit vector source→listener,
 * positive radial velocity = moving TOWARD the other end. `amount` scales the
 * deviation from 1 (0 = off, 1 = physical, >1 stylized). Radial speeds are
 * capped below c (a teleporting emitter must not blow the ratio up) and the
 * result is clamped to [0.25, 4] (±2 octaves) as a final safety.
 */
function _dopplerRatio(srcVel, lisVel, srcPos, lisPos, amount, c = _DOPPLER_C) {
  const rx = lisPos.x - srcPos.x, ry = lisPos.y - srcPos.y, rz = (lisPos.z || 0) - (srcPos.z || 0);
  const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (dist < 1e-6 || !(amount > 0)) return 1.0;
  const ux = rx / dist, uy = ry / dist, uz = rz / dist;
  const cap = 0.9 * c;
  const clamp = (v) => Math.max(-cap, Math.min(cap, v));
  const vSrc = clamp(srcVel.x * ux + srcVel.y * uy + (srcVel.z || 0) * uz);      // + = source → listener
  const vLis = clamp(-(lisVel.x * ux + lisVel.y * uy + (lisVel.z || 0) * uz));   // + = listener → source
  const ratio = 1 + ((c + vLis) / (c - vSrc) - 1) * amount;
  return Math.max(0.25, Math.min(4.0, ratio));
}

// ── Fade Curve Helper ────────────────────────────────────────────────

/**
 * Fade-in curve shape 0→1 for progress ∈ [0,1]. Editor parity:
 * core/track.py::_get_fade_value. For fade-out callers pass f(1-p) inline.
 */
function _evalFadeInCurve(progress, curve) {
  const p = Math.max(0, Math.min(1, progress));
  switch (curve) {
    case 'linear': return p;
    case 'equal_power': return Math.sin(p * Math.PI / 2);
    case 's_curve': return p * p * (3 - 2 * p);
    case 'exponential': return p * p;
    case 'logarithmic': {
      const inv = 1 - p;
      return 1 - inv * inv;
    }
    default: return p;
  }
}

/**
 * Ramp a Web Audio AudioParam from v0→v1 over duration seconds starting at t0,
 * shaping the ramp according to `curve` (linear / equal_power / s_curve /
 * exponential / logarithmic). Editor & Godot parity.
 *
 * - linear: native linearRampToValueAtTime (cheap, sample-accurate).
 * - non-linear: setValueCurveAtTime with a pre-computed sample array.
 *   Fade direction inferred from sign(v1-v0) so fade-out uses f(1-t) shape.
 *
 * Caller is expected to have already called cancelScheduledValues at t0 +
 * epsilon so no prior event conflicts with this ramp.
 */
function _applyFadeCurve(gainParam, v0, v1, t0, duration, curve) {
  if (duration <= 0) {
    gainParam.setValueAtTime(v1, t0);
    return;
  }
  if (!curve || curve === 'linear') {
    gainParam.setValueAtTime(v0, t0);
    gainParam.linearRampToValueAtTime(v1, t0 + duration);
    return;
  }
  // Sample the shape. Webkit/Firefox setValueCurveAtTime interpolates between
  // samples, so ~128 Hz sample-rate of the curve is well below per-frame audio
  // resolution and visually smooth. Minimum 16 points for very short fades.
  const N = Math.max(16, Math.min(512, Math.ceil(duration * 128)));
  const arr = new Float32Array(N + 1);
  const isFadeOut = v1 < v0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const shape = isFadeOut
      ? _evalFadeInCurve(1 - t, curve)
      : _evalFadeInCurve(t, curve);
    arr[i] = isFadeOut
      ? v1 + (v0 - v1) * shape     // fade-out: amp = v1 + (v0-v1) * f(1-t)
      : v0 + (v1 - v0) * shape;    // fade-in:  amp = v0 + (v1-v0) * f(t)
  }
  gainParam.setValueCurveAtTime(arr, t0, duration);
}

// ── PFA Engine ───────────────────────────────────────────────────────

class PFA {
  constructor() {
    /** @type {AudioContext} */
    this.ctx = null;
    /** @type {GainNode} */
    this.masterGain = null;
    /** @type {Object<string, PFAEvent>} */
    this.events = {};
    /** @type {Object<string, PFAGroup>} */
    this.groups = {};
    /** @type {Object} */
    this.config = null;
    /** @type {string} */
    this.basePath = '';
    /** @type {boolean} */
    this.loaded = false;

    // Event callbacks
    /** @type {Function|null} */
    this.onEventStarted = null;
    /** @type {Function|null} */
    this.onEventStopped = null;
    /** @type {Function|null} */
    this.onLevelChanged = null;
    /** @type {Function|null} */
    this.onSfxTriggered = null;
    /** @type {Function|null} - Called on node graph navigation: (eventName, nodeId, nodeName) */
    this.onNodeChanged = null;
    /** @type {Function|null} - Called on sub-level toggle: (eventName, subLevelName, enabled) */
    this.onSubLevelToggled = null;
    /** @type {Function|null} - Transition-phase breadcrumb: (eventName, info).
     * info.phase ∈ { "entry_fade" | "terminal_fade" | "fade_out_start" | "transition" }.
     * Mirrors Godot signal `PFAEvent.transition_info`; subscribe for UI / debug overlays. */
    this.onTransitionInfo = null;

    // Spatial audio state
    /** @private */ this._listenerPos = { x: 0, y: 0, z: 0 };
    /** @private */ this._listenerMode = '2D';
    /** @private */ this._worldScale = 1.0;
    /** @private */ this._spatialVoices = [];
    /** @private */ this._emitters = [];
    /** @private */ this._nextSpatialId = 1;

    // Bank mode state
    /** @private */ this._bankMode = false;
    /** @private */ this._bankBuffer = null;
    /** @private */ this._bankDataOffset = 0;
    /** @private */ this._bankEntries = null;

    // Memory management: AssetStore + DecodeCache + LRU
    /** @private */ this._assetStore = {};       // { filePath: ArrayBuffer } — compressed bytes, always kept
    /** @private */ this._decodeCache = {};      // { filePath: AudioBuffer } — decoded PCM, LRU-managed
    /** @private */ this._decodeLRU = [];        // [ filePath, ... ] — most recently used at end
    /** @private */ this._memoryBudgetBytes = Infinity; // default: no eviction (backward compat)
    /** @private */ this._decodedBytes = 0;      // current total decoded PCM bytes in cache

    // Reverb (algorithmic Freeverb send-bus) — built lazily from
    // config.reverb_zones; null when the pack ships no zones (zero behaviour change).
    /** @private @type {Object|null} */ this.reverbBus = null;      // { input, predelay, hipass, combsL[], combsR[], apL[], apR[], merger, wetGain }
    /** @private @type {Object|null} */ this.reverbZones = null;    // { name: resolvedCharacter }
    /** @private @type {string|null} */ this.reverbDefaultZone = null;
    /** @private @type {string} */ this.activeReverbZone = '';      // '' = fully dry
    /** @private @type {?boolean} */ this._reverbWorkletReady = null; // null=untried, true=worklet core, false=native fallback
    /** @private @type {?Promise} */ this._reverbWorkletPromise = null;
  }

  /**
   * Initialize audio context. Call on user gesture (click/tap).
   */
  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);

    // Handle device changes (Bluetooth connect/disconnect)
    this.ctx.onstatechange = () => {
      if (this.ctx.state === 'interrupted') {
        console.warn('[PFA] AudioContext interrupted (device change?)');
      } else if (this.ctx.state === 'running') {
        console.log('[PFA] AudioContext resumed');
      }
    };

    // Handle tab visibility (Safari suspends inactive tabs)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.ctx.suspend().catch(() => {});
        } else {
          this.ctx.resume().catch(() => {});
        }
      });
    }
  }

  // ── Reverb send-bus (algorithmic Freeverb) ──────────────────────────

  /**
   * (Re)build engine reverb state from `config.reverb_zones`. Opt-in: absent /
   * empty ⇒ no bus is built and every voice stays dry on master (zero behaviour
   * change). Reload-safe: frees any prior bus + per-event sends first, then
   * applies the default zone immediately (no fade). Called from loadPack/loadBank.
   * @private
   */
  _loadReverbZones() {
    this._freeReverbBus();
    this.reverbZones = null;
    this.reverbDefaultZone = null;
    this.activeReverbZone = '';
    const rz = this.config && this.config.reverb_zones;
    if (!rz || !rz.zones || Object.keys(rz.zones).length === 0) return;

    this.reverbZones = {};
    for (const zname of Object.keys(rz.zones)) {
      this.reverbZones[zname] = _resolveReverbZone(rz.zones[zname]);
    }
    this.reverbDefaultZone = (rz.default_zone != null) ? String(rz.default_zone) : null;
    const def = (this.reverbDefaultZone && this.reverbZones[this.reverbDefaultZone])
      ? this.reverbDefaultZone : '';
    // Build with the default zone's character as the worklet's INITIAL parameterData,
    // so the core is correct from sample 0 (no default-character onset window before
    // setReverbZone's +5 ms anti-click schedule lands). Later switches go via setValueAtTime.
    const initialChar = (def && this.reverbZones[def]) ? this.reverbZones[def] : _REVERB_DEFAULTS;
    this._ensureReverbBus(initialChar);
    this.setReverbZone(def, { fade: 0 });
  }

  /**
   * Lazily build the one global reverb send-bus node graph:
   *   input → predelay (Delay) → hipass (Biquad) → inputGain
   *         → [8 parallel LBCF combs ×2 channels] → [4 series allpass ×2]
   *         → channel merger → wetGain → masterGain
   * Returns the bus object (also stored on this.reverbBus). No-op if already built
   * or no audio context. @private
   */
  _ensureReverbBus(initialChar) {
    if (this.reverbBus || !this.ctx) return this.reverbBus;
    const ctx = this.ctx;

    const input = ctx.createGain();
    const predelay = ctx.createDelay(0.5);
    const hipass = ctx.createBiquadFilter();
    hipass.type = 'highpass';
    hipass.frequency.value = 20;
    hipass.Q.value = 0.707;
    const inGain = ctx.createGain();
    inGain.gain.value = _FREEVERB.inputGain;
    // Freeverb sums the input to MONO before the comb banks — stereo width comes
    // purely from the right bank's spread offset, not from input stereo. Force a
    // one-time downmix here so both banks see the same mono feed.
    inGain.channelCount = 1;
    inGain.channelCountMode = 'explicit';
    inGain.channelInterpretation = 'speakers';
    input.connect(predelay);
    predelay.connect(hipass);
    hipass.connect(inGain);

    const wetGain = ctx.createGain();
    wetGain.gain.value = 0; // ramped by setReverbZone

    // Comb+allpass CORE: sample-accurate AudioWorklet (default, no +128 loop latency)
    // when the module registered, else the native-node graph (graceful fallback).
    const core = (this._reverbWorkletReady === true)
      ? this._buildWorkletCore(inGain, wetGain, initialChar)
      : this._buildNativeCore(inGain, wetGain);

    wetGain.connect(this.masterGain);
    this.reverbBus = Object.assign({ input, predelay, hipass, inGain, wetGain }, core);
    return this.reverbBus;
  }

  /**
   * Comb+allpass core as a single sample-accurate AudioWorklet (`pfa-freeverb`). No
   * DelayNode feedback cycles ⇒ no render-quantum (+128) latency ⇒ the allpass
   * diffusers stay diffusers (no fixed metallic resonance). Initial character is set
   * via parameterData (correct from sample 0); later switches go through the k-rate
   * AudioParams in _applyReverbCharacter. @private @returns {{worklet:AudioWorkletNode}}
   */
  _buildWorkletCore(inGain, wetGain, initialChar) {
    const ctx = this.ctx;
    const c = initialChar || _REVERB_DEFAULTS;
    const worklet = new AudioWorkletNode(ctx, 'pfa-freeverb', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      parameterData: {
        room_size: (c.room_size != null) ? c.room_size : _REVERB_DEFAULTS.room_size,
        decay: (c.decay != null) ? c.decay : _REVERB_DEFAULTS.decay,
        damping: (c.damping != null) ? c.damping : _REVERB_DEFAULTS.damping,
        spread: (c.spread != null) ? c.spread : _REVERB_DEFAULTS.spread,
      },
    });
    inGain.connect(worklet);
    worklet.connect(wetGain);
    return { worklet };
  }

  /**
   * Comb+allpass core as native nodes (8 LBCF combs + 4 series allpass ×2 channels).
   * Fallback for when AudioWorklet is unavailable (insecure context / blocked Blob /
   * old browser). Carries the +128 per-loop latency that colors the tail — accepted
   * as graceful degradation; the worklet core is the default. @private
   */
  _buildNativeCore(inGain, wetGain) {
    const ctx = this.ctx;
    const combSumL = ctx.createGain();
    const combSumR = ctx.createGain();
    const combsL = [], combsR = [];
    const d0 = _reverbDampingCoef(_REVERB_DEFAULTS.damping);
    for (let i = 0; i < _FREEVERB.comb.length; i++) {
      combsL.push(this._buildComb(inGain, combSumL, d0));
      combsR.push(this._buildComb(inGain, combSumR, d0));
    }
    // 4 series allpass diffusers per channel.
    let nodeL = combSumL, nodeR = combSumR;
    const apL = [], apR = [];
    for (let i = 0; i < _FREEVERB.allpass.length; i++) {
      const aL = this._buildAllpass(nodeL); apL.push(aL); nodeL = aL.out;
      const aR = this._buildAllpass(nodeR); apR.push(aR); nodeR = aR.out;
    }
    const merger = ctx.createChannelMerger(2);
    nodeL.connect(merger, 0, 0);
    nodeR.connect(merger, 0, 1);
    merger.connect(wetGain);
    return { combsL, combsR, apL, apR, merger };
  }

  /**
   * Register the Freeverb AudioWorklet module once (idempotent, cached). Resolves the
   * usable flag: true ⇒ worklet core; false ⇒ native fallback (insecure context, no
   * AudioWorklet, blocked Blob/CSP). Awaited from the async load path BEFORE the bus
   * is built so _ensureReverbBus can pick the core synchronously. @private
   * @returns {Promise<boolean>}
   */
  async _ensureReverbWorkletModule() {
    if (this._reverbWorkletReady != null) return this._reverbWorkletReady;
    if (!this.ctx || !this.ctx.audioWorklet ||
        typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      this._reverbWorkletReady = false;
      return false;
    }
    try {
      if (!this._reverbWorkletPromise) {
        const url = URL.createObjectURL(new Blob([_REVERB_WORKLET_SRC], { type: 'application/javascript' }));
        this._reverbWorkletPromise = Promise.resolve(this.ctx.audioWorklet.addModule(url))
          .finally(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } });
      }
      await this._reverbWorkletPromise;
      this._reverbWorkletReady = true;
    } catch (e) {
      console.warn('[PFA] reverb AudioWorklet unavailable — using native-node fallback', e);
      this._reverbWorkletReady = false;
    }
    return this._reverbWorkletReady;
  }

  /**
   * Lowpass-feedback comb filter (Freeverb LBCF) from native nodes:
   *   combIn (= source + feedback) → delay → destSum (output tap)
   *   delay → damp (lowpass) → fb (gain) → combIn   [feedback loop, valid: has a DelayNode]
   * delayTime / fb.gain / damp.frequency are set per zone in _applyReverbCharacter.
   * @private
   */
  _buildComb(source, destSum, dampCoef) {
    const ctx = this.ctx;
    const combIn = ctx.createGain();
    const delay = ctx.createDelay(1.0);
    const damp = this._makeOnePole(dampCoef);
    const fb = ctx.createGain();
    fb.gain.value = 0;
    source.connect(combIn);
    combIn.connect(delay);
    delay.connect(destSum);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(combIn);
    return { combIn, delay, damp, fb, dampCoef };
  }

  /**
   * One-pole lowpass `y = (1-d)·x + d·y[n-1]` as an IIRFilterNode — the Freeverb
   * damping filter. Gain ≤ 1 at every frequency (no overshoot), so it is safe
   * inside the comb feedback loop. Coefficients are FIXED at construction (IIR
   * nodes are not automatable) → changing damping rebuilds the node (_setCombDamping).
   * @private
   */
  _makeOnePole(dampCoef) {
    const d = Math.max(0, Math.min(0.95, dampCoef || 0));
    return this.ctx.createIIRFilter([1 - d], [1, -d]);
  }

  /**
   * Swap a comb's damping one-pole to a new coefficient (zone switch). The IIR
   * node can't be automated, so disconnect the old one (keeping delay→destSum and
   * the feedback gain intact) and splice in a fresh one. Rare (per zone change).
   * @private
   */
  _setCombDamping(comb, dampCoef) {
    if (comb.dampCoef === dampCoef) return;
    try { comb.delay.disconnect(comb.damp); } catch (e) { /* already gone */ }
    try { comb.damp.disconnect(); } catch (e) { /* already gone */ }
    const damp = this._makeOnePole(dampCoef);
    comb.delay.connect(damp);
    damp.connect(comb.fb);
    comb.damp = damp;
    comb.dampCoef = dampCoef;
  }

  /**
   * Schroeder allpass diffuser from native nodes (feedback 0.5):
   *   out      = −x + bufout
   *   buffer   =  x + bufout·fb        (bufout = delayed buffer)
   * @private
   */
  _buildAllpass(source) {
    const ctx = this.ctx;
    const apIn = ctx.createGain();
    const delaySum = ctx.createGain();
    const delay = ctx.createDelay(1.0);
    const fbGain = ctx.createGain();
    fbGain.gain.value = _FREEVERB.allpassFeedback;
    const neg = ctx.createGain();
    neg.gain.value = -1;
    const out = ctx.createGain();
    source.connect(apIn);
    apIn.connect(delaySum);
    delaySum.connect(delay);
    delay.connect(fbGain);
    fbGain.connect(delaySum);
    apIn.connect(neg);
    neg.connect(out);
    delay.connect(out);
    return { apIn, delaySum, delay, fbGain, neg, out };
  }

  /**
   * Apply a resolved zone character to the bus IMMEDIATELY (matches Godot: only
   * `wet` ramps on a zone switch; geometry/tone snap). room_size scales the comb
   * delay lengths (spaciousness); decay sets each comb's feedback for a real RT60;
   * damping = honest darkening; spread offsets the right channel; predelay/hipass
   * are plain pre-network stages. @private
   */
  _applyReverbCharacter(char) {
    const bus = this.reverbBus;
    if (!bus) return;
    const now = this._now();
    const set = (param, value) => {
      param.cancelScheduledValues(now);
      param.setValueAtTime(value, now);
    };
    // predelay + hipass are native pre-stages on BOTH paths (plain delay / filter,
    // not inside a feedback cycle → no +128 issue).
    set(bus.predelay.delayTime, Math.max(0, Math.min(0.5, (char.predelay_ms || 0) / 1000)));
    set(bus.hipass.frequency, _reverbHipassCutoff(char.hipass));

    // Worklet core: set the processor's AudioParams (k-rate; reliable + synchronous,
    // unlike a port message). The processor recomputes its comb/allpass delays, feedback
    // and damping from these. Character snaps immediately (like Godot).
    if (bus.worklet) {
      const setP = (name, v) => {
        const p = bus.worklet.parameters.get(name);
        if (p) { p.cancelScheduledValues(now); p.setValueAtTime(v, now); }
      };
      setP('room_size', Math.max(0, Math.min(1, char.room_size)));
      setP('decay', Math.max(0.05, char.decay));
      setP('damping', Math.max(0, Math.min(1, char.damping)));
      setP('spread', Math.max(0, Math.min(1, char.spread)));
      return;
    }

    // Native fallback core: set each comb/allpass node directly.
    const roomSize = Math.max(0, Math.min(1, char.room_size));
    const sizeScale = 0.5 + roomSize;                       // 0.5 .. 1.5
    const spread = Math.max(0, Math.min(1, char.spread));
    const spreadSamples = Math.round(_FREEVERB.spread * spread);
    const decay = Math.max(0.05, char.decay);
    const dampCoef = _reverbDampingCoef(char.damping);

    for (let i = 0; i < _FREEVERB.comb.length; i++) {
      const base = _FREEVERB.comb[i];
      const lSec = (base / _FREEVERB.refRate) * sizeScale;
      const rSec = ((base + spreadSamples) / _FREEVERB.refRate) * sizeScale;
      set(bus.combsL[i].delay.delayTime, lSec);
      set(bus.combsR[i].delay.delayTime, rSec);
      set(bus.combsL[i].fb.gain, _reverbCombFeedback(lSec, decay));
      set(bus.combsR[i].fb.gain, _reverbCombFeedback(rSec, decay));
      this._setCombDamping(bus.combsL[i], dampCoef);
      this._setCombDamping(bus.combsR[i], dampCoef);
    }
    for (let i = 0; i < _FREEVERB.allpass.length; i++) {
      const base = _FREEVERB.allpass[i];
      set(bus.apL[i].delay.delayTime, base / _FREEVERB.refRate);
      set(bus.apR[i].delay.delayTime, (base + spreadSamples) / _FREEVERB.refRate);
    }
  }

  /**
   * Switch the active reverb zone. Character (size/decay/damping/spread/predelay/
   * hipass) snaps immediately; only the wet mix ramps over `fade` (linear, mirrors
   * Godot's set_active_zone). name null/''/unknown ⇒ fully dry (wet→0). No-op if
   * no reverb bus was built.
   * @param {string|null} name - zone name, or null/'' for dry
   * @param {Object} [opts] - { fade: seconds (default 0.5) }
   */
  setReverbZone(name, opts = {}) {
    if (!this.reverbBus) return;
    const fade = (opts && opts.fade != null) ? opts.fade : 0.5;
    let targetWet = 0;
    const zoneName = (name != null) ? String(name) : '';
    if (zoneName && this.reverbZones && this.reverbZones[zoneName]) {
      const char = this.reverbZones[zoneName];
      this._applyReverbCharacter(char);
      targetWet = Math.max(0, Math.min(1, char.wet));
      this.activeReverbZone = zoneName;
    } else {
      this.activeReverbZone = '';
    }
    const wp = this.reverbBus.wetGain.gain;
    const now = this._now();
    wp.cancelScheduledValues(now);
    if (fade <= 0 || !this.ctx) {
      wp.setValueAtTime(targetWet, now);
    } else {
      wp.setValueAtTime(wp.value, now);
      wp.linearRampToValueAtTime(targetWet, now + fade);
    }
  }

  /** @returns {string} the active reverb zone name ('' = dry / no bus). */
  getReverbZone() {
    return this.activeReverbZone || '';
  }

  /**
   * Web has no positional area-reverb (Godot-only: Area3D + per-zone bus). Stub
   * kept for cross-platform API symmetry; returns null. Use setReverbZone for the
   * global swap the web path supports. @returns {null}
   */
  createReverbZone() {
    return null;
  }

  /** Tear down the reverb bus + every per-event send (reload-safe). @private */
  _freeReverbBus() {
    for (const name of Object.keys(this.events || {})) {
      const ev = this.events[name];
      if (ev && ev._reverbSend) {
        try { ev._reverbSend.disconnect(); } catch (e) { /* already gone */ }
        ev._reverbSend = null;
      }
    }
    if (this.reverbBus) {
      try { this.reverbBus.input.disconnect(); } catch (e) { /* already gone */ }
      try { this.reverbBus.wetGain.disconnect(); } catch (e) { /* already gone */ }
      if (this.reverbBus.worklet) {
        try { this.reverbBus.worklet.disconnect(); } catch (e) { /* already gone */ }
      }
      this.reverbBus = null;
    }
  }

  /**
   * Load audio pack from config.json.
   * @param {string} configUrl - URL to config.json
   * @returns {Promise<boolean>}
   */
  async loadPack(configUrl) {
    if (!this.ctx) this.init();

    try {
      const response = await fetch(configUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.config = await response.json();
    } catch (e) {
      console.error(`[PFA] Failed to load config: ${configUrl}`, e);
      return false;
    }

    this.basePath = configUrl.substring(0, configUrl.lastIndexOf('/'));

    // Parse groups
    this.groups = {};
    for (const groupData of (this.config.groups || [])) {
      this.groups[groupData.name] = new PFAGroup(groupData);
    }

    // Parse events
    this.events = {};
    const eventsData = this.config.events || {};
    for (const eventName of Object.keys(eventsData)) {
      const eventData = eventsData[eventName];
      const event = new PFAEvent(eventName, eventData, this);
      this.events[eventName] = event;

      // Link group volume
      for (const groupName of Object.keys(this.groups)) {
        if (this.groups[groupName].eventNames.includes(eventName)) {
          event.groupGain = this.groups[groupName].volume;
          break;
        }
      }
    }

    // Reverb (opt-in): register the sample-accurate Freeverb worklet (Blob URL) first,
    // then build the send-bus from config.reverb_zones. The worklet is the default core;
    // if registration fails the bus falls back to native nodes (still functional).
    if (this.config && this.config.reverb_zones && this.config.reverb_zones.zones) {
      await this._ensureReverbWorkletModule();
    }
    this._loadReverbZones();

    this.loaded = true;
    console.log(`[PFA] Loaded: ${Object.keys(this.events).length} events, ${Object.keys(this.groups).length} groups`);
    return true;
  }

  /**
   * Load audio pack from a .pfabank binary bank file.
   * Single fetch replaces config.json + N audio file fetches.
   * @param {string} bankUrl - URL to .pfabank file
   * @returns {Promise<boolean>}
   */
  async loadBank(bankUrl) {
    if (!this.ctx) this.init();

    let buffer;
    try {
      const response = await fetch(bankUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffer = await response.arrayBuffer();
    } catch (e) {
      console.error(`[PFA] Failed to fetch bank: ${bankUrl}`, e);
      return false;
    }

    const view = new DataView(buffer);

    // Validate magic "PFABANK\0"
    const magic = new Uint8Array(buffer, 0, 8);
    const expected = [0x50, 0x46, 0x41, 0x42, 0x41, 0x4E, 0x4B, 0x00]; // "PFABANK\0"
    for (let i = 0; i < 8; i++) {
      if (magic[i] !== expected[i]) {
        console.error('[PFA] Invalid bank magic bytes');
        return false;
      }
    }

    // Read header
    const verMajor = view.getUint16(8, true);
    if (verMajor !== 1) {
      console.error(`[PFA] Unsupported bank version: ${verMajor}`);
      return false;
    }

    const sectionDirOff = Number(view.getBigUint64(36, true));
    const sectionCount = view.getUint32(44, true);
    const sectionEntrySize = view.getUint32(48, true);

    // Parse section directory
    let jsonOffset = 0, jsonLength = 0;
    let dataOffset = 0;

    for (let i = 0; i < sectionCount; i++) {
      const entryOff = sectionDirOff + i * sectionEntrySize;
      const typeBytes = new Uint8Array(buffer, entryOff, 4);
      const type = String.fromCharCode(...typeBytes);
      const secOffset = Number(view.getBigUint64(entryOff + 8, true));
      const secLength = Number(view.getBigUint64(entryOff + 16, true));

      if (type === 'JSON') {
        jsonOffset = secOffset;
        jsonLength = secLength;
      } else if (type === 'DATA') {
        dataOffset = secOffset;
      }
    }

    if (!jsonOffset) {
      console.error('[PFA] Bank has no JSON section');
      return false;
    }

    // Extract and parse JSON config
    const jsonBytes = new Uint8Array(buffer, jsonOffset, jsonLength);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    this.config = JSON.parse(jsonStr);

    // Store bank data for on-demand slicing
    this._bankBuffer = buffer;
    this._bankDataOffset = dataOffset;
    this._bankEntries = this.config._audio_entries || {};
    this._bankMode = true;
    delete this.config._audio_entries;

    // Parse groups (same as loadPack)
    this.groups = {};
    for (const groupData of (this.config.groups || [])) {
      this.groups[groupData.name] = new PFAGroup(groupData);
    }

    // Parse events (same as loadPack)
    this.events = {};
    const eventsData = this.config.events || {};
    for (const eventName of Object.keys(eventsData)) {
      const eventData = eventsData[eventName];
      const event = new PFAEvent(eventName, eventData, this);
      this.events[eventName] = event;

      for (const groupName of Object.keys(this.groups)) {
        if (this.groups[groupName].eventNames.includes(eventName)) {
          event.groupGain = this.groups[groupName].volume;
          break;
        }
      }
    }

    // Reverb (opt-in): register the sample-accurate Freeverb worklet (Blob URL) first,
    // then build the send-bus from config.reverb_zones. The worklet is the default core;
    // if registration fails the bus falls back to native nodes (still functional).
    if (this.config && this.config.reverb_zones && this.config.reverb_zones.zones) {
      await this._ensureReverbWorkletModule();
    }
    this._loadReverbZones();

    this.loaded = true;
    const bankSizeMB = (buffer.byteLength / (1024 * 1024)).toFixed(1);
    console.log(`[PFA] Bank loaded: ${bankSizeMB} MB, ${Object.keys(this.events).length} events, ${Object.keys(this._bankEntries).length} audio files`);
    return true;
  }

  /**
   * Get compressed audio ArrayBuffer for a file path.
   * Returns a COPY suitable for decodeAudioData (which detaches the buffer).
   * Stores the original compressed bytes in _assetStore for future re-decode.
   * @param {string} filePath - relative audio path (e.g. "music/foo.ogg")
   * @returns {Promise<ArrayBuffer>}
   * @private
   */
  async _getAudioBuffer(filePath) {
    // Already in asset store — return a copy (decodeAudioData detaches)
    if (this._assetStore[filePath]) {
      return this._assetStore[filePath].slice(0);
    }

    // Fetch compressed bytes
    let raw;
    if (this._bankMode && this._bankEntries[filePath]) {
      const entry = this._bankEntries[filePath];
      const absOffset = this._bankDataOffset + entry.offset;
      raw = this._bankBuffer.slice(absOffset, absOffset + entry.length);
    } else {
      const url = `${this.basePath}/${filePath}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      raw = await response.arrayBuffer();
    }

    // Store compressed bytes for future re-decode (LRU eviction + re-load)
    this._assetStore[filePath] = raw;

    // Return a copy for decodeAudioData
    return raw.slice(0);
  }

  /**
   * Release the raw bank buffer after all compressed bytes are in _assetStore.
   * Call after preloadAll() or loadBuffers() to free the master bank ArrayBuffer.
   * Compressed bytes remain available in _assetStore for re-decode.
   */
  releaseBankBuffer() {
    this._bankBuffer = null;
    console.log('[PFA] Bank buffer released (compressed bytes retained in asset store)');
  }

  // ── Decode Cache + LRU Memory Management ─────────────────────────────

  /**
   * Decode an audio file with caching. Returns cached AudioBuffer if available,
   * otherwise decodes from compressed bytes in _assetStore.
   * @param {string} filePath - relative audio path
   * @returns {Promise<AudioBuffer>}
   * @private
   */
  async _decodeWithCache(filePath) {
    // Cache hit — touch LRU and return
    if (this._decodeCache[filePath]) {
      this._touchLRU(filePath);
      return this._decodeCache[filePath];
    }

    // Decode from compressed bytes
    const raw = await this._getAudioBuffer(filePath);
    const audioBuffer = await this.ctx.decodeAudioData(raw);

    // Store in decode cache
    const pcmBytes = audioBuffer.length * audioBuffer.numberOfChannels * 4; // Float32
    this._decodeCache[filePath] = audioBuffer;
    this._decodedBytes += pcmBytes;
    this._decodeLRU.push(filePath);

    // Evict oldest if over budget
    this._evictLRU();

    return audioBuffer;
  }

  /**
   * Move a file to the end of the LRU list (most recently used).
   * @private
   */
  _touchLRU(filePath) {
    const idx = this._decodeLRU.indexOf(filePath);
    if (idx >= 0) this._decodeLRU.splice(idx, 1);
    this._decodeLRU.push(filePath);
  }

  /**
   * Evict oldest decoded AudioBuffers until under memory budget.
   * Never evicts files used by currently playing events.
   * @private
   */
  _evictLRU() {
    let safetyCounter = this._decodeLRU.length;
    while (this._decodedBytes > this._memoryBudgetBytes && this._decodeLRU.length > 0 && safetyCounter-- > 0) {
      const oldest = this._decodeLRU[0];

      // Don't evict files used by currently playing events
      if (this._isFileInUse(oldest)) {
        // Rotate: move to end, try next
        this._decodeLRU.shift();
        this._decodeLRU.push(oldest);
        continue;
      }

      this._decodeLRU.shift();
      const buf = this._decodeCache[oldest];
      if (buf) {
        this._decodedBytes -= buf.length * buf.numberOfChannels * 4;
        delete this._decodeCache[oldest];
      }
    }
  }

  /**
   * Check if a file is referenced by any currently playing event.
   * @param {string} filePath
   * @returns {boolean}
   * @private
   */
  _isFileInUse(filePath) {
    for (const event of Object.values(this.events)) {
      if (!event.isPlaying) continue;
      for (const track of event.tracks) {
        if (track.sharedSampleFiles.includes(filePath)) return true;
        for (const lvl of Object.keys(track.levelSamples)) {
          if (track.levelSamples[lvl].files.includes(filePath)) return true;
        }
      }
      // Check sub-level tracks
      for (const sub of Object.values(event._subLevelTracks)) {
        for (const track of sub.tracks) {
          if (track.sharedSampleFiles.includes(filePath)) return true;
          for (const lvl of Object.keys(track.levelSamples)) {
            if (track.levelSamples[lvl].files.includes(filePath)) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Set memory budget for decoded audio (PCM). LRU eviction kicks in above this.
   * Default: Infinity (no eviction — backward compatible).
   * @param {number} mb - Budget in megabytes
   */
  setMemoryBudget(mb) {
    this._memoryBudgetBytes = mb * 1024 * 1024;
    console.log(`[PFA] Memory budget set: ${mb} MB`);
    // Immediately evict if already over budget
    this._evictLRU();
  }

  /**
   * Get current memory usage statistics.
   * @returns {{ compressedMB: string, decodedMB: string, budgetMB: string, cachedFiles: number, storedFiles: number }}
   */
  getMemoryStats() {
    const compressedBytes = Object.values(this._assetStore)
      .reduce((sum, buf) => sum + buf.byteLength, 0);
    const platformBudget = this._getPlatformBudget();
    const ratio = this._decodedBytes / platformBudget;
    const zone = ratio < 0.5 ? 'FREE' : ratio < 0.75 ? 'MANAGED' : 'AGGRESSIVE';
    return {
      zone,
      platform: this._isMobile() ? 'mobile' : 'desktop',
      compressedMB: (compressedBytes / (1024 * 1024)).toFixed(1),
      decodedMB: (this._decodedBytes / (1024 * 1024)).toFixed(1),
      budgetMB: this._memoryBudgetBytes === Infinity ? 'Infinity' : (this._memoryBudgetBytes / (1024 * 1024)).toFixed(1),
      platformBudgetMB: (platformBudget / (1024 * 1024)).toFixed(0),
      usage: (ratio * 100).toFixed(0) + '%',
      cachedFiles: Object.keys(this._decodeCache).length,
      storedFiles: Object.keys(this._assetStore).length,
    };
  }

  /**
   * Preload audio buffers for an event.
   * @param {string} eventName
   * @returns {Promise<void>}
   */
  async preload(eventName) {
    const event = this._getEvent(eventName);
    if (!event) return;
    await event.loadBuffers();
  }

  /**
   * Preload all events in a group.
   * @param {string} groupName
   * @returns {Promise<void>}
   */
  async preloadGroup(groupName) {
    const group = this.groups[groupName];
    if (!group) {
      console.warn(`[PFA] Group not found: ${groupName}`);
      return;
    }
    await Promise.all(group.eventNames.map(name => this.preload(name)));
  }

  /**
   * Preload ALL events with bounded concurrency and progress reporting.
   * Call after loadPack() to decode all audio buffers before gameplay.
   *
   * @param {Object} [options]
   * @param {Function} [options.onProgress] - Called with (loaded, total) after each event
   * @param {number}   [options.concurrency] - Max parallel decodes (default: auto-detect)
   * @param {string}   [options.priority]    - 'sfx_first' (default) | 'music_first' | 'none'
   * @returns {Promise<{loaded: number, failed: string[]}>}
   */
  async preloadAll(options = {}) {
    if (!this.loaded) {
      console.warn('[PFA] preloadAll: no pack loaded yet');
      return { loaded: 0, failed: [] };
    }

    const {
      onProgress = null,
      concurrency = this._detectConcurrency(),
      priority = 'sfx_first',
    } = options;

    // Build ordered event list
    const eventNames = Object.keys(this.events);
    let ordered;
    if (priority === 'sfx_first') {
      const sfx = eventNames.filter(n => this.events[n].type === 'sfx');
      const rest = eventNames.filter(n => this.events[n].type !== 'sfx');
      ordered = [...sfx, ...rest];
    } else if (priority === 'music_first') {
      const music = eventNames.filter(n => this.events[n].type === 'music');
      const rest = eventNames.filter(n => this.events[n].type !== 'music');
      ordered = [...music, ...rest];
    } else {
      ordered = eventNames;
    }

    const total = ordered.length;
    let loaded = 0;
    const failed = [];

    // Bounded concurrency queue
    let cursor = 0;
    const workers = [];

    const decodeNext = async () => {
      while (cursor < total) {
        const idx = cursor++;
        const name = ordered[idx];
        try {
          await this.preload(name);
        } catch (e) {
          console.warn(`[PFA] preloadAll: failed to decode "${name}"`, e);
          failed.push(name);
        }
        loaded++;
        onProgress?.(loaded, total);

        // Yield to browser every 2 events to avoid jank
        if (loaded % 2 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
    };

    for (let i = 0; i < Math.min(concurrency, total); i++) {
      workers.push(decodeNext());
    }
    await Promise.all(workers);

    console.log(`[PFA] preloadAll complete: ${loaded - failed.length}/${total} OK` +
      (failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''));

    // Auto-detect memory strategy based on total decoded size vs platform limits
    if (this._memoryBudgetBytes === Infinity) {
      this.autoManageMemory();
    }

    return { loaded: loaded - failed.length, failed };
  }

  /**
   * Auto-detect decode concurrency based on device capabilities.
   * @returns {number}
   * @private
   */
  _detectConcurrency() {
    if (typeof navigator === 'undefined') return 3;
    const cores = navigator.hardwareConcurrency || 2;
    // Mobile heuristic: small screen or touch-primary
    const isMobile = (typeof matchMedia !== 'undefined' &&
      matchMedia('(pointer: coarse)').matches) || cores <= 4;
    return isMobile ? 2 : Math.min(cores, 6);
  }

  /**
   * Detect if running on a mobile device.
   * @returns {boolean}
   * @private
   */
  _isMobile() {
    if (typeof navigator === 'undefined') return false;
    const cores = navigator.hardwareConcurrency || 2;
    return (typeof matchMedia !== 'undefined' &&
      matchMedia('(pointer: coarse)').matches) || cores <= 4;
  }

  /**
   * Get platform audio memory budget in bytes.
   * Conservative: 50% of estimated tab memory limit, reserved for audio.
   * @returns {number}
   * @private
   */
  _getPlatformBudget() {
    // iOS Safari ~300MB, Android Chrome ~512MB, Desktop ~2GB+
    // We take ~50% for audio to leave room for game (textures, JS, DOM)
    return this._isMobile() ? 150 * 1024 * 1024 : 500 * 1024 * 1024;
  }

  /**
   * Estimate total PCM size for all loaded events (without decoding).
   * Uses file count and average assumptions: stereo, 44.1kHz, Float32.
   * After preloadAll, uses actual decoded sizes from _decodeCache.
   * @returns {number} estimated PCM bytes
   * @private
   */
  _estimateTotalPCM() {
    // If we have actual decoded data, use real numbers
    if (this._decodedBytes > 0) return this._decodedBytes;

    // Estimate from compressed file sizes (expansion ratio ~20x for OGG/MP3)
    let compressedTotal = 0;
    // From asset store (already fetched)
    for (const buf of Object.values(this._assetStore)) {
      compressedTotal += buf.byteLength;
    }
    // If asset store is empty, estimate from bank entries
    if (compressedTotal === 0 && this._bankEntries) {
      for (const entry of Object.values(this._bankEntries)) {
        compressedTotal += entry.length;
      }
    }
    return compressedTotal * 20; // ~20x expansion ratio
  }

  /**
   * Auto-detect and apply memory management strategy based on audio size vs platform limits.
   * Called automatically after preloadAll() or can be called manually.
   *
   * Zones (% of platform audio budget):
   *   🟢 FREE       (< 50%):  Decode all, no eviction
   *   🟡 MANAGED    (50-75%): LRU active, evict inactive events
   *   🔴 AGGRESSIVE (> 75%):  Strict LRU, only active events in PCM
   *
   * @returns {{ zone: string, totalPCM_MB: string, budget_MB: string, strategy: string }}
   */
  autoManageMemory() {
    const platformBudget = this._getPlatformBudget();
    const totalPCM = this._estimateTotalPCM();
    const ratio = totalPCM / platformBudget;
    const platform = this._isMobile() ? 'mobile' : 'desktop';

    let zone, strategy;

    if (ratio < 0.5) {
      // 🟢 FREE — everything fits, no management needed
      zone = 'FREE';
      strategy = 'decode all';
      this._memoryBudgetBytes = Infinity;
    } else if (ratio < 0.75) {
      // 🟡 MANAGED — LRU with generous budget
      zone = 'MANAGED';
      strategy = 'LRU active';
      this._memoryBudgetBytes = platformBudget * 0.75;
    } else {
      // 🔴 AGGRESSIVE — strict LRU, minimal PCM
      zone = 'AGGRESSIVE';
      strategy = 'strict LRU';
      this._memoryBudgetBytes = platformBudget * 0.5;
      console.warn(`[PFA] ⚠ Audio exceeds 75% of ${platform} budget. Strict LRU enabled. ` +
        `Consider reducing audio assets or using shorter tracks.`);
    }

    // Trigger eviction if needed
    this._evictLRU();

    const result = {
      zone,
      platform,
      totalPCM_MB: (totalPCM / (1024 * 1024)).toFixed(1),
      budget_MB: (platformBudget / (1024 * 1024)).toFixed(1),
      memoryLimit_MB: this._memoryBudgetBytes === Infinity ? 'Infinity' : (this._memoryBudgetBytes / (1024 * 1024)).toFixed(1),
      ratio: (ratio * 100).toFixed(0) + '%',
      strategy,
    };

    console.log(`[PFA] Memory: ${result.zone} zone (${result.ratio} of ${platform} budget ${result.budget_MB}MB). Strategy: ${strategy}`);
    return result;
  }

  /**
   * Play a music event (looped). Stops other music events.
   * @param {string} eventName
   */
  async play(eventName) {
    const event = this._getEvent(eventName);
    if (!event) return;

    if (event.type === 'sfx') {
      this.trigger(eventName);
      return;
    }

    // Stop other music
    for (const name of Object.keys(this.events)) {
      const e = this.events[name];
      if (e.type === 'music' && e.isPlaying && name !== eventName) {
        e.stop();
        this.onEventStopped?.(name);
      }
    }

    if (!event.buffersLoaded) await event.loadBuffers();
    event.play();
    this.onEventStarted?.(eventName);

    // Notify node if in node mode
    if (event.useNodes && event.currentNode) {
      const node = event.nodeGraph.nodes[event.currentNode];
      this.onNodeChanged?.(eventName, event.currentNode, node?.name);
    }
  }

  /**
   * Crossfade from current music to another event.
   * @param {string} eventName
   * @param {number} duration - Fade time in seconds
   */
  async crossfadeTo(eventName, duration = 2.0) {
    const newEvent = this._getEvent(eventName);
    if (!newEvent || newEvent.type !== 'music') return;

    // Find current playing music
    for (const name of Object.keys(this.events)) {
      const e = this.events[name];
      if (e.type === 'music' && e.isPlaying && name !== eventName) {
        e.fadeOut(duration);
        break;
      }
    }

    if (!newEvent.buffersLoaded) await newEvent.loadBuffers();
    newEvent.fadeIn(duration);
    newEvent.play();
    this.onEventStarted?.(eventName);
  }

  /**
   * Stop an event. The fade is resolved from the event's authored `release_fade`
   * (FMOD AHDSR-release / Wwise Stop fade) unless `fadeTime` is given, in which
   * case it is a per-call OVERRIDE (Wwise-style). Either way, duration 0 → an
   * immediate stop (the engine keeps its ~20ms anti-click floor). Back-compat:
   * an event with no authored release_fade defaults to {0}, so `stop(name)` with
   * no arg stops immediately exactly as before.
   * @param {string} eventName
   * @param {number} [fadeTime] - Optional fade-time override (seconds). Omit to
   *                              use the event's release_fade; 0 = immediate.
   */
  stop(eventName, fadeTime) {
    const event = this._getEvent(eventName);
    if (!event) return;

    // Explicit arg overrides; otherwise fall back to the event's release_fade.
    const rf = event.releaseFade || {};
    const dur = (fadeTime !== undefined && fadeTime !== null) ? fadeTime : (rf.duration ?? 0);
    const curve = rf.curve ?? 'equal_power';

    if (dur > 0) {
      event.fadeOut(dur, curve);
    } else {
      event.stop();
    }
    this.onEventStopped?.(eventName);
  }

  /**
   * Stop an event honoring the current node's `terminal_fade` metadata (Transition
   * Kinds v2 — dangling fade_out at graph end, flattened by the exporter onto the
   * source node). Falls back to plain `fadeOut(defaultFade)` if no terminal_fade
   * is authored.
   * @param {string} eventName
   * @param {number} [defaultFade] - seconds, used when no terminal_fade is set
   */
  stopTerminal(eventName, defaultFade = 2.0) {
    const event = this._getEvent(eventName);
    if (!event) return;
    if (!event.stopWithTerminalFade()) {
      event.fadeOut(defaultFade);
    }
    this.onEventStopped?.(eventName);
  }

  /**
   * Stop all events.
   * @param {number} fadeTime
   */
  stopAll(fadeTime = 0) {
    for (const name of Object.keys(this.events)) {
      this.stop(name, fadeTime);
    }
    // Stop spatial voices but keep emitters alive (they belong to game objects).
    // Smart-loop controllers must stop here too: their timers outlive the voices
    // and re-spawn from event/track refs captured at trigger time — across a
    // Live Connect reload that resurrects the OLD pack as a zombie ambience.
    this._emitters.forEach(em => {
      (em._smartLoops || []).forEach(c => { c.stopped = true; if (c.timer) clearTimeout(c.timer); });
      em._smartLoops = [];
    });
    const fadeMs = fadeTime * 1000;
    this._spatialVoices.forEach(v => v.stop(fadeMs));
    this._spatialVoices = [];
  }

  /**
   * Trigger a one-shot SFX event.
   * @param {string} eventName
   */
  async trigger(eventName, options) {
    const event = this._getEvent(eventName);
    if (!event) return [];

    if (!event.buffersLoaded) await event.loadBuffers();
    // Per-trigger intensity / velocity (0..1) — like a MIDI note. The authored
    // event.intensity curve maps it to a per-voice gain + pitch offset. Omitted ⇒
    // full-strength (1.0). Disabled event ⇒ ignored.
    const intensity = (options && options.intensity != null) ? options.intensity : undefined;
    const played = event.trigger(intensity);
    this.onSfxTriggered?.(eventName, played);
    return played;
  }

  /**
   * Set the adaptive level for an event (Simple mode).
   * @param {string} eventName
   * @param {number} level
   */
  setLevel(eventName, level) {
    const event = this._getEvent(eventName);
    if (!event) return;
    event.setLevel(level);
    this.onLevelChanged?.(eventName, level);
  }

  /**
   * Navigate to a node via trigger (Advanced/Node mode).
   * Finds matching transition from current node and executes it.
   * @param {string} eventName
   * @param {string} trigger - Trigger name to match
   * @returns {boolean} - True if a matching transition was found
   */
  navigate(eventName, trigger) {
    const event = this._getEvent(eventName);
    if (!event) return false;

    const result = event.navigate(trigger);
    if (result && event.currentNode) {
      const node = event.nodeGraph.nodes[event.currentNode];
      this.onNodeChanged?.(eventName, event.currentNode, node?.name);
    }
    return result;
  }

  /**
   * Toggle a sub-level (layer) on or off.
   * @param {string} eventName
   * @param {string} subLevelName - Name of the sub-level
   * @param {boolean} enabled - True to enable, false to disable
   * @param {number} fadeDuration - Fade time in seconds
   */
  toggleSubLevel(eventName, subLevelName, enabled, fadeDuration = 0.5) {
    const event = this._getEvent(eventName);
    if (!event) return;
    event.toggleSubLevel(subLevelName, enabled, fadeDuration);
    this.onSubLevelToggled?.(eventName, subLevelName, enabled);
  }

  /**
   * Get current node ID for an event (Advanced mode).
   * @param {string} eventName
   * @returns {string|null}
   */
  getCurrentNode(eventName) {
    const event = this._getEvent(eventName);
    return event ? event.currentNode : null;
  }

  /**
   * Get current level of an event.
   * @param {string} eventName
   * @returns {number}
   */
  getLevel(eventName) {
    const event = this._getEvent(eventName);
    return event ? event.currentLevel : 0;
  }

  /**
   * Set event volume.
   * @param {string} eventName
   * @param {number} volume - Linear (0.0 - 1.0+)
   */
  setEventVolume(eventName, volume) {
    const event = this._getEvent(eventName);
    if (event) event.setVolume(volume);
  }

  /**
   * Set group volume.
   * @param {string} groupName
   * @param {number} volume
   */
  setGroupVolume(groupName, volume) {
    const group = this.groups[groupName];
    if (!group) return;
    group.volume = volume;
    for (const name of group.eventNames) {
      const event = this.events[name];
      if (!event) continue;
      event.groupGain = volume;
      // Playing voices (music tracks and spatial voices alike) hang off
      // _eventGain and never re-read groupGain — re-apply it now or the live
      // fader only affects future plays. Ducked members re-target
      // duckLevel×groupGain instead: live mute rides duck(0), so a group
      // fader move must not lift an active duck.
      if (!event._eventGain) continue;
      if (event._isDucked) {
        const duckLevel = event._duckLevel !== undefined ? event._duckLevel : 0.0;
        event._tweenEventGain(Math.max(0.0001, duckLevel * volume), 0.05, 'linear');
      } else {
        event._updateGain();
      }
    }
  }

  /**
   * Set master volume.
   * @param {number} volume - Linear (0.0 - 1.0+)
   */
  setMasterVolume(volume) {
    this._masterVolume = volume;
    if (this.masterGain) {
      this.masterGain.gain.setValueAtTime(volume, this._now());
    }
  }

  /**
   * Duck an event's volume (e.g., for popups, dialogue).
   * @param {string} eventName
   * @param {number} level - Target volume (0.0 = silence, 0.3 = -10dB)
   * @param {number} fade - Fade duration in seconds
   */
  duck(eventName, level = 0.0, fade = 0.5) {
    const event = this._getEvent(eventName);
    if (!event) return;
    event._preDuckVolume = event.volume;
    event._isDucked = true;
    event._duckLevel = level;
    if (event._eventGain && this.ctx) {
      event._tweenEventGain(Math.max(0.0001, level * event.groupGain), fade, 'linear');
    }
  }

  /**
   * Restore event volume after duck.
   * @param {string} eventName
   * @param {number} fade - Fade duration in seconds
   */
  unduck(eventName, fade = 0.5) {
    const event = this._getEvent(eventName);
    if (!event || !event._isDucked) return;
    event._isDucked = false;
    const targetVol = (event._preDuckVolume !== undefined ? event._preDuckVolume : event.volume) * event.groupGain;
    if (event._eventGain && this.ctx) {
      event._tweenEventGain(targetVol, fade, 'linear');
    }
  }

  /**
   * Duck master output (affects everything).
   * @param {number} level - Target volume (0.0 = silence)
   * @param {number} fade - Fade duration in seconds
   */
  duckMaster(level = 0.0, fade = 0.5) {
    if (!this.masterGain || !this.ctx) return;
    this._masterDucked = true;
    this.masterGain.gain.cancelScheduledValues(this._now());
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this._now());
    this.masterGain.gain.linearRampToValueAtTime(Math.max(0.0001, level), this._now() + fade);
  }

  /**
   * Restore master volume after duck.
   * @param {number} fade - Fade duration in seconds
   */
  unduckMaster(fade = 0.5) {
    if (!this.masterGain || !this.ctx) return;
    this._masterDucked = false;
    const vol = this._masterVolume !== undefined ? this._masterVolume : 1.0;
    this.masterGain.gain.cancelScheduledValues(this._now());
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this._now());
    this.masterGain.gain.linearRampToValueAtTime(vol, this._now() + fade);
  }

  /**
   * Check if an event is playing.
   * @param {string} eventName
   * @returns {boolean}
   */
  isPlaying(eventName) {
    const event = this._getEvent(eventName);
    return event ? event.isPlaying : false;
  }

  /**
   * Get all event names.
   * @returns {string[]}
   */
  getEventNames() {
    return Object.keys(this.events);
  }

  /**
   * Get all group names.
   * @returns {string[]}
   */
  getGroupNames() {
    return Object.keys(this.groups);
  }

  /**
   * Resume audio context (required after user gesture on some browsers).
   */
  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /**
   * Get current time with safety buffer to prevent race conditions.
   * @returns {number}
   * @private
   */
  _now() {
    return this.ctx ? this.ctx.currentTime + 0.005 : 0;
  }

  /** @private */
  _getEvent(name) {
    if (!(name in this.events)) {
      console.warn(`[PFA] Event not found: ${name}`);
      return null;
    }
    return this.events[name];
  }

  // ── Spatial Audio API ────────────────────────────────────────────

  /**
   * Set world scale: how many game units equal 1 audio unit.
   * Example: setWorldScale(100) means 100 pixels = 1 audio meter.
   * @param {number} unitsPerMeter
   */
  setWorldScale(unitsPerMeter) {
    this._worldScale = unitsPerMeter || 1.0;
  }

  /**
   * Set 2D listener position. Call every frame.
   * @param {number} x - world X
   * @param {number} y - world Y
   */
  setListener2D(x, y) {
    this._listenerPos.x = x;
    this._listenerPos.y = y;
    this._listenerPos.z = 0;
    this._listenerMode = '2D';
    this._updateSpatialVoices();
  }

  /**
   * Set 3D listener position and orientation. Call every frame.
   * Coordinate system: right-handed, +X right, +Y up, -Z forward.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} [fwdX=0] - forward vector X
   * @param {number} [fwdY=0] - forward vector Y
   * @param {number} [fwdZ=-1] - forward vector Z
   * @param {number} [upX=0] - up vector X
   * @param {number} [upY=1] - up vector Y
   * @param {number} [upZ=0] - up vector Z
   */
  setListener3D(x, y, z, fwdX = 0, fwdY = 0, fwdZ = -1, upX = 0, upY = 1, upZ = 0) {
    this._listenerPos.x = x;
    this._listenerPos.y = y;
    this._listenerPos.z = z;
    this._listenerMode = '3D';

    if (this.ctx) {
      const listener = this.ctx.listener;
      const s = this._worldScale;
      // Use AudioParam API with fallback to deprecated setters (Firefox compat)
      if (listener.positionX) {
        listener.positionX.value = x / s;
        listener.positionY.value = y / s;
        listener.positionZ.value = z / s;
        listener.forwardX.value = fwdX;
        listener.forwardY.value = fwdY;
        listener.forwardZ.value = fwdZ;
        listener.upX.value = upX;
        listener.upY.value = upY;
        listener.upZ.value = upZ;
      } else {
        listener.setPosition(x / s, y / s, z / s);
        listener.setOrientation(fwdX, fwdY, fwdZ, upX, upY, upZ);
      }
    }

    this._updateSpatialVoices();
  }

  /**
   * Trigger a spatial SFX at a world position. One-shot, no emitter needed.
   * @param {string} eventName
   * @param {number} x - world X
   * @param {number} y - world Y
   * @param {number} [z] - world Z (omit for 2D)
   * @param {Object} [config] - spatial overrides: { mode, attenuation, panningModel, maxPan }
   * @param {PFASpatialEmitter} [emitter] - owning emitter (links ALL of a multi-track
   *   event's voices to it so they track its position + stop on destroy()).
   * @returns {PFASpatialVoice|null}
   */
  async triggerSpatial(eventName, x, y, z, config, emitter = null) {
    // Handle optional z: if z is an object, it's the config
    if (typeof z === 'object' && z !== null) {
      config = z;
      z = undefined;
    }

    const event = this._getEvent(eventName);
    if (!event) return null;

    if (!event.buffersLoaded) await event.loadBuffers();
    if (!event._checkCanTrigger()) return null;

    event._ensureGain();
    event._eventGain.gain.cancelScheduledValues(0);
    event._eventGain.gain.setValueAtTime(event.volume * event.groupGain, this._now());

    const cfg = _mergeSpatialConfig(config, _eventSpatialToCfg(event.spatial));
    // Per-trigger intensity / velocity (0..1) — the game passes it in the config
    // dict (config.intensity); the authored event.intensity curve maps it to a
    // per-voice gain + pitch offset. Constant for a loop's lifetime → resolved once.
    const iv = _intensityToGainPitch(config && config.intensity, event.intensity);
    const is3D = cfg.mode === '3D' && z != null;
    const pos = { x, y, z: z || 0 };
    // Spatial release: a no-arg voice.stop() / emitter.destroy() falls back to the
    // event's authored release_fade (HOW lives in the editor, not the game).
    // 0 ⇒ instant (unchanged default for events without an authored release).
    const releaseMs = (event.releaseFade && event.releaseFade.duration > 0)
      ? event.releaseFade.duration * 1000 : 0;

    // Smart loop on an EMITTER → a persistent per-track controller that rolls
    // play_chance EVERY cycle (intermittent ambience: a failed roll = a silent
    // slot). Without an emitter (no owner) smart falls back to the voice-chained
    // re-loop in _spawnSpatialVoice (always-plays). Seamless / one-shot spawn directly.
    const smartLoop = !!(emitter && event.loop && event.loop.enabled && event.loop.mode === 'smart');
    const voices = [];
    for (const track of event.tracks) {
      if (smartLoop) {
        const ctrl = this._startSmartLoop(event, track, cfg, is3D, releaseMs, emitter, event.currentLevel, iv);
        if (ctrl && ctrl.active) voices.push(ctrl.active);
      } else {
        const voice = this._spawnSpatialVoice(event, track, pos, cfg, is3D, releaseMs, emitter, false, iv);
        if (voice) voices.push(voice);
      }
    }

    if (this.onSfxTriggered) this.onSfxTriggered(eventName);
    return voices.length > 0 ? voices[0] : null;
  }

  /**
   * @private Build ONE spatial voice for a track at `pos`: wires the panner chain
   * (3D PannerNode / 2D StereoPanner + distance gain), registers it, links it to
   * `emitter` (so all of a multi-track event's voices track + stop with the
   * emitter), and — for a 'smart' loop — schedules the re-trigger. Shared by the
   * initial triggerSpatial and the smart re-loop. Returns the voice or null.
   * @param {boolean} [skipPlayChance=false] - forwarded to triggerSfxSpatial; the
   *   re-loop skips the play_chance roll so the loop never gaps.
   */
  _spawnSpatialVoice(event, track, pos, cfg, is3D, releaseMs, emitter, skipPlayChance = false, iv = null) {
    const result = track.triggerSfxSpatial(event.currentLevel, skipPlayChance, iv);
    if (!result) return null;
    const { source, voiceGain, track: trackRef, loopMode, clipLen, target } = result;
    let pannerNode, distanceGain, lpfNode;

    if (is3D) {
      // 3D: PannerNode handles panning + distance natively
      pannerNode = this.ctx.createPanner();
      pannerNode.panningModel = cfg.panningModel;
      pannerNode.distanceModel = cfg.attenuation.model === 'exponential' ? 'exponential'
        : cfg.attenuation.model === 'linear' ? 'linear' : 'inverse';
      pannerNode.refDistance = cfg.attenuation.minDistance;
      pannerNode.maxDistance = cfg.attenuation.maxDistance;
      pannerNode.rolloffFactor = cfg.attenuation.rolloff;

      const s = this._worldScale;
      pannerNode.positionX.value = pos.x / s;
      pannerNode.positionY.value = pos.y / s;
      pannerNode.positionZ.value = pos.z / s;

      // Distance LPF (Godot parity): a highshelf BEFORE the panner whose
      // negative gain deepens with distance — db = (1 − min(1, att)) × lpfDb,
      // exactly Godot's attenuation filter. Driven per frame in
      // _updateSpatialVoices; seeded from the spawn distance so the first
      // frame is already correct. Off ⇒ no node at all (zero cost).
      if (cfg.lpfEnabled && cfg.lpfDb < 0 && this.ctx.createBiquadFilter) {
        lpfNode = this.ctx.createBiquadFilter();
        lpfNode.type = 'highshelf';
        lpfNode.frequency.value = cfg.lpfCutoffHz;
        const d0 = Math.hypot((pos.x - this._listenerPos.x) / s,
          (pos.y - this._listenerPos.y) / s, (pos.z - this._listenerPos.z) / s);
        lpfNode.gain.value =
          _distanceLpfDb(_computeDistanceAttenuation(d0, cfg.attenuation), cfg.lpfDb);
        voiceGain.connect(lpfNode);
        lpfNode.connect(pannerNode);
      } else {
        voiceGain.connect(pannerNode);
      }
      pannerNode.connect(event._eventGain);
    } else {
      // 2D: StereoPannerNode + manual distance attenuation
      pannerNode = this.ctx.createStereoPanner();
      distanceGain = this.ctx.createGain();

      const dist = _distance2D(this._listenerPos.x, this._listenerPos.y, pos.x, pos.y, this._worldScale);
      const att = _computeDistanceAttenuation(dist, cfg.attenuation);
      const pan = _computePan2D(this._listenerPos.x, pos.x, cfg.attenuation.maxDistance, this._worldScale) * cfg.maxPan;

      pannerNode.pan.setValueAtTime(pan, this._now());
      distanceGain.gain.setValueAtTime(att, this._now());

      voiceGain.connect(pannerNode);
      pannerNode.connect(distanceGain);
      distanceGain.connect(event._eventGain);
    }

    const voice = new PFASpatialVoice(
      this._nextSpatialId++, source, pannerNode, distanceGain, voiceGain,
      emitter || null, is3D ? '3D' : '2D', { x: pos.x, y: pos.y, z: pos.z || 0 }, cfg, trackRef, releaseMs
    );
    voice._target = target;
    voice._clipLen = clipLen;
    voice._lpf = lpfNode || null;
    this._spatialVoices.push(voice);
    event._activeVoices.push({ stop: () => voice.stop(), isActive: () => voice.isPlaying() });

    // Smart loop WITHOUT an emitter → voice-chained re-loop (always-plays; no
    // per-cycle play_chance). WITH an emitter, triggerSpatial drives the persistent
    // _startSmartLoop controller instead, so don't double-schedule here.
    if (loopMode === 'smart' && clipLen > 0 && !emitter) {
      this._scheduleSmartReloop(voice, event, track, cfg, is3D, releaseMs, emitter, iv);
    }
    return voice;
  }

  /**
   * @private Smart loop: re-trigger `track` one clip-cycle later so a fresh
   * variation + randomization is picked, equal-power-crossfading the new voice in
   * and the current one out. Each spawned voice chains the next; the chain ends
   * when the voice is stopped (emitter.destroy / explicit stop clears the timer).
   */
  _scheduleSmartReloop(voice, event, track, cfg, is3D, releaseMs, emitter, iv = null) {
    const CROSS = 0.08; // 80 ms crossfade seam
    const period = Math.max(0.05, (voice._clipLen || 0) - CROSS) * 1000;
    voice._reloopTimer = setTimeout(() => {
      voice._reloopTimer = null;
      if (!voice.isPlaying()) return; // stopped / destroyed before the boundary
      // Live position: the emitter (if it moved) or this voice's fixed spot.
      const src = (emitter && !emitter._destroyed) ? emitter._pos : voice._pos;
      // skipPlayChance=true: the re-loop always produces the next voice (no gap).
      const next = this._spawnSpatialVoice(event, track,
        { x: src.x, y: src.y, z: src.z }, cfg, is3D, releaseMs, emitter, true, iv);
      if (!next) return; // buffer vanished — let the current voice finish out
      // Crossfade: new voice 0→target, old voice →0 then stop after the seam.
      const now = this._now();
      const tgt = next._target != null ? next._target : 1.0;
      next._voiceGain.gain.cancelScheduledValues(now);
      next._voiceGain.gain.setValueAtTime(0, now);
      next._voiceGain.gain.linearRampToValueAtTime(tgt, now + CROSS);
      voice.stop(CROSS * 1000);
    }, period);
  }

  /**
   * @private Smart loop on an emitter — a PERSISTENT controller that, every clip
   * cycle, rolls play_chance: pass → spawn the next (switched) variation and
   * crossfade it in over the previous; fail → a SILENT slot (the prior one-shot
   * voice finishes out). This is what makes play_chance audible on a loop
   * (intermittent ambience). The FIRST cycle always plays (so the ambience starts);
   * later cycles roll. Lives on `emitter._smartLoops`, stopped by emitter.destroy().
   */
  _startSmartLoop(event, track, cfg, is3D, releaseMs, emitter, level, iv = null) {
    const CROSS = 0.08;
    const ctrl = { stopped: false, timer: null, active: null, lastClipLen: 1.0, first: true };
    const tick = () => {
      ctrl.timer = null;
      if (ctrl.stopped || (emitter && emitter._destroyed)) return;
      // First cycle always plays; later cycles roll play_chance per cycle.
      const play = ctrl.first || track._rollPlayChance(level);
      ctrl.first = false;
      if (play) {
        const p = emitter._pos;
        // skipPlayChance=true: the controller already made the play/silent decision.
        const next = this._spawnSpatialVoice(event, track,
          { x: p.x, y: p.y, z: p.z }, cfg, is3D, releaseMs, emitter, true, iv);
        if (next) {
          ctrl.lastClipLen = next._clipLen || ctrl.lastClipLen;
          const now = this._now();
          const tgt = next._target != null ? next._target : 1.0;
          next._voiceGain.gain.cancelScheduledValues(now);
          next._voiceGain.gain.setValueAtTime(0, now);
          next._voiceGain.gain.linearRampToValueAtTime(tgt, now + CROSS);
          if (ctrl.active && ctrl.active.isPlaying()) ctrl.active.stop(CROSS * 1000);
          ctrl.active = next;
        }
      } else {
        // Silent slot — the previous one-shot voice finishes out naturally.
        ctrl.active = null;
      }
      // Next slot = one clip length (the last PLAYED clip sets the rhythm).
      ctrl.timer = setTimeout(tick, Math.max(0.05, ctrl.lastClipLen - CROSS) * 1000);
    };
    (emitter._smartLoops || (emitter._smartLoops = [])).push(ctrl);
    tick(); // first cycle now
    return ctrl;
  }

  /**
   * Create a long-lived spatial emitter for moving objects.
   * @param {Object} [config] - { mode, attenuation, panningModel, maxPan }
   * @returns {PFASpatialEmitter}
   */
  createEmitter(config) {
    const emitter = new PFASpatialEmitter(this._nextSpatialId++, this, config);
    this._emitters.push(emitter);
    return emitter;
  }

  /** @private - Update all active spatial voices (called from setListener*) */
  _updateSpatialVoices() {
    const lx = this._listenerPos.x;
    const ly = this._listenerPos.y;
    const lz = this._listenerPos.z;
    const s = this._worldScale;

    // Frame delta + listener velocity (audio units/s) for Doppler. The game's
    // per-frame setListener* call IS the engine's update tick (same contract the
    // emitter-follow above relies on). dt outside (0, 0.5s] ⇒ stale (first call /
    // tab suspend / paused clock) ⇒ skip doppler this frame, just reseed.
    const now = this._now();
    let dt = 0;
    const lisVel = { x: 0, y: 0, z: 0 };
    const lp = this._listenerPrev;
    if (lp) {
      const d = now - lp.t;
      if (d > 0 && d <= 0.5) {
        dt = d;
        lisVel.x = (lx - lp.x) / s / dt;
        lisVel.y = (ly - lp.y) / s / dt;
        lisVel.z = (lz - lp.z) / s / dt;
      }
    }
    this._listenerPrev = { x: lx, y: ly, z: lz, t: now };

    // Clean up finished voices and update active ones
    this._spatialVoices = this._spatialVoices.filter(voice => {
      if (!voice.isPlaying()) {
        voice._cleanup();
        return false;
      }

      // If attached to emitter, read emitter position
      if (voice._emitter && !voice._emitter._destroyed) {
        voice._pos.x = voice._emitter._pos.x;
        voice._pos.y = voice._emitter._pos.y;
        voice._pos.z = voice._emitter._pos.z;
      }

      // Update audio nodes
      if (voice._mode === '2D' && voice._distanceGain) {
        const dist = _distance2D(lx, ly, voice._pos.x, voice._pos.y, s);
        const att = _computeDistanceAttenuation(dist, voice._cfg.attenuation);
        const pan = _computePan2D(lx, voice._pos.x, voice._cfg.attenuation.maxDistance, s) * voice._cfg.maxPan;
        voice._pannerNode.pan.setValueAtTime(pan, this._now());
        voice._distanceGain.gain.setValueAtTime(att, this._now());
      } else if (voice._mode === '3D' && voice._pannerNode.positionX) {
        voice._pannerNode.positionX.value = voice._pos.x / s;
        voice._pannerNode.positionY.value = voice._pos.y / s;
        voice._pannerNode.positionZ.value = voice._pos.z / s;
      }

      // Distance LPF (3D): retarget the highshelf gain from the live distance —
      // the same attenuation curve the panner plays, folded into filter dB the
      // Godot way. 50 ms smoothing kills frame-to-frame zipper (doppler pattern).
      if (voice._lpf) {
        const dist = Math.hypot((voice._pos.x - lx) / s,
          (voice._pos.y - ly) / s, (voice._pos.z - lz) / s);
        const db = _distanceLpfDb(
          _computeDistanceAttenuation(dist, voice._cfg.attenuation), voice._cfg.lpfDb);
        const gp = voice._lpf.gain;
        if (gp.setTargetAtTime) gp.setTargetAtTime(db, now, 0.05);
        else gp.value = db;
      }

      // Doppler (3D, opt-in via cfg.doppler > 0): pitch from the relative radial
      // source/listener velocity, multiplied ON TOP of the spawn-time playbackRate
      // (pitch/rate randomization). Velocities derive from per-frame position
      // deltas — works for emitters and fixed-pos voices alike (the latter just
      // contribute 0 source velocity while the LISTENER may still move past).
      const dopAmt = (voice._mode === '3D' && voice._cfg.doppler > 0) ? voice._cfg.doppler : 0;
      if (dopAmt > 0 && voice._source && voice._source.playbackRate) {
        const pp = voice._dopPrev;
        if (pp && dt > 0) {
          const srcVel = {
            x: (voice._pos.x - pp.x) / s / dt,
            y: (voice._pos.y - pp.y) / s / dt,
            z: (voice._pos.z - pp.z) / s / dt,
          };
          const ratio = _dopplerRatio(srcVel, lisVel, voice._pos,
            { x: lx, y: ly, z: lz }, dopAmt);
          const target = voice._basePlaybackRate * ratio;
          const pr = voice._source.playbackRate;
          // Short time-constant smoothing kills frame-to-frame zipper/jitter.
          if (pr.setTargetAtTime) pr.setTargetAtTime(target, now, 0.05);
          else pr.value = target;
        }
        if (pp) { pp.x = voice._pos.x; pp.y = voice._pos.y; pp.z = voice._pos.z; }
        else voice._dopPrev = { x: voice._pos.x, y: voice._pos.y, z: voice._pos.z };
      }

      return true;
    });
  }
}


/**
 * Internal: represents one event (music or sfx).
 */
class PFAEvent {
  constructor(name, data, engine) {
    this.name = name;
    this.engine = engine;
    this.type = data.type || 'music';
    this.volume = data.volume || 1.0;
    this.groupGain = 1.0;
    this.bpm = data.bpm || 120;
    this.timeSignature = data.time_signature || [4, 4];
    this.fadeDuration = data.fade_duration || 2.0;
    this.fadeCurve = data.fade_curve || 'equal_power';
    this.switchQuantization = data.switch_quantization || 'bar';
    // Per-event Start (play) / Release (stop) fades — FMOD AHDSR-release / Wwise
    // Stop-Action analog. DISTINCT from fadeDuration above (that is the LEVEL
    // crossfade). startFade applies on play()/entry — but a node-graph entry
    // fade_in marker OVERRIDES it (node > event, see play()); releaseFade applies
    // on stop(), overridable by the stop() `fade` arg. { duration: sec, curve }.
    // duration 0 = no musical fade (engine keeps its ~20ms anti-click floor).
    this.startFade = data.start_fade || { duration: 0.0, curve: 'equal_power' };
    this.releaseFade = data.release_fade || { duration: 0.0, curve: 'equal_power' };
    // Per-event SPATIAL attenuation authored in the editor (config.json `spatial`
    // block, snake_case). Read by triggerSpatial / emitter.trigger as the DEFAULT
    // spatial 'how'; a game-passed config still overrides. Absent/disabled ⇒ the
    // engine falls back to _SPATIAL_DEFAULTS (zero behaviour change). snake→camel
    // mapping in _eventSpatialToCfg.
    this.spatial = data.spatial || null;
    // Per-event REVERB send (editor-authored, config.json `reverb` block) —
    // { enabled, send:0..1 }. Opt-in routing of this event's post-_eventGain
    // signal into the global reverb send-bus (built from config.reverb_zones).
    // Effective wet ≈ send × activeZone.wet. Absent/disabled ⇒ dry on master
    // (zero behaviour change). Wired in _ensureReverbSend.
    this.reverb = data.reverb || null;
    // Per-event LOOP (SFX, editor-authored) — { enabled, mode:'seamless'|'smart' }.
    // Turns a triggered / emitter SFX into a sustained loop (campfire, wind, lamp).
    //   seamless — native gapless loop of one picked variation.
    //   smart    — re-trigger each clip cycle → switches variation + re-rolls
    //              randomization, equal-power-crossfaded (see _scheduleSmartReloop).
    // null/absent ⇒ unchanged one-shot. Read in triggerSfxSpatial via _parentEvent.
    this.loop = data.loop || null;
    // Per-event INTENSITY / velocity (editor-authored, config.json `intensity`
    // block) — { enabled, vol_db:[a,b], vol_curve, pitch_st:[a,b], pitch_curve }.
    // The game passes a normalized intensity 0..1 to trigger()/triggerSpatial();
    // this curve maps it to a per-voice gain + pitch offset over the random
    // variation. null/absent/disabled ⇒ no scaling (a bare trigger = full
    // strength). Read via _intensityToGainPitch in trigger / triggerSfxSpatial.
    this.intensity = data.intensity || null;
    this.cooldownMs = data.cooldown_ms || 0;
    this.maxInstances = data.max_instances || 8;
    this.levels = data.levels || [];
    this.currentLevel = 0;
    this.isPlaying = false;
    this.buffersLoaded = false;

    // Parse tracks
    this.tracks = [];
    for (const trackData of (data.tracks || [])) {
      const track = new PFATrack(trackData, engine);
      track._parentEvent = this;
      this.tracks.push(track);
    }

    // Node graph (Advanced mode)
    this.useNodes = data.use_nodes || false;
    this.nodeGraph = data.node_graph || null;
    this.currentNode = null;
    this._autoAdvanceTimer = null;
    this._pendingLevelSwitch = null;  // setTimeout ID for quantized setLevel
    this._pendingNodeTransition = null;  // setTimeout ID for quantized navigate
    // Transition Kinds v2: fade_out → deferred instant-switch timer. Nulled by any
    // new _applyNodeTransition so a superseded fade_out bails at timer timeout.
    this._pendingFadeOutSwitch = null;

    // Conductor (bar-counting scheduler for play_chance — FMOD/Wwise pattern)
    this._conductorTimer = null;    // setTimeout ID for next bar tick (chained)
    this._barCounter = 0;           // increments every bar from play() to stop()
    // Fabric model: one play_chance verdict per LEVEL — background levels keep
    // rerolling while inactive; entry reads the target level's live verdict.
    this._trackChanceState = {};    // { trackIdx: { level: { playing, lockedUntil, nextRerollBar } } }

    // Per-level phase anchor — used after restart_on_entry seeks players to 0.
    // _calcNextLoopBoundary uses this level's anchor (if set) as the bar cadence
    // origin so variation swaps land on the restarted loop's boundaries, not the
    // global event clock. Empty → global _playStartTime is used. Godot parity:
    // `_level_phase_anchors` (pfa_event.gd:110).
    this._levelPhaseAnchors = {};

    // Sub-levels
    this._subLevelData = data.sub_levels || {};
    this._subLevelTracks = {};  // { "levelIdx_subName": [PFATrack, ...] }
    this._subLevelStates = {}; // { "subName": { enabled, gain } }
    this._parseSubLevels(data);

    // SFX voice management
    this._activeVoices = [];
    this._lastTriggerTime = 0;

    // Fade state
    this._eventGain = null;
    // Reverb send tap off _eventGain (lazy; only when bus exists + opted in).
    this._reverbSend = null;
    // Playback start time (for syncing tracks)
    this._playStartTime = 0;
  }

  _parseSubLevels(data) {
    const subLevelsData = data.sub_levels || {};
    for (const levelIdx of Object.keys(subLevelsData)) {
      const subs = subLevelsData[levelIdx];
      for (const sub of subs) {
        const key = `${levelIdx}_${sub.name}`;
        const tracks = [];
        for (const trackData of (sub.tracks || [])) {
          tracks.push(new PFATrack(trackData, this.engine));
        }
        this._subLevelTracks[key] = {
          name: sub.name,
          levelIndex: parseInt(levelIdx),
          volume: sub.volume || 1.0,
          tracks: tracks,
        };
      }
    }
  }

  async loadBuffers() {
    if (this.buffersLoaded) return;
    // Load main track buffers
    await Promise.all(this.tracks.map(t => t.loadBuffers()));

    // Load sub-level track buffers
    const subLoadPromises = [];
    for (const key of Object.keys(this._subLevelTracks)) {
      const sub = this._subLevelTracks[key];
      for (const track of sub.tracks) {
        subLoadPromises.push(track.loadBuffers());
      }
    }
    await Promise.all(subLoadPromises);

    // Load stinger bundles from node graph connections.
    // v2 shape: connection.stinger is a Dictionary { samples, clips, volume, play_chance, mode }
    // (was: a single string path). Bundles are keyed by `${src}::${tgt}` so a stinger
    // node attached to N fade-nodes loads N independent bundles (1:N reuse) and each
    // fire site keeps independent no-repeat state.
    if (this.nodeGraph) {
      this._stingerBundles = {};
      const stingerPromises = [];
      for (const conn of (this.nodeGraph.connections || [])) {
        const sd = conn.stinger;
        if (sd && typeof sd === 'object' && Array.isArray(sd.samples) && sd.samples.length > 0) {
          const key = `${conn.source}::${conn.target}`;
          stingerPromises.push(this._loadStingerBundle(key, sd));
        }
      }
      await Promise.all(stingerPromises);
    }

    this.buffersLoaded = true;
  }

  /**
   * Release track buffer references so LRU can evict decoded AudioBuffers.
   * Compressed bytes remain in _assetStore for re-decode.
   */
  unloadBuffers() {
    for (const track of this.tracks) {
      track._sharedBuffers = [];
      track._buffers = {};
    }
    for (const sub of Object.values(this._subLevelTracks)) {
      for (const track of sub.tracks) {
        track._sharedBuffers = [];
        track._buffers = {};
      }
    }
    this._stingerBundles = {};
    this.buffersLoaded = false;
  }

  /**
   * Decode every sample in a stinger node's bundle and store under the connection key.
   * `stingerData` shape (from exported config.json):
   *   { samples: [path, ...], clips: [{volume, weight, ...}], volume, play_chance, mode }
   * Mirrors Godot _load_stinger_bundle (pfa_event.gd).
   */
  async _loadStingerBundle(connectionKey, stingerData) {
    const samples = Array.isArray(stingerData?.samples) ? stingerData.samples : [];
    if (samples.length === 0) return;
    const buffers = [];
    for (const path of samples) {
      try {
        const buf = await this.engine._decodeWithCache(path);
        if (buf) buffers.push(buf);
      } catch (e) {
        console.warn(`[PFA] Failed to load stinger sample: ${path}`, e);
      }
    }
    if (buffers.length === 0) return;
    this._stingerBundles[connectionKey] = {
      buffers,
      clips: Array.isArray(stingerData.clips) ? stingerData.clips : [],
      volume: Number(stingerData.volume ?? 1.0),
      playChance: Number(stingerData.play_chance ?? 100),
      mode: String(stingerData.mode ?? 'random'),
      state: { lastIdx: -1 },
    };
  }

  play() {
    // A fresh play supersedes any pending deferred teardown scheduled by a recent
    // stop() (see stop()): bump the generation so that stop's 25ms anti-click timer
    // — which re-reads the track's CURRENT sources at fire time — won't stop the
    // new sources this play() is about to create. play() already tears down the
    // prior sources synchronously (playMusic / prestartAllLevels both call
    // stopAll/stopAllLevels first), so the deferred teardown is only ever needed
    // when no replay follows. Mirrors FMOD/Wwise per-voice lifecycle: a new voice
    // supersedes the previous one's pending release.
    this._stopGen = (this._stopGen || 0) + 1;
    const wasAlreadyPlaying = this.isPlaying;
    this.isPlaying = true;
    this._ensureGain();

    const entryNodeId = (this.useNodes && this.nodeGraph) ? this.nodeGraph.entry_node : null;

    if (!wasAlreadyPlaying) {
      // Fresh start: anti-click event_gain ramp-up from silence (+ authored
      // entry_fade if the entry node carries one). On a re-press of Play we SKIP
      // this — resetting _eventGain to 0 mid-playback would create an audible
      // drop while the active level tries to crossfade. The normal transition
      // path below handles the audible ramp instead. Mirrors Godot
      // `start_playback` (pfa_event.gd:141).
      const now = this.engine._now();
      let entryFadeDur = 0.02;
      let entryFadeCurve = 'equal_power';
      if (entryNodeId && this.nodeGraph?.nodes?.[entryNodeId]?.entry_fade) {
        const ef = this.nodeGraph.nodes[entryNodeId].entry_fade;
        entryFadeDur = ef.fade_duration ?? 0.02;
        entryFadeCurve = ef.fade_curve ?? 'equal_power';
        console.log(`[PFA] Entry fade-in: ${entryFadeDur.toFixed(2)}s (${entryFadeCurve})`);
        const entryNode = this.nodeGraph.nodes[entryNodeId];
        this._emitTransitionInfo({
          phase: 'entry_fade',
          duration: entryFadeDur,
          curve: entryFadeCurve,
          to_node: entryNodeId,
          to_name: entryNode?.name ?? entryNodeId,
        });
      } else if (this.startFade && this.startFade.duration > 0) {
        // Per-event Start fade — Simple mode, or node mode with no entry fade_in
        // marker (node > event, mirrors editor `_event_start_fade_overridden`).
        // Reuses the fresh-start ramp below; only overrides its duration + curve.
        entryFadeDur = this.startFade.duration;
        entryFadeCurve = this.startFade.curve ?? 'equal_power';
        console.log(`[PFA] Start fade-in: ${entryFadeDur.toFixed(2)}s (${entryFadeCurve})`);
        this._emitTransitionInfo({
          phase: 'start_fade',
          duration: entryFadeDur,
          curve: entryFadeCurve,
        });
      }
      this._eventGain.gain.cancelScheduledValues(0);
      this._eventGain.gain.setValueAtTime(0.0001, now);
      _applyFadeCurve(this._eventGain.gain, 0.0001, this.volume * this.groupGain,
                       now, entryFadeDur, entryFadeCurve);
      this._playStartTime = now;
    }

    if (this.useNodes && this.nodeGraph) {
      if (entryNodeId) {
        // Re-press of Play: look up the authored (current → entry) connection so
        // its fade/curve/quantize/kind are used. Fresh start → first-node branch
        // in _enterNode handles empty fadeSettings.
        let fs = null;
        if (wasAlreadyPlaying && this.currentNode && this.currentNode !== entryNodeId) {
          fs = this._findConnectionFade(this.currentNode, entryNodeId);
        }
        this._enterNode(entryNodeId, fs);
      }
    } else {
      // Simple mode: pre-start all levels for level_specific tracks
      for (const track of this.tracks) {
        if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') {
          track.playMusic(this.currentLevel, this._eventGain, 0);
        } else {
          track.prestartAllLevels(this._eventGain, 0);
          track.activateLevel(this.currentLevel, 0);
        }
      }
    }

    // Start Conductor for play_chance only on fresh start — already ticking on re-play.
    if (this.type === 'music' && !wasAlreadyPlaying) {
      this._startConductor();
    }
  }

  stop() {
    this.isPlaying = false;
    // Reset node graph state so next play() starts fresh from entry_node
    this.currentNode = null;
    this.currentLevel = 0;
    // Cancel auto-advance
    if (this._autoAdvanceTimer) {
      clearTimeout(this._autoAdvanceTimer);
      this._autoAdvanceTimer = null;
    }
    // Cancel pending quantized transitions
    if (this._pendingLevelSwitch) {
      clearTimeout(this._pendingLevelSwitch);
      this._pendingLevelSwitch = null;
    }
    if (this._pendingNodeTransition) {
      clearTimeout(this._pendingNodeTransition);
      this._pendingNodeTransition = null;
    }
    if (this._pendingFadeOutSwitch) {
      clearTimeout(this._pendingFadeOutSwitch);
      this._pendingFadeOutSwitch = null;
    }
    // Stop conductor (play_chance bar timer)
    this._stopConductor();
    this._levelPhaseAnchors = {};
    // Cancel pending fadeOut timer
    if (this._fadeOutTimer) {
      clearTimeout(this._fadeOutTimer);
      this._fadeOutTimer = null;
    }
    // Anti-click: short fade-out (20ms) before stopping sources. Through the
    // guarded helper so a direct stop() mid-fade can't overlap an active curve.
    if (this._eventGain) {
      this._tweenEventGain(0.0001, 0.02, 'linear');
    }
    const tracks = this.tracks;
    const self = this;
    const stopGen = this._stopGen = (this._stopGen || 0) + 1;
    setTimeout(() => {
      // Skip if a newer play()/stop() superseded this teardown. Otherwise we'd
      // stop the sources a play() created inside the 25ms anti-click window — the
      // event would read isPlaying=true at full gain yet be silent (its fresh
      // AudioBufferSourceNodes already stopped). play() does its own synchronous
      // source teardown, so nothing leaks when we skip here.
      if (self._stopGen !== stopGen) return;
      for (const track of tracks) {
        track.stopAll();
        track.stopAllLevels();
      }
      self._stopAllSubLevels();
    }, 25);
  }

  /**
   * Check cooldown and max instances. Returns true if the event can trigger.
   * @returns {boolean}
   */
  _checkCanTrigger() {
    const now = performance.now();
    if (this.cooldownMs > 0 && (now - this._lastTriggerTime) < this.cooldownMs) {
      return false;
    }
    this._lastTriggerTime = now;

    this._cleanupVoices();
    if (this._activeVoices.length >= this.maxInstances) {
      const oldest = this._activeVoices.shift();
      oldest.stop();
    }
    return true;
  }

  trigger(intensity) {
    if (!this._checkCanTrigger()) return [];

    this._ensureGain();
    // SFX: set gain immediately (no anti-click needed for one-shots). cancel(0)
    // first so a prior fadeOut curve on this event can't trigger an overlap throw.
    this._eventGain.gain.cancelScheduledValues(0);
    this._eventGain.gain.setValueAtTime(this.volume * this.groupGain, this.engine._now());

    // Intensity / velocity → per-voice gain + pitch (over the random variation).
    // Computed ONCE here (the event owns the curve config); every track voice for
    // this trigger gets the same offset. Neutral {1, 0} when disabled/absent.
    const iv = _intensityToGainPitch(intensity, this.intensity);

    const played = [];
    for (const track of this.tracks) {
      const voice = track.triggerSfx(this.currentLevel, this._eventGain, iv);
      if (voice) {
        this._activeVoices.push(voice);
        played.push({
          track: voice.track, behavior: voice.behavior,
          variation: voice.variation, variationCount: voice.variationCount,
          algo: voice.algo, sample: voice.sample,
        });
      }
    }
    return played;
  }

  setLevel(level) {
    if (level < 0 || level >= this.levels.length) return;
    if (level === this.currentLevel) return;

    if (this.type === 'music' && this.isPlaying) {
      const quantize = this.switchQuantization || 'instant';
      const boundary = this._getQuantizedTime(quantize);

      if (boundary) {
        // Schedule delayed switch at next bar/beat boundary
        this._scheduleLevelSwitch(level, boundary);
      } else {
        // Instant — apply now
        const oldLevel = this.currentLevel;
        this.currentLevel = level;
        this._crossfadeLevel(oldLevel, level);
      }
    } else {
      this.currentLevel = level;
    }
  }

  _scheduleLevelSwitch(level, whenTime) {
    if (this._pendingLevelSwitch) clearTimeout(this._pendingLevelSwitch);
    const delay = (whenTime - this.engine.ctx.currentTime) * 1000;
    this._pendingLevelSwitch = setTimeout(() => {
      this._pendingLevelSwitch = null;
      if (!this.isPlaying) return;
      const oldLevel = this.currentLevel;
      this.currentLevel = level;
      this._crossfadeLevel(oldLevel, level);
      console.log(`[PFA] Quantized setLevel: ${oldLevel} → ${level}`);
    }, Math.max(0, delay));
  }

  /**
   * Navigate to a new node via trigger name.
   * @param {string} trigger
   * @returns {boolean}
   */
  navigate(trigger) {
    if (!this.useNodes || !this.nodeGraph || !this.currentNode) {
      console.warn(`[PFA] Event "${this.name}" is not in node mode`);
      return false;
    }

    // Find matching connections from current node
    const connections = this.nodeGraph.connections || [];
    const candidates = connections.filter(c =>
      c.source === this.currentNode &&
      c.conn_type === 'transition' &&
      c.trigger === trigger
    );

    if (candidates.length === 0) {
      // Fallback: find target node by trigger, use nearest outgoing fade.
      const nodes = this.nodeGraph.nodes || {};
      let targetId = null;
      for (const [id, n] of Object.entries(nodes)) {
        if (n.trigger === trigger) { targetId = id; break; }
      }
      if (!targetId) {
        console.warn(`[PFA] No transition with trigger "${trigger}" from node "${this.currentNode}" and no fallback target`);
        return false;
      }
      const outgoing = connections.filter(c =>
        c.source === this.currentNode && c.conn_type === 'transition'
      );
      const fallbackFade = outgoing.length > 0 ? {
        fade_duration: outgoing[0].fade_duration,
        fade_curve: outgoing[0].fade_curve,
        quantize: outgoing[0].quantize,
        kind: outgoing[0].kind ?? 'crossfade',
        fade_direction: outgoing[0].fade_direction ?? 'both',
        stinger: outgoing[0].stinger,
      } : {};
      if (outgoing.length > 0 && outgoing[0].entry_fade_duration != null) {
        fallbackFade.entry_fade_duration = outgoing[0].entry_fade_duration;
        fallbackFade.entry_fade_curve = outgoing[0].entry_fade_curve ?? 'equal_power';
      }
      this._enterNode(targetId, fallbackFade);
      return true;
    }

    // Sort by priority (highest first)
    candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Filter by probability
    let selected = null;
    for (const conn of candidates) {
      const prob = conn.probability !== undefined ? conn.probability : 100;
      if (Math.random() * 100 <= prob) {
        selected = conn;
        break;
      }
    }

    if (!selected) return false;

    this._executeTransition(selected);
    return true;
  }

  /**
   * Toggle a sub-level on or off.
   */
  toggleSubLevel(subName, enabled, fadeDuration = 0.5) {
    if (!this.isPlaying) return;

    const levelIdx = this.currentLevel;
    const key = `${levelIdx}_${subName}`;
    const sub = this._subLevelTracks[key];

    if (!sub) {
      console.warn(`[PFA] Sub-level "${subName}" not found for level ${levelIdx}`);
      return;
    }

    if (enabled) {
      this._enableSubLevel(sub, fadeDuration);
    } else {
      this._disableSubLevel(sub, subName, fadeDuration);
    }

    // Track state
    if (!this._subLevelStates[subName]) {
      this._subLevelStates[subName] = {};
    }
    this._subLevelStates[subName].enabled = enabled;
  }

  setVolume(vol) {
    this.volume = vol;
    this._updateGain();
  }

  /**
   * Single chokepoint for event-gain fades (JS parity with Godot
   * `_tween_event_gain`, pfa_event.gd:1847). Ramps the event gain to `target`
   * over `duration`, anchoring at the live value first so an interrupted fade
   * resumes smoothly (no click).
   *
   * `cancelScheduledValues(0)` is the load-bearing guard. Since v1.9.3 non-linear
   * fades render as `setValueCurveAtTime`; Web Audio throws NotSupportedError if
   * any later automation lands inside an active curve window. A rapid re-fade
   * (e.g. a game firing `stop(evt, 0.15)` twice within 0.15 s) would otherwise
   * throw out of `fadeOut` and halt the host loop. Cancelling from 0 wipes the
   * running curve (its startTime ≥ 0) under both the strict spec and patched
   * browsers — `cancelScheduledValues(now)` would NOT, since the curve's
   * startTime is < now. Read v0 BEFORE cancelling so the start value is the live
   * (possibly mid-fade) one.
   * @param {number} target - linear gain to ramp to
   * @param {number} duration
   * @param {string} curve
   * @param {?number} from - force the start value (fade-in passes 0.0001); null = read live
   */
  _tweenEventGain(target, duration, curve = 'equal_power', from = null) {
    if (!this._eventGain) return;
    const gain = this._eventGain.gain;
    // Anchor at ctx.currentTime with NO lookahead. A future anchor (now + Δ, the old
    // `_now()` +5ms) leaves a [now, anchor) gap that Web Audio renders at the gain's
    // INTRINSIC value — full for a playing event. So a stop()/anti-click fired at the
    // END of a fade-out (live value ≈ 0 but intrinsic ≈ full) would POP TO FULL for
    // those few ms: the death-music crossfade "прорвала громкость" click, confirmed via
    // OfflineAudioContext (peak 1.0 with the lookahead, ~0.04 without). cancelScheduledValues(0)
    // holds the live value across the audio thread's sub-quantum delay; read v0 BEFORE it.
    // Same no-gap rule as the level splice (PFATrack.activateLevel).
    const now = this.engine.ctx.currentTime;
    const v0 = from != null ? from : Math.max(0.0001, gain.value);
    gain.cancelScheduledValues(0);
    gain.setValueAtTime(v0, now);
    _applyFadeCurve(gain, v0, Math.max(0.0001, target), now, duration, curve);
  }

  fadeIn(duration, curve = 'equal_power') {
    this._ensureGain();
    this._tweenEventGain(this.volume * this.groupGain, duration, curve, 0.0001);
  }

  fadeOut(duration, curve = 'equal_power') {
    if (!this._eventGain) return;
    this._tweenEventGain(0.0001, duration, curve);

    if (this._fadeOutTimer) clearTimeout(this._fadeOutTimer);
    this._fadeOutTimer = setTimeout(() => {
      this._fadeOutTimer = null;
      if (this.isPlaying) this.stop();
    }, duration * 1000);
  }

  // ── Node Graph Internal ──

  /**
   * Resolve the authored fade settings on a graph connection so a caller that
   * navigates src → tgt can honor the composer's duration/curve/quantize/kind
   * rather than falling back to target node defaults. Godot parity:
   * `_find_connection_fade` (pfa_event.gd:207).
   */
  _findConnectionFade(src, tgt) {
    if (!src || !tgt || !this.nodeGraph) return {};
    for (const c of (this.nodeGraph.connections || [])) {
      if (c.source === src && c.target === tgt) {
        const out = {
          fade_duration: c.fade_duration ?? this.fadeDuration,
          fade_curve: c.fade_curve ?? this.fadeCurve,
          quantize: c.quantize ?? this.switchQuantization,
          kind: c.kind ?? 'crossfade',
          fade_direction: c.fade_direction ?? 'both',
          stinger: c.stinger,
        };
        // Phase 3 chain fields: exporter flattens fade_out→fade_in→tgt into
        // a single connection carrying both exit and entry fade settings.
        if (c.entry_fade_duration != null) {
          out.entry_fade_duration = c.entry_fade_duration;
          out.entry_fade_curve = c.entry_fade_curve ?? 'equal_power';
        }
        return out;
      }
    }
    return {};
  }

  /**
   * Fade out honoring the current node's `terminal_fade` metadata (Transition
   * Kinds v2 — dangling fade_out at graph end, exporter attaches it to the
   * source node). Returns true if a terminal fade was triggered; false means
   * caller should fall back to `fadeOut()` / `stop()`. Godot parity:
   * `stop_with_terminal_fade` (pfa_event.gd:375).
   */
  stopWithTerminalFade() {
    if (!this.isPlaying || !this.currentNode || !this.nodeGraph) return false;
    const node = this.nodeGraph.nodes?.[this.currentNode];
    const tf = node?.terminal_fade;
    if (!tf) return false;
    const dur = tf.fade_duration ?? 2.0;
    const curve = tf.fade_curve ?? 'equal_power';
    console.log(`[PFA] Terminal fade-out: ${dur.toFixed(2)}s (${curve}, node=${this.currentNode})`);
    this._emitTransitionInfo({
      phase: 'terminal_fade',
      duration: dur,
      curve,
      from_node: this.currentNode,
      from_name: node?.name ?? this.currentNode,
    });
    this.fadeOut(dur, curve);
    return true;
  }

  _resolveNodeName(nodeId) {
    if (!nodeId) return '(start)';
    const n = this.nodeGraph?.nodes?.[nodeId];
    return n?.name ?? nodeId;
  }

  _emitTransitionInfo(info) {
    this.engine.onTransitionInfo?.(this.name, info);
  }

  _enterNode(nodeId, fadeSettings) {
    if (!this.nodeGraph || !this.nodeGraph.nodes[nodeId]) {
      console.warn(`[PFA] Node not found: ${nodeId}`);
      return;
    }

    const node = this.nodeGraph.nodes[nodeId];
    const oldNode = this.currentNode;

    // Get the level index that this node maps to
    const targetLevel = node.level_index !== undefined ? node.level_index : 0;

    // Determine fade settings (from transition connection or node defaults)
    const fadeDuration = fadeSettings?.fade_duration ?? node.fade_duration ?? this.fadeDuration;
    const fadeCurve = fadeSettings?.fade_curve ?? node.fade_curve ?? this.fadeCurve;

    // Determine quantization (connection → node → event default)
    const quantize = fadeSettings?.quantize ?? node.fade_quantize ?? this.switchQuantization ?? 'instant';

    if (oldNode === null) {
      // First node — no quantization, apply immediately
      this.currentNode = nodeId;
      this.currentLevel = targetLevel;
      for (const track of this.tracks) {
        if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') {
          track.playMusic(targetLevel, this._eventGain, 0);
        } else {
          track.prestartAllLevels(this._eventGain, 0);
          track.activateLevel(targetLevel, 0);
        }
      }
      this._stopAllSubLevels();
      this._syncBarDurationToCurrentNode();
      this._scheduleAutoAdvance(node);
      console.log(`[PFA] Entered node "${node.name}" (${nodeId}), level=${targetLevel}`);
    } else {
      // Node transition — check quantization
      const boundary = this._getQuantizedTime(quantize);

      if (boundary) {
        // Schedule delayed transition
        this._scheduleNodeTransition(nodeId, node, targetLevel, fadeDuration, fadeSettings, boundary);
      } else {
        // Instant — apply now
        this._applyNodeTransition(nodeId, node, targetLevel, fadeDuration, fadeSettings);
      }
    }
  }

  /**
   * Dispatch on `fadeSettings.kind`: crossfade (default, two-way amp ramp) |
   * fade_in (OLD hard-cut with anti-click floor, NEW ramps 0→vol) | fade_out
   * (OLD ramps vol→0 over fd; at fade_end instant-switch to target). Mirrors
   * Godot `_apply_node_transition` (pfa_event.gd:490). terminal fade_out and
   * fade_out→fade_in chain not yet supported — exporter doesn't emit the
   * metadata yet; fade_out here always hard-switches at fade_end.
   */
  _applyNodeTransition(nodeId, node, targetLevel, fadeDuration, fadeSettings) {
    if (this._pendingFadeOutSwitch) {
      clearTimeout(this._pendingFadeOutSwitch);
      this._pendingFadeOutSwitch = null;
    }
    const fromNodeId = this.currentNode;
    const kind = fadeSettings?.kind ?? 'crossfade';
    switch (kind) {
      case 'fade_in':
        this._applyTransitionFadeIn(nodeId, node, targetLevel, fadeDuration, fadeSettings, fromNodeId);
        break;
      case 'fade_out':
        this._applyTransitionFadeOut(nodeId, node, targetLevel, fadeDuration, fadeSettings, fromNodeId);
        break;
      default:
        this._applyTransitionCrossfade(nodeId, node, targetLevel, fadeDuration, fadeSettings, fromNodeId);
    }
  }

  /**
   * Restart all level_specific tracks' sources at `level` from offset 0,
   * anchoring the level's phase to now. Mirrors Godot
   * `_restart_all_players_of_level` (pfa_event.gd:1382). Used when a node has
   * `restart_on_entry: true` so the clip plays fresh from the top on entry
   * rather than continuing from its pre-started phase.
   */
  _restartAllPlayersOfLevel(level) {
    this._levelPhaseAnchors[level] = this.engine._now();
    for (const track of this.tracks) {
      if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') continue;
      track._restartLevelSource(level);
    }
  }

  _applyTransitionCrossfade(nodeId, node, targetLevel, fd, fadeSettings, fromNodeId) {
    this.currentNode = nodeId;
    this.currentLevel = targetLevel;
    const curve = fadeSettings?.fade_curve ?? this.fadeCurve;
    for (const track of this.tracks) {
      if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') continue;
      track.activateLevel(targetLevel, fd, curve);
    }
    this._postTransitionCommon(nodeId, node, targetLevel, fadeSettings, 'crossfade', fd, fromNodeId);
  }

  _applyTransitionFadeIn(nodeId, node, targetLevel, fd, fadeSettings, fromNodeId) {
    this.currentNode = nodeId;
    this.currentLevel = targetLevel;
    const ANTI_CLICK = 0.01;
    const curve = fadeSettings?.fade_curve ?? this.fadeCurve;
    for (const track of this.tracks) {
      if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') continue;
      for (const lvlStr of Object.keys(track._levelGains)) {
        const lvl = parseInt(lvlStr);
        // Non-target levels silenced via anti-click floor (linear, not curve-shaped).
        if (lvl !== targetLevel) track._rampLevelGain(lvl, 0, ANTI_CLICK);
      }
      const passedChance = this._levelChanceVerdict(this.tracks.indexOf(track), targetLevel);
      const targetVol = passedChance ? track.volume : 0;
      track._rampLevelGain(targetLevel, targetVol, fd, curve);
      track._activeLevel = targetLevel;
    }
    this._postTransitionCommon(nodeId, node, targetLevel, fadeSettings, 'fade_in', fd, fromNodeId);
  }

  _applyTransitionFadeOut(nodeId, node, targetLevel, fd, fadeSettings, fromNodeId) {
    // Cancel auto-advance — it would fire mid-fade on the OLD node.
    if (this._autoAdvanceTimer) {
      clearTimeout(this._autoAdvanceTimer);
      this._autoAdvanceTimer = null;
    }
    const exitCurve = fadeSettings?.fade_curve ?? this.fadeCurve;
    // Phase 3 chain fields (exporter-flattened from fade_out→fade_in→target).
    // When present, NEW level ramps 0→volume over entryFd after the switch
    // instead of hard-cutting. Missing → classic hard-switch with anti-click.
    const entryFd = Number(fadeSettings?.entry_fade_duration ?? 0);
    const entryCurve = fadeSettings?.entry_fade_curve ?? 'equal_power';
    for (const track of this.tracks) {
      if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') continue;
      for (const lvlStr of Object.keys(track._levelGains)) {
        track._rampLevelGain(parseInt(lvlStr), 0, fd, exitCurve);
      }
    }
    const fromName = this._resolveNodeName(fromNodeId);
    const chainSuffix = entryFd > 0 ? ` + fade in ${entryFd.toFixed(2)}s (${entryCurve})` : '';
    console.log(`[PFA] Fade Out "${fromName}" → "${node.name}" over ${fd.toFixed(2)}s (${exitCurve})${chainSuffix}`);
    this._emitTransitionInfo({
      phase: 'fade_out_start',
      duration: fd,
      curve: exitCurve,
      entry_fade_duration: entryFd,
      entry_fade_curve: entryCurve,
      from_node: fromNodeId,
      from_name: fromName,
      to_node: nodeId,
      to_name: node.name ?? nodeId,
    });
    // Deferred switch after fade completes. 5ms buffer ensures ramps fully
    // resolved. Any new _applyNodeTransition nulls _pendingFadeOutSwitch
    // so a superseded fade_out bails at timer fire.
    this._pendingFadeOutSwitch = setTimeout(() => {
      if (this._pendingFadeOutSwitch == null) return;
      this._pendingFadeOutSwitch = null;
      if (!this.isPlaying) return;
      this.currentNode = nodeId;
      this.currentLevel = targetLevel;
      for (const track of this.tracks) {
        if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') continue;
        // entryFd=0 → hard-switch via anti-click (original behavior).
        // entryFd>0 → target level ramps up with entryCurve (chain).
        track.activateLevel(targetLevel, entryFd, entryCurve);
      }
      const label = entryFd > 0 ? 'fade_out/fade_in' : 'fade_out/switch';
      this._postTransitionCommon(nodeId, node, targetLevel, fadeSettings, label, entryFd, fromNodeId);
    }, (fd + 0.005) * 1000);
  }

  _postTransitionCommon(nodeId, node, targetLevel, fadeSettings, kindLabel, fd, fromNodeId) {
    // Stinger fires at the post-transition moment. Bundle was loaded under the
    // `${src}::${tgt}` connection key in loadBuffers(); we recompute the key here.
    if (fadeSettings?.stinger && fromNodeId) {
      this._playStinger(`${fromNodeId}::${nodeId}`);
    }
    if (node.restart_on_entry) {
      this._restartAllPlayersOfLevel(targetLevel);
    }
    this._stopAllSubLevels();
    this._syncBarDurationToCurrentNode();
    this._scheduleAutoAdvance(node);
    const fromName = this._resolveNodeName(fromNodeId);
    const direction = fadeSettings?.fade_direction ?? 'both';
    console.log(`[PFA] Entered node "${node.name}" (${nodeId}), level=${targetLevel}, kind=${kindLabel}, dir=${direction}, fd=${fd.toFixed(2)}s, from="${fromName}"`);
    if (this.engine.onNodeChanged) {
      this.engine.onNodeChanged(this.name, nodeId, node.name);
    }
    this._emitTransitionInfo({
      phase: 'transition',
      kind: kindLabel,
      direction,
      duration: fd,
      curve: fadeSettings?.fade_curve ?? this.fadeCurve,
      from_node: fromNodeId,
      from_name: fromName,
      to_node: nodeId,
      to_name: node.name ?? nodeId,
      level: targetLevel,
    });
  }

  _scheduleNodeTransition(nodeId, node, targetLevel, fadeDuration, fadeSettings, whenTime) {
    if (this._pendingNodeTransition) clearTimeout(this._pendingNodeTransition);
    const delay = (whenTime - this.engine.ctx.currentTime) * 1000;
    this._pendingNodeTransition = setTimeout(() => {
      this._pendingNodeTransition = null;
      if (!this.isPlaying) return;
      this._applyNodeTransition(nodeId, node, targetLevel, fadeDuration, fadeSettings);
      console.log(`[PFA] Quantized node transition applied`);
    }, Math.max(0, delay));
  }

  _executeTransition(connection) {
    const fs = {
      fade_duration: connection.fade_duration,
      fade_curve: connection.fade_curve,
      quantize: connection.quantize,
      stinger: connection.stinger,
      kind: connection.kind ?? 'crossfade',
      fade_direction: connection.fade_direction ?? 'both',
    };
    if (connection.entry_fade_duration != null) {
      fs.entry_fade_duration = connection.entry_fade_duration;
      fs.entry_fade_curve = connection.entry_fade_curve ?? 'equal_power';
    }
    this._enterNode(connection.target, fs);
  }

  // ── Conductor: bar-counting scheduler for play_chance (FMOD/Wwise pattern) ──
  // Single timer from play() to stop(). Never resets on navigate().
  // Evaluates play_chance at musical boundaries only.

  _startConductor() {
    if (this._conductorTimer) return; // already running

    const bpm = this.bpm;
    const beatsPerBar = this.timeSignature[0] || 4;
    this._barDurationSec = (60 / bpm) * beatsPerBar;
    this._barCounter = 0;

    // Initial roll for all tracks at bar 0
    this._initialPlayChanceRoll();

    // Sync bar duration to current node (may override event BPM via Tempo flatten).
    this._syncBarDurationToCurrentNode();
    this._scheduleNextBarTick();
  }

  /**
   * Chained setTimeout so each tick reads the current _barDurationSec. When a
   * node transition calls _syncBarDurationToCurrentNode and the bar duration
   * changes, the next tick uses the new rate. Godot parity:
   * `_schedule_next_bar_tick` (pfa_event.gd:871).
   */
  _scheduleNextBarTick() {
    if (!this.isPlaying) return;
    this._conductorTimer = setTimeout(() => {
      this._conductorTimer = null;
      if (!this.isPlaying) return;
      this._barCounter++;
      this._conductorTick();
      this._scheduleNextBarTick();
    }, this._barDurationSec * 1000);
  }

  _stopConductor() {
    if (this._conductorTimer) {
      clearTimeout(this._conductorTimer);
      this._conductorTimer = null;
    }
    this._barCounter = 0;
    this._trackChanceState = {};
  }

  // Fabric model: EVERY level of a level_specific track gets its own verdict +
  // reroll grid at start. Background levels keep rolling while inactive (editor
  // reference: core/region.py _advance_level_state simulates exactly this), so
  // entering a level at any moment catches its live chance texture.
  _initialPlayChanceRoll() {
    this._trackChanceState = {};

    for (let i = 0; i < this.tracks.length; i++) {
      const track = this.tracks[i];
      if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') continue;

      const levelsState = {};
      for (const lvlStr of Object.keys(track.levelSamples)) {
        const lvl = parseInt(lvlStr);
        const levelData = track.levelSamples[lvl];
        const playChance = levelData ? (levelData.playChance ?? 100) : 100;

        if (playChance >= 100) {
          levelsState[lvl] = { playing: true, lockedUntil: 0, nextRerollBar: Infinity };
          continue;
        }

        const passed = track._rollPlayChance(lvl);
        const loopBars = levelData?.loopBars || 4;
        const rerollBars = track.chanceRerollBars || 1;
        const lockDuration = loopBars * rerollBars;

        levelsState[lvl] = {
          playing: passed,
          lockedUntil: lockDuration,
          nextRerollBar: lockDuration,
        };

        // Apply gain immediately — activateLevel already ran before conductor started
        if (!passed && lvl === this.currentLevel) {
          this._applyChanceGain(track, lvl, false);
        }
      }
      this._trackChanceState[i] = levelsState;
    }
  }

  _conductorTick() {
    const bar = this._barCounter;
    const curLevel = this.currentLevel;

    // ── play_chance evaluation ──
    // Fabric model: every level rerolls on ITS OWN grid, continuously — background
    // verdicts evolve while the level is inactive (bookkeeping only; gain ramps
    // apply to the current level alone). activateLevel reads the target level's
    // live verdict at entry, so no entry-time reroll exists anymore.
    for (let i = 0; i < this.tracks.length; i++) {
      const levelsState = this._trackChanceState[i];
      if (!levelsState) continue;

      const track = this.tracks[i];
      for (const lvlStr of Object.keys(levelsState)) {
        const lvl = parseInt(lvlStr);
        const state = levelsState[lvlStr];

        // Still locked from previous roll — committed state
        if (bar < state.nextRerollBar) continue;

        const levelData = track.levelSamples[lvl];
        const playChance = levelData ? (levelData.playChance ?? 100) : 100;
        if (playChance >= 100) {
          // Init seeds 100%-levels with nextRerollBar=Infinity — reachable only
          // if a runtime mutation dropped the chance below 100 and back.
          state.playing = true;
          state.nextRerollBar = Infinity;
          continue;
        }

        // Reroll on this level's own grid
        const passed = track._rollPlayChance(lvl);
        const loopBars = levelData?.loopBars || 4;
        const rerollBars = track.chanceRerollBars || 1;
        const lockDuration = loopBars * rerollBars;

        // Audible ramp only when the verdict CHANGED on the audible level;
        // background levels just remember the verdict for their next entry.
        if (passed !== state.playing && lvl === curLevel) {
          const boundary = this._calcNextLoopBoundary(track, lvl);
          this._applyChanceGain(track, lvl, passed, boundary);
        }

        state.playing = passed;
        state.lockedUntil = bar + lockDuration;
        state.nextRerollBar = bar + lockDuration;
      }
    }

    // ── Variation switching (runs every bar, checks against loopBars * repeatCount) ──
    // Fabric model: level_specific tracks tick EVERY level's pool, not just the
    // current one — background levels keep rotating while muted (editor reference
    // _advance_level_state; FMOD virtual-voice model). Counters stay aligned to
    // each level's own loop grid (all ticking since play start), so entering a
    // level mid-loop never restarts its "play N times before switching" count.
    for (let i = 0; i < this.tracks.length; i++) {
      const track = this.tracks[i];
      const isShared = (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional');

      if (isShared) {
        const buffers = track._sharedBuffers;
        if (!buffers || buffers.length <= 1) continue;

        if (track._variationBarCounter['shared'] === undefined) {
          track._variationBarCounter['shared'] = 0;
        }
        track._variationBarCounter['shared']++;

        const levelData = track.levelSamples[curLevel] || {};
        const switchBars = (levelData.loopBars || 4) * (track.repeatCount || 1);

        if (track._variationBarCounter['shared'] >= switchBars) {
          track._variationBarCounter['shared'] = 0;
          const switchChance = levelData.switchChance ?? 100;
          if (switchChance > 0 && Math.random() * 100 <= switchChance) {
            const boundary = this._calcNextLoopBoundary(track, curLevel);
            this._switchVariation(track, 'shared', boundary);
          }
        }
        continue;
      }

      for (const lvlStr of Object.keys(track.levelSamples)) {
        const lvl = parseInt(lvlStr);
        const buffers = track._buffers[lvl];
        if (!buffers || buffers.length <= 1) continue;

        if (track._variationBarCounter[lvl] === undefined) {
          track._variationBarCounter[lvl] = 0;
        }
        track._variationBarCounter[lvl]++;

        const levelData = track.levelSamples[lvl] || {};
        const switchBars = (levelData.loopBars || 4) * (track.repeatCount || 1);

        if (track._variationBarCounter[lvl] >= switchBars) {
          track._variationBarCounter[lvl] = 0;
          const switchChance = levelData.switchChance ?? 100;
          if (switchChance > 0 && Math.random() * 100 <= switchChance) {
            const boundary = this._calcNextLoopBoundary(track, lvl);
            this._switchVariation(track, lvl, boundary);
          }
        }
      }
    }
  }

  /**
   * Live play_chance verdict for (trackIdx, level). Fabric model: background
   * levels reroll continuously on their own grid (conductor), so entry simply
   * READS the target level's current verdict — no entry-time reroll (the old
   * _rollChanceForNewLevel), no stale verdict inherited from the level left.
   */
  _levelChanceVerdict(trackIdx, level) {
    if (trackIdx < 0) return true;
    const levelsState = this._trackChanceState?.[trackIdx];
    if (!levelsState || !levelsState[level]) return true;
    return !!levelsState[level].playing;
  }

  /**
   * Calculate exact AudioContext time of next loop boundary for a track.
   * Loop boundary = _playStartTime + N * (barDurationSec * loopBars), where N is next whole loop.
   *
   * Conductor ticks are phase-aligned with bar cadence, so when a counter hits
   * switch_bars the tick lands ≈ AT the loop boundary we want to use. Pushing to
   * the NEXT loop via `boundary + loopDurationSec` schedules the swap one loop
   * late — observable as "switch every loop" playing each variation twice before
   * moving on. Use the PREVIOUS boundary when we're within ~1 frame of it
   * (tick jitter); `_switchVariation` / `_applyChanceGain` treat a past boundary
   * as "fire now", which is the authored intent ("at THIS loop end"). Ported
   * from Godot `_calc_next_loop_boundary` (pfa_event.gd:791).
   */
  _calcNextLoopBoundary(track, level) {
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    const levelData = track.levelSamples[level];
    const loopBars = levelData?.loopBars || 4;
    const loopDurationSec = this._barDurationSec * loopBars;

    if (loopDurationSec <= 0) return now; // safety fallback

    // Per-level phase anchor takes precedence over global _playStartTime when
    // restart_on_entry fired on this level — boundaries then follow the
    // restarted loop, not the global event clock.
    const anchor = this._levelPhaseAnchors?.[level] ?? this._playStartTime;
    const elapsed = now - anchor;
    const loopsSoFar = Math.ceil(elapsed / loopDurationSec);
    const boundary = anchor + loopsSoFar * loopDurationSec;
    const prevBoundary = boundary - loopDurationSec;
    // ~33ms ≈ 2 frames at 60fps. Tick jitter rarely exceeds this.
    if (prevBoundary >= anchor - 0.001 && now - prevBoundary < 0.033) {
      return prevBoundary;
    }
    return boundary;
  }

  /**
   * Calculate next bar boundary in AudioContext time.
   */
  _calcNextBarBoundary() {
    const now = this.engine.ctx.currentTime;
    if (!this._barDurationSec || this._barDurationSec <= 0) return now;
    const elapsed = now - this._playStartTime;
    const barsSoFar = Math.ceil(elapsed / this._barDurationSec);
    let boundary = this._playStartTime + barsSoFar * this._barDurationSec;
    if (boundary - now < 0.01) boundary += this._barDurationSec;
    return boundary;
  }

  /**
   * Calculate next beat boundary in AudioContext time.
   */
  _calcNextBeatBoundary() {
    const beatsPerBar = this.timeSignature[0] || 4;
    const beatDurationSec = this._barDurationSec / beatsPerBar;
    if (beatDurationSec <= 0) return this.engine.ctx.currentTime;
    const now = this.engine.ctx.currentTime;
    const elapsed = now - this._playStartTime;
    const beatsSoFar = Math.ceil(elapsed / beatDurationSec);
    let boundary = this._playStartTime + beatsSoFar * beatDurationSec;
    if (boundary - now < 0.01) boundary += beatDurationSec;
    return boundary;
  }

  /**
   * Get quantized transition time based on quantization mode.
   * Returns AudioContext time for bar/beat, or null for instant.
   *
   * If the current node has `free_tempo: true`, force instant — no bar/beat
   * grid exists to snap to. Covers level switches, node transitions, and
   * connection-level quantize overrides since they all route through here.
   * Editor parity: core/music_event.py:404-408 in _compute_scheduled_switch_position.
   * Godot parity: `_get_quantized_time` (pfa_event.gd:839).
   */
  _getQuantizedTime(quantize) {
    if (this._isCurrentNodeFreeTempo()) return null;
    if (quantize === 'bar') return this._calcNextBarBoundary();
    if (quantize === 'beat') return this._calcNextBeatBoundary();
    return null; // instant/immediate — no delay
  }

  _isCurrentNodeFreeTempo() {
    if (!this.useNodes || !this.currentNode || !this.nodeGraph) return false;
    const node = this.nodeGraph.nodes?.[this.currentNode];
    return !!node?.free_tempo;
  }

  /**
   * Update `_barDurationSec` from the current node's BPM/time_signature (the
   * exporter flattens a Tempo node's overrides into these fields on the target
   * loop node). When the bar duration changes, the chained conductor setTimeout
   * picks up the new value on the next tick. Call sites: first-node branch of
   * _enterNode, _postTransitionCommon, _startConductor. Godot parity:
   * `_sync_bar_duration_to_current_node` (pfa_event.gd:1727).
   */
  _syncBarDurationToCurrentNode() {
    if (!this.currentNode || !this.nodeGraph) return;
    const node = this.nodeGraph.nodes?.[this.currentNode];
    if (!node) return;
    const nodeBpm = node.bpm || this.bpm;
    const nodeTs = node.time_signature || this.timeSignature;
    const beatsPerBar = nodeTs?.[0] || 4;
    if (nodeBpm > 0 && beatsPerBar > 0) {
      this._barDurationSec = (60 / nodeBpm) * beatsPerBar;
    }
  }

  /**
   * @param {PFATrack} track
   * @param {number} level
   * @param {boolean} playing - target state
   * @param {number} [whenTime] - AudioContext time to start the ramp (default: now, used for initial roll)
   *
   * Leak safety: scheduled on `track._levelGains[level].gain`. If navigate()
   * flips `current_level` before the boundary fires, activateLevel (or the
   * Transition Kinds v2 `_rampLevelGain`) runs on that gain node and calls
   * `cancelScheduledValues(t0 + epsilon)` where t0 ≈ now — any future unmute
   * ramp past t0 is cancelled. The Godot port (pfa_event.gd:127) needs an
   * explicit `_transition_gen` guard because SceneTreeTimer lambdas can't be
   * cancelled sample-accurately; Web Audio handles it natively.
   */
  _applyChanceGain(track, level, playing, whenTime) {
    const g = track._levelGains[level];
    if (!g) return;

    const targetVol = playing ? track.volume : 0;
    const fadeSec = track.chanceFadeMode === 'fade' ? track.chanceFadeDuration : 0.01;

    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    const t0 = whenTime ?? now;

    const prevIntended = track._intendedGains[level] ?? 0;

    // Scheduled at a future musical boundary. A play_chance change can land while a level
    // fade curve (activateLevel / _rampLevelGain) is still in flight on this same gain, so
    // split on whether such a fade's window straddles t0 (endTime read from _rampState — the
    // timing is exact even though its fromVal estimate is vestigial):
    if (t0 > now + 0.005) {
      const rs = track._rampState[level];
      const fadeCrossesT0 = !!(rs && rs.endTime > t0 + 1e-4);
      if (fadeCrossesT0) {
        // OVERLAP. The old `cancelScheduledValues(t0)` + `setValueAtTime(prevIntended, t0)`
        // was wrong two ways — both confirmed on real Web Audio via OfflineAudioContext:
        //   • cancelScheduledValues(cancelTime) inside a setValueCurveAtTime REMOVES the whole
        //     curve (Chromium) → the fade collapses to its surviving anchor (silence) with a
        //     sub-fade step pop at t0; on stricter engines the following setValueAtTime lands
        //     inside the live curve → NotSupportedError → the conductor tick throws and
        //     _scheduleNextBarTick never re-arms (the latent freeze flagged for follow-up).
        //   • it anchored prevIntended (the level TARGET), not the curve's real value at t0.
        // cancelAndHoldAtTime(t0) lets the curve run to t0, truncates+holds the real value
        // there (no overlap → no throw), and the ramp continues from it. Verified: fade-in
        // preserved 0→0.707 through t0, then a clean ramp to target. Godot parity:
        // _apply_chance_gain waits on a SceneTreeTimer then ramps from the live value.
        g.gain.cancelAndHoldAtTime(t0);
        g.gain.linearRampToValueAtTime(targetVol, t0 + fadeSec);
      } else {
        // COMMON (no fade crossing t0): defer the change to the boundary, then ramp — the
        // FMOD/Wwise boundary-aligned semantics. Safe: no live curve for the anchor to overlap.
        // (cancelAndHold can't be used here — with nothing to truncate it leaves no t0 anchor,
        // so the ramp would start at `now`, pulling the change a bar early off the beat.)
        g.gain.cancelScheduledValues(t0);
        g.gain.setValueAtTime(prevIntended, t0);
        g.gain.linearRampToValueAtTime(targetVol, t0 + fadeSec);
      }
      // DON'T update _intendedGains/_rampState yet — the ramp hasn't started.
      // activateLevel reads these for splice interpolation; updating now would
      // give negative progress if activateLevel runs before the boundary.
      // Store pending state separately so Conductor won't re-apply (fromVal is
      // bookkeeping only — never read for a gain decision; v0 reads live g.value).
      track._pendingChanceGain = { level, targetVol, startTime: t0, endTime: t0 + fadeSec, fromVal: prevIntended };
    } else {
      // Immediate (initial roll at play start)
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(targetVol, now + fadeSec);

      track._intendedGains[level] = targetVol;
      track._rampState[level] = {
        startTime: now,
        endTime: now + fadeSec,
        fromVal: g.gain.value,
        toVal: targetVol,
      };
    }
  }

  // ── Variation Switching: JIT Stop+Start with 2ms micro-crossfade ──
  // Research doc/08 pattern: create new source at boundary, crossfade via dedicated GainNodes.
  // Old source cleaned up via onended (Chromium memory leak prevention).

  /**
   * Switch sample variation for a track at the given loop boundary.
   * Uses 2ms micro-crossfade to prevent clicks from waveform discontinuity.
   * @param {PFATrack} track
   * @param {number|string} level - level index or 'shared' for always_play
   * @param {number} boundaryTime - AudioContext.currentTime of loop boundary
   */
  _switchVariation(track, level, boundaryTime) {
    const ctx = this.engine.ctx;
    const MICRO_FADE = 0.002; // 2ms — eliminates click from amplitude mismatch at splice
    const t = boundaryTime;

    // Determine buffers/clips for this track
    const isShared = (level === 'shared');
    let buffers, clips;
    if (isShared) {
      buffers = track._sharedBuffers;
      clips = track.sharedClips;
    } else {
      buffers = track._buffers[level] || track._buffers[0];
      clips = track.levelClips[level] || track.levelClips[0] || [];
    }

    if (!buffers || buffers.length <= 1) return; // Nothing to switch

    // Fabric model: background (non-current) levels DO rotate — the swap lands on
    // a muted lane (levelGain 0) and is inaudible. The editor's freeze survives
    // only in its original narrow sense ("OLD level during crossfade must not swap
    // variation at loop boundary — counters still advance but the swap itself is
    // vetoed", core/multisample.py:475-479): while the OUTGOING lane is still
    // audibly fading, replacing its source would jump content mid-fade. Checked
    // BEFORE the pick so a vetoed boundary never consumes the rotation bag.
    if (!isShared && level !== this.currentLevel) {
      const lvlGain = track._levelGains[level];
      const ramp = track._rampState ? track._rampState[level] : null;
      const stillFading = !!(ramp && ctx.currentTime < ramp.endTime);
      const liveVal = (lvlGain && lvlGain.gain) ? lvlGain.gain.value : 0;
      if (stillFading || liveVal > 0.001) return;
    }

    // Pick new variation (per-pool rotation state — 'shared' or this level)
    const poolKey = isShared ? 'shared' : level;
    const oldVariation = track.currentVariation(poolKey);
    const newVariation = track._pickVariation(buffers, clips, poolKey);

    if (newVariation === oldVariation) {
      // Same buffer — skip source swap (no audible change)
      console.log(`[PFA] Variation switch: same index ${oldVariation}, skipping`);
      return;
    }

    const newBuffer = buffers[newVariation];
    const newClip = clips ? clips[newVariation] : null;
    if (!newBuffer) return;

    // Connection target: levelGain for level_specific, trackGain for always_play
    const targetGain = isShared ? track._trackGain : track._levelGains[level];
    if (!targetGain) return;

    // --- Create new source + variationGain ---
    const newVarGain = ctx.createGain();
    newVarGain.gain.setValueAtTime(0, t);
    newVarGain.gain.linearRampToValueAtTime(1, t + MICRO_FADE);
    newVarGain.connect(targetGain);

    const newSource = ctx.createBufferSource();
    newSource.buffer = newBuffer;
    newSource.loop = true;

    if (newClip && newClip.sourcePlayLength > 0) {
      newSource.loopStart = newClip.sourceOffset;
      newSource.loopEnd = newClip.sourceOffset + newClip.sourcePlayLength;
      if (newClip.loopMode === 'one_shot') newSource.loop = false;
      newSource.connect(newVarGain);
      // Start at beginning of clip region (offset from buffer start, per Web Audio spec)
      newSource.start(t, newClip.sourceOffset);
    } else {
      newSource.connect(newVarGain);
      newSource.start(t, 0);
    }

    // --- Fade out old source ---
    const lvlKey = isShared ? 'shared' : level;
    const oldVarGain = track._variationGains[lvlKey];
    const oldSource = isShared ? track._sources[0] : track._levelSources[level];

    if (oldVarGain) {
      oldVarGain.gain.setValueAtTime(1, t);
      oldVarGain.gain.linearRampToValueAtTime(0, t + MICRO_FADE);
    }

    // Schedule old source stop AFTER micro-fade completes
    if (oldSource) {
      try {
        oldSource.stop(t + MICRO_FADE);
      } catch(e) {} // May already be stopped
      // Cleanup via onended — NEVER disconnect before stop fires (Chromium memory leak)
      const capturedOldVarGain = oldVarGain;
      oldSource.onended = () => {
        try { oldSource.disconnect(); } catch(e) {}
        if (capturedOldVarGain) {
          try { capturedOldVarGain.disconnect(); } catch(e) {}
        }
      };
    }

    // --- Update references ---
    track._variationGains[lvlKey] = newVarGain;
    if (isShared) {
      track._sources[0] = newSource;
    } else {
      track._levelSources[level] = newSource;
    }

    console.log(`[PFA] Variation switch: "${track.name}" ${oldVariation} → ${newVariation} at ${t.toFixed(3)}s (level=${level})`);
  }

  /**
   * Clip length (seconds) of the current node's level — used by free_tempo
   * auto-advance where bars don't apply. First level_specific track's first
   * clip wins. RegionClip.sourcePlayLength when present, else buffer.duration.
   * Returns -1 if no playable clip found. Godot parity:
   * `_get_current_clip_length_sec` (pfa_event.gd).
   */
  _getCurrentClipLengthSec() {
    const curLevel = this.currentLevel;
    for (const track of this.tracks) {
      if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') continue;
      const clips = track.levelClips?.[curLevel] ?? track.levelClips?.[0] ?? [];
      if (clips.length > 0 && clips[0].sourcePlayLength > 0) {
        return clips[0].sourcePlayLength;
      }
      const buffers = track._buffers?.[curLevel] ?? track._buffers?.[0];
      if (buffers && buffers.length > 0 && buffers[0]) {
        return buffers[0].duration;
      }
    }
    return -1;
  }

  /**
   * Schedule auto-advance to a connected node after loop_count plays.
   * Free tempo: duration = clip_length × loop_count (bars don't apply).
   * Fixed tempo: duration = duration_bars × loop_count × bar_duration_at_node_bpm.
   * If no outgoing auto connection exists but the node carries `terminal_fade`
   * metadata (exporter-flattened dangling fade_out), we fire the terminal fade
   * instead — authored intent is "this node ends with that fade, play it then stop".
   * Mirrors Godot `_schedule_auto_advance` (pfa_event.gd:724).
   */
  _scheduleAutoAdvance(node) {
    if (this._autoAdvanceTimer) {
      clearTimeout(this._autoAdvanceTimer);
      this._autoAdvanceTimer = null;
    }

    const loopCount = node.loop_count || 0;
    if (loopCount <= 0) return;

    const connections = this.nodeGraph?.connections || [];
    const hasAuto = connections.some(c => c.source === this.currentNode && c.auto === true);
    const hasTerminal = !!node.terminal_fade;
    if (!hasAuto && !hasTerminal) return;

    let duration = -1;
    const freeTempo = !!node.free_tempo;

    if (freeTempo) {
      const clipLen = this._getCurrentClipLengthSec();
      if (clipLen > 0) duration = clipLen * loopCount;
    } else {
      const bpmNode = node.bpm || this.bpm;
      const tsNode = node.time_signature || this.timeSignature;
      const beatsPerBar = tsNode?.[0] || 4;
      const barDur = bpmNode > 0 ? (60 / bpmNode) * beatsPerBar : this._barDurationSec;
      const durationBars = node.duration_bars || 0;
      if (durationBars > 0) duration = durationBars * loopCount * barDur;
    }

    if (duration <= 0) return;

    console.log(`[PFA] Auto-advance in ${duration.toFixed(3)}s (node=${this.currentNode}, loop_count=${loopCount}, free=${freeTempo}, terminal=${hasTerminal && !hasAuto})`);

    this._autoAdvanceTimer = setTimeout(() => {
      this._autoAdvanceTimer = null;
      if (hasAuto) {
        this._executeAutoAdvance();
      } else {
        this.stopWithTerminalFade();
      }
    }, duration * 1000);
  }

  _executeAutoAdvance() {
    if (!this.currentNode || !this.nodeGraph) return;

    // Find auto-transition connections from current node
    const connections = this.nodeGraph.connections || [];
    const autoCandidates = connections.filter(c =>
      c.source === this.currentNode &&
      c.conn_type === 'transition' &&
      c.auto === true
    );

    if (autoCandidates.length === 0) {
      console.log(`[PFA] No auto-advance transition from node "${this.currentNode}"`);
      return;
    }

    // Sort by priority
    autoCandidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Pick by probability
    for (const conn of autoCandidates) {
      const prob = conn.probability !== undefined ? conn.probability : 100;
      if (Math.random() * 100 <= prob) {
        console.log(`[PFA] Auto-advancing from "${this.currentNode}" to "${conn.target}"`);
        this._executeTransition(conn);
        // Fire onNodeChanged callback (same as navigate())
        if (this.engine.onNodeChanged && this.currentNode) {
          const node = this.nodeGraph.nodes[this.currentNode];
          this.engine.onNodeChanged(this.name, this.currentNode, node?.name);
        }
        return;
      }
    }
  }

  /**
   * Fire a one-shot stinger overlay on top of the music bed.
   * Rolls play_chance, picks a variant per `bundle.mode`, scales by clip × bundle volume,
   * and routes through `_eventGain` (so event volume + fades still apply).
   * Mirrors Godot _play_stinger (pfa_event.gd).
   */
  _playStinger(connectionKey) {
    const bundle = this._stingerBundles?.[connectionKey];
    if (!bundle || bundle.buffers.length === 0) return;

    const chance = bundle.playChance;
    if (chance <= 0) return;
    if (chance < 100 && Math.random() * 100 > chance) return;

    const idx = this._pickStingerVariant(bundle);
    if (idx < 0 || idx >= bundle.buffers.length) return;

    const clip = bundle.clips[idx] ?? {};
    const finalGain = Number(clip.volume ?? 1.0) * bundle.volume;

    const source = this.engine.ctx.createBufferSource();
    source.buffer = bundle.buffers[idx];
    source.loop = false;
    const gainNode = this.engine.ctx.createGain();
    gainNode.gain.value = finalGain;
    source.connect(gainNode).connect(this._eventGain);
    source.start(this.engine._now());
    console.log(`[PFA] Stinger fired (key=${connectionKey}, idx=${idx}, mode=${bundle.mode}, vol=${finalGain.toFixed(2)})`);
  }

  /**
   * Variant selection. Canonical algorithm — port of core/stinger_picker.py.
   * Modes: "random" | "weighted" | "no_repeat" (unknown falls back to random).
   * Mutates bundle.state.lastIdx on each pick (used by no_repeat).
   */
  _pickStingerVariant(bundle) {
    const n = bundle.buffers.length;
    if (n <= 0) return -1;
    if (n === 1) {
      bundle.state.lastIdx = 0;
      return 0;
    }
    const mode = bundle.mode;
    if (mode === 'weighted') {
      if (!Array.isArray(bundle.clips) || bundle.clips.length !== n) {
        return Math.floor(Math.random() * n);
      }
      const weights = bundle.clips.map(c => Math.max(0, Number(c?.weight ?? 1.0)));
      const total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) return Math.floor(Math.random() * n);
      const rval = Math.random() * total;
      let cum = 0;
      for (let i = 0; i < n; i++) {
        cum += weights[i];
        if (rval < cum) return i;
      }
      return n - 1;
    }
    if (mode === 'no_repeat') {
      const last = bundle.state.lastIdx;
      const choices = [];
      for (let i = 0; i < n; i++) if (i !== last) choices.push(i);
      const idx = choices.length > 0
        ? choices[Math.floor(Math.random() * choices.length)]
        : 0;
      bundle.state.lastIdx = idx;
      return idx;
    }
    return Math.floor(Math.random() * n);
  }

  // ── Sub-levels ──

  _enableSubLevel(sub, fadeDuration) {
    const now = this.engine._now();
    const elapsed = now - this._playStartTime;
    const subGain = this.engine.ctx.createGain();
    subGain.gain.setValueAtTime(0, now);
    subGain.connect(this._eventGain);

    // Pre-start sub-level tracks at gain=0, then fade in subGain
    for (const track of sub.tracks) {
      if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') {
        track.playMusic(sub.levelIndex, subGain, elapsed);
      } else {
        track.prestartAllLevels(subGain, elapsed);
        track.activateLevel(sub.levelIndex, 0);
      }
    }

    // Fade in the sub-level gain
    subGain.gain.linearRampToValueAtTime(sub.volume, now + fadeDuration);

    // Store for later disable
    if (!this._subLevelStates[sub.name]) {
      this._subLevelStates[sub.name] = {};
    }
    this._subLevelStates[sub.name].gainNode = subGain;
    this._subLevelStates[sub.name].tracks = sub.tracks;
  }

  _disableSubLevel(sub, subName, fadeDuration) {
    const state = this._subLevelStates[subName];
    if (!state || !state.gainNode) return;

    const gainNode = state.gainNode;
    const tracks = state.tracks || sub.tracks;
    const now = this.engine._now();

    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + fadeDuration);

    // Stop tracks after fade completes
    setTimeout(() => {
      for (const track of tracks) {
        track.stopAll();
        track.stopAllLevels();
      }
      gainNode.disconnect();
    }, fadeDuration * 1000);

    state.gainNode = null;
    state.tracks = null;
  }

  _stopAllSubLevels() {
    const now = this.engine._now();
    for (const subName of Object.keys(this._subLevelStates)) {
      const state = this._subLevelStates[subName];
      if (state.gainNode) {
        const gainNode = state.gainNode;
        const tracks = state.tracks;
        // Micro-fade out (20ms) to prevent click
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        gainNode.gain.linearRampToValueAtTime(0, now + 0.02);
        setTimeout(() => {
          if (tracks) {
            for (const track of tracks) {
              track.stopAll();
              track.stopAllLevels();
            }
          }
          gainNode.disconnect();
        }, 25);
        state.gainNode = null;
        state.tracks = null;
      }
      state.enabled = false;
    }
  }

  // ── Common ──

  _ensureGain() {
    if (!this._eventGain) {
      this._eventGain = this.engine.ctx.createGain();
      // Set gain to 0 IMMEDIATELY (not scheduled) to prevent any audio leak
      this._eventGain.gain.value = 0;
      this._eventGain.connect(this.engine.masterGain);
    }
    this._ensureReverbSend();
  }

  /**
   * Opt-in per-event reverb send. Taps POST-_eventGain (so it inherits every
   * event fade for free) and routes send×(active-zone wet) into the global reverb
   * bus. Created at most once, only when a reverb bus exists AND this event
   * authored reverb {enabled, send>0}. Unlike Godot's binary `>0` bus gate, the
   * web path honors the send MAGNITUDE. No bus / not opted in ⇒ stays dry on
   * master (zero behaviour change). Idempotent — safe to call on every play.
   * @private
   */
  _ensureReverbSend() {
    const eng = this.engine;
    if (this._reverbSend || !eng.reverbBus || !this._eventGain) return;
    const rv = this.reverb;
    if (!rv || !rv.enabled) return;
    const send = (rv.send != null) ? rv.send : 0;
    if (!(send > 0)) return;
    this._reverbSend = eng.ctx.createGain();
    this._reverbSend.gain.value = Math.max(0, Math.min(1, send));
    this._eventGain.connect(this._reverbSend);
    this._reverbSend.connect(eng.reverbBus.input);
  }

  _updateGain() {
    if (this._eventGain) {
      // Instant, but guarded: clear any active fade curve first so setVolume()
      // mid-fade can't throw a curve-overlap error.
      this._eventGain.gain.cancelScheduledValues(0);
      this._eventGain.gain.setValueAtTime(
        this.volume * this.groupGain,
        this.engine._now()
      );
    }
  }

  _crossfadeLevel(oldLevel, newLevel) {
    for (const track of this.tracks) {
      if (track.levelBehavior === 'always_play' || track.levelBehavior === 'level_conditional') continue;
      // Pre-started sources already running — just ramp gains. Pass the event's authored
      // fadeCurve (the editor's Curve dropdown): without it activateLevel defaulted to
      // equal_power, a front-loaded ramp that sounds much faster than the set duration even
      // when the user picked Linear. Node-mode transitions already thread the curve.
      track.activateLevel(newLevel, this.fadeDuration, this.fadeCurve);
    }
  }

  _cleanupVoices() {
    this._activeVoices = this._activeVoices.filter(v => v.isActive());
  }
}


/**
 * Internal: one track within an event.
 */
class PFATrack {
  /** Minimum ramp duration for "instant" level gain changes. Below this, a
   * hard setValueAtTime would click audibly on amp discontinuities. 10ms
   * mirrors Godot's 30ms frame floor scaled to Web Audio sample accuracy. */
  static _FADE_ANTICLICK_FLOOR = 0.01;

  constructor(data, engine) {
    this.engine = engine;
    this.name = data.name || 'Track';
    this.volume = data.volume ?? 1.0;
    this.levelBehavior = data.level_behavior || 'level_specific';
    this.randomization = data.randomization || {};
    this.repeatCount = data.repeat_count || 1;
    this.chanceRerollBars = data.chance_reroll_bars || 1; // independent play_chance reroll interval
    this.randomizationAlgo = data.randomization_algo || 'random'; // 'random' | 'weighted' | 'no_repeat'
    this.chanceFadeMode = data.chance_fade_mode || 'instant';
    this.chanceFadeDuration = data.chance_fade_duration ?? 0.5;
    this.playChanceMode = data.play_chance_mode || 'true_random'; // 'true_random' | 'weighted_history' | 'shuffle_bag'

    // Shared samples (for always_play / level_conditional)
    this.sharedSampleFiles = data.samples || [];
    this.sharedClips = (data.clips || []).map(c => PFATrack._parseClip(c));

    // Per-level sample info
    this.levelSamples = {};
    this.levelClips = {};
    const levelsData = data.levels || {};
    for (const key of Object.keys(levelsData)) {
      const levelInfo = levelsData[key];
      const lvl = parseInt(key);
      this.levelSamples[lvl] = {
        files: levelInfo.samples || [],
        loopBars: levelInfo.loop_bars ?? 4,
        switchChance: levelInfo.switch_chance ?? 100,
        playChance: levelInfo.play_chance ?? 100,
      };
      this.levelClips[lvl] = (levelInfo.clips || []).map(c => PFATrack._parseClip(c));
    }

    // Runtime
    this._buffers = {};       // level -> [AudioBuffer]
    this._sharedBuffers = []; // for always_play
    this._sources = [];       // active AudioBufferSourceNode
    this._trackGain = null;
    // Per-pool variation rotation state, keyed 'shared' or level — editor parity
    // (LevelState.current_variation_index + _variation_shuffle_bag): each level
    // rotates its own variations independently. Pools of different sizes must
    // never share one index/bag — a no_repeat bag minted on a 5-variation level
    // pops out-of-range indices on a 2-variation level, the swap bails, and the
    // variation sticks for a full extra loop per stale entry (china L2 bug).
    this._variationState = {};  // lvlKey -> { current: int, bag: [int] }

    // State for play_chance_mode (weighted_history / shuffle_bag)
    this._chanceConsecutivePlays = {};   // { level: count }
    this._chanceConsecutiveSilences = {}; // { level: count }
    this._chanceShuffleBags = {};        // { level: [true, false, ...] }
    this._chanceShuffleBagSize = 10;

    // Pre-start layers (FMOD/Wwise pattern: all levels playing at gain=0)
    this._levelGains = {};    // { levelIndex: GainNode }
    this._levelSources = {};  // { levelIndex: AudioBufferSourceNode }
    this._activeLevel = null; // currently active level index
    this._intendedGains = {}; // { levelIndex: number } — final target of last ramp
    this._rampState = {};     // { levelIndex: { startTime, endTime, fromVal, toVal } } — for computing current interpolated value

    // Variation switching state (JIT stop+start with micro-crossfade)
    this._variationGains = {};       // { level|'shared': GainNode } — current variationGain per level
    this._variationBarCounter = {};  // { level|'shared': number } — bars since last switch check
  }

  static _parseClip(c) {
    if (!c) return null;
    return {
      sourceOffset: c.source_offset || 0,
      sourcePlayLength: c.source_play_length || 0,
      loopMode: c.loop_mode || 'loop_source',
      fadeIn: c.fade_in || 0,
      fadeOut: c.fade_out || 0,
      volume: c.volume !== undefined ? c.volume : 1.0,
      weight: c.weight !== undefined ? c.weight : 1.0,
    };
  }

  async loadBuffers() {
    // Load shared (always_play) buffers — via decode cache
    console.log(`[PFA Track] Loading "${this.name}" behavior=${this.levelBehavior} shared=${this.sharedSampleFiles.length} levels=${JSON.stringify(Object.keys(this.levelSamples))}`);
    this._sharedBuffers = [];
    for (const file of this.sharedSampleFiles) {
      try {
        const audioBuffer = await this.engine._decodeWithCache(file);
        this._sharedBuffers.push(audioBuffer);
      } catch (e) {
        console.warn(`[PFA] Failed to load: ${file}`, e);
      }
    }

    // Load per-level buffers — via decode cache
    for (const level of Object.keys(this.levelSamples)) {
      const files = this.levelSamples[level].files;
      const buffers = [];
      for (const file of files) {
        try {
          const audioBuffer = await this.engine._decodeWithCache(file);
          buffers.push(audioBuffer);
        } catch (e) {
          console.warn(`[PFA] Failed to load: ${file}`, e);
        }
      }
      this._buffers[level] = buffers;
    }
  }

  playMusic(level, destination, offsetSeconds = 0) {
    this.stopAll();
    const { buffer, clip } = this._getBufferAndClip(level);
    console.log(`[PFA Track] playMusic "${this.name}" level=${level} behavior=${this.levelBehavior} buffer=${buffer ? 'OK' : 'NULL'} offset=${offsetSeconds.toFixed(2)}s`);
    if (!buffer) return;

    this._ensureGain(destination);

    const ctx = this.engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const now = this.engine._now();

    // Variation gain (1.0 steady state, micro-crossfade on switch)
    const variationGain = ctx.createGain();
    variationGain.gain.setValueAtTime(1, now);
    variationGain.connect(this._trackGain);
    this._variationGains['shared'] = variationGain;
    this._variationBarCounter['shared'] = 0;

    // Apply RegionClip windowing
    if (clip && clip.sourcePlayLength > 0) {
      source.loopStart = clip.sourceOffset;
      source.loopEnd = clip.sourceOffset + clip.sourcePlayLength;
      source.loop = clip.loopMode !== 'one_shot';

      // Apply clip volume
      if (clip.volume !== 1.0) {
        this._trackGain.gain.setValueAtTime(
          this.volume * clip.volume, now
        );
      }

      // Clip fade-in
      if (clip.fadeIn > 0) {
        this._trackGain.gain.setValueAtTime(0.0001, now);
        this._trackGain.gain.exponentialRampToValueAtTime(
          this.volume * (clip.volume || 1.0), now + clip.fadeIn
        );
      }

      // Connect BEFORE start to avoid click
      source.connect(variationGain);
      const clipDuration = clip.sourcePlayLength;
      const loopOffset = clipDuration > 0 ? (offsetSeconds % clipDuration) : 0;
      // Start at scheduled time (synced with gain) — NOT at 0 (immediate)
      source.start(now, clip.sourceOffset + loopOffset);
      this._sources.push(source);
      return;
    } else {
      // Legacy: full buffer loop
      source.loop = true;
      const loopOffset = buffer.duration > 0 ? (offsetSeconds % buffer.duration) : 0;
      source.connect(variationGain);
      // Start at scheduled time (synced with gain) — NOT at 0 (immediate)
      source.start(now, loopOffset);
      this._sources.push(source);
    }
  }

  triggerSfx(level, destination, iv = null) {
    // always_play / level_conditional keep their samples in the shared pool, so
    // levelSamples is empty for them — only gate level_specific on missing level data.
    const isShared = this.levelBehavior === 'always_play' || this.levelBehavior === 'level_conditional';
    if (!isShared && !this.levelSamples[level] && !this.levelSamples[0]) return null;

    // Play chance
    if (!this._rollPlayChance(level)) return null;

    const { buffer, clip, variation, variationCount } = this._getBufferAndClip(level, true);
    if (!buffer) return null;

    this._ensureGain(destination);

    const ctx = this.engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;

    this._applySfxPitchRate(source, iv);

    // Per-voice gain isolates clip volume + fades from the shared _trackGain
    // (track volume stays on _trackGain). Each voice is independent, so overlapping
    // SFX no longer clobber each other's volume randomization. Intensity multiplies
    // the steady target (its dB offset already folded into iv.gainMult).
    const voiceGain = ctx.createGain();
    const target = (clip?.volume ?? 1.0) * this._volumeRandLinear() * (iv ? iv.gainMult : 1.0);

    const startTime = this.engine._now() + (this._getRandomParam('delay') / 1000);

    // Trim window: [sourceOffset, sourceOffset + playLen).
    const offset = clip ? clip.sourceOffset : 0;
    const hasWindow = clip && clip.sourcePlayLength > 0;
    const playLen = hasWindow ? clip.sourcePlayLength : Math.max(0, buffer.duration - offset);
    if (hasWindow) {
      source.start(startTime, offset, clip.sourcePlayLength);
    } else if (offset > 0) {
      source.start(startTime, offset);
    } else {
      source.start(startTime);
    }

    this._applySfxFadeEnvelope(voiceGain.gain, target, startTime, playLen, clip);

    source.connect(voiceGain);
    voiceGain.connect(this._trackGain);
    this._sources.push(source);

    // Cleanup when done
    source.onended = () => {
      const idx = this._sources.indexOf(source);
      if (idx >= 0) this._sources.splice(idx, 1);
      try { voiceGain.disconnect(); } catch(e) {}
    };

    // Report what played — clean public API so the game can show it (variation /
    // sample / algorithm) without reaching into engine internals.
    const files = isShared ? this.sharedSampleFiles
      : (this.levelSamples[level]?.files || this.levelSamples[0]?.files || []);
    const sample = files && files[variation] ? files[variation].split('/').pop() : null;

    return {
      stop: () => { try { source.stop(); } catch(e) {} },
      isActive: () => this._sources.includes(source),
      track: this.name,
      behavior: this.levelBehavior,
      variation,
      variationCount,
      algo: this.randomizationAlgo,
      sample,
    };
  }

  /**
   * Trigger SFX for spatial audio. Creates per-voice gain instead of shared trackGain.
   * @param {number} level
   * @param {boolean} [skipPlayChance=false] - smart-loop re-trigger: bypass the
   *   play_chance roll so the loop never gaps (variation switch still applies).
   * @returns {{ source, voiceGain, track, loopMode, clipLen, target }|null}
   *   loopMode: null | 'seamless' (native loop) | 'smart' (re-trigger each cycle);
   *   clipLen/target let triggerSpatial schedule the smart re-loop + crossfade.
   */
  triggerSfxSpatial(level, skipPlayChance = false, iv = null) {
    const isShared = this.levelBehavior === 'always_play' || this.levelBehavior === 'level_conditional';
    if (!isShared && !this.levelSamples[level] && !this.levelSamples[0]) return null;

    // Play chance (skipped on a smart-loop re-trigger so the loop never gaps; the
    // initial trigger still rolls it).
    if (!skipPlayChance && !this._rollPlayChance(level)) return null;

    const { buffer, clip } = this._getBufferAndClip(level, true);
    if (!buffer) return null;

    const ctx = this.engine.ctx;

    // Per-voice gain (not shared _trackGain). The spatial chain has no _trackGain,
    // so this voice gain carries the full track volume + clip volume + fades.
    const voiceGain = ctx.createGain();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Loop resolution for this spatial voice:
    //   • event.loop (editor-authored, SFX) is the explicit control —
    //       'seamless' → native gapless loop of THIS variation;
    //       'smart'    → play ONCE here, triggerSpatial re-triggers each cycle so a
    //                    fresh variation + randomization is picked (crossfaded).
    //   • a music-type event still loops seamlessly by nature (kept as a fallback).
    //   • a one_shot clip never loops; a plain spatial SFX stays single-shot
    //     (fox-run footsteps/hits — byte-for-byte unchanged).
    const ev = this._parentEvent;
    const lcfg = ev && ev.loop;
    let loopMode = null;
    if (lcfg && lcfg.enabled) loopMode = lcfg.mode === 'smart' ? 'smart' : 'seamless';
    else if (ev && ev.type === 'music') loopMode = 'seamless';
    if (loopMode && !(clip && clip.loopMode !== 'one_shot')) loopMode = null;
    const loopSeamless = loopMode === 'seamless';
    source.loop = loopSeamless;

    this._applySfxPitchRate(source, iv);

    const target = this.volume * (clip?.volume ?? 1.0) * this._volumeRandLinear() * (iv ? iv.gainMult : 1.0);

    const startTime = this.engine._now() + (this._getRandomParam('delay') / 1000);

    // Trim window: [sourceOffset, sourceOffset + playLen).
    const offset = clip ? clip.sourceOffset : 0;
    const hasWindow = clip && clip.sourcePlayLength > 0;
    const playLen = hasWindow ? clip.sourcePlayLength : Math.max(0, buffer.duration - offset);
    if (loopSeamless) {
      // Loop [offset, offset+playLen) forever. No duration arg (it would stop the
      // source after one pass); loopStart/loopEnd keep the trim window seamless.
      if (hasWindow) {
        source.loopStart = offset;
        source.loopEnd = offset + clip.sourcePlayLength;
      }
      source.start(startTime, offset);
    } else if (hasWindow) {
      // One-shot trim — also the per-cycle pass for 'smart' loop (re-triggered).
      source.start(startTime, offset, clip.sourcePlayLength);
    } else if (offset > 0) {
      source.start(startTime, offset);
    } else {
      source.start(startTime);
    }

    if (loopMode === 'smart') {
      // The re-trigger scheduler owns the seam (equal-power crossfade), so the voice
      // plays at full gain — a clip fade-in/out here would fight the crossfade.
      voiceGain.gain.setValueAtTime(target, startTime);
    } else {
      // seamless / one-shot: clip fade envelope. 'looping' suppresses the window-end
      // fade-out (it would mute a seamless loop after the first pass).
      this._applySfxFadeEnvelope(voiceGain.gain, target, startTime, playLen, clip, loopSeamless);
    }

    source.connect(voiceGain);
    this._sources.push(source);

    // onended is set by the PFASpatialVoice ctor (also handles _sources cleanup).
    // loopMode/clipLen/target let triggerSpatial schedule the 'smart' re-loop.
    return { source, voiceGain, track: this, loopMode, clipLen: playLen, target };
  }

  crossfadeToLevel(newLevel, duration, destination, elapsedSeconds = 0) {
    // Always_play tracks don't change on level switch — keep playing
    if (this.levelBehavior === 'always_play') return;

    const { buffer, clip } = this._getBufferAndClip(newLevel);

    // Level-specific with no samples for this level — fade out
    if (!buffer) {
      if (this._trackGain && this._sources.length > 0) {
        const now = this.engine._now();
        this._trackGain.gain.setValueAtTime(this._trackGain.gain.value, now);
        this._trackGain.gain.linearRampToValueAtTime(0, now + duration);
        const oldSources = [...this._sources];
        setTimeout(() => {
          oldSources.forEach(s => { try { s.stop(); } catch(e) {} });
        }, duration * 1000);
        this._sources = [];
      }
      return;
    }

    // Fade out old
    if (this._trackGain) {
      const oldGain = this._trackGain;
      const now = this.engine._now();
      oldGain.gain.setValueAtTime(oldGain.gain.value, now);
      oldGain.gain.linearRampToValueAtTime(0, now + duration);
      const oldSources = [...this._sources];
      setTimeout(() => {
        oldSources.forEach(s => { try { s.stop(); } catch(e) {} });
        oldGain.disconnect();
      }, duration * 1000);
    }

    // Fade in new — sync to elapsed time
    const targetVolume = this.volume * (clip?.volume || 1.0);
    const newGain = this.engine.ctx.createGain();
    // Start silent immediately to prevent any audio leak before scheduled ramp
    newGain.gain.value = 0;
    const now = this.engine._now();
    newGain.gain.setValueAtTime(0, now);
    newGain.gain.linearRampToValueAtTime(targetVolume, now + duration);
    newGain.connect(destination);

    const source = this.engine.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(newGain);

    // Start at same scheduled time as gain=0 to avoid click
    if (clip && clip.sourcePlayLength > 0) {
      source.loopStart = clip.sourceOffset;
      source.loopEnd = clip.sourceOffset + clip.sourcePlayLength;
      source.loop = clip.loopMode !== 'one_shot';
      const clipDuration = clip.sourcePlayLength;
      const loopOffset = clipDuration > 0 ? (elapsedSeconds % clipDuration) : 0;
      source.start(now, clip.sourceOffset + loopOffset);
    } else {
      source.loop = true;
      const loopOffset = buffer.duration > 0 ? (elapsedSeconds % buffer.duration) : 0;
      source.start(now, loopOffset);
    }

    this._trackGain = newGain;
    this._sources = [source];
  }

  /**
   * Stop the currently-playing source for `level` and start a fresh one at
   * offset 0. Variation and level gain nodes are preserved — this only
   * replaces the source so phase resets while ongoing gain ramps continue.
   * Used by `restart_on_entry` on node entry. Godot parity (by intent):
   * Godot calls AudioStreamPlayer.seek(0); Web Audio BufferSourceNode can't be
   * rewound, so we recreate. The pool's current variation is preserved —
   * restart is about phase, not selection.
   */
  _restartLevelSource(level) {
    const varGain = this._variationGains?.[level];
    if (!varGain) return; // level not pre-started
    const { buffer, clip } = this._getBufferAndClip(level);
    if (!buffer) return;

    const ctx = this.engine.ctx;
    const now = this.engine._now();

    const oldSource = this._levelSources[level];
    if (oldSource) {
      try { oldSource.stop(now + 0.005); } catch (e) { /* already stopped */ }
    }

    const newSource = ctx.createBufferSource();
    newSource.buffer = buffer;
    if (clip && clip.sourcePlayLength > 0) {
      newSource.loopStart = clip.sourceOffset;
      newSource.loopEnd = clip.sourceOffset + clip.sourcePlayLength;
      newSource.loop = clip.loopMode !== 'one_shot';
      newSource.connect(varGain);
      newSource.start(now, clip.sourceOffset);
    } else {
      newSource.loop = true;
      newSource.connect(varGain);
      newSource.start(now, 0);
    }
    this._levelSources[level] = newSource;
    // Fresh phase — variation bar counter restarts with the new loop.
    this._variationBarCounter[level] = 0;
  }

  /**
   * Pre-start ALL levels at gain=0 (FMOD/Wwise pattern).
   * Sources are phase-locked (same start time). Only gains are switched at runtime.
   * @param {AudioNode} destination - Connect level gains here (eventGain)
   * @param {number} offsetSeconds - Playback offset for phase sync
   */
  prestartAllLevels(destination, offsetSeconds = 0) {
    this.stopAllLevels();

    const ctx = this.engine.ctx;
    const now = this.engine._now();

    for (const level of Object.keys(this.levelSamples)) {
      const lvl = parseInt(level);
      const { buffer, clip } = this._getBufferAndClip(lvl);
      if (!buffer) continue;

      // Per-level gain node, starts at 0
      const levelGain = ctx.createGain();
      levelGain.gain.setValueAtTime(0, now);
      levelGain.connect(destination);

      // Variation gain (1.0 steady state, only used during 2ms micro-crossfade on switch)
      const variationGain = ctx.createGain();
      variationGain.gain.setValueAtTime(1, now);
      variationGain.connect(levelGain);

      // Source with loop/clip settings
      const source = ctx.createBufferSource();
      source.buffer = buffer;

      if (clip && clip.sourcePlayLength > 0) {
        source.loopStart = clip.sourceOffset;
        source.loopEnd = clip.sourceOffset + clip.sourcePlayLength;
        source.loop = clip.loopMode !== 'one_shot';
        const clipDuration = clip.sourcePlayLength;
        const loopOffset = clipDuration > 0 ? (offsetSeconds % clipDuration) : 0;
        source.connect(variationGain);
        source.start(now, clip.sourceOffset + loopOffset);
      } else {
        source.loop = true;
        const loopOffset = buffer.duration > 0 ? (offsetSeconds % buffer.duration) : 0;
        source.connect(variationGain);
        source.start(now, loopOffset);
      }

      this._levelGains[lvl] = levelGain;
      this._levelSources[lvl] = source;
      this._variationGains[lvl] = variationGain;
      this._variationBarCounter[lvl] = 0;
      this._intendedGains[lvl] = 0;
    }
  }

  /**
   * Activate a level by ramping gains. No source creation/destruction.
   * Pass level=-1 to fade all to zero (used in node transitions).
   * @param {number} level - Target level index (-1 = all silent)
   * @param {number} fadeDuration - Fade time in seconds (0 = instant)
   * @param {string} [curve='equal_power'] - Fade curve (editor parity).
   */
  activateLevel(level, fadeDuration, curve = 'equal_power') {
    const ctx = this.engine.ctx;

    // Flush pending chance ramp if it has already started (boundary passed)
    if (this._pendingChanceGain) {
      const p = this._pendingChanceGain;
      if (ctx.currentTime >= p.startTime) {
        this._intendedGains[p.level] = p.targetVol;
        this._rampState[p.level] = { startTime: p.startTime, endTime: p.endTime, fromVal: p.fromVal, toVal: p.targetVol };
        this._pendingChanceGain = null;
      }
      // If boundary not yet reached, pending ramp is cancelled by activateLevel's own scheduling
      // (cancelScheduledValues will remove it). Clear the pending state.
      else {
        this._pendingChanceGain = null;
      }
    }

    // play_chance managed by Conductor (_trackChanceState) — no dice roll here.
    // Fabric model: gate by the TARGET level's own live verdict (was: stale
    // per-track verdict inherited from the level being LEFT — entering a
    // 100%-chance level could stay silent until the next loop boundary).
    const event = this._parentEvent;
    const passedChance = event
      ? event._levelChanceVerdict(event.tracks.indexOf(this), level)
      : true;

    for (const [lvl, gainNode] of Object.entries(this._levelGains)) {
      const g = gainNode.gain;
      let targetVol = (parseInt(lvl) === level) ? this.volume : 0;
      // Mute if play_chance state says this track should be silent
      if (parseInt(lvl) === level && !passedChance) {
        targetVol = 0;
      }

      // Splice the new fade onto the gain's LIVE value, anchored at the current
      // time. Two rules, both load-bearing (validated against real Web Audio via
      // OfflineAudioContext, see js/tests/test-event-fade-overlap.js §6):
      //   1. v0 = g.value — the TRUE in-flight amplitude. A linear estimate of an
      //      equal_power curve can be off by ~0.2, which a hard setValueAtTime then
      //      turns into an audible step.
      //   2. cancelScheduledValues(0) THEN anchor at `now` = ctx.currentTime, with NO
      //      lookahead. cancel(0) wipes any active fade curve so the new schedule can't
      //      overlap it (NotSupportedError → host-loop freeze) and HOLDS the live value
      //      (it does NOT revert to the intrinsic 1.0 — empirically confirmed). A
      //      future splice point (now+Δ) instead leaves a [now, t0) gap that Web Audio
      //      renders at the NEW curve's TARGET: full volume on a fade-in (the audible
      //      "pop to full" on rapid level changes) or silence on a fade-out.
      //      setValueAtTime pins the held value at `now` before the fade.
      const now = ctx.currentTime;
      const v0 = Math.max(0, g.value);
      g.cancelScheduledValues(0);
      g.setValueAtTime(v0, now);

      if (fadeDuration > 0) {
        const t1 = now + fadeDuration;
        _applyFadeCurve(g, v0, targetVol, now, fadeDuration, curve);
        this._intendedGains[lvl] = targetVol;
        this._rampState[lvl] = { startTime: now, endTime: t1, fromVal: v0, toVal: targetVol };
      } else {
        // Anti-click floor: an instant (fd=0) level swap would step the gain and
        // click. Ramp ~10ms from the live value to the target instead — still
        // effectively instant. Linear is intentional (anti-click carries no
        // perceptual curve semantics). Godot parity: 30ms frame-rate floor.
        const t1 = now + PFATrack._FADE_ANTICLICK_FLOOR;
        g.linearRampToValueAtTime(targetVol, t1);
        this._intendedGains[lvl] = targetVol;
        this._rampState[lvl] = { startTime: now, endTime: t1, fromVal: v0, toVal: targetVol };
      }
    }
    this._activeLevel = level;
  }

  /**
   * Ramp ONE level's gain to `targetVol` over `fadeDuration`, using the same
   * splice-with-lookahead pattern as `activateLevel`. Used by Transition Kinds
   * v2 helpers that need per-level granular control (fade_in silences non-target
   * levels with anti-click, fade_out ramps all levels to 0). Keeps
   * `_intendedGains` / `_rampState` consistent so later `activateLevel` splices
   * see the correct in-flight state. Godot parity: `_ramp_level_gain`
   * (pfa_event.gd:1281).
   */
  _rampLevelGain(level, targetVol, fadeDuration, curve = 'equal_power') {
    const gainNode = this._levelGains[level];
    if (!gainNode) return;
    const g = gainNode.gain;
    const ctx = this.engine.ctx;

    if (this._pendingChanceGain && this._pendingChanceGain.level === level) {
      this._pendingChanceGain = null;
    }

    // Anti-click floor: a literal 0 fade produces an audible step when target
    // differs from current amp. Force a ~10ms ramp so the transition is
    // inaudible but still "instant" perceptually. At the floor, curve is
    // intentionally ignored (anti-click is linear). Godot parity: 30ms frame
    // floor in `_ramp_level_gain`.
    const isFloor = !(fadeDuration > 0);
    const fd = isFloor ? PFATrack._FADE_ANTICLICK_FLOOR : fadeDuration;

    // Same splice rule as activateLevel: read the LIVE value, cancelScheduledValues(0)
    // to wipe any active fade curve (else the new schedule overlaps it → freeze) while
    // holding that value, then anchor at `now` with NO lookahead. A future splice point
    // leaves a [now, t0) gap that renders the new curve's target — a pop to full / drop
    // to silence. setValueAtTime pins the held value before the ramp.
    const now = ctx.currentTime;
    const t1 = now + fd;
    const v0 = Math.max(0, g.value);
    g.cancelScheduledValues(0);
    g.setValueAtTime(v0, now);
    if (isFloor) {
      g.linearRampToValueAtTime(targetVol, t1);
    } else {
      _applyFadeCurve(g, v0, targetVol, now, fd, curve);
    }
    this._intendedGains[level] = targetVol;
    this._rampState[level] = { startTime: now, endTime: t1, fromVal: v0, toVal: targetVol };
  }

  /**
   * Stop all pre-started level sources and disconnect gains.
   */
  stopAllLevels() {
    for (const source of Object.values(this._levelSources)) {
      try { source.stop(); } catch(e) {}
    }
    for (const gainNode of Object.values(this._levelGains)) {
      try { gainNode.disconnect(); } catch(e) {}
    }
    for (const gainNode of Object.values(this._variationGains)) {
      try { gainNode.disconnect(); } catch(e) {}
    }
    this._levelSources = {};
    this._levelGains = {};
    this._variationGains = {};
    this._variationBarCounter = {};
    this._intendedGains = {};
    this._rampState = {};
    this._activeLevel = null;
    // Reset variation selection for fresh start
    this._variationState = {};
  }

  stopAll() {
    for (const source of this._sources) {
      try { source.stop(); } catch(e) {}
    }
    this._sources = [];
    // Clean up shared variation gain
    if (this._variationGains['shared']) {
      try { this._variationGains['shared'].disconnect(); } catch(e) {}
    }
    this._variationGains = {};
    this._variationBarCounter = {};
  }

  _getBufferAndClip(level, pickVariation = false) {
    let buffers, clips;

    if (this.levelBehavior === 'always_play' || this.levelBehavior === 'level_conditional') {
      buffers = this._sharedBuffers;
      clips = this.sharedClips;
    } else {
      buffers = this._buffers[level] || this._buffers[0];
      clips = this.levelClips[level] || this.levelClips[0] || [];
    }

    if (!buffers || buffers.length === 0) return { buffer: null, clip: null };

    // SFX picks a fresh variation per trigger (editor parity: core/sfx_event.py
    // trigger() rolls switch_chance, then switch_variation() → pick_random_variation).
    // Music leaves the pool's current to the Conductor (_switchVariation, JIT Stop+Start, doc/08).
    const lvlKey = this._variationKey(level);
    if (pickVariation && buffers.length > 1) {
      const ld = this.levelSamples[level] || this.levelSamples[0];
      const switchChance = ld ? (ld.switchChance ?? 100) : 100; // always_play has no level data → 100
      if (switchChance > 0 && Math.random() * 100 <= switchChance) {
        this._pickVariation(buffers, clips, lvlKey);
      }
    }

    const idx = Math.min(this.currentVariation(lvlKey), buffers.length - 1);
    const buffer = buffers[idx];
    const clip = clips ? clips[idx] : null;

    return { buffer, clip, variation: idx, variationCount: buffers.length };
  }

  /** Variation-pool key for a level: shared behaviors rotate ONE pool,
   *  level_specific one pool PER level (editor: Multisample._get_level_state()). */
  _variationKey(level) {
    return (this.levelBehavior === 'always_play' || this.levelBehavior === 'level_conditional')
      ? 'shared' : level;
  }

  /** Per-pool rotation state accessor — auto-creates (editor: _get_level_state()). */
  _varState(lvlKey) {
    if (!this._variationState[lvlKey]) {
      this._variationState[lvlKey] = { current: 0, bag: [] };
    }
    return this._variationState[lvlKey];
  }

  /** Current variation index of a pool (editor: LevelState.current_variation_index). */
  currentVariation(lvlKey) {
    return this._varState(lvlKey).current;
  }

  /** Set a pool's current variation (restart paths + tests). */
  setCurrentVariation(lvlKey, idx) {
    this._varState(lvlKey).current = idx;
  }

  /**
   * Pick next sample variation based on randomization_algo.
   * Rotation state (current index + no_repeat bag) lives per pool — `lvlKey`
   * from _variationKey(level) — and the pick COMMITS into that pool's current.
   * @param {AudioBuffer[]} buffers
   * @param {Object[]} clips - clip objects with weight property
   * @param {string|number} lvlKey - pool key: 'shared' or level
   * @returns {number} - selected index (committed to the pool)
   */
  _pickVariation(buffers, clips, lvlKey) {
    const count = buffers.length;
    const state = this._varState(lvlKey);
    if (count <= 1) {
      state.current = 0;
      return 0;
    }
    const prev = state.current;
    let picked = prev;

    switch (this.randomizationAlgo) {
      case 'weighted': {
        // Weighted selection by clip weights
        picked = count - 1;
        const weights = [];
        for (let i = 0; i < count; i++) {
          weights.push(clips?.[i]?.weight ?? 1.0);
        }
        const total = weights.reduce((a, b) => a + b, 0);
        if (total <= 0) {
          picked = Math.floor(Math.random() * count);
          break;
        }
        let rand = Math.random() * total;
        for (let i = 0; i < count; i++) {
          rand -= weights[i];
          if (rand <= 0) { picked = i; break; }
        }
        break;
      }

      case 'no_repeat': {
        // Shuffle bag: play all variations before repeating, never same twice in a row
        if (state.bag.length === 0) {
          // Refill: all indices except current (to avoid repeat at bag boundary)
          state.bag = Array.from({ length: count }, (_, i) => i);
          // Fisher-Yates shuffle
          for (let i = state.bag.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [state.bag[i], state.bag[j]] = [state.bag[j], state.bag[i]];
          }
          // If first in new bag is same as last played, move it to the end
          if (state.bag[0] === prev && count > 1) {
            state.bag.push(state.bag.shift());
          }
        }
        picked = state.bag.shift();
        break;
      }

      case 'random':
      default: {
        // Pure random (may repeat)
        picked = Math.floor(Math.random() * count);
        break;
      }
    }

    state.current = picked;
    return picked;
  }

  /**
   * Decide play or silence based on play_chance_mode.
   * Replaces inline Math.random() rolls in triggerSfx/Conductor.
   */
  _rollPlayChance(level) {
    const levelData = this.levelSamples[level] || this.levelSamples[0];
    const playChance = levelData ? (levelData.playChance ?? 100) : 100;
    if (playChance >= 100) return true;
    if (playChance <= 0) return false;

    switch (this.playChanceMode) {
      case 'weighted_history': {
        const plays = this._chanceConsecutivePlays[level] || 0;
        const silences = this._chanceConsecutiveSilences[level] || 0;
        let adjusted = playChance;

        // Balanced step sizes: p * stepDown = (1-p) * stepUp
        // ensures E[adjusted] = playChance (no systematic bias)
        const p = playChance / 100;
        const baseStep = 5;
        const maxUp = 95 - playChance;
        const maxDown = playChance - 5;
        let stepDown, stepUp;

        if (playChance >= 50) {
          stepDown = baseStep;
          stepUp = baseStep * p / (1 - p);
          // If compensated stepUp exceeds available range, scale both down
          if (stepUp > maxUp) {
            stepUp = maxUp;
            stepDown = maxUp * (1 - p) / p;
          }
        } else {
          stepUp = baseStep;
          stepDown = baseStep * (1 - p) / p;
          if (stepDown > maxDown) {
            stepDown = maxDown;
            stepUp = maxDown * p / (1 - p);
          }
        }

        if (plays > 0) adjusted = playChance - Math.min(plays, 5) * stepDown;
        if (silences > 0) adjusted = playChance + Math.min(silences, 5) * stepUp;
        adjusted = Math.max(5, Math.min(95, adjusted));

        const passed = Math.random() * 100 < adjusted;
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
          bag = this._refillChanceShuffleBag(level, playChance);
        }
        return bag.shift();
      }
      default: // true_random
        return Math.random() * 100 < playChance;
    }
  }

  _refillChanceShuffleBag(level, playChance) {
    const size = this._chanceShuffleBagSize;
    const numPlays = Math.round(size * playChance / 100);
    const bag = [];
    for (let i = 0; i < numPlays; i++) bag.push(true);
    for (let i = 0; i < size - numPlays; i++) bag.push(false);
    // Fisher-Yates shuffle
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this._chanceShuffleBags[level] = bag;
    return bag;
  }

  _ensureGain(destination) {
    if (!this._trackGain) {
      this._trackGain = this.engine.ctx.createGain();
      // Start silent to prevent click, volume set by playMusic/crossfade
      this._trackGain.gain.value = 0;
      this._trackGain.connect(destination);
    }
    const now = this.engine._now();
    this._trackGain.gain.setValueAtTime(this.volume, now);
  }

  /** Apply pitch + rate randomization to an SFX source's playbackRate. */
  _applySfxPitchRate(source, iv = null) {
    // Random pitch (semitones) + the intensity-curve semitone offset, summed in
    // semitones, then a separate random rate multiplier on top.
    const pitchSt = this._getRandomParam('pitch') + (iv ? iv.pitchSt : 0);
    if (pitchSt !== 0) source.playbackRate.value = Math.pow(2, pitchSt / 12);
    const rate = this._getRandomParam('rate');
    if (rate !== 0) source.playbackRate.value *= rate;
  }

  /** Linear gain multiplier from the (dB) volume randomization param. 1.0 if disabled. */
  _volumeRandLinear() {
    const volDb = this._getRandomParam('volume');
    return volDb !== 0 ? Math.pow(10, volDb / 20) : 1.0;
  }

  /**
   * Apply a one-shot SFX fade envelope to a per-voice gain param, mirroring the
   * editor's RegionClip._apply_fades: linear amplitude ramps, fade_out only fires
   * for the one-shot SFX window. Fades are positioned relative to the trim window
   * [startTime, startTime + playLen]. No fades -> steady gain at `target`.
   * @param {AudioParam} gainParam  the per-voice gain's .gain param
   * @param {number} target         steady-state amplitude (track/clip volume x volume-rand)
   * @param {number} startTime      scheduled source start (ctx time, incl. delay randomization)
   * @param {number} playLen        playback window length in seconds
   * @param {object|null} clip      parsed clip (fadeIn/fadeOut in seconds), may be null
   */
  _applySfxFadeEnvelope(gainParam, target, startTime, playLen, clip, looping = false) {
    let fadeIn = clip ? (clip.fadeIn || 0) : 0;
    let fadeOut = clip ? (clip.fadeOut || 0) : 0;
    // Looping spatial ambience: the window-end fade-out would mute the loop after
    // one pass, so drop it (the fade-in still applies once at start).
    if (looping) fadeOut = 0;

    if (fadeIn <= 0 && fadeOut <= 0) {
      gainParam.setValueAtTime(target, startTime);
      return;
    }

    // Clamp so both fades fit inside the window (preserve their ratio).
    if (playLen > 0 && fadeIn + fadeOut > playLen) {
      const scale = playLen / (fadeIn + fadeOut);
      fadeIn *= scale;
      fadeOut *= scale;
    }

    // Fade in: linear 0 -> target over [startTime, startTime + fadeIn].
    if (fadeIn > 0) {
      gainParam.setValueAtTime(0, startTime);
      gainParam.linearRampToValueAtTime(target, startTime + fadeIn);
    } else {
      gainParam.setValueAtTime(target, startTime);
    }

    // Fade out: linear target -> 0 ending at the window end (one-shot only).
    if (fadeOut > 0) {
      gainParam.setValueAtTime(target, startTime + playLen - fadeOut);
      gainParam.linearRampToValueAtTime(0, startTime + playLen);
    }
  }

  _getRandomParam(paramName) {
    const param = this.randomization[paramName];
    if (!param || !param.enabled) return 0;
    const min = param.min || 0;
    const max = param.max || 0;
    return min + Math.random() * (max - min);
  }
}


/**
 * Internal: event group with shared volume.
 */
class PFAGroup {
  constructor(data) {
    this.name = data.name || '';
    this.volume = data.volume || 1.0;
    this.eventNames = data.events || [];
  }
}


// ── Spatial Audio Classes ────────────────────────────────────────────

/**
 * A playing spatial audio voice. Wraps source + panner chain.
 */
// Anti-click floor (ms) for DIRECT spatial-voice stops — stop(0)/destroy(0)/stopAll(0)/
// voice-steal on a release_fade:0 event. A LOOP cut mid-wave by a bare source.stop() is a
// step discontinuity = audible click (web-billiards ball_roll stop repro, sess28); one-shots
// end at a natural zero and never hit this path. 20ms matches the engine's own sub-level
// stop micro-fade. Event-routed stops (PFA.stop → event gain) have their own anti-click.
const SPATIAL_STOP_FLOOR_MS = 20;

class PFASpatialVoice {
  constructor(id, source, pannerNode, distanceGain, voiceGain, emitter, mode, pos, cfg, track, releaseMs = 0) {
    this.id = id;
    /** @private */ this._source = source;
    /** @private */ this._pannerNode = pannerNode;
    /** @private */ this._distanceGain = distanceGain; // null for 3D
    /** @private */ this._voiceGain = voiceGain;
    /** @private */ this._emitter = emitter;
    /** @private */ this._mode = mode;
    /** @private */ this._pos = { x: pos.x, y: pos.y, z: pos.z || 0 };
    /** @private */ this._cfg = cfg;
    /** @private */ this._playing = true;
    /** @private */ this._track = track;
    /** @private */ this._releaseMs = releaseMs; // no-arg stop() fade = event release_fade (ms)
    // Doppler state: the spawn-time playbackRate (pitch/rate randomization baked
    // in) is the base the per-frame doppler ratio multiplies ON TOP of; _dopPrev
    // is last frame's position (null until the second update seeds a velocity).
    /** @private */ this._basePlaybackRate =
      (source.playbackRate && typeof source.playbackRate.value === 'number')
        ? source.playbackRate.value : 1.0;
    /** @private */ this._dopPrev = null;
    // Distance-LPF highshelf (3D only; null when off/2D) — assigned by
    // _spawnSpatialVoice, retargeted per frame, disconnected in _cleanup.
    /** @private */ this._lpf = null;

    source.onended = () => {
      this._playing = false;
      // Clean up track._sources
      if (this._track) {
        const idx = this._track._sources.indexOf(source);
        if (idx >= 0) this._track._sources.splice(idx, 1);
      }
    };
  }

  isPlaying() {
    return this._playing;
  }

  /**
   * Stop with optional fade. With NO argument, falls back to the event's authored
   * release_fade (ms); pass an explicit number to override. Every stop is floored
   * to SPATIAL_STOP_FLOOR_MS — 0 means "as fast as click-free allows", not a hard cut.
   * @param {number} [fadeMs]
   */
  stop(fadeMs) {
    if (!this._playing || this._stopping) return;
    // Cancel a pending smart-loop re-trigger so the loop ends here.
    if (this._reloopTimer) { clearTimeout(this._reloopTimer); this._reloopTimer = null; }
    let ms = (fadeMs != null) ? fadeMs : this._releaseMs;
    if (this._voiceGain) ms = Math.max(ms, SPATIAL_STOP_FLOOR_MS);
    try {
      if (ms > 0 && this._voiceGain) {
        const ctx = this._voiceGain.context;
        const now = ctx.currentTime + 0.005;
        const cur = this._voiceGain.gain.value;
        // Drop any scheduled clip-fade envelope so the stop fade is clean
        this._voiceGain.gain.cancelScheduledValues(now);
        this._voiceGain.gain.setValueAtTime(cur, now);
        this._voiceGain.gain.linearRampToValueAtTime(0, now + ms / 1000);
        // Keep _playing = true through the ramp. _updateSpatialVoices prunes any
        // voice whose isPlaying() is false on the NEXT frame, _cleanup()-ing (i.e.
        // DISCONNECTING) its nodes — which was cutting the release fade to instant
        // silence. Stay alive until the ramp finishes, then stop + mark done.
        this._stopping = true;
        setTimeout(() => {
          this._playing = false;
          try { this._source.stop(); } catch(e) {}
        }, ms + 10);
      } else {
        this._source.stop();
        this._playing = false;
      }
    } catch(e) { this._playing = false; }
  }

  /** Detach from emitter — freeze at current position. */
  detachFromEmitter() {
    this._emitter = null;
  }

  /** @private */
  _cleanup() {
    if (this._reloopTimer) { clearTimeout(this._reloopTimer); this._reloopTimer = null; }
    try {
      if (this._pannerNode) this._pannerNode.disconnect();
      if (this._lpf) this._lpf.disconnect();
      if (this._distanceGain) this._distanceGain.disconnect();
      if (this._voiceGain) this._voiceGain.disconnect();
    } catch(e) {}
  }
}


/**
 * A long-lived spatial emitter attached to a game object.
 * Stores position; voices triggered on it track its position.
 */
class PFASpatialEmitter {
  constructor(id, engine, config) {
    this.id = id;
    /** @private */ this._engine = engine;
    // Store the RAW game-passed config (may be null/partial). It's merged with
    // the event's authored spatial config at trigger time (the event is known
    // only then): _SPATIAL_DEFAULTS ← event.spatial ← this._cfg. Baking full
    // defaults here would mask the event's authored attenuation.
    /** @private */ this._cfg = config || null;
    /** @private */ this._pos = { x: 0, y: 0, z: 0 };
    /** @private */ this._destroyed = false;
  }

  /**
   * Update 2D position.
   * @param {number} x
   * @param {number} y
   */
  setPosition2D(x, y) {
    this._pos.x = x;
    this._pos.y = y;
  }

  /**
   * Update 3D position.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  setPosition3D(x, y, z) {
    this._pos.x = x;
    this._pos.y = y;
    this._pos.z = z;
  }

  /**
   * Trigger a spatial SFX on this emitter.
   * The voice will follow this emitter's position.
   * @param {string} eventName
   * @returns {PFASpatialVoice|null}
   */
  async trigger(eventName) {
    if (this._destroyed) return null;
    // Pass `this` so triggerSpatial links ALL of a multi-track event's voices to the
    // emitter (position tracking + stop-on-destroy + smart-loop ownership).
    const voice = await this._engine.triggerSpatial(eventName, this._pos.x, this._pos.y, this._pos.z, this._cfg, this);
    return voice;
  }

  /**
   * Destroy emitter and stop all its voices.
   * @param {number} [fadeMs] - fade out (ms); omit to use each voice's event release_fade
   */
  destroy(fadeMs) {
    this._destroyed = true;
    // Stop any persistent smart-loop controllers first (cancel their next cycle).
    (this._smartLoops || []).forEach(c => { c.stopped = true; if (c.timer) clearTimeout(c.timer); });
    this._smartLoops = [];
    // Stop voices attached to this emitter. No explicit ms ⇒ each voice falls
    // back to its event's authored release_fade.
    this._engine._spatialVoices.forEach(v => {
      if (v._emitter === this) v.stop(fadeMs);
    });
    const idx = this._engine._emitters.indexOf(this);
    if (idx >= 0) this._engine._emitters.splice(idx, 1);
  }
}


/**
 * PFA Live Connect — WebSocket bridge to PFA Editor for real-time audio tuning.
 * Connects to PFA Editor's Live Server (port 9264) and applies changes in real-time.
 */
class PFALiveConnect {
  constructor(pfa, port = 9264) {
    this.pfa = pfa;
    this.port = port;
    this.ws = null;
    this.connected = false;
    this._statusCallback = null;
    this._logCallback = null;
    this._reconnectTimer = null;
    this._reloading = false;
  }

  connect() {
    // Cancel pending reconnect
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Close existing socket before creating new one
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      // Remove handlers so old socket doesn't trigger reconnect
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) {
        old.close();
      }
    }

    try {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);
      this.ws.onopen = () => {
        this.connected = true;
        this._log('[PFA Live] Connected to editor');
        // Introduce ourselves — the editor can list connected platforms/versions.
        try {
          this.ws.send(JSON.stringify({
            type: 'hello', platform: 'web', engine: PFA.VERSION,
            pack: (this.pfa && this.pfa.config && this.pfa.config.project) || null,
          }));
        } catch (e) {}
        this._statusCallback?.(true);
      };
      this.ws.onclose = () => {
        this.connected = false;
        this._statusCallback?.(false);
        this._scheduleReconnect();
      };
      this.ws.onerror = () => {};
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleMessage(msg);
        } catch (e) {}
      };
    } catch (e) {
      this._scheduleReconnect();
    }
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // Don't trigger reconnect on intentional disconnect
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this._statusCallback?.(false);
  }

  onStatusChange(callback) { this._statusCallback = callback; }
  onLog(callback) { this._logCallback = callback; }
  /** Called after a successful pack reload — the game re-triggers its looping
   *  ambiences / music here (stopAll killed the voices; emitters survived). */
  onReload(callback) { this._reloadCallback = callback; }

  _log(msg) {
    console.log(msg);
    this._logCallback?.(msg);
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), 5000);
  }

  _handleMessage(msg) {
    if (!msg.type) return;

    switch (msg.type) {
      case 'reload':
        // Guard against duplicate reload while one is in progress
        if (this._reloading) {
          this._log('[PFA Live] Reload already in progress, skipping');
          break;
        }
        this._reloading = true;
        this._log('[PFA Live] Reloading audio pack...');
        if (this.pfa.config) {
          const configUrl = this.pfa.basePath + '/config.json';
          this.pfa.stopAll(0.5);
          setTimeout(async () => {
            try {
              this.pfa.events = {};
              this.pfa.groups = {};
              this.pfa.loaded = false;
              await this.pfa.loadPack(configUrl);
              if (this.pfa.preloadAll) {
                await this.pfa.preloadAll();
              }
              this._log('[PFA Live] Audio pack reloaded');
              this._reloadCallback?.();
            } catch (e) {
              this._log(`[PFA Live] Reload failed: ${e.message}`);
            } finally {
              this._reloading = false;
            }
          }, 600);
        } else {
          this._reloading = false;
        }
        break;

      case 'set_volume':
        if (msg.event) this.pfa.setEventVolume(msg.event, msg.volume);
        break;

      case 'set_level':
        if (msg.event) this.pfa.setLevel(msg.event, msg.level);
        break;

      case 'play':
        if (msg.event) this.pfa.play(msg.event);
        break;

      case 'stop':
        if (msg.event) this.pfa.stop(msg.event, msg.fade || 0);
        break;

      case 'trigger':
        if (msg.event) this.pfa.trigger(msg.event);
        break;

      case 'set_group_volume':
        if (msg.group) this.pfa.setGroupVolume(msg.group, msg.volume);
        break;

      case 'set_master_volume':
        this.pfa.setMasterVolume(msg.volume);
        break;

      case 'set_mute':
        if (msg.event) {
          if (msg.muted) {
            this.pfa.duck(msg.event, 0.0, 0.1);
          } else {
            this.pfa.unduck(msg.event, 0.1);
          }
        }
        break;

      case 'duck':
        if (msg.event) this.pfa.duck(msg.event, msg.level, msg.fade);
        break;

      case 'unduck':
        if (msg.event) this.pfa.unduck(msg.event, msg.fade != null ? msg.fade : 0.1);
        break;

      case 'welcome':
        this._log(`[PFA Live] Server: ${msg.message} v${msg.version}`);
        break;
    }
  }
}

/** Engine version (also sent in the Live Connect hello). */
PFA.VERSION = '1.15.0';

// Browser global
if (typeof window !== 'undefined') {
  window.PFA = PFA;
  window.PFALiveConnect = PFALiveConnect;
  window.PFASpatialEmitter = PFASpatialEmitter;
  window.PFASpatialVoice = PFASpatialVoice;
}

export { PFA, PFAEvent, PFATrack, PFAGroup, PFALiveConnect, PFASpatialEmitter, PFASpatialVoice };
export default PFA;
