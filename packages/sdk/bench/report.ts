/**
 * report — 读 baseline-detection 输出的 raw.json，生成 report.md。
 *
 * 用法（仓库根目录）：
 *   pnpm --filter @runova/sdk exec tsx bench/report.ts <results-dir>
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

import type {
  DetectionRunRaw,
  DetectionScore,
  SurfaceHit,
  SurfaceName,
} from '../src/detection-lab/index.js';
import {
  DBI_KEY_TO_SURFACE,
  FPSCANNER_TO_SURFACE,
  KNOWN_OUTDATED_FPSCANNER_RULES,
  attributeSurface,
  computeScore,
  normalizeWebglString,
  parseUniquenessPct,
  weightHit,
} from '../src/detection-lab/scorer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * v0.8 起 raw.json 的 shape 类型 + scorer 算法 single-source-of-truth 在
 * `src/detection-lab/scorer.ts`。本文件仅负责 markdown 渲染：从 raw.json
 * + scorer.ts 计算的 DetectionScore 生成 report.md，不再推断 / 路由 hits。
 *
 * `RawSummary` / `Surface` 是老命名 alias，保留以免函数签名大改。
 */
type RawSummary = DetectionRunRaw;
type Surface = SurfaceName;

// ═══════════════════════════════════════════════════════════════════════════
// 站点特异分析器
// ═══════════════════════════════════════════════════════════════════════════

function analyzeSannysoft(extracted: Record<string, unknown>): string {
  const rows = (extracted.rows as Array<{ name: string; result: string; status: string }>) ?? [];
  const passes = (extracted.passes as number) ?? 0;
  const fails = (extracted.fails as number) ?? 0;
  const unknown = (extracted.unknown as number) ?? 0;
  const total = (extracted.total as number) ?? rows.length;

  const failedRows = rows.filter((r) => r.status === 'fail');

  let md = `**结果**：${passes}/${total} 通过，${fails} 失败，${unknown} 未识别\n\n`;
  if (failedRows.length > 0) {
    md += '**失败检测项**：\n\n';
    for (const row of failedRows) {
      md += `- ❌ \`${row.name}\` → ${row.result}\n`;
    }
  } else {
    md += '_全部通过_\n';
  }
  return md;
}

function analyzeCreepjs(extracted: Record<string, unknown>): string {
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
    md += '**Lies/bold-fail surfaces**（核心反检测指标）：\n\n';
    for (const ls of liesSurfaces) {
      const icon = ls.severity === 'bold-fail' ? '🔴' : '🟠';
      md += `- ${icon} **${ls.surface}** (${ls.severity}) → \`${ls.hash}\`\n`;
    }
    md += '\n';
  }

  if (sections.length > 0) {
    md += '**Sections detected**：\n\n';
    for (const s of sections.slice(0, 20)) {
      md += `- **${s.title}**: ${s.subtitle.slice(0, 100)}\n`;
    }
  }

  return md;
}

function analyzeIphey(extracted: Record<string, unknown>): string {
  const items = (extracted.items as Array<{ name: string; status: string }>) ?? [];
  const passes = (extracted.passes as number) ?? 0;
  const fails = (extracted.fails as number) ?? 0;
  const total = (extracted.total as number) ?? items.length;

  const failedItems = items.filter((i) => i.status === 'fail');

  let md = `**结果**：${passes}/${total} 通过，${fails} 失败\n\n`;
  if (failedItems.length > 0) {
    md += '**失败项**：\n\n';
    for (const item of failedItems.slice(0, 30)) {
      md += `- ❌ ${item.name}\n`;
    }
  } else if (passes > 0) {
    md += '_全部通过_\n';
  } else {
    md += '_⚠️ 解析未识别到检测项 — 可能站点结构变化，需手动看截图_\n';
  }
  return md;
}

