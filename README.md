# PFA Engine — JavaScript

**PitchFox Audio Engine** — adaptive music & SFX runtime for web games, built on the Web Audio API.

It plays audio projects authored in **PFA Studio** (the desktop editor): Studio exports a `config.json` + audio files (or a single `.pfabank`), the engine loads and performs them — adaptive music levels, node-graph transitions, randomized SFX, spatial voices, reverb zones. The same export drives the [PFA Engine for Godot](../godot/addons/pfa_engine/README.md); design once, ship on both.

- Engine version **1.15.x** · config schema **v1.1** · zero dependencies · MIT
- Suite overview & version compatibility: [main README](../README.md)
- Authoring is documented in the **PFA Studio manual** (the editor ships it); this README covers the runtime API.

---

## Install

```bash
npm install pfa-engine
```

```javascript
import { PFA, PFALiveConnect } from 'pfa-engine';
```

Or without a bundler — the engine is a single file, `src/index.js`, with no dependencies:

```html
<script type="module">
  import { PFA } from './pfa-engine.js';
  const pfa = new PFA();
</script>
```

The module also attaches `window.PFA`, `window.PFALiveConnect`, `window.PFASpatialEmitter`, `window.PFASpatialVoice` for non-bundled setups. (To use the file as a classic non-module `<script>`, comment out the `export` lines at the bottom — everything is reachable through the `window` globals.)

## Quick Start

```javascript
import { PFA, PFALiveConnect } from 'pfa-engine';

const pfa = new PFA();

// Optional: live tuning from PFA Studio (volumes, levels, sync-reload)
const live = new PFALiveConnect(pfa);
live.connect();

// Browsers require a user gesture before audio can start
document.addEventListener('click', async () => {
  pfa.init();
  await pfa.loadPack('audio/config.json');   // or: await pfa.loadBank('audio/project.pfabank')
  await pfa.preloadAll({
    onProgress: (loaded, total) => console.log(`Loading ${loaded}/${total}`),
  });
  pfa.play('main_theme');
}, { once: true });

// Game events
function onEnemySpotted() { pfa.setLevel('main_theme', 1); }   // calm → action
function onSafeZone()     { pfa.setLevel('main_theme', 0); }
function onCoin()         { pfa.trigger('coin'); }             // one-shot SFX
function onBossRoom()     { pfa.crossfadeTo('boss_theme', 2.0); }

// Spatial + intensity (see the Spatial section)
function onBallHit(x, y, speed) {
  pfa.triggerSpatial('ball_hit', x, y, { intensity: Math.min(1, speed / 5) });
}
```

Event names come from your Studio project (lowercase, `_` for spaces); `pfa.getEventNames()` lists everything the pack loaded.

---

## Loading & Memory

`loadPack()` / `loadBank()` parse events and groups but decode **no audio** (lazy). An event's samples are decoded on first use — so without preloading, the very first trigger of each event pays a decode cost. Pick a strategy:

### Small game / demo / pack: `preloadAll()`

Warm everything up front, right after loading. Zero first-hit latency. Comparable to FMOD's `Bank.loadSampleData()` for "whole pack = one bank".

```javascript
await pfa.loadPack('audio/config.json');
const result = await pfa.preloadAll({
  onProgress: (loaded, total) => showLoadingBar(loaded, total),
  priority: 'sfx_first',   // 'sfx_first' (default) | 'music_first' | 'none'
  concurrency: 4,          // parallel decodes; auto-detected if omitted (mobile 2, desktop up to 6)
});
// result = { loaded: 17, failed: [] }  — failed files are skipped, not fatal
```

It's an explicit opt-in (not automatic in `loadPack()`) so bigger games keep per-room control, and it's idempotent — the Live Connect reload path re-warms cheaply after every editor Sync.

### Many-room game: `preloadGroup()` per area

Don't `preloadAll()` a big game. Author events into **groups per area/room** in Studio, keep a small "common" group warm (UI, player, footsteps), and preload a room's group when the player enters. Unused decoded audio is evicted automatically under the memory budget (below) — there is no manual unload on web.

