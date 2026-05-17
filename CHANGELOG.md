# Changelog

All notable changes to Mosaiq are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while
in 0.x (minor bumps may include breaking changes).

## [0.6.0] — 2026-05-17

The **"v0.6 CreepJS audio trap closed"** release. Closes the v0.5.0
documented "CreepJS Audio yellow-lies still fires (`trap` cross-check)"
limit by reading the upstream CreepJS `src/audio/index.ts` to verify the
exact `trap` formula and switching the runner audio noise model from
per-call PRNG to per-`(buffer, channel)` memoization.

After Phase 6.1 the v0.5.0 visible report hits collapse from **3 → 2**
(only the 2 long-term known-limit reds remain: CreepJS WebGL bold-fail
+ browserleaks-canvas 100% uniqueness). The CreepJS Audio surface now
renders with `<span class="hash">…</span>` instead of `<span class="lies
hash">…</span>` — the yellow severity is gone.

### Fixed

- **Phase 6.1 — CreepJS Audio `trap` cross-check closed**
  (`runner.ts §6` + `runner.ts §11` worker IIFE mirror).

  **Root cause investigation** (read CreepJS upstream `src/audio/index.
  ts`): the `trap` HTML field is rendered from CreepJS's `noise =
  noiseFactor || sum(unique(bins.slice(0, 100)))`, and `if (noise) lied
  = true` documents an `'AudioBuffer'` lies entry. `noiseFactor` is
  computed by `getNoiseFactor()` which writes a canary
  `AUDIO_TRAP = Math.random()` into 3 indices via
  `getChannelData(0)[start/mid/end] = rand`, then cross-checks survival
  via `copyFromChannel + repeated reads`. v0.5.4c's per-call PRNG
  model meant subsequent reads overwrote the caller's writes with new
  noise → `result Set` had many noise values → `noiseFactor != 0` →
  yellow lies fired. Earlier hypotheses (`Function.prototype.toString`
  proxy detection, sample-mismatch only) were both off the mark; the
  actual surface was a `getNoiseFactor()` aggregate cross-check across
  all three AudioBuffer access methods.

  **Fix (Path A — per-`(buffer, channel)` memoization)**: module-level
  `WeakMap<AudioBuffer, Set<number>>` (`noisedChannels`) tracks which
  `(buffer, channel)` tuples have been noised. `ensureNoised(buf, ch,
  underlying)` applies noise once (Phase 5.2b skip-zero rule
  preserved); subsequent calls early-return. The 3 hooks share
  `ensureNoised` with these rules:

  - `getChannelData`: lazy noise on first read; subsequent reads
    return underlying as-is (caller writes between reads survive).
  - `copyFromChannel`: forces `ensureNoised` on underlying before
    native copy → `dest` is byte-equal to `getChannelData(ch)`.
  - `copyToChannel`: native call writes caller's source into
    underlying; **no noise added**, just `set.add(channel)` to mark
    the buffer as synced (subsequent `ensureNoised` early-returns
    keep caller data canonical).

  Worker IIFE mirrored with the same `_noisedChannels = new WeakMap()`
  + `_ensureNoised(buf, ch, arr)` pattern; `WeakMap` and `Set` are
  available in the Worker realm.

  Bench-verified (`bench/results/2026-05-17T08-36-26-115Z`):
  - `<span class="hash">02204f20</span>` (no `lies` class — yellow severity gone)
  - `trap: 0.8392229921637789` (plain, no `<span class="bold-fail">`
    digits → `noise = 0` → CreepJS renders raw `AUDIO_TRAP` value)
  - `data: b0333c80 == copy: b0333c80` (cross-method byte-equal —
    `getChannelData` and `copyFromChannel` return identical [4500..4600] sample window)

### Documented (known limitations)

- **CreepJS WebGL bold-fail persists for all 4 built-in profiles**
  (carried over from v0.4 / v0.5, unchanged). Phase 5.3 capture +
  convert pipeline remains the long-term path; user-contributed real-
  hardware captures may hit a CreepJS-whitelisted hash. Blind brute-
  force remains mathematically infeasible (per-attempt hit probability
  ≈ 5.5e-8).
- **browserleaks-canvas uniqueness 100%** (carried over): by-design
  per-persona unique canvas hash; not a "leak" in any meaningful
  sense, but still appears in the visible report.

### Bench

- **Phase 6.1 12-site re-run** (`bench/results/2026-05-17T08-36-26-115Z`).
  12/12 sites OK. Total visible hits **3 → 2**. CreepJS Audio surface
  hash now plain (no `lies` class); only the 2 long-term known-limit
  reds remain.

### Tests

- **sdk**: 366 → 378 (+12). Breakdown:
  - +8 `runner-audio` (Phase 6.1: idempotence, caller-write-survives,
    CreepJS getNoiseFactor() replay → noiseFactor === 0, per-channel
    isolation, copyFromChannel-as-entry, silent-buffer cross-method,
    copyToChannel preserved cross-method, multi-buffer cache safety).
  - +2 `runner-worker` static IIFE assertions (`_noisedChannels`
    WeakMap + `_ensureNoised` early-return + `set.add(ch)` on
    copyToChannel).
  - +2 `runner-worker` sandbox execution (Phase 6.1 idempotent re-read,
    caller-write-survives in worker IIFE).
  - 1 outdated 5.4c test ("copyToChannel writes noise-baked source")
    rewritten to the new 6.1 contract (caller data preserved).
- **persona-schema**: 26 → 26 unchanged (no schema changes in 6.1).
- **typecheck clean**: persona-schema + sdk + desktop all `tsc --noEmit`
  pass.

### Internal

- **`bench/PHASE-6-PLAN.md`** added documenting the v0.6 plan with the
  upstream-verified CreepJS trap formula, before/after trace of
  `getCopyFrom` / `getCopyTo` / `getNoiseFactor` flows under both
  v0.5.4c (broken) and v0.6.1 (fixed) hooks, and Path A vs Path B
  rationale.

---

## [0.5.0] — 2026-05-17

The **"v0.5 audio dB-noise + bench-driven CreepJS audio fix + real-hardware
WebGL pipeline"** release. Closes the v0.4 AnalyserNode dB-scale silent-
quantize limitation, eliminates the CreepJS audio bold-fail introduced by
the Phase 4.1 hook (discovered via Phase 5.2 12-site bench re-run), and
ships a complete real-hardware WebGL profile capture + convert workflow
so non-trivial CreepJS whitelist hits become attainable.

- **Phase 5.1**: AnalyserNode dB-domain noise (`audioNoiseAmplitudeDb`).
- **Phase 5.2 / 5.2b**: 12-site bench re-run revealed CreepJS audio
  bold-fail (Phase 4.1 regression); fixed by skipping zero samples in
  the AudioBuffer hook so silent-region pattern matches real Chrome.
- **Phase 5.3**: `bench/capture-real-webgl-profile.html` + `bench/convert-
  captured-profile.ts` — end-to-end capture workflow for users to
  contribute authentic GPU profiles to `KNOWN_PROFILES`.
- **Phase 5.4**: bench `extractCreepjs` parser noise eliminated; the
  v0.5.0 documented `bold-fail: <unknown>` 22-line phantom block in
  bench reports collapses to 0, leaving only the 2 real surface markers
  visible.
- **Phase 5.4b**: convert-captured-profile gains a software-renderer
  diagnostic (Microsoft Basic Render Driver / SwiftShader / llvmpipe /
  generic). Surfaced from real-world capture testing — when a user
  runs the capture page in a browser with hardware acceleration off,
  the tool now flags the situation and tells them how to recapture
  against real GPU hardware.
- **Phase 5.4c**: AudioBuffer `copyFromChannel` / `copyToChannel` hooks
  added (main scope + worker IIFE mirror). Source-level investigation of
  CreepJS `audio.ts` showed the v0.5.0 hypothesis (`Function.prototype.
  toString` / proxy detection cross-check) was wrong; the actual surface
  is a `trap` aggregate across all 3 methods. 5.4c shifted the lies
  hash `b726173b → 17db53bb` (one path closed) but did **not** clear the
  yellow signal — see Documented (known limitations) below.

### Added

- **Phase 5.1 — `audioNoiseAmplitudeDb` field**
  (`packages/persona-schema/src/persona.ts` + 4 templates): New
  `AudioFingerprintSchema.noiseAmplitudeDb` (Zod default `0.001`,
  bounds `[0, 5]`). Wired through `InjectionConfig.audioNoiseAmplitudeDb`
  to `runner.ts` AnalyserNode hook. Replaces the v0.2-v0.4 PCM-only
  `audioNoiseAmplitude=1e-7` which was silently quantized in dB scale
  (Float32 ULP @ -100 dB ≈ 1.19e-5; 1e-7 noise rounds to baseline). The
  new default 0.001 dB ≈ 42× ULP — guaranteed visible, far below human
  JND (~1 dB) and audio-application thresholds. PCM path unchanged
  (still 1e-7, which is correct for the [-1, 1] range). 5 new persona-
  schema tests + 2 new sdk runner-audio tests.
- **Phase 5.3 — `bench/capture-real-webgl-profile.html`**: Self-
  contained capture page (no network requests). Reads
  `UNMASKED_VENDOR_WEBGL` + `UNMASKED_RENDERER_WEBGL` via
  `WEBGL_debug_renderer_info`, then queries 28 WebGL1 + 30 WebGL2
  capability params matching the GL constants exposed by `runner.ts`.
  Emits a versioned JSON payload (`schemaVersion: mosaiq-webgl-capture/1`)
  with a local-computed CreepJS hash preview (capabilitiesHash +
  brandCapabilities) so the user can sanity-check their hardware before
  submitting.
- **Phase 5.3 — `bench/convert-captured-profile.ts`** (new tsx CLI):
  Reads capture JSON from stdin or `--file <path>`, verifies against
  the same CreepJS whitelists used by `verify-creepjs-profile-hash.ts`,
  emits a paste-ready `WebglProfile` TypeScript snippet for
  `webgl-profiles.ts`. Auto-suggests a profile id and `matchRenderer`
  regex from the captured renderer string. Uses the live `GL.*`
  constant map for readable output (falls back to hex literals for
  unmapped params; entries sorted by hex key for stable diffs).
  `--self-test` invariant locks the round-trip pipeline against
  `INTEL_UHD_730_D3D11` capHash `2146264057`. 22 new vitest cases
  (parse / verify / brand classification / id suggestion / regex
  suggestion / TS emission / round-trip).
- **`bench:verify-creepjs` + `bench:convert-profile` scripts**
  (`packages/sdk/package.json`): expose the two whitelist tools through
  `pnpm run` (`pnpm exec tsx` is not in the bin shim path on Windows).
- **Phase 5.4b — `detectSoftwareRenderer` helper** in
  `bench/convert-captured-profile.ts`: classifies an unmasked renderer
  string as software fallback (Microsoft Basic Render Driver,
  SwiftShader, Mesa llvmpipe, generic Software Rasterizer) and returns
  a contextual `{label, hint}` so the CLI can render a yellow warning
  block before the verdict. Closes a real-world UX gap — a Phase 5.4b
  test pass exercised by an actual user capture (Edge with
  hw-accel off) showed the convert tool happily emits a paste-ready
  snippet for a Microsoft-WARP profile that's anti-detection-
  counterproductive (CreepJS whitelist mathematically can't hit
  software-only hashes; persona claiming "Win11 + Chrome 147 + no GPU"
  is itself an outlier on amiunique / fingerprint-scan). 7 new tests
  cover the 4 software-renderer patterns + 3 negative controls (Intel
  iGPU / NVIDIA RTX / AMD RX must NOT match).

### Fixed

- **Phase 5.2b — CreepJS audio bold-fail eliminated**
  (`runner.ts §6` + `runner.ts §11` worker IIFE mirror). Bench-driven
  fix. The Phase 5.2 12-site re-run (the first since Phase 4.1 landed in
  v0.4) surfaced `creepjs.com Audio` bold-fail. Root cause: Phase 4.1
  hook applied PRNG noise to all 5000 samples including the silence
  region; CreepJS audio test renders `OfflineAudioContext +
  DynamicsCompressor` where pre-attack samples are exact 0 on real
  Chrome. Adding any noise to those zeros produced `unique:5000` (every
  sample distinct), which CreepJS bold-fails. Fix: skip the
  `buf[i] = s + n` write when the original sample is exact 0. PRNG still
  advances every iteration (deterministic sequence + per-channel XOR
  seed unchanged); non-zero samples receive identical noise. Worker
  IIFE updated symmetrically. Bench result: creepjs Audio severity
  dropped **bold-fail (red) → lies (yellow)** — the bold-fail signal
  CreepJS uses to gate WebGL fallback no longer fires on the audio
  surface. 3 new vitest cases pin the silent-sample preservation
  invariant; worker IIFE static assertion rewritten to lock the new
  `var s=...|var n=...|if(s!==0)` pattern.
- **Phase 5.4 — bench parser noise eliminated**
  (`packages/sdk/bench/sites.ts` `extractCreepjs`). The v0.5.0 12-site
  bench report `creepjs.html` carried 22 phantom `bold-fail: <unknown>`
  entries with single-character hashes (`hash=2`, `hash=5`, `hash=.`,
  …). Root cause: the page-side extractor selected the over-broad
  `span.lies, span.bold-fail` and fell back to `surface = '<unknown>'`
  when the previous sibling was not `<strong>`. CreepJS uses the bare
  `lies`/`bold-fail` classes for **inline character-level hash
  highlighting** (e.g. `<span class="bold-fail">2</span>` digits inside
  the AudioBuffer trap-value debug text), and uses `lies hash` /
  `bold-fail hash` only for surface-level markers. Fix: extract the
  page.evaluate body into an exported `extractCreepjsFromDocument`
  helper and tighten three guards — (1) selector
  `span.lies.hash, span.bold-fail.hash` (CreepJS's own discriminator);
  (2) hash text must match `/^[0-9a-f]{6,12}$/i` (hashMini format);
  (3) `previousElementSibling.tagName === 'STRONG'` is required (drop
  the v0.2 `<unknown>` fallback). Verified against the
  2026-05-17T01-27-18-536Z bench fixture: 24 collected → 2 (the 2 real
  surface markers `WebGL bold-fail#3695ea1d` + `Audio lies#b726173b`
  preserved). Closes the v0.5.0 documented "Bench `report.ts` parser
  noise" limitation. 8 new vitest cases (synthetic + real-fixture) lock
  the discriminator + regex + STRONG-sibling invariants.
