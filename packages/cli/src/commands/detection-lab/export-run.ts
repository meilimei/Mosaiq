/**
 * `mosaiq detection-lab export-run <persona-id> <run-id>` — 把一次 DetectionRun
 * 渲染成可分享的报告文本。
 *
 * 当前支持格式：
 *   - `md`（默认）— GitHub Flavored Markdown，由 SDK
 *     `formatDetectionRunMarkdown` 投影；可粘贴到 PR / Issue / Slack / Notion
 *   - `json` — 完整 DetectionRun JSON（同 `show-run --json`）。提供作为
 *     `export-run` 的对称分支，方便用户记住一个命令、按 `--format` 切换
 *
 * 输出目标：
 *   - `--out <file>`：写到指定文件（覆盖）
 *   - 缺省：写 stdout，方便 `… > report.md` / `… | mail` / `… | clip`
 *
 * 退出码：
 *   0 = 成功
 *   2 = 参数错 / persona 或 run 未找到 / 文件写入失败
 */

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { type DetectionRun, formatDetectionRunMarkdown, loadDetectionRun } from '@runova/sdk';

import { fmt } from '../../output.js';

const HELP = `Usage: mosaiq detection-lab export-run <persona-id> <run-id> [options]

Render a saved Detection Lab run as a shareable report. Default format
is GitHub Flavored Markdown (suitable for pasting into PRs / Issues /
Slack snippets / Notion); --format json emits the full DetectionRun
JSON as on disk.

Arguments:
  <persona-id>           Persona id
  <run-id>               Run id (ISO timestamp form, e.g.
                         2026-05-19T11-01-32-216Z)

Options:
  --format <fmt>         Output format. One of:
                           md   (default) GitHub Flavored Markdown
                           json full DetectionRun JSON (same as show-run --json)
  --out <file>           Write to <file> instead of stdout (overwrites
                         existing file at that path)
  --no-site-details      Omit the per-site results table from the
                         markdown output (smaller diffs / share blocks).
                         Ignored for --format json.
  --no-hits              Omit the per-severity hits drill-down list
                         from the markdown output (matrix kept).
                         Ignored for --format json.
  --no-meta              Omit the SDK / chromium / template metadata
                         line from the markdown output. Ignored for
                         --format json.
  -h, --help             Show this help

Examples:
  # Default: pretty markdown to stdout
  mosaiq detection-lab export-run reddit-alice 2026-05-19T11-01-32-216Z

  # Save to file for an issue / PR comment
  mosaiq detection-lab export-run reddit-alice 2026-05-19T... \\
    --out report.md

  # Lean version (no per-site grid, no drill-down) for chat snippets
  mosaiq detection-lab export-run reddit-alice 2026-05-19T... \\
    --no-site-details --no-hits

  # Full JSON for jq / dashboards (equivalent to show-run --json)
  mosaiq detection-lab export-run reddit-alice 2026-05-19T... \\
    --format json | jq '.score.weightedHits'
`;

interface ExportRunOpts {
  personaId: string;
  runId: string;
  format: 'md' | 'json';
  out?: string;
  noSiteDetails: boolean;
  noHits: boolean;
  noMeta: boolean;
  help: boolean;
}

export async function runDetectionLabExportRun(argv: readonly string[]): Promise<number> {
  let opts: ExportRunOpts;
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        format: { type: 'string', default: 'md' },
        out: { type: 'string' },
        'no-site-details': { type: 'boolean', default: false },
        'no-hits': { type: 'boolean', default: false },
        'no-meta': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const format = parsed.values.format as string;
    if (format !== 'md' && format !== 'json') {
      throw new Error(`Invalid --format "${format}". Must be one of: md, json.`);
    }
    opts = {
      personaId: parsed.positionals[0] ?? '',
      runId: parsed.positionals[1] ?? '',
      format: format as 'md' | 'json',
      out: parsed.values.out as string | undefined,
      noSiteDetails: parsed.values['no-site-details'] === true,
      noHits: parsed.values['no-hits'] === true,
      noMeta: parsed.values['no-meta'] === true,
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

  // ── 1. Load run（与 show-run 一致的容错） ──────────────────────────
  let run: DetectionRun;
  try {
    run = loadDetectionRun(opts.personaId, opts.runId);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  // ── 2. 渲染 ─────────────────────────────────────────────────────────
  let content: string;
  if (opts.format === 'json') {
    content = `${JSON.stringify(run, null, 2)}\n`;
  } else {
    content = `${formatDetectionRunMarkdown(run, {
      includeSiteDetails: !opts.noSiteDetails,
      includeHits: !opts.noHits,
      includeMeta: !opts.noMeta,
    })}\n`;
  }

  // ── 3. 输出 ─────────────────────────────────────────────────────────
  if (opts.out !== undefined) {
    try {
      writeFileSync(opts.out, content, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `${fmt.red('✗')} Failed to write ${opts.out}: ${(err as Error).message}\n`,
      );
      return 2;
    }
    process.stdout.write(
      `${fmt.green('✓ Exported run')} ${fmt.cyan(opts.runId)} ${fmt.dim(`(${opts.format})`)} → ${opts.out}\n`,
    );
    return 0;
  }

  // 写 stdout 时直接吐内容；TTY 自动结尾换行已经在 content 末尾加过
  process.stdout.write(content);
  return 0;
}
