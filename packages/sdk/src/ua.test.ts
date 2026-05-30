/**
 * ua.ts 单元测试。
 *
 * UA 字符串和 Accept-Language 是反检测层最暴露的两个 header：
 *   - 跟模板声称的 OS / 浏览器版本不一致 = 直接 robot
 *   - q 值递减格式不规范 = Chrome 用户里几乎不存在的边缘 pattern
 *
 * 用 persona-schema 模板生成 fixture，再针对个别字段在内存里改写以覆盖
 * Linux / 非 Chrome / 不支持 family 的分支。
 */

import { describe, expect, it } from 'vitest';

import type { Persona } from '@runova/persona-schema';
import {
  createMacosSonomaChromeUsPersona,
  createWin11ChromeUsPersona,
} from '@runova/persona-schema/templates';

import { buildAcceptLanguage, buildUserAgent } from './ua.js';

function win11(): Persona {
  return createWin11ChromeUsPersona({ id: 'ua-win', displayName: 'W' });
}

function macSonoma(): Persona {
  return createMacosSonomaChromeUsPersona({ id: 'ua-mac', displayName: 'M' });
}

describe('buildUserAgent', () => {
  it('builds Windows + Chrome UA with Win64;x64 token', () => {
    const ua = buildUserAgent(win11());
    expect(ua).toContain('Windows NT 10.0; Win64; x64');
    expect(ua).toContain('Chrome/130.0.6723.117 Safari/537.36');
    // 必须以 Mozilla/5.0 开头（任何不以此开头的 Chrome UA 都会被多数 WAF 直接判 bot）
    expect(ua.startsWith('Mozilla/5.0 ')).toBe(true);
  });

  it('builds macOS UA with Macintosh; Intel Mac OS X token', () => {
    const ua = buildUserAgent(macSonoma());
    // 真 Chrome 在 macOS 上仍然报 "Macintosh; Intel Mac OS X 10_15_*"（Apple 冻结了这个段）
    expect(ua).toContain('Macintosh; Intel Mac OS X');
    expect(ua).toContain('Chrome/130');
  });

  it('builds Linux UA with X11; Linux x86_64 token', () => {
    const persona = win11();
    const linuxPersona: Persona = {
      ...persona,
      system: {
        ...persona.system,
        os: { family: 'linux', version: '6.5.0', arch: 'x86_64', platformLabel: 'Linux x86_64' },
      },
    };
    expect(buildUserAgent(linuxPersona)).toContain('X11; Linux x86_64');
  });

  it('throws on non-chrome brand (v0.1 has not implemented Firefox/Safari UA)', () => {
    const persona = win11();
    const ffPersona = {
      ...persona,
      browser: { ...persona.browser, brand: 'firefox' as Persona['browser']['brand'] },
    };
    expect(() => buildUserAgent(ffPersona)).toThrow(/only supports Chrome/);
  });

  it('throws on unsupported OS family', () => {
    const persona = win11();
    const aliens: Persona = {
      ...persona,
      system: {
        ...persona.system,
        os: { ...persona.system.os, family: 'android' as Persona['system']['os']['family'] },
      },
    };
    expect(() => buildUserAgent(aliens)).toThrow(/Unsupported OS family/);
  });
});

describe('buildAcceptLanguage', () => {
  it('returns single language as-is (no q-suffix needed)', () => {
    const persona = win11();
    const out = buildAcceptLanguage({
      ...persona,
      system: { ...persona.system, languages: ['en-US'] },
    });
    expect(out).toBe('en-US');
  });

  it('appends descending q values starting from 0.9', () => {
    const persona = win11();
    expect(
      buildAcceptLanguage({
        ...persona,
        system: { ...persona.system, languages: ['en-US', 'en'] },
      }),
    ).toBe('en-US,en;q=0.9');
  });

  it('keeps q decreasing by 0.1 across multiple langs', () => {
    const persona = win11();
    expect(
      buildAcceptLanguage({
        ...persona,
        system: { ...persona.system, languages: ['zh-CN', 'zh', 'en-US', 'en'] },
      }),
    ).toBe('zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');
  });
});
