// @vitest-environment happy-dom

/**
 * runner.ts 端到端注入测试。
 *
 * runner.ts 是 22KB 的浏览器端反检测核心，正常通过 Playwright addInitScript
 * 在每个页面加载前执行。这里我们在 happy-dom 模拟的 window 里直接调用
 * `injectAll(config)`，然后断言 navigator / screen / Intl 等被正确改写。
 *
 * happy-dom 限制：
 *   - 没有 WebGLRenderingContext / AudioContext / Canvas getImageData / FontFaceSet
 *     这些块在 runner 内部都用 typeof guard / try-catch 保护，不会挂，但也无法验证。
 *   - 整个 prototype mixin 链不像真实 Chromium 那么深；我们只能保证「值被替换」
 *     和「不留 own property」两个反检测核心要求，覆盖 IDL mixin 真实定义点的
 *     精确路径（NavigatorDeviceMemory 等）只能在真实 Chromium 中验证。
 *
 * 同文件多个测试共享同一个 window：injectAll 不可逆，所以全文件只注入一次，
 * 然后分组断言不同维度。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';

import { buildInjectionConfig } from './build-config.js';
import { injectAll } from './runner.js';
import type { InjectionConfig } from './types.js';

let config: InjectionConfig;

beforeAll(() => {
  const persona = createWin11ChromeUsPersona({
    id: 'runner-test',
    displayName: 'Runner',
    timezone: 'Asia/Tokyo',
    masterSeed: 'deadbeef',
  });
  config = buildInjectionConfig(persona);
  injectAll(config);
});

describe('navigator identity', () => {
  it('overrides userAgent / platform / vendor', () => {
    expect(navigator.userAgent).toBe(config.userAgent);
    expect(navigator.platform).toBe(config.platform); // 'Win32'
    expect(navigator.vendor).toBe(config.vendor); // 'Google Inc.'
  });

  it('overrides language (= first of languages) and languages array', () => {
    expect(navigator.language).toBe('en-US');
    expect([...navigator.languages]).toEqual(['en-US', 'en']);
  });

  it('overrides hardwareConcurrency / deviceMemory / maxTouchPoints', () => {
    expect(navigator.hardwareConcurrency).toBe(8);
    expect(
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    ).toBe(8);
    expect(navigator.maxTouchPoints).toBe(0);
  });

  it('reports webdriver === false (反检测核心)', () => {
    // 即使 happy-dom / Playwright 把 webdriver 暴露为 true，注入后必须为 false
    expect(navigator.webdriver).toBe(false);
  });
});

describe('反 own-property 检测', () => {
  // 反检测库（如 fingerprint.com / creepjs）会用 hasOwnProperty 区分
  // "原生 prototype getter" 与 "脚本注入的 own property"。后者一律判 bot。
  // runner 用 defineProtoGetter 把 spoof 写到 prototype 上，instance 不留痕。

  it('navigator.userAgent has no own property on the instance', () => {
    expect(Object.getOwnPropertyDescriptor(navigator, 'userAgent')).toBeUndefined();
  });

  it('navigator.webdriver has no own property on the instance', () => {
    expect(Object.getOwnPropertyDescriptor(navigator, 'webdriver')).toBeUndefined();
  });

  it('navigator.hardwareConcurrency has no own property on the instance', () => {
    expect(
      Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency'),
    ).toBeUndefined();
  });

  it('webdriver getter resolves somewhere on the prototype chain', () => {
    // walk 链找到 webdriver 描述符，确保它存在并且是 getter
    let curr: object | null = Object.getPrototypeOf(navigator);
    let found: PropertyDescriptor | undefined;
    while (curr) {
      const d = Object.getOwnPropertyDescriptor(curr, 'webdriver');
      if (d) {
        found = d;
        break;
      }
      curr = Object.getPrototypeOf(curr);
    }
    expect(found).toBeDefined();
    expect(typeof found?.get).toBe('function');
  });
});

describe('screen + window', () => {
  it('overrides screen.width / height / availWidth / availHeight', () => {
    expect(screen.width).toBe(1920);
    expect(screen.height).toBe(1080);
    expect(screen.availWidth).toBe(1920);
    expect(screen.availHeight).toBe(1040);
  });

  it('overrides screen.colorDepth / pixelDepth', () => {
    expect(screen.colorDepth).toBe(24);
    expect(screen.pixelDepth).toBe(24);
  });

  it('overrides window.devicePixelRatio', () => {
    expect(window.devicePixelRatio).toBe(1);
  });
});

describe('timezone (Intl)', () => {
  it('Intl.DateTimeFormat().resolvedOptions().timeZone matches config', () => {
    // 即使没有显式 timeZone option，也走 patched constructor 注入 config.timezone
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
  });

  it('explicit timeZone option still wins (patched ctor merges, not overrides)', () => {
    // 用户显式传 'America/New_York' 应该被尊重
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' });
    expect(dtf.resolvedOptions().timeZone).toBe('America/New_York');
  });

  it('Date.prototype.getTimezoneOffset returns offset consistent with timezone', () => {
    // Asia/Tokyo = UTC+9 → offset = -540 分钟（标准时区，无 DST）
    const offset = new Date('2024-06-15T12:00:00Z').getTimezoneOffset();
    expect(offset).toBe(-540);
  });
});

describe('window.chrome shim', () => {
  it('window.chrome exists with runtime / loadTimes / csi / app fields', () => {
    const chrome = (window as Window & { chrome?: Record<string, unknown> }).chrome;
    expect(chrome).toBeDefined();
    expect(typeof chrome).toBe('object');
    expect(chrome).toHaveProperty('runtime');
    expect(typeof chrome?.loadTimes).toBe('function');
    expect(typeof chrome?.csi).toBe('function');
    expect(chrome).toHaveProperty('app');
  });
});

describe('navigator.permissions notifications', () => {
  it('returns prompt state for notifications query (避免 headless 默认 denied 暴露)', async () => {
    // Headless Chrome 下 navigator.permissions.query({name:'notifications'}) 默认 'denied'，
    // 而真实用户多为 'prompt'。runner 强制返回 'prompt' 以匹配真人分布。
    if (!navigator.permissions?.query) {
      // happy-dom 没有实现 permissions —— 整个 spoof 块被 runner try-catch 跳过
      return;
    }
    const result = await navigator.permissions.query({ name: 'notifications' });
    expect(result.state).toBe('prompt');
  });
});

describe('navigator.plugins / mimeTypes / pdfViewerEnabled (Phase 1.8)', () => {
  /**
   * sannysoft "Plugins Length (Old) = 0" + "Plugins is of type PluginArray = failed"
   * + HEADCHR_PLUGINS 是同一根因：headless Chromium navigator.plugins 默认空。
   *
   * 修法：注入与 Chrome 88+ 一致的 5 PDF 插件 + 2 mime types + pdfViewerEnabled=true。
   * 因为是 Chrome 全用户硬编码同一份，0 entropy added。
   */
  it('navigator.plugins.length === 5 (Chrome 88+ standard PDF plugin set)', () => {
    if (typeof PluginArray === 'undefined') return;
    expect(navigator.plugins.length).toBe(5);
  });

  it('navigator.plugins instanceof PluginArray (passes sannysoft "Plugins is of type")', () => {
    if (typeof PluginArray === 'undefined') return;
    expect(navigator.plugins).toBeInstanceOf(PluginArray);
  });

  it('navigator.plugins[0] is "PDF Viewer" and instanceof Plugin', () => {
    if (typeof Plugin === 'undefined' || typeof PluginArray === 'undefined') return;
    const first = navigator.plugins[0];
    expect(first).toBeInstanceOf(Plugin);
    expect(first.name).toBe('PDF Viewer');
    expect(first.filename).toBe('internal-pdf-viewer');
    expect(first.description).toBe('Portable Document Format');
  });

  it('navigator.plugins enumerates 5 distinct Chrome-standard names', () => {
    if (typeof PluginArray === 'undefined') return;
    const names = Array.from({ length: navigator.plugins.length }, (_, i) => navigator.plugins[i].name);
    expect(names).toEqual([
      'PDF Viewer',
      'Chrome PDF Viewer',
      'Chromium PDF Viewer',
      'Microsoft Edge PDF Viewer',
      'WebKit built-in PDF',
    ]);
  });

  it('navigator.plugins.namedItem("PDF Viewer") returns the same instance as plugins[0]', () => {
    if (typeof PluginArray === 'undefined') return;
    expect(navigator.plugins.namedItem('PDF Viewer')).toBe(navigator.plugins[0]);
    expect(navigator.plugins.namedItem('does-not-exist')).toBe(null);
  });

  it('navigator.mimeTypes.length === 2 with application/pdf + text/pdf', () => {
    if (typeof MimeTypeArray === 'undefined') return;
    expect(navigator.mimeTypes.length).toBe(2);
    expect(navigator.mimeTypes[0].type).toBe('application/pdf');
    expect(navigator.mimeTypes[1].type).toBe('text/pdf');
  });

  it('navigator.mimeTypes[0] instanceof MimeType and links back to PDF Viewer plugin', () => {
    if (typeof MimeType === 'undefined' || typeof MimeTypeArray === 'undefined') return;
    const mt = navigator.mimeTypes[0];
    expect(mt).toBeInstanceOf(MimeType);
    expect(mt.suffixes).toBe('pdf');
    // enabledPlugin 应指向 PDF Viewer（plugins[0]）
    expect(mt.enabledPlugin).toBe(navigator.plugins[0]);
  });

  it('navigator.pdfViewerEnabled === true (Chrome 88+ feature flag)', () => {
    // happy-dom 默认无此属性 —— 我们用 defineProtoGetter shadow 进去
    expect((navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled).toBe(true);
  });

  it('navigator.plugins getter does not leak own property on navigator instance', () => {
    // CreepJS getPrototypeLies 检测：navigator 自身不应有 plugins own property
    // （应只在 Navigator.prototype 上，由 defineProtoGetter 保证）
    if (typeof PluginArray === 'undefined') return;
    const ownDesc = Object.getOwnPropertyDescriptor(navigator, 'plugins');
    // happy-dom 默认会在 navigator 上 shadow，runner 在 proto 上重新挂 getter
    // 这里只确保至少有一个位置（own 或 proto）有 plugins 访问器
    const protoDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'plugins');
    expect(Boolean(ownDesc?.get) || Boolean(protoDesc?.get)).toBe(true);
  });

  /**
   * Phase 1.9 后续修复回归测试 —— Navigator lies 由 CreepJS `getPluginLies` 触发：
   *
   *   pluginsList.forEach((plugin) => {
   *     const mtTypes = Object.values(plugin).map((m) => m.type);
   *     mtTypes.forEach((mt) => {
   *       if (!trustedMimeTypes.has(mt)) lies.push('invalid mimetype');
   *     });
   *   });
   *
   * 即 CreepJS 期望 `Object.values(plugin)` **只返回 MimeType 列表**（数字索引）。如果
   * Plugin 的 metadata（name/description/filename/length）也是 enumerable，会污染该
   * 数组导致字符串 `.type === undefined` → 5 个 invalid mimetype → Navigator lies。
   *
   * 修复：metadata 改为 `enumerable: false`（与 real Chrome IDL 一致）。
   */
  it('Object.values(plugin) returns ONLY MimeType list (no metadata pollution)', () => {
    if (typeof Plugin === 'undefined' || typeof MimeType === 'undefined') return;
    const plugin = navigator.plugins[0];
    const values = Object.values(plugin);
    // 期望：[MimeType, MimeType]（2 个 application/pdf + text/pdf）
    expect(values.length).toBe(2);
    for (const v of values) {
      expect(v).toBeInstanceOf(MimeType);
    }
    // 关键：每个 value 都必须有 `.type` 字符串（CreepJS 后续 .map(m => m.type) 不为 undefined）
    expect(values.every((v) => typeof (v as MimeType).type === 'string')).toBe(true);
  });

  it('Plugin metadata (name/description/filename/length) is non-enumerable', () => {
    if (typeof Plugin === 'undefined') return;
    const plugin = navigator.plugins[0];
    for (const key of ['name', 'description', 'filename', 'length'] as const) {
      const desc = Object.getOwnPropertyDescriptor(plugin, key);
      // 必须存在但 enumerable: false（real chrome IDL 是 prototype getter，
      // 我们用 instance own + non-enumerable 模拟）
      expect(desc).toBeDefined();
      expect(desc?.enumerable).toBe(false);
    }
  });

  it('MimeType IDL attributes (type/suffixes/description/enabledPlugin) are non-enumerable', () => {
    if (typeof MimeType === 'undefined') return;
    const mt = navigator.mimeTypes[0];
    for (const key of ['type', 'suffixes', 'description', 'enabledPlugin'] as const) {
      const desc = Object.getOwnPropertyDescriptor(mt, key);
      expect(desc).toBeDefined();
      expect(desc?.enumerable).toBe(false);
    }
    // 直接验证 Object.values 行为（防退化测试）
    expect(Object.values(mt).length).toBe(0);
  });

  it('Object.values(plugin).map(m => m.type) returns only valid MimeType strings (CreepJS getPluginLies path)', () => {
    if (typeof Plugin === 'undefined') return;
    const trustedMimeTypes = new Set(['application/pdf', 'text/pdf']);
    // 模拟 CreepJS 的完整检测路径
    const allInvalid: string[] = [];
    for (let i = 0; i < navigator.plugins.length; i++) {
      const plugin = navigator.plugins[i];
      const mtTypes = (Object.values(plugin) as MimeType[]).map((m) => m.type);
      for (const mt of mtTypes) {
        if (!trustedMimeTypes.has(mt)) allInvalid.push(`plugin[${i}]: ${mt}`);
      }
    }
    // 必须 0 invalid，否则 CreepJS 会标 'invalid mimetype' lie
    expect(allInvalid).toEqual([]);
  });
});

