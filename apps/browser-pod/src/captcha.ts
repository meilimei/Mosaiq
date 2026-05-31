/**
 * 服务端 captcha 自动求解（gap fill phase A）。
 *
 * 背景：LaunchAI「自主发帖、模仿真人」遇到 captcha 时，历史上 Mosaiq 把
 * Browserbase `solveCaptchas` 字段 warn-and-ignore（见 cloud-runtime sessions.ts）。
 * 本模块把求解能力下沉到 pod：session `stealth.solveCaptchas=true` + pod
 * `POD_CAPTCHA_SOLVER=true` 时，pod 用自带 playwright-core 连本机 CDP，监视每个
 * 页面里的 captcha（reCAPTCHA v2/v3 / hCaptcha / Cloudflare Turnstile），命中后调
 * 求解 provider 拿 token，再回填进页面 + 触发常见 callback。
 *
 * 设计与 inject.ts 的 `applyServerStealth` 对齐：
 *   - 复用一条 pod 侧 playwright 连接，session 结束时（SIGTERM 前）close。
 *   - **fail-soft**：任何失败只 log，不抛错，session 照常工作。
 *   - 总开关 + provider gate：未配置 provider/key 时退回「仅观察 + 日志」，
 *     这样可以先在 prod 上量检测命中率，再决定是否接付费 provider。
 *
 * ⚠️ 这是 phase A 的脚手架：检测选择器与 token 回填是 best-effort，覆盖主流站点
 * 的常见嵌入方式，但不保证 100%（站点自定义 callback / 影子 DOM / 多 widget 等
 * 边界后续迭代）。先把链路打通、可观测，再按真实命中数据补强。
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';

import type { Env } from './env.js';
import { getLogger } from './logger.js';

/** 检测到的 captcha 类型。 */
export type CaptchaKind = 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile';

/** 页面里检测到的单个 captcha 挑战。 */
export interface CaptchaChallenge {
  kind: CaptchaKind;
  /** widget 的 site key（provider 求解必需）。 */
  siteKey: string;
  /** captcha 所在页面 URL（provider 求解必需）。 */
  pageUrl: string;
  /** reCAPTCHA v3 的 action（若能探测到）。 */
  action?: string;
}

/** 求解结果 token。 */
export interface CaptchaSolution {
  token: string;
}

/** 求解 provider 抽象。返回 null = 求解失败（watcher 据此放弃本次回填）。 */
export interface CaptchaSolver {
  readonly name: string;
  solve(challenge: CaptchaChallenge, signal: AbortSignal): Promise<CaptchaSolution | null>;
}

/** captcha watcher 句柄：持有 pod 侧 playwright 连接，session 结束时 close。 */
export interface CaptchaWatcherHandle {
  close(): Promise<void>;
}

const NOOP_HANDLE: CaptchaWatcherHandle = { close: async () => undefined };

// ─── 页面侧检测逻辑 ──────────────────────────────────────────────────────────
// 写成**真实函数**（而非内联字符串），既能 node 单测（传 fake doc/location），又能
// 串行化到页面 context 跑（`(${fn})(document, location)`）—— 与 inject.ts 用
// injectAll.toString() 的模式一致。用最小结构化类型避免在 pod（无 DOM lib）里
// 引入整套 DOM 类型。

/** 检测函数只用到的最小 DOM 元素能力。 */
interface DomElementLike {
  getAttribute(name: string): string | null;
}
/** 检测函数只用到的最小 document 能力。 */
interface DomDocumentLike {
  querySelector(sel: string): DomElementLike | null;
  querySelectorAll(sel: string): ArrayLike<DomElementLike>;
}
/** 检测函数只用到的最小 location 能力。 */
interface DomLocationLike {
  href: string;
}

/**
 * 在页面里扫描主流 captcha 的标准嵌入特征。返回首个命中的 challenge（一个页面
 * 通常只有一个），找不到返回 null。
 *
 * 导出供单测；运行时通过 `.toString()` 串行化进 page.evaluate。**不得**引用闭包外
 * 变量（串行化后在页面里没有），所有依赖通过参数传入。
 */
