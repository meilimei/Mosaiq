/**
 * detection-lab/scorer — 把 `DetectionRunRaw`（站点抓回的 extracted 数据）映射到
 * `DetectionScore`（UI dashboard 直接消费的归一化得分 + SurfaceHit[]）。
 *
 * 这是 v0.8 Detection Lab 的"中枢"：runner 输出 raw、scorer 算 score、storage 持
 * 久化、UI 渲染——scorer 是其中**纯计算**的一环（无 IO，无 mutable global state，
 * `computeScore` 是 referentially transparent）。
 *
 * 历史：本模块是从 `bench/report.ts` 抽出的。原 file 把 hits 收集 + metric 提取
 * + markdown 渲染三件事捆在一起（`analyze*` 函数 mutates `hits[]` 并返回 markdown）。
 * 抽出后：
 *   - **scorer.ts**（本文件）= hits 收集 + metric 提取，pure
 *   - **bench/report.ts** = markdown 渲染，调用 `computeScore` 拿分后渲染
 *   - **desktop renderer** = 同样调用 `computeScore`（或读 storage 里持久化的 score）
 *     渲染 dashboard
 *
 * Single source of truth：所有"站点 X 的某个 detector 应入哪个 surface / 什么 severity"
 * 的判定都在本文件，bench 与 desktop 看到完全相同的 hits。
 */

import type {
  DetectionRunRaw,
  DetectionScore,
  HitSeverity,
  HitsBySurface,
  SiteResult,
  SurfaceHit,
  SurfaceName,
} from './types.js';
import { emptyHitsBySurface } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Severity 权重（types.ts:166 公约的 single source of truth）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Severity → trend score 权重。
 *
 * 与 `types.ts` 中 `DetectionScore.weightedHits` 注释定义对齐：
 * `high*3 + medium*1.5 + low*0.5`。这条公约同时被 desktop UI 的 trend chart 使用，
 * 不要单点修改。
 */
export const SEVERITY_WEIGHT: Readonly<Record<HitSeverity, number>> = {
  high: 3,
  medium: 1.5,
  low: 0.5,
};

export function weightHit(severity: HitSeverity): number {
  return SEVERITY_WEIGHT[severity];
}

export function weightedHitsSum(hits: readonly SurfaceHit[]): number {
  let sum = 0;
  for (const h of hits) sum += SEVERITY_WEIGHT[h.severity];
  return sum;
}

// ─────────────────────────────────────────────────────────────────────────────
// Surface 归因
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 关键词 → surface 的映射。键值优先级递减（越靠前越特异）。
 *
 * ⚠️ 与 bench/report.ts 旧版同形（直接迁过来的 single source of truth）。
 */
export const SURFACE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  surface: SurfaceName;
  severity: HitSeverity;
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

