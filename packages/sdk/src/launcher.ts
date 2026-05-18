/**
 * launchPersona(persona, options?) — Mosaiq SDK 的主 API。
 *
 * 启动一个注入了 persona 身份的 Chromium 浏览器：
 *   - 独立 user-data-dir（cookie / localStorage / indexedDB 隔离）
 *   - 代理配置（若 persona.network.proxy 有值）
 *   - CDP init script 注入（navigator / screen / WebGL / Canvas / Audio / Fonts / WebRTC）
 *   - 时区、locale、viewport 与 persona 自洽
 *
 * 兼容性：
 *   - 使用 playwright-core（不自带浏览器），用户需 `npx playwright install chromium`
 *   - 返回的 BrowserSession.context 就是 Playwright BrowserContext，
 *     可直接传给 Stagehand / browser-use 等上层框架
 */

import { type BrowserContext, type LaunchOptions, chromium } from 'playwright-core';

import type { Persona } from '@mosaiq/persona-schema';

import { BrowserSession } from './browser-session.js';
import { getInstalledChromeMajor, getInstalledChromeVersion } from './chromium-version.js';
import { buildInjectionConfig } from './injection/build-config.js';
import { injectAll } from './injection/runner.js';
import { type PathConfig, getUserDataDir } from './paths.js';
import { toPlaywrightProxy } from './proxy.js';
import { buildAcceptLanguage } from './ua.js';

export interface LaunchPersonaOptions extends PathConfig {
  /** 是否以 headless 模式启动。默认 false（桌面使用场景）。 */
  headless?: boolean;
  /** Chromium 额外启动参数。 */
  extraArgs?: string[];
  /** Playwright 可执行文件路径（bundled Chromium 外使用）。 */
  executablePath?: string;
  /** 是否开启 slowMo（毫秒），便于调试。 */
  slowMo?: number;
  /** Viewport override。默认跟随 persona.screen。 */
  viewport?: { width: number; height: number } | null;
}

export async function launchPersona(
  persona: Persona,
  options: LaunchPersonaOptions = {},
): Promise<BrowserSession> {
  const userDataDir = getUserDataDir(persona.metadata.id, options);

  // 把 persona.browser 的版本字段对齐到当前真实安装的 chromium 引擎，避免
  // 模板里硬编码的旧版本与 navigator 真实行为不一致（例如 BrowserScan 会比
  // 对 navigator.userAgent 与 JS feature 推断出的真实版本，mismatch 会被
  // 直接标记为可疑）。persona 持久化文件不会被修改，仅在 launch 进程内覆盖。
  const realFullVersion = getInstalledChromeVersion();
  const realMajor = getInstalledChromeMajor();
  const alignedPersona: Persona = {
    ...persona,
    browser: {
      ...persona.browser,
      majorVersion: realMajor,
      fullVersion: realFullVersion,
      // 显式 userAgent 优先级最高；如果 persona 把它写死了，就尊重用户意图，
      // 否则交给 buildUserAgent() 用 fullVersion 重新拼。
      userAgent: persona.browser.userAgent,
    },
  };
  const injectionConfig = buildInjectionConfig(alignedPersona);

  const args: string[] = [
    // 禁用默认 flags 引起的指纹偏差
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    `--lang=${persona.system.languages[0] ?? 'en-US'}`,
    `--window-size=${persona.system.screen.width},${persona.system.screen.height}`,
    // WebRTC 策略
    ...(persona.fingerprint.webrtc.mode === 'proxy_only'
      ? ['--force-webrtc-ip-handling-policy=default_public_interface_only']
      : []),
    ...(options.extraArgs ?? []),
  ];

  const launchOptions: LaunchOptions & {
    args?: string[];
    proxy?: ReturnType<typeof toPlaywrightProxy>;
  } = {
    headless: options.headless ?? false,
    args,
    slowMo: options.slowMo,
  };

  if (options.executablePath) {
    launchOptions.executablePath = options.executablePath;
  }

  if (persona.network.proxy) {
    launchOptions.proxy = toPlaywrightProxy(persona.network.proxy);
  }

  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    ...launchOptions,
    viewport:
      options.viewport === null
        ? null
        : (options.viewport ?? {
            width: persona.system.screen.width,
            height: persona.system.screen.height,
          }),
    locale: persona.system.locale,
    timezoneId: persona.system.timezone,
    deviceScaleFactor: persona.system.screen.devicePixelRatio,
    userAgent: injectionConfig.userAgent,
    extraHTTPHeaders: {
      'Accept-Language': buildAcceptLanguage(persona),
    },
    colorScheme: 'no-preference',
  });

  // 在每个 page / iframe 加载前注入反检测脚本。
  //
  // ⚠️ 关键：tsx/esbuild 编译 runner.ts 时（keepNames 默认开），会把内部
  //   `function makePrng() {}` / `const foo = function() {}` 这样的命名 / 匿名
  //   函数都包装成 `__name(fn, "name")` 调用以保留 `Function.prototype.name`。
  //   但 chromium init-script world 不自动暴露 esbuild 的 `__name` helper，
  //   导致整个 injectAll 在第一个 `__name(...)` 调用处抛 ReferenceError —
  //   这是 0.1 baseline 中 WebGL/Canvas/Audio 等块全部失效的根因。
  //
  // 必须用 string 形式 addInitScript（callback 形式会让 Playwright 跳过 prepend）
  // 在 injectAll 之前 polyfill `__name = (f) => f`（identity 函数即可，只用于保留 name）。
  const initialPages = context.pages();
  const namePolyfill = 'globalThis.__name=globalThis.__name||function(f){return f};';
  const script = `${namePolyfill}(${injectAll.toString()})(${JSON.stringify(injectionConfig)});`;
  await context.addInitScript({ content: script });
  await context.newPage();
  await Promise.all(initialPages.map((page) => page.close().catch(() => undefined)));

  return new BrowserSession(context, persona);
}
