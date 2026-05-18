/**
 * detection-lab/types — Detection Lab 公共契约。
 *
 * 三层抽象：
 *   1. **DetectionRun** — UI 主要消费的高级摘要：每次"运行"的元信息 +
 *      DetectionScore（去重的、稳定的、面向 dashboard 的数字）
 *   2. **DetectionScore** — 头条数字 + SurfaceHit[]（surface 维度的检测失败）
 *   3. **DetectionRunRaw** — 持久化在磁盘 raw.json 里的原始数据，scorer 的输入
 *
 * 设计选择：
 *   - 所有类型都 transferable via IPC（纯 POJO，无 class / function / Date）
 *   - DetectionRun **内嵌** raw（v0.8.0+）：`SiteResult.html` / `screenshot` 是相对
 *     路径字符串、不是文件内容，所以 raw 序列化通常 <100KB。listDetectionRuns
 *     在投影 DetectionRunSummary 时丢 raw，避免 100 个历史 run 一次性占用大量内存
 *   - SurfaceHit 与 bench/report.ts 的 SurfaceHit 同形（scorer 是 bench/report 抽出来的）
 */

import type { Page } from 'playwright-core';

import type { PersonaId } from '@mosaiq/persona-schema';

// ─────────────────────────────────────────────────────────────────────────────
// Surface / Hit
// ─────────────────────────────────────────────────────────────────────────────

/** 反检测维度。与 bench/report.ts 的 Surface 同形。 */
export type SurfaceName =
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

export type HitSeverity = 'high' | 'medium' | 'low';

/** 检测失败项 / 反检测站撒谎信号。 */
export interface SurfaceHit {
  surface: SurfaceName;
  /** 哪个站检测到的（SITES 里的 id） */
  site: string;
  /** 检测项名 */
  detector: string;
  /** 状态文本 / 失败证据 */
  evidence: string;
  /** 严重度：high = 一定要补，medium = 影响中，low = 边缘 */
  severity: HitSeverity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Site spec / result（从原 bench/sites.ts 提升到 SDK）
// ─────────────────────────────────────────────────────────────────────────────

export interface SiteResult {
  /** 站点 id（用作文件名 + 报告 key） */
  id: string;
  /** 显示名 */
  name: string;
  /** url */
  url: string;
  /** 是否成功跑完（false 则 error 字段有值） */
  ok: boolean;
  /** 失败时填写 */
  error?: string;
  /** 跑完耗时（ms） */
  durationMs: number;
  /** 页面标题 */
  title?: string;
  /** 完整 body innerText（可能被截断） */
  bodyText?: string;
  /** 截图相对路径（相对 results dir） */
  screenshot?: string;
  /** 完整 HTML 相对路径（相对 results dir） */
  html?: string;
  /** 站点特异提取的结构化字段（每站不同） */
  extracted?: Record<string, unknown>;
  /** 实际重试次数（0 = 首次成功不需要重试） */
  retries?: number;
}

export interface SiteSpec {
  id: string;
  name: string;
  url: string;
  /** 等页面 settle 的额外秒数 */
  settleMs: number;
  /** page.goto 的 waitUntil 策略 */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  /** 站点特异提取器 */
  extract?: (page: Page) => Promise<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw summary 持久化（raw.json）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每次运行的原始数据，磁盘 raw.json 反序列化结果。
 *
 * 与 bench/report.ts 的 RawSummary 同形，提升为公共类型以便 scorer / report
 * 共享。`persona` 是 snapshot，不引用 Persona 类型本身（避免循环依赖 / 跨包 IPC）。
 */
export interface DetectionRunRaw {
  /** 运行开始时间（ISO） */
  timestamp: string;
  /** 全部站点总耗时（ms） */
  overallMs: number;
  sitesAttempted: number;
  sitesOk: number;
  sitesFail: number;
  /** 有任何 retry 发生的站数（Phase 3.2） */
  sitesWithRetry?: number;
  /** 总 retry 次数 */
  totalRetries?: number;
  /** persona snapshot — scorer 需要 hardware.gpu 来 cross-check WebGL */
  persona: {
    id: string;
    template: string;
    browser: unknown;
    system: unknown;
    hardware?: {
      gpu?: { webglVendor?: string; webglRenderer?: string };
    };
    fingerprint?: unknown;
  };
  results: SiteResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 高级 Score（dashboard 直接消费）
// ─────────────────────────────────────────────────────────────────────────────

/** SurfaceName → 命中数，包含所有 surface（未命中的 = 0），方便 UI 渲染稳定形状的图表。 */
export type HitsBySurface = Record<SurfaceName, number>;

/** UI dashboard 直接消费的归一化得分。 */
export interface DetectionScore {
  /** 站点级 — 跑通几个 / 失败几个 */
  sitesOk: number;
  sitesFail: number;

