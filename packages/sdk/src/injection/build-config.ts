/**
 * 从 Persona 派生 InjectionConfig。Node 端执行，不进浏览器。
 */

import type { Persona } from '@runova/persona-schema';
import { seedToUint32 } from '@runova/persona-schema';

import { buildUserAgent } from '../ua.js';
import type { InjectionConfig } from './types.js';
import { selectWebglProfileForPersona, serializeProfile } from './webgl-profiles.js';

/**
 * 把 persona.browser + persona.system.os 翻译成 NavigatorUAData 表面字段。
 *
 * 设计原则：
 *  - 如果 persona 显式提供 `browser.uaClientHints` 则照搬（用户自定义优先）。
 *  - 否则按 Chromium 当前 GREASE + UA-CH reduction 政策派生：
 *    - brands: 三元组 [真品牌, 'Not.A/Brand'/v8, 'Chromium']
 *    - fullVersionList: 同上但带完整 fullVersion
 *    - platformVersion: Chrome 105+ reduction —— Win11(build≥22000)→"15.0.0"、
 *      Win10→"10.0.0"、macOS→"<major>.0.0"、Linux→"" 空串
 *    - architecture: x86_64 → "x86"，arm64 → "arm"
 *    - bitness: 桌面默认 "64"
 *
 * 真实 Chrome 把 brand list 顺序按 GREASE 算法随机化（per launch seeded）。
 * 为了 fingerprint 在 persona 维度稳定，我们固定顺序——这降低了 GREASE 强度，
 * 但对 fingerprinter 不可见（他们看到的是 brand 集合，不是顺序）。
 */
