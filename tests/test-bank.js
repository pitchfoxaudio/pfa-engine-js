/**
 * .pfabank load path (JS) — the SHIP integration path, parity with loadPack.
 *
 * Proves loadBank's binary parse (magic / version / sections / JSON) creates events
 * and that audio slices come out of the bank LOSSLESS (byte-identical to the loose
 * source file). The decode step (decodeAudioData) is shared with loose mode and is
 * not re-tested here. Loads a real bank exported from 01_footsteps; skips if absent
 * (same convention as the Godot test_bank / footsteps integration).
 *
 * Run: node tests/test-bank.js   (exit 0 = green, 1 = any fail)
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
const { PFA } = loadEngine();

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log('    ✓', m); } else { failed++; console.log('    ✗', m); } }

// Minimal ctx so loadBank skips init() (which needs window.AudioContext, absent in node).
function stubGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
function stubCtx() {
  return { currentTime: 0, sampleRate: 48000, state: 'running',
    createGain: stubGain, createStereoPanner: () => ({ pan: { value: 0 }, connect() {}, disconnect() {} }),
    createBufferSource: () => ({ connect() {}, disconnect() {} }) };
}

const AUDIO_DIR = path.join(__dirname, '..', '..', 'games', '01_footsteps', 'audio');
const BANK = path.join(AUDIO_DIR, 'footsteps.pfabank');

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  .pfabank — loadBank ship path (parity with loadPack)');
  console.log('══════════════════════════════════════════════════════════════════════');

  if (!fs.existsSync(BANK)) {
    console.log(`\n  (bank fixture missing at ${BANK} — skipping; export 01_footsteps with .pfabank)`);
    process.exit(0);
  }

  const nodeBuf = fs.readFileSync(BANK);
  const ab = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => ab });

  const pfa = new PFA();
  pfa.ctx = stubCtx();
  pfa.masterGain = pfa.ctx.createGain();

  const ok = await pfa.loadBank('footsteps.pfabank');
  assert(ok === true, 'loadBank() returns true on a real .pfabank');
  assert(pfa._bankMode === true, 'bank mode flag set');
  assert(pfa._masterVolume === 1.0,
    'bank config without master_volume → unity master (loadBank shares the loadPack intake)');

  const names = Object.keys(pfa.events);
  assert(names.includes('footsteps_walk') && names.includes('footsteps_run'),
    `bank parsed both events (got ${JSON.stringify(names)})`);

  const entries = pfa._bankEntries || {};
  const n = Object.keys(entries).length;
  assert(n > 0, `bank exposes audio entries (got ${n})`);

  assert(Object.keys(entries).every(rel => entries[rel].offset % 16 === 0),
    'every audio entry is 16-byte aligned in the DATA section');

  // Slice losslessness: every entry's bank bytes must equal the loose source file.
  let allLossless = true, checked = 0, firstBad = '';
  for (const rel of Object.keys(entries)) {
    const e = entries[rel];
    const view = new Uint8Array(pfa._bankBuffer, pfa._bankDataOffset + e.offset, e.length);
    const loose = fs.readFileSync(path.join(AUDIO_DIR, rel));
    let same = view.length === loose.length;
    for (let i = 0; same && i < view.length; i++) if (view[i] !== loose[i]) same = false;
    if (!same) { allLossless = false; firstBad = rel; break; }
    checked++;
  }
  assert(allLossless, `all ${checked} bank slices byte-identical to loose source` + (firstBad ? ` (first mismatch: ${firstBad})` : ''));

  console.log(`\n  RESULT: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('    ✗ threw:', e && e.stack || e); process.exit(1); });
