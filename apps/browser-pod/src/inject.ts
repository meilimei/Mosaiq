/**
 * 服务端反指纹注入（Option A，phase 11.x）。
 *
 * 背景：pod 用 `persona-flags.ts` 只施加**进程级** chromium flag（UA/lang/proxy/
 * window/webdriver-off）。深层 JS-layer 指纹伪装（canvas/WebGL/audio/UA-CH/字体/
 * worker scope）历史上只能靠客户端 `@runova/cloud-sdk` 的 `injectInto()`——意味着
 * 纯 `connectOverCDP`（含 BB-SDK baseURL swap）拿不到深层 stealth。
 *
 * 本模块让 **pod 服务端**也能注入：chromium 起好后，pod 用自带的 playwright-core
 * 连到本机 browser 级 CDP（`waitForCdp` 返回的 ws URL），经
 * `Page.addScriptToEvaluateOnNewDocument` 注册与 desktop / cloud-sdk 相同的
 * `injectAll` 脚本。
 *
 * **禁止**在 `contexts().length === 0` 时 `browser.newContext()`：那会造一个
 * Playwright 私有 context，客户端另一条 `connectOverCDP` 仍走 Chromium 默认
 * context，导致 prod 上 `hardwareConcurrency` 仍是 VM 真值（Fly 上常见 2）。
 *
 * 关键约束：
 *   - **必须保持这条 playwright 连接到 session 结束**——init script 随注册它的
 *     CDP session 存活；`killChromium` 在 SIGTERM chromium 前先 close。
 *   - **fail-soft**：注册失败只 log + 返回 no-op handle，session 照常工作。
 *   - **幂等**：`injectAll` 自带 realm 级幂等守卫，与客户端 `injectInto` 不双注入。
 */

import type { Persona } from '@runova/persona-schema';
import { buildInjectionConfig, injectAll } from '@runova/sdk/injection';
import { type Browser, type BrowserContext, type CDPSession, chromium } from 'playwright-core';

import { getLogger } from './logger.js';

/** 服务端注入句柄：持有 pod 侧 playwright 连接，session 结束时 close。 */
export interface ServerStealthHandle {
  close(): Promise<void>;
}

const NOOP_HANDLE: ServerStealthHandle = { close: async () => undefined };

/**
 * 拿到 Chromium 默认 browser context（不是 Playwright 新建的隔离 context）。
 * 冷启动时 contexts() 可能为空：用临时 page 触发默认 context 物化，再关掉 page。
 */
async function ensureDefaultBrowserContext(
  browser: Browser,
): Promise<BrowserContext> {
  const existing = browser.contexts()[0];
  if (existing) return existing;
  const page = await browser.newPage();
  const ctx = page.context();
  await page.close();
  return ctx;
}

/**
 * 构造与 desktop launcher / cloud-sdk 完全一致的注入脚本字符串：
 *   先 polyfill esbuild 的 `__name` helper，再 IIFE 调 `injectAll(config)`。
 * 必须 string 形式（不能 addInitScript(injectAll, cfg)），否则 esbuild keepNames
 * 注入的 `__name(fn,"name")` 在 chromium init-script world 抛 ReferenceError 让整
 * 个注入静默失效（详见 sdk DEVELOPMENT.md §7）。
 */
export function buildInjectionScript(persona: Persona): string {
  const config = buildInjectionConfig(persona);
  const namePolyfill = 'globalThis.__name=globalThis.__name||function(f){return f};';
  return `${namePolyfill}(${injectAll.toString()})(${JSON.stringify(config)});`;
}

/**
 * 在已启动的 chromium 上注册服务端注入（browser 级，覆盖所有 CDP 客户端）。
 *
 * @param browserWSEndpoint - `waitForCdp` 返回的 `webSocketDebuggerUrl`（browser target）
 * @returns 句柄；调用方在 session 结束时（SIGTERM 前）调 `close()`。失败返回 no-op。
 */
export async function applyServerStealth(opts: {
  browserWSEndpoint: string;
  persona: Persona;
}): Promise<ServerStealthHandle> {
  const log = getLogger();
  let browser: Browser | null = null;
  let cdpSession: CDPSession | null = null;
  const script = buildInjectionScript(opts.persona);

  try {
    browser = await chromium.connectOverCDP(opts.browserWSEndpoint, {
      timeout: 15_000,
      isLocal: true,
    });

    let cdpOk = false;
    try {
      cdpSession = await browser.newBrowserCDPSession();
      await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
      cdpOk = true;
    } catch (cdpErr) {
      log.warn(
        { err: cdpErr instanceof Error ? cdpErr.message : String(cdpErr) },
        'browser CDP addScriptToEvaluateOnNewDocument skipped (non-fatal)',
      );
      if (cdpSession) {
        try {
          await cdpSession.detach();
        } catch {
          // ignore
        }
        cdpSession = null;
      }
    }

    // 主路径：Chromium 默认 context + addInitScript（禁止 browser.newContext()）。
    const defaultCtx = await ensureDefaultBrowserContext(browser);
    await defaultCtx.addInitScript({ content: script });

    const connected = browser;
    const session = cdpSession;
    log.info(
      {
        contexts: connected.contexts().length,
        cdpOk,
      },
      'server-side stealth injection registered',
    );

    return {
      close: async () => {
        if (session) {
          try {
            await session.detach();
          } catch {
            // ignore
          }
        }
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
      'server-side stealth injection failed; session continues with process-level hardening only',
    );
    if (cdpSession) {
      try {
        await cdpSession.detach();
      } catch {
        // ignore
      }
    }
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
