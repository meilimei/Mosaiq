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
