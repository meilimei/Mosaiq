/**
 * `mosaiq detection-lab compare <persona-id> <runA> <runB>` — diff two runs.
 *
 * Convention: A = baseline (older / reference), B = candidate (newer / under
 * test). Deltas are computed as **B - A**, so:
 *   - `Δ weightedHits = -2.5` means B improved (fewer / lighter hits)
 *   - `Δ weightedHits = +1.0` means B regressed
 *
 * Hit identity = `(surface, site, detector)`. Same identity = same conceptual
 * issue; severity / evidence changes within an identity = "changed", not
 * added / removed.
 *
 * Site flip detection uses `raw.results[i].ok` per site:
 *   - okToFail : site was ok in A, fail in B    (regression)
 *   - failToOk : site was fail in A, ok in B    (improvement)
 *
 * Exit codes (CI policy):
 *   0 = runs equivalent or B is better (default)
 *   0 = with --fail-on-regression: B has no regressions
 *   1 = with --fail-on-regression: B has regressions
 *       (added hits, OR ΔweightedHits > 0, OR any okToFail flips)
 *   2 = run not found / arg error
 */

import { parseArgs } from 'node:util';

import { type DetectionRun, type SurfaceHit, loadDetectionRun } from '@mosaiq/sdk';

import { fmt, formatMs } from '../../output.js';
import { detectionRunPathHint, statusBadge } from './format.js';

const HELP = `Usage: mosaiq detection-lab compare <persona-id> <run-a> <run-b> [options]

Diff two saved detection runs for the same persona. Convention: A is the
baseline, B is the candidate; deltas are B - A.

Arguments:
  <persona-id>           Persona id (must own both runs).
  <run-a>                Run id of the baseline.
  <run-b>                Run id of the candidate.

Options:
  --json                 Emit machine-readable RunDiff JSON (suppresses pretty)
  --fail-on-regression   Exit 1 if B regresses vs A (added hits, higher
                         weightedHits, or sites flipped ok->fail)
  -h, --help             Show this help
`;

interface CompareOpts {
  personaId: string;
  runIdA: string;
  runIdB: string;
  json: boolean;
  failOnRegression: boolean;
  help: boolean;
}

interface HitIdentity {
  surface: string;
  site: string;
  detector: string;
}

interface ChangedHit {
  before: SurfaceHit;
  after: SurfaceHit;
  /** Specific fields that differ within the same identity. */
  diff: Array<'severity' | 'evidence'>;
}

interface RunDiff {
  personaId: string;
  runA: RunSnapshot;
  runB: RunSnapshot;
  delta: {
    weightedHits: number;
    totalHits: number;
    sitesOk: number;
    sitesFail: number;
  };
  removed: SurfaceHit[];
  added: SurfaceHit[];
  changed: ChangedHit[];
  sitesFlipped: {
    okToFail: string[];
    failToOk: string[];
  };
  /** Sites attempted in A but not in B (or vice versa). */
  sitesOnlyInA: string[];
  sitesOnlyInB: string[];
  /** True if B introduces any regression by the policy used in --fail-on-regression. */
  hasRegression: boolean;
}

interface RunSnapshot {
  id: string;
  status: DetectionRun['status'];
  durationMs: number;
  weightedHits: number;
  totalHits: number;
  sitesOk: number;
  sitesFail: number;
}

