/**
 * `mosaiq detection-lab delete-run <persona-id> <run-id>` — 删除一次 run。
 *
 * 行为：
 *   - 默认交互式 yes/no 确认（与 desktop UI 5s 自动取消的二次确认对应）
 *   - `--yes` / `-y` 跳过确认（CI / 脚本用）
 *   - 非 TTY (stdin closed) 且无 --yes → 拒绝执行；exit 2
 *   - 删除目标：`<runId>.json` + 同名 artifact 子目录
 *   - 文件不存在 → 友好 "no such run" + exit 2（idempotent SDK call 但 CLI 想报告差异）
 */

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { type DetectionRun, deleteDetectionRun, loadDetectionRun } from '@runova/sdk';

import { fmt } from '../../output.js';
import { detectionRunPathHint, statusBadge } from './format.js';

const HELP = `Usage: mosaiq detection-lab delete-run <persona-id> <run-id> [options]

Delete a saved detection run (.json file + artifact subdirectory).

Arguments:
  <persona-id>           Persona id.
  <run-id>               Run id (ISO timestamp form).

Options:
  -y, --yes              Skip confirmation prompt (required for non-TTY)
  -h, --help             Show this help
`;

export async function runDetectionLabDeleteRun(argv: readonly string[]): Promise<number> {
  let opts: { personaId: string; runId: string; yes: boolean; help: boolean };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        yes: { type: 'boolean', short: 'y', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    opts = {
      personaId: parsed.positionals[0] ?? '',
      runId: parsed.positionals[1] ?? '',
      yes: parsed.values.yes === true,
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

  // ───────────────────────────────────────────────────────────────────────
  // 1. Verify the run exists + show a 1-line preview before confirming
  // ───────────────────────────────────────────────────────────────────────
  let run: DetectionRun;
  try {
    run = loadDetectionRun(opts.personaId, opts.runId);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  process.stdout.write(`${fmt.bold('About to delete:')}\n`);
  process.stdout.write(`  ${fmt.cyan(opts.runId)}  ${statusBadge(run.status)}\n`);
  process.stdout.write(`  ${fmt.dim(detectionRunPathHint(opts.personaId, opts.runId))}\n`);

  // ───────────────────────────────────────────────────────────────────────
  // 2. Confirm (unless --yes or non-TTY rejection)
  // ───────────────────────────────────────────────────────────────────────
  if (!opts.yes) {
    if (process.stdin.isTTY !== true) {
      process.stderr.write(
        `\n${fmt.red('✗')} stdin is not a TTY; pass --yes to confirm non-interactively.\n`,
      );
      return 2;
    }
    const rl = createInterface({ input, output });
    let answer: string;
    try {
      answer = (await rl.question(`\nDelete this run? (y/${fmt.bold('N')}) `)).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write(`${fmt.dim('Cancelled.')}\n`);
      return 0;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3. Delete
  // ───────────────────────────────────────────────────────────────────────
  const removed = deleteDetectionRun(opts.personaId, opts.runId);
  if (!removed) {
    // Race: someone else deleted it between our load and the unlink. Treat as
    // "no such run" without claiming success.
    process.stderr.write(`${fmt.yellow('⚠')} run no longer exists\n`);
    return 2;
  }

  process.stdout.write(`${fmt.green('✓ deleted')} ${fmt.dim(opts.runId)}\n`);
  return 0;
}
