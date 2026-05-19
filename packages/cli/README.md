# @mosaiq/cli

Command-line interface for [Mosaiq](../../README.md). Run Detection Lab passes
and inspect personas without launching the desktop app.

> **Status:** v0.9 phase 9.5c — full persona CRUD: `personas list` /
> `show` / `create` / `update` / `clone` / `delete` / `export` / `import` /
> `templates list`, plus `detection-lab run` / `list-runs` / `show-run` /
> `delete-run` / `compare`.

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

### `mosaiq personas update <persona-id>`

Edits a persona's "soft" fields (display name / tags / notes / timezone /
proxy). Hardware fingerprint, OS family, and browser version are **not**
editable — `personas clone` is the right escape hatch when you actually
need a different hardware baseline (it preserves the original persona's
warming history).

At least one patch flag is required; running `update` with only the id
is rejected with `exit 2` to avoid silent no-ops.

```bash
# Rename and refresh tags
pnpm mosaiq personas update reddit-alice \
  --display-name "Reddit Alice (warm)" \
  --tags reddit,us,warming,template:win11-chrome-us

# Drop proxy (e.g. moved to direct VPN)
pnpm mosaiq personas update reddit-alice --no-proxy

# Switch to a new sticky-session proxy
pnpm mosaiq personas update reddit-alice \
  --proxy http://brd-customer-XXX:p%40ss@brd.example:33335 \
  --proxy-label "Bright Data US-east session-7"
```

#### Patch flags

| flag                      | behavior                                                     |
|---------------------------|--------------------------------------------------------------|
| `--display-name <name>`   | New display name (1–128 chars)                               |
| `--tags <a,b,c>`          | **Replace** tags (`""` clears). Pre-existing tags are NOT preserved unless re-listed — re-add `template:<id>` if you want list/show to keep recognizing the template |
| `--notes <text>`          | New notes (≤2048 chars; `""` clears)                         |
| `--timezone <iana>`       | New IANA timezone                                            |
| `--proxy <url>`           | Replace the proxy entirely (same URL format as `create`)     |
| `--proxy-label <label>`   | Friendly proxy label (only with `--proxy`)                   |
| `--no-proxy`              | Remove the proxy. Mutually exclusive with `--proxy`          |
| `--json`                  | Print full updated Persona JSON instead of a summary         |

If the persona is currently running in the desktop browser, the JSON on
disk updates immediately, but Chromium has already started with the old
config — a restart is required for the new value to take effect.

### `mosaiq personas clone <source-id> <new-id>`

Copies a persona's full identity baseline (OS, browser, hardware, font
list, locale) but **re-derives** the canvas / webgl / audio noise seeds
from a fresh master seed, so the clone has a fingerprint independent
from the source. Use this for multi-account matrices that share a
visual / capability profile but must not collide at detection time.

`launchCount` and `lastLaunchedAt` are reset on the clone (it's a
fresh identity); `createdAt` is set to "now" so the persona's age is
trackable.

```bash
# Standard clone for a multi-account matrix
pnpm mosaiq personas clone reddit-alice reddit-alice-alt \
  --display-name "Reddit Alice (alt)"

# Clone but switch to a different proxy region
pnpm mosaiq personas clone reddit-alice reddit-alice-uk \
  --display-name "Reddit Alice (UK)" \
  --proxy http://user:p%40ss@proxy.example.com:8080 \
  --timezone Europe/London \
  --tags reddit,uk

# Reproducible clone (CI / detection-lab regression fixtures)
pnpm mosaiq personas clone bench-fixture bench-fixture-replay \
  --display-name "Bench Fixture (replay)" \
  --master-seed deadbeef
```

#### Required + optional flags

| flag                  | required | notes                                                            |
|-----------------------|----------|------------------------------------------------------------------|
| `--display-name <n>`  | ✓        | UI label for the clone                                           |
| `--tags <a,b,c>`      |          | Replace tag list (default: copy source's verbatim, including any `template:<id>` tag) |
| `--notes <text>`      |          | Replace notes (default: copy source's)                           |
| `--timezone <iana>`   |          | Override timezone (default: copy source's)                       |
| `--proxy <url>`       |          | Replace proxy (default: copy source's)                           |
| `--proxy-label <s>`   |          | Friendly proxy label (only with `--proxy`)                       |
| `--no-proxy`          |          | Drop the proxy on the clone                                      |
| `--master-seed <hex>` |          | Pin the master noise seed for reproducibility                    |
| `--json`              |          | Print full cloned Persona JSON instead of a summary              |

Exits `2` on missing source / id-conflict / mutually-exclusive flags
(`--proxy` + `--no-proxy`).

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

### `mosaiq personas export <persona-id>`

Serializes a persona to JSON. Output is byte-identical to the on-disk
file at `~/.mosaiq/personas/<id>.json` (modulo proxy password
redaction), so an exported file can be dropped directly into another
machine's personas directory and the SDK will recognize it.

By default `proxy.password` is redacted to `''` to keep credentials out
of shared exports / git history. Pass `--include-secrets` to opt into
exporting the raw password (with a stderr warning). Cookies / localStorage /
IndexedDB are stored separately in the chromium user-data-dir and are
NOT included in the persona export — exports move identity, not session.

```bash
# Stream to stdout (default; pipe-friendly)
pnpm mosaiq personas export reddit-alice > backup/reddit-alice.json

# Direct write
pnpm mosaiq personas export reddit-alice --out backup/reddit-alice.json

# Include credentials (only for moves to a trusted machine)
pnpm mosaiq personas export reddit-alice \
  --include-secrets \
  --out /secure/transfer/reddit-alice.json
```

### `mosaiq personas import <file>`

Imports a persona JSON into `~/.mosaiq/personas/`. Use `-` for the file
positional to read from stdin (e.g. `cat foo.json | mosaiq personas
import -`). Schema is validated against `PERSONA_SCHEMA_VERSION = 1`;
malformed JSON or schema-incompatible files are rejected with `exit 2`.

`launchCount` and `lastLaunchedAt` are reset on import (fresh identity
on the new machine); `createdAt` is preserved for provenance, and
`updatedAt` refreshes to the import timestamp.

```bash
# Import from a file (errors on id conflict)
pnpm mosaiq personas import backup/reddit-alice.json

# Import + auto-rename on conflict
pnpm mosaiq personas import backup/reddit-alice.json --on-conflict rename

# Replay from a pipeline / stdin
cat backup/reddit-alice.json | pnpm mosaiq personas import -

# Print imported persona JSON (for jq / pipelines)
pnpm mosaiq personas import backup/reddit-alice.json --json
```

#### `--on-conflict` strategies

| strategy   | behavior                                                                |
|------------|-------------------------------------------------------------------------|
| `error`    | (default) Abort with `exit 2`; existing persona untouched               |
| `rename`   | Append `-imported` (then `-imported-2` / `-imported-3` / …) to the id   |
| `overwrite`| Replace the on-disk persona JSON. **The chromium user-data-dir is preserved**, so the new persona may end up with cookies that don't match its fingerprint — use only when you know the cookies / session can be reset |

If the imported persona was exported with the default secret-stripping,
the proxy `username` will be present but `password` will be empty. Run
`mosaiq personas update <id> --proxy <url>` afterwards to restore the
real password before launching.

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
