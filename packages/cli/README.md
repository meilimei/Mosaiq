# @mosaiq/cli

Command-line interface for [Mosaiq](../../README.md). Run Detection Lab passes
and inspect personas without launching the desktop app.

> **Status:** v0.9 phase 9.1 — initial scope is `detection-lab run` and
> `personas list`. More subcommands (`show-run`, `delete-run`, `compare`,
> persona crud) land as v0.9 progresses.

## Install

`@mosaiq/cli` is a workspace package and gets linked automatically by `pnpm install`
at the repo root. There is no published npm release yet.

For local development the easiest invocation goes through the root script
(uses `tsx`, no build step needed):

```bash
pnpm mosaiq <command> [args...]
```

If you've run `pnpm --filter @mosaiq/cli build`, you can also call the
compiled binary directly:

```bash
pnpm exec mosaiq <command> [args...]
# or
node packages/cli/bin/mosaiq.js <command> [args...]
```

## Commands

### `mosaiq personas list`

Lists every persona stored under `~/.mosaiq/personas/`.

```bash
pnpm mosaiq personas list

# Machine-readable variant (full Persona JSON array):
pnpm mosaiq personas list --json
```

### `mosaiq detection-lab run <persona-id>`

Runs the 12-site Detection Lab against the given persona. Saves a
`DetectionRun` JSON to `~/.mosaiq/detection-runs/<persona-id>/<runId>.json`
plus a sibling `<runId>/` directory with per-site `.html` and `.png`
artifacts — same layout as the desktop app, so runs created via the CLI
appear in the desktop run history (and vice versa).

```bash
# Default: headless, all 12 sites, 60s per-site timeout, 2 retries
pnpm mosaiq detection-lab run baseline-bench-mp9itrpe

# Subset of sites + visible browser
pnpm mosaiq detection-lab run my-persona \
  --only creepjs,sannysoft \
  --headed

# Machine-readable output for CI / piping into jq
pnpm mosaiq detection-lab run my-persona --json > run.json
jq '.score.weightedHits' run.json

# CI gate — exit 1 if any medium/high hit is detected
pnpm mosaiq detection-lab run my-persona --fail-on-hits medium
```

#### Exit codes

| code | meaning                                                          |
|------|------------------------------------------------------------------|
| 0    | run completed; hit policy not triggered                          |
| 1    | run completed; `--fail-on-hits` threshold reached                |
| 2    | argument error / persona not found / launch failed              |
| 130  | SIGINT (Ctrl-C) — gracefully cancelled mid-run                   |

#### `--fail-on-hits` levels

| level    | exit non-zero when…                          |
|----------|----------------------------------------------|
| `none`   | never (default)                              |
| `any`    | `hits.length > 0`                            |
| `medium` | any `medium` or `high` severity hit          |
| `high`   | any `high` severity hit                      |

## Notes

- The CLI shares the same SDK (`@mosaiq/sdk`) and on-disk layout as the
  desktop app. Runs created here are visible in the desktop's
  `DetectionLabPage` history list, and vice versa.
- `Ctrl-C` aborts a running pass cleanly — the in-flight site finishes
  (or hits its timeout), all sites after it short-circuit, and the run
  is persisted with `status: 'canceled'`. A second `Ctrl-C` force-quits.
- Output is fully ANSI-colored when stdout is a TTY; set `NO_COLOR=1` or
  pipe the output to disable colors.