export function detectCaptchaFn(
  doc: DomDocumentLike,
  loc: DomLocationLike,
): CaptchaChallenge | null {
  // Cloudflare Turnstile
  const turnstileEl = doc.querySelector('.cf-turnstile[data-sitekey]');
  if (turnstileEl) {
    return {
      kind: 'turnstile',
      siteKey: turnstileEl.getAttribute('data-sitekey') || '',
      pageUrl: loc.href,
    };
  }
  // hCaptcha
  const hc = doc.querySelector('.h-captcha[data-sitekey], [data-hcaptcha-widget-id]');
  if (hc) {
    const sk = hc.getAttribute('data-sitekey');
    if (sk) return { kind: 'hcaptcha', siteKey: sk, pageUrl: loc.href };
  }
  // reCAPTCHA v2 (checkbox) / v3 (invisible)
  const rc = doc.querySelector('.g-recaptcha[data-sitekey], [data-sitekey].g-recaptcha');
  if (rc) {
    const sk = rc.getAttribute('data-sitekey');
    const action = rc.getAttribute('data-action') || undefined;
    const size = rc.getAttribute('data-size');
    if (sk) {
      return {
        kind: size === 'invisible' ? 'recaptcha_v3' : 'recaptcha_v2',
        siteKey: sk,
        pageUrl: loc.href,
        ...(action ? { action } : {}),
      };
    }
  }
  // 兜底：扫 iframe src 里的 recaptcha / hcaptcha（部分站点不渲染 data-sitekey 容器）
  const frames = Array.from(doc.querySelectorAll('iframe[src]'));
  for (const f of frames) {
    const src = f.getAttribute('src') || '';
    if (src.includes('google.com/recaptcha') || src.includes('recaptcha.net')) {
      const k = src.match(/[?&]k=([^&]+)/)?.[1];
      if (k) return { kind: 'recaptcha_v2', siteKey: decodeURIComponent(k), pageUrl: loc.href };
    }
    if (src.includes('hcaptcha.com')) {
      const k = src.match(/[?&]sitekey=([^&]+)/)?.[1];
      if (k) return { kind: 'hcaptcha', siteKey: decodeURIComponent(k), pageUrl: loc.href };
    }
  }
  return null;
}

// esbuild keepNames（tsx dev 路径）会在串行化函数体里插 `__name(fn,"name")`，页面
// init world 里没有这个 helper 会 ReferenceError 让整段静默失效。前置 polyfill 兜底
// （与 inject.ts 同款手法）。
const NAME_POLYFILL = 'globalThis.__name=globalThis.__name||function(f){return f};';

/** 把一个函数 + 实参表达式拼成 page.evaluate 可直接求值并返回结果的字符串。 */
function buildEvalExpr(fnSource: string, argExprs: string[]): string {
  return `${NAME_POLYFILL}(${fnSource})(${argExprs.join(',')})`;
}

// ─── token 回填脚本 ──────────────────────────────────────────────────────────
// best-effort：写入标准 response 字段并尝试触发常见 callback。站点自定义流程可能
// 需要额外动作，这里覆盖最常见的嵌入方式。
function buildInjectTokenScript(kind: CaptchaKind, token: string): string {
  const t = JSON.stringify(token);
  return `() => {
    const token = ${t};
    const setField = (name) => {
      document.querySelectorAll('textarea[name="' + name + '"], input[name="' + name + '"]').forEach((el) => {
        el.value = token;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    const fireCallback = (globalName) => {
      try {
        const g = window[globalName];
        if (g && typeof g.getResponse === 'function') { /* no-op: response set via field */ }
      } catch {}
    };
    ${
      kind === 'turnstile'
        ? `setField('cf-turnstile-response'); fireCallback('turnstile');`
        : kind === 'hcaptcha'
          ? `setField('h-captcha-response'); setField('g-recaptcha-response'); fireCallback('hcaptcha');`
          : `setField('g-recaptcha-response'); fireCallback('grecaptcha');`
    }
    // 通用：触发 data-callback 指定的全局函数（很多站点用它来 enable 提交按钮）
    const el = document.querySelector('[data-callback]');
    const cbName = el && el.getAttribute('data-callback');
    if (cbName && typeof window[cbName] === 'function') {
      try { window[cbName](token); } catch {}
    }
    return true;
  }`;
}

// ─── CapSolver provider ──────────────────────────────────────────────────────
// token 模式（不做图像点选）：createTask → 轮询 getTaskResult。仅在 provider=
// 'capsolver' 且 api key 非空时构造。失败返回 null（fail-soft）。
export class CapSolverProvider implements CaptchaSolver {
  readonly name = 'capsolver';
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;