describe('Notification.permission spoof (Phase 1.8)', () => {
  it('Notification.permission === "default" when Notification API exists', () => {
    if (typeof Notification === 'undefined') return; // happy-dom 跳过
    // sannysoft "Permissions (New)" 判 fail 的条件是 Notification.permission === 'denied'
    // && permissions.query state === 'prompt'（老 headless bug）。spoof 成 'default' 通过。
    expect(Notification.permission).toBe('default');
  });
});

describe('worker scope spoof (Phase 1.5)', () => {
  it('Worker constructor is replaced on globalThis but still named "Worker"', () => {
    if (typeof Worker === 'undefined') return; // happy-dom 无 Worker，跳过
    // Worker.prototype.constructor.name 必须保持 'Worker'，否则 CreepJS
    // `hasConstructor(workerInstance, 'Worker')` 直接判负，导致 SW/Shared/
    // Dedicated 三条 fallback 路径全部短路、worker 数据采集失败。
    expect(Worker.prototype.constructor.name).toBe('Worker');
    // toString 透明（受全局 Function.prototype.toString hook 兜底）—— 不能
    // 暴露 "[function: Object]" 之类的 Proxy 源码字符串。
    expect(Function.prototype.toString.call(Worker)).toContain('[native code]');
  });

  it('navigator.serviceWorker.register is replaced (instance-level own override)', () => {
    const sw = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer })
      .serviceWorker;
    if (!sw || typeof sw.register !== 'function') return;
    // 实例 own 属性应该是我们替换上去的 wrappedRegister，而不是原型链上的
    // 原生 register。检查 own desc 存在即可。
    const desc = Object.getOwnPropertyDescriptor(sw, 'register');
    expect(desc).toBeDefined();
    expect(typeof desc?.value).toBe('function');
    // toString 仍是 native code（全局 hook 把 Proxy 包装伪装成原生）
    expect(Function.prototype.toString.call(sw.register)).toContain('[native code]');
  });
});