- **Phase 5.4c — CreepJS Audio: one of two lies paths closed**
  (`runner.ts §6` + `runner.ts §11` worker IIFE mirror). Hooks added
  for `AudioBuffer.copyFromChannel` and `AudioBuffer.copyToChannel`,
  symmetrically with the existing `getChannelData` hook. Refactored
  `runner.ts §6` to extract a shared `applyAudioNoise(target, channel)`
  helper consumed by all three hooks, guaranteeing identical
  `seed XOR channel` PRNG sequence + Phase 5.2b skip-zero rule across
  access paths. Worker IIFE mirrored with the same shared
  `_applyAudioNoise(arr, ch)` helper internalized via the IIFE string.
  This closes the `getChannelData ↔ copyFromChannel sample mismatch`
  cross-check (CreepJS upstream `src/audio/index.ts`) and shifts the
  lies hash from `b726173b` → `17db53bb` in the post-5.4c bench fixture
  (`bench/results/2026-05-17T04-44-25-195Z`). Yellow severity unchanged
  — a different CreepJS cross-check (`trap` aggregate across all 3
  methods) still fires; see Documented (known limitations) for the
  corrected v0.6 diagnosis. 8 new vitest cases (5 main-scope + 3
  worker-scope sandbox) lock the cross-path noise invariants.

  Trade-off (orthogonal to the remaining lies): when the same buffer is
  read via both `copyFromChannel` AND `getChannelData` in reverse order
  (getChannelData first, then copyFromChannel), the two access paths
  now disagree by ≤ 2× amplitude (~2e-7) because each hook applies
  noise once. CreepJS doesn't probe that order today; any future probe
  would surface as a separate fresh `lies` entry.

