/**
 * Template: Windows 10 22H2 + Chrome 130 + US desktop
 *
 * 与 Win11 同价位但 OS 版本更老 / 字体集更小（缺 Bahnschrift / HoloLens / Ink Free）。
 * 适配企业 / 老 PC 用户群（Win10 仍有 ~30% 份额，Win11 升级缓慢）。
 *
 * 与 win11-chrome-us 的差异：
 *   - system.os.version: '10.0.19045' (Win10 22H2 build) vs '10.0.22631' (Win11 23H2)
 *   - fonts: WIN10_FONTS（少 3 个 Win11 独占字体）
 *   - tags 默认: ['reddit', 'us', 'win10']
 *
 * 其他保持一致：UA platformLabel 仍为 'Win32'（这是 navigator.platform 的值，
 * Win10/Win11 都报 'Win32'，区分靠 UA-CH `Sec-CH-UA-Platform-Version`）。
 */

import type { Persona, PersonaId } from '../persona.js';
import { deriveSeed, randomNoiseSeed } from '../utils/seed.js';
import { WIN10_FONTS } from './fonts.js';

export interface Win10ChromeUsInput {
  id: PersonaId;
  displayName: string;
  tags?: string[];
  notes?: string;
  /** 可选：覆盖默认时区（默认 'America/New_York'） */
  timezone?: string;
  proxy?: {
    protocol: 'http' | 'https' | 'socks5';
    host: string;
    port: number;
    username?: string;
    password?: string;
    label?: string;
  };
  /** 可选：覆盖主 noise seed（便于可复现性） */
  masterSeed?: string;
}

export function createWin10ChromeUsPersona(input: Win10ChromeUsInput): Persona {
  const master = (input.masterSeed ?? randomNoiseSeed()) as ReturnType<typeof randomNoiseSeed>;
  const now = new Date().toISOString();
  const tz = input.timezone ?? 'America/New_York';

  return {
    schemaVersion: 1,
    metadata: {
      id: input.id,
      displayName: input.displayName,
      tags: input.tags ?? ['reddit', 'us', 'win10'],
      notes: input.notes ?? '',
      createdAt: now,
      updatedAt: now,
      lastLaunchedAt: null,
      launchCount: 0,
    },
    system: {
      os: {
        family: 'windows',
        version: '10.0.19045', // Win10 22H2
        arch: 'x86_64',
        platformLabel: 'Win32',
      },
      locale: 'en-US',
      languages: ['en-US', 'en'],
      timezone: tz,
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
        pixelDepth: 24,
        devicePixelRatio: 1,
      },
    },
    browser: {
      brand: 'chrome',
      majorVersion: 130,
      fullVersion: '130.0.6723.117',
    },
    hardware: {
      cpu: {
        cores: 4, // Win10 用户群更可能是老 4 核 PC
        modelName: 'Intel Core i5-8400',
      },
      deviceMemoryGb: 8,
      gpu: {
        vendor: 'intel',
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer:
          'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      audio: {
        sampleRate: 48000,
        outputLatencySec: 0.01,
        outputDeviceCount: 1,
        inputDeviceCount: 1,
      },
      maxTouchPoints: 0,
    },
    fingerprint: {
      canvas: {
        noiseSeed: deriveSeed(master, 'canvas'),
        noiseStrength: 2,
      },
      webgl: {
        noiseSeed: deriveSeed(master, 'webgl'),
        perturbReadPixels: true,
      },
      audio: {
        noiseSeed: deriveSeed(master, 'audio'),
        noiseAmplitude: 1e-7,
      },
      fontList: {
        fonts: [...WIN10_FONTS],
      },
      webrtc: {
        mode: 'proxy_only',
      },
    },
    network: {
      proxy: input.proxy
        ? {
            protocol: input.proxy.protocol,
            host: input.proxy.host,
            port: input.proxy.port,
            username: input.proxy.username,
            password: input.proxy.password,
            bypassList: [],
            label: input.proxy.label,
          }
        : undefined,
    },
  };
}