function analyzeBrowserleaksGeneric(extracted: Record<string, unknown>): string {
  const pairs = (extracted.pairs as Array<{ name: string; value: string }>) ?? [];
  let md = `**抓到 ${pairs.length} 项 property/value**\n\n`;
  if (pairs.length > 0) {
    md += '<details><summary>展开</summary>\n\n';
    for (const p of pairs.slice(0, 50)) {
      md += `- **${p.name}**: \`${p.value.slice(0, 100)}\`\n`;
    }
    md += '\n</details>\n';
  }
  return md;
}

function analyzeBrowserleaksCanvas(extracted: Record<string, unknown>): string {
  const hash = extracted.canvasHash as string | undefined;
  const uniqueness = extracted.uniqueness as string | undefined;
  let md = `**Canvas Hash**：\`${hash ?? 'N/A'}\`\n\n`;
  md += `**Uniqueness**：${uniqueness ?? 'N/A'}\n\n`;

  // 设计决策：单次 baseline run 无法判断 canvas hash 是「真硬件 hash」还是「persona spoof 后的稳定 hash」。
  // 真正的验证是 **跨 run 的 deterministic seed 对比**（同 persona 应跑出同 hash；不同 persona 应跑出不同 hash）。
  // 这一步留给 Day 2+ 的 `bench/canvas-cross-check.ts`。
  //
  // hit 路由在 scorer.ts:scoreBrowserleaksCanvas；本函数仅负责 markdown 表现。
  md += analyzeBrowserleaksGeneric(extracted);
  return md;
}

