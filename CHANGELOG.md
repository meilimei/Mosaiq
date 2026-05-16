# Changelog

All notable changes to Mosaiq are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while
in 0.x (minor bumps may include breaking changes).

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

[0.2.0]: https://github.com/meilimei/Mosaiq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/meilimei/Mosaiq/releases/tag/v0.1.0
