/**
 * `mosaiq personas update <persona-id>` — 编辑现有 persona 的「软」字段。
 *
 * 与 desktop `PersonaEditPage` 的可编辑字段一致（SDK `PersonaPatch` 的全集）：
 *   - displayName / tags / notes / timezone / proxy
 *
 * **故意不暴露**：硬件指纹（CPU/GPU/screen/canvas seed/...）、UA / OS / 浏览器版本。
 * 想换硬件请走「克隆 → 改指纹」流程（`personas clone`），保留旧 persona 的养号成果。
 *
 * Proxy 三态（与 SDK PersonaPatch.proxy 对齐）：
 *   - 不传 `--proxy` 也不传 `--no-proxy`：保持原代理
 *   - `--proxy <url>`：替换为新代理（与 create 一样的 URL 格式）
 *   - `--no-proxy`：移除代理（裸连）
 *   - `--proxy` 与 `--no-proxy` 同时给：参数错 + exit 2
 *
 * 没传任何 patch flag → 报「nothing to update」+ exit 2，避免无声 no-op。
 *
 * 注意：如果该 persona 当前正在 desktop 里运行，磁盘 JSON 会被更新，但 chromium
 * 进程已用旧配置启动，新值要等用户重启浏览器后才会生效。
 *
 * 退出码：
 *   0 = 更新落盘成功
 *   2 = 参数错 / persona 未找到 / proxy URL 解析失败 / schema 校验失败
 */

import { parseArgs } from 'node:util';

import { type Persona, type PersonaId, type PersonaPatch, updatePersona } from '@mosaiq/sdk';

import { fmt } from '../../output.js';
import { type ParsedProxyInput, parseProxyUrl } from './proxy-url.js';

const HELP = `Usage: mosaiq personas update <persona-id> [options]

Update the soft fields of an existing persona (display name / tags /
notes / timezone / proxy). Hardware fingerprint, OS, and browser
version are intentionally NOT editable — clone the persona instead if
you need a different hardware baseline.

Arguments:
  <persona-id>              Persona id to update

Patch options (at least one is required):
  --display-name <name>     New display name (1..128 chars)
  --tags <a,b,c>            Replace the tags array (comma-separated;
                            empty string clears all tags). Tags from
                            the existing persona are NOT preserved
                            unless re-listed.
  --notes <text>            New notes (\u22642048 chars; '' clears)
  --timezone <iana>         New IANA timezone (e.g. Europe/Berlin)
  --proxy <url>             Replace proxy: <protocol>://[user[:pass]@]host:port
  --proxy-label <label>     Friendly proxy label (only with --proxy)
  --no-proxy                Remove proxy (incompatible with --proxy)

Other options:
  --json                    Print full updated Persona JSON instead of
                            a human summary
  -h, --help                Show this help

Examples:
  # Rename and refresh tags
  mosaiq personas update reddit-alice \\
    --display-name "Reddit Alice (warm)" \\
    --tags reddit,us,warming,template:win11-chrome-us

  # Drop the proxy (e.g. moved to direct VPN)
  mosaiq personas update reddit-alice --no-proxy

  # Switch to a new sticky-session proxy
  mosaiq personas update reddit-alice \\
    --proxy http://brd-customer-XXX:p%40ss@brd.example:33335 \\
    --proxy-label "Bright Data US-east session-7"
`;

interface UpdateOpts {
  personaId: string;
  displayName?: string;
  tags?: string[];
  notes?: string;
  timezone?: string;
  proxy?: ParsedProxyInput;
  proxyLabel?: string;
  noProxy: boolean;
  json: boolean;
  help: boolean;
}

