/**
 * report — 读 baseline-detection 输出的 raw.json，生成 report.md。
 *
 * 用法（仓库根目录）：
 *   pnpm --filter @mosaiq/sdk exec tsx bench/report.ts <results-dir>
 *
 * 不传 results-dir 时取 bench/results/ 下最新的一个。
 *
 * 输出 report.md 含：
 *   - 元信息（时间戳、persona、各站耗时）
 *   - 每站 pass/fail 项 详细列表
 *   - **surface 归因**：把检测失败项映射到 Canvas / WebGL / Audio / Font / WebRTC / 其他
 *   - **Phase 1 surface 优先级建议**（按检测失败数排序）
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface RawSummary {
  timestamp: string;
  overallMs: number;
  sitesAttempted: number;
  sitesOk: number;
  sitesFail: number;
  persona: {
    id: string;
    template: string;
    browser: unknown;
    system: unknown;
    /** Persona 期望的硬件值，用于 cross-check spoof 是否真的让浏览器返回这些值。 */
    hardware?: {
      gpu?: { webglVendor?: string; webglRenderer?: string };
    };
    /** 指纹噪声配置（canvas/webgl/audio noise seed 等）。 */
    fingerprint?: unknown;
  };
  results: Array<{
    id: string;
    name: string;
    url: string;
    ok: boolean;
    error?: string;
    durationMs: number;
    title?: string;
    bodyText?: string;
    screenshot?: string;
    html?: string;
    extracted?: Record<string, unknown>;
  }>;
}

/**
 * 把 BrowserLeaks 显示出来的"包装值"（含括号注释）剥成核心字符串，便于和 persona 声称值对比。
 *
 * 例：
 *   `"NVIDIA Corporation"` → `nvidia corporation`
 *   `"ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)"` → 同字符串小写
 *   `"Google Inc. (NVIDIA)"` → `google inc. (nvidia)`
 */
