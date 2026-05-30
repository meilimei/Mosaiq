/**
 * `mosaiq detection-lab run-all` — multi-persona batch CI gate (v0.9 phase 9.10).
 *
 * 给所有 personas（或 --only / --skip 子集）顺序跑 Detection Lab，把每次 run
 * 像单 persona `run` 一样落盘到 `~/.mosaiq/detection-runs/<id>/<runId>.json`，
 * 然后输出聚合表 + 决策 exit code。
 *
 * 和 9.2b `compare --fail-on-regression` 的关系：
 *   - 9.2b 是单 persona 单次比较的 gate（手工指定 runA / runB）
 *   - 9.10 是多 persona 自动比较的 gate（每个 persona 自动取上一次 saved
 *     completed run 作 baseline，自动 diff 本次刚跑的 run）
 *   两者**正交**：9.2b 适合手工确认某次提交的影响；9.10 适合 nightly cron。
 *
 * 串行而非并发：v0.9 只支持 concurrency=1。Chrome user-data-dir 每个 persona
 * 一份，理论上能并发，但 hardware fingerprint（GPU 帧率 / audio context jitter）
 * 在并发负载下不稳定，会让 detection score 受调度噪声污染。--concurrency
 * 选项保留 surface 让未来加 multi-process fork 时不破协议。
 *
 * 退出码：
 *   0 = 全 OK 且策略没触发
 *   1 = 任一 persona runtime failed / 命中 --fail-on-hits / --fail-on-regression
 *   2 = 参数错 / 未发现可跑的 persona / 一开始就没有 persona
 *   130 = SIGINT 取消（与单 persona run 一致）
 */

import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  type DetectionRun,
  type Persona,
  type RunDetectionOptions,
  type RunProgressEvent,
  diffRuns,
  getDetectionRunArtifactDir,
  listDetectionRuns,
  listPersonas,
  loadDetectionRun,
  runDetection,
  saveDetectionRun,
} from '@runova/sdk';

import { fmt, formatMs, renderTable } from '../../output.js';
import { statusBadge } from './format.js';
import {
  type BatchAggregate,
  type BatchPolicy,
  type FailOnHitsLevel,
  type PersonaBatchResult,
  type RegressionInfo,
  aggregateBatch,
  decideBatchExitCode,
  findRegressionBaseline,
  selectPersonas,
} from './run-all-helpers.js';
import { buildCompletedRun, buildFailedRun, extractTemplateTag } from './run-helpers.js';

const HELP = `Usage: mosaiq detection-lab run-all [options]

Run a Detection Lab pass for every persona (or a filtered subset) in
sequence, save each run, and emit an aggregated summary. CI-friendly:
returns a single exit code policy across all personas.

Options:
  --only <ids>            Comma-separated persona ids to include (default: all)
  --skip <ids>            Comma-separated persona ids to exclude
  --headed                Launch Chromium with a visible window (default: headless)
  --only-sites <ids>      Comma-separated site ids to include in EACH run
  --skip-sites <ids>      Comma-separated site ids to exclude in EACH run
  --retries <n>           Max retries per site (default: 2)
  --timeout <ms>          Per-site timeout in ms (default: 60000)
  --template <name>       Persona template name written into each raw.persona.template
                          (default: read from each persona's \`template:<x>\` tag)
  --fail-on-hits <level>  Aggregate exit-code policy. Levels: none|any|medium|high
                          (default: none — runtime failures still trigger exit 1)
  --fail-on-regression    Exit 1 if any persona regressed vs its previous saved run
                          (per-persona baseline = most recent completed run)
  --concurrency <n>       Reserved for future use; only 1 supported in v0.9 (default: 1)
  --json                  Emit aggregated BatchRunResult JSON (suppresses progress)
  --quiet                 Suppress per-persona / per-site progress (still prints summary)
  -h, --help              Show this help

Examples:
  mosaiq detection-lab run-all
  mosaiq detection-lab run-all --only alice,bob --fail-on-regression
  mosaiq detection-lab run-all --fail-on-hits medium --json > batch.json
  mosaiq detection-lab run-all --only-sites creepjs,sannysoft --quiet
`;