  /** CreepJS lies hash 数（黄色）+ bold-fail hash 数（红色） */
  creepjsLies: number;
  creepjsBoldFail: number;

  /** sannysoft 通过 / 总数 */
  sannysoftPass: number;
  sannysoftTotal: number;

  /** dbi-bot 触发的 bot 信号数 */
  dbiBotFlagsTriggered: number;

  /** amiunique outlier 属性数（< 0.5% similarity） */
  amiuniqueOutliers: number;

  /** fp-scanner inconsistent 项数（Datadome 系） */
  fpScannerInconsistent: number;

  /** incolumitas 红色 bot 信号触发数 */
  incolumitasBadFlags: number;

  /** 单值 trend metric — weighted hits（high*3 + medium*1.5 + low*0.5）。UI 主画 trend 线用此。 */
  weightedHits: number;

  /** 完整 SurfaceHit 列表 — drill-down 用 */
  hits: SurfaceHit[];

  /** SurfaceName → count，所有 surface 都有 key（0 也保留） */
  hitsBySurface: HitsBySurface;
}

/** 创建空 DetectionScore（所有 surface = 0）。scorer 内部 + UI 默认值用。 */
export function emptyHitsBySurface(): HitsBySurface {
  return {
    canvas: 0,
    webgl: 0,
    audio: 0,
    font: 0,
    webrtc: 0,
    navigator: 0,
    screen: 0,
    permissions: 0,
    timezone: 0,
    plugins: 0,
    webdriver: 0,
    other: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Run lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';

/**
 * UI 列表 / 历史表项主消费类型。
 *
 * 关于 `raw` 字段：
 *   - 完成 run 会内嵌 `raw`（DetectionRunRaw），UI detail 页直接访问
 *     `run.raw.results[]` 渲染 12 站 grid，不再分两次 IPC
 *   - SiteResult 里的 `html` / `screenshot` 是相对路径**字符串**（不是文件内容），
 *     真正的 artifacts 在 `<runtimeRoot>/detection-runs/<personaId>/<runId>/` 下；
 *     所以 raw JSON 序列化后通常 <100KB，IPC clone 成本可接受
 *   - failed run 通常 raw 缺失（runDetection 抛错前没有完整 raw）
 *   - listDetectionRuns 投影出 DetectionRunSummary 时丢弃 raw，避免
 *     100 个历史 run 一次性占用大量内存
 */
export interface DetectionRun {
  /** ISO timestamp folder name，eg `2026-05-17T18-30-00-000Z` */
  id: string;
  personaId: PersonaId;
  /** ISO */
  startedAt: string;
  /** ISO，未完成时 null */
  finishedAt: string | null;
  status: RunStatus;
  /** 实际运行的站点 ids（可能是 SITES 子集，如果 onlySites 被传） */
  sitesAttempted: string[];
  /** 跑完总耗时（ms），未完成时 0 */
  durationMs: number;
  /** 得分。failed/canceled 时可能为 null（部分跑完仍可有 partial score） */
  score: DetectionScore | null;
  /**
   * 原始数据（按站 results / 元信息）。完成 run 必有；failed run 在 runDetection
   * 抛错前若已 build raw 则留下，否则 undefined。
   */
  raw?: DetectionRunRaw;
  /** failed 时填，否则 null */
  error: string | null;
  /** 运行时上下文 */
  meta: {
    sdkVersion: string;
    chromiumVersion?: string;
  };
}

/** 进度事件 — 主进程 emit、渲染进程 listen。 */
export type RunProgressPhase =
  | 'init'
  | 'site-start'
  | 'site-end'
  | 'site-retry'
  | 'done'
  | 'error'
  | 'canceled';

export interface RunProgressEvent {
  /** 哪一次 run 的进度 */
  runId: string;
  personaId: PersonaId;
  phase: RunProgressPhase;
  /** site-start / site-end / site-retry 时填 */
  siteIndex?: number;
  siteId?: string;
  /** site-end 时填 */
  siteOk?: boolean;
  siteDurationMs?: number;
  /** init 时填 */
  totalSites?: number;
  /** site-retry 时填，第几次重试（1-based） */
  retryAttempt?: number;
  /** done 时填，最终 DetectionRun */
  finalRun?: DetectionRun;
  /** error 时填 */
  error?: string;
}