### Documented (known limitations)

- **CreepJS Audio yellow-lies still fires (`trap` cross-check)** —
  diagnosis corrected from v0.5.0. Phase 5.4c shifted the lies hash
  but did not clear the yellow severity. Inspecting the post-5.4c
  `creepjs.html` (`bench/results/2026-05-17T04-44-25-195Z`) shows the
  remaining trigger is the CreepJS `trap` field, whose `<div>` `title`
  attribute literally lists `AudioBuffer.getChannelData()` +
  `AudioBuffer.copyFromChannel()` + `AudioBuffer.copyToChannel`. Trap
  appears to be an aggregate sum across the three access paths;
  because Phase 5.4c uses a fresh `mulberry32(seed XOR channel)` PRNG
  per call, repeated reads of the same `[4500..4600]` window draw
  different noise samples each time, so the trap deviates from the
  Chrome baseline value the CreepJS team hardcoded. Two paths forward
  for v0.6: (a) memoize per-`(buffer-id, channel-id, sample-index)`
  noise so all three methods return identical noised samples (closes
  trap; spec change to noise determinism — currently per-call); (b)
  inspect the upstream trap formula and pre-compute a baseline-matching
  noise distribution. Yellow `lies` does not gate the WebGL fallback
  the way `bold-fail` does, and no other detector in the 12-site suite
  penalizes it.
