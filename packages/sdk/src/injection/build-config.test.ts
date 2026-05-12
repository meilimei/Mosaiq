/**
 * build-config.ts 单元测试。
 *
 * buildInjectionConfig 是 Persona schema → 浏览器端 init script 输入参数
 * 之间的纯函数翻译层。它不进浏览器，但每个字段都直接决定一个反检测维度
 * （userAgent / vendor / 噪声种子 / 字体列表 / WebRTC 策略）。
 * 这里的回归保护点都是「曾在排查反检测异常时被怀疑过的字段」。
 */

import { describe, expect, it } from 'vitest';

import { seedToUint32 } from '@mosaiq/persona-schema';
import {
  createMacosSonomaChromeUsPersona,
  createWin11ChromeUsPersona,
} from '@mosaiq/persona-schema/templates';

import { buildInjectionConfig } from './build-config.js';

describe('buildInjectionConfig', () => {
  it('translates Win11 persona end-to-end with all critical surface area', () => {
    const persona = createWin11ChromeUsPersona({ id: 'inj-w', displayName: 'W' });
    const cfg = buildInjectionConfig(persona);

    // Identity
    expect(cfg.userAgent).toContain('Windows NT 10.0; Win64; x64');
    expect(cfg.userAgent).toMatch(/Chrome\/\d+\.\d+\.\d+\.\d+/);
    expect(cfg.platform).toBe('Win32');
    expect(cfg.vendor).toBe('Google Inc.');
    expect(cfg.languages).toEqual(['en-US', 'en']);

    // Hardware
    expect(cfg.hardwareConcurrency).toBe(8);
    expect(cfg.deviceMemory).toBe(8);
    expect(cfg.maxTouchPoints).toBe(0);

    // Screen
    expect(cfg.screen).toEqual({
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: 1,
    });

    // Timezone
    expect(cfg.timezone).toBe('America/New_York');

    // GPU
    expect(cfg.webglVendor).toBe('Google Inc. (Intel)');
    expect(cfg.webglRenderer).toContain('ANGLE');

    // Audio
    expect(cfg.audioSampleRate).toBe(48000);
    expect(cfg.audioOutputLatency).toBe(0.01);
    expect(cfg.audioInputDevices).toBe(1);
    expect(cfg.audioOutputDevices).toBe(1);

    // Fonts
    expect(cfg.fontList.length).toBeGreaterThan(10);
    expect(cfg.fontList).toContain('Arial');

    // WebRTC
    expect(cfg.webrtcMode).toBe('proxy_only');
  });

  it('translates macOS Sonoma persona with retina DPR and Apple GPU', () => {
    const persona = createMacosSonomaChromeUsPersona({ id: 'inj-m', displayName: 'M' });
    const cfg = buildInjectionConfig(persona);

    expect(cfg.platform).toBe('MacIntel');
    expect(cfg.screen.devicePixelRatio).toBe(2);
    expect(cfg.screen.colorDepth).toBe(30);
    expect(cfg.timezone).toBe('America/Los_Angeles');
    expect(cfg.webglRenderer).toContain('Apple M2');
  });

  describe('userAgent priority', () => {
    it('uses explicit persona.browser.userAgent when set (override wins)', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-ua-1', displayName: 'X' });
      const custom = 'Mozilla/5.0 (custom-injected-via-edit-page)';
      const cfg = buildInjectionConfig({
        ...persona,
        browser: { ...persona.browser, userAgent: custom },
      });
      expect(cfg.userAgent).toBe(custom);
    });

    it('falls back to buildUserAgent() when userAgent unset', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-ua-2', displayName: 'X' });
      const cfg = buildInjectionConfig(persona);
      // 派生出来的 UA 严格符合 Chrome on Win64 形态
      expect(cfg.userAgent).toMatch(
        /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.\d+\.\d+\.\d+ Safari\/537\.36$/,
      );
    });
  });

  describe('appVersion', () => {
    it('strips leading Mozilla/ from userAgent', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-av', displayName: 'X' });
      const cfg = buildInjectionConfig(persona);
      expect(cfg.appVersion.startsWith('Mozilla/')).toBe(false);
      expect(cfg.appVersion).toBe(cfg.userAgent.slice('Mozilla/'.length));
    });
  });

  describe('vendor', () => {
    it('returns "Google Inc." for Chrome', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-v1', displayName: 'X' });
      expect(buildInjectionConfig(persona).vendor).toBe('Google Inc.');
    });

    it('returns empty string for Firefox (Mozilla-family quirk)', () => {
      // Firefox 必须显式提供 UA —— 否则 buildUserAgent 会在 v0.1 抛。
      // 这个分支是为未来 Firefox persona 预留的；测试锁定 vendor 行为，
      // 防止后续误把它写成 'Mozilla' 之类反 Firefox 的真实输出。
      const persona = createWin11ChromeUsPersona({ id: 'inj-v2', displayName: 'X' });
      const ffPersona = {
        ...persona,
        browser: {
          ...persona.browser,
          brand: 'firefox' as const,
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
        },
      };
      expect(buildInjectionConfig(ffPersona).vendor).toBe('');
    });
  });

  describe('fingerprint seeds', () => {
    it('converts hex noise seeds to Uint32 numbers (not raw hex strings)', () => {
      const persona = createWin11ChromeUsPersona({
        id: 'inj-seed-1',
        displayName: 'X',
        masterSeed: 'deadbeef',
      });
      const cfg = buildInjectionConfig(persona);

      // 注入端 makePrng 期望 number；如果错误地把 hex 字符串透传过去，
      // PRNG 全坏，所有 noise 失效。
      expect(typeof cfg.canvasNoiseSeed).toBe('number');
      expect(typeof cfg.webglNoiseSeed).toBe('number');
      expect(typeof cfg.audioNoiseSeed).toBe('number');

      // 范围必须是 unsigned 32-bit
      for (const seed of [cfg.canvasNoiseSeed, cfg.webglNoiseSeed, cfg.audioNoiseSeed]) {
        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThan(2 ** 32);
      }

      // 转换契约必须严格等价于 seedToUint32（同一函数链上下游）
      expect(cfg.canvasNoiseSeed).toBe(seedToUint32(persona.fingerprint.canvas.noiseSeed));
      expect(cfg.webglNoiseSeed).toBe(seedToUint32(persona.fingerprint.webgl.noiseSeed));
      expect(cfg.audioNoiseSeed).toBe(seedToUint32(persona.fingerprint.audio.noiseSeed));
    });

    it('is reproducible across personas sharing the same masterSeed', () => {
      // 两个 persona id 不同但 masterSeed 相同 → 噪声 seed 完全一致。
      // 这是 cloneable persona 的反检测一致性基础。
      const a = createWin11ChromeUsPersona({ id: 'a', displayName: 'A', masterSeed: 'cafebabe' });
      const b = createWin11ChromeUsPersona({ id: 'b', displayName: 'B', masterSeed: 'cafebabe' });
      const cfgA = buildInjectionConfig(a);
      const cfgB = buildInjectionConfig(b);

      expect(cfgA.canvasNoiseSeed).toBe(cfgB.canvasNoiseSeed);
      expect(cfgA.webglNoiseSeed).toBe(cfgB.webglNoiseSeed);
      expect(cfgA.audioNoiseSeed).toBe(cfgB.audioNoiseSeed);
    });

    it('propagates noise strength / amplitude / readPixels flag verbatim', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-seed-3', displayName: 'X' });
      const cfg = buildInjectionConfig(persona);
      expect(cfg.canvasNoiseStrength).toBe(persona.fingerprint.canvas.noiseStrength);
      expect(cfg.audioNoiseAmplitude).toBe(persona.fingerprint.audio.noiseAmplitude);
      expect(cfg.webglPerturbReadPixels).toBe(persona.fingerprint.webgl.perturbReadPixels);
    });
  });

  describe('webrtcMode', () => {
    it('passes through persona.fingerprint.webrtc.mode unchanged', () => {
      const base = createWin11ChromeUsPersona({ id: 'inj-rtc', displayName: 'X' });
      // default 是 proxy_only
      expect(buildInjectionConfig(base).webrtcMode).toBe('proxy_only');

      // 切到 disabled
      const disabled = {
        ...base,
        fingerprint: { ...base.fingerprint, webrtc: { mode: 'disabled' as const } },
      };
      expect(buildInjectionConfig(disabled).webrtcMode).toBe('disabled');
    });
  });

  describe('fonts', () => {
    it('propagates persona font list verbatim and order-stable', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-fonts', displayName: 'X' });
      expect(buildInjectionConfig(persona).fontList).toEqual(persona.fingerprint.fontList.fonts);
    });
  });
});
