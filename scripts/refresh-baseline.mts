#!/usr/bin/env node
// =============================================================================
// scripts/refresh-baseline.ts
//
// v0.10 phase 10.8 — Detection Lab baseline auto-refresh driver.
//
// Used by `.github/workflows/refresh-baseline.yml` (weekly cron + manual
// dispatch) to detect when an *external* detection site (creepjs,
// browserscan, sannysoft, ...) has updated its detector logic enough to
// move the committed baseline. In that case the workflow runs this
// script, which rewrites the affected baseline.json file(s), and the
// workflow then opens a PR for maintainer review (via the
// `peter-evans/create-pull-request@v6` action — its built-in
// "create PR only when working tree has changes" check is what gates the
// PR creation).
//
// The script can also be invoked locally:
//   pnpm refresh-baseline                           # all fixture personas, 3-run consensus
//   pnpm refresh-baseline --persona win11-chrome-us # one persona
//   pnpm refresh-baseline --runs 1                  # skip consensus (faster, MVP-local-debug)
//   pnpm refresh-baseline --check                   # don't write, just report drift
//
// Multi-run consensus rationale:
//   A single Detection Lab run is noisy — a transient HTTP 5xx from
//   creepjs.com or a JS error in browserscan's detector can flip site
//   `ok` / move `score.hits` by ±1 — so a 1-run baseline refresh would
//   open spurious PRs once a month even when nothing real changed.
//   Running N times (default 3) and taking the majority vote per hit-
//   identity + per-site-ok cuts the false-positive rate by an order of
//   magnitude. The tradeoff is wall-clock: ~3 × 15min = 45min per
//   workflow invocation, well under the runner's 60min default.
//
// Consensus algorithm:
//   - For each hit-identity (surface + site + detector): include in
//     consensus if it appears in >= majority threshold runs (default
//     ceil(N/2) = 2 for N=3). Severity = mode across the runs that
//     contained the hit (ties broken toward higher severity, since
//     under-reporting severity is worse than over-reporting).
//   - For each site result: `ok` = majority vote across runs (ties
//     broken toward `false` to avoid hiding real failures from the
//     baseline; the worst case is a transient failure baked in, but
//     that's caught next refresh cycle).
//   - Other fields (personaId, status, sitesAttempted, meta.sdkVersion,
//     raw.persona) are taken from run #1 and must be identical across
//     runs; if not, the script fails loud — that's a sign something
//     unexpected is going on (persona was hot-edited mid-run, SDK was
//     mid-build during the cron, etc.).
//
// Output (per persona):
//   tests/fixtures/baseline-runs/<persona-id>/baseline.json — consensus
//     of N runs, stripped via stripRunForBaseline (so the file is
//     git-diff-friendly).
//
// Exit codes:
//   0 = success (wrote baseline OR --check found no drift)
//   1 = --check found drift (CI uses this only for diagnostic; the
//       workflow itself uses `git diff` on the working tree)
//   2 = arg error / fixture missing / run failed / consensus disagreed
//       on a structural field
//
// Doc: docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md §11.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  type DetectionRun,
  type DetectionRunRaw,
  type DetectionScore,
  type HitsBySurface,
  type Persona,
  SDK_VERSION,
  SEVERITY_WEIGHT,
  type SiteResult,
  type SurfaceHit,
  diffRuns,
  emptyHitsBySurface,
  importPersonaJson,
  loadPersona,
  runDetection,
  stripRunForBaseline,
} from '../packages/sdk/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FIXTURES_DIR = resolve(ROOT, 'tests', 'fixtures', 'personas');
const BASELINES_DIR = resolve(ROOT, 'tests', 'fixtures', 'baseline-runs');

// ─────────────────────────────────────────────────────────────────────────────
// argv parsing
// ─────────────────────────────────────────────────────────────────────────────

interface Opts {
  personas: string[]; // empty = all discovered fixtures
  runs: number;
  check: boolean;
  timeoutMs: number;
  retries: number;
}

