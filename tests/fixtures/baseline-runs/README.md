# Detection Lab CI baselines

This directory holds the committed `baseline.json` files that the v0.10
phase 10.7 Detection Lab CI gate (`.github/workflows/detection-lab.yml`)
compares fresh runs against.

```
tests/fixtures/baseline-runs/
  <persona-id>/
    baseline.json     # stripRunForBaseline(DetectionRun) — git-trackable, stable
```

Each fixture persona under `tests/fixtures/personas/<persona-id>.json`
expects a matching `tests/fixtures/baseline-runs/<persona-id>/baseline.json`.
On a PR / push / weekly cron, the workflow:

1. Imports the fixture persona into the runner's `~/.mosaiq/personas/`
2. Runs `mosaiq detection-lab run <persona-id> --json` → fresh candidate
3. Strips environmental noise via `stripRunForBaseline` from `@runova/sdk`
4. Diffs against this directory's `baseline.json` via `diffRuns`
5. Fails the workflow on regression (added hits / `weightedHits` rose /
   `>2` sites flipped `ok → fail`)

## Why "stripped" baselines?

A raw `DetectionRun` JSON contains many fields that change every run
without reflecting any real anti-detection behavior change:

  - `id`, `startedAt`, `finishedAt`, `durationMs`
  - `meta.chromiumVersion` (differs between runner OS and runner build)
  - `raw.timestamp`, `raw.overallMs`
  - per-site `durationMs` / `screenshot` / `html` / `retries` / `bodyText` /
    `title` / `error`

Committing these would mean `git diff` is permanently red against every
re-run. `stripRunForBaseline` replaces these with stable placeholders
(`'baseline'` / `0` / unix epoch) while preserving the behavior-relevant
fields (`personaId`, `status`, `score.*`, per-site `ok` + `extracted`).

## Bootstrapping a new baseline

The first time you add a fixture persona under `tests/fixtures/personas/`,
its baseline doesn't exist yet. The workflow detects this and exits 0
with a "baseline missing" markdown report instead of failing. To bootstrap:

1. **Trigger the workflow** on `main` (or via `workflow_dispatch`).
2. **Download the artifact** named
   `detection-lab-<persona-id>-<run-number>` from the workflow run.
   It contains `candidate-<persona-id>.json` (the fresh run produced by
   the CI runner).
3. **Strip + write** the baseline on your dev machine:
   ```bash
   pnpm --filter @runova/sdk build
   node scripts/ci-compare-baseline.mjs write-baseline \
     candidate-<persona-id>.json \
     tests/fixtures/baseline-runs/<persona-id>/baseline.json
   ```
4. **Commit** the new `baseline.json` and open a PR. Subsequent
   workflow runs will now gate against it.

Always bootstrap from a **CI runner** artifact, **never** from a local
`mosaiq detection-lab run` invocation. Local hardware fingerprint
(GPU model, OS Chromium build, real audio context) differs from
`ubuntu-latest` and would produce false-positive regressions on the
next CI compare.

## Refreshing an existing baseline

Detection sites (creepjs, browserscan, etc.) update their detector logic
periodically — what was a hit yesterday might be silent today, or vice
versa. When this happens, the workflow flags it as a regression even
though Mosaiq's SDK hasn't changed. To refresh:

1. **Verify** that the regression is genuinely external (read the
   markdown report in the workflow's Summary tab — if the added hit
   came from a site that just shipped a new detector and Mosaiq's
   actual behavior didn't change, the baseline is stale).
2. **Download** the candidate artifact from the failing workflow run.
3. **Overwrite** the baseline:
   ```bash
   node scripts/ci-compare-baseline.mjs write-baseline \
     candidate-<persona-id>.json \
     tests/fixtures/baseline-runs/<persona-id>/baseline.json
   ```
4. **PR** with a clear message: `chore(baseline): refresh
   <persona-id> after <site> detector update`. Reviewer should
   sanity-check the diff (which surfaces / sites moved) before merging.

Phase 10.8 (planned) automates this loop with a `refresh-baseline.yml`
workflow that opens an auto-PR weekly.

## Do not hand-edit `baseline.json`

The file is a stripped projection of a real `DetectionRun`. Hand-editing
will likely produce invalid shape (the SDK's `diffRuns` accepts the
`DetectionRun` schema, not arbitrary JSON) and the next workflow run
will either pass spuriously or fail with a parse error. Always regenerate
via `write-baseline` mode.