/** 把一条 detector + evidence 文本归因到一个 surface。 */
export function attributeSurface(
  detector: string,
  evidence: string,
): { surface: SurfaceName; severity: HitSeverity } {
  const text = `${detector} ${evidence}`.toLowerCase();
  for (const { pattern, surface, severity } of SURFACE_PATTERNS) {
    if (pattern.test(text)) return { surface, severity };
  }
  return { surface: 'other', severity: 'low' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 字符串归一化 / 解析 helper（多个 site scorer 共用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 BrowserLeaks 显示的 "包装值"（含括号注释）剥成核心字符串，便于和 persona
 * 声称值对比。
 *
 * 例：`"NVIDIA Corporation"` → `nvidia corporation`
 */
export function normalizeWebglString(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 解析 BrowserLeaks 的 uniqueness 字符串（如 `"0.01% (1 in 12000)"` 或 `"75.3%"`）
 * → 百分比数值。
 */
export function parseUniquenessPct(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  return m && m[1] ? Number.parseFloat(m[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 站点 specific 路由表
// ─────────────────────────────────────────────────────────────────────────────

/**
 * deviceandbrowserinfo Bot Check —— 把每个布尔信号映射回 surface + severity。
 * 任何 `true` 都意味着 spoof 失败。
 */
export const DBI_KEY_TO_SURFACE: Readonly<
  Record<string, { surface: SurfaceName; severity: HitSeverity }>
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

/**
 * Fp-Scanner（arh.antoinevastel.com / Datadome 开源核心）规则名 → surface + severity。
 *
 * 命名规范：SCREAMING_SNAKE_CASE（Fp-Scanner 内部约定）。匹配是 substring +
 * 大小写不敏感，所以 `WEBDRIVER_NEW` 这种命名也会被前缀匹配上。
 */
export const FPSCANNER_TO_SURFACE: Readonly<
  Record<string, { surface: SurfaceName; severity: HitSeverity }>
> = {
  PHANTOM_UA: { surface: 'navigator', severity: 'high' },
  PHANTOM_PROPERTIES: { surface: 'navigator', severity: 'high' },
  PHANTOM_ETSL: { surface: 'navigator', severity: 'high' },
  PHANTOM_LANGUAGE: { surface: 'navigator', severity: 'high' },
  PHANTOM_WEBSOCKET: { surface: 'other', severity: 'medium' },
  MQ_SCREEN: { surface: 'screen', severity: 'medium' },
  PHANTOM_OVERFLOW: { surface: 'other', severity: 'low' },
  PHANTOM_WINDOW_HEIGHT: { surface: 'screen', severity: 'medium' },
  HEADCHR_UA: { surface: 'navigator', severity: 'high' },
  WEBDRIVER: { surface: 'webdriver', severity: 'high' },
  HEADCHR_CHROME_OBJ: { surface: 'navigator', severity: 'high' },
  HEADCHR_PERMISSIONS: { surface: 'permissions', severity: 'high' },
  HEADCHR_PLUGINS: { surface: 'plugins', severity: 'high' },
  HEADCHR_IFRAME: { surface: 'other', severity: 'medium' },
  CHR_BATTERY: { surface: 'other', severity: 'low' },
  CHR_MEMORY: { surface: 'navigator', severity: 'medium' },
  TRANSPARENT_PIXEL: { surface: 'canvas', severity: 'medium' },
  SEQUENTUM: { surface: 'other', severity: 'medium' },
  VIDEO_CODECS: { surface: 'other', severity: 'low' },
};

/**
 * Fp-Scanner 已知过时 / spec-incompatible 的规则白名单（Phase 3.1 调查结论）。
 *
 * 这些规则对**所有现代 Chrome 用户**都报 Inconsistent —— detector 本身过时，
 * **不是 Mosaiq spoof 的漏洞**。出现在 inconsistentTests 列表里时跳过 hit 记录。
 *
 * - **WEBDRIVER**：fp-scanner (2017) 检 `'webdriver' in navigator`，但 W3C
 *   WebDriver Recommendation (2018+) 强制要求 `navigator.webdriver` 必须存在
 *   （普通用户值是 false，自动化下是 true）。`in` 操作符在两种情况下都返回 true，
 *   所以现代 Chrome 永远 Inconsistent。区分 bot 的是值（我们 spoof = false），
 *   不是存在性。
 */
export const KNOWN_OUTDATED_FPSCANNER_RULES: ReadonlySet<string> = new Set(['WEBDRIVER']);

function normalizeFpScannerRuleName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function resolveFpScannerRoute(testName: string): { surface: SurfaceName; severity: HitSeverity } {
  const upper = normalizeFpScannerRuleName(testName);
  for (const [rule, route] of Object.entries(FPSCANNER_TO_SURFACE)) {
    if (upper.includes(rule)) return route;
  }
  return { surface: 'other', severity: 'medium' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 单站点 partial score 形状
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单站点的部分得分。`metrics` 是 dashboard 头条数字的"site → field"贡献，由
 * `computeScore` 主循环 merge 到最终 `DetectionScore`。
 *
 * 设计原则：每个 site scorer **只负责自己的字段**，不要跨站点累计——累计是
 * `computeScore` 的责任。
 */
export interface SitePartialScore {
  hits: SurfaceHit[];
  metrics: Partial<{
    creepjsLies: number;
    creepjsBoldFail: number;
    sannysoftPass: number;
    sannysoftTotal: number;
    dbiBotFlagsTriggered: number;
    amiuniqueOutliers: number;
    fpScannerInconsistent: number;
    incolumitasBadFlags: number;
  }>;
}

const EMPTY_SITE_SCORE: SitePartialScore = { hits: [], metrics: {} };

// ─────────────────────────────────────────────────────────────────────────────
// 12 个站点 scorer
// ─────────────────────────────────────────────────────────────────────────────

export function scoreSannysoft(extracted: Record<string, unknown>): SitePartialScore {
  const rows = (extracted.rows as Array<{ name: string; result: string; status: string }>) ?? [];
  const passes = (extracted.passes as number) ?? 0;
  const total = (extracted.total as number) ?? rows.length;
  const hits: SurfaceHit[] = [];
  for (const row of rows) {
    if (row.status !== 'fail') continue;
    const { surface, severity } = attributeSurface(row.name, row.result);
    hits.push({
      surface,
      site: 'sannysoft',
      detector: row.name,
      evidence: row.result,
      severity,
    });
  }
  return {
    hits,
    metrics: { sannysoftPass: passes, sannysoftTotal: total },
  };
}

export function scoreCreepjs(extracted: Record<string, unknown>): SitePartialScore {
  const liesCount = (extracted.liesCount as number | null) ?? 0;
  const boldFailCount = (extracted.boldFailCount as number | null) ?? 0;
  const liesSurfaces =
    (extracted.liesSurfaces as Array<{ surface: string; severity: string; hash: string }>) ?? [];
  const hits: SurfaceHit[] = [];
  for (const ls of liesSurfaces) {
    const { surface, severity } = attributeSurface(ls.surface, ls.severity);
    hits.push({
      surface,
      site: 'creepjs',
      detector: `creepjs ${ls.severity}: ${ls.surface}`,
      evidence: `hash=${ls.hash}`,
      severity: ls.severity === 'bold-fail' ? 'high' : severity,
    });
  }
  return {
    hits,
    metrics: { creepjsLies: liesCount, creepjsBoldFail: boldFailCount },
  };
}

export function scoreIphey(extracted: Record<string, unknown>): SitePartialScore {
  const items = (extracted.items as Array<{ name: string; status: string }>) ?? [];
  const hits: SurfaceHit[] = [];
  for (const item of items) {
    if (item.status !== 'fail') continue;
    const { surface, severity } = attributeSurface(item.name, item.name);
    hits.push({
      surface,
      site: 'iphey',
      detector: item.name,
      evidence: 'failed',
      severity,
    });
  }
  return { hits, metrics: {} };
}

export function scoreBrowserleaksCanvas(extracted: Record<string, unknown>): SitePartialScore {
  const hash = extracted.canvasHash as string | undefined;
  const uniqueness = extracted.uniqueness as string | undefined;
  const hits: SurfaceHit[] = [];

  // 设计决策（与 bench/report.ts 旧 analyzeBrowserleaksCanvas 同形）：
  //   - hash 不存在 → 致命（解析失败或 canvas 全黑）→ high hit
  //   - hash 存在 + uniqueness > 50% → noise 不足 / spoof 失败 → medium hit
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
  }
  return { hits, metrics: {} };
}

export function scoreBrowserleaksWebgl(
  extracted: Record<string, unknown>,
  persona: DetectionRunRaw['persona'],
): SitePartialScore {
  const unmaskedV = extracted.unmaskedVendor as string | undefined;
  const unmaskedR = extracted.unmaskedRenderer as string | undefined;
  const expectedV = persona.hardware?.gpu?.webglVendor;
  const expectedR = persona.hardware?.gpu?.webglRenderer;
  const hits: SurfaceHit[] = [];

  // 与旧 analyzeBrowserleaksWebgl 同形的 cross-check：
  //   - persona 无 expected → 只要 unmasked 存在就 hit (no baseline = always suspect)
  //   - expected vs actual 不一致 → 暴露真硬件 → high hit per mismatched 字段
  //   - 一致 → 不 hit（spoof 验证通过）
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
  }
  return { hits, metrics: {} };
}

export function scoreDbiBot(extracted: Record<string, unknown>): SitePartialScore {
  const flags = (extracted.flags as Record<string, boolean> | undefined) ?? {};
  const triggered = (extracted.flagsTriggered as string[] | undefined) ?? [];
  const trueCount = (extracted.flagsTrue as number | undefined) ?? triggered.length;
  const hits: SurfaceHit[] = [];

  // 计算总数依据 flags 而非 triggered，这样在 trueCount === 0 / flags 缺失场景
  // 都能保留旧 bench/report.ts 的"未解析到任何 hasXxx/isXxx"分支语义。
  const total = Object.keys(flags).length;

  // 旧 bench 行为：trueCount === 0 时不 push（spoof 通过）；total === 0 时不 push
  // （DOM 解析失败，避免假阳性）。其他情况按 DBI_KEY_TO_SURFACE 路由。
  if (trueCount > 0 && total > 0) {
    for (const key of triggered) {
      const route = DBI_KEY_TO_SURFACE[key] ?? {
        surface: 'other' as SurfaceName,
        severity: 'medium' as HitSeverity,
      };
      hits.push({
        surface: route.surface,
        site: 'dbi-bot',
        detector: key,
        evidence: 'true',
        severity: route.severity,
      });
    }
  }
  return { hits, metrics: { dbiBotFlagsTriggered: trueCount } };
}

export function scoreAmIUnique(extracted: Record<string, unknown>): SitePartialScore {
  const outliers =
    (extracted.outliers as
      | Array<{ name: string; similarityPct: number | null; similarityRaw: string; value: string }>
      | undefined) ?? [];
  const hits: SurfaceHit[] = [];
  for (const o of outliers) {
    const { surface } = attributeSurface(o.name, o.value);
    hits.push({
      surface,
      site: 'amiunique',
      detector: `amiunique outlier: ${o.name}`,
      evidence: `similarity=${o.similarityRaw} value=${o.value.slice(0, 100)}`,
      severity: 'medium',
    });
  }
  return { hits, metrics: { amiuniqueOutliers: outliers.length } };
}

export function scoreAntoinevastel(extracted: Record<string, unknown>): SitePartialScore {
  const inconsistentTests = (extracted.inconsistentTests as string[] | undefined) ?? [];
  const unsureTests = (extracted.unsureTests as string[] | undefined) ?? [];
  const hits: SurfaceHit[] = [];

  // Inconsistent 行：跳过已知过时规则（KNOWN_OUTDATED_FPSCANNER_RULES），
  // 其余按 FPSCANNER_TO_SURFACE 路由 + severity = 'high'
  let reportableInconsistent = 0;
  for (const name of inconsistentTests) {
    const upper = normalizeFpScannerRuleName(name);
    if (KNOWN_OUTDATED_FPSCANNER_RULES.has(upper)) continue;
    reportableInconsistent++;
    const route = resolveFpScannerRoute(name);
    hits.push({
      surface: route.surface,
      site: 'arh-antoinevastel',
      detector: `fp-scanner inconsistent: ${name}`,
      evidence: 'Inconsistent',
      severity: 'high',
    });
  }
  // Unsure 行：medium（不分过时规则白名单 — 旧 bench 行为）
  for (const name of unsureTests) {
    const route = resolveFpScannerRoute(name);
    hits.push({
      surface: route.surface,
      site: 'arh-antoinevastel',
      detector: `fp-scanner unsure: ${name}`,
      evidence: 'Unsure',
      severity: 'medium',
    });
  }
  return { hits, metrics: { fpScannerInconsistent: reportableInconsistent } };
}

export function scoreIncolumitas(extracted: Record<string, unknown>): SitePartialScore {
  const triggered =
    (extracted.triggeredBadFlags as
      | Array<{ section: string | null; key: string; value: unknown }>
      | undefined) ?? [];
  const hits: SurfaceHit[] = [];

  const sectionToSurface = (heading: string | null): SurfaceName => {
    if (!heading) return 'other';
    const h = heading.toLowerCase();
    if (h.includes('canvas')) return 'canvas';
    if (h.includes('webgl')) return 'webgl';
    if (h.includes('worker')) return 'other';
    if (h.includes('fingerprint') || h.includes('browser')) return 'navigator';
    if (h.includes('headless')) return 'navigator';
    if (h.includes('proxy') || h.includes('tcp') || h.includes('tls')) return 'other';
    if (h.includes('header')) return 'navigator';
    return 'other';
  };

  for (const flag of triggered) {
    const surface = sectionToSurface(flag.section);
    hits.push({
      surface,
      site: 'incolumitas',
      detector: `incolumitas ${flag.section ?? '?'}: ${flag.key}`,
      evidence: String(flag.value),
      severity: 'high',
    });
  }
  return { hits, metrics: { incolumitasBadFlags: triggered.length } };
}

/**
 * fingerprint-scan.com — Castle.io 商业 detector demo。
 *
 * Phase 3.3 决策：score ≥ 50 / verdict === 'bot' 视为已知商业 detector 限制
 * （Castle 黑盒、持续更新），**不入 hits**。仅当：
 *   - score 在 25–49（"suspicious"）→ medium
 *   - 关键字 highRisk / botDetected 命中且 score < 50 → high (canary)
 *
 * 与旧 bench/report.ts 同形。
 */
export function scoreFingerprintScan(extracted: Record<string, unknown>): SitePartialScore {
  const score = extracted.botRiskScore as number | null | undefined;
  const verdict = extracted.scoreVerdict as string | undefined;
  const highRisk = (extracted.highRiskHit as boolean | undefined) ?? false;
  const botDetected = (extracted.botDetectedText as boolean | undefined) ?? false;
  const hits: SurfaceHit[] = [];

  if (score === null || score === undefined) return EMPTY_SITE_SCORE;
  if (verdict === 'bot' || score >= 50) return EMPTY_SITE_SCORE; // Castle.io known-limit

  if (highRisk || botDetected) {
    hits.push({
      surface: 'other',
      site: 'fingerprint-scan',
      detector: `fingerprint-scan keyword`,
      evidence: `score=${score} verdict=${verdict ?? '?'}`,
      severity: 'high',
    });
  } else if (verdict === 'suspicious' || score >= 25) {
    hits.push({
      surface: 'other',
      site: 'fingerprint-scan',
      detector: `fingerprint-scan suspicious score`,
      evidence: `score=${score}`,
      severity: 'medium',
    });
  }
  return { hits, metrics: {} };
}

export function scorePixelscan(extracted: Record<string, unknown>): SitePartialScore {
  const cards =
    (extracted.cards as
      | Array<{ title: string; status: string; summary: string }>
      | undefined) ?? [];
  const challengeDetected = extracted.challengeDetected as boolean | undefined;
  const stillLoading = extracted.stillLoading as boolean | undefined;
  const hits: SurfaceHit[] = [];

  // Cloudflare/Turnstile 卡住 → 跳过 hits（结果不可信）
  if (challengeDetected || stillLoading) return EMPTY_SITE_SCORE;

  for (const c of cards) {
    if (c.status !== 'danger' && c.status !== 'warning') continue;
    const { surface, severity: attrSev } = attributeSurface(c.title, c.summary);
    const sev: HitSeverity =
      c.status === 'danger' ? 'high' : c.status === 'warning' ? 'medium' : attrSev;
    hits.push({
      surface,
      site: 'pixelscan',
      detector: `pixelscan ${c.status}: ${c.title}`,
      evidence: c.summary.slice(0, 200),
      severity: sev,
    });
  }
  return { hits, metrics: {} };
}

/**
 * BrowserLeaks 通用 / browserleaks-js 等没有特异 hit 规则的站点 fallback。
 * 抓 properties 但不入 hits（与旧 analyzeBrowserleaksGeneric 同形：纯展示）。
 */
export function scoreBrowserleaksGeneric(_extracted: Record<string, unknown>): SitePartialScore {
  return EMPTY_SITE_SCORE;
}

// ─────────────────────────────────────────────────────────────────────────────
// 站点 dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把单个 SiteResult 路由到对应 site scorer。
 *
 * - `result.ok === false` 或无 `extracted` → 返回空 partial（站点没跑通就没东西可 score）
 * - 未识别的 site id → fallback `scoreBrowserleaksGeneric`（与旧 generate() 的
 *   default 分支同形）
 */
export function scoreSiteResult(
  result: SiteResult,
  persona: DetectionRunRaw['persona'],
): SitePartialScore {
  if (!result.ok || !result.extracted) return EMPTY_SITE_SCORE;
  const extracted = result.extracted;
  switch (result.id) {
    case 'sannysoft':
      return scoreSannysoft(extracted);
    case 'creepjs':
      return scoreCreepjs(extracted);
    case 'iphey':
      return scoreIphey(extracted);
    case 'browserleaks-canvas':
      return scoreBrowserleaksCanvas(extracted);
    case 'browserleaks-webgl':
      return scoreBrowserleaksWebgl(extracted, persona);
    case 'dbi-bot':
      return scoreDbiBot(extracted);
    case 'amiunique':
      return scoreAmIUnique(extracted);
    case 'pixelscan':
      return scorePixelscan(extracted);
    case 'arh-antoinevastel':
      return scoreAntoinevastel(extracted);
    case 'incolumitas':
      return scoreIncolumitas(extracted);
    case 'fingerprint-scan':
      return scoreFingerprintScan(extracted);
    case 'browserleaks-js':
    default:
      return scoreBrowserleaksGeneric(extracted);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一次 detection run 的原始数据归约成 dashboard 直接消费的 `DetectionScore`。
 *
 * 纯函数 / referentially transparent：相同 raw 永远输出相同 score。`DetectionScore`
 * 是 IPC-transferable POJO，可以缓存 / 持久化 / 跨进程发送。
 */
export function computeScore(raw: DetectionRunRaw): DetectionScore {
  const hits: SurfaceHit[] = [];
  const hitsBySurface: HitsBySurface = emptyHitsBySurface();

  // 累计字段；用 0 初始化保证 dashboard 永不显示 undefined。
  let creepjsLies = 0;
  let creepjsBoldFail = 0;
  let sannysoftPass = 0;
  let sannysoftTotal = 0;
  let dbiBotFlagsTriggered = 0;
  let amiuniqueOutliers = 0;
  let fpScannerInconsistent = 0;
  let incolumitasBadFlags = 0;

  for (const result of raw.results) {
    const partial = scoreSiteResult(result, raw.persona);
    for (const h of partial.hits) {
      hits.push(h);
      hitsBySurface[h.surface] += 1;
    }
    const m = partial.metrics;
    if (m.creepjsLies !== undefined) creepjsLies = m.creepjsLies;
    if (m.creepjsBoldFail !== undefined) creepjsBoldFail = m.creepjsBoldFail;
    if (m.sannysoftPass !== undefined) sannysoftPass = m.sannysoftPass;
    if (m.sannysoftTotal !== undefined) sannysoftTotal = m.sannysoftTotal;
    if (m.dbiBotFlagsTriggered !== undefined) dbiBotFlagsTriggered = m.dbiBotFlagsTriggered;
    if (m.amiuniqueOutliers !== undefined) amiuniqueOutliers = m.amiuniqueOutliers;
    if (m.fpScannerInconsistent !== undefined) fpScannerInconsistent = m.fpScannerInconsistent;
    if (m.incolumitasBadFlags !== undefined) incolumitasBadFlags = m.incolumitasBadFlags;
  }

  return {
    sitesOk: raw.sitesOk,
    sitesFail: raw.sitesFail,
    creepjsLies,
    creepjsBoldFail,
    sannysoftPass,
    sannysoftTotal,
    dbiBotFlagsTriggered,
    amiuniqueOutliers,
    fpScannerInconsistent,
    incolumitasBadFlags,
    weightedHits: weightedHitsSum(hits),
    hits,
    hitsBySurface,
  };
}
