/**
 * Template: macOS Sonoma + Chrome 130 + US desktop
 *
 * 第二常见 Reddit 用户配置：MacBook Air M2 / macOS 14.6 / 1470×956 logical / 2× retina
 */

import type { Persona, PersonaId } from '../persona.js';
import { deriveSeed, randomNoiseSeed } from '../utils/seed.js';
import { MACOS_SONOMA_FONTS } from './fonts.js';

export interface MacosSonomaChromeUsInput {
  id: PersonaId;
  displayName: string;
  tags?: string[];
  notes?: string;
  timezone?: string;
  proxy?: {
    protocol: 'http' | 'https' | 'socks5';
    host: string;
    port: number;
    username?: string;
    password?: string;
    label?: string;
  };
  masterSeed?: string;
}

export function createMacosSonomaChromeUsPersona(input: MacosSonomaChromeUsInput): Persona {
  const master = (input.masterSeed ?? randomNoiseSeed()) as ReturnType<typeof randomNoiseSeed>;
  const now = new Date().toISOString();
  const tz = input.timezone ?? 'America/Los_Angeles';

  return {
    schemaVersion: 1,
    metadata: {
      id: input.id,
      displayName: input.displayName,
      tags: input.tags ?? ['reddit', 'us', 'mac'],
      notes: input.notes ?? '',
      createdAt: now,
      updatedAt: now,
      lastLaunchedAt: null,
      launchCount: 0,
    },
    system: {
      os: {
        family: 'macos',
        version: '14.6.1',
        arch: 'arm64',
        platformLabel: 'MacIntel',
      },
      locale: 'en-US',
      languages: ['en-US', 'en'],
      timezone: tz,
      screen: {
        width: 1470,
        height: 956,
        availWidth: 1470,
        availHeight: 931,
        colorDepth: 30,
        pixelDepth: 30,
        devicePixelRatio: 2,
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
        modelName: 'Apple M2',
      },
      deviceMemoryGb: 8,
      gpu: {
        vendor: 'apple',
        webglVendor: 'Google Inc. (Apple)',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      },
      audio: {
        sampleRate: 48000,
        outputLatencySec: 0.015,
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
        noiseAmplitudeDb: 0.001,
      },
      fontList: {
        fonts: [...MACOS_SONOMA_FONTS],
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
