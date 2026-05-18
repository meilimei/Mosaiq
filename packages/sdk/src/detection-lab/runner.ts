/**
 * detection-lab/runner — `runDetection(persona, options)` 公共 API。
 *
 * Phase 8.3b：把 runner-core（纯壳）和真实 Playwright 操作（goto / settle / 截图 /
 * extract）粘合成 desktop main process 直接可调用的入口。
 *
 * 流程：
 *   1. 生成 runId（如调用方未传）+ mkdir artifactDir（如有）
 *   2. launchPersona 启动注入版 chromium
 *   3. 把 page 闭包成 SiteWorker 注入 executeRun
 *   4. executeRun 顺序跑过滤后的 SITES，发 init / site-* progress 事件
 *   5. 关闭 session（finally 兜底，launch 失败也走）
 *   6. computeScore(raw) 算分
 *   7. 发终态 progress：done / canceled / error
 *   8. 返回 { raw, score }
 *
 * 终态事件语义：
 *   - error  — launchPersona / firstPage 抛异常时；事件 + 抛出，由调用方 catch
 *   - canceled — executeRun 期间 signal.aborted；正常 return（不抛）
 *   - done   — 正常结束；不携带 finalRun（调用方需要 DetectionRun shape 时自构）
 *
 * 测试边界：
 *   - 内部依赖通过 RunDetectionDeps 注入，单测可 mock launchPersona / runOnePage /
 *     fs（不起 Playwright，不真 mkdir）
 *   - 真实 Playwright 集成路径靠 `bench/baseline-detection.ts` 手工跑覆盖
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Persona } from '@mosaiq/persona-schema';
import type { Page } from 'playwright-core';

import type { BrowserSession } from '../browser-session.js';
import { type LaunchPersonaOptions, launchPersona } from '../launcher.js';
import {
  type ExecuteRunOptions,
  type PersonaSnapshot,
  type SiteWorker,
  type SiteWorkerContext,
  executeRun,
} from './runner-core.js';
import { computeScore } from './scorer.js';
import { SITES } from './sites.js';
import type {
  DetectionRunRaw,
  DetectionScore,
  RunProgressEvent,
  SiteResult,
  SiteSpec,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** body innerText 截断阈值；与 bench/baseline-detection.ts 保持一致。 */
const MAX_BODY_TEXT = 50_000;
/** 单站 networkidle 等待上限（settle 后追加，超时吞掉）。 */
const NETWORK_IDLE_TIMEOUT_MS = 5_000;
/** body innerText 抓取超时。 */
const BODY_TEXT_TIMEOUT_MS = 3_000;
/** screenshot fullPage 主路径超时。 */
const SCREENSHOT_FULLPAGE_TIMEOUT_MS = 12_000;
/** screenshot fullPage 失败后 viewport 降级超时。 */
const SCREENSHOT_VIEWPORT_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// 公共类型
// ─────────────────────────────────────────────────────────────────────────────

export interface RunDetectionOptions {
  /** Run 标识；默认 = ISO timestamp 把 `:`/`.` 替换成 `-`。 */
  runId?: string;
  /**
   * 写进 raw.persona.template 的人类可读模板名（如 'win11-chrome-us'）。
   * 默认 'unknown'——Persona schema 不持久化 template 字段，由调用方按需提供。
   */
  personaTemplate?: string;
  /** 站点 id 子集；undefined / 空 = 全部。 */
  only?: readonly string[];
  /** 站点 id 黑名单。和 only 同时存在时 only 先生效然后 skip。 */
  skip?: readonly string[];
  /** 单站超时（ms），默认 60_000。 */
  timeoutMs?: number;
  /** 单站最大重试次数（默认 2）。 */
  maxRetries?: number;
  /** 进度回调；按顺序触发：init → (site-start, site-retry?, site-end)\* → done|canceled|error。 */
  onProgress?: (evt: RunProgressEvent) => void;
  /** 中断信号（用户在 UI cancel）。 */
  signal?: AbortSignal;
  /** 透传给 launchPersona 的选项；默认 { headless: true }。 */
  launchOptions?: LaunchPersonaOptions;
  /**
   * 把 raw screenshot / html 写到哪个目录。
   * undefined = 不存大 artifact，只把 metrics / extracted 留在内存 raw 里。
   * 调用方传值时会 mkdir -p。
   */
  artifactDir?: string;
}