```javascript
await pfa.preloadGroup('forest');   // on room enter
await pfa.preload('boss_theme');    // or a single event
```

### Binary bank: `.pfabank`

Studio can export the whole project as one binary bank — one HTTP request instead of dozens, same API after load:

```javascript
await pfa.loadBank('audio/project.pfabank');
await pfa.preloadAll();
pfa.releaseBankBuffer();   // free the raw bank bytes; compressed audio stays for re-decode
```

If you use Live Connect with a bank, point reloads at the loose export afterwards: `pfa.basePath = 'audio'` (Sync always writes loose files).

### Memory management (automatic)

Browsers expand compressed audio ~20× when decoding (1 MB OGG → ~60 MB PCM), so the engine manages decoded memory for you — the FMOD "compressed in memory" pattern:

- Compressed bytes stay in an asset store (~small); decoded PCM lives in an LRU cache.
- `autoManageMemory()` (runs automatically after `preloadAll()`) picks a strategy from the platform budget — mobile ~150 MB, desktop ~500 MB:
  - **FREE** (< 50 % of budget) — decode all, no eviction
  - **MANAGED** (50–75 %) — LRU active, inactive events evicted
  - **AGGRESSIVE** (> 75 %) — strict LRU, only active events stay decoded (console warning)
- Evicted audio is re-decoded from the stored compressed bytes when needed.

| Method | Description |
|--------|-------------|
| `pfa.getMemoryStats()` | `{ zone, platform, compressedMB, decodedMB, budgetMB, platformBudgetMB, usage, cachedFiles, storedFiles }` |
| `pfa.setMemoryBudget(mb)` | Manual budget override (evicts immediately if already over) |
| `pfa.autoManageMemory()` | Re-run platform detection + strategy pick |
| `pfa.events[name].unloadBuffers()` | Manually release one event's decoded buffers |

---

## API Reference

### Lifecycle & Loading

| Method | Description |
|--------|-------------|
| `pfa.init()` | Create the AudioContext (call inside a user gesture) |
| `pfa.loadPack(url)` | Load `config.json` + set up events (no audio decoded yet) |
| `pfa.loadBank(url)` | Load a `.pfabank` binary bank (single fetch), same API after load |
| `pfa.releaseBankBuffer()` | Free the raw bank ArrayBuffer after preloading |
| `pfa.preload(event)` | Decode one event's audio |
| `pfa.preloadGroup(group)` | Decode all events in a group |
| `pfa.preloadAll(options?)` | Decode everything (batched; see Loading above) |
| `pfa.resume()` | Manually resume the AudioContext (rarely needed — auto-resumes on visibility) |

### Music (Simple Mode)

| Method | Description |
|--------|-------------|
| `pfa.play(event)` | Play a music event (anti-click fade-in, stops other music) |
| `pfa.stop(event, fadeSec?)` | Stop. No arg ⇒ the event's authored `release_fade`; explicit number overrides it |
| `pfa.stopTerminal(event, defaultFade = 2.0)` | Stop honoring the current node's `terminal_fade`, falling back to `defaultFade` |
| `pfa.stopAll(fadeSec = 0)` | Stop every playing event + spatial voice (emitters survive — they belong to the game) |
| `pfa.crossfadeTo(event, duration = 2.0)` | Crossfade from current music to another event |
| `pfa.setLevel(event, level)` | Set adaptive level — crossfades per the event's quantization settings |
| `pfa.getLevel(event)` | Current level index |
| `pfa.isPlaying(event)` | Whether the event is playing |
| `pfa.getEventNames()` / `pfa.getGroupNames()` | Loaded event / group names |

### Node Graph (Advanced Mode)

| Method | Description |
|--------|-------------|
| `pfa.navigate(event, trigger)` | Fire a transition by trigger name — returns `true` if one matched |
| `pfa.getCurrentNode(event)` | Current node ID (or `null`) |
| `pfa.toggleSubLevel(event, name, enabled, fade = 0.5)` | Toggle a sub-level layer on/off with a fade |

