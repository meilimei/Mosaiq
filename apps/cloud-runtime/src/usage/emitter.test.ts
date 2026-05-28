/**
 * Phase 11.7 commit 1: usage emitter 单测。
 *
 * 两层：
 *   1) computeBillableMinutes —— 纯函数，覆盖取整 / 最小值 / 时钟漂移兜底，不碰 DB。
 *   2) recordUsage —— 真 in-memory sqlite，验证行落库 + reported_at 留 NULL。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { projects, usageEvents } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { computeBillableMinutes, recordUsage } from './emitter.js';

describe('computeBillableMinutes', () => {
  const open = '2026-05-29T00:00:00.000Z';

  it('< 1 分钟 → 计 1（最小计费增量）', () => {
    expect(computeBillableMinutes(open, '2026-05-29T00:00:01.000Z')).toBe(1);
    expect(computeBillableMinutes(open, '2026-05-29T00:00:59.999Z')).toBe(1);
  });

  it('恰好 1 分钟 → 1', () => {
    expect(computeBillableMinutes(open, '2026-05-29T00:01:00.000Z')).toBe(1);
  });

  it('1 分钟 + 1ms → 向上取整为 2', () => {
    expect(computeBillableMinutes(open, '2026-05-29T00:01:00.001Z')).toBe(2);
  });

  it('90 秒 → ceil = 2', () => {
    expect(computeBillableMinutes(open, '2026-05-29T00:01:30.000Z')).toBe(2);
  });

  it('24 小时 keepAlive session → 1440 分钟', () => {
    expect(computeBillableMinutes(open, '2026-05-30T00:00:00.000Z')).toBe(1440);
  });

  it('时钟漂移：close 早于 open（负时长）→ 保守计 1，绝不计 0/负', () => {
    expect(computeBillableMinutes('2026-05-29T00:01:00.000Z', open)).toBe(1);
  });

  it('同毫秒关闭（0 时长）→ 1', () => {
    expect(computeBillableMinutes(open, open)).toBe(1);
  });

  it('非法时间戳（NaN）→ 1', () => {
    expect(computeBillableMinutes('not-a-date', open)).toBe(1);
    expect(computeBillableMinutes(open, 'not-a-date')).toBe(1);
  });
});

describe('recordUsage', () => {
  const PROJECT_ID = 'proj_usage_emit';

  beforeEach(async () => {
    process.env.DATABASE_URL = 'sqlite::memory:';
    process.env.SEED_API_KEY = '';
    resetEnvCache();
    await ensureSchema();
    const handle = await getDb();
    await handle.drizzle.insert(projects).values({ id: PROJECT_ID, name: 'usage-emit' });
  });

  afterEach(async () => {
    await disposeDb();
  });

  it('写一条 usage_event：kind/value/projectId 正确，reported_at NULL', async () => {
    const handle = await getDb();
    await recordUsage(handle, {
      projectId: PROJECT_ID,
      sessionId: 'ses_abc',
      kind: 'session.minute',
      value: 7,
    });

    const rows = await handle.drizzle
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.projectId, PROJECT_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('session.minute');
    expect(rows[0]?.value).toBe(7);
    expect(rows[0]?.sessionId).toBe('ses_abc');
    expect(rows[0]?.reportedAt).toBeNull();
    expect(rows[0]?.id).toMatch(/^use_/);
    expect(rows[0]?.ts).toBeTruthy();
  });

  it('sessionId 省略 → 落 NULL（非 session 类计费预留）', async () => {
    const handle = await getDb();
    await recordUsage(handle, { projectId: PROJECT_ID, kind: 'session.minute', value: 1 });
    const rows = await handle.drizzle
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.projectId, PROJECT_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBeNull();
  });
});
