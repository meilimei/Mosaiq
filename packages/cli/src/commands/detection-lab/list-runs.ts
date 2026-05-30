/**
 * `mosaiq detection-lab list-runs <persona-id>` — 列出某 persona 的历史 runs。
 *
 * 投影自 `listDetectionRuns()` 的 DetectionRunSummary[]（已按 startedAt
 * 降序，最新在前 — SDK 行为）。
 *
 * 默认输出：
 *   RUN ID                       STATUS       DURATION  SITES OK/FAIL  HITS  WEIGHTED
 *   2026-05-19T11-01-32-216Z     ✓ completed  24.7s     1/0            0     0.00
 *
 * --json：原始 DetectionRunSummary 数组（JSON.stringify-able POJO）。
 */

import { parseArgs } from 'node:util';

import { listDetectionRuns } from '@runova/sdk';

import { fmt, renderTable } from '../../output.js';
import { formatMs } from '../../output.js';
import { formatSummaryHits, statusBadge } from './format.js';

const HELP = `Usage: mosaiq detection-lab list-runs <persona-id> [options]

List all detection runs stored for the given persona, newest first.

Arguments:
  <persona-id>           Persona id. Use \`mosaiq personas list\` to discover.

Options:
  --json                 Print raw DetectionRunSummary[] as JSON
  -h, --help             Show this help
`;

export async function runDetectionLabListRuns(argv: readonly string[]): Promise<number> {
  let opts: { personaId: string; json: boolean; help: boolean };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    opts = {
      personaId: parsed.positionals[0] ?? '',
      json: parsed.values.json === true,
      help: parsed.values.help === true,
    };
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

  const summaries = listDetectionRuns(opts.personaId);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
    return 0;
  }

  if (summaries.length === 0) {
    process.stdout.write(
      `${fmt.dim(`No detection runs for persona '${opts.personaId}'.`)}\n` +
        `${fmt.dim('Tip: kick one off with')} ${fmt.cyan(`mosaiq detection-lab run ${opts.personaId}`)}\n`,
    );
    return 0;
  }

  const table = renderTable(summaries, [
    { header: 'RUN ID', get: (s) => fmt.cyan(s.runId) },
    { header: 'STATUS', get: (s) => statusBadge(s.status) },
    { header: 'DURATION', get: (s) => formatMs(s.durationMs) },
    {
      header: 'SITES OK/FAIL',
      get: (s) =>
        `${fmt.green(`${s.sitesOk}`)}/${s.sitesFail > 0 ? fmt.red(`${s.sitesFail}`) : `${s.sitesFail}`}`,
    },
    { header: 'HITS', get: (s) => formatSummaryHits(s) },
    { header: 'WEIGHTED', get: (s) => s.weightedHits.toFixed(2) },
  ]);
  process.stdout.write(`${table}\n`);
  process.stdout.write(
    `${fmt.dim(`(${summaries.length} run${summaries.length === 1 ? '' : 's'})`)}\n`,
  );
  return 0;
}