  constructor(apiKey: string, timeoutMs: number, pollIntervalMs = 2_000) {
    this.#apiKey = apiKey;
    this.#timeoutMs = timeoutMs;
    this.#pollIntervalMs = pollIntervalMs;
  }

  #taskPayload(challenge: CaptchaChallenge): Record<string, unknown> {
    switch (challenge.kind) {
      case 'turnstile':
        return {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: challenge.pageUrl,
          websiteKey: challenge.siteKey,
        };
      case 'hcaptcha':
        return {
          type: 'HCaptchaTaskProxyLess',
          websiteURL: challenge.pageUrl,
          websiteKey: challenge.siteKey,
        };
      case 'recaptcha_v3':
        return {
          type: 'ReCaptchaV3TaskProxyLess',
          websiteURL: challenge.pageUrl,
          websiteKey: challenge.siteKey,
          pageAction: challenge.action ?? 'verify',
        };
      default:
        // recaptcha_v2（含未知 kind 兜底）
        return {
          type: 'ReCaptchaV2TaskProxyLess',
          websiteURL: challenge.pageUrl,
          websiteKey: challenge.siteKey,
        };
    }
  }

  async solve(challenge: CaptchaChallenge, signal: AbortSignal): Promise<CaptchaSolution | null> {
    const log = getLogger();
    const deadline = Date.now() + this.#timeoutMs;

    let taskId: string;
    try {
      const createResp = await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientKey: this.#apiKey, task: this.#taskPayload(challenge) }),
        signal,
      });
      const created = (await createResp.json().catch(() => null)) as {
        taskId?: string;
        errorId?: number;
        errordescription?: string;
      } | null;
      if (!created || created.errorId || !created.taskId) {
        log.warn(
          { kind: challenge.kind, err: created?.errordescription ?? 'createTask failed' },
          'capsolver createTask did not return a taskId',
        );
        return null;
      }
      taskId = created.taskId;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'capsolver createTask request failed',
      );
      return null;
    }

    // 轮询 getTaskResult 直到 ready / 超时。CapSolver 建议 1-2s 间隔。
    while (Date.now() < deadline) {
      if (signal.aborted) return null;
      await new Promise((r) => setTimeout(r, this.#pollIntervalMs));
      try {
        const resultResp = await fetch('https://api.capsolver.com/getTaskResult', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientKey: this.#apiKey, taskId }),
          signal,
        });
        const result = (await resultResp.json().catch(() => null)) as {
          status?: string;
          errorId?: number;
          solution?: { gRecaptchaResponse?: string; token?: string };
        } | null;
        if (!result || result.errorId) return null;
        if (result.status === 'ready') {
          const token = result.solution?.token ?? result.solution?.gRecaptchaResponse;
          return token ? { token } : null;
        }
        // status === 'processing' → 继续轮询
      } catch (err) {
        if (signal.aborted) return null;
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'capsolver getTaskResult poll error (retrying)',
        );
      }
    }
    log.warn({ kind: challenge.kind }, 'capsolver solve timed out');
    return null;
  }
}

/**
 * 按 env 构造求解 provider。provider='none' 或 key 缺失 → 返回 null（watcher 退回
 * 仅观察）。
 */
export function createCaptchaSolver(env: Env): CaptchaSolver | null {
  if (env.POD_CAPTCHA_PROVIDER === 'capsolver') {
    if (!env.POD_CAPTCHA_API_KEY) return null;
    return new CapSolverProvider(env.POD_CAPTCHA_API_KEY, env.POD_CAPTCHA_TIMEOUT_MS);
  }
  return null;
}

/**
 * 在已启动的 chromium 上挂 captcha watcher（browser 级，覆盖所有页面）。
 *
 * @param browserWSEndpoint - `waitForCdp` 返回的本机 CDP ws URL（同 inject.ts）
 * @returns 句柄；调用方在 session 结束（SIGTERM 前）调 `close()`。失败返回 no-op。
 */