export interface RunDetectionResult {
  /** 写盘的 source of truth；shape 同 bench raw.json。 */
  raw: DetectionRunRaw;
  /** 即时算好的 DetectionScore，避免调用方再 import scorer。 */
  score: DetectionScore;
  /** 实际使用的 runId（无论调用方传与否，统一 echo back）。 */
  runId: string;
}

/**
 * DI 入口 — 测试可注入桩，把真 launchPersona / runOnePage / mkdir 替换掉。
 * 生产调用 `runDetection(persona, options)` 走默认实现。
 */
export interface RunDetectionDeps {
  launch?: (persona: Persona, options?: LaunchPersonaOptions) => Promise<BrowserSession>;
  runOnePage?: (page: Page, spec: SiteSpec, ctx: SiteWorkerContext) => Promise<SiteResult>;
  mkdir?: (dir: string) => void;
  /** DI: ISO 时间戳生成（也用作默认 runId）；测试用。 */
  isoTimestamp?: () => string;
  /** DI: 透传到 executeRun 的 sleep / now / isoTimestamp。 */
  executeRunDeps?: Pick<ExecuteRunOptions, 'sleep' | 'now' | 'isoTimestamp'>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 公共 helper（snapshot）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 Persona 浓缩成 DetectionRunRaw.persona 期望的形状。
 *
 * - `template` 字段 Persona schema 不持久化，由调用方按需提供（默认 'unknown'）。
 * - 返回 `unknown`-typed 字段（browser / system / fingerprint）保留 zod 推断的全
 *   部子键，方便 scorer 做 cross-check（如 hardware.gpu.webglRenderer）。
 */
export function snapshotPersona(persona: Persona, template = 'unknown'): PersonaSnapshot {
  return {
    id: persona.metadata.id,
    template,
    browser: persona.browser,
    system: persona.system,
    hardware: persona.hardware,
    fingerprint: persona.fingerprint,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 默认 SiteWorker — 用真 Playwright Page 跑单站
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单站执行：goto / settle / networkidle / title / body / 可选 artifact 落盘 / extract。
 *
 * 与 bench/baseline-detection.ts:runOne 行为等价，差异：
 *   - 不打印 `[bench]` 日志（runner-core 通过 progress 事件传递状态）
 *   - artifact 落盘改成 ctx.artifactDir 控制（undefined = 跳过 HTML / 截图）
 *   - 不抛异常；任何失败转成 `{ ok:false, error }`（runner-core 兜底也会处理）
 */
export async function runOnePage(
  page: Page,
  spec: SiteSpec,
  ctx: SiteWorkerContext,
): Promise<SiteResult> {
  const start = Date.now();
  const result: SiteResult = {
    id: spec.id,
    name: spec.name,
    url: spec.url,
    ok: false,
    durationMs: 0,
  };

  try {
    // 进入站点前先 honor 中断信号——避免 abort 后还启 goto 浪费 60s timeout
    if (ctx.signal?.aborted) {
      result.error = 'aborted';
      return result;
    }

    await page.goto(spec.url, {
      waitUntil: spec.waitUntil ?? 'domcontentloaded',
      timeout: ctx.timeoutMs,
    });
    // 等额外 settle 时间，让 JS 计算（如 CreepJS）有时间出 trust score
    await page.waitForTimeout(spec.settleMs);
    // networkidle：有些站永远不 idle，吞超时即可
    try {
      await page.waitForLoadState('networkidle', {
        timeout: NETWORK_IDLE_TIMEOUT_MS,
      });
    } catch {
      // 静默
    }

    result.title = await page.title();

    const bodyText = await page
      .locator('body')
      .innerText({ timeout: BODY_TEXT_TIMEOUT_MS })
      .catch(() => '');
    result.bodyText = bodyText.slice(0, MAX_BODY_TEXT);

    if (ctx.artifactDir) {
      // HTML
      try {
        const html = await page.content();
        const htmlPath = `${spec.id}.html`;
        writeFileSync(join(ctx.artifactDir, htmlPath), html, 'utf8');
        result.html = htmlPath;
      } catch {
        // page.content() 偶尔在 navigation race 时失败；不阻断
      }

      // 截图：fullPage 主路径，失败降级 viewport，再失败完全跳过
      const screenshotPath = `${spec.id}.png`;
      try {
        await page.screenshot({
          path: join(ctx.artifactDir, screenshotPath),
          fullPage: true,
          timeout: SCREENSHOT_FULLPAGE_TIMEOUT_MS,
        });
        result.screenshot = screenshotPath;
      } catch {
        try {
          await page.screenshot({
            path: join(ctx.artifactDir, screenshotPath),
            fullPage: false,
            timeout: SCREENSHOT_VIEWPORT_TIMEOUT_MS,
          });
          result.screenshot = screenshotPath;
        } catch {
          // 完全跳过截图，不阻断 extract
        }
      }
    }

    if (spec.extract) {
      try {
        result.extracted = await spec.extract(page);
      } catch (err) {
        result.extracted = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.durationMs = Date.now() - start;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

function defaultRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function defaultMkdir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * 跑一次完整 detection：launch persona → 顺序跑 12 站 → close session → 算分 → 发终态。
 *
 * 入参 deps 留作单测注入；生产调用只传前两个。
 */
export async function runDetection(
  persona: Persona,
  options: RunDetectionOptions = {},
  deps: RunDetectionDeps = {},
): Promise<RunDetectionResult> {
  const launch = deps.launch ?? launchPersona;
  const worker = deps.runOnePage ?? runOnePage;
  const mkdir = deps.mkdir ?? defaultMkdir;
  const isoTimestamp = deps.isoTimestamp ?? (() => new Date().toISOString());

  const runId = options.runId ?? defaultRunId();
  const personaId = persona.metadata.id;
  const personaSnapshot = snapshotPersona(persona, options.personaTemplate ?? 'unknown');

  if (options.artifactDir) {
    mkdir(options.artifactDir);
  }

  let session: BrowserSession | null = null;
  let raw: DetectionRunRaw;

  try {
    session = await launch(persona, options.launchOptions ?? { headless: true });
    const page = await session.firstPage();

    const siteWorker: SiteWorker = (spec, ctx) => worker(page, spec, ctx);

    raw = await executeRun(SITES, siteWorker, {
      runId,
      personaId,
      personaSnapshot,
      only: options.only,
      skip: options.skip,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      onProgress: options.onProgress,
      signal: options.signal,
      artifactDir: options.artifactDir,
      sleep: deps.executeRunDeps?.sleep,
      now: deps.executeRunDeps?.now,
      isoTimestamp: deps.executeRunDeps?.isoTimestamp ?? isoTimestamp,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.onProgress?.({
      runId,
      personaId,
      phase: 'error',
      error: message,
    });
    throw err;
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // session 已被外部关掉
      }
    }
  }

  const score = computeScore(raw);

  // 终态 progress：abort > done。executeRun 不会抛，所以 error phase 只在 launch
  // / firstPage 失败时才发（在上面的 catch 里）。
  if (options.signal?.aborted) {
    options.onProgress?.({
      runId,
      personaId,
      phase: 'canceled',
    });
  } else {
    options.onProgress?.({
      runId,
      personaId,
      phase: 'done',
    });
  }

  return { raw, score, runId };
}