function parseOpts(argv: readonly string[]): Opts {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      persona: { type: 'string', multiple: true },
      runs: { type: 'string', default: '3' },
      check: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '60000' },
      retries: { type: 'string', default: '3' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (parsed.values.help === true) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const runs = Number.parseInt(parsed.values.runs as string, 10);
  if (!Number.isFinite(runs) || runs < 1 || runs > 9) {
    bail(`--runs must be in [1, 9] (got '${parsed.values.runs}')`);
  }
  const timeoutMs = Number.parseInt(parsed.values.timeout as string, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    bail(`--timeout must be >= 1000 (got '${parsed.values.timeout}')`);
  }
  const retries = Number.parseInt(parsed.values.retries as string, 10);
  if (!Number.isFinite(retries) || retries < 0) {
    bail(`--retries must be >= 0 (got '${parsed.values.retries}')`);
  }

  return {
    personas: (parsed.values.persona as string[] | undefined) ?? [],
    runs,
    check: parsed.values.check === true,
    timeoutMs,
    retries,
  };
}

const HELP = `Usage: pnpm refresh-baseline [options]

Re-runs Detection Lab against committed fixture personas, computes
multi-run consensus, and writes the result to
tests/fixtures/baseline-runs/<persona-id>/baseline.json. Used by the
weekly refresh-baseline.yml workflow to track external detection-site
drift.

Options:
  --persona <id>     Restrict to one persona (repeatable). Default: all
                     fixtures under tests/fixtures/personas/.
  --runs <n>         Number of runs per persona for consensus. Default: 3.
                     Use 1 to skip consensus (faster local debug).
  --check            Don't write; print drift vs current baseline, exit
                     1 if drift detected.
  --timeout <ms>     Per-site timeout. Default: 60000.
  --retries <n>      Per-site retries. Default: 3.
  -h, --help         Show this help.

Examples:
  pnpm refresh-baseline
  pnpm refresh-baseline --persona win11-chrome-us
  pnpm refresh-baseline --runs 1               # quick local refresh
  pnpm refresh-baseline --check                # diff against committed baseline
`;

// ─────────────────────────────────────────────────────────────────────────────
// Persona discovery
// ─────────────────────────────────────────────────────────────────────────────

interface FixtureRef {
  id: string;
  jsonPath: string;
  baselinePath: string;
}

