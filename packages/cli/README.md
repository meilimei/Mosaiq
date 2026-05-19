# @mosaiq/cli

Command-line interface for [Mosaiq](../../README.md). Run Detection Lab passes
and inspect personas without launching the desktop app.

> **Status:** v0.9 phase 9.5 — supports `detection-lab run` / `list-runs` /
> `show-run` / `delete-run` / `compare`, plus `personas list` / `show` /
> `create` / `delete` / `templates list`. Update / clone / export / import
> follow in 9.5b / 9.5c.

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

The `TEMPLATE` column reads from a `template:<id>` tag (auto-injected by
`mosaiq personas create`) or — for legacy desktop-created personas —
from a bare-tag match against the known template catalog. Personas with
neither show `unknown`.

### `mosaiq personas templates list`

Lists every template available to `mosaiq personas create --template`.
Same data the desktop "新建 Persona" page renders as cards.

```bash
pnpm mosaiq personas templates list

# Machine-readable: { id, displayName, description }[]
pnpm mosaiq personas templates list --json
```

### `mosaiq personas show <persona-id>`

Pretty-prints one persona's details: identity (id / display name /
template / tags / notes / timestamps), system (OS / locale / timezone /
screen), browser (brand / version / UA override), hardware (CPU / GPU /
audio / touch), fingerprint signature (canvas / webgl / audio noise
seeds, font count, webrtc mode), and network (proxy + label, with
password redacted). Does not launch Chromium.

```bash
pnpm mosaiq personas show reddit-alice

# Full Persona JSON (incl. fingerprint seeds + font list):
pnpm mosaiq personas show reddit-alice --json | jq '.metadata.id'
```

Exits `2` if the persona id is unknown or the JSON file is corrupt.

### `mosaiq personas create <persona-id>`

Creates a new persona under `~/.mosaiq/personas/<id>.json`. Mirrors the
desktop "新建 Persona" form: same templates, same fields, same disk
layout — a CLI-created persona is immediately visible in the desktop UI
and vice versa.

```bash
# Minimal: kebab-case id + template + display name
pnpm mosaiq personas create reddit-alice \
  --template win11-chrome-us \
  --display-name "Reddit Alice"

# With proxy + tags + override timezone
pnpm mosaiq personas create reddit-bob \
  --template win11-chrome-us \
  --display-name "Reddit Bob" \
  --proxy http://user:p%40ss@proxy.example.com:8080 \
  --proxy-label "IPRoyal residential US" \
  --tags reddit,us,warming \
  --timezone America/Los_Angeles

# Reproducible run (pin master noise seed for benchmark / comparison):
pnpm mosaiq personas create bench-fixture \
  --template win11-chrome-us \
  --display-name "Bench Fixture" \
  --master-seed deadbeef

# Machine-readable: full Persona JSON (incl. derived seeds)
pnpm mosaiq personas create bot-test \
  --template ubuntu-2204-chrome-us \
  --display-name "Bot Test" \
  --json | jq '.fingerprint.canvas.noiseSeed'
```

#### Required + optional flags

| flag                   | required | notes                                                  |
|------------------------|----------|--------------------------------------------------------|
| `--template <id>`      | ✓        | One of `mosaiq personas templates list` ids            |
| `--display-name <n>`   | ✓        | UI label, 1–128 chars                                  |
| `--tags <a,b,c>`       |          | Comma-separated; `template:<id>` always auto-appended  |
| `--notes <text>`       |          | Free-form notes (≤2048 chars)                          |
| `--timezone <iana>`    |          | Override template default (e.g. `America/Los_Angeles`) |
| `--proxy <url>`        |          | `<protocol>://[user[:pass]@]host:port`                 |
| `--proxy-label <s>`    |          | UI label for the proxy (e.g. `IPRoyal US`)             |
| `--master-seed <hex>`  |          | Persist fingerprint noise seed for reproducibility     |
| `--json`               |          | Print full Persona JSON instead of human summary       |

#### Proxy URL format

Supported protocols: `http`, `https`, `socks5`. Credentials must be
URL-encoded (e.g. `pass%40word` for a literal `pass@word`); the CLI
auto-decodes them before storing in the persona JSON. Path / query /
fragment in the URL are rejected (they are never part of a proxy URL).

#### Exit codes

| code | meaning                                                              |
|------|----------------------------------------------------------------------|
| 0    | persona created and saved to disk                                    |
| 2    | argument error / unknown template / id conflict / proxy parse error  |

### `mosaiq personas delete <persona-id>`

