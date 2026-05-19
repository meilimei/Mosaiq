/**
 * 终端输出 helper — ANSI 颜色 / 表格 / 时间格式化。
 *
 * 设计原则：
 *   - 零依赖（不引 picocolors / chalk），ANSI 转义直接拼接
 *   - 自动检测 TTY 与 `NO_COLOR` 环境变量；非 TTY 或 NO_COLOR=1 时输出纯文本
 *   - 所有 helper 返回字符串而不是直接写 stdout，方便 `--json` 模式时全部抑制
 */

const COLOR_ENABLED =
  process.stdout.isTTY === true && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

type ColorName = keyof typeof ANSI;

function paint(s: string, color: ColorName): string {
  if (!COLOR_ENABLED) return s;
  return `${ANSI[color]}${s}${ANSI.reset}`;
}

export const fmt = {
  bold: (s: string) => paint(s, 'bold'),
  dim: (s: string) => paint(s, 'dim'),
  red: (s: string) => paint(s, 'red'),
  green: (s: string) => paint(s, 'green'),
  yellow: (s: string) => paint(s, 'yellow'),
  blue: (s: string) => paint(s, 'blue'),
  cyan: (s: string) => paint(s, 'cyan'),
  gray: (s: string) => paint(s, 'gray'),
};

/** 把 ms 格式化成 `1m 23s` / `12.3s` / `350ms`。 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

// ANSI escape sequence stripper. Built via RegExp constructor + fromCharCode
// because biome's `noControlCharactersInRegex` flags `\x1b` literals; the
// resulting regex is identical at runtime.
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');

/** 把字符串左对齐 padding 到 width；ANSI 颜色不计入宽度。 */
export function padEnd(s: string, width: number): string {
  const visible = s.replace(ANSI_RE, '');
  const pad = Math.max(0, width - visible.length);
  return s + ' '.repeat(pad);
}

/**
 * 把对象数组按列宽对齐打印成表格。所有列按 visible width 计算 padding。
 *
 * 参数：
 *   - rows: 数据对象数组
 *   - columns: 列定义 `{ header, get }`，get 返回该列的渲染字符串（可含 ANSI）
 */
export function renderTable<T>(
  rows: readonly T[],
  columns: ReadonlyArray<{ header: string; get: (row: T) => string }>,
): string {
  const headerRow = columns.map((c) => fmt.bold(c.header));
  const dataRows = rows.map((r) => columns.map((c) => c.get(r)));
  // 计算每列宽度 = max(header, ...cells) of visible chars
  const widths = columns.map((_, i) => {
    let max = stripAnsi(headerRow[i] ?? '').length;
    for (const row of dataRows) {
      const cell = row[i] ?? '';
      max = Math.max(max, stripAnsi(cell).length);
    }
    return max;
  });
  const lines: string[] = [];
  lines.push(headerRow.map((h, i) => padEnd(h, widths[i] ?? 0)).join('  '));
  lines.push(widths.map((w) => fmt.dim('─'.repeat(w))).join('  '));
  for (const row of dataRows) {
    lines.push(row.map((c, i) => padEnd(c, widths[i] ?? 0)).join('  '));
  }
  return lines.join('\n');
}

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