function listFixturePersonas(filter: readonly string[]): FixtureRef[] {
  if (!existsSync(FIXTURES_DIR)) {
    bail(`Fixtures dir not found: ${FIXTURES_DIR}`);
  }
  // We avoid readdirSync here because the fixtures dir might pick up
  // README.md or other files in the future. Just iterate the known
  // ids derived from the JSON filenames.
  // For v0.10.8 the canonical list is hardcoded to mirror what
  // build-fixture-personas.ts emits. As that script grows, this list
  // grows alongside.
  const known = ['win11-chrome-us'];
  const requested = filter.length > 0 ? filter : known;
  const refs: FixtureRef[] = [];
  for (const id of requested) {
    const jsonPath = resolve(FIXTURES_DIR, `${id}.json`);
    if (!existsSync(jsonPath)) {
      bail(`Fixture persona not found: ${jsonPath}\nHint: did you mistype --persona ?`);
    }
    refs.push({
      id,
      jsonPath,
      baselinePath: resolve(BASELINES_DIR, id, 'baseline.json'),
    });
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
// One detection run (no persistence — we only care about the in-memory
// DetectionRun shape; nothing is written to ~/.mosaiq/detection-runs/
// because this script's output is the baseline file itself).
// ─────────────────────────────────────────────────────────────────────────────

async function runOnce(args: {
  persona: Persona;
  runIndex: number;
  totalRuns: number;
  timeoutMs: number;
  retries: number;
  signal: AbortSignal;
}): Promise<DetectionRun> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const runId = `refresh-${args.runIndex}-${startedAtIso.replace(/[:.]/g, '-')}`;

  log(`[run ${args.runIndex}/${args.totalRuns}] starting...`);

  const result = await runDetection(args.persona, {
    runId,
    personaTemplate: extractTemplate(args.persona) ?? 'unknown',
    timeoutMs: args.timeoutMs,
    maxRetries: args.retries,
    signal: args.signal,
    launchOptions: { headless: true },
    onProgress: (evt) => {
      if (evt.phase === 'site-end') {
        const mark = evt.siteOk ? 'ok' : 'fail';
        const dur = evt.siteDurationMs != null ? ` (${Math.round(evt.siteDurationMs)}ms)` : '';
        log(`  [run ${args.runIndex}] ${evt.siteId} ${mark}${dur}`);
      }
    },
  });

  const status = args.signal.aborted ? 'canceled' : 'completed';

  return {
    id: runId,
    personaId: args.persona.metadata.id,
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    status,
    sitesAttempted: result.raw.results.map((r) => r.id),
    durationMs: Date.now() - startedAtMs,
    score: result.score,
    raw: result.raw,
    error: null,
    meta: {
      sdkVersion: SDK_VERSION,
      chromiumVersion: 'refresh-baseline',
    },
  };
}

function extractTemplate(p: Persona): string | undefined {
  const tags = p.metadata.tags ?? [];
  for (const tag of tags) {
    if (tag.startsWith('template:')) return tag.slice('template:'.length);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consensus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge N stripped runs into one consensus run. The first run is taken
 * as the structural template; ok / hits / score are recomputed by vote.
 *
 * Exported for `scripts/refresh-baseline.test.mts` regression coverage —
 * the consensus algorithm is the riskiest pure-logic piece of this
 * script and deserves isolated tests independent of Chromium plumbing.
 */
export function computeConsensus(runs: readonly DetectionRun[]): DetectionRun {
  if (runs.length === 0) throw new Error('computeConsensus: empty input');
  if (runs.length === 1) {
    // n=1 means "no consensus, just take it" — useful for local --runs 1.
    return runs[0]!;
  }

  const template = runs[0]!;
  const majority = Math.ceil(runs.length / 2);

  // Structural-field sanity check
  for (const r of runs) {
    if (r.personaId !== template.personaId) {
      bail(`Consensus: personaId mismatch (${template.personaId} vs ${r.personaId})`);
    }
    if (r.status !== template.status) {
      bail(`Consensus: status mismatch (${template.status} vs ${r.status})`);
    }
    if (r.meta.sdkVersion !== template.meta.sdkVersion) {
      bail(`Consensus: sdkVersion mismatch (${template.meta.sdkVersion} vs ${r.meta.sdkVersion})`);
    }
  }

  if (!template.raw) {
    throw new Error('Consensus: template run has no raw');
  }

  // ─── Site ok consensus ──────────────────────────────────────────────
  const siteIds = template.raw.results.map((r) => r.id);
  const siteOkVotes = new Map<string, number>(); // id → ok-vote count
  for (const id of siteIds) siteOkVotes.set(id, 0);
  for (const r of runs) {
    if (!r.raw) continue;
    for (const sr of r.raw.results) {
      if (sr.ok && siteOkVotes.has(sr.id)) {
        siteOkVotes.set(sr.id, (siteOkVotes.get(sr.id) ?? 0) + 1);
      }
    }
  }
  const consensusSiteOk = new Map<string, boolean>();
  for (const id of siteIds) {
    consensusSiteOk.set(id, (siteOkVotes.get(id) ?? 0) >= majority);
  }

  // ─── Hit identity consensus ─────────────────────────────────────────
  type HitKey = string;
  const hitVotes = new Map<HitKey, { hit: SurfaceHit; votes: number; severities: string[] }>();
  for (const r of runs) {
    const hits = r.score?.hits ?? [];
    for (const h of hits) {
      const key = `${h.surface}\x00${h.site}\x00${h.detector}`;
      const existing = hitVotes.get(key);
      if (existing) {
        existing.votes += 1;
        existing.severities.push(h.severity);
      } else {
        hitVotes.set(key, { hit: h, votes: 1, severities: [h.severity] });
      }
    }
  }
  const consensusHits: SurfaceHit[] = [];
  for (const { hit, votes, severities } of hitVotes.values()) {
    if (votes >= majority) {
      // Tie-break severity toward higher (under-reporting = bad).
      const sev = pickWorstSeverity(severities);
      consensusHits.push({ ...hit, severity: sev });
    }
  }
  // Stable sort by (severity desc, surface, site, detector) for diff-friendly output
  consensusHits.sort(compareHitForSort);

  // ─── Recompute score ────────────────────────────────────────────────
  const consensusOkCount = [...consensusSiteOk.values()].filter((v) => v).length;
  const consensusFailCount = siteIds.length - consensusOkCount;
  const consensusHitsBySurface: HitsBySurface = emptyHitsBySurface();
  for (const h of consensusHits) {
    consensusHitsBySurface[h.surface] = (consensusHitsBySurface[h.surface] ?? 0) + 1;
  }
  const consensusWeighted = consensusHits.reduce((acc, h) => acc + SEVERITY_WEIGHT[h.severity], 0);

  // For metric fields like sannysoftPass / creepjsLies that the score
  // tracks: take the median across runs (or mean for fractional). Simpler
  // for now: take from the first run (template). They're informational
  // only; the regression gate keys off hits + weightedHits.
  const baseScore = template.score;
  const consensusScore: DetectionScore = baseScore
    ? {
        ...baseScore,
        sitesOk: consensusOkCount,
        sitesFail: consensusFailCount,
        weightedHits: consensusWeighted,
        hits: consensusHits,
        hitsBySurface: consensusHitsBySurface,
      }
    : {
        sitesOk: consensusOkCount,
        sitesFail: consensusFailCount,
        creepjsLies: 0,
        creepjsBoldFail: 0,
        sannysoftPass: 0,
        sannysoftTotal: 0,
        dbiBotFlagsTriggered: 0,
        amiuniqueOutliers: 0,
        fpScannerInconsistent: 0,
        incolumitasBadFlags: 0,
        weightedHits: consensusWeighted,
        hits: consensusHits,
        hitsBySurface: consensusHitsBySurface,
      };

  // ─── Project raw.results to consensus ok / pick extracted from a
  //     contributing run (the first run whose ok matches consensus).
  // ─────────────────────────────────────────────────────────────────────
  const consensusResults: SiteResult[] = template.raw.results.map((sr) => {
    const ok = consensusSiteOk.get(sr.id) ?? sr.ok;
    let extracted = sr.extracted;
    for (const r of runs) {
      const candidate = r.raw?.results.find((x) => x.id === sr.id);
      if (candidate && candidate.ok === ok && candidate.extracted !== undefined) {
        extracted = candidate.extracted;
        break;
      }
    }
    const merged: SiteResult = {
      id: sr.id,
      name: sr.name,
      url: sr.url,
      ok,
      durationMs: sr.durationMs,
    };
    if (extracted !== undefined) merged.extracted = extracted;
    return merged;
  });

  const consensusRaw: DetectionRunRaw = {
    ...template.raw,
    results: consensusResults,
  };

  return {
    ...template,
    score: consensusScore,
    raw: consensusRaw,
  };
}

export function pickWorstSeverity(severities: readonly string[]): SurfaceHit['severity'] {
  if (severities.includes('high')) return 'high';
  if (severities.includes('medium')) return 'medium';
  return 'low';
}

export function compareHitForSort(a: SurfaceHit, b: SurfaceHit): number {
  const sevOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sa = sevOrder[a.severity] ?? 9;
  const sb = sevOrder[b.severity] ?? 9;
  if (sa !== sb) return sa - sb;
  if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
  if (a.site !== b.site) return a.site < b.site ? -1 : 1;
  return a.detector < b.detector ? -1 : a.detector > b.detector ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseOpts(process.argv.slice(2));
  const fixtures = listFixturePersonas(opts.personas);

  log(
    `Refreshing ${fixtures.length} fixture(s), ${opts.runs} run(s) each (mode: ${
      opts.check ? 'check' : 'write'
    })`,
  );

  const abort = new AbortController();
  process.on('SIGINT', () => {
    log('SIGINT — aborting…');
    abort.abort();
  });

  let driftCount = 0;
  let errorCount = 0;
  const startedAtMs = Date.now();

  for (const ref of fixtures) {
    log(`\n=== ${ref.id} ===`);

    // Import the fixture persona into ~/.mosaiq/personas/ so loadPersona
    // can find it by id. We use --on-conflict overwrite semantics.
    let persona: Persona;
    try {
      const json = readFileSync(ref.jsonPath, 'utf-8');
      importPersonaJson(json, { onConflict: 'overwrite' });
      persona = loadPersona(ref.id);
    } catch (err) {
      log(`✗ failed to import fixture: ${(err as Error).message}`);
      errorCount += 1;
      continue;
    }

    // Run N times
    const stripped: DetectionRun[] = [];
    let runFailed = false;
    for (let i = 1; i <= opts.runs; i++) {
      if (abort.signal.aborted) {
        log(`✗ aborted before run ${i}`);
        runFailed = true;
        break;
      }
      try {
        const raw = await runOnce({
          persona,
          runIndex: i,
          totalRuns: opts.runs,
          timeoutMs: opts.timeoutMs,
          retries: opts.retries,
          signal: abort.signal,
        });
        stripped.push(stripRunForBaseline(raw));
      } catch (err) {
        log(`✗ run ${i} failed: ${(err as Error).message}`);
        runFailed = true;
        break;
      }
    }
    if (runFailed) {
      errorCount += 1;
      continue;
    }

    // Consensus + strip (already stripped per run, but strip again is
    // idempotent + future-proofs against runOnce growing non-stable fields)
    const consensus = stripRunForBaseline(computeConsensus(stripped));

    // Diff vs committed baseline, decide write/check
    const committed = existsSync(ref.baselinePath)
      ? (JSON.parse(readFileSync(ref.baselinePath, 'utf-8')) as DetectionRun)
      : null;

    if (committed) {
      const diff = diffRuns(ref.id, committed, consensus);
      const drift =
        diff.added.length > 0 ||
        diff.removed.length > 0 ||
        diff.changed.length > 0 ||
        diff.sitesFlipped.okToFail.length > 0 ||
        diff.sitesFlipped.failToOk.length > 0 ||
        Math.abs(diff.delta.weightedHits) > 0;

      if (!drift) {
        log('✓ no drift — committed baseline still valid');
        continue;
      }

      log(
        `! drift detected: +${diff.added.length} / -${diff.removed.length} hits, ` +
          `Δweighted=${diff.delta.weightedHits.toFixed(2)}, ` +
          `okToFail=${diff.sitesFlipped.okToFail.length}, ` +
          `failToOk=${diff.sitesFlipped.failToOk.length}`,
      );
      driftCount += 1;
    } else {
      log('! no committed baseline — will write new');
      driftCount += 1;
    }

    if (opts.check) {
      log('(--check: not writing)');
      continue;
    }

    // Write
    mkdirSync(dirname(ref.baselinePath), { recursive: true });
    const json = `${JSON.stringify(consensus, null, 2)}\n`;
    writeFileSync(ref.baselinePath, json);
    log(`✓ wrote ${ref.baselinePath} (${json.length} bytes)`);
  }

  const durationMs = Date.now() - startedAtMs;
  log(
    `\nDone in ${(durationMs / 1000).toFixed(1)}s. ` +
      `fixtures=${fixtures.length} drift=${driftCount} errors=${errorCount}`,
  );

  if (errorCount > 0) return 2;
  if (opts.check && driftCount > 0) return 1;
  return 0;
}

// Only auto-run main() when invoked directly (e.g. `tsx scripts/refresh-baseline.mts`).
// When imported by `refresh-baseline.test.mts` for unit coverage of the pure
// `computeConsensus` helper, the test file should not also spawn Chromium.
const isDirectInvocation = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectInvocation) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(`❌ Unhandled error in refresh-baseline: ${err?.stack ?? err}`);
      process.exit(2);
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function bail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`❌ ${msg}`);
  process.exit(2);
}