function deriveUaCh(persona: Persona): InjectionConfig['uaCh'] {
  // 用户显式覆盖
  if (persona.browser.uaClientHints) {
    const ch = persona.browser.uaClientHints;
    return {
      brands: ch.brands,
      // 没显式提供 fullVersionList → 用 majorVersion brands 兜底
      fullVersionList: ch.brands.map((b) => ({
        brand: b.brand,
        version: b.brand === persona.browser.brand ? persona.browser.fullVersion : b.version,
      })),
      mobile: ch.mobile,
      platform: ch.platform,
      platformVersion: ch.platformVersion,
      architecture: ch.architecture,
      bitness: ch.bitness,
      wow64: ch.wow64,
      model: ch.model,
    };
  }

  const major = String(persona.browser.majorVersion);
  const full = persona.browser.fullVersion;
  const brandName =
    persona.browser.brand === 'chrome'
      ? 'Google Chrome'
      : persona.browser.brand === 'edge'
        ? 'Microsoft Edge'
        : persona.browser.brand === 'brave'
          ? 'Brave'
          : persona.browser.brand === 'opera'
            ? 'Opera'
            : 'Firefox'; // firefox 不发 UA-CH，但保留分支不让类型坍塌

  const brands = [
    { brand: brandName, version: major },
    { brand: 'Not.A/Brand', version: '8' },
    { brand: 'Chromium', version: major },
  ];
  const fullVersionList = [
    { brand: brandName, version: full },
    { brand: 'Not.A/Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: full },
  ];

  let platform: string;
  let platformVersion: string;
  if (persona.system.os.family === 'windows') {
    platform = 'Windows';
    const build = Number(persona.system.os.version.split('.')[2] ?? '0');
    platformVersion = build >= 22000 ? '15.0.0' : '10.0.0';
  } else if (persona.system.os.family === 'macos') {
    platform = 'macOS';
    const majorOs = persona.system.os.version.split('.')[0] ?? '14';
    platformVersion = `${majorOs}.0.0`;
  } else {
    platform = 'Linux';
    platformVersion = ''; // Chrome 105+ Linux UA-CH reduction → 空串
  }

  const architecture = persona.system.os.arch === 'arm64' ? 'arm' : 'x86';
  // 桌面 persona 都是 64-bit
  const bitness = '64';

  return {
    brands,
    fullVersionList,
    mobile: false,
    platform,
    platformVersion,
    architecture,
    bitness,
    wow64: false,
    model: '',
  };
}

export function buildInjectionConfig(persona: Persona): InjectionConfig {
  const ua = persona.browser.userAgent ?? buildUserAgent(persona);

  return {
    // Identity
    userAgent: ua,
    appVersion: ua.replace(/^Mozilla\//, ''),
    platform: persona.system.os.platformLabel,
    vendor: persona.browser.brand === 'firefox' ? '' : 'Google Inc.',
    languages: persona.system.languages,

    uaCh: deriveUaCh(persona),

    // Hardware
    hardwareConcurrency: persona.hardware.cpu.cores,
    deviceMemory: persona.hardware.deviceMemoryGb,
    maxTouchPoints: persona.hardware.maxTouchPoints,

    // Screen
    screen: {
      width: persona.system.screen.width,
      height: persona.system.screen.height,
      availWidth: persona.system.screen.availWidth,
      availHeight: persona.system.screen.availHeight,
      colorDepth: persona.system.screen.colorDepth,
      pixelDepth: persona.system.screen.pixelDepth,
      devicePixelRatio: persona.system.screen.devicePixelRatio,
    },

    timezone: persona.system.timezone,

    // GPU
    webglVendor: persona.hardware.gpu.webglVendor,
    webglRenderer: persona.hardware.gpu.webglRenderer,
    // GL capability 参数表（Phase 2.1：先按 webglProfileId 显式 override 选 profile，
    // 否则按 webglRenderer 字符串 regex 匹配）。
    // 无匹配 → null → runner.ts §4 跳过 GL param spoof，保留 v0.1 的 UNMASKED_VENDOR/
    // RENDERER 字符串 spoof，行为向后兼容。
    webglProfile: (() => {
      const profile = selectWebglProfileForPersona({
        webglRenderer: persona.hardware.gpu.webglRenderer,
        webglProfileId: persona.hardware.gpu.webglProfileId,
      });
      return profile ? serializeProfile(profile) : null;
    })(),

    // Audio
    audioSampleRate: persona.hardware.audio.sampleRate,
    // ⚠️ 下面三个字段当前已派生但 runner.ts 尚未消费（非死字段，是为后续 surface 预留的
    // 管线）：audioOutputLatency → 未来 spoof AudioContext.outputLatency/baseLatency；
    // audioInputDevices/audioOutputDevices → 未来 spoof navigator.mediaDevices.enumerateDevices()
    // 的设备计数。保留 persona→config 的连线，落地新 surface 时 runner.ts 直接读即可，
    // 不必再改 persona-schema / 模板。要移除请连同 InjectionConfig 字段与相关测试一并处理。
    audioOutputLatency: persona.hardware.audio.outputLatencySec,
    audioInputDevices: persona.hardware.audio.inputDeviceCount,
    audioOutputDevices: persona.hardware.audio.outputDeviceCount,

    // Fingerprint seeds
    canvasNoiseSeed: seedToUint32(persona.fingerprint.canvas.noiseSeed),
    canvasNoiseStrength: persona.fingerprint.canvas.noiseStrength,
    webglNoiseSeed: seedToUint32(persona.fingerprint.webgl.noiseSeed),
    webglPerturbReadPixels: persona.fingerprint.webgl.perturbReadPixels,
    audioNoiseSeed: seedToUint32(persona.fingerprint.audio.noiseSeed),
    audioNoiseAmplitude: persona.fingerprint.audio.noiseAmplitude,
    audioNoiseAmplitudeDb: persona.fingerprint.audio.noiseAmplitudeDb,

    // Fonts
    fontList: persona.fingerprint.fontList.fonts,

    // WebRTC
    webrtcMode: persona.fingerprint.webrtc.mode,
  };
}
