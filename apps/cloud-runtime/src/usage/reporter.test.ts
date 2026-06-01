/**
 * Phase 11.7 commit 3: MeterReporter 工厂 + noop 行为单测。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetEnvCache } from '../env.js';
import {
  type FetchLike,
  type MeterReporter,
  NoopMeterReporter,
  StripeMeterReporter,
  type UsageRecord,
  getMeterReporter,
  setMeterReporterForTesting,
} from './reporter.js';

beforeEach(() => {
  setMeterReporterForTesting(null);
  process.env.STRIPE_API_KEY = undefined;
  process.env.STRIPE_API_BASE_URL = undefined;
  process.env.STRIPE_METER_EVENT_NAME = undefined;
  resetEnvCache();
});

afterEach(() => {
  setMeterReporterForTesting(null);
  process.env.STRIPE_API_KEY = undefined;
  process.env.STRIPE_API_BASE_URL = undefined;
  process.env.STRIPE_METER_EVENT_NAME = undefined;
  resetEnvCache();
});

/** 记录每次 fetch 调用的 mock；可配置返回状态。 */
function makeFakeFetch(opts: { status?: number; body?: string } = {}): FetchLike & {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const status = opts.status ?? 200;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return opts.body ?? '';
      },
      async json() {
        return opts.body ? JSON.parse(opts.body) : {};
      },
    } as Response;
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function parseForm(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body ?? ''));
}

