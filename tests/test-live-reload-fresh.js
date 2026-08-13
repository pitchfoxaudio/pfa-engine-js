#!/usr/bin/env node
/**
 * Live Connect reload — FRESH BYTES contract.
 *
 * Sync rewrites exported files UNDER THE SAME NAMES (<event>_<track>_L<n>_<i>).
 * Two caches key by that unchanged name and made a re-load keep playing
 * yesterday's audio (FV-07 shoot, 2026-08-04):
 *   1. engine-side: _assetStore (compressed bytes, "always kept") and
 *      _decodeCache (PCM) survive the reload chain untouched;
 *   2. browser-side: plain fetch() lets the HTTP cache serve stale bytes —
 *      hard reload does not help, JS-initiated fetches bypass it.
 * Godot has neither cache (pfa.gd re-reads files) — this is a JS-only fix.
 *
 * Contract locked here:
 *   A. PFA.clearAudioCaches() exists, flushes store+decode cache (bank mode
 *      keeps the store: bank bytes ARE the pack and _bankBuffer may already
 *      be released — Sync never rewrites banks, manual ch 10.3/11.4).
 *   B. The live reload chain flushes the caches and arms fresh-fetch mode,
 *      so a re-decode after reload yields the NEW bytes.
 *   C. While fresh-fetch mode is armed, config + audio fetches carry
 *      {cache:'reload'} — UNCONDITIONAL refetch that updates the HTTP cache.
 *      Not 'no-cache': WAV passthrough copies preserve the SOURCE mtime, so
 *      a rewrite can carry an OLDER Last-Modified than the cached entry and
 *      an mtime-based server (python http.server) answers 304 to stale bytes
 *      — conditional revalidation lies when time runs backward (FV-07,
 *      wooden knife_hit surviving no-cache in Chrome).
 *   D. Off by default: a page that never saw a live reload fetches with
 *      default cache semantics (production untouched).
 *
 * Loads the REAL src/index.js. Run: node tests/test-live-reload-fresh.js
 */
const fs = require('fs');
const path = require('path');

function loadEngine() {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  src = src.replace(/^export\s+\{[^}]*\};\s*$/m, '');
  src = src.replace(/^export\s+default\s+PFA;\s*$/m, '');
  src += '\n;return { PFA, PFALiveConnect };';
  return new Function('window', src)(undefined);
}
const { PFA, PFALiveConnect } = loadEngine();

let passed = 0, failed = 0;
function header(t){console.log('\n'+'═'.repeat(70));console.log('  '+t);console.log('═'.repeat(70));}
function assert(c,m){if(c){passed++;console.log('    ✓ '+m);}else{failed++;console.log('    ✗ FAIL: '+m);}}

// Stub ctx: decodeAudioData tags the fake buffer with the first byte of the
// compressed payload, so tests can tell WHICH generation got decoded.
function stubCtx() {
  return {
    currentTime: 0, sampleRate: 44100, state: 'running',
    createGain: () => ({ gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
    decodeAudioData: async (raw) => {
      const tag = new Uint8Array(raw)[0];
      return { _tag: tag, length: 100, numberOfChannels: 1, sampleRate: 44100,
               duration: 100 / 44100, getChannelData: () => new Float32Array(0) };
    },
  };
}

const AUDIO = 'music/main_music_track_1_L0_0.ogg';
const CFG = { version: '1.1', project: 'fresh_fixture', groups: [], events: {} };

// Fetch stub: serves config + audio from a mutable "disk", records every call.
function mkDisk() {
  const disk = { gen: 1, calls: [] };
  global.fetch = async (url, init) => {
    disk.calls.push({ url: String(url), init });
    if (String(url).includes('config.json')) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(CFG)),
               arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([disk.gen, 0, 0, 0]).buffer };
  };
  return disk;
}

async function mkLoadedPfa() {
  const pfa = new PFA();
  pfa.ctx = stubCtx();
  pfa.masterGain = pfa.ctx.createGain();
  const ok = await pfa.loadPack('/audio/config.json');
  return { pfa, ok };
}