function analyzeDbiBot(extracted: Record<string, unknown>): string {
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
    md +=
      '_⚠️ 未解析到任何 `hasXxx/isXxx` 布尔字段；可能页面 DOM 已变化 / Turnstile 拦截 — 看截图_\n';
  } else {
    md += '**触发的信号**：\n\n';
    for (const key of triggered) {
      const route = DBI_KEY_TO_SURFACE[key] ?? {
        surface: 'other' as SurfaceName,
        severity: 'medium' as const,
      };
      const icon = route.severity === 'high' ? '🔴' : route.severity === 'medium' ? '🟡' : '⚪';
      md += `- ${icon} **\`${key}\`** → surface: \`${route.surface}\`\n`;
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
function analyzeAmIUnique(extracted: Record<string, unknown>): string {
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
    md += '_所有属性都在合理常见区间 — 无 outlier 提示_\n';
  } else if (outliers.length > 0) {
    md += '<details><summary>展开 Outlier 详情</summary>\n\n';
    for (const o of outliers.slice(0, 30)) {
      md += `- 🟡 **${o.name}** \`${o.similarityRaw}\` → \`${o.value.slice(0, 80)}\`\n`;
    }
    md += '\n</details>\n';
  }

  if (total === 0) {
    md += '_⚠️ 未解析到属性表；amiunique DOM 结构可能已变化 — 看截图_\n';
  }
  return md;
}

/**
 * Phase 2.5 — Fp-Scanner（arh.antoinevastel.com）— 三态 consistency 检测。
 *
 * Inconsistent = 强 bot 信号（high）。Unsure = 模糊（medium）。Consistent = 通过。
 *
 * Outputs a Markdown table with all rows, and pushes high/medium hits to the
 * surface tracker keyed by the FPSCANNER_TO_SURFACE map; unknown rule names
 * fall back to `surface: 'other'`.
 */
function analyzeAntoinevastel(extracted: Record<string, unknown>): string {
  const rows =
    (extracted.rows as Array<{ name: string; status: string; raw: string }> | undefined) ?? [];
  const total = (extracted.rowsTotal as number | undefined) ?? rows.length;
  const consistent = (extracted.consistent as number | undefined) ?? 0;
  const unsure = (extracted.unsure as number | undefined) ?? 0;
  const inconsistent = (extracted.inconsistent as number | undefined) ?? 0;
  const inconsistentTests = (extracted.inconsistentTests as string[] | undefined) ?? [];
  const unsureTests = (extracted.unsureTests as string[] | undefined) ?? [];

  let md = `**Fp-Scanner 三态结果**：✅ ${consistent} consistent / 🟡 ${unsure} unsure / 🔴 ${inconsistent} inconsistent (total ${total})\n\n`;

  if (total === 0) {
    md +=
      '_⚠️ 未解析到任何 Consistent/Unsure/Inconsistent 行 — 页面 DOM 已变化或加载未完成（看截图）_\n';
    return md;
  }
  if (inconsistent === 0 && unsure === 0) {
    md += `_所有 ${total} 项检测均 Consistent — Fp-Scanner / Datadome detector 通过_ ✅\n`;
    return md;
  }

  const resolveRoute = (testName: string) => {
    // FPSCANNER_TO_SURFACE 的 key 是 SCREAMING_SNAKE_CASE，做 substring + 大小写不敏感匹配
    const upperName = testName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    for (const [rule, route] of Object.entries(FPSCANNER_TO_SURFACE)) {
      if (upperName.includes(rule)) return route;
    }
    return { surface: 'other' as Surface, severity: 'medium' as const };
  };

  // ⚠️ 已知 detector 过时 / spec-incompatible 的规则白名单——single-source-of-truth
  // 在 scorer.ts 的 KNOWN_OUTDATED_FPSCANNER_RULES，本函数仅复用该集合做 markdown 分组。
  if (inconsistent > 0) {
    const reportable: string[] = [];
    const outdated: string[] = [];
    for (const name of inconsistentTests) {
      const upper = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      if (KNOWN_OUTDATED_FPSCANNER_RULES.has(upper)) outdated.push(name);
      else reportable.push(name);
    }

    if (reportable.length > 0) {
      md += '**🔴 Inconsistent（强 bot 信号）**：\n\n';
      for (const name of reportable) {
        const route = resolveRoute(name);
        md += `- 🔴 **\`${name}\`** → surface: \`${route.surface}\`\n`;
      }
      md += '\n';
    }
    if (outdated.length > 0) {
      md += '**ℹ️ 已知过时规则（不入 hits）**：\n\n';
      for (const name of outdated) {
        md += `- ℹ️ **\`${name}\`** — detector 早于 W3C spec 更新，对所有现代 Chrome 用户都报 Inconsistent\n`;
      }
      md += '\n';
    }
  }
  if (unsure > 0) {
    md += '**🟡 Unsure（模糊信号）**：\n\n';
    for (const name of unsureTests) {
      const route = resolveRoute(name);
      md += `- 🟡 **\`${name}\`** → surface: \`${route.surface}\`\n`;
    }
  }
  return md;
}

/**
 * Phase 2.5 — incolumitas (`bot.incolumitas.com`) — 综合 bot detector。
 *
 * 我们的 extractor 抓了所有 `<pre>` 的 JSON 块，并扫了一组已知 bad key（intoli,
 * webdriver, isHeadlessChrome, etc.）。这里把命中的 bad flag 转成 hits。
 *
 * Surface routing：根据 section heading 启发式路由（Browser Fingerprint → navigator，
 * Canvas → canvas，WebGL → webgl，Web Worker → other 等）。
 */
function analyzeIncolumitas(extracted: Record<string, unknown>): string {
  const preSections =
    (extracted.preSections as
      | Array<{ heading: string | null; json: unknown; rawSnippet: string }>
      | undefined) ?? [];
  const triggered =
    (extracted.triggeredBadFlags as
      | Array<{ section: string | null; key: string; value: unknown }>
      | undefined) ?? [];
  const total = (extracted.triggeredBadFlagsCount as number | undefined) ?? triggered.length;
  const botDetectedText = (extracted.botDetectedText as boolean | undefined) ?? false;

  let md = `**Pre-sections 抓取**：${preSections.length} 个 JSON 段\n\n`;
  md += `**红色 bot 信号触发**：${total} 项\n\n`;
  if (botDetectedText) {
    md += `_🔴 页面正文含 "bot detected" / "headless detected" 字样 — 综合判定 bot_\n\n`;
  }

  if (preSections.length === 0) {
    md += '_⚠️ 未抓到任何 `<pre>` JSON 块 — 页面可能未完成异步上报（看截图）_\n';
    return md;
  }
  if (total === 0 && !botDetectedText) {
    md += `_所有已知 bad key 在抓到的 ${preSections.length} 个 section 中均为 false / 缺失 — incolumitas 综合判定通过_ ✅\n`;
    return md;
  }

  const sectionToSurface = (heading: string | null): Surface => {
    if (!heading) return 'other';
    const h = heading.toLowerCase();
    if (h.includes('canvas')) return 'canvas';
    if (h.includes('webgl')) return 'webgl';
    if (h.includes('worker')) return 'other'; // worker scope
    if (h.includes('fingerprint') || h.includes('browser')) return 'navigator';
    if (h.includes('headless')) return 'navigator';
    if (h.includes('proxy') || h.includes('tcp') || h.includes('tls')) return 'other';
    if (h.includes('header')) return 'navigator';
    return 'other';
  };

  if (triggered.length > 0) {
    md += '**触发的红色信号**：\n\n';
    for (const flag of triggered) {
      const surface = sectionToSurface(flag.section);
      md += `- 🔴 **\`${flag.section ?? '?'}.${flag.key}\`** = \`${String(flag.value)}\` → surface: \`${surface}\`\n`;
    }
  }

  // 展开 sections（人工查阅用，不入 hits）
  md += `\n<details><summary>展开 ${preSections.length} 个 section snippet</summary>\n\n`;
  for (const sec of preSections.slice(0, 12)) {
    md += `**${sec.heading ?? '(no heading)'}**:\n\`\`\`\n${sec.rawSnippet.slice(0, 240)}\n\`\`\`\n`;
  }
  md += '\n</details>\n';
  return md;
}

/**
 * Phase 2.5 — fingerprint-scan.com — 0-100 bot risk score。
 *
 * ⚠️ **关键发现**（Phase 3.3 reconnaissance, 2026-05-16）：fingerprint-scan.com 是
 * **Castle.io** 商业反欺诈服务的 marketing demo —— 站点加载
 * `<script src="https://d220g4lrdguk14.cloudfront.net/v3/castle.browser.js">`
 * （Castle 的浏览器 fingerprinter），score 是 Castle.io enterprise 商业黑盒算分
 * 的输出。Reverse 它的 75/100 组成需要逆向 minified Castle JS + 揣摩 server-side
 * weighting，工作量 hours-of-engineering 且即便 reverse 成功也只是 snapshot —
 * Castle 会持续更新算法。
 *
 * 决策：把 fingerprint-scan score≥50 视为**已知商业 detector 限制**（类似 CreepJS
 * WebGL bold-fail / browserleaks-canvas uniqueness），仅显示 ℹ️ note，**不入 hits**。
 * 真正不可绕的 enterprise tier 应当在 chromium-fork 层面解（v0.4+）。普通站点不
 * 使用 Castle，所以不影响主流场景。
 *
 * attrsTotal / 关键字命中等数据仍然抓取并显示，对调试有价值。
 */
function analyzeFingerprintScan(extracted: Record<string, unknown>): string {
  const score = extracted.botRiskScore as number | null | undefined;
  const verdict = extracted.scoreVerdict as string | undefined;
  const sourceText = extracted.scoreSourceText as string | null | undefined;
  const highRisk = (extracted.highRiskHit as boolean | undefined) ?? false;
  const botDetected = (extracted.botDetectedText as boolean | undefined) ?? false;
  const attrsTotal = (extracted.attrsTotal as number | undefined) ?? 0;

  let md = `**Bot Risk Score**：${score ?? 'N/A'} / 100  (verdict: **${verdict ?? 'unknown'}**)\n\n`;
  if (sourceText) md += `_从 "${sourceText.slice(0, 120)}" 中提取_\n\n`;
  md += `**抓到属性**：${attrsTotal} 项\n`;
  md += `**关键字命中**：high-risk=${highRisk ? '✅' : '✗'} / bot-detected=${botDetected ? '✅' : '✗'}\n\n`;

  if (score === null || score === undefined) {
    md += '_⚠️ 未解析到 0-100 风险分 — 页面 DOM 已变化或异步未完成（看截图）_\n';
    return md;
  }

  // Phase 3.3: Castle.io 商业 detector — 不入 hits，仅显示。
  if (verdict === 'bot' || score >= 50) {
    md += `_ℹ️ score=${score} ≥ 50 (verdict=${verdict}) — 由 **Castle.io** 商业 detector 算分。\n`;
    md += 'Castle 是 enterprise 反欺诈服务，黑盒算分 + 持续更新；reverse 工作量极重且不稳定，\n';
    md += '归为已知商业 detector 限制，与 CreepJS WebGL bold-fail / browserleaks-canvas\n';
    md += 'uniqueness 一档（Phase 2.2 + Phase 2.4 known limits）。不入 hits。需要绕过\n';
    md += 'Castle.io 的场景应等 v0.4+ chromium-fork 层面方案。_\n';
    return md;
  }
  if (highRisk || botDetected) {
    md += '_🔴 关键字命中（high-risk 或 bot-detected）→ 判定 bot_\n';
  } else if (verdict === 'suspicious' || score >= 25) {
    md += `_🟡 score=${score} 在 25-49 区间 → 可疑_\n`;
  } else {
    md += `_✅ score=${score} < 25 → 判定 human_\n`;
  }
  if (highRisk && (score ?? 0) < 50) {
    // 关键字命中但 score 偏低 — 警告但不入额外 hit（已计 score-based）
    md += `\n_注：正文含 "high risk" 字样但 score=${score} 偏低，提示 detector 内部信号不一致_\n`;
  }
  return md;
}

/**
 * Pixelscan —— SPA，可能被 Cloudflare 卡住。我们做：
 *   - 若 challenge 触发 → 输出警告 + 不 hit（站点未真正完成检测，结果不可信）。
 *   - 否则按卡片状态出 high (danger) / medium (warning) hit。
 */
function analyzePixelscan(extracted: Record<string, unknown>): string {
  const cards =
    (extracted.cards as Array<{ title: string; status: string; summary: string }> | undefined) ??
    [];
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
    md +=
      '_⚠️ 检测到 Cloudflare / Turnstile 挑战 — pixelscan 未完成扫描，结果不可信。请用 `HEADED=1` 或换干净 IP 重跑。_\n';
    return md;
  }
  if (stillLoading) {
    md += `_⚠️ SPA 仍处于 "Collecting Data..." 状态 — 反爬墙未让 fetch 出 result。请用 \`HEADED=1\` 或换干净 IP 重跑。本次结果跳过 hits 归因。_\n`;
    // 不入 hits：因为根本没拿到检测结果
    if (cards.length > 0) {
      md += `\n<details><summary>展开 ${cards.length} 个白名单卡片（仅观察）</summary>\n\n`;
      for (const c of cards) {
        const icon =
          c.status === 'danger'
            ? '🔴'
            : c.status === 'warning'
              ? '🟡'
              : c.status === 'success'
                ? '✅'
                : '⚪';
        md += `- ${icon} **${c.title}** _(status: ${c.status})_\n`;
      }
      md += '\n</details>\n';
    }
    return md;
  }

  if (cards.length === 0) {
    md += '_⚠️ 未解析到任何核心检测卡片 — SPA 还未渲染完毕或选择器需要更新_\n';
    return md;
  }

  md += `<details><summary>展开 ${cards.length} 个核心卡片详情</summary>\n\n`;
  for (const c of cards) {
    const icon =
      c.status === 'danger'
        ? '🔴'
        : c.status === 'warning'
          ? '🟡'
          : c.status === 'success'
            ? '✅'
            : '⚪';
    md += `- ${icon} **${c.title}** _(status: ${c.status})_\n`;
  }
  md += '\n</details>\n';
  return md;
}

