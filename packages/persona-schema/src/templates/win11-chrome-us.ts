/**
 * Template: Windows 11 + Chrome 130 + US desktop + Home residential
 *
 * 典型 Reddit 美国用户配置：Win11 23H2 / Chrome 最新稳定版 / 1920×1080 / 4C8T / 8GB
 * 这是 Reddit 用户群体中最大的单一配置，最不容易因「过于特殊」被标记异常。
 */

import type { Persona, PersonaId } from '../persona.js';
import { deriveSeed, randomNoiseSeed } from '../utils/seed.js';
import { WIN11_FONTS } from './fonts.js';

export interface Win11ChromeUsInput {
  id: PersonaId;
  displayName: string;
  tags?: string[];
  notes?: string;
  /** 可选：覆盖默认时区（'America/New_York' / 'America/Los_Angeles' 等） */
  timezone?: string;
  /** 可选：代理配置 */
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

export function createWin11ChromeUsPersona(input: Win11ChromeUsInput): Persona {
  const master = (input.masterSeed ?? randomNoiseSeed()) as ReturnType<typeof randomNoiseSeed>;
  const now = new Date().toISOString();
  const tz = input.timezone ?? 'America/New_York';

  return {
    schemaVersion: 1,
    metadata: {
      id: input.id,
      displayName: input.displayName,
      tags: input.tags ?? ['reddit', 'us'],
      notes: input.notes ?? '',
      createdAt: now,
      updatedAt: now,
      lastLaunchedAt: null,
      launchCount: 0,
    },
    system: {
      os: {
        family: 'windows',
        version: '10.0.22631',
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
        cores: 8,
        modelName: 'Intel Core i5-12400',
      },
      deviceMemoryGb: 8,
      gpu: {
        vendor: 'intel',
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer:
          'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
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
        fonts: [...WIN11_FONTS],
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