(async () => {

header('A. clearAudioCaches() — the public flush');
{
  const disk = mkDisk();
  const { pfa, ok } = await mkLoadedPfa();
  assert(ok === true, 'loadPack parses the fixture config');
  const b1 = await pfa._decodeWithCache(AUDIO);
  assert(b1._tag === 1, 'gen-1 bytes decoded (sanity)');
  disk.gen = 2;
  const b2 = await pfa._decodeWithCache(AUDIO);
  assert(b2._tag === 1, 'without a flush the caches serve gen-1 (the documented trap)');

  assert(typeof pfa.clearAudioCaches === 'function', 'clearAudioCaches() exists on PFA');
  if (typeof pfa.clearAudioCaches === 'function') {
    pfa.clearAudioCaches();
    assert(Object.keys(pfa._assetStore).length === 0 && Object.keys(pfa._decodeCache).length === 0
           && pfa._decodeLRU.length === 0 && pfa._decodedBytes === 0,
           'store + decode cache + LRU + byte counter all flushed');
    const b3 = await pfa._decodeWithCache(AUDIO);
    assert(b3._tag === 2, 'next decode re-fetches: gen-2 bytes');
  } else { failed += 2; console.log('    ✗ FAIL: (skipped flush asserts — no method)'); }
}

header('A2. bank mode keeps the compressed store');
{
  mkDisk();
  const { pfa } = await mkLoadedPfa();
  await pfa._decodeWithCache(AUDIO);
  pfa._bankMode = true; // simulate a bank-booted session (bank buffer may be released)
  if (typeof pfa.clearAudioCaches === 'function') {
    pfa.clearAudioCaches();
    assert(Object.keys(pfa._assetStore).length === 1, 'bank mode: compressed store survives the flush');
    assert(Object.keys(pfa._decodeCache).length === 0, 'bank mode: decode cache still flushed');
  } else { failed += 2; console.log('    ✗ FAIL: (no clearAudioCaches — bank asserts skipped)'); }
}

header('B. live reload chain serves fresh bytes');
{
  const disk = mkDisk();
  const { pfa } = await mkLoadedPfa();
  const b1 = await pfa._decodeWithCache(AUDIO);
  assert(b1._tag === 1, 'pre-reload decode is gen-1');

  disk.gen = 2; // Sync rewrote the file under the same name

  const realST = setTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  try {
    const lc = new PFALiveConnect(pfa);
    lc._handleMessage({ type: 'reload' });
    assert(timers.length === 1, 'swap deferred (fade ring-out)');
    await timers[0].fn();
  } finally { global.setTimeout = realST; }

  const b2 = await pfa._decodeWithCache(AUDIO);
  assert(b2._tag === 2, 'post-reload decode is gen-2 — the stale-audio bug is dead');
}

header('C. fresh-fetch mode bypasses the HTTP cache unconditionally');
{
  const disk = mkDisk();
  const { pfa } = await mkLoadedPfa();
  await pfa._decodeWithCache(AUDIO);

  const realST = setTimeout;
  global.setTimeout = (fn) => { fn(); return 1; };
  try {
    const lc = new PFALiveConnect(pfa);
    lc._handleMessage({ type: 'reload' });
    await new Promise(r => realST(r, 20)); // let the (immediate) swap settle
  } finally { global.setTimeout = realST; }

  const reloadCfg = disk.calls.filter(c => c.url.includes('config.json')).at(-1);
  assert(reloadCfg && reloadCfg.init && reloadCfg.init.cache === 'reload',
         "reload's config fetch carries {cache:'reload'} (unconditional)");
  await pfa._decodeWithCache(AUDIO);
  const audioCall = disk.calls.filter(c => c.url.includes(AUDIO)).at(-1);
  assert(audioCall && audioCall.init && audioCall.init.cache === 'reload',
         "post-reload audio fetch carries {cache:'reload'} (unconditional)");
}

header('D. off by default — production fetches untouched');
{
  const disk = mkDisk();
  const { pfa } = await mkLoadedPfa();
  await pfa._decodeWithCache(AUDIO);
  const cfgCall = disk.calls.find(c => c.url.includes('config.json'));
  const audioCall = disk.calls.find(c => c.url.includes(AUDIO));
  assert(!cfgCall.init || cfgCall.init.cache === undefined, 'boot config fetch: default cache semantics');
  assert(!audioCall.init || audioCall.init.cache === undefined, 'boot audio fetch: default cache semantics');
}

console.log('\n' + '─'.repeat(70));
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
})();