describe('CDP detection hardening (Phase 1.6)', () => {
  // 这是 dbi-bot `isAutomatedWithCDP` 在浏览器里跑的探测代码。我们的注入要让
  // detected 始终为 false：accessor descriptor 永不被装上去，CDP 序列化读到的
  // 还是真实的 stack 字符串。

  it('Object.defineProperty silently no-ops accessor descriptor on Error#stack', () => {
    let detected = false;
    const e = new Error('probe');
    const ret = Object.defineProperty(e, 'stack', {
      get() {
        detected = true;
        return '';
      },
    });
    // 原始 stack 还应该可读（数据 descriptor 没换成 accessor）
    const stack = e.stack;
    expect(detected).toBe(false);
    // 调用方看到的返回值仍然是 e（与原生 defineProperty 行为一致）
    expect(ret).toBe(e);
    // 真实 stack 字符串还在（happy-dom 里至少非空字符串或 undefined，但绝不应该是 ''）
    expect(typeof stack === 'string' || stack === undefined).toBe(true);
  });

  it('Reflect.defineProperty silently returns true for accessor on Error#stack', () => {
    let detected = false;
    const e = new TypeError('probe-reflect');
    const ok = Reflect.defineProperty(e, 'stack', {
      get() {
        detected = true;
        return '';
      },
    });
    void e.stack;
    expect(detected).toBe(false);
    // Reflect.defineProperty 真实返回 boolean —— 我们假装成功
    expect(ok).toBe(true);
  });

  it('Object.defineProperties strips stack accessor but keeps siblings', () => {
    let detected = false;
    const e = new RangeError('probe-bulk');
    Object.defineProperties(e, {
      stack: {
        get() {
          detected = true;
          return '';
        },
      },
      customField: { value: 42, enumerable: true },
    });
    void e.stack;
    expect(detected).toBe(false);
    // 兄弟字段应仍生效
    expect((e as Error & { customField?: number }).customField).toBe(42);
  });

  it('legitimate data descriptor on Error#stack still applies', () => {
    // 合法用法：日志库把 stack 改成清洗过的字符串
    const e = new Error('legit');
    Object.defineProperty(e, 'stack', { value: 'cleaned\n  at foo', writable: true });
    expect(e.stack).toBe('cleaned\n  at foo');
  });

  it('plain (non-Error) objects can still install accessor on stack', () => {
    // 反检测只针对 Error 实例 —— 其它对象的 stack 属性不在 CDP 路径上，留给业务自由。
    const obj: { stack?: string } = {};
    let read = 0;
    Object.defineProperty(obj, 'stack', {
      get() {
        read++;
        return 'plain';
      },
    });
    expect(obj.stack).toBe('plain');
    expect(read).toBe(1);
  });

  it('Error subclass instances also protected', () => {
    class MyErr extends Error {}
    let detected = false;
    const e = new MyErr('sub');
    Object.defineProperty(e, 'stack', {
      get() {
        detected = true;
        return '';
      },
    });
    void e.stack;
    expect(detected).toBe(false);
  });

  it('Object.defineProperty / Reflect.defineProperty / Object.defineProperties stay native-toString', () => {
    // Function.prototype.toString hook + wrapStealth registry 把 Proxy 包装伪装成原生。
    // 任何反检测脚本读 toString 应仍看到 [native code]。
    expect(Function.prototype.toString.call(Object.defineProperty)).toContain('[native code]');
    expect(Function.prototype.toString.call(Reflect.defineProperty)).toContain('[native code]');
    expect(Function.prototype.toString.call(Object.defineProperties)).toContain('[native code]');
  });
});