interface RunAllOpts {
  only?: string[];
  skip?: string[];
  headed: boolean;
  onlySites?: string[];
  skipSites?: string[];
  retries: number;
  timeoutMs: number;
  template?: string;
  failOnHits: FailOnHitsLevel;
  failOnRegression: boolean;
  concurrency: number;
  json: boolean;
  quiet: boolean;
  help: boolean;
}

const SCHEMA_VERSION = 1 as const;

/** Top-level batch run result — same shape as `--json` output, structured-clone safe. */
interface BatchRunResult {
  schemaVersion: typeof SCHEMA_VERSION;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  policy: BatchPolicy;
  personas: PersonaBatchResult[];
  aggregate: BatchAggregate;
  exitCode: number;
}

export async function runDetectionLabRunAll(argv: readonly string[]): Promise<number> {
  let opts: RunAllOpts;
  try {
    opts = parseRunAllArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 1. List + filter personas
  // ───────────────────────────────────────────────────────────────────────
  const allPersonas = listPersonas();
  if (allPersonas.length === 0) {
    process.stderr.write(
      `${fmt.red('✗')} No personas found in ~/.mosaiq/personas/.\n` +
        `${fmt.dim('Tip: create one in the desktop app, or via')} ${fmt.cyan('mosaiq personas create')}\n`,
    );
    return 2;
  }

  const selection = selectPersonas(allPersonas, {
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.skip ? { skip: opts.skip } : {}),
  });
  if (selection.unknownIds.length > 0 && !opts.json) {
    process.stderr.write(
      `${fmt.yellow('⚠')} Unknown persona ids in --only / --skip: ${selection.unknownIds.join(', ')}\n`,
    );
  }
  if (selection.selected.length === 0) {
    process.stderr.write(`${fmt.red('✗')} No personas selected after applying --only / --skip.\n`);
    return 2;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 2. Hook SIGINT → AbortController (shared across all personas in batch)
  // ───────────────────────────────────────────────────────────────────────
  const abort = new AbortController();
  let canceledViaSigint = false;
  const onSigint = () => {
    if (canceledViaSigint) {
      process.exit(130);
    }
    canceledViaSigint = true;
    if (!opts.json) {
      process.stderr.write(
        `\n${fmt.yellow('⚠')} cancel requested — finishing current persona then aborting (Ctrl-C again to force-quit)\n`,
      );
    }
    abort.abort();
  };
  process.on('SIGINT', onSigint);

  const policy: BatchPolicy = {
    failOnHits: opts.failOnHits,
    failOnRegression: opts.failOnRegression,
  };

  // ───────────────────────────────────────────────────────────────────────
  // 3. Preflight (unless --json)
  // ───────────────────────────────────────────────────────────────────────
  if (!opts.json && !opts.quiet) {
    printBatchPreflight(selection.selected, opts);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 4. Sequential driver loop
  // ───────────────────────────────────────────────────────────────────────
  const batchStartedAtMs = Date.now();
  const batchStartedAtIso = new Date(batchStartedAtMs).toISOString();
  const results: PersonaBatchResult[] = [];

  for (let i = 0; i < selection.selected.length; i++) {
    const persona = selection.selected[i];
    if (!persona) continue;

    if (abort.signal.aborted) {
      // user pressed Ctrl-C between personas → mark remaining as skipped
      results.push(makeSkippedResult(persona, 'canceled before start'));
      continue;
    }

    if (!opts.json && !opts.quiet) {
      printPersonaHeader(i + 1, selection.selected.length, persona);
    }

    const result = await runOnePersona(persona, opts, abort.signal, {
      json: opts.json,
      quiet: opts.quiet,
    });
    results.push(result);

    if (!opts.json && !opts.quiet) {
      printPersonaFooter(result);
    }
  }

  process.off('SIGINT', onSigint);

  // ───────────────────────────────────────────────────────────────────────
  // 5. Aggregate + decide exit code
  // ───────────────────────────────────────────────────────────────────────
  const finishedAtMs = Date.now();
  const aggregate = aggregateBatch(results);
  const exitCode = abort.signal.aborted ? 130 : decideBatchExitCode(aggregate, policy);

  const batchResult: BatchRunResult = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: batchStartedAtIso,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - batchStartedAtMs,
    policy,
    personas: results,
    aggregate,
    exitCode,
  };

  // ───────────────────────────────────────────────────────────────────────
  // 6. Output
  // ───────────────────────────────────────────────────────────────────────
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(batchResult, null, 2)}\n`);
  } else {
    process.stdout.write('\n');
    printBatchSummary(batchResult);
  }

  return exitCode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-persona: run + (optional) regression diff
// ─────────────────────────────────────────────────────────────────────────────

async function runOnePersona(
  persona: Persona,
  opts: RunAllOpts,
  signal: AbortSignal,
  output: { json: boolean; quiet: boolean },
): Promise<PersonaBatchResult> {
  const personaId = persona.metadata.id;
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const runId = startedAtIso.replace(/[:.]/g, '-');
  const artifactDir = getDetectionRunArtifactDir(personaId, runId);
  const personaTemplate = opts.template ?? extractTemplateTag(persona) ?? 'unknown';

  mkdirSync(artifactDir, { recursive: true });

  const sdkOptions: RunDetectionOptions = {
    runId,
    personaTemplate,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.retries,
    artifactDir,
    signal,
    launchOptions: { headless: !opts.headed },
    ...(opts.onlySites ? { only: opts.onlySites } : {}),
    ...(opts.skipSites ? { skip: opts.skipSites } : {}),
    onProgress: (evt) => {
      if (output.json || output.quiet) return;
      printSiteProgress(evt);
    },
  };

  let run: DetectionRun;
  try {
    const result = await runDetection(persona, sdkOptions);
    const status = signal.aborted ? 'canceled' : 'completed';
    run = buildCompletedRun({
      runId,
      personaId,
      startedAtIso,
      startedAtMs,
      status,
      raw: result.raw,
      score: result.score,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run = buildFailedRun({
      runId,
      personaId,
      startedAtIso,
      startedAtMs,
      error: message,
    });
    try {
      saveDetectionRun(personaId, run);
    } catch {
      // Persisting a failed run is best-effort
    }
    return runToBatchResult(persona, run, null);
  }

  saveDetectionRun(personaId, run);

  // Regression detection (only meaningful for completed runs and when policy asks)
  let regression: RegressionInfo | null = null;
  if (run.status === 'completed' && opts.failOnRegression) {
    regression = computeRegression(personaId, run);
  }

  return runToBatchResult(persona, run, regression);
}

/**
 * Compare current run against the most recent saved completed predecessor.
 * Returns null if no baseline exists or the current run is not regressed.
 *
 * Uses 9.8's pure SDK `diffRuns` — same logic as `compare --fail-on-regression`.
 */
function computeRegression(personaId: string, current: DetectionRun): RegressionInfo | null {
  let history: DetectionRun[] = [];
  try {
    const summaries = listDetectionRuns(personaId);
    history = summaries
      .filter((s) => s.status === 'completed' && s.runId !== current.id)
      .map((s) => {
        try {
          return loadDetectionRun(personaId, s.runId);
        } catch {
          return null;
        }
      })
      .filter((r): r is DetectionRun => r !== null);
  } catch {
    return null;
  }

  const baseline = findRegressionBaseline(current, history);
  if (!baseline) return null;

  const diff = diffRuns(personaId, baseline, current);
  if (!diff.hasRegression) return null;

  return {
    previousRunId: baseline.id,
    addedHits: diff.added.length,
    deltaWeightedHits: diff.delta.weightedHits,
    okToFail: [...diff.sitesFlipped.okToFail],
  };
}

function runToBatchResult(
  persona: Persona,
  run: DetectionRun,
  regression: RegressionInfo | null,
): PersonaBatchResult {
  const score = run.score;
  const hits = score?.hits ?? [];
  const high = hits.filter((h) => h.severity === 'high').length;
  const medium = hits.filter((h) => h.severity === 'medium').length;
  const low = hits.filter((h) => h.severity === 'low').length;

  return {
    personaId: persona.metadata.id,
    displayName: persona.metadata.displayName,
    status: run.status === 'pending' || run.status === 'running' ? 'failed' : run.status,
    runId: run.id,
    durationMs: run.durationMs,
    sitesAttempted: run.sitesAttempted.length,
    sitesOk: score?.sitesOk ?? 0,
    sitesFail: score?.sitesFail ?? 0,
    totalHits: hits.length,
    weightedHits: score?.weightedHits ?? 0,
    highHits: high,
    mediumHits: medium,
    lowHits: low,
    error: run.error,
    regression,
  };
}

function makeSkippedResult(persona: Persona, reason: string): PersonaBatchResult {
  return {
    personaId: persona.metadata.id,
    displayName: persona.metadata.displayName,
    status: 'skipped',
    runId: null,
    durationMs: 0,
    sitesAttempted: 0,
    sitesOk: 0,
    sitesFail: 0,
    totalHits: 0,
    weightedHits: 0,
    highHits: 0,
    mediumHits: 0,
    lowHits: 0,
    error: reason,
    regression: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// argv 解析
// ─────────────────────────────────────────────────────────────────────────────

function parseRunAllArgs(argv: readonly string[]): RunAllOpts {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      only: { type: 'string' },
      skip: { type: 'string' },
      headed: { type: 'boolean', default: false },
      'only-sites': { type: 'string' },
      'skip-sites': { type: 'string' },
      retries: { type: 'string', default: '2' },
      timeout: { type: 'string', default: '60000' },
      template: { type: 'string' },
      'fail-on-hits': { type: 'string', default: 'none' },
      'fail-on-regression': { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '1' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const retries = parseIntStrict(parsed.values.retries as string, 'retries');
  if (retries < 0) throw new Error('--retries must be >= 0');

  const timeoutMs = parseIntStrict(parsed.values.timeout as string, 'timeout');
  if (timeoutMs < 1_000) throw new Error('--timeout must be >= 1000 ms');

  const concurrency = parseIntStrict(parsed.values.concurrency as string, 'concurrency');
  if (concurrency !== 1) {
    throw new Error('--concurrency only supports 1 in v0.9 (parallel runs reserved for future)');
  }

  const failOnHits = parsed.values['fail-on-hits'] as string;
  if (!['none', 'any', 'medium', 'high'].includes(failOnHits)) {
    throw new Error(
      `--fail-on-hits must be one of: none | any | medium | high (got '${failOnHits}')`,
    );
  }

  return {
    only: splitCsvOrUndefined(parsed.values.only as string | undefined),
    skip: splitCsvOrUndefined(parsed.values.skip as string | undefined),
    headed: parsed.values.headed === true,
    onlySites: splitCsvOrUndefined(parsed.values['only-sites'] as string | undefined),
    skipSites: splitCsvOrUndefined(parsed.values['skip-sites'] as string | undefined),
    retries,
    timeoutMs,
    template: parsed.values.template as string | undefined,
    failOnHits: failOnHits as FailOnHitsLevel,
    failOnRegression: parsed.values['fail-on-regression'] === true,
    concurrency,
    json: parsed.values.json === true,
    quiet: parsed.values.quiet === true,
    help: parsed.values.help === true,
  };
}

function parseIntStrict(s: string, name: string): number {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || String(n) !== s.trim()) {
    throw new Error(`--${name} must be an integer (got '${s}')`);
  }
  return n;
}

function splitCsvOrUndefined(s: string | undefined): string[] | undefined {
  if (!s) return undefined;
  const ids = s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output: per-persona progress (TTY mode)
// ─────────────────────────────────────────────────────────────────────────────

function printBatchPreflight(personas: readonly Persona[], opts: RunAllOpts): void {
  const lines: string[] = [];
  lines.push(
    `${fmt.bold('Detection Lab')} ${fmt.dim('—')} batch (${personas.length} persona${personas.length === 1 ? '' : 's'})`,
  );
  lines.push(`  mode         : ${opts.headed ? fmt.yellow('headed') : 'headless'}`);
  if (opts.onlySites) lines.push(`  only-sites   : ${opts.onlySites.join(', ')}`);
  if (opts.skipSites) lines.push(`  skip-sites   : ${opts.skipSites.join(', ')}`);
  lines.push(`  retries      : ${opts.retries}`);
  lines.push(`  timeout      : ${formatMs(opts.timeoutMs)}`);
  if (opts.failOnHits !== 'none') lines.push(`  fail-on-hits : ${opts.failOnHits}`);
  if (opts.failOnRegression) lines.push(`  fail-on-reg  : ${fmt.yellow('on')}`);
  process.stdout.write(`${lines.join('\n')}\n\n`);
}

let progressCounter = 0;

function printPersonaHeader(idx: number, total: number, p: Persona): void {
  progressCounter = 0;
  const label = p.metadata.displayName ? ` ${fmt.dim(`(${p.metadata.displayName})`)}` : '';
  process.stdout.write(`${fmt.bold(`[${idx}/${total}]`)} ${fmt.cyan(p.metadata.id)}${label}\n`);
}

function printPersonaFooter(r: PersonaBatchResult): void {
  const dur = formatMs(r.durationMs);
  if (r.status === 'completed') {
    const tail =
      r.totalHits === 0
        ? fmt.green(`${dur}  0 hits`)
        : `${dur}  ${fmt.yellow(`${r.totalHits} hits`)} ${fmt.dim(`(weighted ${r.weightedHits.toFixed(2)})`)}`;
    const reg = r.regression ? `  ${fmt.red('REGRESSION')}` : '';
    process.stdout.write(`    ${fmt.green('✓ done')}  ${tail}${reg}\n\n`);
  } else if (r.status === 'canceled') {
    process.stdout.write(`    ${fmt.yellow('⚠ canceled')}  ${dur}\n\n`);
  } else if (r.status === 'failed') {
    process.stdout.write(`    ${fmt.red('✗ failed')}  ${dur}  ${fmt.dim(r.error ?? '')}\n\n`);
  } else {
    process.stdout.write(`    ${fmt.dim('· skipped')}  ${fmt.dim(r.error ?? '')}\n\n`);
  }
}

function printSiteProgress(evt: RunProgressEvent): void {
  switch (evt.phase) {
    case 'init':
      progressCounter = 0;
      if (evt.totalSites != null) {
        process.stdout.write(`    ${fmt.dim(`scanning ${evt.totalSites} sites…`)}\n`);
      }
      break;
    case 'site-start':
      progressCounter += 1;
      process.stdout.write(
        `    ${fmt.dim(`[${progressCounter}]`)} ${evt.siteId ?? '?'} ${fmt.dim('…')}`,
      );
      break;
    case 'site-retry':
      process.stdout.write(`\n      ${fmt.yellow('↻ retry')} #${evt.retryAttempt ?? '?'}`);
      break;
    case 'site-end': {
      const ok = evt.siteOk === true;
      const mark = ok ? fmt.green('✓') : fmt.red('✗');
      const dur = evt.siteDurationMs != null ? fmt.dim(formatMs(evt.siteDurationMs)) : '';
      process.stdout.write(` ${mark} ${dur}\n`);
      break;
    }
    case 'done':
    case 'canceled':
    case 'error':
      // 终态由 footer 处理
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output: final aggregated summary
// ─────────────────────────────────────────────────────────────────────────────

function printBatchSummary(result: BatchRunResult): void {
  const { personas, aggregate, policy } = result;

  // Per-persona table
  const table = renderTable(personas, [
    { header: 'PERSONA', get: (r) => fmt.cyan(r.personaId) },
    { header: 'STATUS', get: (r) => batchStatusBadge(r.status) },
    {
      header: 'SITES OK/FAIL',
      get: (r) =>
        `${fmt.green(`${r.sitesOk}`)}/${r.sitesFail > 0 ? fmt.red(`${r.sitesFail}`) : `${r.sitesFail}`}`,
    },
    {
      header: 'HITS',
      get: (r) => (r.totalHits === 0 ? fmt.green('0') : `${r.totalHits}`),
    },
    {
      header: 'WEIGHTED',
      get: (r) => r.weightedHits.toFixed(2),
    },
    {
      header: 'REGRESSION',
      get: (r) => (r.regression ? fmt.red('yes') : fmt.dim('—')),
    },
    { header: 'DURATION', get: (r) => formatMs(r.durationMs) },
  ]);
  process.stdout.write(`${table}\n\n`);

  // Aggregate summary block
  const lines: string[] = [];
  lines.push(`${fmt.bold('Summary')}  ${formatMs(result.durationMs)} elapsed`);

  const failedSeg =
    aggregate.personasFailed > 0
      ? ` · ${fmt.red(`${aggregate.personasFailed} failed`)}`
      : ` · ${aggregate.personasFailed} failed`;
  const canceledSeg =
    aggregate.personasCanceled > 0
      ? ` · ${fmt.yellow(`${aggregate.personasCanceled} canceled`)}`
      : '';
  lines.push(
    `  personas      : ${aggregate.personasAttempted} attempted · ${fmt.green(`${aggregate.personasCompleted} completed`)}${failedSeg}${canceledSeg}`,
  );
  lines.push(
    `  sites total   : ${aggregate.sitesAttempted} attempted · ${fmt.green(`${aggregate.sitesOk} ok`)} · ${aggregate.sitesFail > 0 ? fmt.red(`${aggregate.sitesFail} fail`) : `${aggregate.sitesFail} fail`}`,
  );
  const highSeg = aggregate.highHits > 0 ? ` · ${fmt.red(`${aggregate.highHits} high`)}` : '';
  const medSeg =
    aggregate.mediumHits > 0 ? ` · ${fmt.yellow(`${aggregate.mediumHits} medium`)}` : '';
  const lowSeg = aggregate.lowHits > 0 ? ` · ${aggregate.lowHits} low` : '';
  lines.push(
    `  hits total    : ${aggregate.totalHits} ${fmt.dim(`(weighted ${aggregate.weightedHits.toFixed(2)})`)}${highSeg}${medSeg}${lowSeg}`,
  );
  if (aggregate.personasWithRegression.length > 0) {
    lines.push(
      `  regressions   : ${fmt.red(`${aggregate.personasWithRegression.length}`)} (${aggregate.personasWithRegression.join(', ')})`,
    );
  }
  if (aggregate.worstPersona) {
    const w = aggregate.worstPersona;
    lines.push(
      `  worst persona : ${fmt.cyan(w.personaId)} (${w.totalHits} hits, weighted ${w.weightedHits.toFixed(2)})`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n\n`);

  // Verdict footer
  process.stdout.write(`${verdictLine(result.exitCode, aggregate, policy)}\n`);
}

function batchStatusBadge(status: PersonaBatchResult['status']): string {
  // Reuse statusBadge for the 3 DetectionRun states; add 'skipped' locally.
  if (status === 'skipped') return fmt.dim('· skipped');
  return statusBadge(status);
}

function verdictLine(exitCode: number, aggregate: BatchAggregate, policy: BatchPolicy): string {
  if (exitCode === 130) return `${fmt.yellow('Verdict:')} batch canceled by user.`;
  if (exitCode === 0) {
    const tag = fmt.green('Verdict:');
    return `${tag} all ${aggregate.personasCompleted} persona${aggregate.personasCompleted === 1 ? '' : 's'} clean.`;
  }
  // exit 1
  const reasons: string[] = [];
  if (aggregate.personasFailed > 0) reasons.push(`${aggregate.personasFailed} runtime failure(s)`);
  if (policy.failOnRegression && aggregate.personasWithRegression.length > 0) {
    reasons.push(`${aggregate.personasWithRegression.length} regression(s)`);
  }
  if (policy.failOnHits !== 'none') {
    reasons.push(`hits ≥ ${policy.failOnHits}`);
  }
  return `${fmt.red('Verdict:')} ${reasons.length > 0 ? reasons.join(', ') : 'failure(s) detected'}.`;
}
