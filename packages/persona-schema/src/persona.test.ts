import { describe, expect, it } from 'vitest';

import { PERSONA_SCHEMA_VERSION, parsePersona, safeParsePersona } from './persona.js';
import { createWin11ChromeUsPersona } from './templates/win11-chrome-us.js';
import { createMacosSonomaChromeUsPersona } from './templates/macos-sonoma-chrome-us.js';
import { deriveSeed, randomNoiseSeed } from './utils/seed.js';

describe('Persona template: win11-chrome-us', () => {
  it('produces a schema-valid persona', () => {
    const p = createWin11ChromeUsPersona({
      id: 'reddit-alice',
      displayName: 'Reddit Alice',
    });
    expect(() => parsePersona(p)).not.toThrow();
    expect(p.schemaVersion).toBe(PERSONA_SCHEMA_VERSION);
    expect(p.system.os.family).toBe('windows');
    expect(p.browser.brand).toBe('chrome');
    expect(p.fingerprint.fontList.fonts.length).toBeGreaterThan(30);
  });

  it('uses proxy when provided', () => {
    const p = createWin11ChromeUsPersona({
      id: 'reddit-bob',
      displayName: 'Reddit Bob',
      proxy: {
        protocol: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'user',
        password: 'pass',
        label: 'test-proxy',
      },
    });
    expect(p.network.proxy?.host).toBe('proxy.example.com');
    expect(p.network.proxy?.label).toBe('test-proxy');
  });

  it('derives stable seeds from master seed', () => {
    const p1 = createWin11ChromeUsPersona({
      id: 'stable-1',
      displayName: 'S1',
      masterSeed: 'deadbeef',
    });
    const p2 = createWin11ChromeUsPersona({
      id: 'stable-2',
      displayName: 'S2',
      masterSeed: 'deadbeef',
    });
    expect(p1.fingerprint.canvas.noiseSeed).toBe(p2.fingerprint.canvas.noiseSeed);
    expect(p1.fingerprint.webgl.noiseSeed).toBe(p2.fingerprint.webgl.noiseSeed);
    expect(p1.fingerprint.canvas.noiseSeed).not.toBe(p1.fingerprint.webgl.noiseSeed);
  });

  it('generates different seeds for different masters', () => {
    const p1 = createWin11ChromeUsPersona({ id: 'a', displayName: 'A', masterSeed: 'deadbeef' });
    const p2 = createWin11ChromeUsPersona({ id: 'b', displayName: 'B', masterSeed: 'baadf00d' });
    expect(p1.fingerprint.canvas.noiseSeed).not.toBe(p2.fingerprint.canvas.noiseSeed);
  });
});

describe('Persona template: macos-sonoma-chrome-us', () => {
  it('produces a schema-valid persona', () => {
    const p = createMacosSonomaChromeUsPersona({
      id: 'reddit-mac-alice',
      displayName: 'Mac Alice',
    });
    expect(() => parsePersona(p)).not.toThrow();
    expect(p.system.os.family).toBe('macos');
    expect(p.hardware.gpu.vendor).toBe('apple');
    expect(p.system.screen.devicePixelRatio).toBe(2);
  });
});

describe('Persona validation', () => {
  it('rejects invalid persona id', () => {
    const base = createWin11ChromeUsPersona({ id: 'alice', displayName: 'A' });
    const bad = { ...base, metadata: { ...base.metadata, id: 'A-UPPERCASE' } };
    const result = safeParsePersona(bad);
    expect(result.success).toBe(false);
  });

  it('rejects invalid timezone', () => {
    const base = createWin11ChromeUsPersona({ id: 'alice', displayName: 'A' });
    const bad = { ...base, system: { ...base.system, timezone: 'EST' } };
    expect(safeParsePersona(bad).success).toBe(false);
  });

  it('rejects invalid noise seed', () => {
    const base = createWin11ChromeUsPersona({ id: 'alice', displayName: 'A' });
    const bad = {
      ...base,
      fingerprint: {
        ...base.fingerprint,
        canvas: { ...base.fingerprint.canvas, noiseSeed: 'not-hex' },
      },
    };
    expect(safeParsePersona(bad).success).toBe(false);
  });
});

describe('Seed utilities', () => {
  it('randomNoiseSeed produces 8-hex chars', () => {
    for (let i = 0; i < 100; i++) {
      expect(randomNoiseSeed()).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('deriveSeed is deterministic', () => {
    const master = 'deadbeef' as const;
    expect(deriveSeed(master, 'canvas')).toBe(deriveSeed(master, 'canvas'));
    expect(deriveSeed(master, 'canvas')).not.toBe(deriveSeed(master, 'webgl'));
  });
});