- **CreepJS WebGL bold-fail persists for all 4 built-in profiles**
  (carried over from v0.4, unchanged). Phase 5.3 capture + convert
  pipeline is the long-term path: any user can now contribute an
  authentic capture from their machine that may hit a CreepJS-whitelisted
  hash, growing `KNOWN_PROFILES` beyond the 4 built-ins. Blind brute-
  force remains mathematically infeasible (Phase 2.2 Part 2 math:
  per-attempt hit probability ≈ 5.5e-8). The convert tool always emits a
  paste-ready snippet even on whitelist miss — the GPU-persona
  flexibility benefit (Intel iGPU vs NVIDIA / AMD desktop) applies
  regardless of CreepJS whitelist.

After Phase 5.4 + 5.4b + 5.4c the v0.5.0 visible report hits collapse
to: **2 reds** (CreepJS WebGL bold-fail + browserleaks-canvas 100%
uniqueness) + **1 yellow** (CreepJS Audio `trap` lies, hash shifted
from `b726173b` to `17db53bb` after one of two CreepJS cross-checks
was closed by 5.4c). Down from v0.4's 3 reds + the 22-line phantom
block; all 3 remaining hits are documented above as long-term known
limits.

### Bench

- **Phase 5.2 / 5.4c 12-site re-runs**
  (`bench/results/2026-05-17T01-04-37-334Z` → pre-5.2b;
  `bench/results/2026-05-17T01-27-18-536Z` → post-5.2b;
  `bench/results/2026-05-17T04-44-25-195Z` → post-5.4c). 12/12 sites OK
  all three runs. Total visible hits 28 → 25 → **3** (after Phase 5.4
  parser-noise removal: 22 phantom creepjs `<unknown>` entries dropped,
  leaving the 2 reds [creepjs WebGL bold-fail + browserleaks-canvas
  uniqueness 100%] + 1 yellow [creepjs Audio `trap` lies, hash
  `17db53bb` post-5.4c, was `b726173b` pre-5.4c]). All 3 documented as
  long-term known limits above.

### Tests

- **persona-schema**: 21 → 26 (Phase 5.1 introduced 5 new under
  `AudioFingerprintSchema noiseAmplitudeDb`).
- **sdk**: 318 → 366. Breakdown:
  - +2 `runner-audio` (Phase 5.1 dB-noise visibility + bound).
  - +3 `runner-audio` (Phase 5.2b silent-sample preservation + full-
    silence buffer + PRNG-advance invariant).
  - +22 `convert-captured-profile` (Phase 5.3 round-trip / verify /
    brand / id-suggest / regex-suggest / TS-emit).
  - +8 `sites-creepjs` (Phase 5.4 extractCreepjs discriminator + hex
    regex + STRONG-sibling guard + real bench-fixture regression).
  - +7 `convert-captured-profile` (Phase 5.4b detectSoftwareRenderer:
    Microsoft Basic Render Driver / SwiftShader / llvmpipe / generic
    + 3 real-GPU negative controls).
  - +8 `runner-audio` / `runner-worker` (Phase 5.4c
    `copyFromChannel` / `copyToChannel` cross-path noise invariants;
    5 main-scope + 3 worker-scope sandbox).
- **typecheck clean**: persona-schema + sdk + desktop all `tsc --noEmit`
  pass. **Tests**: 366/366 sdk + 26/26 persona-schema all pass on
  post-5.4c HEAD.

### Internal

- **`bench/PHASE-5-PLAN.md`** added documenting the v0.5 plan.
- **MockAudioBuffer** in `runner-audio.test.ts` gained an optional
  `fill` callback so silent-pattern tests can inject zero buffers
  without ad-hoc Float32Array poking.

---

## [0.4.0] — 2026-05-16

The **"v0.4 audio closure + multi-GPU + chromium-fork bridge"** release.
Closes the last major SDK-level fingerprint gap (audio), broadens GPU
persona choice, and opens the chromium-fork enterprise-detector workstream
with three new patch design specs (no native build yet — chromium-fork
remains in cold storage; see `chromium-fork/STATUS.md`).