function normalizeWebglString(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

type Surface =
  | 'canvas'
  | 'webgl'
  | 'audio'
  | 'font'
  | 'webrtc'
  | 'navigator'
  | 'screen'
  | 'permissions'
  | 'timezone'
  | 'plugins'
  | 'webdriver'
  | 'other';

interface SurfaceHit {
  surface: Surface;
  /** 哪个站检测到的 */
  site: string;
  /** 检测项名称 */
  detector: string;
  /** 状态文本 */
  evidence: string;
  /** 严重度：high = 一定要补，medium = 影响中，low = 边缘 */
  severity: 'high' | 'medium' | 'low';
}

/**
 * 关键词到 surface 的映射。键值优先级递减（越靠前越特异）。
 */
const SURFACE_PATTERNS: Array<{
  pattern: RegExp;
  surface: Surface;
  severity: 'high' | 'medium' | 'low';
}> = [
  { pattern: /\bwebdriver\b/i, surface: 'webdriver', severity: 'high' },
  { pattern: /chromedriver|sequentum|phantomjs|selenium|automation/i, surface: 'webdriver', severity: 'high' },
  { pattern: /\bcanvas\b.*\b(hash|signature|fingerprint|noise|unique)/i, surface: 'canvas', severity: 'high' },
  { pattern: /\b(canvas\s+(2d|fingerprint|hash|toDataURL))\b/i, surface: 'canvas', severity: 'high' },
  { pattern: /\bwebgl\b.*(vendor|renderer|hash|fingerprint|unique)/i, surface: 'webgl', severity: 'high' },
  { pattern: /\b(unmasked\s+(vendor|renderer))\b/i, surface: 'webgl', severity: 'high' },
  { pattern: /\baudio(context)?\s*(fingerprint|hash|unique)/i, surface: 'audio', severity: 'high' },
  { pattern: /\b(font|fonts)\s*(fingerprint|enumeration|list|unique)/i, surface: 'font', severity: 'medium' },
  { pattern: /\bwebrtc\b/i, surface: 'webrtc', severity: 'high' },
  { pattern: /\b(local|public|private)\s*ip\s*(leak|address)/i, surface: 'webrtc', severity: 'high' },
  { pattern: /\bnavigator\.(userAgent|platform|hardwareConcurrency|deviceMemory|languages)/i, surface: 'navigator', severity: 'medium' },
  { pattern: /\b(screen|viewport|window)\s*(width|height|resolution)/i, surface: 'screen', severity: 'low' },
  { pattern: /\b(permissions|notifications)\b/i, surface: 'permissions', severity: 'low' },
  { pattern: /\b(timezone|locale|intl)\b/i, surface: 'timezone', severity: 'medium' },
  { pattern: /\bplugin/i, surface: 'plugins', severity: 'low' },
];

/**
 * 把一条 detector + evidence 文本归因到一个 surface。
 */
function attributeSurface(detector: string, evidence: string): { surface: Surface; severity: 'high' | 'medium' | 'low' } {
  const text = `${detector} ${evidence}`.toLowerCase();
  for (const { pattern, surface, severity } of SURFACE_PATTERNS) {
    if (pattern.test(text)) return { surface, severity };
  }
  return { surface: 'other', severity: 'low' };
}

// ═══════════════════════════════════════════════════════════════════════════
// 站点特异分析器
// ═══════════════════════════════════════════════════════════════════════════

function analyzeSannysoft(extracted: Record<string, unknown>, hits: SurfaceHit[]): string {
  const rows = (extracted.rows as Array<{ name: string; result: string; status: string }>) ?? [];
  const passes = (extracted.passes as number) ?? 0;
  const fails = (extracted.fails as number) ?? 0;
  const unknown = (extracted.unknown as number) ?? 0;
  const total = (extracted.total as number) ?? rows.length;

  const failedRows = rows.filter((r) => r.status === 'fail');
  for (const row of failedRows) {
    const { surface, severity } = attributeSurface(row.name, row.result);
    hits.push({
      surface,
      site: 'sannysoft',
      detector: row.name,
      evidence: row.result,
      severity,
    });
  }

  let md = `**结果**：${passes}/${total} 通过，${fails} 失败，${unknown} 未识别\n\n`;
  if (failedRows.length > 0) {
    md += `**失败检测项**：\n\n`;
    for (const row of failedRows) {
      md += `- ❌ \`${row.name}\` → ${row.result}\n`;
    }
  } else {
    md += `_全部通过_\n`;
  }
  return md;
}

function analyzeCreepjs(extracted: Record<string, unknown>, hits: SurfaceHit[]): string {
  const trustScore = extracted.trustScore as string | null;
  const fpId = extracted.fingerprintId as string | null;
  const liesCount = (extracted.liesCount as number | null) ?? 0;
  const boldFailCount = (extracted.boldFailCount as number | null) ?? 0;
  const liesSurfaces =
    (extracted.liesSurfaces as Array<{ surface: string; severity: string; hash: string }>) ?? [];
  const blocked = extracted.blockedCount as number | null;
  const errors = extracted.errorsCount as number | null;
  const sections = (extracted.sections as Array<{ title: string; subtitle: string }>) ?? [];

  let md = `**Trust Score**：${trustScore ?? 'N/A'}\n\n`;
  md += `**Fingerprint ID**：\`${fpId ?? 'N/A'}\`\n\n`;
  md += `**Lies**：${liesCount} | **Bold-fail**：${boldFailCount} | **Blocked**：${blocked ?? 'N/A'} | **Errors**：${errors ?? 'N/A'}\n\n`;

  // 每个 lies surface 入 hits — 这才是真正的 hook detection 度量
  if (liesSurfaces.length > 0) {
    md += `**Lies/bold-fail surfaces**（核心反检测指标）：\n\n`;
    for (const ls of liesSurfaces) {
      const icon = ls.severity === 'bold-fail' ? '🔴' : '🟠';
      md += `- ${icon} **${ls.surface}** (${ls.severity}) → \`${ls.hash}\`\n`;
      // 把 surface 名称归因到我们的 surface 分类
      const { surface, severity } = attributeSurface(ls.surface, ls.severity);
      hits.push({
        surface,
        site: 'creepjs',
        detector: `creepjs ${ls.severity}: ${ls.surface}`,
        evidence: `hash=${ls.hash}`,
        severity: ls.severity === 'bold-fail' ? 'high' : severity,
      });
    }
    md += `\n`;
  }

  if (sections.length > 0) {
    md += `**Sections detected**：\n\n`;
    for (const s of sections.slice(0, 20)) {
      md += `- **${s.title}**: ${s.subtitle.slice(0, 100)}\n`;
    }
  }

  return md;
}

function analyzeIphey(extracted: Record<string, unknown>, hits: SurfaceHit[]): string {
  const items = (extracted.items as Array<{ name: string; status: string }>) ?? [];
  const passes = (extracted.passes as number) ?? 0;
  const fails = (extracted.fails as number) ?? 0;
  const total = (extracted.total as number) ?? items.length;

  const failedItems = items.filter((i) => i.status === 'fail');
  for (const item of failedItems) {
    const { surface, severity } = attributeSurface(item.name, item.name);
    hits.push({
      surface,
      site: 'iphey',
      detector: item.name,
      evidence: 'failed',
      severity,
    });
  }

  let md = `**结果**：${passes}/${total} 通过，${fails} 失败\n\n`;
  if (failedItems.length > 0) {
    md += `**失败项**：\n\n`;
    for (const item of failedItems.slice(0, 30)) {
      md += `- ❌ ${item.name}\n`;
    }
  } else if (passes > 0) {
    md += `_全部通过_\n`;
  } else {
    md += `_⚠️ 解析未识别到检测项 — 可能站点结构变化，需手动看截图_\n`;
  }
  return md;
}

function analyzeBrowserleaksGeneric(
  extracted: Record<string, unknown>,
  _hits: SurfaceHit[],
): string {
  const pairs = (extracted.pairs as Array<{ name: string; value: string }>) ?? [];
  let md = `**抓到 ${pairs.length} 项 property/value**\n\n`;
  if (pairs.length > 0) {
    md += `<details><summary>展开</summary>\n\n`;
    for (const p of pairs.slice(0, 50)) {
      md += `- **${p.name}**: \`${p.value.slice(0, 100)}\`\n`;
    }
    md += `\n</details>\n`;
  }
  return md;
}

function analyzeBrowserleaksCanvas(
  extracted: Record<string, unknown>,
  hits: SurfaceHit[],
  _persona: RawSummary['persona'],
): string {
  const hash = extracted.canvasHash as string | undefined;
  const uniqueness = extracted.uniqueness as string | undefined;
  let md = `**Canvas Hash**：\`${hash ?? 'N/A'}\`\n\n`;
  md += `**Uniqueness**：${uniqueness ?? 'N/A'}\n\n`;

  // 设计决策：单次 baseline run 无法判断 canvas hash 是「真硬件 hash」还是「persona spoof 后的稳定 hash」。
  // 真正的验证是 **跨 run 的 deterministic seed 对比**（同 persona 应跑出同 hash；不同 persona 应跑出不同 hash）。
  // 这一步留给 Day 2+ 的 `bench/canvas-cross-check.ts`。
  //
  // 当前规则：
  //   - hash 不存在 → 致命（解析失败或 canvas 全黑） → high hit
  //   - hash 存在 + uniqueness 很低（< 0.01%）→ 表示该 hash 极其常见，spoof 成功 → 不 hit
  //   - hash 存在 + uniqueness 高（> 50%）→ 该 hash 在 BrowserLeaks DB 中接近独一无二 → spoof 失败或 noise 不足 → medium hit
  //   - 其他 → info only，不 hit
  if (!hash) {
    hits.push({
      surface: 'canvas',
      site: 'browserleaks-canvas',
      detector: 'canvas signature missing',
      evidence: 'canvas hash 提取失败 — 站点 DOM 变化或 canvas API 被禁用',
      severity: 'high',
    });
  } else {
    const uniqPct = parseUniquenessPct(uniqueness);
    if (uniqPct !== null && uniqPct > 50) {
      hits.push({
        surface: 'canvas',
        site: 'browserleaks-canvas',
        detector: 'canvas hash too unique',
        evidence: `uniqueness=${uniqueness} (>50%) — noise 不足或 spoof 未生效`,
        severity: 'medium',
      });
    }
    // 否则：spoof 看似生效（hash 在 BrowserLeaks DB 中常见），记录但不 hit。
  }
  md += analyzeBrowserleaksGeneric(extracted, hits);
  return md;
}

/**
 * 解析 BrowserLeaks 的 uniqueness 字符串（如 `"0.01% (1 in 12000)"` 或 `"75.3%"`）→ 百分比数值。
 */
function parseUniquenessPct(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  return m && m[1] ? Number.parseFloat(m[1]) : null;
}

/**
 * deviceandbrowserinfo Bot Check —— 把每个布尔信号映射回我们的 surface 分类。
 *
 * 任何 `true` 都意味着 spoof 失败；high severity（直接揭穿自动化的）vs
 * medium（弱信号 / 软可疑）按 detector 名分类。
 */
const DBI_KEY_TO_SURFACE: Readonly<
  Record<string, { surface: Surface; severity: 'high' | 'medium' | 'low' }>
> = {
  hasBotUserAgent: { surface: 'navigator', severity: 'high' },
  hasWebdriverTrue: { surface: 'webdriver', severity: 'high' },
  hasWebdriverInFrameTrue: { surface: 'webdriver', severity: 'high' },
  isPlaywright: { surface: 'webdriver', severity: 'high' },
  hasInconsistentChromeObject: { surface: 'navigator', severity: 'medium' },
  isPhantom: { surface: 'webdriver', severity: 'high' },
  isNightmare: { surface: 'webdriver', severity: 'high' },
  isSequentum: { surface: 'webdriver', severity: 'high' },
  isSeleniumChromeDefault: { surface: 'webdriver', severity: 'high' },
  isHeadlessChrome: { surface: 'navigator', severity: 'high' },
  isWebGLInconsistent: { surface: 'webgl', severity: 'high' },
  isAutomatedWithCDP: { surface: 'webdriver', severity: 'high' },
  isAutomatedWithCDPInWebWorker: { surface: 'webdriver', severity: 'high' },
  hasInconsistentClientHints: { surface: 'navigator', severity: 'high' },
  hasInconsistentGPUFeatures: { surface: 'webgl', severity: 'medium' },
  isIframeOverridden: { surface: 'other', severity: 'medium' },
  hasInconsistentWorkerValues: { surface: 'navigator', severity: 'high' },
  hasHighHardwareConcurrency: { surface: 'navigator', severity: 'low' },
  hasHeadlessChromeDefaultScreenResolution: { surface: 'screen', severity: 'high' },
  hasSuspiciousWeakSignals: { surface: 'other', severity: 'low' },
};

function analyzeDbiBot(extracted: Record<string, unknown>, hits: SurfaceHit[]): string {
  const flags = (extracted.flags as Record<string, boolean> | undefined) ?? {};
  const triggered = (extracted.flagsTriggered as string[] | undefined) ?? [];
  const total = (extracted.flagsTotal as number | undefined) ?? Object.keys(flags).length;
  const trueCount = (extracted.flagsTrue as number | undefined) ?? triggered.length;
  const verdict = extracted.verdict as string | null | undefined;

  let md = `**Verdict**：${verdict ?? 'N/A'}\n\n`;
  md += `**布尔信号**：${trueCount}/${total} 触发\n\n`;

  if (trueCount === 0 && total > 0) {
    md += `_全部 ${total} 个 bot 信号均未触发 — spoof 通过_ ✅\n`;
  } else if (total === 0) {
    md += `_⚠️ 未解析到任何 \`hasXxx/isXxx\` 布尔字段；可能页面 DOM 已变化 / Turnstile 拦截 — 看截图_\n`;
  } else {
    md += `**触发的信号**：\n\n`;
    for (const key of triggered) {
      const route = DBI_KEY_TO_SURFACE[key] ?? {
        surface: 'other' as Surface,
        severity: 'medium' as const,
      };
      const icon =
        route.severity === 'high' ? '🔴' : route.severity === 'medium' ? '🟡' : '⚪';
      md += `- ${icon} **\`${key}\`** → surface: \`${route.surface}\`\n`;
      hits.push({
        surface: route.surface,
        site: 'dbi-bot',
        detector: key,
        evidence: 'true',
        severity: route.severity,
      });
    }
  }
  return md;
}

/**
 * AmIUnique —— 关心两个事情：(a) 整体 verdict (unique vs not)；(b) outlier 属性数。
 *
 * outlier = similarity < 0.5%。出现 outlier 通常意味着 spoof 出了"真人不会有的组合"
 * （例如 WebGL renderer = "NVIDIA GTX 1080" 但 platform = "MacIntel"）。
 *
 * 我们不直接 push high hit（amiunique 不是真在指控 bot），而是把每个 outlier 当作
 * medium 提示，帮助挑下一个调优 surface。
 */
function analyzeAmIUnique(extracted: Record<string, unknown>, hits: SurfaceHit[]): string {
  const verdict = extracted.verdict as string | null | undefined;
  const attrs =
    (extracted.attrs as
      | Array<{ name: string; similarityPct: number | null; similarityRaw: string; value: string }>
      | undefined) ?? [];
  const outliers =
    (extracted.outliers as
      | Array<{ name: string; similarityPct: number | null; similarityRaw: string; value: string }>
      | undefined) ?? [];
  const total = (extracted.attrsTotal as number | undefined) ?? attrs.length;

  let md = `**Verdict**：${verdict ?? 'N/A'}\n\n`;
  md += `**抓到属性**：${total} 项\n\n`;
  md += `**Outlier 属性（< 0.5% similarity）**：${outliers.length} 项\n\n`;

  if (outliers.length === 0 && total > 0) {
    md += `_所有属性都在合理常见区间 — 无 outlier 提示_\n`;
  } else if (outliers.length > 0) {
    md += `<details><summary>展开 Outlier 详情</summary>\n\n`;
    for (const o of outliers.slice(0, 30)) {
      md += `- 🟡 **${o.name}** \`${o.similarityRaw}\` → \`${o.value.slice(0, 80)}\`\n`;
      const { surface } = attributeSurface(o.name, o.value);
      hits.push({
        surface,
        site: 'amiunique',
        detector: `amiunique outlier: ${o.name}`,
        evidence: `similarity=${o.similarityRaw} value=${o.value.slice(0, 100)}`,
        severity: 'medium',
      });
    }
    md += `\n</details>\n`;
  }

  if (total === 0) {
    md += `_⚠️ 未解析到属性表；amiunique DOM 结构可能已变化 — 看截图_\n`;
  }
  return md;
}

/**
 * Pixelscan —— SPA，可能被 Cloudflare 卡住。我们做：
 *   - 若 challenge 触发 → 输出警告 + 不 hit（站点未真正完成检测，结果不可信）。
 *   - 否则按卡片状态出 high (danger) / medium (warning) hit。
 */
function analyzePixelscan(extracted: Record<string, unknown>, hits: SurfaceHit[]): string {
  const cards =
    (extracted.cards as
      | Array<{ title: string; status: string; summary: string }>
      | undefined) ?? [];
  const danger = (extracted.dangerCards as number | undefined) ?? 0;
  const warning = (extracted.warningCards as number | undefined) ?? 0;
  const success = (extracted.successCards as number | undefined) ?? 0;
  const unknown = (extracted.unknownCards as number | undefined) ?? 0;
  const challengeDetected = extracted.challengeDetected as boolean | undefined;
  const stillLoading = extracted.stillLoading as boolean | undefined;
  const maskVerdict = extracted.maskVerdict as string | null | undefined;

  let md = `**Mask Verdict**：${maskVerdict ?? 'N/A'}\n\n`;
  md += `**核心卡片**：✅ ${success} / 🟡 ${warning} / 🔴 ${danger} / ⚪ ${unknown}\n\n`;

  if (challengeDetected) {
    md += `_⚠️ 检测到 Cloudflare / Turnstile 挑战 — pixelscan 未完成扫描，结果不可信。请用 \`HEADED=1\` 或换干净 IP 重跑。_\n`;
    return md;
  }
  if (stillLoading) {
    md += `_⚠️ SPA 仍处于 "Collecting Data..." 状态 — 反爬墙未让 fetch 出 result。请用 \`HEADED=1\` 或换干净 IP 重跑。本次结果跳过 hits 归因。_\n`;
    // 不入 hits：因为根本没拿到检测结果
    if (cards.length > 0) {
      md += `\n<details><summary>展开 ${cards.length} 个白名单卡片（仅观察）</summary>\n\n`;
      for (const c of cards) {
        const icon =
          c.status === 'danger' ? '🔴' : c.status === 'warning' ? '🟡' : c.status === 'success' ? '✅' : '⚪';
        md += `- ${icon} **${c.title}** _(status: ${c.status})_\n`;
      }
      md += `\n</details>\n`;
    }
    return md;
  }

  if (cards.length === 0) {
    md += `_⚠️ 未解析到任何核心检测卡片 — SPA 还未渲染完毕或选择器需要更新_\n`;
    return md;
  }

  // 把 danger/warning 卡片入 hits
  for (const c of cards) {
    if (c.status !== 'danger' && c.status !== 'warning') continue;
    const { surface, severity: attrSev } = attributeSurface(c.title, c.summary);
    const sev: 'high' | 'medium' | 'low' =
      c.status === 'danger' ? 'high' : c.status === 'warning' ? 'medium' : attrSev;
    hits.push({
      surface,
      site: 'pixelscan',
      detector: `pixelscan ${c.status}: ${c.title}`,
      evidence: c.summary.slice(0, 200),
      severity: sev,
    });
  }

  md += `<details><summary>展开 ${cards.length} 个核心卡片详情</summary>\n\n`;
  for (const c of cards) {
    const icon =
      c.status === 'danger' ? '🔴' : c.status === 'warning' ? '🟡' : c.status === 'success' ? '✅' : '⚪';
    md += `- ${icon} **${c.title}** _(status: ${c.status})_\n`;
  }
  md += `\n</details>\n`;
  return md;
}

function analyzeBrowserleaksWebgl(
  extracted: Record<string, unknown>,
  hits: SurfaceHit[],
  persona: RawSummary['persona'],
): string {
  const vendor = extracted.webglVendor as string | undefined;
  const renderer = extracted.webglRenderer as string | undefined;
  const unmaskedV = extracted.unmaskedVendor as string | undefined;
  const unmaskedR = extracted.unmaskedRenderer as string | undefined;

  const expectedV = persona.hardware?.gpu?.webglVendor;
  const expectedR = persona.hardware?.gpu?.webglRenderer;

  let md = `**WebGL Vendor**：\`${vendor ?? 'N/A'}\`\n\n`;
  md += `**WebGL Renderer**：\`${renderer ?? 'N/A'}\`\n\n`;
  md += `**Unmasked Vendor**：\`${unmaskedV ?? 'N/A'}\`\n\n`;
  md += `**Unmasked Renderer**：\`${unmaskedR ?? 'N/A'}\`\n\n`;
  if (expectedV || expectedR) {
    md += `**Persona 期望 Vendor**：\`${expectedV ?? 'N/A'}\`\n\n`;
    md += `**Persona 期望 Renderer**：\`${expectedR ?? 'N/A'}\`\n\n`;
  }

  // 新判定（cross-check vs persona expected）：
  //   - persona 没声称 expected 值 → fallback 老逻辑（只要 unmasked 存在就 hit）
  //   - expected 存在且 actual 与之**一致** → spoof 成功 → 不 hit
  //   - expected 存在但 actual 不一致或缺失 → 暴露真硬件 → high hit
  //   - expected 存在但 BrowserLeaks 显示 N/A（站点解析失败）→ info only，不 hit
  if (!expectedV && !expectedR) {
    if (unmaskedV || unmaskedR) {
      hits.push({
        surface: 'webgl',
        site: 'browserleaks-webgl',
        detector: 'unmasked GPU info (no persona baseline)',
        evidence: `vendor=${unmaskedV ?? '?'} renderer=${unmaskedR ?? '?'}`,
        severity: 'high',
      });
    }
  } else {
    const actualV = normalizeWebglString(unmaskedV);
    const actualR = normalizeWebglString(unmaskedR);
    const wantV = normalizeWebglString(expectedV);
    const wantR = normalizeWebglString(expectedR);

    const vendorOk = actualV !== '' && wantV !== '' && actualV.includes(wantV);
    const rendererOk = actualR !== '' && wantR !== '' && actualR.includes(wantR);

    if (wantV && !vendorOk) {
      hits.push({
        surface: 'webgl',
        site: 'browserleaks-webgl',
        detector: 'unmasked vendor mismatch',
        evidence: `expected="${expectedV}" actual="${unmaskedV ?? '?'}"`,
        severity: 'high',
      });
    }
    if (wantR && !rendererOk) {
      hits.push({
        surface: 'webgl',
        site: 'browserleaks-webgl',
        detector: 'unmasked renderer mismatch',
        evidence: `expected="${expectedR}" actual="${unmaskedR ?? '?'}"`,
        severity: 'high',
      });
    }
    if (vendorOk && rendererOk) {
      md += `\n> ✅ **WebGL spoof 验证通过** — unmasked vendor / renderer 与 persona 声称一致\n\n`;
    }
  }
  md += analyzeBrowserleaksGeneric(extracted, hits);
  return md;
}

// ═══════════════════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════════════════

function findLatestResultsDir(): string {
  const root = resolve(__dirname, 'results');
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    throw new Error(`bench/results/ 目录不存在；先跑 baseline-detection.ts`);
  }
  const dirs = entries
    .map((name) => ({ name, path: join(root, name) }))
    .filter((e) => {
      try {
        return statSync(e.path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  if (dirs.length === 0) throw new Error(`bench/results/ 没有子目录；先跑 baseline-detection.ts`);
  const first = dirs[0];
  if (!first) throw new Error(`bench/results/ 没有子目录；先跑 baseline-detection.ts`);
  return first.path;
}

function summarizeSurfacePriority(hits: SurfaceHit[]): string {
  const byCount = new Map<Surface, { high: number; medium: number; low: number; total: number }>();
  for (const h of hits) {
    const cur = byCount.get(h.surface) ?? { high: 0, medium: 0, low: 0, total: 0 };
    cur[h.severity]++;
    cur.total++;
    byCount.set(h.surface, cur);
  }
  const ranked = [...byCount.entries()].sort((a, b) => {
    // 加权：high*3 + medium*1.5 + low*1
    const score = (e: typeof a[1]) => e.high * 3 + e.medium * 1.5 + e.low;
    return score(b[1]) - score(a[1]);
  });

  let md = `| 排名 | Surface | High | Medium | Low | 加权分 | 推荐动作 |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  ranked.forEach(([surface, c], i) => {
    const score = c.high * 3 + c.medium * 1.5 + c.low;
    const action = recommendAction(surface, c);
    md += `| ${i + 1} | **${surface}** | ${c.high} | ${c.medium} | ${c.low} | ${score.toFixed(1)} | ${action} |\n`;
  });
  if (ranked.length === 0) md += `| — | — | — | — | — | — | _所有站点未检测到失败项 — 现状已较好_ |\n`;
  return md;
}

function recommendAction(surface: Surface, c: { high: number; medium: number; low: number }): string {
  const total = c.high + c.medium + c.low;
  if (total === 0) return '保持现状';
  switch (surface) {
    case 'canvas':
      return 'Phase 1 优先 — 注入 toDataURL/getImageData 噪声';
    case 'webgl':
      return 'Phase 1 优先 — 拦截 getParameter/UNMASKED_VENDOR_WEBGL';
    case 'audio':
      return 'Phase 1 — 注入 OfflineAudioContext.getChannelData 扰动';
    case 'font':
      return 'Phase 1 — 拦截 document.fonts / measureText';
    case 'webrtc':
      return 'Phase 1 — chrome flag --force-webrtc-ip-handling-policy + getUserMedia 拦截';
    case 'webdriver':
      return '检查 runner.ts:155 是否生效（理论上已处理）';
    case 'navigator':
      return '检查 runner.ts navigator spoof 完整性';
    case 'screen':
      return '检查 launcher viewport / persona.system.screen';
    case 'permissions':
      return '检查 runner.ts §10 permissions spoof';
    case 'timezone':
      return '检查 launcher contextOptions.timezoneId';
    case 'plugins':
      return '检查 runner.ts plugins shim';
    case 'other':
      return '看具体 detector 决定';
  }
}

function generate(rawPath: string, outDir: string): void {
  const summary: RawSummary = JSON.parse(readFileSync(rawPath, 'utf8'));
  const hits: SurfaceHit[] = [];

  let md = `# Mosaiq SDK Baseline Detection Report\n\n`;
  md += `> Phase 1 起点基线 — 用于决策第一个补强 surface\n\n`;
  md += `**生成时间**：${summary.timestamp}\n\n`;
  md += `**总耗时**：${(summary.overallMs / 1000).toFixed(1)}s\n\n`;
  md += `**Persona 模板**：\`${summary.persona.template}\`\n\n`;
  md += `**站点结果**：${summary.sitesOk}/${summary.sitesAttempted} 成功跑完\n\n`;
  md += `---\n\n## 各站详情\n\n`;

  for (const r of summary.results) {
    md += `### ${r.name} (\`${r.id}\`)\n\n`;
    md += `- URL：${r.url}\n`;
    md += `- 耗时：${r.durationMs}ms\n`;
    md += `- 状态：${r.ok ? '✅ OK' : '❌ FAIL'}\n`;
    if (r.error) md += `- 错误：\`${r.error}\`\n`;
    if (r.title) md += `- 标题：${r.title}\n`;
    if (r.screenshot) md += `- 截图：[\`${r.screenshot}\`](./${r.screenshot})\n`;
    if (r.html) md += `- HTML：[\`${r.html}\`](./${r.html})\n`;
    md += `\n`;

    if (r.ok && r.extracted) {
      switch (r.id) {
        case 'sannysoft':
          md += analyzeSannysoft(r.extracted, hits);
          break;
        case 'creepjs':
          md += analyzeCreepjs(r.extracted, hits);
          break;
        case 'iphey':
          md += analyzeIphey(r.extracted, hits);
          break;
        case 'browserleaks-canvas':
          md += analyzeBrowserleaksCanvas(r.extracted, hits, summary.persona);
          break;
        case 'browserleaks-webgl':
          md += analyzeBrowserleaksWebgl(r.extracted, hits, summary.persona);
          break;
        case 'dbi-bot':
          md += analyzeDbiBot(r.extracted, hits);
          break;
        case 'amiunique':
          md += analyzeAmIUnique(r.extracted, hits);
          break;
        case 'pixelscan':
          md += analyzePixelscan(r.extracted, hits);
          break;
        case 'browserleaks-js':
        default:
          md += analyzeBrowserleaksGeneric(r.extracted, hits);
          break;
      }
    }
    md += `\n---\n\n`;
  }

  // ── Phase 1 surface 优先级 ──────────────────────────────────────
  md += `## Phase 1 Surface 优先级（基于检测结果归因）\n\n`;
  md += summarizeSurfacePriority(hits);
  md += `\n\n`;

  // ── 完整 hits 列表 ──────────────────────────────────────────────
  if (hits.length > 0) {
    md += `## 完整失败检测项（按 surface 分组）\n\n`;
    const bySurface = new Map<Surface, SurfaceHit[]>();
    for (const h of hits) {
      const arr = bySurface.get(h.surface) ?? [];
      arr.push(h);
      bySurface.set(h.surface, arr);
    }
    for (const [surface, arr] of [...bySurface.entries()].sort((a, b) => b[1].length - a[1].length)) {
      md += `### \`${surface}\` (${arr.length} 项)\n\n`;
      for (const h of arr.slice(0, 30)) {
        const sevIcon = h.severity === 'high' ? '🔴' : h.severity === 'medium' ? '🟡' : '⚪';
        md += `- ${sevIcon} **\`${h.detector}\`** _(at ${h.site})_ — ${h.evidence}\n`;
      }
      md += `\n`;
    }
  }

  // ── 下一步 ──────────────────────────────────────────────────────
  md += `## 下一步\n\n`;
  md += `1. 看上面 "Phase 1 Surface 优先级" 表，从加权分最高的 surface 起手\n`;
  md += `2. 写对应模块的 spec.md（参考 \`chromium-fork/patches/\` 已有草案）\n`;
  md += `3. 在 \`packages/sdk/src/injection/\` 加新模块（或扩展 runner.ts）\n`;
  md += `4. 加单测（vitest，目标 ≥ 10 测试）\n`;
  md += `5. 重跑 \`bench/baseline-detection.ts\` 验证通过率提升\n\n`;
  md += `如需重新跑：\n\n`;
  md += `\`\`\`bash\npnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts\npnpm --filter @mosaiq/sdk exec tsx bench/report.ts\n\`\`\`\n`;

  const outPath = join(outDir, 'report.md');
  writeFileSync(outPath, md, 'utf8');
  console.log(`[report] wrote ${outPath}`);
  console.log(`[report] hits: ${hits.length}`);
  if (hits.length > 0) {
    const top = [...new Set(hits.map((h) => h.surface))].slice(0, 3).join(', ');
    console.log(`[report] top surfaces: ${top}`);
  }
}

function main() {
  const argDir = process.argv[2];
  const dir = argDir ? resolve(argDir) : findLatestResultsDir();
  const rawPath = join(dir, 'raw.json');
  console.log(`[report] reading ${rawPath}`);
  generate(rawPath, dir);
}

main();
