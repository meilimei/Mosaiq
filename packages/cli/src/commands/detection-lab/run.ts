/**
 * `mosaiq detection-lab run <persona-id>` — 跑一次 Detection Lab。
 *
 * 行为对齐 Desktop main process（`apps/desktop/electron/main.ts:executeDetectionRunAsync`）：
 *   1. loadPersona(personaId)
 *   2. 解析 runId / artifactDir（路径与 desktop / bench 完全一致 — `~/.mosaiq/detection-runs/<id>/...`）
 *   3. runDetection(persona, options) — onProgress 回调实时打印 / `--json` 模式抑制
 *   4. 包装成 DetectionRun（含 sdkVersion / chromiumVersion / status）
 *   5. saveDetectionRun(personaId, run)
 *   6. 输出：pretty summary（默认） 或 完整 DetectionRun JSON（`--json`）
 *
 * 退出码：
 *   0 = run 完成且 hits === 0（CI 友好：可作为"无回归"绿灯）
 *   1 = run 完成但有 hits（让 CI 失败到使用方决定）
 *   2 = 参数错 / persona 未找到 / 启动失败
 *   130 = SIGINT（Ctrl-C）触发的 cancel — Unix 惯例
 *
 * `--fail-on-hits=<level>`（默认 `none`）控制非零退出码触发条件：
 *   - `none`：永远 0（除参数错 / 启动失败）
 *   - `any`：任何 hit 都失败
 *   - `medium`：medium / high hit 失败
 *   - `high`：仅 high hit 失败
 */

import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  type DetectionRun,
  type DetectionRunRaw,
  type DetectionScore,
  type Persona,
  type RunDetectionOptions,
  type RunProgressEvent,
  SDK_VERSION,
  getDetectionRunArtifactDir,
  getInstalledChromeVersion,
  loadPersona,
  runDetection,
  saveDetectionRun,
} from '@mosaiq/sdk';

import { fmt, formatMs } from '../../output.js';
import { printRunSummary } from './format.js';

const HELP = `Usage: mosaiq detection-lab run <persona-id> [options]

Run a Detection Lab pass for the given persona. Saves a DetectionRun JSON
to ~/.mosaiq/detection-runs/<persona-id>/<runId>.json (same layout as the
desktop app), plus per-site HTML / PNG artifacts under <runId>/.

Arguments:
  <persona-id>           Persona id (e.g. 'baseline-bench-mp9itrpe').
                         Use \`mosaiq personas list\` to discover ids.

Options:
  --headed               Launch Chromium with a visible window (default: headless)
  --only <ids>           Comma-separated site ids to include (e.g. 'creepjs,sannysoft')
  --skip <ids>           Comma-separated site ids to exclude
  --retries <n>          Max retries per site (default: 2)
  --timeout <ms>         Per-site timeout in ms (default: 60000)
  --template <name>      Persona template name written into raw.persona.template
                         (default: read from \`template:<x>\` tag, else 'unknown')
  --json                 Emit full DetectionRun JSON to stdout instead of
                         a human-readable summary; suppresses progress
  --quiet                Suppress per-site progress (still prints final summary)
  --fail-on-hits <level> Exit non-zero if hits >= level. Levels: none|any|medium|high
                         (default: none)
  -h, --help             Show this help
`;

interface RunOpts {
  personaId: string;
  headed: boolean;
  only?: string[];
  skip?: string[];
  retries: number;
  timeoutMs: number;
  template?: string;
  json: boolean;
  quiet: boolean;
  failOnHits: 'none' | 'any' | 'medium' | 'high';
  help: boolean;
}

