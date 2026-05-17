# Captured WebGL Profiles

This directory holds JSON captures from real hardware, contributed by
Mosaiq users via the Phase 5.3 capture pipeline. Each `*.json` file is
processed by `bench/integrate-captured-profiles.ts` into a typed
`WebglProfile` and merged into `KNOWN_PROFILES` automatically.

## Contributor flow

1. **Capture** — open `packages/sdk/bench/capture-real-webgl-profile.
   html` in your real-hardware Chrome / Edge (NOT inside a VM, NOT
   with hardware acceleration disabled). Click `Capture` and download
   the resulting JSON.
2. **Verify** locally:

   ```bash
   pnpm --filter @mosaiq/sdk run bench:convert-profile -- --file <your-capture>.json
   ```

   Confirm the verdict line. If it says `❌ FAIL (LowerEntropy.WEBGL)`,
   the profile won't clear the CreepJS WebGL bold-fail — but other
   detectors don't use the CreepJS whitelist, so the profile is still
   valuable as a GPU persona option. (If the convert tool warns about
   software rendering, recapture with hardware acceleration enabled.)
3. **Submit** — drop the JSON into this directory with a stable name:

   ```
   <vendor>-<model>-<backend>-<contributor-handle>.json
   ```

   Example: `intel-uhd-630-d3d11-alice.json`,
   `nvidia-rtx-4070-d3d11-bob.json`. Avoid PII in the filename.
4. **Integrate**:

   ```bash
   pnpm --filter @mosaiq/sdk run bench:integrate-profiles
   ```

   This regenerates `packages/sdk/src/injection/webgl-profiles-
   captured.ts` from every JSON in this directory. Commit both the
   JSON and the regenerated TS file.

CI re-runs the integrate step on every PR; if the generated TS file
drifts from the JSONs, the CI check fails.

## File schema

Each capture JSON conforms to `schemaVersion: mosaiq-webgl-capture/1`,
the format produced by `capture-real-webgl-profile.html`:

```json
{
  "schemaVersion": "mosaiq-webgl-capture/1",
  "captureDate": "2026-05-17T16:30:00Z",
  "userAgent": "Mozilla/5.0 ...",
  "vendor": "Google Inc. (Intel)",
  "renderer": "ANGLE (Intel, Intel(R) UHD Graphics ... Direct3D11 ...)",
  "webgl1": { "0x1f00": "WebKit", ... },
  "webgl2": { "0x1f00": "WebKit", ... }
}
```

## Provenance & PII

We do **NOT** record IP, geolocation, locale, or anything beyond the
WebGL parameter table. The `userAgent` field is part of the schema
(useful for triage when a profile breaks) but contributors are free
to redact it to the minimal `Mozilla/5.0 (Win/Mac/Linux) ...` form
before submitting.

## Why this matters

Phase 2.2 Part 2 math: blind brute-force probability of hitting a
CreepJS whitelist hash is ~5.5e-8 per attempt. Real-hardware captures
have a much higher hit rate because the CreepJS team curates the
whitelist from actual user fingerprints. **One real capture from a
common GPU is worth millions of synthetic attempts.**