Node graph activates when the config has `use_nodes: true`. The engine enters the entry node on `play()` (honoring `entry_fade`), auto-advances after `duration_bars × loop_count` when a transition has `auto: true`, falls back to a node's `terminal_fade` when there's no auto transition, fires stingers at transition start, and quantizes per cascade `connection.quantize → node.fade_quantize → event.switchQuantization`.

### SFX

| Method | Description |
|--------|-------------|
| `pfa.trigger(event, options?)` | Trigger a one-shot SFX. `options.intensity` (0..1) = per-trigger hit strength (see Intensity). Returns `played[]` — one entry per track that fired: `{ track, behavior, variation, variationCount, algo, sample }` |

Cooldown (`cooldown_ms`) and voice cap (`max_instances`, oldest voice stolen) are authored per event in Studio and enforced by the engine. `always_play` layers fire on every level; each fired layer picks a fresh sample variation (switch_chance-gated) with clip trim + fades applied.

### Volume & Ducking

| Method | Description |
|--------|-------------|
| `pfa.setEventVolume(event, vol)` | Event volume (linear, 1.0 = unity) |
| `pfa.setGroupVolume(group, vol)` | Group volume (applies live to playing voices) |
| `pfa.setMasterVolume(vol)` | Master volume |
| `pfa.duck(event, level = 0.0, fade = 0.5)` | Duck an event (remembers its volume) |
| `pfa.unduck(event, fade = 0.5)` | Restore after duck |
| `pfa.duckMaster(level = 0.0, fade = 0.5)` | Duck the master output |
| `pfa.unduckMaster(fade = 0.5)` | Restore master |

Volume chain: `clip × track × event × group × master` — all linear, each stage independent.

### Callbacks

```javascript
pfa.onEventStarted    = (name) => {};
pfa.onEventStopped    = (name) => {};
pfa.onLevelChanged    = (name, level) => {};
pfa.onSfxTriggered    = (name, played) => {};          // played[] as returned by trigger()
pfa.onNodeChanged     = (name, nodeId, nodeName) => {};
pfa.onSubLevelToggled = (name, subName, enabled) => {};
pfa.onTransitionInfo  = (name, info) => {};            // see Transition Info below
```

---

## Spatial Audio

The model: **the editor authors how an event behaves in space; the game only passes positions.** Studio writes a per-event `spatial` block (mode, attenuation, panning, filters) into the config; at runtime the engine merges, in order:

```
engine defaults  ←  event.spatial (authored in Studio)  ←  per-call config (game override)
```

so most game code never touches spatial parameters at all.

### Setup

```javascript
pfa.setWorldScale(100);                 // 100 game units = 1 audio meter (default 1.0)
// each frame:
pfa.setListener2D(player.x, player.y);  // 2D games
pfa.setListener3D(cam.x, cam.y, cam.z,  // 3D games: position +
                  fwdX, fwdY, fwdZ,     // forward vector (default 0,0,-1)
                  upX, upY, upZ);       // up vector      (default 0,1,0)
```

Coordinate system is right-handed, +X right, +Y up, −Z forward (Web Audio convention).

### One-shots at a position

```javascript
pfa.triggerSpatial('ball_hit', x, y);            // 2D
pfa.triggerSpatial('explosion', x, y, z);        // 3D (z present ⇒ 3D path)
pfa.triggerSpatial('ball_hit', x, y, { intensity: 0.8 });   // with per-trigger override
```

Returns the first spawned `PFASpatialVoice` (or `null`). Multi-track events spawn one voice per track.

### Emitters — voices that follow a game object

```javascript
const emitter = pfa.createEmitter();          // optional config override, e.g. { mode: '2D' }
emitter.setPosition2D(ball.x, ball.y);        // or setPosition3D(x, y, z) — update each frame
await emitter.trigger('ball_roll');           // voices (incl. loops) now track the emitter

// when the object stops / dies:
emitter.destroy();       // stops all its voices via each event's authored release_fade
emitter.destroy(0);      // "as fast as click-free allows" (20 ms floor), not a hard cut
```

