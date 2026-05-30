# Capturing real-hardware WebGL profiles

> **TL;DR** Open `packages/sdk/bench/capture-real-webgl-profile.html` in
> your browser, click `Capture`, drop the JSON into
> `packages/sdk/bench/captured-profiles/<id>.json`, run
> `pnpm --filter @runova/sdk run bench:integrate-profiles`, commit both
> files.

This doc explains how to contribute a real-hardware WebGL profile to
Mosaiq's `KNOWN_PROFILES` registry. Contributing a profile lets your
GPU configuration (and anyone with similar hardware) be selectable as
a Mosaiq persona, and may eliminate the CreepJS WebGL `bold-fail`
signal for that GPU class.

## Why we need community captures

Mosaiq ships with 4 hand-curated profiles (Intel UHD 630 / 730, NVIDIA
RTX 3060, AMD RX 6600). Three of these were extracted from real
hardware; one (UHD 730) is in fact too new for the CreepJS upstream
whitelist. The CreepJS team curates the whitelist from real user
fingerprints they've seen in the wild — so the only way to grow it is
**real captures from real hardware**.

Phase 2.2 Part 2 math: blind brute-force probability of hitting a
CreepJS whitelist hash is **~5.5e-8 per attempt**. One real capture
from a common GPU is statistically worth millions of synthetic guesses.

## Pre-flight checklist

Before capturing:

1. **Use a real desktop browser**, not a VM, not Docker, not a Linux
   container without GPU passthrough. The HTML capture tool reports
   `UNMASKED_VENDOR_WEBGL` + `UNMASKED_RENDERER_WEBGL` from
   `WEBGL_debug_renderer_info`; if your browser is on a software
   renderer (Microsoft Basic Render Driver, SwiftShader, llvmpipe),
   the convert tool will refuse to emit a snippet — those captures are
   actively counter-productive (CreepJS whitelist mathematically can't
   contain software-only hashes; persona-claiming "Win11 Chrome no GPU"
   is itself an outlier).
2. **Hardware acceleration enabled**. In Chrome:
   `chrome://settings/system` → "Use hardware acceleration when
   available" → ON. Restart Chrome.
3. **Verify your GPU**: visit `chrome://gpu` and confirm "Graphics
   Feature Status" lists "WebGL: Hardware accelerated" (not "Software
   only").

## Step 1 — Capture

```
file:///D:/path/to/Mosaiq/packages/sdk/bench/capture-real-webgl-profile.html
```

Open the file directly (no need to `pnpm dev` — it's a single self-
contained page that runs locally; the only `script` is inline). The
page:

- Shows your `UNMASKED_VENDOR_WEBGL` and `UNMASKED_RENDERER_WEBGL`
- Queries 28 WebGL1 + 30 WebGL2 capability params
- Computes a preview CreepJS-style hash so you can sanity-check
  before submission
- Provides a `Copy` and `Download .json` button

Save the JSON locally — name doesn't matter yet, we'll rename in step 3.

## Step 2 — Verify locally

Pipe or pass the file to the convert tool:

```bash
pnpm --filter @runova/sdk run bench:convert-profile -- --file ~/Downloads/my-capture.json
```

You'll see one of:

- **`✅ PASS (cap ∧ brand)`** — your hash hits the CreepJS whitelist!
  Submit this profile; it will eliminate CreepJS WebGL bold-fail for
  anyone using your GPU class.
- **`❌ FAIL (LowerEntropy.WEBGL)`** — your hash is not in the CreepJS
  hardcoded whitelist. The profile is still useful as a GPU persona
  (other detectors like browserleaks-webgl, fingerprint-scan,
  arh-antoinevastel etc. don't use the CreepJS whitelist), but
  CreepJS will continue flagging WebGL as bold-fail for personas
  using this profile.

  This is **not your fault** — the CreepJS whitelist is roughly 250
  hardcoded GPU hashes, which is far smaller than the actual diversity
  of real hardware. Submit the profile anyway; future CreepJS updates
  may include your GPU.
- **`⚠️ Software renderer detected`** — recapture with hardware
  acceleration on (see pre-flight checklist).

The tool also prints a paste-ready TypeScript snippet that you'd
**not** need to manually copy — `bench:integrate-profiles` does that
for you in step 4.

## Step 3 — Submit

Rename and save into `packages/sdk/bench/captured-profiles/`:

```
<vendor>-<model>-<backend>-<contributor-handle>.json
```

Examples:

- `intel-uhd-630-d3d11-alice.json`
- `nvidia-rtx-4070-d3d11-bob.json`
- `apple-m2-metal-charlie.json`

The filename **stem** becomes the profile id used in
`Persona.hardware.gpu.webglProfileId` overrides, so pick a stable
identifier. Avoid PII; the contributor handle is for attribution and
de-duplication, not authentication.

If your filename matches `^[a-z0-9][a-z0-9-]*$` it becomes the id
verbatim. Otherwise the integrate tool falls back to a heuristic
suggested-id from the renderer string.

## Step 4 — Integrate

```bash
pnpm --filter @runova/sdk run bench:integrate-profiles
```

This regenerates `packages/sdk/src/injection/webgl-profiles-captured.
ts` from every JSON in `bench/captured-profiles/`. Open the file to
verify your profile appears as expected.

Commit BOTH the JSON and the regenerated TS file:

```bash
git add packages/sdk/bench/captured-profiles/<your-file>.json
git add packages/sdk/src/injection/webgl-profiles-captured.ts
git commit -m "feat(profiles): add <gpu-name> capture"
```

## Step 5 — Open a PR

CI will run:

```bash
pnpm --filter @runova/sdk run bench:integrate-profiles -- --check
```

…to verify the on-disk TS file is in sync with your JSON. If you
forgot to re-run integrate, this check fails with a copy-pastable
fix command.

## Privacy guarantees

Mosaiq does **not** record any of the following from your capture:

- IP address / geolocation
- Locale / timezone / language
- Hostname / username
- Installed fonts / plugins / extensions
- Storage permission / push subscription / notification permission
- Any cookie or localStorage value

The only fields collected are:

| Field | Used for | PII risk |
|---|---|---|
| `schemaVersion` | format detection | none |
| `captureDate` | provenance triage | low (date only, no time of day) |
| `userAgent` | OS / browser version triage | low (you can redact to `Mozilla/5.0 (Windows NT 10.0; Win64) ...` if uncomfortable) |
| `vendor` | GPU brand classification | low (e.g. `Google Inc. (Intel)`) |
| `renderer` | profile id + matchRenderer suggestion | low (e.g. `ANGLE (Intel, Intel(R) UHD Graphics 730 ...)`)
| `webgl1` / `webgl2` | the actual capability table | none (these are static GL constants, not user data) |

Feel free to **redact `userAgent` before submitting** — the integrate
tool only uses it for the snippet banner, not for behavior. Replace
with `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Mosaiq/contributor`
or similar if you want zero personal-OS-version exposure.

## Updating an existing profile

If you discover your capture had wrong / outdated data (e.g. you
captured with hardware acceleration off), simply replace the JSON
file (keep the same filename / id) and re-run integrate. The
regenerated TS file will overwrite the old snippet with the new
hashes; the profile id stays stable across the update.

## Related tools

- `bench/capture-real-webgl-profile.html` — the capture page
- `bench/convert-captured-profile.ts` — single-capture convert + verify
- `bench/integrate-captured-profiles.ts` — multi-capture batch
  integration (this doc)
- `bench/verify-creepjs-profile-hash.ts` — verify already-existing
  `KNOWN_PROFILES` entries against the upstream CreepJS whitelist