function analyzeBrowserleaksWebgl(
  extracted: Record<string, unknown>,
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

  // hit 路由在 scorer.ts:scoreBrowserleaksWebgl。本函数仅负责 markdown 表现——
  // persona 与实际一致时补上“验证通过” note。
  if (expectedV || expectedR) {
    const actualV = normalizeWebglString(unmaskedV);
    const actualR = normalizeWebglString(unmaskedR);
    const wantV = normalizeWebglString(expectedV);
    const wantR = normalizeWebglString(expectedR);
    const vendorOk = actualV !== '' && wantV !== '' && actualV.includes(wantV);
    const rendererOk = actualR !== '' && wantR !== '' && actualR.includes(wantR);
    if (vendorOk && rendererOk) {
      md += '\n> ✅ **WebGL spoof 验证通过** — unmasked vendor / renderer 与 persona 声称一致\n\n';
    }
  }
  md += analyzeBrowserleaksGeneric(extracted);
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
    throw new Error('bench/results/ 目录不存在；先跑 baseline-detection.ts');
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
  if (dirs.length === 0) throw new Error('bench/results/ 没有子目录；先跑 baseline-detection.ts');
  const first = dirs[0];
  if (!first) throw new Error('bench/results/ 没有子目录；先跑 baseline-detection.ts');
  return first.path;
}

