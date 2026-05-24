/**
 * bumpLastSeenAt 单测。
 *
 * 走真实 in-memory sqlite（跟 app.test.ts 同款），不 mock —— 这样真正
 * 验证 SQL UPDATE 命中 last_seen_at 列、where 条件按 id 过滤。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { ensureSchema } from './bootstrap.js';
import { disposeDb, getDb } from './client.js';
import { projects, sessions as sessionsTable } from './schema.js';
import { resetEnvCache } from '../env.js';
import { bumpLastSeenAt } from './session-activity.js';

const PROJECT_ID = 'proj_test_lastseen';

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  resetEnvCache();
  await ensureSchema();
  const handle = await getDb();
  await handle.drizzle.insert(projects).values({ id: PROJECT_ID, name: 'lastseen-test' });
});

afterEach(async () => {
  await disposeDb();
});

async function insertSession(id: string, lastSeenAt: string): Promise<void> {
  const handle = await getDb();
  await handle.drizzle.insert(sessionsTable).values({
    id,
    projectId: PROJECT_ID,
    personaId: null,
    machineId: 'mch_x',
    status: 'live',
    cdpInternalUrl: 'ws://fake/u',
    cdpPublicUrl: 'ws://fake/v1/sessions/u/cdp',
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastSeenAt,
    metadataJson: '{}',
  });
}

describe('bumpLastSeenAt', () => {
  it('更新指定 session 的 last_seen_at，不动其他列 / 其他 session', async () => {
    const oldStamp = '2026-01-01T00:00:00.000Z';
    await insertSession('ses_target', oldStamp);
    await insertSession('ses_other', oldStamp);

    const handle = await getDb();
    const newStamp = '2026-01-02T00:00:00.000Z';
    const ok = await bumpLastSeenAt(handle, 'ses_target', newStamp);
    expect(ok).toBe(true);

    const [target] = await handle.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_target'));
    expect(target?.lastSeenAt).toBe(newStamp);
    // 其他列不动
    expect(target?.status).toBe('live');
    expect(target?.machineId).toBe('mch_x');

    const [other] = await handle.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_other'));
    expect(other?.lastSeenAt).toBe(oldStamp);
  });

  it('未传 nowIso → 默认用当前 UTC ISO', async () => {
    const oldStamp = '2025-01-01T00:00:00.000Z';
    await insertSession('ses_default_now', oldStamp);

    const before = Date.now();
    const handle = await getDb();
    const ok = await bumpLastSeenAt(handle, 'ses_default_now');
    const after = Date.now();
    expect(ok).toBe(true);

    const [row] = await handle.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_default_now'));
    const written = Date.parse(row?.lastSeenAt ?? '');
    // 写入时间应该在 before/after 之间（容差 5s 以应付 CI 慢盘）
    expect(written).toBeGreaterThanOrEqual(before);
    expect(written).toBeLessThanOrEqual(after + 5_000);
  });

  it('未知 sessionId → ok=true（drizzle update 不命中行不抛错），不影响表里其他行', async () => {
    const oldStamp = '2026-01-01T00:00:00.000Z';
    await insertSession('ses_existing', oldStamp);

    const handle = await getDb();
    const ok = await bumpLastSeenAt(handle, 'ses_does_not_exist');
    expect(ok).toBe(true);

    const [row] = await handle.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_existing'));
    expect(row?.lastSeenAt).toBe(oldStamp);
  });

  it('sqlite 已 close → 返回 false 而不是抛错', async () => {
    await insertSession('ses_will_fail', '2026-01-01T00:00:00.000Z');
    const handle = await getDb();
    await handle.close(); // 关掉底层 sqlite，drizzle.update 会抛
    const ok = await bumpLastSeenAt(handle, 'ses_will_fail');
    expect(ok).toBe(false);
  });
});
