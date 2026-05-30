/**
 * `mosaiq personas clone <source-id> <new-id>` — 克隆现有 persona。
 *
 * SDK `clonePersona` 行为概要（详见 packages/sdk/src/persona-store.ts）：
 *   - 复制源 persona 全部「身份基线」（OS / 浏览器 / 硬件 / 字体 / locale）
 *   - **重新派生** canvas/webgl/audio noise seeds（默认从随机 master seed 派生），
 *     让两个 persona 在反检测站点上指纹**完全独立** —— 不会被识别为「同一台机器多账号」
 *   - 重置 metadata（createdAt = now / launchCount = 0 / lastLaunchedAt = null）
 *
 * 与 desktop `PersonaClonePage` 形态一致。CLI 的额外 superpower：`--master-seed
 * <hex>` 让两次 clone 产出完全可复现的指纹（CI / 调试用）。
 *
 * Proxy 三态（与 SDK CloneOptions.newProxy 对齐）：
 *   - 不传 `--proxy` 也不传 `--no-proxy`：复用源代理（如果源有）
 *   - `--proxy <url>`：用新代理（与 create 一样格式）
 *   - `--no-proxy`：克隆出来的 persona 没有代理（裸连）
 *
 * 退出码：
 *   0 = 克隆成功
 *   2 = 参数错 / source 不存在 / new-id 已被占用 / proxy URL 解析失败
 */

import { parseArgs } from 'node:util';

import {
  type CloneOptions,
  type Persona,
  type PersonaId,
  clonePersona,
  personaExists,
} from '@runova/sdk';

import { fmt } from '../../output.js';
import { type ParsedProxyInput, parseProxyUrl } from './proxy-url.js';

const HELP = `Usage: mosaiq personas clone <source-id> <new-id> [options]

Clone an existing persona. The clone keeps the source's hardware /
locale baseline but gets fresh fingerprint noise seeds, so the two
personas are independent identities at detection time.

Arguments:
  <source-id>               Persona id to clone from
  <new-id>                  Id for the new persona (kebab-case, must
                            not collide with any existing persona)

Required options:
  --display-name <name>     Display name for the new persona

Optional:
  --tags <a,b,c>            Replace tag list (default: copy source's)
  --notes <text>            Replace notes (default: copy source's)
  --timezone <iana>         Override timezone (default: copy source's)
  --proxy <url>             Replace proxy: <protocol>://[user[:pass]@]
                            host:port (default: copy source's)
  --proxy-label <label>     Friendly proxy label (only with --proxy)
  --no-proxy                Drop the proxy on the clone (incompatible
                            with --proxy)
  --master-seed <hex>       Pin the master noise seed for reproducibility;
                            default = freshly random (recommended)
  --json                    Print full cloned Persona JSON instead of
                            a human summary
  -h, --help                Show this help

Examples:
  # Standard clone for a multi-account matrix:
  mosaiq personas clone reddit-alice reddit-alice-alt \\
    --display-name "Reddit Alice (alt)"

  # Clone but switch to a different sticky-session proxy:
  mosaiq personas clone reddit-alice reddit-alice-uk \\
    --display-name "Reddit Alice (UK)" \\
    --proxy http://user:p%40ss@proxy.example.com:8080 \\
    --timezone Europe/London \\
    --tags reddit,uk
`;

const PERSONA_ID_RE = /^[a-z][a-z0-9-]{2,63}$/;

interface CloneOpts {
  sourceId: string;
  newId: string;
  displayName: string;
  tags?: string[];
  notes?: string;
  timezone?: string;
  proxy?: ParsedProxyInput;
  proxyLabel?: string;
  noProxy: boolean;
  masterSeed?: string;
  json: boolean;
  help: boolean;
}