- **Phase 4.1 – 4.2**: AudioBuffer hook in main + worker scope.
- **Phase 4.3**: CreepJS WebGL second round — NVIDIA RTX 3060 / AMD RX
  6600 alt profiles + verify pipeline.
- **Phase 4.4**: Enterprise detector landscape + 3 new chromium-fork
  patch design specs (`0002 webgl-renderer`, `0016 headless-bypass`,
  `0017 audio-noise`).

### Added

- **Phase 4.1 — AudioBuffer.getChannelData hook (main scope)**
  (`runner.ts §6`): Closes the classic CreepJS / fp.com / FingerprintJS
  audio fingerprint path (`new OfflineAudioContext() → oscillator + dynamicsCompressor →
  startRendering().then(buf.getChannelData)`), which ran completely
  un-spoofed up to v0.3. In-place mulberry32 noise per channel (seed XOR
  channel index → distinct left/right sequences; amplitude
  `audioNoiseAmplitude=1e-7`, well below 16-bit PCM ULP; inaudible but
  shifts `sum.toString()` enough to make `hashMini` per-persona unique).
  New file `runner-audio.test.ts` (9 tests covering noise injection /
  determinism / per-channel XOR / amplitude bound / out-of-range
  forward / v0.2 regression).
- **Phase 4.2 — AudioBuffer worker IIFE mirror** (`runner.ts §11`):
  Mirrors main-scope §6 hook into worker realm. `workerSpoofPayload`
  carries `audioNoiseSeed` + `audioNoiseAmplitude`. Closes worker-scope
  audio fingerprint path (OfflineAudioContext is exposed to dedicated
  workers; without this hook, CreepJS / fp.com audio probes in workers
  would bypass main-scope spoof entirely). 8 new tests in
  `runner-worker.test.ts` (6 static + 2 sandbox execution asserting
  hook is live with per-channel XOR).
- **Phase 4.3 — NVIDIA RTX 3060 + AMD RX 6600 alt WebGL profiles**
  (`webgl-profiles.ts`): `KNOWN_PROFILES` 2 → 4. Gives users
  detector-friendly GPU persona choice (Intel iGPU vs gaming GPU)
  beyond the Intel UHD 630/730 defaults. Both profiles built from
  public webgl fingerprint databases + ANGLE D3D11 backend reports;
  NVIDIA Ampere differs from Intel iGPU on `MAX_VIEWPORT_DIMS` (32767
  vs 16384), `MAX_TEXTURE_IMAGE_UNITS` (32 vs 16),
  `MAX_3D_TEXTURE_SIZE` (16384 vs 2048), `ALIASED_POINT_SIZE_RANGE`
  ([1, 63] vs [1, 1024]), and Ampere-specific `MAX_SAMPLES=32` +
  `MAX_UNIFORM_BUFFER_BINDINGS=84`. AMD RDNA2 sits closer to Intel iGPU
  on viewport / point-size but matches NVIDIA on texture-unit count and
  3D-texture size.
- **Phase 4.3 — `bench/verify-creepjs-profile-hash.ts`** (new tool):
  Automated verification — runs every `KNOWN_PROFILES` entry through
  the CreepJS `capabilitiesHash` (XOR reduce) + `brandCapabilities`
  (hashMini) algorithms and reports whether the result hits the
  hardcoded whitelist (237 cap hashes + 287 brand hashes). Refactored
  shared CreepJS whitelist data into `bench/creepjs-whitelist-data.ts`
  (lib shared with `find-creepjs-whitelist-fit.ts`).
- **Phase 4.3 — 18 new webgl-profiles tests**: Cover RTX 3060 / RX 6600
  match-renderer regex strictness, key differentiating param values vs
  Intel iGPU, and `selectWebglProfileForPersona` multi-profile
  branching.
- **Phase 4.4 — `docs/ENTERPRISE-DETECTORS.md`** (new doc):
  Comprehensive landscape of 6 commercial bot detectors (Castle.io,
  Imperva ABP, DataDome, Cloudflare BM, PerimeterX, Akamai BM) with
  technical breakdown / Mosaiq SDK current coverage / chromium-fork
  patch candidates + v1.0 priority matrix.
- **Phase 4.4 — 3 new chromium-fork patch design specs** (`chromium-fork/patches/`):
  - `0002-webgl-renderer-spoof.spec.md` (P2): GL_VENDOR / GL_RENDERER
    + 49-param spoof in ANGLE / GPU process layer, replacing SDK
    Proxy path to eliminate `Function.prototype.toString` reverse +
    cross-realm prototype comparison detection risk.
  - `0016-headless-detection-bypass.spec.md` (P2): Strip CDP
    `Page.IsAutomatedTask` method, `HeadlessChrome` UA fragments, and
    `--enable-automation` renderer-side exposure; re-enable WebGL2 +
    ServiceWorker in `--headless=new` mode when `PersonaService` is
    active.
  - `0017-audio-fingerprint-noise.spec.md` (P3): Blink AudioBuffer
    C++-level mulberry32 noise injection, replacing SDK §6 + Phase 4.2
    worker mirror; also resolves the AnalyserNode dB+Float32 ULP
    quantize limitation noted below.
- **`chromium-fork/patches/series.txt`** updated with the 3 new entries
  and priority markers (P0/P1/P2/P3).
- **`chromium-fork/STATUS.md`** updated with Phase 4.4 activity log
  (cold storage status unchanged).

### Documented (known limitations)

