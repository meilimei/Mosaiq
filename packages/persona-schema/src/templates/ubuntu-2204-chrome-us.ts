/**
 * Template: Ubuntu 22.04 LTS + Chrome 130 + US desktop
 *
 * Linux 桌面用户配置（程序员 / 自托管 / DevOps 群体）。在 Reddit / HN / GitHub 等
 * 开发者社区是常见画像，但在普通消费类网站（购物、社交）上反而显得「极小众」，
 * Cloudflare 一些 BotScore 模型会把 Linux UA 直接判成可疑（自动化爬虫多用 Linux）。
 *
 * 适用场景：
 *   - 跑技术社区账号（HN / GitHub / Reddit r/programming / Stack Exchange）
 *   - dev / staging 工作流，不打算用于消费类站点
 *
 * **不适用**：
 *   - 跨境电商类（Amazon / Shopee 卖家），它们对非主流 OS 风控更严
 *   - 美区 banking / 金融类，这类站点 Linux 用户极少，触发额外验证
 *
 * 关键差异 vs win11/macos：
 *   - OS family: 'linux'，platformLabel: 'Linux x86_64'
 *   - GPU: Intel Mesa（Ubuntu 默认开源驱动，最常见配置）
 *   - 字体集：UBUNTU_2204_FONTS（特征字体如 'Ubuntu' / 'DejaVu Sans' /
 *     'Liberation Mono' 是 Linux 强信号）
 *   - audio.sampleRate: 48000（PulseAudio / PipeWire 默认）
 */

import type { Persona, PersonaId } from '../persona.js';
import { deriveSeed, randomNoiseSeed } from '../utils/seed.js';
import { UBUNTU_2204_FONTS } from './fonts.js';

export interface Ubuntu2204ChromeUsInput {
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

export function createUbuntu2204ChromeUsPersona(input: Ubuntu2204ChromeUsInput): Persona {
  const master = (input.masterSeed ?? randomNoiseSeed()) as ReturnType<typeof randomNoiseSeed>;
  const now = new Date().toISOString();
  const tz = input.timezone ?? 'America/New_York';

  return {
    schemaVersion: 1,
    metadata: {
      id: input.id,
      displayName: input.displayName,
      tags: input.tags ?? ['hn', 'github', 'us', 'linux'],
      notes: input.notes ?? '',
      createdAt: now,
      updatedAt: now,
      lastLaunchedAt: null,
      launchCount: 0,
    },
    system: {
      os: {
        family: 'linux',
        version: '6.8.0-45-generic', // Ubuntu 22.04.5 HWE kernel
        arch: 'x86_64',
        platformLabel: 'Linux x86_64',
      },
      locale: 'en-US',
      languages: ['en-US', 'en'],
      timezone: tz,
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        // GNOME 顶栏 ~28px + 任务栏可能没有（Activities Overview 模式）
        availHeight: 1052,
        colorDepth: 24,
        pixelDepth: 24,
        devicePixelRatio: 1,
      },
    },
    browser: {
      brand: 'chrome',
      majorVersion: 130,
      fullVersion: '130.0.6723.116', // Linux Chrome 偶尔比 Win/macOS 落后 1 个 patch
    },
    hardware: {
      cpu: {
        cores: 8,
        modelName: 'Intel Core i7-12700H',
      },
      deviceMemoryGb: 8,
      gpu: {
        vendor: 'intel',
        // Linux 的 ANGLE renderer 字符串带 OpenGL 后端（Mesa）
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer:
          'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2) (0x00009BC4), OpenGL 4.6 (Core Profile) Mesa 23.2.1-1ubuntu3.1~22.04.2)',
      },
      audio: {
        sampleRate: 48000,
        outputLatencySec: 0.012,
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
        fonts: [...UBUNTU_2204_FONTS],
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