export async function runPersonasClone(argv: readonly string[]): Promise<number> {
  let opts: CloneOpts;
  try {
    opts = parseCloneArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (!opts.sourceId || !opts.newId) {
    process.stderr.write(`Error: <source-id> and <new-id> are both required.\n\n${HELP}`);
    return 2;
  }
  if (!opts.displayName) {
    process.stderr.write(`Error: --display-name is required.\n\n${HELP}`);
    return 2;
  }
  if (!PERSONA_ID_RE.test(opts.newId)) {
    process.stderr.write(
      `${fmt.red('✗')} Invalid new persona id "${opts.newId}": must be kebab-case, 3-64 chars, start with a letter.\n`,
    );
    return 2;
  }
  if (opts.proxy && opts.noProxy) {
    process.stderr.write(`${fmt.red('✗')} --proxy and --no-proxy are mutually exclusive.\n`);
    return 2;
  }
  if (opts.proxyLabel && !opts.proxy) {
    process.stderr.write(`${fmt.red('✗')} --proxy-label requires --proxy.\n`);
    return 2;
  }

  // 早期检查 source / new-id；clonePersona 内部也会查，但 CLI 想给更清晰的错误
  if (!personaExists(opts.sourceId as PersonaId)) {
    process.stderr.write(`${fmt.red('✗')} Source persona "${opts.sourceId}" not found.\n`);
    return 2;
  }
  if (personaExists(opts.newId as PersonaId)) {
    process.stderr.write(
      `${fmt.red('✗')} Target persona "${opts.newId}" already exists.\n` +
        `${fmt.dim('Pick a different new-id, or `mosaiq personas delete` first.')}\n`,
    );
    return 2;
  }

  const cloneOpts: CloneOptions = {
    newId: opts.newId,
    newDisplayName: opts.displayName,
    newTags: opts.tags,
    newNotes: opts.notes,
    newTimezone: opts.timezone,
    newProxy: opts.noProxy
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
    newMasterSeed: opts.masterSeed,
  };

  let cloned: Persona;
  try {
    cloned = clonePersona(opts.sourceId as PersonaId, cloneOpts);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(cloned, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${fmt.green('✓ Cloned persona')} ${fmt.cyan(opts.sourceId)} → ${fmt.cyan(cloned.metadata.id)}\n`,
  );
  process.stdout.write(`  ${fmt.dim('Display name:')} ${cloned.metadata.displayName}\n`);
  process.stdout.write(
    `  ${fmt.dim('Tags:        ')} ${
      cloned.metadata.tags.length === 0 ? fmt.dim('—') : cloned.metadata.tags.join(', ')
    }\n`,
  );
  process.stdout.write(`  ${fmt.dim('Timezone:    ')} ${cloned.system.timezone}\n`);
  if (cloned.network.proxy) {
    const x = cloned.network.proxy;
    const credPart = x.username ? `${x.username}${x.password ? ':***' : ''}@` : '';
    process.stdout.write(
      `  ${fmt.dim('Proxy:       ')} ${x.protocol}://${credPart}${x.host}:${x.port}${
        x.label ? `  ${fmt.dim(`(${x.label})`)}` : ''
      }\n`,
    );
  } else {
    process.stdout.write(`  ${fmt.dim('Proxy:       ')} ${fmt.dim('none')}\n`);
  }
  process.stdout.write(
    `  ${fmt.dim('Saved at:    ')} ~/.mosaiq/personas/${cloned.metadata.id}.json\n`,
  );
  process.stdout.write(
    `\n${fmt.dim('Note: noise seeds were freshly derived — the clone has an independent fingerprint from the source.')}\n`,
  );
  return 0;
}

function parseCloneArgs(argv: readonly string[]): CloneOpts {
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
      'master-seed': { type: 'string' },
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

  const tagsRaw = parsed.values.tags as string | undefined;
  let tags: string[] | undefined;
  if (tagsRaw !== undefined) {
    tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  return {
    sourceId: parsed.positionals[0] ?? '',
    newId: parsed.positionals[1] ?? '',
    displayName: (parsed.values['display-name'] as string | undefined) ?? '',
    tags,
    notes: parsed.values.notes as string | undefined,
    timezone: parsed.values.timezone as string | undefined,
    proxy,
    proxyLabel: parsed.values['proxy-label'] as string | undefined,
    noProxy: parsed.values['no-proxy'] === true,
    masterSeed: parsed.values['master-seed'] as string | undefined,
    json: parsed.values.json === true,
    help: parsed.values.help === true,
  };
}