- **AnalyserNode dB-scale noise silently quantized** (v0.2 limitation
  surfaced by Phase 4.1 tests): `AnalyserNode.getFloatFrequencyData`
  returns dB values (-100 to 0). The 1e-7 `audioNoiseAmplitude` default
  is far below Float32 ULP at that magnitude (~7.6e-6), so the noise
  is rounded back to baseline. Hook installs cleanly (no regression),
  but produces no observable noise. **PCM path
  (`AudioBuffer.getChannelData`) is unaffected** — value range -1..1
  makes 1e-7 visible. v0.5 will add a separate
  `audioNoiseAmplitudeDb` field for dB-aware noise.
- **CreepJS WebGL bold-fail persists for all 4 built-in profiles**:
  Phase 4.3 verify-tool result — Intel UHD 630/730, NVIDIA RTX 3060,
  AMD RX 6600 all miss both CreepJS whitelists (PASS=0, FAIL=4).
  Confirms Phase 2.2 Part 2 math (blind hit probability ≈ 5.5e-8). Not
  a Mosaiq spoof flaw — real RTX 3060 / RX 6600 users hit the same
  outcome. v0.5+ path is a real-hardware capture pipeline (users
  submit their authentic webglParams; `verify-creepjs-profile-hash`
  reusable as the validator). Phase 4.3 value lies in (a) GPU-persona
  flexibility (iGPU vs gaming card), (b) other detectors
  (`browserleaks-webgl`, `arh-antoinevastel`, `incolumitas`) don't rely
  on the CreepJS whitelist, so alt profiles still spoof effectively.

### Changed

- **`KNOWN_PROFILES` array order preserved** for regex matching priority
  — UHD 630 (`\b630\b` stricter) still leads the array; new NVIDIA / AMD
  entries follow Intel. All 4 regexes are mutually exclusive, so
  order does not affect runtime behavior.
- **`InjectionConfig.audioNoiseSeed` + `audioNoiseAmplitude` now flow
  into `workerSpoofPayload`** alongside existing canvas/webgl fields.

### Verification

- **Tests**: persona-schema 21/21, sdk **316/316** (281 → 316, +35
  since v0.3.0: +9 `runner-audio.test.ts`, +8 `runner-worker.test.ts`
  audio mirror, +18 `webgl-profiles.test.ts` NVIDIA/AMD profile).
- **Typecheck**: clean across 3 packages.
- **`bench/verify-creepjs-profile-hash.ts`**: PASS=0, FAIL=4 (expected
  per Phase 2.2 Part 2 math; see "Documented" above).
- **Bench**: 12-site `baseline-detection.ts` not re-run for this
  release. v0.4 changes are additive (audio hook is `typeof
  AudioBuffer`-guarded; new GPU profiles only match via explicit
  `webglProfileId` or matching renderer regex). No spoof surface
  regression risk on existing personas. v0.5 will include a fresh
  12-site bench run with audio surface validation.

### Migration from 0.3.0

No breaking changes. Persona files saved under 0.3.0 remain valid.

- **Opt into NVIDIA / AMD GPU personas**: Set
  `persona.hardware.gpu.webglProfileId = 'nvidia-rtx-3060-d3d11'` or
  `'amd-rx-6600-d3d11'` and update `webglRenderer` / `webglVendor` to
  match. Existing Intel UHD 630/730 personas continue to work
  unchanged.

---

## [0.3.0] — 2026-05-16

The **"v0.3 defensive depth + measurement accuracy"** release. Builds on
v0.2.0 anti-detection engine with three new phases plus consolidated
Phase 2.5–2.6 work that was deferred from v0.2.0:

- **Phase 2.5 – 2.6** (consolidated): Worker scope full mirror (WebGL
  49-param + OffscreenCanvas) and baseline expanded from 9 → 12 sites.
- **Phase 3.1 – 3.3** (this release): Error.stack frame poisoning hardening,
  bench retry mechanism, Castle.io commercial detector limitation
  documented.

### Added

- **Worker scope full mirror** (`Phase 2.6`): Worker IIFE now mirrors
  main scope WebGL 49-param spoof + OffscreenCanvas noise injection +
  `navigator.webdriver` spoof. Was previously partial (2 WebGL params,
  no canvas). Closes CreepJS worker-scope `does not match` flags. 23
  new tests in `runner-worker.test.ts`.
- **3 new baseline detection sites** (`Phase 2.5`): `arh-antoinevastel`
  (Datadome Fp-Scanner 22-rule three-state detector), `incolumitas`
  (multi-section JSON detector including Worker scope navigator props),
  `fingerprint-scan` (Castle.io commercial bot risk score).
  9 → **12** sites in `bench/baseline-detection.ts`.
- **Phase 3.1 — Error.stack frame poisoning hardening** (`runner.ts §13`):
  Installs V8 `Error.prepareStackTrace` global hook in main + worker
  scopes. Filters suspicious frames (`utilityscript`, `blob:`,
  `puppeteer`, `playwright`, `__playwright__`, `__pwInitScripts`,
  `puppeteerExtra`, `evaluationScript`, `cdp.`, `devtools`) before they
  enter user-visible `error.stack`. Defends against detectors that throw
  `ReferenceError` and inspect stack content for automation signatures.
  10 new unit tests. `Function.prototype.toString` stealth preserved via
  manual `stealthRegistry.set` (no Proxy wrap → avoids source-code leak).
