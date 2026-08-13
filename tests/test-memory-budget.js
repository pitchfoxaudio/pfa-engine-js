/**
 * Memory budget auto-engagement — the "auto-detected by default" contract.
 *
 * README documents setMemoryBudget as "Manual memory budget override (default:
 * auto-detected)". These tests pin WHERE auto-detection engages:
 *   1. loadBank() — bank entries carry byte lengths, so the budget must be set
 *      right after load (a lazy session must not decode forever at Infinity);
 *   2. a manual setMemoryBudget() call before load is respected (never clobbered);
 *   3. preloadAll() — budget must be active BEFORE the first decode, otherwise
 *      the transient peak is the FULL project PCM (~20× bank size) and the final
 *      clamp comes too late for a mobile tab;
 *   4. peak decoded bytes during preloadAll stay near the budget, far below full;
 *   5. paths with no up-front sizes (loose loadPack / raw lazy decodes) engage the
 *      budget once real decoded bytes cross 75% of the platform budget.
 *
 * Self-contained: builds a tiny in-memory .pfabank (same layout as
 * core/exporter.py export_bank), stubs fetch + AudioContext.decodeAudioData.
 *
 * Run: node tests/test-memory-budget.js   (exit 0 = green, 1 = any fail)
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

const MB = 1024 * 1024;

// ── Stub audio context: decodeAudioData returns a fake buffer of fixed PCM size ──
const FAKE_FRAMES = 44100; // 1s stereo Float32 → 44100 × 2 × 4 = ~0.34 MB per file
function stubGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
function stubCtx() {
  return {
    currentTime: 0, sampleRate: 44100, state: 'running',
    createGain: stubGain,
    createStereoPanner: () => ({ pan: { value: 0 }, connect() {}, disconnect() {} }),
    createBufferSource: () => ({ connect() {}, disconnect() {} }),
    decodeAudioData: async () => ({
      length: FAKE_FRAMES, numberOfChannels: 2, sampleRate: 44100,
      duration: FAKE_FRAMES / 44100, getChannelData: () => new Float32Array(0),
    }),
  };
}

// ── Minimal .pfabank builder (mirrors core/exporter.py export_bank layout) ──
function align(n, a) { return Math.ceil(n / a) * a; }
function makeBank(config, audioFiles /* {relPath: byteLength} */) {
  const entries = {};
  let dataLen = 0;
  const chunks = [];
  for (const [rel, len] of Object.entries(audioFiles)) {
    const off = align(dataLen, 16);
    if (off > dataLen) { chunks.push(new Uint8Array(off - dataLen)); dataLen = off; }
    entries[rel] = { offset: off, length: len, codec: 1 };
    chunks.push(new Uint8Array(len).fill(0x4f)); // fake OGG bytes
    dataLen += len;
  }
  config._audio_entries = entries;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(config));

  const HEADER = 64, ENTRY = 32, sectionDirOff = HEADER;
  const jsonOffset = align(sectionDirOff + 2 * ENTRY, 8);
  const dataOffset = align(jsonOffset + jsonBytes.length, 16);
  const fileSize = dataOffset + dataLen;

  const buf = new ArrayBuffer(fileSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  u8.set([0x50, 0x46, 0x41, 0x42, 0x41, 0x4e, 0x4b, 0x00], 0); // "PFABANK\0"
  dv.setUint16(8, 1, true);                 // ver_major
  dv.setUint16(10, 0, true);                // ver_minor
  dv.setUint32(12, HEADER, true);           // header_size
  dv.setUint32(16, 1, true);                // flags
  dv.setBigUint64(20, 0n, true);            // bank_uid
  dv.setBigUint64(28, 0n, true);            // build_uid
  dv.setBigUint64(36, BigInt(sectionDirOff), true);
  dv.setUint32(44, 2, true);                // section_count
  dv.setUint32(48, ENTRY, true);            // section_entry_size
  dv.setBigUint64(52, BigInt(fileSize), true);

  const writeSection = (at, type, off, len) => {
    u8.set(new TextEncoder().encode(type), at);
    dv.setUint32(at + 4, 0, true);
    dv.setBigUint64(at + 8, BigInt(off), true);
    dv.setBigUint64(at + 16, BigInt(len), true);
    dv.setUint32(at + 24, 1, true);
  };
  writeSection(sectionDirOff, 'JSON', jsonOffset, jsonBytes.length);
  writeSection(sectionDirOff + ENTRY, 'DATA', dataOffset, dataLen);

  u8.set(jsonBytes, jsonOffset);
  let cursor = dataOffset;
  for (const c of chunks) { u8.set(c, cursor); cursor += c.length; }
  return buf;
}

// 10 sfx events × 1 track × 2 samples = 20 audio files, 100 KB compressed each
// → estimate 20 files × 100 KB × 20x ≈ 40 MB PCM, huge vs the tiny stub budgets.
function makeFixtureConfig() {
  const events = {};
  const files = {};
  for (let i = 0; i < 10; i++) {
    const s0 = `sfx/mb_e${i}_0.ogg`, s1 = `sfx/mb_e${i}_1.ogg`;
    files[s0] = 100 * 1024; files[s1] = 100 * 1024;
    const clip = { source_offset: 0.0, source_play_length: 0.1, loop_mode: 'loop_source',
                   fade_in: 0.0, fade_out: 0.0, volume: 1.0, weight: 1.0 };
    events[`mb_event_${i}`] = {
      type: 'sfx', volume: 1.0,
      levels: [{ name: 'Level 1' }],
      tracks: [{ name: 't', volume: 1.0, level_behavior: 'level_specific',
                 levels: { '0': { samples: [s0, s1], clips: [clip, clip] } } }],
    };
  }
  const config = { version: '1.1', project: 'membudget_fixture', audio_format: 'ogg',
                   bpm: 120, sample_rate: 44100, groups: [], events };
  return { config, files };
}

