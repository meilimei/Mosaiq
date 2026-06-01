import { describe, expect, it, vi } from 'vitest';

import { loadEnv, resetEnvCache } from '../env.js';
import { logSingleInstanceAssumption } from './single-instance-guard.js';

describe('logSingleInstanceAssumption', () => {
  it('emits warn with single-instance metadata', () => {
    resetEnvCache();
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'sqlite:./data/test.db' });
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    logSingleInstanceAssumption(log, env);

    expect(warn).toHaveBeenCalled();
    const [meta, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(meta.assumption).toBe('single_control_plane_instance');
    expect(msg).toContain('ONE control-plane instance');
  });
});
