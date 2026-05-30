/**
 * 服务端反指纹注入（Option A，phase 11.x）。
 *
 * 背景：pod 用 `persona-flags.ts` 只施加**进程级** chromium flag（UA/lang/proxy/
 * window/webdriver-off）。深层 JS-layer 指纹伪装（canvas/WebGL/audio/UA-CH/字体/
 * worker scope）历史上只能靠客户端 `@mosaiq/cloud-sdk` 的 `injectInto()`——意味着
 * 纯 `connectOverCDP`（含 BB-SDK baseURL swap）拿不到深层 stealth。
 *
 * 本模块让 **pod 服务端**也能注入：chromium 起好后，pod 用自带的 playwright-core
 * `connectOverCDP` 连到本机 internal CDP，对 default context `addInitScript` 注册
 * 与 desktop launcher / cloud-sdk **完全相同**的 `injectAll` 脚本。实测（probe）
 * 证实：pod 这条连接注册的 init script 能覆盖**客户端另一条 connectOverCDP 创建的
 * 页面**（playwright 的 Target.setAutoAttach + waitForDebuggerOnStart 保证 init
 * script 在文档加载前注册）。
 *
 * 关键约束：
 *   - **必须保持这条 playwright 连接到 session 结束**——`Page.addScriptToEvaluate-
 *     OnNewDocument` 随注册它的 CDP session 存活；连接一断，注册随之失效。
 *     `killChromium` 在 SIGTERM chromium 前先 close 本连接。
 *   - **fail-soft**：注入注册失败只 log + 返回 no-op handle，session 照常工作（退化
 *     为「仅进程级加固」，绝不比现状更差）。
 *   - **幂等**：`injectAll` 自带 realm 级幂等守卫（见 sdk runner.ts），所以即便客户端
 *     仍调 `injectInto()`，同一文档跑两遍也只注入一次。
 */

import type { Persona } from '@runova/persona-schema';
import { buildInjectionConfig, injectAll } from '@runova/sdk/injection';
import { type Browser, chromium } from 'playwright-core';

import { getLogger } from './logger.js';

/** 服务端注入句柄：持有 pod 侧 playwright 连接，session 结束时 close。 */
export interface ServerStealthHandle {
  close(): Promise<void>;
}

const NOOP_HANDLE: ServerStealthHandle = { close: async () => undefined };

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
 * 在已启动的 chromium 上注册服务端注入。
 *
 * @returns 句柄；调用方在 session 结束时（SIGTERM 前）调 `close()`。失败返回 no-op。
 */
export async function applyServerStealth(opts: {
  internalCdpPort: number;
  persona: Persona;
}): Promise<ServerStealthHandle> {
  const log = getLogger();
  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.internalCdpPort}`, {
      timeout: 15_000,
    });
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    await ctx.addInitScript({ content: buildInjectionScript(opts.persona) });
    const connected = browser;
    log.info(
      { contexts: connected.contexts().length },
      'server-side stealth injection registered (pod-side addInitScript)',
    );
    return {
      close: async () => {
        try {
          await connected.close();
        } catch {
          // 断开本就 best-effort；chromium 可能已先死
        }
      },
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'server-side stealth injection failed; session continues with process-level hardening only',
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