async function freshLoadedPFA(platformBudgetBytes) {
  const { config, files } = makeFixtureConfig();
  const bank = makeBank(config, files);
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => bank.slice(0) });
  const pfa = new PFA();
  pfa.ctx = stubCtx();
  pfa.masterGain = pfa.ctx.createGain();
  pfa._getPlatformBudget = () => platformBudgetBytes;
  const ok = await pfa.loadBank('membudget.pfabank');
  return { pfa, ok };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  memory budget — auto-detected by default (loadBank / preloadAll / lazy)');
  console.log('══════════════════════════════════════════════════════════════════════');

  // ── 1. loadBank engages the budget when sizes are known ──
  {
    const { pfa, ok } = await freshLoadedPFA(8 * MB);
    assert(ok === true, 'loadBank() parses the in-memory fixture bank');
    assert(pfa._memoryBudgetBytes !== Infinity,
      `loadBank auto-engages the memory budget (got ${pfa._memoryBudgetBytes === Infinity ? 'Infinity' : (pfa._memoryBudgetBytes / MB).toFixed(1) + ' MB'})`);
  }

  // ── 2. manual budget set before load is never clobbered ──
  {
    const { config, files } = makeFixtureConfig();
    const bank = makeBank(config, files);
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => bank.slice(0) });
    const pfa = new PFA();
    pfa.ctx = stubCtx();
    pfa.masterGain = pfa.ctx.createGain();
    pfa._getPlatformBudget = () => 8 * MB;
    pfa.setMemoryBudget(3);
    await pfa.loadBank('membudget.pfabank');
    assert(pfa._memoryBudgetBytes === 3 * MB,
      `manual setMemoryBudget(3) before loadBank survives (got ${(pfa._memoryBudgetBytes / MB).toFixed(1)} MB)`);
  }

  // ── 3. preloadAll: budget active BEFORE the first decode ──
  {
    const { pfa } = await freshLoadedPFA(2 * MB);
    pfa._memoryBudgetBytes = Infinity; // isolate preloadAll's own engagement from loadBank's
    let budgetAtFirstDecode = null;
    const origDecode = pfa.ctx.decodeAudioData;
    pfa.ctx.decodeAudioData = async (raw) => {
      if (budgetAtFirstDecode === null) budgetAtFirstDecode = pfa._memoryBudgetBytes;
      return origDecode(raw);
    };
    await pfa.preloadAll();
    assert(budgetAtFirstDecode !== null, 'preloadAll decoded at least one file');
    assert(budgetAtFirstDecode !== Infinity,
      `preloadAll sets the budget BEFORE decoding (at first decode: ${budgetAtFirstDecode === Infinity ? 'Infinity' : (budgetAtFirstDecode / MB).toFixed(1) + ' MB'})`);
  }

  // ── 4. peak decoded bytes during preloadAll stay near budget, far below full ──
  {
    const { pfa } = await freshLoadedPFA(2 * MB); // AGGRESSIVE → 1 MB budget
    const filePCM = FAKE_FRAMES * 2 * 4;          // ~0.34 MB
    const fullPCM = 20 * filePCM;                 // ~6.7 MB if nothing evicts
    let peak = 0;
    const orig = pfa._decodeWithCache.bind(pfa);
    pfa._decodeWithCache = async (f) => {
      const b = await orig(f);
      if (pfa._decodedBytes > peak) peak = pfa._decodedBytes;
      return b;
    };
    await pfa.preloadAll();
    const slack = 4 * filePCM; // decode concurrency + the just-decoded file
    assert(peak <= pfa._memoryBudgetBytes + slack && peak < fullPCM / 2,
      `peak decoded stays near budget (peak ${(peak / MB).toFixed(2)} MB, budget ${(pfa._memoryBudgetBytes / MB).toFixed(2)} MB, full ${(fullPCM / MB).toFixed(2)} MB)`);
  }

  // ── 5. safety net with no up-front sizes: budget engages at 75% of platform ──
  {
    const pfa = new PFA();
    pfa.ctx = stubCtx();
    pfa.masterGain = pfa.ctx.createGain();
    pfa._getPlatformBudget = () => 2 * MB;
    // loose-style: compressed bytes appear in the asset store with no bank/entries
    for (let i = 0; i < 10; i++) pfa._assetStore[`sfx/loose_${i}.ogg`] = new ArrayBuffer(1024);
    for (let i = 0; i < 10; i++) await pfa._decodeWithCache(`sfx/loose_${i}.ogg`);
    // 10 × 0.34 MB decoded = 3.4 MB vs 2 MB platform budget → must have engaged
    assert(pfa._memoryBudgetBytes !== Infinity,
      `lazy decodes past 75% of platform budget engage auto-management (got ${pfa._memoryBudgetBytes === Infinity ? 'Infinity' : (pfa._memoryBudgetBytes / MB).toFixed(1) + ' MB'})`);
    assert(pfa._decodedBytes <= pfa._memoryBudgetBytes || pfa._memoryBudgetBytes === Infinity,
      `eviction clamped decoded bytes under the engaged budget (decoded ${(pfa._decodedBytes / MB).toFixed(2)} MB)`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
