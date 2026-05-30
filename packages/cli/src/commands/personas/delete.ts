/**
 * `mosaiq personas delete <persona-id>` — 删除一份 persona JSON。
 *
 * 行为对齐 desktop "删除 Persona" 二次确认：
 *   - 默认交互式 yes/no（与 desktop 5s 自动取消的二次确认对应；CLI 用即时 prompt）
 *   - `--yes` / `-y` 跳过确认（CI / 脚本用）
 *   - 非 TTY 且无 `--yes` → 拒绝执行 + exit 2（不要让 pipeline 误删）
 *   - 文件不存在 → 友好 "no such persona" + exit 2
 *
 * 注意：只删 `~/.mosaiq/personas/<id>.json`。chromium user-data-dir
 * (`~/.mosaiq/profiles/<id>/`) 与历史 detection-runs 不动 —— 与 desktop
 * `apps/desktop/electron/main.ts:deletePersona` 行为一致。如果要彻底清理
 * 该 persona 的全部痕迹，请同时手工删 profiles/ 和 detection-runs/ 子目录。
 */

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { type Persona, type PersonaId, deletePersona, loadPersona } from '@runova/sdk';

import { fmt } from '../../output.js';

const HELP = `Usage: mosaiq personas delete <persona-id> [options]

Delete a persona JSON file under ~/.mosaiq/personas/<id>.json. Does not
remove the chromium user-data-dir or detection-run history; see Notes.

Arguments:
  <persona-id>           Persona id to delete

Options:
  -y, --yes              Skip the confirmation prompt (required for non-TTY)
  -h, --help             Show this help

Notes:
  - The persona's chromium profile (~/.mosaiq/profiles/<id>/) is NOT
    deleted — it can preserve cookies / cache for re-import. Remove it
    manually if you want a clean slate.
  - The persona's detection-run history (~/.mosaiq/detection-runs/<id>/)
    is also untouched. Use \`mosaiq detection-lab delete-run\` per run, or
    rm -rf the directory manually.
`;

export async function runPersonasDelete(argv: readonly string[]): Promise<number> {
  let opts: { personaId: string; yes: boolean; help: boolean };
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
  if (!opts.personaId) {
    process.stderr.write(`Error: <persona-id> is required.\n\n${HELP}`);
    return 2;
  }

  // ── 1. 验证 persona 存在 + 显示一行预览 ─────────────────────────────
  let persona: Persona;
  try {
    persona = loadPersona(opts.personaId as PersonaId);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  process.stdout.write(`${fmt.bold('About to delete:')}\n`);
  process.stdout.write(
    `  ${fmt.cyan(persona.metadata.id)}  ${fmt.dim(persona.metadata.displayName)}\n`,
  );
  process.stdout.write(`  ${fmt.dim(`~/.mosaiq/personas/${persona.metadata.id}.json`)}\n`);

  // ── 2. 二次确认（除非 --yes 或非 TTY 直接拒绝）─────────────────────
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
      answer = (await rl.question(`\nDelete this persona? (y/${fmt.bold('N')}) `))
        .trim()
        .toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write(`${fmt.dim('Cancelled.')}\n`);
      return 0;
    }
  }

  // ── 3. 删除 ──────────────────────────────────────────────────────────
  const removed = deletePersona(opts.personaId as PersonaId);
  if (!removed) {
    // Race: someone deleted it between our load() and unlink. Treat as
    // "no such persona" without claiming success.
    process.stderr.write(`${fmt.yellow('⚠')} persona no longer exists\n`);
    return 2;
  }

  process.stdout.write(`${fmt.green('✓ deleted')} ${fmt.dim(opts.personaId)}\n`);
  return 0;
}
