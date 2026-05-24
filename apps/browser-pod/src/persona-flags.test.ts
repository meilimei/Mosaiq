import { describe, expect, it } from 'vitest';

import type { Persona } from '@mosaiq/persona-schema';

import { buildChromiumFlags } from './persona-flags.js';

// 极简 persona，只覆盖 buildChromiumFlags 实际读到的字段。完整 schema 校验由
// @mosaiq/persona-schema 的单测负责，这里不重复 round-trip。
const persona = {
  schemaVersion: 1,
  id: 'p_test',
  source: 'user',
  system: {
    os: 'Win32',
    languages: ['en-US', 'en'],
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    screen: { width: 1920, height: 1080, dpr: 1, colorDepth: 24 },
    cores: 8,
    memGb: 8,
  },
  browser: { name: 'chrome', version: '130.0.6723.117', vendor: 'Google Inc.' },
  network: {},
  fingerprint: {
    webrtc: { mode: 'proxy_only' },
  },
} as unknown as Persona;

describe('buildChromiumFlags', () => {
  const baseInput = {
    persona,
    internalCdpPort: 9224,
    userDataDir: '/tmp/profile/m_test',
    headless: true,
  };

  it('emits CDP exposure flags using internalCdpPort + allow-origins, NOT --remote-debugging-address', () => {
    const flags = buildChromiumFlags(baseInput);
    // chromium 实际监听 127.0.0.1:internalCdpPort（默认 9224）。外面 relay 把
    // 0.0.0.0:POD_CDP_PORT 转发到这里。
    expect(flags).toContain('--remote-debugging-port=9224');
    // 回归：chromium 111+ 必须有这个 flag 才会接受非 localhost Host 的 WS upgrade
    expect(flags).toContain('--remote-allow-origins=*');
    // 回归：故意不传 --remote-debugging-address —— headless 模式下 chromium 这个
    // flag 不生效（已知 bug），传了误导。relay 兜底外部可达。
    expect(flags.some((f) => f.startsWith('--remote-debugging-address'))).toBe(false);
  });

  it('emits --user-data-dir from input', () => {
    expect(buildChromiumFlags({ ...baseInput, userDataDir: '/data/profile/m_abc' })).toContain(
      '--user-data-dir=/data/profile/m_abc',
    );
  });

  it('emits --headless=new when headless=true and omits it when false', () => {
    expect(buildChromiumFlags({ ...baseInput, headless: true })).toContain('--headless=new');
    expect(buildChromiumFlags({ ...baseInput, headless: false })).not.toContain('--headless=new');
  });

  it('viewport override wins over persona.system.screen', () => {
    const flags = buildChromiumFlags({ ...baseInput, viewport: { width: 1366, height: 768 } });
    expect(flags).toContain('--window-size=1366,768');
    expect(flags).not.toContain('--window-size=1920,1080');
  });

  it('emits no-dbus / no-desktop container flags (regression: prod chromium hung 18s on dbus)', () => {
    const flags = buildChromiumFlags(baseInput);
    // 2026-05-24 prod 部署回归：Fly firecracker / docker-without-dbus 镜像下 chromium
    // 会在启动期反复尝试连 /run/dbus/system_bus_socket，每次失败累积可达 15s+。
    // 下面这组 flags 关掉所有触发 dbus 的子系统。详见 persona-flags.ts 注释。
    expect(flags).toContain('--no-first-run');
    expect(flags).toContain('--no-default-browser-check');
    expect(flags).toContain('--disable-background-networking');
    expect(flags).toContain('--disable-sync');
    expect(flags).toContain('--disable-default-apps');
    expect(flags).toContain('--password-store=basic');
    expect(flags).toContain('--use-mock-keychain');
    // MediaRouter 走 dbus 探 Cast 设备 —— 必须合并到 --disable-features 里。
    const disableFeatures = flags.find((f) => f.startsWith('--disable-features='));
    expect(disableFeatures).toBeDefined();
    expect(disableFeatures!).toContain('MediaRouter');
  });
});