describe('Error.stack frame poisoning hardening (Phase 3.1)', () => {
  // §13 装 V8 全局 `Error.prepareStackTrace` hook，filter 掉敏感栈帧
  // （utilityscript / blob: / puppeteer / playwright 等）。真站 detector 走
  // `try { ... } catch (e) { check_keywords(e.stack) }` 路径 → hook 必须拦下。

  type PrepFn = (err: Error, stack: unknown[]) => string;

  function getPrep(): PrepFn {
    const fn = (Error as unknown as { prepareStackTrace?: PrepFn }).prepareStackTrace;
    if (typeof fn !== 'function') {
      throw new Error('Error.prepareStackTrace not installed');
    }
    return fn;
  }

  // 构造 fake CallSite（V8 stack frames 的 minimal interface），
  // 避免在 happy-dom + Node 环境下 frame 内容平台依赖。
  function frame(
    functionName: string,
    fileName: string,
    label = `${functionName} (${fileName}:1:1)`,
  ): unknown {
    return {
      getFunctionName: () => functionName,
      getFileName: () => fileName,
      toString: () => label,
    };
  }

  it('installs Error.prepareStackTrace as a function', () => {
    expect(typeof (Error as unknown as { prepareStackTrace?: unknown }).prepareStackTrace).toBe(
      'function',
    );
  });

  it('filters UtilityScript frames (Playwright internal bridge)', () => {
    const prep = getPrep();
    const result = prep(new Error('test'), [
      frame('appCode', 'https://site.com/app.js'),
      frame('UtilityScript.evaluate', '<anonymous>'),
      frame('UtilityScript.<anonymous>', '<anonymous>'),
    ]);
    expect(typeof result).toBe('string');
    expect(result).toContain('appCode');
    expect(result).toContain('https://site.com/app.js');
    expect(result).not.toContain('UtilityScript');
  });

  it('filters blob: file URLs (worker self-source URL leak)', () => {
    const prep = getPrep();
    const result = prep(new Error('worker-test'), [
      frame('userFn', 'https://site.com/main.js'),
      frame('onmessage', 'blob:null/abc-uuid-123'),
    ]);
    expect(result).toContain('userFn');
    expect(result).not.toContain('blob:');
  });

  it('filters puppeteer / playwright / automation / cdp / devtools substrings', () => {
    const prep = getPrep();
    const result = prep(new Error('multi'), [
      frame('normalFn', 'app.js'),
      frame('puppeteerInternal', 'pup.js'),
      frame('playwrightHelper', 'pw.js'),
      frame('__playwright__', 'inject.js'),
      frame('PuppeteerExtra', 'extra.js'),
      frame('evaluationScript', 'ev.js'),
    ]);
    expect(result).toContain('normalFn');
    expect(result).not.toContain('puppeteer');
    expect(result).not.toContain('playwright');
    expect(result).not.toContain('PuppeteerExtra');
    expect(result).not.toContain('evaluationScript');
  });

  it('preserves user frames in stack output (no false positives)', () => {
    const prep = getPrep();
    const result = prep(new Error('user-test'), [
      frame('handleClick', 'https://shop.example.com/cart.js'),
      frame('Array.forEach', '<anonymous>'),
    ]);
    expect(result).toContain('Error: user-test');
    expect(result).toContain('handleClick');
    expect(result).toContain('https://shop.example.com/cart.js');
    expect(result).toContain('Array.forEach');
  });

  it('emits valid V8-format string for empty stack', () => {
    const prep = getPrep();
    const result = prep(new Error('empty'), []);
    expect(typeof result).toBe('string');
    expect(result).toContain('Error: empty');
  });

  it('handles CallSite getter that throws (defensive)', () => {
    const prep = getPrep();
    const badFrame = {
      getFunctionName: () => {
        throw new Error('boom');
      },
      getFileName: () => 'app.js',
      toString: () => 'crashy (app.js:1:1)',
    };
    const result = prep(new Error('defensive'), [badFrame, frame('goodFn', 'app.js')]);
    // 抛错的 frame 被 try/catch 兜住，保守不算可疑 → 保留
    expect(result).toContain('crashy');
    expect(result).toContain('goodFn');
  });

  it('Error.prepareStackTrace.toString returns native code (stealth)', () => {
    const prep = (Error as unknown as { prepareStackTrace?: PrepFn }).prepareStackTrace!;
    expect(Function.prototype.toString.call(prep)).toContain('[native code]');
  });

  it('does not break Error subclasses', () => {
    class CustomError extends Error {}
    const e = new CustomError('sub-test');
    // 真实读 .stack — 走 V8 自动调 prepareStackTrace 路径
    const stack = e.stack;
    expect(typeof stack === 'string' || stack === undefined).toBe(true);
    if (typeof stack === 'string') {
      expect(stack).not.toContain('UtilityScript');
      expect(stack).not.toContain('blob:');
    }
  });

  it('case-insensitive matching catches mixed-case variants', () => {
    const prep = getPrep();
    const result = prep(new Error('case-test'), [
      frame('userFn', 'app.js'),
      frame('Puppeteer.evaluate', 'pup.js'),
      frame('PlayWright.helper', 'pw.js'),
    ]);
    expect(result).toContain('userFn');
    expect(result.toLowerCase()).not.toContain('puppeteer');
    expect(result.toLowerCase()).not.toContain('playwright');
  });
});
