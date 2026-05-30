/**
 * `mosaiq personas create <persona-id>` — 基于 template 在 ~/.mosaiq/personas/ 下
 * 创建并落盘一份新 persona，行为与 desktop `PersonaCreatePage` 完全等价（同一份
 * `TEMPLATE_CATALOG` + 同一个 `savePersona`）。
 *
 * 必填：
 *   <persona-id>             kebab-case id，与 desktop UI 的 ID 校验同 regex
 *   --template <id>          模板 id（参 `mosaiq personas templates list`）
 *   --display-name <name>    人读名称
 *
 * 可选：
 *   --tags <a,b,c>           逗号分隔。Phase 9.5+ 自动追加 `template:<id>` 让 list/show
 *                            能反查模板（与 desktop 的 bare-tag 约定都兼容，详见
 *                            template-tag.ts）
 *   --notes <text>           备注
 *   --timezone <tz>          覆盖模板默认时区
 *   --proxy <url>            `<protocol>://[user[:pass]@]host:port`，protocol ∈
 *                            {http, https, socks5}；URL-encoded credentials 会自动 decode
 *   --proxy-label <label>    代理别名（如 'IPRoyal residential US'）
 *   --master-seed <hex>      持久化 fingerprint 噪声 seed 入参（便于可复现实验）
 *   --json                   吐完整 Persona JSON 而不是人读 summary
 *
 * 退出码：
 *   0 = 创建成功
 *   2 = 参数错 / 未知模板 / persona id 已占用 / proxy URL 解析失败
 */

import { parseArgs } from 'node:util';

import { TEMPLATE_CATALOG } from '@runova/persona-schema/templates';
import { type Persona, type PersonaId, personaExists, savePersona } from '@runova/sdk';

import { fmt } from '../../output.js';
import { type ParsedProxyInput, parseProxyUrl } from './proxy-url.js';
import { makeTemplateTag } from './template-tag.js';

// `TEMPLATE_CATALOG` 是 `as const`，t.id 是字面量联合；这里 widen 成 string[]
// 让 `.includes(string)` 不报 TS2345。
const TEMPLATE_IDS: readonly string[] = TEMPLATE_CATALOG.map((t) => t.id);

const HELP = `Usage: mosaiq personas create <persona-id> --template <id> --display-name <name> [options]

Create a new persona under ~/.mosaiq/personas/<id>.json. Mirrors the
desktop "新建 Persona" form: same templates, same fields, same disk layout.

Arguments:
  <persona-id>              kebab-case, 3-64 chars, starts with letter
                            (e.g. 'reddit-alice', 'us-shopping-02')

Required options:
  --template <id>           Persona template (run \`mosaiq personas
                            templates list\` to see ids)
  --display-name <name>     Human-readable name shown in the desktop UI

Optional:
  --tags <a,b,c>            Comma-separated tags (default: template defaults
                            like 'reddit, us'). \`template:<id>\` is
                            auto-appended for round-trip discoverability.
  --notes <text>            Free-form notes
  --timezone <tz>           IANA tz override (e.g. 'America/Los_Angeles');
                            falls back to template default if omitted
  --proxy <url>             <protocol>://[user[:pass]@]host:port; protocol
                            ∈ {http, https, socks5}. URL-encoded
                            credentials are auto-decoded.
  --proxy-label <label>     Friendly label shown in UI (e.g. 'IPRoyal US')
  --master-seed <hex>       Persist fingerprint noise master seed for
                            reproducibility; default = freshly random
  --json                    Print full Persona JSON instead of a summary
  -h, --help                Show this help

Examples:
  mosaiq personas create reddit-alice \\
    --template win11-chrome-us \\
    --display-name "Reddit Alice"

  mosaiq personas create reddit-bob \\
    --template win11-chrome-us \\
    --display-name "Reddit Bob" \\
    --proxy http://user:p%40ss@proxy.example.com:8080 \\
    --proxy-label "IPRoyal residential US" \\
    --tags reddit,us,warming
`;

const PERSONA_ID_RE = /^[a-z][a-z0-9-]{2,63}$/;

interface CreateOpts {
  personaId: string;
  template: string;
  displayName: string;
  tags?: string[];
  notes?: string;
  timezone?: string;
  proxy?: ParsedProxyInput;
  proxyLabel?: string;
  masterSeed?: string;
  json: boolean;
  help: boolean;
}