export async function runPersonasUpdate(argv: readonly string[]): Promise<number> {
  let opts: UpdateOpts;
  try {
    opts = parseUpdateArgs(argv);
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

  // 互斥校验：--proxy / --no-proxy 二选一，否则下面 PersonaPatch.proxy 字段没法
  // 表达「同时设置又同时移除」的语义。
  if (opts.proxy && opts.noProxy) {
    process.stderr.write(`${fmt.red('✗')} --proxy and --no-proxy are mutually exclusive.\n`);
    return 2;
  }
  if (opts.proxyLabel && !opts.proxy) {
    process.stderr.write(
      `${fmt.red('✗')} --proxy-label requires --proxy.\n` +
        `${fmt.dim('To rename an existing proxy without changing the URL, pass `--proxy <same-url>` along with the new label.')}\n`,
    );
    return 2;
  }

  // 「空 patch」检测：用户没传任何 patch flag 直接报错，避免静默 no-op
  // （updatePersona 自己会刷新 updatedAt 时间戳，但其他字段毫无变化）。
  const hasAnyPatch =
    opts.displayName !== undefined ||
    opts.tags !== undefined ||
    opts.notes !== undefined ||
    opts.timezone !== undefined ||
    opts.proxy !== undefined ||
    opts.noProxy;
  if (!hasAnyPatch) {
    process.stderr.write(
      `${fmt.red('✗')} Nothing to update. Pass at least one of: --display-name, --tags, --notes, --timezone, --proxy, --no-proxy.\n`,
    );
    return 2;
  }

  // 构造 PersonaPatch（proxy 三态严格按 SDK 约定：undefined = 不动 / null = 移除）
  const patch: PersonaPatch = {
    displayName: opts.displayName,
    tags: opts.tags,
    notes: opts.notes,
    timezone: opts.timezone,
    proxy: opts.noProxy
      ? null
      : opts.proxy
        ? {
            protocol: opts.proxy.protocol,
            host: opts.proxy.host,
            port: opts.proxy.port,
            username: opts.proxy.username,
            password: opts.proxy.password,
            bypassList: [],
            label: opts.proxyLabel,
          }
        : undefined,
  };

  let updated: Persona;
  try {
    updated = updatePersona(opts.personaId as PersonaId, patch);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${fmt.green('✓ Updated persona')} ${fmt.cyan(updated.metadata.id)}\n`);
  process.stdout.write(`  ${fmt.dim('Display name:')} ${updated.metadata.displayName}\n`);
  process.stdout.write(
    `  ${fmt.dim('Tags:        ')} ${
      updated.metadata.tags.length === 0 ? fmt.dim('—') : updated.metadata.tags.join(', ')
    }\n`,
  );
  if (opts.notes !== undefined) {
    process.stdout.write(
      `  ${fmt.dim('Notes:       ')} ${updated.metadata.notes || fmt.dim('—')}\n`,
    );
  }
  process.stdout.write(`  ${fmt.dim('Timezone:    ')} ${updated.system.timezone}\n`);
  if (updated.network.proxy) {
    const x = updated.network.proxy;
    const credPart = x.username ? `${x.username}${x.password ? ':***' : ''}@` : '';
    process.stdout.write(
      `  ${fmt.dim('Proxy:       ')} ${x.protocol}://${credPart}${x.host}:${x.port}${
        x.label ? `  ${fmt.dim(`(${x.label})`)}` : ''
      }\n`,
    );
  } else {
    process.stdout.write(`  ${fmt.dim('Proxy:       ')} ${fmt.dim('none')}\n`);
  }
  process.stdout.write(`  ${fmt.dim('Updated at:  ')} ${updated.metadata.updatedAt}\n`);

  // Hint：runtime 重启提示（与 desktop UI 同含义）
  process.stdout.write(
    `\n${fmt.dim('Tip: if this persona is currently running in the desktop browser, restart it for the change to take effect.')}\n`,
  );
  return 0;
}

function parseUpdateArgs(argv: readonly string[]): UpdateOpts {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      'display-name': { type: 'string' },
      tags: { type: 'string' },
      notes: { type: 'string' },
      timezone: { type: 'string' },
      proxy: { type: 'string' },
      'proxy-label': { type: 'string' },
      'no-proxy': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  let proxy: ParsedProxyInput | undefined;
  const proxyRaw = parsed.values.proxy as string | undefined;
  if (proxyRaw !== undefined) {
    proxy = parseProxyUrl(proxyRaw);
  }

  // tags 三态：
  //   - 字段未传 → undefined（保留原 tags）
  //   - 传 `--tags ""` → 空数组（清空）
  //   - 传 `--tags a,b,c` → ['a','b','c']
  // SDK PersonaPatch.tags 字段如果是 undefined 则保留原值，是 [] 则替换为空数组。
  const tagsRaw = parsed.values.tags as string | undefined;
  let tags: string[] | undefined;
  if (tagsRaw !== undefined) {
    tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  return {
    personaId: parsed.positionals[0] ?? '',
    displayName: parsed.values['display-name'] as string | undefined,
    tags,
    notes: parsed.values.notes as string | undefined,
    timezone: parsed.values.timezone as string | undefined,
    proxy,
    proxyLabel: parsed.values['proxy-label'] as string | undefined,
    noProxy: parsed.values['no-proxy'] === true,
    json: parsed.values.json === true,
    help: parsed.values.help === true,
  };
}