export async function applyCaptchaWatcher(opts: {
  browserWSEndpoint: string;
  env: Env;
  /**
   * 观测回调：'detected' = 首次在某页面命中某 challenge；'solved' = token 成功回填。
   * 用于 pod 侧计数（/healthz）与未来计费的数据基础。绝不能抛错（watcher fail-soft）。
   */
  onEvent?: (event: 'detected' | 'solved', challenge: CaptchaChallenge) => void;
}): Promise<CaptchaWatcherHandle> {
  const log = getLogger();
  const { env, onEvent } = opts;
  const solver = env.POD_CAPTCHA_SOLVER ? createCaptchaSolver(env) : null;

  let browser: Browser | null = null;
  let closed = false;
  const abort = new AbortController();
  // 防止对同一 (page,siteKey) 重复求解：成功/进行中的 challenge 记在这里。
  const inFlight = new Set<string>();

  // onEvent 回调隔离：观测埋点绝不能让 watcher 崩（与整体 fail-soft 一致）。
  function safeEmit(event: 'detected' | 'solved', challenge: CaptchaChallenge): void {
    try {
      onEvent?.(event, challenge);
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'captcha onEvent callback threw (ignored)',
      );
    }
  }

  async function handleChallenge(page: Page, challenge: CaptchaChallenge): Promise<void> {
    const key = `${challenge.kind}:${challenge.siteKey}:${challenge.pageUrl}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    log.info(
      { kind: challenge.kind, pageUrl: challenge.pageUrl, willSolve: Boolean(solver) },
      'captcha detected',
    );
    safeEmit('detected', challenge);
    if (!solver) return; // 仅观察模式：检测命中已记录，留待付费 provider 决策
    try {
      const solution = await solver.solve(challenge, abort.signal);
      if (!solution) {
        log.warn({ kind: challenge.kind }, 'captcha solve returned no token');
        inFlight.delete(key); // 允许下个 poll 重试
        return;
      }
      // Playwright 接受字符串表达式：在页面上下文求值并返回结果。用字符串而非真实
      // 函数，避免在 pod（无 DOM lib）里 TS 校验 window/document。
      await page.evaluate(
        buildEvalExpr(buildInjectTokenScript(challenge.kind, solution.token), []),
      );
      log.info({ kind: challenge.kind, solver: solver.name }, 'captcha token injected');
      safeEmit('solved', challenge);
    } catch (err) {
      log.warn(
        { kind: challenge.kind, err: err instanceof Error ? err.message : String(err) },
        'captcha solve/inject failed (non-fatal)',
      );
      inFlight.delete(key);
    }
  }

  // 每个页面挂一个轮询检测器，页面关闭 / watcher close 时停。
  function watchPage(page: Page): void {
    let timer: NodeJS.Timeout | null = null;
    const tick = async (): Promise<void> => {
      if (closed || page.isClosed()) return;
      try {
        const found = (await page.evaluate(
          buildEvalExpr(detectCaptchaFn.toString(), ['document', 'location']),
        )) as CaptchaChallenge | null;
        if (found?.siteKey) await handleChallenge(page, found);
      } catch {
        // 页面导航中 / context 销毁 → 忽略，下个 tick 再试
      }
      if (!closed && !page.isClosed()) {
        timer = setTimeout(() => void tick(), env.POD_CAPTCHA_POLL_INTERVAL_MS);
      }
    };
    page.once('close', () => {
      if (timer) clearTimeout(timer);
    });
    timer = setTimeout(() => void tick(), env.POD_CAPTCHA_POLL_INTERVAL_MS);
  }

  try {
    browser = await chromium.connectOverCDP(opts.browserWSEndpoint, {
      timeout: 15_000,
      isLocal: true,
    });
    const ctx: BrowserContext | undefined = browser.contexts()[0];
    if (!ctx) {
      // 没有默认 context（不该发生，inject.ts 已物化）→ no-op，避免造隔离 context。
      await browser.close().catch(() => undefined);
      log.warn({}, 'captcha watcher: no default context, skipping');
      return NOOP_HANDLE;
    }
    ctx.on('page', (p) => watchPage(p));
    for (const p of ctx.pages()) watchPage(p);

    const connected = browser;
    log.info(
      { provider: solver?.name ?? 'none', observeOnly: !solver },
      'captcha watcher attached',
    );
    return {
      close: async () => {
        closed = true;
        abort.abort();
        try {
          await connected.close();
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'captcha watcher attach failed; session continues without auto-solve',
    );
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    return NOOP_HANDLE;
  }
}
