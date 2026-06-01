/**
 * detection-lab/runner-core — Persona → DetectionRunRaw 执行流的纯壳。
 *
 * Phase 8.3a：把 bench/baseline-detection.ts 里的 runOne / runOneWithRetry / 站点
 * 过滤 / progress 通知 / abort 中断 / 聚合 raw 这些**纯流程**抽出来，让 unit
 * test 不起 Playwright 也能验证 retry 退避、progress 顺序、abort 行为、only/skip 过滤。
 *
 * 真正起 Playwright 的部分（page.goto / waitForLoadState / 截图 / extract）由
 * 8.3b runner.ts 注入；这一层只与 `SiteWorker` 函数接口耦合，不知道
 * page / browser context 的存在。
 *
 * 设计选择：
 *   - `executeRun` 不发终态 progress 事件（'done' / 'canceled' / 'error'）。终态
 *     需要 score / DetectionRun，由 `runDetection`（8.3b）在 executeRun 返回后发。
 *   - 单站 worker 不抛异常；如果它意外抛了，runner-core 兜底转成 `ok:false` SiteResult。
 *   - retry 退避是指数（0 / 1s / 2s / 4s ...），与 bench/baseline-detection.ts 一致。
 *   - sleep / now / isoTimestamp 都可注入，方便测试不真睡 + 时间戳确定。
 */

import type { PersonaId } from '@runova/persona-schema';

import type { DetectionRunRaw, RunProgressEvent, SiteResult, SiteSpec } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 类型契约
// ─────────────────────────────────────────────────────────────────────────────

/** Persona 落盘 snapshot（DetectionRunRaw.persona 同形）。 */
export type PersonaSnapshot = DetectionRunRaw['persona'];

/** 单站执行环境 — worker 收到的不可变上下文。 */
export interface SiteWorkerContext {
  /** 单站 page.goto / waitForLoadState 超时。 */
  timeoutMs: number;
  /** 截图 / HTML 落盘目录；undefined = 不写大 artifact。 */
  artifactDir?: string;
  /** 上层中断信号；worker 应在长操作 await 间隙检查（runner-core 也会在 site 边界检查）。 */
  signal?: AbortSignal;
}

/**
 * 单站 worker — 输入 spec + ctx，输出 SiteResult。
 *
 * 约定：
 *   - 不抛异常；任何失败转成 `{ ok: false, error }`（runner-core 兜底也会处理意外抛出）
 *   - 不调 onProgress（由 executeRun 统一发）
 *   - 不实现 retry（由 executeRun 包装）
 */
export type SiteWorker = (spec: SiteSpec, ctx: SiteWorkerContext) => Promise<SiteResult>;

export interface ExecuteRunOptions {
  /** 写进每个 RunProgressEvent.runId。 */
  runId: string;
  /** 写进每个 RunProgressEvent.personaId。 */
  personaId: PersonaId;
  /** 写进 DetectionRunRaw.persona 的 snapshot；调用方按需构造。 */
  personaSnapshot: PersonaSnapshot;
  /** 站点 id 子集；undefined / 空 = 全部。 */
  only?: readonly string[];
  /** 站点 id 黑名单；与 only 同时存在时 only 先过滤再 skip。 */
  skip?: readonly string[];
  /** 单站超时（ms），默认 60_000。 */
  timeoutMs?: number;
  /** 单站最大重试次数（默认 2，即首次失败后再重试 2 次共 3 attempts）。 */
  maxRetries?: number;
  /** 进度回调；同步调用，runner-core 不 await。 */
  onProgress?: (evt: RunProgressEvent) => void;
  /** 中断信号；触发后剩余站点标 `ok:false, error:'aborted'`。 */
  signal?: AbortSignal;
  /** artifact dir 透传给 worker.ctx；无意义直接落盘，runner-core 不读不写。 */
  artifactDir?: string;
  /** DI: 等待函数（默认基于 setTimeout）；用于测试不真睡。 */
  sleep?: (ms: number) => Promise<void>;
  /** DI: 时间源（默认 Date.now）；用于测试可预测 overallMs。 */
  now?: () => number;
  /** DI: ISO 时间戳生成（默认 new Date().toISOString()）；用于测试可预测 timestamp 字段。 */
  isoTimestamp?: () => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 默认值 / 常量
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
export const BACKOFF_BASE_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按 only / skip 过滤 site specs。
 *   - only 非空：先取 only ∩ sites
 *   - skip 非空：再排除 skip
 *   - 顺序总是保留 sites 原顺序（不依赖 only 顺序）
 *   - only 里有的 id 但 sites 里没有：silently 忽略
 */
export function filterSites(
  sites: readonly SiteSpec[],
  only?: readonly string[],
  skip?: readonly string[],
): SiteSpec[] {
  let filtered: SiteSpec[] = [...sites];
  if (only && only.length > 0) {
    const allow = new Set(only);
    filtered = filtered.filter((s) => allow.has(s.id));
  }
  if (skip && skip.length > 0) {
    const deny = new Set(skip);
    filtered = filtered.filter((s) => !deny.has(s.id));
  }
  return filtered;
}

/**
 * 重试退避调度（attempt 是 1-based attempt index，1 = 首次执行）。
 *
 * attempt=1 → 0      （首次无退避）
 * attempt=2 → 1000ms （第一次重试前等 1s）
 * attempt=3 → 2000ms
 * attempt=4 → 4000ms
 * ...
 */
export function backoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return BACKOFF_BASE_MS * 2 ** (attempt - 2);
}

