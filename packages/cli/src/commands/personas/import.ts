/**
 * `mosaiq personas import <file>` — 从 JSON 文件导入 persona 到磁盘。
 *
 * 等价于 desktop 的「导入」对话框，共用 SDK 的 `importPersonaJson`。
 *
 * 输入源：
 *   - 文件路径（位置参数）
 *   - `-`（字面量）= 从 stdin 读，便于 `cat persona.json | mosaiq personas import -`
 *
 * ID 冲突策略（与 SDK ImportConflictOptions 对齐）：
 *   - `error`（默认）：抛错，让用户决定。最安全。
 *   - `rename`：自动给目标 id 加 `-imported` / `-imported-2` 后缀。
 *   - `overwrite`：替换磁盘上的 persona 文件（**会保留 chromium user-data-dir 里的
 *     cookies**，但 persona 配置被替换，可能导致指纹与已有 cookies 不一致；
 *     谨慎使用）。
 *
 * 注意：导入会重置 `launchCount` / `lastLaunchedAt`。`createdAt` 保留以追溯
 * persona 血统；`updatedAt` 刷新到导入时刻。
 *
 * 退出码：
 *   0 = 导入并落盘成功
 *   2 = 文件读不到 / JSON 解析失败 / schema 校验失败 / id 冲突且 onConflict=error
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { type ImportConflictOptions, type Persona, importPersonaJson } from '@mosaiq/sdk';

import { fmt } from '../../output.js';

const HELP = `Usage: mosaiq personas import <file> [options]

Import a persona from a JSON file (or stdin) into ~/.mosaiq/personas/.
The JSON shape must match the on-disk schemaVersion=1 layout (which is
exactly what \`mosaiq personas export\` emits).

Arguments:
  <file>                    Path to the persona JSON. Use '-' to read
                            from stdin (e.g. cat foo.json | … import -).

Options:
  --on-conflict <strategy>  How to handle id collision against an
                            existing persona. One of:
                              error      (default) abort with exit 2
                              rename     append '-imported[-N]' suffix
                              overwrite  replace existing persona JSON
                                         (keeps the chromium user-data-
                                         dir; may cause fingerprint /
                                         cookie mismatch — handle with
                                         care)
  --json                    Print the imported Persona JSON to stdout
                            instead of a human summary
  -h, --help                Show this help

Examples:
  # Import from a file (errors on id conflict)
  mosaiq personas import backup/reddit-alice.json

  # Import + auto-rename on conflict (good for "I already have one with that id")
  mosaiq personas import backup/reddit-alice.json --on-conflict rename

  # Replay from a pipeline / stdin
  cat backup/reddit-alice.json | mosaiq personas import -
`;

const VALID_STRATEGIES: ReadonlyArray<NonNullable<ImportConflictOptions['onConflict']>> = [
  'error',
  'rename',
  'overwrite',
];

export async function runPersonasImport(argv: readonly string[]): Promise<number> {
  let opts: {
    file: string;
    onConflict: NonNullable<ImportConflictOptions['onConflict']>;
    json: boolean;
    help: boolean;
  };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        'on-conflict': { type: 'string', default: 'error' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const onConflict = parsed.values['on-conflict'] as string;
    if (!(VALID_STRATEGIES as readonly string[]).includes(onConflict)) {
      throw new Error(
        `Invalid --on-conflict "${onConflict}". Must be one of: ${VALID_STRATEGIES.join(', ')}.`,
      );
    }
    opts = {
      file: parsed.positionals[0] ?? '',
      onConflict: onConflict as NonNullable<ImportConflictOptions['onConflict']>,
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
  if (!opts.file) {
    process.stderr.write(`Error: <file> is required.\n\n${HELP}`);
    return 2;
  }

  // ── 1. 读取 JSON 内容（文件 / stdin） ────────────────────────────────
  let raw: string;
  try {
    if (opts.file === '-') {
      raw = await readStdin();
    } else {
      raw = readFileSync(opts.file, 'utf-8');
    }
  } catch (err) {
    process.stderr.write(
      `${fmt.red('✗')} Failed to read ${opts.file}: ${(err as Error).message}\n`,
    );
    return 2;
  }

  // ── 2. 调 SDK importPersonaJson（含 schema 校验 + 冲突策略） ────────
  let imported: Persona;
  try {
    imported = importPersonaJson(raw, { onConflict: opts.onConflict });
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(imported, null, 2)}\n`);
    return 0;
  }

  // ── 3. 人读 summary ──────────────────────────────────────────────────
  process.stdout.write(`${fmt.green('✓ Imported persona')} ${fmt.cyan(imported.metadata.id)}\n`);
  process.stdout.write(`  ${fmt.dim('Display name:')} ${imported.metadata.displayName}\n`);
  process.stdout.write(
    `  ${fmt.dim('Tags:        ')} ${
      imported.metadata.tags.length === 0 ? fmt.dim('—') : imported.metadata.tags.join(', ')
    }\n`,
  );
  process.stdout.write(`  ${fmt.dim('Timezone:    ')} ${imported.system.timezone}\n`);
  if (imported.network.proxy) {
    const x = imported.network.proxy;
    const credPart = x.username ? `${x.username}${x.password ? ':***' : ''}@` : '';
    process.stdout.write(
      `  ${fmt.dim('Proxy:       ')} ${x.protocol}://${credPart}${x.host}:${x.port}${
        x.label ? `  ${fmt.dim(`(${x.label})`)}` : ''
      }${
        // 提示：如果 password 是空（被脱敏过），告诉用户需要 update 重填
        x.username && !x.password
          ? `  ${fmt.yellow('(password missing — run `mosaiq personas update --proxy …` to set)')}`
          : ''
      }\n`,
    );
  } else {
    process.stdout.write(`  ${fmt.dim('Proxy:       ')} ${fmt.dim('none')}\n`);
  }
  process.stdout.write(
    `  ${fmt.dim('Saved at:    ')} ~/.mosaiq/personas/${imported.metadata.id}.json\n`,
  );
  return 0;
}

/**
 * 把整个 stdin 全部读完成 utf-8 字符串。Persona JSON 通常 < 100KB，所以一次性
 * 全部读入内存是合理的（`fs.readFileSync('-')` 在 Windows 不能直接用，所以
 * 自己用 stream API 拼起来）。
 */
async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.once('error', reject);
  });
}
