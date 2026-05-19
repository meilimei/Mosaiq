/**
 * `mosaiq personas export <persona-id>` — 把 persona 序列化成 JSON。
 *
 * 用途：跨设备迁移、git 备份、团队共享 persona 模板。等价于 desktop 「导出」按钮，
 * 共用 SDK 的 `serializePersona` —— 输出格式与 `~/.mosaiq/personas/<id>.json` 完全
 * 一致，所以一份导出文件直接放进对方的 personas 目录就能被识别。
 *
 * 安全语义（与 SDK ExportOptions 对齐）：
 *   - **默认脱敏 proxy.password**（`stripSecrets: true`），避免不小心把凭据传到 IM /
 *     git 仓库。导入端必须在 UI / CLI update 时重新填密码才能联网。
 *   - 通过 `--include-secrets` 关掉脱敏（会打印一条 yellow 警告到 stderr 提醒）。
 *   - cookie / localStorage / IndexedDB 不在 persona JSON 里 —— 它们在 chromium
 *     user-data-dir 单独存储，导出 persona 不会带走会话。
 *
 * 输出目标：
 *   - `--out <file>`：写到指定文件（覆盖；用户负责选 `.json` 后缀）
 *   - 缺省：打到 stdout，方便 `… > backup.json` / `… | sftp put` 流式管道
 *
 * 退出码：
 *   0 = 成功
 *   2 = persona 未找到 / 文件写入失败
 */

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { exportPersonaJson } from '@mosaiq/sdk';

import { fmt } from '../../output.js';

const HELP = `Usage: mosaiq personas export <persona-id> [options]

Export a persona to JSON. Output is byte-identical to the on-disk file
under ~/.mosaiq/personas/<id>.json (modulo proxy password redaction).

Arguments:
  <persona-id>              Persona id to export

Options:
  --out <file>              Write to <file> instead of stdout (overwrites
                            existing file at that path)
  --include-secrets         Emit proxy.password verbatim. Default
                            redacts it to '' to keep credentials out of
                            shared exports / git history. Combine with
                            --out to a private path; piping secrets to
                            stdout is generally unsafe.
  -h, --help                Show this help

Examples:
  # Stream to stdout (default)
  mosaiq personas export reddit-alice > backup/reddit-alice.json

  # Direct write
  mosaiq personas export reddit-alice --out backup/reddit-alice.json

  # Include credentials (for moving to a trusted machine)
  mosaiq personas export reddit-alice \\
    --include-secrets \\
    --out /secure/transfer/reddit-alice.json
`;

export async function runPersonasExport(argv: readonly string[]): Promise<number> {
  let opts: { personaId: string; out?: string; includeSecrets: boolean; help: boolean };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        out: { type: 'string' },
        'include-secrets': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    opts = {
      personaId: parsed.positionals[0] ?? '',
      out: parsed.values.out as string | undefined,
      includeSecrets: parsed.values['include-secrets'] === true,
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

  let json: string;
  try {
    json = exportPersonaJson(opts.personaId, {
      stripSecrets: !opts.includeSecrets,
    });
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  // 警告：用户主动开启了脱敏关闭。提醒一下 —— 写到 stderr 不污染 stdout 的 JSON 流。
  if (opts.includeSecrets) {
    process.stderr.write(
      `${fmt.yellow('⚠')} --include-secrets: proxy.password will be exported in clear text.\n`,
    );
  }

  if (opts.out !== undefined) {
    try {
      writeFileSync(opts.out, json, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `${fmt.red('✗')} Failed to write ${opts.out}: ${(err as Error).message}\n`,
      );
      return 2;
    }
    process.stdout.write(`${fmt.green('✓ Exported')} ${fmt.cyan(opts.personaId)} → ${opts.out}\n`);
    return 0;
  }

  // 写 stdout 时不能附加换行/前缀，否则用户 `> file.json` 拿到的就不是合法 JSON
  process.stdout.write(json);
  // 但如果 stdout 是 TTY（人在直接看），最后补一个换行让 prompt 在新行。
  if (process.stdout.isTTY === true) process.stdout.write('\n');
  return 0;
}