Removes the `~/.mosaiq/personas/<id>.json` file. Does **not** remove the
chromium user-data-dir (`~/.mosaiq/profiles/<id>/`) or the persona's
detection-run history (`~/.mosaiq/detection-runs/<id>/`) — same behavior
as the desktop UI's delete button. If you want to wipe everything for
that persona, also `rm -rf` those two directories.

```bash
# Interactive (default) — shows a 1-line preview then prompts y/N:
pnpm mosaiq personas delete reddit-alice

# Non-interactive (CI / scripts):
pnpm mosaiq personas delete reddit-alice --yes
```

Exits `2` if the persona id is unknown, or if `stdin` is not a TTY and
`--yes` was not supplied (so a piped invocation never silently deletes).

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

### `mosaiq detection-lab list-runs <persona-id>`

Lists every saved detection run for the persona, newest first. Shape mirrors
the desktop `DetectionLabPage` history list.

```bash
pnpm mosaiq detection-lab list-runs baseline-bench-mp9itrpe

# Machine-readable: DetectionRunSummary[] (no embedded `raw`)
pnpm mosaiq detection-lab list-runs baseline-bench-mp9itrpe --json
```

### `mosaiq detection-lab show-run <persona-id> <run-id>`

Pretty-prints a previously-saved run without launching Chromium. Matches the
final summary block emitted by `detection-lab run`, plus a header with run-id
/ persona / startedAt / sdk+chrome versions.

```bash
pnpm mosaiq detection-lab show-run my-persona 2026-05-18T13-49-09-107Z

# Full DetectionRun blob (incl. raw + score + meta) — same shape that's on disk
pnpm mosaiq detection-lab show-run my-persona 2026-05-18T13-49-09-107Z --json
```

Exits `2` if the run id is unknown or the JSON file is corrupt.

### `mosaiq detection-lab delete-run <persona-id> <run-id>`

Removes the `<runId>.json` file plus the sibling artifact directory.

```bash
# Interactive (default) — shows a 1-line preview then prompts y/N:
pnpm mosaiq detection-lab delete-run my-persona 2026-05-18T13-49-09-107Z

# Non-interactive (CI / scripts):
pnpm mosaiq detection-lab delete-run my-persona 2026-05-18T13-49-09-107Z --yes
```

Exits `2` if the run does not exist; refuses to run on a non-TTY without
`--yes`. Already-deleted runs are surfaced as a yellow warning rather than a
silent success.

### `mosaiq detection-lab compare <persona-id> <run-a> <run-b>`

Diffs two runs of the same persona. Convention: **A** is the baseline (older /
reference), **B** is the candidate (newer / under test); deltas are computed
as `B - A`.

```bash
# Pretty diff between two runs:
pnpm mosaiq detection-lab compare my-persona 2026-05-18T13-44-26-599Z 2026-05-19T11-01-32-216Z

# CI mode — exit 1 if B regresses (added hits, higher weightedHits, sites flipped ok→fail):
pnpm mosaiq detection-lab compare my-persona <runA> <runB> --fail-on-regression

# Machine-readable RunDiff (for jq / dashboards):
pnpm mosaiq detection-lab compare my-persona <runA> <runB> --json
```

Hit identity for the diff is `(surface, site, detector)` — same identity ⇒
same conceptual issue. Severity / evidence changes within an identity show up
under **Changed**, not Added / Removed. Site-level flips (`ok ↔ fail`) are
called out separately under **Sites flipped**.

A yellow `⚠ site lists differ` banner appears if the two runs attempted
different site sets (e.g. one used `--only` and the other didn't).

#### Verdict logic

| condition                                                    | verdict             |
|--------------------------------------------------------------|---------------------|
| `Δ weightedHits > 0` OR `added.length > 0` OR `okToFail > 0` | **B regresses**     |
| `Δ weightedHits < 0` OR `removed.length > 0`                 | **B improves**      |
| neither of the above                                         | **no material change** |

`--fail-on-regression` exits `1` only on the first row.

## Notes

- The CLI shares the same SDK (`@mosaiq/sdk`) and on-disk layout as the
  desktop app. Runs created here are visible in the desktop's
  `DetectionLabPage` history list, and vice versa.
- `Ctrl-C` aborts a running pass cleanly — the in-flight site finishes
  (or hits its timeout), all sites after it short-circuit, and the run
  is persisted with `status: 'canceled'`. A second `Ctrl-C` force-quits.
- Output is fully ANSI-colored when stdout is a TTY; set `NO_COLOR=1` or
  pipe the output to disable colors.
