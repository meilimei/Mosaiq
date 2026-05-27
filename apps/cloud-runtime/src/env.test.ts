/**
 * env.test.ts — schema 校验回归测试
 *
 * 主要 pin 住：
 *   - prod 模式下 SEED_API_KEY 必须为空
 *   - MACHINE_MANAGER=fly 时 FLY_API_TOKEN + FLY_POD_APP_NAME 必填
 *   - FLY_APP_NAME / FLY_REGION 这两个名是 Fly machine runtime 保留名（会被
 *     自动注入覆盖 secrets），所以必须用 FLY_POD_APP_NAME / FLY_POD_REGION。
 *     这条 invariant 通过：
 *       a) FLY_APP_NAME 不在 parsed env 里
 *       b) 同时设置 FLY_APP_NAME 和 FLY_POD_APP_NAME 时只有后者生效
 *     来保证，回归 2026-05-24 prod 部署踩坑（详见 PHASE-11.2-FLY-DEPLOY.md §10）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadEnv, resetEnvCache, type Env } from './env.js';

function loadWith(overrides: NodeJS.ProcessEnv): Env {
  resetEnvCache();
  // base: empty env so defaults kick in; loadEnv reads from the passed source.
  return loadEnv(overrides);
}

describe('env schema — base defaults', () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it('parses an empty env with sensible defaults', () => {
    const env = loadWith({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(8787);
    expect(env.MACHINE_MANAGER).toBe('static');
    expect(env.FLY_POD_REGION).toBe('iad');
    expect(env.FLY_BROWSER_POD_IMAGE).toBe('registry.fly.io/mosaiq-browser-pod:latest');
  });
});

describe('env schema — production guardrails', () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it('rejects SEED_API_KEY when NODE_ENV=production (test exit via spy)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        loadWith({
          NODE_ENV: 'production',
          SEED_API_KEY: 'msq_sk_live_should_not_be_set_in_prod_xx',
        }),
      ).toThrow(/exit:1/);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('SEED_API_KEY'));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('env schema — fly machine manager required vars', () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it('rejects MACHINE_MANAGER=fly when FLY_API_TOKEN missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        loadWith({
          MACHINE_MANAGER: 'fly',
          FLY_POD_APP_NAME: 'mosaiq-browser-pod',
        }),
      ).toThrow(/exit:1/);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('FLY_API_TOKEN'));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('rejects MACHINE_MANAGER=fly when FLY_POD_APP_NAME missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        loadWith({
          MACHINE_MANAGER: 'fly',
          FLY_API_TOKEN: 'fo1_test_token',
        }),
      ).toThrow(/exit:1/);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('FLY_POD_APP_NAME'));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('accepts valid fly config', () => {
    const env = loadWith({
      MACHINE_MANAGER: 'fly',
      FLY_API_TOKEN: 'fo1_test_token',
      FLY_POD_APP_NAME: 'mosaiq-browser-pod',
      FLY_POD_REGION: 'lax',
    });
    expect(env.MACHINE_MANAGER).toBe('fly');
    expect(env.FLY_POD_APP_NAME).toBe('mosaiq-browser-pod');
    expect(env.FLY_POD_REGION).toBe('lax');
  });
});

describe('env schema — phase 11.3a stopped-machine pool knobs', () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it('defaults: POOL_TARGET_SIZE=0 (pool disabled, factory picks FlyMachineManager)', () => {
    const env = loadWith({});
    expect(env.POOL_TARGET_SIZE).toBe(0);
    expect(env.POOL_REPLENISH_INTERVAL_MS).toBe(10_000);
    expect(env.POOL_REPLENISH_CONCURRENCY).toBe(2);
    expect(env.POOL_MAX_AGE_SECONDS).toBe(86_400);
    expect(env.POOL_PROVISION_TIMEOUT_MS).toBe(120_000);
    expect(env.POOL_BOOTSTRAP_EVICT_FOREIGN).toBe(true);
  });

  it('coerces POOL_TARGET_SIZE from string env', () => {
    const env = loadWith({ POOL_TARGET_SIZE: '5' });
    expect(env.POOL_TARGET_SIZE).toBe(5);
  });

  it('rejects POOL_TARGET_SIZE > 50 (safety cap)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => loadWith({ POOL_TARGET_SIZE: '51' })).toThrow(/exit:1/);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('POOL_TARGET_SIZE'));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('POOL_BOOTSTRAP_EVICT_FOREIGN transforms "false" → boolean false', () => {
    const env = loadWith({ POOL_BOOTSTRAP_EVICT_FOREIGN: 'false' });
    expect(env.POOL_BOOTSTRAP_EVICT_FOREIGN).toBe(false);
  });

  it('POOL_BOOTSTRAP_EVICT_FOREIGN invalid string is rejected', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => loadWith({ POOL_BOOTSTRAP_EVICT_FOREIGN: 'yes' })).toThrow(/exit:1/);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('env schema — phase 11.5 keepAlive knobs', () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it('defaults: TTL_MAX_KEEPALIVE=86400 (24h), IDLE_TIMEOUT_KEEPALIVE=3600 (1h), PER_PROJECT_MAX=5', () => {
    const env = loadWith({});
    expect(env.SESSION_TTL_MAX_KEEPALIVE_SECONDS).toBe(86400);
    expect(env.SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS).toBe(3600);
    expect(env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX).toBe(5);
  });

  it('accepts 0 for KEEPALIVE_SESSIONS_PER_PROJECT_MAX (kill-switch / disable mode)', () => {
    const env = loadWith({ KEEPALIVE_SESSIONS_PER_PROJECT_MAX: '0' });
    expect(env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX).toBe(0);
  });

  it('rejects SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS < 60 (would false-positive in tests)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        loadWith({ SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS: '30' }),
      ).toThrow(/exit:1/);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS'),
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('rejects KEEPALIVE_SESSIONS_PER_PROJECT_MAX > 50 (hard cost-runaway cap)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        loadWith({ KEEPALIVE_SESSIONS_PER_PROJECT_MAX: '51' }),
      ).toThrow(/exit:1/);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('KEEPALIVE_SESSIONS_PER_PROJECT_MAX'),
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('rejects when SESSION_TTL_MAX_KEEPALIVE_SECONDS < SESSION_TTL_MAX_SECONDS', () => {
    // keepAlive ceiling 必须 >= 常规 ceiling，否则语义上"keepAlive 反而比短 session 短"是 nonsense
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        loadWith({
          SESSION_TTL_MAX_SECONDS: '7200',
          SESSION_TTL_MAX_KEEPALIVE_SECONDS: '3600',
        }),
      ).toThrow(/exit:1/);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('SESSION_TTL_MAX_KEEPALIVE_SECONDS'),
      );
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringMatching(/>= SESSION_TTL_MAX_SECONDS/),
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('accepts SESSION_TTL_MAX_KEEPALIVE_SECONDS == SESSION_TTL_MAX_SECONDS (boundary, equal ok)', () => {
    const env = loadWith({
      SESSION_TTL_MAX_SECONDS: '7200',
      SESSION_TTL_MAX_KEEPALIVE_SECONDS: '7200',
    });
    expect(env.SESSION_TTL_MAX_KEEPALIVE_SECONDS).toBe(7200);
    expect(env.SESSION_TTL_MAX_SECONDS).toBe(7200);
  });
});

describe('env schema — FLY_APP_NAME / FLY_REGION are Fly-reserved (regression)', () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it('does NOT read FLY_APP_NAME — Fly auto-injects it and would override secrets', () => {
    // 模拟 Fly machine runtime: FLY_APP_NAME 被注入为控制平面 app 名，
    // 但 secrets / .env 里写了 FLY_POD_APP_NAME 指向 pod app。
    const env = loadWith({
      MACHINE_MANAGER: 'fly',
      FLY_API_TOKEN: 'fo1_test_token',
      FLY_APP_NAME: 'mosaiq-cloud-runtime', // Fly 注入的，不该被读
      FLY_POD_APP_NAME: 'mosaiq-browser-pod', // 真正的 pod app
    });
    // parsed env 不应有 FLY_APP_NAME 字段
    expect((env as unknown as Record<string, unknown>).FLY_APP_NAME).toBeUndefined();
    // FLY_POD_APP_NAME 才是 FlyMachineManager 用的
    expect(env.FLY_POD_APP_NAME).toBe('mosaiq-browser-pod');
  });

  it('does NOT read FLY_REGION — Fly auto-injects it as current machine region', () => {
    const env = loadWith({
      MACHINE_MANAGER: 'fly',
      FLY_API_TOKEN: 'fo1_test_token',
      FLY_POD_APP_NAME: 'mosaiq-browser-pod',
      FLY_REGION: 'sjc', // Fly 注入的当前 machine region
      FLY_POD_REGION: 'iad', // 我们要 spawn pod 的目标 region
    });
    expect((env as unknown as Record<string, unknown>).FLY_REGION).toBeUndefined();
    expect(env.FLY_POD_REGION).toBe('iad');
  });
});
