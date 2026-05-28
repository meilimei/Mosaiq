/**
 * Phase 11.7 commit 2: usage aggregation + GET /v1/usage 测试。
 *
 * 两层：
 *   1) aggregateUsage / currentMonthWindowUtc 纯查询/纯函数 —— in-memory sqlite。
 *   2) GET /v1/usage 端点 —— createApp() + seeded api key，验证 auth-gate、
 *      时间窗过滤、跨 project 隔离、成本估算、参数校验。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createApp } from '../app.js';
import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys, projects, usageEvents } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { resetRateLimitStore } from '../middleware/rate-limit.js';
import { aggregateUsage, currentMonthWindowUtc } from '../usage/aggregate.js';
import { sha256Hex } from '../utils/hash.js';
import { newId } from '../utils/ids.js';

const TEST_PROJECT_ID = 'proj_usage';
const TEST_API_KEY = 'msq_sk_test_uuuuuuuuuuuuuuuuuuuuuu';
const OTHER_PROJECT_ID = 'proj_usage_other';
const OTHER_API_KEY = 'msq_sk_test_oooooooooooooooooooooo';

function authH(key = TEST_API_KEY): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

async function insertUsage(opts: {
  projectId: string;
  kind?: string;
  value: number;
  ts: string;
  sessionId?: string;
}): Promise<void> {
  const handle = await getDb();
  await handle.drizzle.insert(usageEvents).values({
    id: newId('use'),
    projectId: opts.projectId,
    sessionId: opts.sessionId ?? null,
    kind: opts.kind ?? 'session.minute',
    value: opts.value,
    ts: opts.ts,
  });
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  process.env.PUBLIC_BASE_URL = 'http://localhost:8787';
  delete process.env.UNIT_PRICE_USD_PER_MINUTE;
  delete process.env.RATE_LIMIT_READ_CAPACITY;
  delete process.env.RATE_LIMIT_READ_REFILL_PER_SEC;
  resetEnvCache();
  resetRateLimitStore();
  await ensureSchema();

  const handle = await getDb();
  await handle.drizzle.insert(projects).values([
    { id: TEST_PROJECT_ID, name: 'usage' },
    { id: OTHER_PROJECT_ID, name: 'usage-other' },
  ]);
  await handle.drizzle.insert(apiKeys).values([
    {
      id: newId('apk'),
      projectId: TEST_PROJECT_ID,
      keyHash: sha256Hex(TEST_API_KEY),
      prefix: TEST_API_KEY.slice(0, 20),
    },
    {
      id: newId('apk'),
      projectId: OTHER_PROJECT_ID,
      keyHash: sha256Hex(OTHER_API_KEY),
      prefix: OTHER_API_KEY.slice(0, 20),
    },
  ]);
});

afterEach(async () => {
  await disposeDb();
});

// ─── currentMonthWindowUtc ────────────────────────────────────────────────

describe('currentMonthWindowUtc', () => {
  it('返回当月 [1号00:00, 次月1号00:00) UTC', () => {
    const w = currentMonthWindowUtc(new Date('2026-05-15T12:34:56.000Z'));
    expect(w.fromIso).toBe('2026-05-01T00:00:00.000Z');
    expect(w.toIso).toBe('2026-06-01T00:00:00.000Z');
  });

  it('12 月跨年正确滚动到次年 1 月', () => {
    const w = currentMonthWindowUtc(new Date('2026-12-31T23:59:59.000Z'));
    expect(w.fromIso).toBe('2026-12-01T00:00:00.000Z');
    expect(w.toIso).toBe('2027-01-01T00:00:00.000Z');
  });
});

// ─── aggregateUsage ───────────────────────────────────────────────────────

describe('aggregateUsage', () => {
  it('按 kind 求和，half-open 区间 [from, to) 过滤', async () => {
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 3, ts: '2026-05-10T00:00:00.000Z' });
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 5, ts: '2026-05-20T00:00:00.000Z' });
    // 上界独占：恰好等于 to 的不计入
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 99, ts: '2026-06-01T00:00:00.000Z' });
    // 下界之前：不计入
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 77, ts: '2026-04-30T23:59:59.999Z' });

    const handle = await getDb();
    const totals = await aggregateUsage(
      handle,
      TEST_PROJECT_ID,
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(totals['session.minute']).toBe(8);
  });

  it('跨 project 隔离：只聚合本 project', async () => {
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 10, ts: '2026-05-10T00:00:00.000Z' });
    await insertUsage({ projectId: OTHER_PROJECT_ID, value: 999, ts: '2026-05-10T00:00:00.000Z' });

    const handle = await getDb();
    const totals = await aggregateUsage(
      handle,
      TEST_PROJECT_ID,
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(totals['session.minute']).toBe(10);
  });

  it('区间内无数据 → 空对象', async () => {
    const handle = await getDb();
    const totals = await aggregateUsage(
      handle,
      TEST_PROJECT_ID,
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(totals['session.minute']).toBeUndefined();
    expect(Object.keys(totals)).toHaveLength(0);
  });
});

// ─── GET /v1/usage ────────────────────────────────────────────────────────

describe('GET /v1/usage', () => {
  it('无 auth → 401', async () => {
    const app = createApp();
    const resp = await app.request('/v1/usage');
    expect(resp.status).toBe(401);
  });

  it('显式 from/to → totals + estimated_cost_usd（默认单价 0.06）', async () => {
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 12, ts: '2026-05-10T00:00:00.000Z' });
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 5, ts: '2026-05-11T00:00:00.000Z' });

    const app = createApp();
    const resp = await app.request(
      '/v1/usage?from=2026-05-01T00:00:00Z&to=2026-06-01T00:00:00Z',
      { headers: authH() },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      project_id: string;
      from: string;
      to: string;
      totals: Record<string, number>;
      estimated_cost_usd: number;
      unit_price_usd_per_minute: number;
    };
    expect(body.project_id).toBe(TEST_PROJECT_ID);
    expect(body.totals['session.minute']).toBe(17);
    // 17 × 0.06 = 1.02
    expect(body.estimated_cost_usd).toBe(1.02);
    expect(body.unit_price_usd_per_minute).toBe(0.06);
    // 归一化为 Z-form ISO
    expect(body.from).toBe('2026-05-01T00:00:00.000Z');
    expect(body.to).toBe('2026-06-01T00:00:00.000Z');
  });

  it('自定义单价 env → 成本估算随之变化', async () => {
    process.env.UNIT_PRICE_USD_PER_MINUTE = '0.10';
    resetEnvCache();
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 50, ts: '2026-05-10T00:00:00.000Z' });

    const app = createApp();
    const resp = await app.request(
      '/v1/usage?from=2026-05-01T00:00:00Z&to=2026-06-01T00:00:00Z',
      { headers: authH() },
    );
    const body = (await resp.json()) as { estimated_cost_usd: number };
    expect(body.estimated_cost_usd).toBe(5); // 50 × 0.10
  });

  it('默认窗口 = 当前自然月（不传 from/to）', async () => {
    const { fromIso } = currentMonthWindowUtc();
    // 当月内插一条
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 7, ts: fromIso });

    const app = createApp();
    const resp = await app.request('/v1/usage', { headers: authH() });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { totals: Record<string, number>; from: string };
    expect(body.totals['session.minute']).toBe(7);
    expect(body.from).toBe(fromIso);
  });

  it('跨 project 隔离：OTHER key 看不到 TEST 的用量', async () => {
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 100, ts: '2026-05-10T00:00:00.000Z' });

    const app = createApp();
    const resp = await app.request(
      '/v1/usage?from=2026-05-01T00:00:00Z&to=2026-06-01T00:00:00Z',
      { headers: authH(OTHER_API_KEY) },
    );
    const body = (await resp.json()) as { project_id: string; totals: Record<string, number> };
    expect(body.project_id).toBe(OTHER_PROJECT_ID);
    expect(body.totals['session.minute']).toBe(0);
  });

  it('无数据 → totals 0，cost 0', async () => {
    const app = createApp();
    const resp = await app.request('/v1/usage', { headers: authH() });
    const body = (await resp.json()) as { totals: Record<string, number>; estimated_cost_usd: number };
    expect(body.totals['session.minute']).toBe(0);
    expect(body.estimated_cost_usd).toBe(0);
  });

  it('非法 from → 422', async () => {
    const app = createApp();
    const resp = await app.request('/v1/usage?from=not-a-date', { headers: authH() });
    expect(resp.status).toBe(422);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('request.invalid');
  });

  it('from >= to → 422', async () => {
    const app = createApp();
    const resp = await app.request(
      '/v1/usage?from=2026-06-01T00:00:00Z&to=2026-05-01T00:00:00Z',
      { headers: authH() },
    );
    expect(resp.status).toBe(422);
  });

  it('带时区偏移的 from 被归一化为 UTC Z-form 后正确过滤', async () => {
    // +08:00 的 2026-05-01T08:00 == UTC 2026-05-01T00:00；该事件应被计入。
    await insertUsage({ projectId: TEST_PROJECT_ID, value: 4, ts: '2026-05-01T00:30:00.000Z' });

    const app = createApp();
    const resp = await app.request(
      '/v1/usage?from=2026-05-01T08:00:00%2B08:00&to=2026-06-01T00:00:00Z',
      { headers: authH() },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { from: string; totals: Record<string, number> };
    expect(body.from).toBe('2026-05-01T00:00:00.000Z');
    expect(body.totals['session.minute']).toBe(4);
  });
});
