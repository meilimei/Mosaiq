/**
 * `mosaiq detection-lab show-run <persona-id> <run-id>` — 打印一次已存的 run。
 *
 * 不启动 Chromium、不重跑 — 纯磁盘读取 → 渲染 summary。
 * Run 不存在 / JSON 损坏 → 错误信息 + exit 2。
 *
 * --json 模式吐完整 DetectionRun（含 raw / score / meta），CI / jq 友好。
 */

import { parseArgs } from 'node:util';

import { type DetectionRun, loadDetectionRun } from '@mosaiq/sdk';

import { fmt } from '../../output.js';
import { printRunSummary } from './format.js';

const HELP = `Usage: mosaiq detection-lab show-run <persona-id> <run-id> [options]

Print a previously-saved detection run. Does not launch Chromium.

Arguments:
  <persona-id>           Persona id.
  <run-id>               Run id (ISO timestamp form, e.g. 2026-05-19T11-01-32-216Z).
                         Use \`mosaiq detection-lab list-runs <persona-id>\` to find ids.

Options:
  --json                 Print full DetectionRun as JSON (incl. raw + score + meta)
  -h, --help             Show this help
`;

export async function runDetectionLabShowRun(argv: readonly string[]): Promise<number> {
  let opts: { personaId: string; runId: string; json: boolean; help: boolean };
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
      runId: parsed.positionals[1] ?? '',
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
  if (!opts.personaId || !opts.runId) {
    process.stderr.write(`Error: <persona-id> and <run-id> are required.\n\n${HELP}`);
    return 2;
  }

  let run: DetectionRun;
  try {
    run = loadDetectionRun(opts.personaId, opts.runId);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return 0;
  }

  printRunSummary(run);
  return 0;
}