function summarizeSurfacePriority(hits: readonly SurfaceHit[]): string {
  const byCount = new Map<Surface, { high: number; medium: number; low: number; total: number }>();
  for (const h of hits) {
    const cur = byCount.get(h.surface) ?? { high: 0, medium: 0, low: 0, total: 0 };
    cur[h.severity]++;
    cur.total++;
    byCount.set(h.surface, cur);
  }
  // 加权使用 scorer.SEVERITY_WEIGHT 公约（high*3 / medium*1.5 / low*0.5）——
  // 与 types.ts:166 + DetectionScore.weightedHits + desktop UI trend chart 同源。
  const surfaceScore = (e: { high: number; medium: number; low: number }) =>
    e.high * weightHit('high') + e.medium * weightHit('medium') + e.low * weightHit('low');
  const ranked = [...byCount.entries()].sort((a, b) => surfaceScore(b[1]) - surfaceScore(a[1]));

  let md = '| 排名 | Surface | High | Medium | Low | 加权分 | 推荐动作 |\n';
  md += '|---|---|---|---|---|---|---|\n';
  ranked.forEach(([surface, c], i) => {
    const score = surfaceScore(c);
    const action = recommendAction(surface, c);
    md += `| ${i + 1} | **${surface}** | ${c.high} | ${c.medium} | ${c.low} | ${score.toFixed(1)} | ${action} |\n`;
  });
  if (ranked.length === 0)
    md += '| — | — | — | — | — | — | _所有站点未检测到失败项 — 现状已较好_ |\n';
  return md;
}