- **Phase 3.2 — bench retry mechanism** (`baseline-detection.ts`):
  `runOneWithRetry` wrapper with exponential backoff (1s/2s/4s).
  `RETRIES=N` env (default 2 = 3 total attempts). `SiteResult.retries`
  field + report metadata surfaces measurement reliability. Prevents
  single flaky site (dbi-bot intermittent 60s gateway timeouts) from
  failing the full bench.
- **2 diagnostic probes** (`bench/probe-error-stack.ts`,
  `bench/probe-fpcollect-source.ts`): Direct-injection scripts for
  rapid Error.stack reconnaissance and fp-collect source inspection.
  Drove the Phase 3.1 implementation + Phase 3.3 Castle.io discovery.

### Changed

- **12-site bench hits**: 5 → **2** (Phase 3 cycle). Remaining 2 hits
  are Phase 2 already-documented limitations:
  - `creepjs WebGL bold-fail` (Phase 2.2 negative reverse-fit, CreepJS
    whitelist gap for Intel UHD 730)
  - `browserleaks-canvas uniqueness=100%` (Phase 2.4 per-persona
    uniqueness tradeoff)
- **`extractIncolumitas.knownBadKeys`**: Removed `'webdriver'`.
  Recon via `probe-fpcollect-source.ts` revealed that incolumitas's
  modified fp-collect uses `webDriver: 'webdriver' in navigator`, which
  is **always true on every modern Chrome user** (W3C WebDriver
  Recommendation 2018+ mandates `navigator.webdriver` to exist). This
  was a false positive in our analyzer, not a spoof leak.
- **`analyzeAntoinevastel.KNOWN_OUTDATED_RULES`**: Added `WEBDRIVER` to
  whitelist. fp-scanner 2017 vintage uses same `'webdriver' in navigator`
  check via fp-collect, predating W3C spec update → flags every modern
  Chrome user as Inconsistent. Now shown as ℹ️ informational, not red flag.
- **`analyzeFingerprintScan` Castle.io demote** (`Phase 3.3`):
  Recon revealed `<script src=".../castle.browser.js">` — fingerprint-scan.com
  is a Castle.io commercial detector marketing demo. 75/100 score is
  Castle's enterprise black-box output (out-of-scope for SDK injection
  layer). Demoted to ℹ️ note (same tier as CreepJS WebGL bold-fail).
- **Worker scope `navigator.webdriver` spoof** (`Phase 2.6.1`): Phase 2.6
  worker IIFE `defs` array initially missed `webdriver`. Added — fixes
  worker-realm `navigator.webdriver=true` leak. Discovered via Phase 2.5
  bench against `incolumitas` "Web Worker Navigatory Property" section.
- **`arh-antoinevastel` extractor** (`Phase 2.6.1`): Initial regex used
  `\b(Consistent|Unsure|Inconsistent)\b` word boundary on tr.textContent
  which couldn't match `RULEConsistent{...}` (no separator between
  cells). Rewrote to parse `table#scanner tbody tr` 3-`<td>` structure
  directly. 0 rows → 21 rows captured.

### Documented (known limitations)

- **fingerprint-scan (Castle.io) commercial detector**: Reverse engineering
  Castle.io's minified browser fingerprinter + black-box server-side
  scoring is out-of-scope for v0.3 SDK injection layer. Castle.io
  reverse should be addressed in v0.4+ chromium-fork patches.

### Verification

- **Tests**: persona-schema 21/21, sdk **281/281** (248 → 281, +10 Phase 3.1
  stack hardening + 23 Phase 2.6 worker).
- **Typecheck**: clean across 3 packages.
- **Bench**: 12-site `baseline-detection.ts` ran 12 OK / 0 FAIL,
  hits=**2** (both Phase 2 already-documented known-limits).
  Latest result: `bench/results/2026-05-16T13-25-39-879Z/`.
- **Probe**: `bench/probe-error-stack.ts` confirms zero suspicious
  frames in main + worker scopes post-Phase 3.1 hook.

### Migration from 0.2.0

No breaking changes. Persona files saved under 0.2.0 remain valid.

---

## [0.2.0] — 2026-05-16

The **"v0.2 anti-detection engine"** release. Builds on the v0.1.0 Persona +
Electron foundation with two major anti-fingerprinting phases:

- **Phase 1.5 – 1.9b** (consolidated): Worker-scope spoof, UA Client Hints,
  CDP detection hardening, navigator-lies fix, full WebGL 49-parameter spoof.
- **Phase 2.1 – 2.4** (this release): Multi-profile WebGL infrastructure,
  second built-in GPU profile (UHD 630), CreepJS limitations documentation,
  canvas spoof double-guard defeating CreepJS lies + LowerEntropy.CANVAS.

### Added

- **WebGL profile selection** (`Phase 2.1`): `Persona.hardware.gpu.webglProfileId`
  field lets users explicitly select a built-in WebGL profile, bypassing the
  default regex-based renderer matching. Typo-tolerant: unknown id falls back
  to regex match.
- **Second built-in WebGL profile** (`Phase 2.2 part 1`): `intel-uhd-630-d3d11`
  for `win10-chrome-us` template. Brings full 49-parameter coverage (vs
  v0.1.0 UNMASKED-only fallback) on Windows 10 personas → defeats cross-check
  fail on non-CreepJS fingerprinters.
