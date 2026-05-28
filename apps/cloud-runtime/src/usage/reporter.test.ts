/**
 * Phase 11.7 commit 3: MeterReporter 工厂 + noop 行为单测。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetEnvCache } from '../env.js';
import {
  NoopMeterReporter,
  getMeterReporter,
  setMeterReporterForTesting,
  type MeterReporter,
  type UsageRecord,
} from './reporter.js';

beforeEach(() => {
  setMeterReporterForTesting(null);
  delete process.env.STRIPE_API_KEY;
  resetEnvCache();
});

afterEach(() => {
  setMeterReporterForTesting(null);
});

describe('NoopMeterReporter', () => {
  it('report 不抛错，空数组也安全', async () => {
    const r = new NoopMeterReporter();
    expect(r.kind).toBe('noop');
    await expect(r.report([])).resolves.toBeUndefined();
    await expect(
      r.report([{ projectId: 'p', kind: 'session.minute', value: 3, windowEnd: '2026-05-01T00:00:00.000Z' }]),
    ).resolves.toBeUndefined();
  });
});

describe('getMeterReporter', () => {
  it('STRIPE_API_KEY 空 → NoopMeterReporter', () => {
    process.env.STRIPE_API_KEY = '';
    resetEnvCache();
    const r = getMeterReporter();
    expect(r.kind).toBe('noop');
  });

  it('缓存：连续两次返回同一实例', () => {
    const a = getMeterReporter();
    const b = getMeterReporter();
    expect(a).toBe(b);
  });

  it('STRIPE_API_KEY 非空 → fail-fast 抛错（11.7a 未实现 Stripe，绝不静默 noop）', () => {
    process.env.STRIPE_API_KEY = 'sk_test_xxx';
    resetEnvCache();
    expect(() => getMeterReporter()).toThrow(/not implemented yet/i);
  });

  it('setMeterReporterForTesting 注入 fake → 工厂返回它', () => {
    const fake: MeterReporter = {
      kind: 'stripe',
      async report(_records: UsageRecord[]) {
        /* */
      },
    };
    setMeterReporterForTesting(fake);
    expect(getMeterReporter()).toBe(fake);
  });
});