function recommendAction(
  surface: Surface,
  c: { high: number; medium: number; low: number },
): string {
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

  // ✨ v0.8 Phase 2：委托给 scorer.computeScore。本函数只负责 markdown
  // 渲染，不再推断 / 路由 hits。`score.hits` / `score.weightedHits` /
  // `score.hitsBySurface` 是 single source of truth。
  const score: DetectionScore = computeScore(summary);
  const hits = score.hits;

  let md = '# Mosaiq SDK Baseline Detection Report\n\n';
  md += '> Phase 1 起点基线 — 用于决策第一个补强 surface\n\n';
  md += `**生成时间**：${summary.timestamp}\n\n`;
  md += `**总耗时**：${(summary.overallMs / 1000).toFixed(1)}s\n\n`;
  md += `**Persona 模板**：\`${summary.persona.template}\`\n\n`;
  md += `**站点结果**：${summary.sitesOk}/${summary.sitesAttempted} 成功跑完\n\n`;
  md += `**Detection score**：${score.weightedHits.toFixed(1)} 加权分 / ${hits.length} hits (high×3 + medium×1.5 + low×0.5)\n\n`;
  if ((summary.totalRetries ?? 0) > 0) {
    md += `**重试情况**：${summary.sitesWithRetry ?? 0} 站需要重试，共 ${summary.totalRetries ?? 0} 次重试（Phase 3.2 retry mechanism）\n\n`;
  }
  md += '---\n\n## 各站详情\n\n';

  for (const r of summary.results) {
    md += `### ${r.name} (\`${r.id}\`)\n\n`;
    md += `- URL：${r.url}\n`;
    md += `- 耗时：${r.durationMs}ms\n`;
    md += `- 状态：${r.ok ? '✅ OK' : '❌ FAIL'}\n`;
    if ((r.retries ?? 0) > 0) {
      md += `- 重试：${r.retries} 次（Phase 3.2 retry mechanism）\n`;
    }
    if (r.error) md += `- 错误：\`${r.error}\`\n`;
    if (r.title) md += `- 标题：${r.title}\n`;
    if (r.screenshot) md += `- 截图：[\`${r.screenshot}\`](./${r.screenshot})\n`;
    if (r.html) md += `- HTML：[\`${r.html}\`](./${r.html})\n`;
    md += '\n';

    if (r.ok && r.extracted) {
      switch (r.id) {
        case 'sannysoft':
          md += analyzeSannysoft(r.extracted);
          break;
        case 'creepjs':
          md += analyzeCreepjs(r.extracted);
          break;
        case 'iphey':
          md += analyzeIphey(r.extracted);
          break;
        case 'browserleaks-canvas':
          md += analyzeBrowserleaksCanvas(r.extracted);
          break;
        case 'browserleaks-webgl':
          md += analyzeBrowserleaksWebgl(r.extracted, summary.persona);
          break;
        case 'dbi-bot':
          md += analyzeDbiBot(r.extracted);
          break;
        case 'amiunique':
          md += analyzeAmIUnique(r.extracted);
          break;
        case 'pixelscan':
          md += analyzePixelscan(r.extracted);
          break;
        case 'arh-antoinevastel':
          md += analyzeAntoinevastel(r.extracted);
          break;
        case 'incolumitas':
          md += analyzeIncolumitas(r.extracted);
          break;
        case 'fingerprint-scan':
          md += analyzeFingerprintScan(r.extracted);
          break;
        default:
          md += analyzeBrowserleaksGeneric(r.extracted);
          break;
      }
    }
    md += '\n---\n\n';
  }

  // ── Phase 1 surface 优先级 ────────────────────────────
  md += '## Phase 1 Surface 优先级（基于检测结果归因）\n\n';
  md += summarizeSurfacePriority(hits);
  md += '\n\n';

  // ── 完整 hits 列表 ──────────────────────────────────
  if (hits.length > 0) {
    md += '## 完整失败检测项（按 surface 分组）\n\n';
    const bySurface = new Map<Surface, SurfaceHit[]>();
    for (const h of hits) {
      const arr = bySurface.get(h.surface) ?? [];
      arr.push(h);
      bySurface.set(h.surface, arr);
    }
    for (const [surface, arr] of [...bySurface.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      md += `### \`${surface}\` (${arr.length} 项)\n\n`;
      for (const h of arr.slice(0, 30)) {
        const sevIcon = h.severity === 'high' ? '🔴' : h.severity === 'medium' ? '🟡' : '⚪';
        md += `- ${sevIcon} **\`${h.detector}\`** _(at ${h.site})_ — ${h.evidence}\n`;
      }
      md += '\n';
    }
  }

  // ── 下一步 ──────────────────────────────────────────────────────
  md += '## 下一步\n\n';
  md += `1. 看上面 "Phase 1 Surface 优先级" 表，从加权分最高的 surface 起手\n`;
  md += '2. 写对应模块的 spec.md（参考 `chromium-fork/patches/` 已有草案）\n';
  md += '3. 在 `packages/sdk/src/injection/` 加新模块（或扩展 runner.ts）\n';
  md += '4. 加单测（vitest，目标 ≥ 10 测试）\n';
  md += '5. 重跑 `bench/baseline-detection.ts` 验证通过率提升\n\n';
  md += '如需重新跑：\n\n';
  md +=
    '```bash\npnpm --filter @runova/sdk exec tsx bench/baseline-detection.ts\npnpm --filter @runova/sdk exec tsx bench/report.ts\n```\n';

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
