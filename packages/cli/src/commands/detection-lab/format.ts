/**
 * Detection-lab subcommand 共享的渲染 helper。
 *
 * 抽自 `run.ts` 内的 printSummary / formatHitBreakdown / badge / pathHint，
 * 让 `show-run` / `list-runs` 能复用同一套视觉语言。
 *
 * 不依赖任何 SDK runtime 调用；纯 DetectionRun → string 投影。
 */

import type { DetectionRun, DetectionRunSummary } from '@runova/sdk';

import { fmt, formatMs } from '../../output.js';

/** Pretty 打印一个完整 DetectionRun（show-run / run 末尾用同一个块）。 */
export function printRunSummary(run: DetectionRun): void {
  const score = run.score;
  const sitesOk = score?.sitesOk ?? 0;
  const sitesFail = score?.sitesFail ?? 0;
  const hits = score?.hits ?? [];
  const high = hits.filter((h) => h.severity === 'high').length;
  const medium = hits.filter((h) => h.severity === 'medium').length;
  const low = hits.filter((h) => h.severity === 'low').length;

  process.stdout.write(`${fmt.bold('Result')}  ${statusBadge(run.status)}\n`);
  process.stdout.write(`  runId        : ${fmt.dim(run.id)}\n`);
  process.stdout.write(`  persona      : ${fmt.cyan(run.personaId)}\n`);
  process.stdout.write(`  startedAt    : ${fmt.dim(run.startedAt)}\n`);
  process.stdout.write(`  duration     : ${formatMs(run.durationMs)}\n`);
  process.stdout.write(
    `  sites        : ${fmt.green(`${sitesOk} ok`)} · ${sitesFail > 0 ? fmt.red(`${sitesFail} fail`) : `${sitesFail} fail`}\n`,
  );
  process.stdout.write(
    `  hits         : ${hits.length} ${fmt.dim(`(${formatHitBreakdown(high, medium, low)})`)}\n`,
  );
  if (score) {
    process.stdout.write(`  weightedHits : ${fmt.bold(score.weightedHits.toFixed(2))}\n`);
  }
  if (run.meta) {
    process.stdout.write(
      `  sdk / chrome : ${fmt.dim(`${run.meta.sdkVersion ?? '?'} / ${run.meta.chromiumVersion ?? '?'}`)}\n`,
    );
  }
  process.stdout.write(
    `  saved to     : ${fmt.dim(detectionRunPathHint(run.personaId, run.id))}\n`,
  );

  if (run.error) {
    process.stdout.write(`\n${fmt.bold('Error:')} ${fmt.red(run.error)}\n`);
  }

  if (hits.length > 0) {
    process.stdout.write(`\n${fmt.bold('Hits:')}\n`);
    for (const h of hits) {
      const sevColor =
        h.severity === 'high' ? fmt.red : h.severity === 'medium' ? fmt.yellow : fmt.dim;
      process.stdout.write(
        `  ${sevColor('●')} ${fmt.cyan(h.surface)} · ${fmt.dim(h.site)} — ${h.detector}\n`,
      );
      if (h.evidence) {
        process.stdout.write(`      ${fmt.dim(h.evidence)}\n`);
      }
    }
  }
}

/** Status → 带颜色 + emoji 的徽章。完整 + summary 共用。 */
export function statusBadge(status: DetectionRun['status']): string {
  switch (status) {
    case 'completed':
      return fmt.green('✓ completed');
    case 'canceled':
      return fmt.yellow('⚠ canceled');
    case 'failed':
      return fmt.red('✗ failed');
    case 'running':
      return fmt.cyan('· running');
    case 'pending':
      return fmt.dim('· pending');
  }
}

/** "2 high, 1 med" / "none" — hit 分级简短描述。 */
export function formatHitBreakdown(high: number, medium: number, low: number): string {
  const parts: string[] = [];
  if (high > 0) parts.push(`${high} high`);
  if (medium > 0) parts.push(`${medium} med`);
  if (low > 0) parts.push(`${low} low`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** ~/.mosaiq/detection-runs/<personaId>/<runId>.json — 用户友好路径提示。 */
export function detectionRunPathHint(personaId: string, runId: string): string {
  return `~/.mosaiq/detection-runs/${personaId}/${runId}.json`;
}

/** Summary 简表用：从 DetectionRunSummary 构造 hits-cell 的 colored breakdown。 */
export function formatSummaryHits(summary: DetectionRunSummary): string {
  if (summary.totalHits === 0) return fmt.green('0');
  return `${summary.totalHits} ${fmt.dim(`(${summary.weightedHits.toFixed(1)}w)`)}`;
}