function abortedResult(spec: SiteSpec): SiteResult {
  return {
    id: spec.id,
    name: spec.name,
    url: spec.url,
    ok: false,
    error: 'aborted',
    durationMs: 0,
  };
}

/**
 * 单站 retry 包装。每次重试前发 site-retry 进度事件（attempt > 1 时）。
 *
 * 约定：
 *   - worker 不应抛异常；若抛了，兜底转成 SiteResult.error
 *   - 收到 abort 信号则立刻中止剩余 attempts，返回 abortedResult
 *   - 返回最后一次 attempt 的 SiteResult，retries 字段记录已发生的重试次数
 */
async function runWithRetry(
  spec: SiteSpec,
  worker: SiteWorker,
  ctx: SiteWorkerContext,
  opts: {
    siteIndex: number;
    runId: string;
    personaId: PersonaId;
    maxRetries: number;
    onProgress?: (evt: RunProgressEvent) => void;
    sleep: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<SiteResult> {
  const maxAttempts = Math.max(1, opts.maxRetries + 1);
  let last: SiteResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      const aborted = abortedResult(spec);
      aborted.retries = attempt - 1;
      return aborted;
    }

    if (attempt > 1) {
      const wait = backoffMs(attempt);
      opts.onProgress?.({
        runId: opts.runId,
        personaId: opts.personaId,
        phase: 'site-retry',
        siteIndex: opts.siteIndex,
        siteId: spec.id,
        retryAttempt: attempt - 1,
      });
      if (wait > 0) await opts.sleep(wait);
      // backoff 期间 abort：立刻返回 aborted，不再调 worker
      if (opts.signal?.aborted) {
        const aborted = abortedResult(spec);
        aborted.retries = attempt - 1;
        return aborted;
      }
    }

    let r: SiteResult;
    try {
      r = await worker(spec, ctx);
    } catch (err) {
      // worker 不该抛——兜底
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      r = {
        id: spec.id,
        name: spec.name,
        url: spec.url,
        ok: false,
        error: message,
        durationMs: 0,
      };
    }
    r.retries = attempt - 1;
    last = r;
    if (r.ok) return r;
  }
  return last as SiteResult; // maxAttempts >= 1 保证 last 非 null
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 主入口 — 顺序跑过滤后的站，发 progress 事件，聚合 DetectionRunRaw。
 *
 * 不起 Playwright；page / context / launchPersona 的耦合都在 worker 闭包里。
 *
 * 进度事件序列（无中断、无重试时）：
 *   1. init                       — totalSites 表明本次跑几个
 *   2. site-start (siteIndex=0)
 *   3. site-end   (siteIndex=0)
 *   4. site-start (siteIndex=1)
 *   5. site-end   (siteIndex=1)
 *   ...
 *
 * 重试时在 site-start 与 site-end 之间插入 `site-retry`（每次重试前一次）。
 * 终态事件（'done' / 'canceled' / 'error'）由调用方在 executeRun 返回后自行发。
 */
export async function executeRun(
  sites: readonly SiteSpec[],
  worker: SiteWorker,
  options: ExecuteRunOptions,
): Promise<DetectionRunRaw> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const isoTimestamp = options.isoTimestamp ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  const filtered = filterSites(sites, options.only, options.skip);
  const overallStart = now();
  const startedAt = isoTimestamp();

  options.onProgress?.({
    runId: options.runId,
    personaId: options.personaId,
    phase: 'init',
    totalSites: filtered.length,
  });

  const results: SiteResult[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const spec = filtered[i] as SiteSpec;

    // 站间 abort：把当前 + 剩余全标 aborted，提前 break。
    if (options.signal?.aborted) {
      for (let j = i; j < filtered.length; j++) {
        results.push(abortedResult(filtered[j] as SiteSpec));
      }
      break;
    }

    options.onProgress?.({
      runId: options.runId,
      personaId: options.personaId,
      phase: 'site-start',
      siteIndex: i,
      siteId: spec.id,
    });

    const r = await runWithRetry(
      spec,
      worker,
      {
        timeoutMs,
        artifactDir: options.artifactDir,
        signal: options.signal,
      },
      {
        siteIndex: i,
        runId: options.runId,
        personaId: options.personaId,
        maxRetries,
        onProgress: options.onProgress,
        sleep,
        signal: options.signal,
      },
    );
    results.push(r);

    options.onProgress?.({
      runId: options.runId,
      personaId: options.personaId,
      phase: 'site-end',
      siteIndex: i,
      siteId: spec.id,
      siteOk: r.ok,
      siteDurationMs: r.durationMs,
    });
  }

  const overallMs = now() - overallStart;
  const sitesOk = results.filter((r) => r.ok).length;
  const sitesFail = results.filter((r) => !r.ok).length;
  const totalRetries = results.reduce((sum, r) => sum + (r.retries ?? 0), 0);
  const sitesWithRetry = results.filter((r) => (r.retries ?? 0) > 0).length;

  return {
    timestamp: startedAt,
    overallMs,
    sitesAttempted: filtered.length,
    sitesOk,
    sitesFail,
    sitesWithRetry,
    totalRetries,
    persona: options.personaSnapshot,
    results,
  };
}
