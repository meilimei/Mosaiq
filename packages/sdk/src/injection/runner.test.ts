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