A looping event (authored `loop {enabled, mode}` in Studio) keeps sounding until `destroy()` — `mode: "seamless"` is a native gapless loop, `mode: "smart"` re-triggers per cycle with fresh variation picks and play-chance rolls, crossfaded over 80 ms. `voice.detachFromEmitter()` freezes a voice at its current position.

### The authored `spatial` block

```json
"spatial": {
  "enabled": true, "mode": "2D",
  "model": "inverse", "min_distance": 1.0, "max_distance": 50.0, "rolloff": 1.0,
  "panning_model": "equalpower", "max_pan": 1.0,
  "doppler": 0.0,
  "lpf_enabled": true, "lpf_cutoff_hz": 5000.0, "lpf_db": -24.0
}
```

Game-side overrides use the engine's cfg shape (camelCase, nested attenuation) — pass any subset to `triggerSpatial` / `createEmitter`:

```javascript
{
  mode: '2D' | '3D',
  attenuation: { model, minDistance, maxDistance, rolloff },
  panningModel: 'equalpower' | 'HRTF',
  maxPan: 1.0,          // 0..1 — cap on stereo separation (0.5 ⇒ pan range [-0.5, +0.5])
  doppler: 0,           // 0 = off · 1 = physical · >1 stylized
  lpfEnabled: true, lpfCutoffHz: 5000, lpfDb: -24,
  intensity: 1.0,       // not spatial config — per-trigger velocity, see below
}
```

### Distance, panning, filters