export async function runPersonasCreate(argv: readonly string[]): Promise<number> {
  let opts: CreateOpts;
  try {
    opts = parseCreateArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // ── 参数校验 ──────────────────────────────────────────────────────────
  if (!opts.personaId) {
    process.stderr.write(`Error: <persona-id> is required.\n\n${HELP}`);
    return 2;
  }
  if (!PERSONA_ID_RE.test(opts.personaId)) {
    process.stderr.write(
      `${fmt.red('✗')} Invalid persona id "${opts.personaId}": must be kebab-case, 3-64 chars, start with a letter.\n`,
    );
    return 2;
  }
  if (!opts.template) {
    process.stderr.write(`Error: --template is required.\n\n${HELP}`);
    return 2;
  }
  if (!TEMPLATE_IDS.includes(opts.template)) {
    process.stderr.write(
      `${fmt.red('✗')} Unknown template "${opts.template}". Available: ${TEMPLATE_IDS.join(', ')}\n`,
    );
    return 2;
  }
  if (!opts.displayName) {
    process.stderr.write(`Error: --display-name is required.\n\n${HELP}`);
    return 2;
  }
  if (personaExists(opts.personaId as PersonaId)) {
    process.stderr.write(
      `${fmt.red('✗')} Persona "${opts.personaId}" already exists.\n` +
        `${fmt.dim('Use a different id, or `mosaiq personas delete` first.')}\n`,
    );
    return 2;
  }

  // ── 调对应模板 ctor ──────────────────────────────────────────────────
  const tagsWithTemplate = mergeTagsWithTemplate(opts.tags, opts.template);

  // 注入到模板 ctor 的入参形态（不含 bypassList，模板内部会填 []）
  const proxyInput = opts.proxy
    ? {
        protocol: opts.proxy.protocol,
        host: opts.proxy.host,
        port: opts.proxy.port,
        username: opts.proxy.username,
        password: opts.proxy.password,
        label: opts.proxyLabel,
      }
    : undefined;

  const entry = TEMPLATE_CATALOG.find((t) => t.id === opts.template);
  if (!entry) {
    // 已经在上方 includes() 检查过；冗余 guard 仅为类型 narrowing
    process.stderr.write(`${fmt.red('✗')} Unknown template "${opts.template}"\n`);
    return 2;
  }

  let persona: Persona;
  try {
    persona = entry.create({
      id: opts.personaId as PersonaId,
      displayName: opts.displayName,
      tags: tagsWithTemplate,
      notes: opts.notes,
      timezone: opts.timezone,
      proxy: proxyInput,
      masterSeed: opts.masterSeed,
    });
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} Failed to build persona: ${(err as Error).message}\n`);
    return 2;
  }

  let saved: Persona;
  try {
    saved = savePersona(persona);
  } catch (err) {
    // 多半是 schema 校验失败（例：timezone 不是 IANA / locale 不合规）
    process.stderr.write(`${fmt.red('✗')} Failed to save persona: ${(err as Error).message}\n`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
    return 0;
  }

  // ── 人读 summary ─────────────────────────────────────────────────────
  process.stdout.write(`${fmt.green('✓ Created persona')} ${fmt.cyan(saved.metadata.id)}\n`);
  process.stdout.write(`  ${fmt.dim('Display name:')} ${saved.metadata.displayName}\n`);
  process.stdout.write(`  ${fmt.dim('Template:    ')} ${opts.template}\n`);
  process.stdout.write(
    `  ${fmt.dim('Tags:        ')} ${
      saved.metadata.tags.length === 0 ? fmt.dim('—') : saved.metadata.tags.join(', ')
    }\n`,
  );
  process.stdout.write(
    `  ${fmt.dim('Timezone:    ')} ${saved.system.timezone}${
      opts.timezone ? '' : fmt.dim(' (template default)')
    }\n`,
  );
  if (saved.network.proxy) {
    const x = saved.network.proxy;
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
    `  ${fmt.dim('Saved at:    ')} ~/.mosaiq/personas/${saved.metadata.id}.json\n`,
  );
  process.stdout.write(
    `\n${fmt.dim(`Tip: \`mosaiq detection-lab run ${saved.metadata.id}\` to verify the fingerprint.`)}\n`,
  );
  return 0;
}

/**
 * 把用户传入的 `--tags` 与 `template:<id>` 合并、去重。
 *
 * 行为：
 *   - 用户 tag 优先（保持顺序）
 *   - 未显式指定 `--tags` 时，让模板 ctor 自己填默认（`['reddit', 'us']` 等），
 *     模板默认值之上再追加 `template:<id>` —— 但因为 ctor 在内部填默认，我们这里
 *     拿不到默认列表。退而求其次：当用户没传 --tags 时，**只**追加模板 tag，让
 *     ctor 接收 `tags = [makeTemplateTag(id)]`，覆盖掉 `['reddit', 'us']` 这种
 *     模板硬编码默认 —— 这能让 list/show 反查到模板，且不强行混进用户没要求的
 *     `reddit` / `us` 标签。
 */
function mergeTagsWithTemplate(userTags: string[] | undefined, templateId: string): string[] {
  const templateTag = makeTemplateTag(templateId);
  if (!userTags) return [templateTag];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of userTags) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  if (!seen.has(templateTag)) out.push(templateTag);
  return out;
}

function parseCreateArgs(argv: readonly string[]): CreateOpts {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      template: { type: 'string' },
      'display-name': { type: 'string' },
      tags: { type: 'string' },
      notes: { type: 'string' },
      timezone: { type: 'string' },
      proxy: { type: 'string' },
      'proxy-label': { type: 'string' },
      'master-seed': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  let proxy: ParsedProxyInput | undefined;
  const proxyRaw = parsed.values.proxy as string | undefined;
  if (proxyRaw) {
    proxy = parseProxyUrl(proxyRaw);
  }

  const tagsRaw = parsed.values.tags as string | undefined;
  const tags = tagsRaw
    ? tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : undefined;

  return {
    personaId: parsed.positionals[0] ?? '',
    template: (parsed.values.template as string | undefined) ?? '',
    displayName: (parsed.values['display-name'] as string | undefined) ?? '',
    tags,
    notes: parsed.values.notes as string | undefined,
    timezone: parsed.values.timezone as string | undefined,
    proxy,
    proxyLabel: parsed.values['proxy-label'] as string | undefined,
    masterSeed: parsed.values['master-seed'] as string | undefined,
    json: parsed.values.json === true,
    help: parsed.values.help === true,
  };
}