- **Canvas spoof double-guard** (`Phase 2.4`): Two new helpers in
  `runner.ts` §5 — `isProbeCanvas` (skip ≤16×16 canvases) and `isAllZero`
  (skip cleared/transparent regions). Defeats CreepJS's two independent
  canvas detections:
  - `CanvasRenderingContext2D.getImageData: pixel data modified` lie
    (cleared 8×8 region read on 50×50 canvas after clearRect)
  - `LowerEntropy.CANVAS = true` from `suspicious pixel data` (hardcoded
    `KnownImageData.BLINK/GECKO/WEBKIT` whitelist comparison on 2×2 probe)
- **WebGL 49-parameter spoof** (`Phase 1.9 / 1.9b`): Full ANGLE D3D11 backend
  parameter coverage for `intel-uhd-730-d3d11` profile —
  `MAX_TEXTURE_SIZE`, `MAX_VIEWPORT_DIMS`, `ALIASED_*_RANGE`, and 46 others.
  String params (`VENDOR`, `RENDERER`, `VERSION`, `SHADING_LANGUAGE_VERSION`)
  now also covered.
- **UA Client Hints full spoof** (`bdf5b89`): `navigator.userAgentData`
  brands, fullVersionList, platform, platformVersion, architecture, bitness,
  wow64, model — all spoofed in main + worker scope. Prevents
  `"HeadlessChrome"` brand leak via UA-CH reduction.
- **Worker scope hardening** (`Phase 1.5`): SDK injects spoof block into
  ServiceWorker / DedicatedWorker / SharedWorker scripts. Eliminates CreepJS
  worker `lies` count (Navigator API parity main ↔ worker).
- **CDP detection hardening** (`Phase 1.6`): Patches `Runtime.evaluate` /
  `Inspector.detached` indicators. Adds 3 new baseline sites for CDP
  detection coverage.
- **Rebrowser-patches integration** (`Phase 1.7.1`): Applies upstream
  rebrowser patches to `playwright-core@1.59.1` for additional headless
  signature removal.
- **15 new tests** for canvas spoof Phase 2.4 (`runner-canvas.test.ts`),
  using polyfilled `CanvasRenderingContext2D` + `ImageData` (happy-dom lacks
  both). Total SDK tests: 209 → **248**.
- **Persona-schema tests** for `webglProfileId` derivation + override
  validation: 17 → **21**.

### Changed

- **CreepJS lies count**: 10 → 2 (Phase 1.x rollup). Remaining 2 are
  documented as data-coverage limitations (see below).
- **`build-config.ts` WebGL profile selection**: Now uses high-level
  `selectWebglProfileForPersona(persona)` API instead of inline regex
  match, supporting `webglProfileId` override.
- **`packages/persona-schema/README.md`**: New `WebGL profile 选择 (v0.3+)`
  section documenting `webglProfileId` field + 2 built-in profiles + the
  CreepJS WebGL bold-fail expectation.

### Documented (known limitations)

- **CreepJS WebGL bold-fail expected** (`Phase 2.2 part 2`, `Phase 2.3`):
  All 4 built-in persona templates trigger `LowerEntropy.WEBGL` on
  creepjs.com. Root cause: CreepJS's hardcoded GPU whitelist (237 capability
  hashes + 287 brand hashes) has joint density ~3.7e-15 vs the 2^32 hash
  space. Blind reverse-fit is mathematically infeasible (~2.7×10¹⁴ expected
  tries). Real-hardware Intel UHD 730 users hit the same outcome. Not a
  spoof flaw; documented in `packages/sdk/bench/PHASE-2-PLAN.md` Phase 2.2
  Part 2 with full analysis tool (`bench/find-creepjs-whitelist-fit.ts`).

### Fixed

- **Navigator lies regression** (`Phase 1.8`): Several `Navigator.prototype`
  getters were leaving `own property` traces detectable by CreepJS's
  `failed own property` check. Now all spoof via `defineProtoGetter` →
  prototype-only, instance-clean.
- **Canvas spoof noise on cleared regions**: v0.1.0 added ±1 LSB noise to
  ALL pixels including transparent ones, causing CreepJS to flag canvas as
  modified even on fresh `clearRect`. Phase 2.4 `isAllZero` guard fixes.

### Verification

- **Tests**: persona-schema 21/21, sdk 248/248 (15 new canvas tests).
- **Typecheck**: clean across 3 packages (`@mosaiq/persona-schema`,
  `@mosaiq/sdk`, `@mosaiq/desktop`).
- **Bench**: `packages/sdk/bench/baseline-detection.ts` available for
  end-to-end Chromium validation (user-runnable; not auto-executed).

### Migration from 0.1.0

No breaking changes. Persona files saved under 0.1.0 remain valid; new
optional `hardware.gpu.webglProfileId` field defaults to `undefined`
(regex fallback retains v0.1.0 behavior for win11).

---

## [0.1.0] — 2026-05-07

Initial public release. See git tag `v0.1.0`.

- Persona schema + 4 templates (`win11-chrome-us`, `win10-chrome-us`,
  `macos-chrome-us`, `ubuntu-chrome-us`)
- SDK injection engine: navigator / screen / Intl / WebGL / Canvas / Audio
  / fonts / WebRTC spoof via Playwright `addInitScript`
- Electron desktop shell with Persona browser launcher
- humanize input engine (mouse jitter, keystroke timing)
- 9-site baseline detection bench (creepjs, sannysoft, browserleaks, etc.)

[0.5.0]: https://github.com/meilimei/Mosaiq/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/meilimei/Mosaiq/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/meilimei/Mosaiq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/meilimei/Mosaiq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/meilimei/Mosaiq/releases/tag/v0.1.0
