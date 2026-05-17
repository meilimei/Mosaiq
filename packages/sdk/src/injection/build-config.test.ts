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
  createUbuntu2204ChromeUsPersona,
  createWin10ChromeUsPersona,
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
      // Phase 5.1: 独立 dB 域 amplitude 字段
      expect(cfg.audioNoiseAmplitudeDb).toBe(persona.fingerprint.audio.noiseAmplitudeDb);
      expect(cfg.audioNoiseAmplitudeDb).toBeGreaterThan(0);
      expect(cfg.audioNoiseAmplitudeDb).toBeLessThanOrEqual(5);
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

  describe('webglProfile (Phase 1.9)', () => {
    /**
     * Phase 1.9：build-config 按 persona.gpu.webglRenderer 匹配 GL 参数 profile，
     * 序列化（typed array → number[]，map key → hex 字符串）后送进 runner.ts。
     */
    it('Win11 persona (Intel UHD 730) 派生 INTEL_UHD_730_D3D11 profile', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-glp-w11', displayName: 'X' });
      const cfg = buildInjectionConfig(persona);
      expect(cfg.webglProfile).not.toBeNull();
      expect(cfg.webglProfile?.name).toContain('UHD Graphics 730');
      // 关键参数：MAX_TEXTURE_SIZE = 0x0d33 = 16384
      expect(cfg.webglProfile?.webgl1['0xd33']).toBe(16384);
      // MAX_VIEWPORT_DIMS = 0x0d3a = [16384, 16384]
      expect(cfg.webglProfile?.webgl1['0xd3a']).toEqual([16384, 16384]);
    });

    it('Win10 persona (Intel UHD 630) 派生 INTEL_UHD_630_D3D11 profile (Phase 2.2)', () => {
      // Phase 2.2: UHD 630 加入 KNOWN_PROFILES，win10-chrome-us 不再 fallback 到 null
      const cfg = buildInjectionConfig(
        createWin10ChromeUsPersona({ id: 'inj-glp-w10', displayName: 'X' }),
      );
      expect(cfg.webglProfile).not.toBeNull();
      expect(cfg.webglProfile?.id).toBe('intel-uhd-630-d3d11');
      expect(cfg.webglProfile?.name).toContain('UHD Graphics 630');
    });

    it('macOS / Ubuntu persona 暂未匹配（保留 null → runner 跳过 spoof）', () => {
      // macOS 用 Apple M2 - 暂无 profile
      expect(
        buildInjectionConfig(
          createMacosSonomaChromeUsPersona({ id: 'inj-glp-mac', displayName: 'X' }),
        ).webglProfile,
      ).toBeNull();
      // Ubuntu 用 Mesa - 暂无 profile
      expect(
        buildInjectionConfig(
          createUbuntu2204ChromeUsPersona({ id: 'inj-glp-ubt', displayName: 'X' }),
        ).webglProfile,
      ).toBeNull();
    });

    it('webglProfile JSON 往返不变（序列化进 page context 必须 stable）', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-glp-rt', displayName: 'X' });
      const cfg = buildInjectionConfig(persona);
      const roundTrip = JSON.parse(JSON.stringify(cfg.webglProfile));
      expect(roundTrip).toEqual(cfg.webglProfile);
    });

    it('Phase 2.1: serialized profile 带 id 字段（与 KNOWN_PROFILES 对齐）', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-glp-id', displayName: 'X' });
      const cfg = buildInjectionConfig(persona);
      expect(cfg.webglProfile?.id).toBe('intel-uhd-730-d3d11');
    });
  });

  describe('webglProfile webglProfileId override (Phase 2.1)', () => {
    /**
     * Phase 2.1: persona.hardware.gpu.webglProfileId 让用户绕过 regex match
     * 强制选某个 profile id。Phase 2.2 会加 INTEL_UHD_630 让此 override 真正
     * 用得上；当前只能验证：
     *   - id 匹配 KNOWN_PROFILES 时 → 选中（即便 webglRenderer 字符串与 profile
     *     的 matchRenderer 不一致）
     *   - id 未匹配（typo） → 降级 regex match，不强 fail
     */

    it('webglProfileId 命中时用 id 选 profile（绕过 regex）', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-id-hit', displayName: 'X' });
      // Win11 模板的 webglRenderer 是 UHD 730，对应的 profile id 也是 'intel-uhd-730-d3d11'
      // 当 webglProfileId 显式声明同一 id 时，行为应等同（id 优先 → 选中）
      const personaWithId = {
        ...persona,
        hardware: {
          ...persona.hardware,
          gpu: { ...persona.hardware.gpu, webglProfileId: 'intel-uhd-730-d3d11' },
        },
      };
      const cfg = buildInjectionConfig(personaWithId);
      expect(cfg.webglProfile?.id).toBe('intel-uhd-730-d3d11');
    });

    it('webglProfileId typo 时降级到 regex match（不强 fail）', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-id-typo', displayName: 'X' });
      const personaWithBadId = {
        ...persona,
        hardware: {
          ...persona.hardware,
          gpu: { ...persona.hardware.gpu, webglProfileId: 'nonexistent-profile-id-zzz' },
        },
      };
      const cfg = buildInjectionConfig(personaWithBadId);
      // typo 时不该 disable spoof —— 应该降级用 webglRenderer regex 选 UHD 730
      expect(cfg.webglProfile?.id).toBe('intel-uhd-730-d3d11');
    });

    it('webglProfileId 留空 / undefined 时按 regex match（向后兼容 v0.2 行为）', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-id-undef', displayName: 'X' });
      // 默认就是 undefined（template 不设置）
      expect(persona.hardware.gpu.webglProfileId).toBeUndefined();
      const cfg = buildInjectionConfig(persona);
      expect(cfg.webglProfile?.id).toBe('intel-uhd-730-d3d11');
    });
  });

  describe('uaCh (UA-CH 派生)', () => {
    it('derives Chrome triple brand list with Not.A/Brand v8 + Chromium', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-uach-w', displayName: 'W' });
      const cfg = buildInjectionConfig(persona);
      // 顺序固定：[真品牌, Not.A/Brand, Chromium] —— Chromium GREASE 真实顺序是
      // 随机的，但我们为 persona 维度可复现性固定。fingerprinter 看的是集合，不是顺序。
      expect(cfg.uaCh.brands.map((b) => b.brand)).toEqual([
        'Google Chrome',
        'Not.A/Brand',
        'Chromium',
      ]);
      // majorVersion 应该跟 brands version 对齐
      expect(cfg.uaCh.brands[0]?.version).toBe(String(persona.browser.majorVersion));
      // fullVersionList 用 fullVersion
      expect(cfg.uaCh.fullVersionList[0]?.version).toBe(persona.browser.fullVersion);
      expect(cfg.uaCh.fullVersionList[1]).toEqual({ brand: 'Not.A/Brand', version: '8.0.0.0' });
    });

    it('Win11 (build ≥ 22000) → platformVersion "15.0.0" (UA-CH reduction)', () => {
      const persona = createWin11ChromeUsPersona({ id: 'inj-uach-w11', displayName: 'W11' });
      // Win11 模板 os.version = '10.0.22631' → build 22631 ≥ 22000
      const cfg = buildInjectionConfig(persona);
      expect(cfg.uaCh.platform).toBe('Windows');
      expect(cfg.uaCh.platformVersion).toBe('15.0.0');
    });

    it('Win10 (build < 22000) → platformVersion "10.0.0"', () => {
      const persona = createWin10ChromeUsPersona({ id: 'inj-uach-w10', displayName: 'W10' });
      // Win10 模板 os.version = '10.0.19045' → build 19045 < 22000
      const cfg = buildInjectionConfig(persona);
      expect(cfg.uaCh.platform).toBe('Windows');
      expect(cfg.uaCh.platformVersion).toBe('10.0.0');
    });

    it('macOS → platform "macOS" + platformVersion derived from major', () => {
      const persona = createMacosSonomaChromeUsPersona({ id: 'inj-uach-m', displayName: 'M' });
      const cfg = buildInjectionConfig(persona);
      expect(cfg.uaCh.platform).toBe('macOS');
      // Sonoma os.version = '14.6.1' → major "14" → "14.0.0"
      expect(cfg.uaCh.platformVersion).toBe('14.0.0');
    });

    it('Linux → platform "Linux" + platformVersion "" (Chrome 105+ reduction 空串)', () => {
      const persona = createUbuntu2204ChromeUsPersona({ id: 'inj-uach-l', displayName: 'L' });
      const cfg = buildInjectionConfig(persona);
      expect(cfg.uaCh.platform).toBe('Linux');
      expect(cfg.uaCh.platformVersion).toBe('');
    });

    it('architecture follows persona.system.os.arch (x86_64 → "x86", arm64 → "arm")', () => {
      const w = buildInjectionConfig(
        createWin11ChromeUsPersona({ id: 'inj-uach-arch-w', displayName: 'X' }),
      );
      expect(w.uaCh.architecture).toBe('x86');
      // macOS Sonoma 模板 arch = 'arm64'
      const m = buildInjectionConfig(
        createMacosSonomaChromeUsPersona({ id: 'inj-uach-arch-m', displayName: 'X' }),
      );
      expect(m.uaCh.architecture).toBe('arm');
    });

    it('all desktop personas report mobile=false / wow64=false / bitness="64"', () => {
      for (const persona of [
        createWin11ChromeUsPersona({ id: 'a1', displayName: 'X' }),
        createMacosSonomaChromeUsPersona({ id: 'a2', displayName: 'X' }),
        createUbuntu2204ChromeUsPersona({ id: 'a3', displayName: 'X' }),
      ]) {
        const cfg = buildInjectionConfig(persona);
        expect(cfg.uaCh.mobile).toBe(false);
        expect(cfg.uaCh.wow64).toBe(false);
        expect(cfg.uaCh.bitness).toBe('64');
        expect(cfg.uaCh.model).toBe('');
      }
    });

    it('persona.browser.uaClientHints 显式覆盖时按 persona 原样返回', () => {
      const base = createWin11ChromeUsPersona({ id: 'inj-uach-ovr', displayName: 'X' });
      const explicit = {
        ...base,
        browser: {
          ...base.browser,
          uaClientHints: {
            brands: [{ brand: 'CustomBrand', version: '99' }],
            mobile: true,
            platform: 'CustomOS',
            platformVersion: '99.0.0',
            architecture: 'wasm',
            bitness: '32',
            model: 'Pixel-Fold',
            wow64: true,
          },
        },
      };
      const cfg = buildInjectionConfig(explicit);
      expect(cfg.uaCh.platform).toBe('CustomOS');
      expect(cfg.uaCh.platformVersion).toBe('99.0.0');
      expect(cfg.uaCh.architecture).toBe('wasm');
      expect(cfg.uaCh.bitness).toBe('32');
      expect(cfg.uaCh.model).toBe('Pixel-Fold');
      expect(cfg.uaCh.mobile).toBe(true);
      expect(cfg.uaCh.wow64).toBe(true);
      expect(cfg.uaCh.brands).toEqual([{ brand: 'CustomBrand', version: '99' }]);
    });
  });
});
