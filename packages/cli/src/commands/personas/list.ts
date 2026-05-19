/**
 * `mosaiq personas list` — 列出所有 persona。
 *
 * 用途：跑 detection-lab run 之前要知道 persona id；这是最低成本的 discovery。
 *
 * 默认输出：
 *   ID                            DISPLAY NAME             TEMPLATE          UPDATED
 *   baseline-bench-mp6uss3k       Baseline Detection Bench …baseline-…       2026-05-15 …
 *
 * --json 输出：原始 Persona 数组（含全部字段）。
 */

import { parseArgs } from 'node:util';

import { listPersonas } from '@mosaiq/sdk';

import { fmt, renderTable } from '../../output.js';
import { extractTemplateTag } from './template-tag.js';

const HELP = `Usage: mosaiq personas list [options]

List all personas stored under ~/.mosaiq/personas/.

Options:
  --json        Print raw JSON array (full Persona objects) instead of a table
  -h, --help    Show this help
`;

export async function runPersonasList(argv: readonly string[]): Promise<number> {
  let opts: { json: boolean; help: boolean };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    opts = {
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

  const personas = listPersonas();

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(personas, null, 2)}\n`);
    return 0;
  }

  if (personas.length === 0) {
    process.stdout.write(
      `${fmt.dim('No personas found in ~/.mosaiq/personas/.')}\n` +
        `${fmt.dim('Tip: create one in the desktop app, or via the SDK')}` +
        ` ${fmt.cyan('savePersona()')}.\n`,
    );
    return 0;
  }

  const table = renderTable(personas, [
    { header: 'ID', get: (p) => fmt.cyan(p.metadata.id) },
    {
      header: 'DISPLAY NAME',
      get: (p) => p.metadata.displayName ?? fmt.dim('—'),
    },
    {
      header: 'TEMPLATE',
      get: (p) => extractTemplateTag(p) ?? fmt.dim('unknown'),
    },
    {
      header: 'UPDATED',
      get: (p) => fmt.dim(formatDate(p.metadata.updatedAt)),
    },
  ]);

  process.stdout.write(`${table}\n`);
  process.stdout.write(
    `${fmt.dim(`(${personas.length} persona${personas.length === 1 ? '' : 's'})`)}\n`,
  );
  return 0;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  // 简洁本地化：2026-05-15 19:48
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