export async function runDetectionLabCompare(argv: readonly string[]): Promise<number> {
  let opts: CompareOpts;
  try {
    opts = parseCompareArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!opts.personaId || !opts.runIdA || !opts.runIdB) {
    process.stderr.write(`Error: <persona-id>, <run-a>, and <run-b> are all required.\n\n${HELP}`);
    return 2;
  }

  let runA: DetectionRun;
  let runB: DetectionRun;
  try {
    runA = loadDetectionRun(opts.personaId, opts.runIdA);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗ run A:')} ${(err as Error).message}\n`);
    return 2;
  }
  try {
    runB = loadDetectionRun(opts.personaId, opts.runIdB);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗ run B:')} ${(err as Error).message}\n`);
    return 2;
  }

  const diff = diffRuns(opts.personaId, runA, runB);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else {
    printDiff(diff, runA, runB);
  }

  if (opts.failOnRegression && diff.hasRegression) return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：diffRuns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure: compute a RunDiff from two DetectionRuns.
 *
 * Failed/canceled runs (score == null) are treated as 0 weightedHits + empty
 * hits + 0 ok/fail — caller can still see status discrepancy in the snapshot
 * blocks.
 */
export function diffRuns(personaId: string, a: DetectionRun, b: DetectionRun): RunDiff {
  const snapA = toSnapshot(a);
  const snapB = toSnapshot(b);

  const hitsA = a.score?.hits ?? [];
  const hitsB = b.score?.hits ?? [];

  const indexA = indexHits(hitsA);
  const indexB = indexHits(hitsB);

  const removed: SurfaceHit[] = [];
  const added: SurfaceHit[] = [];
  const changed: ChangedHit[] = [];

  for (const [key, hit] of indexA) {
    const counterpart = indexB.get(key);
    if (!counterpart) {
      removed.push(hit);
      continue;
    }
    const fields = diffHitFields(hit, counterpart);
    if (fields.length > 0) {
      changed.push({ before: hit, after: counterpart, diff: fields });
    }
  }
  for (const [key, hit] of indexB) {
    if (!indexA.has(key)) added.push(hit);
  }

  // Site flip detection — needs raw.results
  const resultsA = a.raw?.results ?? [];
  const resultsB = b.raw?.results ?? [];
  const okMapA = new Map(resultsA.map((r) => [r.id, r.ok]));
  const okMapB = new Map(resultsB.map((r) => [r.id, r.ok]));

  const okToFail: string[] = [];
  const failToOk: string[] = [];
  const sitesOnlyInA: string[] = [];
  const sitesOnlyInB: string[] = [];

  for (const [siteId, okA] of okMapA) {
    const okB = okMapB.get(siteId);
    if (okB === undefined) {
      sitesOnlyInA.push(siteId);
      continue;
    }
    if (okA && !okB) okToFail.push(siteId);
    else if (!okA && okB) failToOk.push(siteId);
  }
  for (const siteId of okMapB.keys()) {
    if (!okMapA.has(siteId)) sitesOnlyInB.push(siteId);
  }

  const delta = {
    weightedHits: snapB.weightedHits - snapA.weightedHits,
    totalHits: snapB.totalHits - snapA.totalHits,
    sitesOk: snapB.sitesOk - snapA.sitesOk,
    sitesFail: snapB.sitesFail - snapA.sitesFail,
  };

  const hasRegression = added.length > 0 || delta.weightedHits > 0 || okToFail.length > 0;

  return {
    personaId,
    runA: snapA,
    runB: snapB,
    delta,
    removed,
    added,
    changed,
    sitesFlipped: { okToFail, failToOk },
    sitesOnlyInA,
    sitesOnlyInB,
    hasRegression,
  };
}

function toSnapshot(run: DetectionRun): RunSnapshot {
  const score = run.score;
  return {
    id: run.id,
    status: run.status,
    durationMs: run.durationMs,
    weightedHits: score?.weightedHits ?? 0,
    totalHits: score?.hits.length ?? 0,
    sitesOk: score?.sitesOk ?? 0,
    sitesFail: score?.sitesFail ?? 0,
  };
}

function hitKey(h: HitIdentity): string {
  // 用 \x00 当分隔符，避免字段值里有 ':' / '|' 撞键
  return `${h.surface}\x00${h.site}\x00${h.detector}`;
}

function indexHits(hits: readonly SurfaceHit[]): Map<string, SurfaceHit> {
  const m = new Map<string, SurfaceHit>();
  for (const h of hits) m.set(hitKey(h), h);
  return m;
}

function diffHitFields(a: SurfaceHit, b: SurfaceHit): Array<'severity' | 'evidence'> {
  const out: Array<'severity' | 'evidence'> = [];
  if (a.severity !== b.severity) out.push('severity');
  if (a.evidence !== b.evidence) out.push('evidence');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部 helpers — args 解析 + 渲染
// ─────────────────────────────────────────────────────────────────────────────

function parseCompareArgs(argv: readonly string[]): CompareOpts {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      json: { type: 'boolean', default: false },
      'fail-on-regression': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  return {
    personaId: parsed.positionals[0] ?? '',
    runIdA: parsed.positionals[1] ?? '',
    runIdB: parsed.positionals[2] ?? '',
    json: parsed.values.json === true,
    failOnRegression: parsed.values['fail-on-regression'] === true,
    help: parsed.values.help === true,
  };
}

function printDiff(diff: RunDiff, runA: DetectionRun, runB: DetectionRun): void {
  process.stdout.write(
    `${fmt.bold('Comparing detection runs')} ${fmt.dim(`for ${diff.personaId}`)}\n\n`,
  );

  // Snapshot blocks for A and B — same structure for visual symmetry
  process.stdout.write(`  ${fmt.bold('A')} (baseline)\n`);
  printSnapshot(diff.runA, runA);
  process.stdout.write(`  ${fmt.bold('B')} (candidate)\n`);
  printSnapshot(diff.runB, runB);

  // Delta line
  const deltaLine = formatDelta(diff.delta);
  process.stdout.write(`\n${fmt.bold('Δ')} ${deltaLine}\n`);

  // Site list discrepancy warning (different --only flags between runs etc.)
  if (diff.sitesOnlyInA.length > 0 || diff.sitesOnlyInB.length > 0) {
    process.stdout.write(`\n${fmt.yellow('⚠ site lists differ:')}\n`);
    if (diff.sitesOnlyInA.length > 0) {
      process.stdout.write(`    only in A: ${diff.sitesOnlyInA.join(', ')}\n`);
    }
    if (diff.sitesOnlyInB.length > 0) {
      process.stdout.write(`    only in B: ${diff.sitesOnlyInB.join(', ')}\n`);
    }
  }

  // Site flips
  if (diff.sitesFlipped.okToFail.length > 0) {
    process.stdout.write(
      `\n${fmt.red('✗ Sites flipped ok → fail:')} ${diff.sitesFlipped.okToFail.join(', ')}\n`,
    );
  }
  if (diff.sitesFlipped.failToOk.length > 0) {
    process.stdout.write(
      `\n${fmt.green('✓ Sites flipped fail → ok:')} ${diff.sitesFlipped.failToOk.join(', ')}\n`,
    );
  }

  // Hit changes
  if (diff.removed.length > 0) {
    process.stdout.write(`\n${fmt.green(`✓ Removed (${diff.removed.length}):`)}\n`);
    for (const h of diff.removed) printHitLine(h);
  }
  if (diff.added.length > 0) {
    process.stdout.write(`\n${fmt.red(`✗ Added (${diff.added.length}):`)}\n`);
    for (const h of diff.added) printHitLine(h);
  }
  if (diff.changed.length > 0) {
    process.stdout.write(`\n${fmt.yellow(`~ Changed (${diff.changed.length}):`)}\n`);
    for (const c of diff.changed) printChangedHit(c);
  }

  if (
    diff.removed.length === 0 &&
    diff.added.length === 0 &&
    diff.changed.length === 0 &&
    diff.sitesFlipped.okToFail.length === 0 &&
    diff.sitesFlipped.failToOk.length === 0
  ) {
    process.stdout.write(`\n${fmt.dim('No changes — runs are equivalent.')}\n`);
  }

  // Verdict footer
  process.stdout.write('\n');
  if (diff.hasRegression) {
    process.stdout.write(`${fmt.red('Verdict:')} B regresses vs A.\n`);
  } else if (diff.delta.weightedHits < 0 || diff.removed.length > 0) {
    process.stdout.write(`${fmt.green('Verdict:')} B improves on A.\n`);
  } else {
    process.stdout.write(`${fmt.dim('Verdict:')} no material change.\n`);
  }
}

function printSnapshot(snap: RunSnapshot, run: DetectionRun): void {
  process.stdout.write(`    runId        : ${fmt.cyan(snap.id)}\n`);
  process.stdout.write(`    status       : ${statusBadge(snap.status)}\n`);
  process.stdout.write(`    duration     : ${formatMs(snap.durationMs)}\n`);
  process.stdout.write(
    `    sites        : ${fmt.green(`${snap.sitesOk} ok`)} · ${snap.sitesFail > 0 ? fmt.red(`${snap.sitesFail} fail`) : `${snap.sitesFail} fail`}\n`,
  );
  process.stdout.write(
    `    hits         : ${snap.totalHits} ${fmt.dim(`(weighted ${snap.weightedHits.toFixed(2)})`)}\n`,
  );
  process.stdout.write(
    `    saved        : ${fmt.dim(detectionRunPathHint(run.personaId, run.id))}\n`,
  );
}

function formatDelta(delta: RunDiff['delta']): string {
  const wh = delta.weightedHits;
  const whDir = wh < 0 ? fmt.green('↓') : wh > 0 ? fmt.red('↑') : fmt.dim('=');
  const whStr = `${wh > 0 ? '+' : ''}${wh.toFixed(2)}`;
  const th = delta.totalHits;
  const thDir = th < 0 ? fmt.green('↓') : th > 0 ? fmt.red('↑') : fmt.dim('=');
  const thStr = `${th > 0 ? '+' : ''}${th}`;
  const so = delta.sitesOk;
  const sf = delta.sitesFail;
  return (
    `weightedHits ${whDir} ${whStr}  ` +
    `· hits ${thDir} ${thStr}  ` +
    `· sites Δok ${so > 0 ? '+' : ''}${so}, Δfail ${sf > 0 ? '+' : ''}${sf}`
  );
}

function printHitLine(h: SurfaceHit): void {
  const sevColor = h.severity === 'high' ? fmt.red : h.severity === 'medium' ? fmt.yellow : fmt.dim;
  process.stdout.write(
    `    ${sevColor('●')} ${fmt.cyan(h.surface)} · ${fmt.dim(h.site)} — ${h.detector} ${fmt.dim(`[${h.severity}]`)}\n`,
  );
  if (h.evidence) {
    process.stdout.write(`        ${fmt.dim(h.evidence)}\n`);
  }
}

function printChangedHit(c: ChangedHit): void {
  const { before, after, diff } = c;
  process.stdout.write(
    `    ${fmt.yellow('●')} ${fmt.cyan(after.surface)} · ${fmt.dim(after.site)} — ${after.detector}\n`,
  );
  if (diff.includes('severity')) {
    process.stdout.write(
      `        severity : ${fmt.dim(before.severity)} → ${fmt.bold(after.severity)}\n`,
    );
  }
  if (diff.includes('evidence')) {
    process.stdout.write(`        evidence : ${fmt.dim(before.evidence)}\n`);
    process.stdout.write(`                   ${after.evidence}\n`);
  }
}