describe('NoopMeterReporter', () => {
  it('report 不抛错，空数组也安全', async () => {
    const r = new NoopMeterReporter();
    expect(r.kind).toBe('noop');
    await expect(r.report([])).resolves.toBeUndefined();
    await expect(
      r.report([
        { projectId: 'p', kind: 'session.minute', value: 3, windowEnd: '2026-05-01T00:00:00.000Z' },
      ]),
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

  it('STRIPE_API_KEY 非空 → StripeMeterReporter（phase 11.7b）', () => {
    process.env.STRIPE_API_KEY = 'sk_test_xxx';
    resetEnvCache();
    const r = getMeterReporter();
    expect(r.kind).toBe('stripe');
    expect(r).toBeInstanceOf(StripeMeterReporter);
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

describe('StripeMeterReporter', () => {
  const baseOpts = {
    apiKey: 'sk_test_xxx',
    baseUrl: 'https://stripe.test',
    sessionMinuteEventName: 'mosaiq_browser_minutes',
    nowMs: () => 1_700_000_000_000, // fixed → timestamp = 1700000000
  };

  it('kind=stripe', () => {
    const r = new StripeMeterReporter({
      ...baseOpts,
      resolveStripeCustomerId: async () => 'cus_x',
      fetchImpl: makeFakeFetch(),
    });
    expect(r.kind).toBe('stripe');
  });

  it('空数组 → 不外呼', async () => {
    const fetchImpl = makeFakeFetch();
    const r = new StripeMeterReporter({
      ...baseOpts,
      resolveStripeCustomerId: async () => 'cus_x',
      fetchImpl,
    });
    await r.report([]);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('一条记录 → POST meter_events，form + headers + idempotency key 正确', async () => {
    const fetchImpl = makeFakeFetch({ status: 200 });
    const r = new StripeMeterReporter({
      ...baseOpts,
      resolveStripeCustomerId: async (projectId) => (projectId === 'proj_a' ? 'cus_a' : null),
      fetchImpl,
    });

    await r.report([
      {
        projectId: 'proj_a',
        kind: 'session.minute',
        value: 42,
        windowEnd: '2026-05-02T00:00:00.000Z',
      },
    ]);

    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe('https://stripe.test/v1/billing/meter_events');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_test_xxx');
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const idempotencyKey = 'proj_a:2026-05-02T00:00:00.000Z:session.minute';
    expect(headers['idempotency-key']).toBe(idempotencyKey);

    const form = parseForm(call.init);
    expect(form.get('event_name')).toBe('mosaiq_browser_minutes');
    expect(form.get('identifier')).toBe(idempotencyKey);
    expect(form.get('timestamp')).toBe('1700000000');
    expect(form.get('payload[stripe_customer_id]')).toBe('cus_a');
    expect(form.get('payload[value]')).toBe('42');
  });

  it('多条记录 → 每条一个 meter event', async () => {
    const fetchImpl = makeFakeFetch();
    const r = new StripeMeterReporter({
      ...baseOpts,
      resolveStripeCustomerId: async (projectId) => `cus_${projectId}`,
      fetchImpl,
    });
    await r.report([
      { projectId: 'p1', kind: 'session.minute', value: 6, windowEnd: '2026-05-02T00:00:00.000Z' },
      { projectId: 'p2', kind: 'session.minute', value: 10, windowEnd: '2026-05-02T00:00:00.000Z' },
    ]);
    expect(fetchImpl.calls).toHaveLength(2);
    const customers = fetchImpl.calls.map((c) =>
      parseForm(c.init).get('payload[stripe_customer_id]'),
    );
    expect(customers).toEqual(['cus_p1', 'cus_p2']);
  });

  it('未映射 project（resolve 返 null）→ 抛错，不外呼（绝不静默丢账单）', async () => {
    const fetchImpl = makeFakeFetch();
    const r = new StripeMeterReporter({
      ...baseOpts,
      resolveStripeCustomerId: async () => null,
      fetchImpl,
    });
    await expect(
      r.report([
        {
          projectId: 'proj_unmapped',
          kind: 'session.minute',
          value: 5,
          windowEnd: '2026-05-02T00:00:00.000Z',
        },
      ]),
    ).rejects.toThrow(/no stripe_customer_id/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('Stripe 非 2xx → 抛错（job 不回填、下 tick 重试）', async () => {
    const fetchImpl = makeFakeFetch({ status: 402, body: '{"error":{"message":"card declined"}}' });
    const r = new StripeMeterReporter({
      ...baseOpts,
      resolveStripeCustomerId: async () => 'cus_a',
      fetchImpl,
    });
    await expect(
      r.report([
        {
          projectId: 'proj_a',
          kind: 'session.minute',
          value: 5,
          windowEnd: '2026-05-02T00:00:00.000Z',
        },
      ]),
    ).rejects.toThrow(/meter_events 402/);
  });

  it('多条时第二条失败 → 抛错（整批本 tick 不算成功）', async () => {
    // 第一条 200，第二条 500：用 call 计数切换状态。
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      const ok = n === 1;
      return {
        ok,
        status: ok ? 200 : 500,
        async text() {
          return ok ? '' : 'boom';
        },
        async json() {
          return {};
        },
      } as Response;
    }) as FetchLike;
    const r = new StripeMeterReporter({
      ...baseOpts,
      resolveStripeCustomerId: async () => 'cus_a',
      fetchImpl,
    });
    await expect(
      r.report([
        {
          projectId: 'p1',
          kind: 'session.minute',
          value: 1,
          windowEnd: '2026-05-02T00:00:00.000Z',
        },
        {
          projectId: 'p2',
          kind: 'session.minute',
          value: 2,
          windowEnd: '2026-05-02T00:00:00.000Z',
        },
      ]),
    ).rejects.toThrow(/meter_events 500/);
    expect(n).toBe(2);
  });

  it('baseUrl 末尾斜杠被 normalize', async () => {
    const fetchImpl = makeFakeFetch();
    const r = new StripeMeterReporter({
      ...baseOpts,
      baseUrl: 'https://stripe.test/',
      resolveStripeCustomerId: async () => 'cus_a',
      fetchImpl,
    });
    await r.report([
      { projectId: 'p1', kind: 'session.minute', value: 1, windowEnd: '2026-05-02T00:00:00.000Z' },
    ]);
    expect(fetchImpl.calls[0]!.url).toBe('https://stripe.test/v1/billing/meter_events');
  });

  it('apiKey 为空 → 构造抛错', () => {
    expect(
      () =>
        new StripeMeterReporter({
          ...baseOpts,
          apiKey: '',
          resolveStripeCustomerId: async () => 'cus_a',
        }),
    ).toThrow(/apiKey required/);
  });
});