export async function runDetectionLabCommand(argv: readonly string[]): Promise<number> {
  let opts: RunOpts;
  try {
    opts = parseRunArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (!opts.personaId) {
    process.stderr.write(`Error: <persona-id> is required.\n\n${HELP}`);
    return 2;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 1. Load persona
  // ───────────────────────────────────────────────────────────────────────
  let persona: Persona;
  try {
    persona = loadPersona(opts.personaId);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 2. Resolve runId + artifactDir (must match desktop layout exactly)
  // ───────────────────────────────────────────────────────────────────────
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const runId = startedAtIso.replace(/[:.]/g, '-');
  const artifactDir = getDetectionRunArtifactDir(opts.personaId, runId);

  // ───────────────────────────────────────────────────────────────────────
  // 3. Hook SIGINT → AbortController so Ctrl-C cancels gracefully
  // ───────────────────────────────────────────────────────────────────────
  const abort = new AbortController();
  let canceledViaSigint = false;
  const onSigint = () => {
    if (canceledViaSigint) {
      // Second Ctrl-C — let the user force-quit
      process.exit(130);
    }
    canceledViaSigint = true;
    if (!opts.json) {
      process.stderr.write(`\n${fmt.yellow('⚠')} cancel requested (Ctrl-C again to force-quit)\n`);
    }
    abort.abort();
  };
  process.on('SIGINT', onSigint);

  // ───────────────────────────────────────────────────────────────────────
  // 4. Resolve template + print preflight (unless --json)
  // ───────────────────────────────────────────────────────────────────────
  const personaTemplate = opts.template ?? extractTemplateTag(persona) ?? 'unknown';

  if (!opts.json) {
    printPreflight({
      personaId: opts.personaId,
      personaName: persona.metadata.displayName,
      personaTemplate,
      runId,
      headed: opts.headed,
      only: opts.only,
      skip: opts.skip,
      retries: opts.retries,
      timeoutMs: opts.timeoutMs,
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // 5. Build runDetection options + onProgress printer
  // ───────────────────────────────────────────────────────────────────────
  // Ensure artifactDir exists (runDetection will mkdir it too, but pre-creating
  // makes the path inspectable from ANOTHER terminal mid-run for debugging.)
  mkdirSync(artifactDir, { recursive: true });

  const sdkOptions: RunDetectionOptions = {
    runId,
    personaTemplate,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.retries,
    artifactDir,
    signal: abort.signal,
    launchOptions: { headless: !opts.headed },
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.skip ? { skip: opts.skip } : {}),
    onProgress: (evt) => {
      if (opts.json || opts.quiet) return;
      printProgress(evt);
    },
  };

  // ───────────────────────────────────────────────────────────────────────
  // 6. Run + wrap into DetectionRun + persist
  // ───────────────────────────────────────────────────────────────────────
  let run: DetectionRun;
  try {
    const result = await runDetection(persona, sdkOptions);
    const status = abort.signal.aborted ? 'canceled' : 'completed';
    run = buildCompletedRun({
      runId,
      personaId: opts.personaId,
      startedAtIso,
      startedAtMs,
      status,
      raw: result.raw,
      score: result.score,
    });
  } catch (err) {
    process.off('SIGINT', onSigint);
    const message = err instanceof Error ? err.message : String(err);
    run = buildFailedRun({
      runId,
      personaId: opts.personaId,
      startedAtIso,
      startedAtMs,
      error: message,
    });
    try {
      saveDetectionRun(opts.personaId, run);
    } catch {
      // Persisting a failed run is best-effort; surface the original error
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    } else {
      process.stderr.write(`\n${fmt.red('✗ run failed:')} ${message}\n`);
    }
    return 2;
  } finally {
    process.off('SIGINT', onSigint);
  }

  saveDetectionRun(opts.personaId, run);

  // ───────────────────────────────────────────────────────────────────────
  // 7. Output
  // ───────────────────────────────────────────────────────────────────────
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  } else {
    process.stdout.write('\n');
    printRunSummary(run);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 8. Exit code (CI policy)
  // ───────────────────────────────────────────────────────────────────────
  if (run.status === 'canceled') return 130;
  if (run.status !== 'completed') return 2;

  const hits = run.score?.hits ?? [];
  if (shouldFail(hits, opts.failOnHits)) return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部 helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseRunArgs(argv: readonly string[]): RunOpts {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      headed: { type: 'boolean', default: false },
      only: { type: 'string' },
      skip: { type: 'string' },
      retries: { type: 'string', default: '2' },
      timeout: { type: 'string', default: '60000' },
      template: { type: 'string' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      'fail-on-hits': { type: 'string', default: 'none' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const positionals = parsed.positionals;
  const personaId = positionals[0] ?? '';

  const retries = parseIntStrict(parsed.values.retries as string, 'retries');
  if (retries < 0) throw new Error('--retries must be >= 0');

  const timeoutMs = parseIntStrict(parsed.values.timeout as string, 'timeout');
  if (timeoutMs < 1_000) throw new Error('--timeout must be >= 1000 ms');

  const failOnHits = parsed.values['fail-on-hits'] as string;
  if (!['none', 'any', 'medium', 'high'].includes(failOnHits)) {
    throw new Error(
      `--fail-on-hits must be one of: none | any | medium | high (got '${failOnHits}')`,
    );
  }

  return {
    personaId,
    headed: parsed.values.headed === true,
    only: splitCsvOrUndefined(parsed.values.only as string | undefined),
    skip: splitCsvOrUndefined(parsed.values.skip as string | undefined),
    retries,
    timeoutMs,
    template: parsed.values.template as string | undefined,
    json: parsed.values.json === true,
    quiet: parsed.values.quiet === true,
    failOnHits: failOnHits as RunOpts['failOnHits'],
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

function extractTemplateTag(p: { metadata: { tags?: readonly string[] } }): string | undefined {
  const tags = p.metadata.tags ?? [];
  for (const tag of tags) {
    if (tag.startsWith('template:')) return tag.slice('template:'.length);
  }
  return undefined;
}

function printPreflight(info: {
  personaId: string;
  personaName?: string;
  personaTemplate: string;
  runId: string;
  headed: boolean;
  only: readonly string[] | undefined;
  skip: readonly string[] | undefined;
  retries: number;
  timeoutMs: number;
}): void {
  const lines: string[] = [];
  lines.push(`${fmt.bold('Detection Lab')} ${fmt.dim('—')} ${fmt.cyan(info.personaId)}`);
  if (info.personaName) lines.push(`  display name : ${info.personaName}`);
  lines.push(`  template     : ${info.personaTemplate}`);
  lines.push(`  runId        : ${fmt.dim(info.runId)}`);
  lines.push(`  mode         : ${info.headed ? fmt.yellow('headed') : 'headless'}`);
  if (info.only) lines.push(`  only         : ${info.only.join(', ')}`);
  if (info.skip) lines.push(`  skip         : ${info.skip.join(', ')}`);
  lines.push(`  retries      : ${info.retries}`);
  lines.push(`  timeout      : ${formatMs(info.timeoutMs)}`);
  process.stdout.write(`${lines.join('\n')}\n\n`);
}

let progressCounter = 0;

function printProgress(evt: RunProgressEvent): void {
  switch (evt.phase) {
    case 'init':
      progressCounter = 0;
      if (evt.totalSites != null) {
        process.stdout.write(`${fmt.dim(`scanning ${evt.totalSites} sites…`)}\n`);
      }
      break;
    case 'site-start':
      progressCounter += 1;
      process.stdout.write(
        `${fmt.dim(`[${progressCounter}]`)} ${evt.siteId ?? '?'} ${fmt.dim('…')}`,
      );
      break;
    case 'site-retry':
      process.stdout.write(`\n${fmt.yellow('  ↻ retry')} #${evt.retryAttempt ?? '?'}`);
      break;
    case 'site-end': {
      const ok = evt.siteOk === true;
      const mark = ok ? fmt.green('✓') : fmt.red('✗');
      const dur = evt.siteDurationMs != null ? fmt.dim(formatMs(evt.siteDurationMs)) : '';
      // Overwrite the "…" tail; quick approximation: just print mark + duration on a new line piece
      process.stdout.write(` ${mark} ${dur}\n`);
      break;
    }
    case 'done':
    case 'canceled':
    case 'error':
      // 终态由调用方走 summary，这里不重复
      break;
  }
}

function shouldFail(hits: readonly { severity: string }[], level: RunOpts['failOnHits']): boolean {
  switch (level) {
    case 'none':
      return false;
    case 'any':
      return hits.length > 0;
    case 'medium':
      return hits.some((h) => h.severity === 'medium' || h.severity === 'high');
    case 'high':
      return hits.some((h) => h.severity === 'high');
  }
}

function buildCompletedRun(args: {
  runId: string;
  personaId: string;
  startedAtIso: string;
  startedAtMs: number;
  status: 'completed' | 'canceled';
  raw: DetectionRunRaw;
  score: DetectionScore;
}): DetectionRun {
  return {
    id: args.runId,
    personaId: args.personaId,
    startedAt: args.startedAtIso,
    finishedAt: new Date().toISOString(),
    status: args.status,
    sitesAttempted: args.raw.results.map((r) => r.id),
    durationMs: Date.now() - args.startedAtMs,
    score: args.score,
    raw: args.raw,
    error: null,
    meta: {
      sdkVersion: SDK_VERSION,
      chromiumVersion: safeChromiumVersion(),
    },
  };
}

function buildFailedRun(args: {
  runId: string;
  personaId: string;
  startedAtIso: string;
  startedAtMs: number;
  error: string;
}): DetectionRun {
  return {
    id: args.runId,
    personaId: args.personaId,
    startedAt: args.startedAtIso,
    finishedAt: new Date().toISOString(),
    status: 'failed',
    sitesAttempted: [],
    durationMs: Date.now() - args.startedAtMs,
    score: null,
    error: args.error,
    meta: {
      sdkVersion: SDK_VERSION,
      chromiumVersion: safeChromiumVersion(),
    },
  };
}

function safeChromiumVersion(): string {
  try {
    return getInstalledChromeVersion();
  } catch {
    return 'unknown';
  }
}
