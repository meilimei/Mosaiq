/**
 * `mosaiq personas templates list` — 列出可用 persona 模板。
 *
 * 用途：在跑 `personas create` 之前，让用户能 discover 合法的 `--template` 值。
 * 数据源：`@runova/persona-schema/templates` 的 `TEMPLATE_CATALOG`，与 desktop
 * `PersonaCreatePage` 渲染的卡片完全一致（同一份 catalog 不会漂移）。
 *
 * --json 输出 `Array<{ id, displayName, description }>`，便于 `jq -r '.[].id'`
 * 取出所有 id 给脚本用。
 */

import { parseArgs } from 'node:util';

import { TEMPLATE_CATALOG } from '@runova/persona-schema/templates';

import { fmt, renderTable } from '../../output.js';

const HELP = `Usage: mosaiq personas templates list [options]

List available persona templates. Use the printed ID with
\`mosaiq personas create --template <id>\`.

Options:
  --json        Print raw JSON array (id / displayName / description)
                instead of a table
  -h, --help    Show this help
`;

export async function runPersonasTemplatesList(argv: readonly string[]): Promise<number> {
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

  // Strip the (non-serializable) `create` function before emitting JSON.
  const projected = TEMPLATE_CATALOG.map((t) => ({
    id: t.id,
    displayName: t.displayName,
    description: t.description,
  }));

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(projected, null, 2)}\n`);
    return 0;
  }

  const table = renderTable(projected, [
    { header: 'ID', get: (t) => fmt.cyan(t.id) },
    { header: 'DISPLAY NAME', get: (t) => t.displayName },
    { header: 'DESCRIPTION', get: (t) => fmt.dim(t.description) },
  ]);

  process.stdout.write(`${table}\n`);
  process.stdout.write(
    `${fmt.dim(`(${projected.length} template${projected.length === 1 ? '' : 's'})`)}\n`,
  );
  return 0;
}