- **Distance models** (`attenuation.model`): `inverse` (default), `linear`, `exponential`. The last 10 % of the radius always tapers to silence so a fast-moving voice can't pop crossing `maxDistance`.
- **2D path**: `StereoPannerNode` pan from horizontal offset + a distance gain node. No distance filter in 2D (matches Godot).
- **3D path**: native `PannerNode` — `panning_model: "HRTF"` gives binaural 3D (headphones); `equalpower` is cheaper. Distance handled by the panner's native model.
- **Distance LPF (3D)**: air absorption, Godot-semantics — a per-voice highshelf at `lpf_cutoff_hz` deepening toward `lpf_db` as distance attenuation falls. **On by default** (5000 Hz / −24 dB — Godot's own node defaults; the two engines deliberately match). Disable with `lpf_enabled: false`.
- **Doppler**: Web Audio removed PannerNode doppler from the spec, so the engine computes it manually per frame from position deltas. `0` = off (default, costs nothing).

### Voice management & stopping

- **`max_instances`** (authored per event, default 8): at the cap the oldest voice is stolen — stopped through its release path, so steals are click-free.
- **Stopping is never a hard cut**: every spatial voice stop — `voice.stop(0)`, `emitter.destroy(0)`, `stopAll(0)`, voice steal — is floored to **20 ms** (`SPATIAL_STOP_FLOOR_MS`). A loop cut mid-wave is a step discontinuity (an audible click); one-shots simply end and never hit this path.
- **`release_fade`** (authored per event): the default stop fade wherever no explicit fade is passed — `stop(name)`, `emitter.destroy()`, voice steal. *How* an event ends lives in the editor, not in game code.

### Intensity (per-trigger velocity)

A normalized 0..1 "how hard was the hit" — like a MIDI note's velocity:

```javascript
pfa.trigger('coin', { intensity: 0.4 });
pfa.triggerSpatial('ball_hit', x, y, { intensity: Math.min(1, relSpeed / 5) });
```

The mapping is **authored in Studio** (the event's `intensity` block: `vol_db` / `pitch_st` ranges + curves) and applied per voice on top of the random variation. Events without an intensity block ignore the value — so the game can always pass it. Identical math in the Godot engine.

Real-world example (the billiards demo, `games/04_billiards/web/`): 5 events — cue strike, ball hit, cushion, pocket, rolling loop — where every trigger passes `clamp01(speed / max_speed)` and one emitter per rolling ball follows it with `setPosition2D` until `destroy()` on stop.

---

## Reverb Zones

Studio can author named **reverb zones** (room, cave, hall…) at project level plus a per-event **send**; the engine builds a global reverb from them:

```json
"reverb_zones": {
  "default_zone": "room",
  "zones": { "room": { "room_size": 0.4, "decay": 0.6, "damping": 0.5, "wet": 0.3,
                        "spread": 1.0, "hipass": 0.0, "predelay_ms": 12.0 } }
}
```

- Events opt in with an authored `reverb: { enabled, send }` — their output taps into the reverb bus at `send × zone.wet`. Everything else stays dry.
- `default_zone` is applied automatically on `loadPack()` — a fully editor-driven game never calls the API at all.

| Method | Description |
|--------|-------------|
| `pfa.setReverbZone(name, { fade = 0.5 }?)` | Switch zones: character (size/decay/damping/spread/predelay/hipass) snaps, wet ramps click-free over `fade`. `null`/`''` ⇒ dry |
| `pfa.getReverbZone()` | Active zone name (`''` = dry) |

Web reverb details:

- **Architecture**: aux send — `predelay → hipass → 8 parallel comb filters + 4 series allpasses (stereo) → wet gain → master`. The dry path is untouched; `dry` in the zone schema is a no-op on web (kept for Godot parity, where it's real).
- **`decay` is a true RT60** (seconds) on web — tail length is independent of `room_size`. (On Godot the tail rides room size; the exporter's per-platform `godot {}` zone overrides exist for exactly this.)
- **`predelay_ms` is a true predelay** on web (plain DelayNode). 
- The reverb core runs as an **AudioWorklet** (sample-accurate, compiled from an inline blob — no extra asset to ship). On browsers/contexts without worklets it falls back to a native-node graph that adds one render quantum (128 samples) of per-loop latency and a slight metallic tint — functional, but worklet is the intended path (HTTPS or localhost).

---

## Musical Timing & Transitions

How the engine performs music (all authored in Studio; nothing here needs game code):

### Pre-start layers
FMOD/Wwise pattern: on `play()` all level layers start simultaneously at gain 0 and stay phase-locked; level switching only ramps gains — no source creation at runtime, no phase drift between layers.

### Conductor (bar-counting scheduler)
A single chained tick per event from `play()` to `stop()`; each tick reads the current bar duration, so per-node BPM changes apply on the next tick. It drives:

- **Play chance** — per-track probability rolled at bar boundaries (never on `navigate()`), with committed state (a track locks for N bars after its roll — rapid navigation can't pump amplitudes). Modes: `true_random`, `weighted_history` (anti-streak), `shuffle_bag` (exact distribution).
- **Sample variation switching** — swap the playing sample at the loop boundary (JIT stop+start, 2 ms micro-crossfade), `switchBars = loopBars × repeatCount`. Algorithms: `random`, `weighted`, `no_repeat` (shuffle bag).
- **Quantized transitions** — level/node switches scheduled at the next bar/beat; a new transition cancels a pending one.

### Transition kinds
Per-connection `kind`: **`crossfade`** (default — old level down while new level up), **`fade_in`** (silence others first, then ramp target from 0), **`fade_out`** (ramp everything to silence, then a deferred switch — superseding transitions cancel the pending switch). A `fade_out → fade_in` chain is flattened by the exporter into one connection with `entry_fade_duration` / `entry_fade_curve`, and the engine ramps the new level from 0 instead of hard-cutting.

### Fade curves
`linear`, `equal_power` (default), `s_curve`, `exponential`, `logarithmic` — applied uniformly to every fade path (crossfades, kinds, chains, terminal/entry fades, event fades). Non-linear curves are precomputed into `Float32Array`s and applied via `setValueCurveAtTime`; both engines share the same curve math for parity.

### Tempo & phase
Per-node `bpm` / `time_signature` (flattened from Tempo nodes by the exporter) update the conductor on entry. `free_tempo` nodes disable quantization (transitions become instant; auto-advance uses `clip_length × loop_count` instead of bar math). `restart_on_entry: true` resets a node's phase on every entry (fresh source, variation pick preserved) instead of staying loop-locked to the event clock.

### Stingers
A one-shot bundle on a transition (`connection.stinger {samples, clips, volume, play_chance, mode}`), fired automatically at the **start** of the fade (t=0 — covering transients that short crossfades would eat). Picker modes `random` / `weighted` / `no_repeat`, with independent history per connection. There is no separate API — stingers are a side effect of transitions.

### Transition Info

`pfa.onTransitionInfo = (eventName, info) => {}` fires per phase — `info.phase` is one of:

| Phase | When |
|-------|------|
| `entry_fade` | entry node fade-in started (on `play()`) |
| `start_fade` | event-level authored `start_fade` applied |
| `transition` | a transition dispatched (`kind`, `direction`, from/to nodes, duration, curve) |
| `fade_out_start` | a `fade_out`-kind transition began its fade-out portion |
| `terminal_fade` | terminal fade-out started (manual `stopTerminal()` or auto-fired) |

Useful for debug overlays and parity test harnesses.

---

## Anti-Click Protection

Every start/stop/switch path has a floor — `0` always means "as fast as click-free allows", never a hard cut:

| Path | Protection |
|------|-----------|
| Play / level activation | 10 ms fade floor (`_FADE_ANTICLICK_FLOOR`) |
| Variation switch | 2 ms micro-crossfade at the splice |
| Spatial voice stop (incl. `destroy(0)`, `stopAll(0)`, voice steal) | 20 ms floor (`SPATIAL_STOP_FLOOR_MS`) |
| Smart-loop cycle seam | 80 ms crossfade |
| Crossfades | gain ramps + source starts scheduled on the same AudioContext clock |

Web Audio's sample-accurate scheduling is why these floors can stay this short (the Godot engine uses 30 ms — frame-based timing needs the wider window).

---

## Live Connect

Real-time tuning from PFA Studio over WebSocket (port **9264**, Studio's Live server):

```javascript
const live = new PFALiveConnect(pfa);        // (pfa, port = 9264)
live.onStatusChange((connected) => { /* show a dot */ });
live.onLog((msg) => console.log(msg));
live.onReload(() => { /* re-trigger your looping ambiences/music */ });
live.connect();      // auto-reconnects every 5 s until the editor appears
live.disconnect();
```

Handled editor commands: `reload` (stop-all + re-fetch config + re-preload), `set_volume`, `set_level`, `play`, `stop`, `trigger`, `set_group_volume`, `set_master_volume`, `set_mute`, `duck`, `unduck`. On **Sync** in Studio the game reloads the pack and fires `onReload` — destroy and re-create your spatial emitters there (see the billiards demo).

---

## Browser Notes

- Call `pfa.init()` / `pfa.loadPack()` inside a user gesture (click/tap) — browsers block audio before one.
- The AudioContext auto-resumes on tab visibility change; `pfa.resume()` exists for manual control.
- Formats: OGG and MP3 decode everywhere that matters; WAV works but is heavy over the network. Studio's OGG export is the safe default.
- The reverb worklet needs a secure context (HTTPS or `localhost`) — otherwise the engine falls back to the native-node reverb automatically.
- Firefox uses the AudioParam fallbacks for listener positioning automatically.

---

## Versions & Compatibility

This package versions independently from the rest of the suite (Studio 0.9.x, Godot addon 0.11.x — the numbers are not aligned by design). The compatibility contract is the **config schema v1.1**: any PFA Studio 0.9.x export plays on this engine. Full matrix: [main README](../README.md#versions--compatibility).

## License

MIT — free for commercial and personal use.

- Website: [pitchfoxaudio.com](https://pitchfoxaudio.com)
- Support the project: [Buy Me a Coffee](https://buymeacoffee.com/pitchfoxaudio)
