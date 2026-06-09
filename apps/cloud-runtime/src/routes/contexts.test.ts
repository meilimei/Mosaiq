/**
 * Phase 11.6 commit 2 — POST/DELETE /v1/contexts handler tests.
 *
 * Pattern follows app.test.ts (in-memory sqlite + mock MachineManager). Each
 * test seeds two projects + API keys, then drives the contexts route via
 * `app.request()`. Feature gate: MOSAIQ_CONTEXT_MASTER_KEY + INTERNAL_HMAC_SECRET
 * set in beforeEach to enable the route; one test deliberately clears them
 * to verify the 503 disabled path.
 */

import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys, contexts as contextsTable, projects, sessions } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { resetRateLimitStore } from '../middleware/rate-limit.js';
import { sha256Hex } from '../utils/hash.js';
import { newId } from '../utils/ids.js';

const TEST_PROJECT_ID = 'proj_test';
const TEST_API_KEY = 'msq_sk_test_aaaaaaaaaaaaaaaaaaaaaa';
const OTHER_PROJECT_ID = 'proj_other';
const OTHER_API_KEY = 'msq_sk_test_bbbbbbbbbbbbbbbbbbbbbb';

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  process.env.PUBLIC_BASE_URL = 'http://localhost:8787';
  // Phase 11.6: enable contexts feature with valid-shape secrets
  process.env.MOSAIQ_CONTEXT_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.MOSAIQ_INTERNAL_HMAC_SECRET = randomBytes(48).toString('base64');
  // Disable rate-limit interference
  delete process.env.RATE_LIMIT_WRITE_CAPACITY;
  delete process.env.RATE_LIMIT_WRITE_REFILL_PER_SEC;
  delete process.env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX;
  resetEnvCache();
  resetRateLimitStore();
  await ensureSchema();

  const handle = await getDb();
  await handle.drizzle.insert(projects).values([
    { id: TEST_PROJECT_ID, name: 'test' },
    { id: OTHER_PROJECT_ID, name: 'other' },
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

function authH(token = TEST_API_KEY): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('POST /v1/contexts', () => {
  it('201 + returns { id, projectId, createdAt }; persists row to DB', async () => {
    const app = createApp();
    const resp = await app.request('/v1/contexts', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      id: string;
      projectId: string;
      createdAt: string;
    };
    expect(body.id).toMatch(/^ctx_[A-Za-z0-9]{22}$/);
    expect(body.projectId).toBe(TEST_PROJECT_ID);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);

    // Verify row landed with expected initial state
    const handle = await getDb();
    const rows = await handle.drizzle
      .select()
      .from(contextsTable)
      .where(eq(contextsTable.id, body.id))
      .limit(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.projectId).toBe(TEST_PROJECT_ID);
    expect(row.storageBackend).toBe('fs');
    expect(row.storageKey).toBe(`${body.id}.tar.zst.enc`);
    expect(row.encAlgo).toBe('aes-256-gcm-v1');
    expect(row.bytes).toBeNull();
    expect(row.activeSessionId).toBeNull();
    expect(row.lastSnapshotAt).toBeNull();
    expect(row.deletedAt).toBeNull();
  });

  it('accepts empty body (BB SDK posts no Content-Type)', async () => {
    const app = createApp();
    const resp = await app.request('/v1/contexts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(resp.status).toBe(201);
  });

  it('two POSTs from same key produce two distinct context rows', async () => {
    const app = createApp();
    const r1 = (await (
      await app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' })
    ).json()) as { id: string };
    const r2 = (await (
      await app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' })
    ).json()) as { id: string };
    expect(r1.id).not.toBe(r2.id);
    const handle = await getDb();
    const rows = await handle.drizzle.select().from(contextsTable);
    expect(rows).toHaveLength(2);
  });

  it('quota saturation → 429 pool.contexts_saturated with detail', async () => {
    process.env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX = '2';
    resetEnvCache();
    const app = createApp();
    await app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' });
    await app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' });
    const resp = await app.request('/v1/contexts', {
      method: 'POST',
      headers: authH(),
      body: '{}',
    });
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as {
      error: { code: string; detail: { activeCount: number; quota: number } };
    };
    expect(body.error.code).toBe('pool.contexts_saturated');
    expect(body.error.detail.activeCount).toBe(2);
    expect(body.error.detail.quota).toBe(2);
  });

  it('concurrent POSTs respect MOSAIQ_CONTEXTS_PER_PROJECT_MAX', async () => {
    process.env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX = '1';
    resetEnvCache();
    const app = createApp();

    const [a, b] = await Promise.all([
      app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' }),
      app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 429]);
    const handle = await getDb();
    const rows = await handle.drizzle
      .select()
      .from(contextsTable)
      .where(and(eq(contextsTable.projectId, TEST_PROJECT_ID), isNull(contextsTable.deletedAt)));
    expect(rows).toHaveLength(1);
  });

  it('soft-deleted contexts do NOT count toward quota', async () => {
    process.env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX = '1';
    resetEnvCache();
    const app = createApp();

    // Fill quota
    const first = (await (
      await app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' })
    ).json()) as { id: string };

    // Confirm second POST hits 429
    const denied = await app.request('/v1/contexts', {
      method: 'POST',
      headers: authH(),
      body: '{}',
    });
    expect(denied.status).toBe(429);

    // Delete the first → quota frees
    const del = await app.request(`/v1/contexts/${first.id}`, {
      method: 'DELETE',
      headers: authH(),
    });
    expect(del.status).toBe(204);

    // Now POST should succeed
    const ok = await app.request('/v1/contexts', {
      method: 'POST',
      headers: authH(),
      body: '{}',
    });
    expect(ok.status).toBe(201);
  });

  it('quotas are per-project — TEST + OTHER independent', async () => {
    process.env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX = '1';
    resetEnvCache();
    const app = createApp();
    const a = await app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' });
    expect(a.status).toBe(201);
    // TEST_PROJECT_ID at quota; OTHER_PROJECT_ID still has room
    const b = await app.request('/v1/contexts', {
      method: 'POST',
      headers: authH(OTHER_API_KEY),
      body: '{}',
    });
    expect(b.status).toBe(201);
  });

  it('feature disabled (no MASTER_KEY) → 503 context.disabled', async () => {
    process.env.MOSAIQ_CONTEXT_MASTER_KEY = '';
    process.env.MOSAIQ_INTERNAL_HMAC_SECRET = '';
    resetEnvCache();
    const app = createApp();
    const resp = await app.request('/v1/contexts', {
      method: 'POST',
      headers: authH(),
      body: '{}',
    });
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('context.disabled');
  });

  it('no auth → 401', async () => {
    const app = createApp();
    const resp = await app.request('/v1/contexts', {
      method: 'POST',
      body: '{}',
    });
    expect(resp.status).toBe(401);
  });
});

describe('DELETE /v1/contexts/:id', () => {
  async function createOne(token = TEST_API_KEY): Promise<string> {
    const app = createApp();
    const resp = await app.request('/v1/contexts', {
      method: 'POST',
      headers: authH(token),
      body: '{}',
    });
    return ((await resp.json()) as { id: string }).id;
  }

  it('204 + soft-deletes (sets deleted_at)', async () => {
    const id = await createOne();
    const app = createApp();
    const resp = await app.request(`/v1/contexts/${id}`, {
      method: 'DELETE',
      headers: authH(),
    });
    expect(resp.status).toBe(204);

    const handle = await getDb();
    const rows = await handle.drizzle
      .select()
      .from(contextsTable)
      .where(eq(contextsTable.id, id))
      .limit(1);
    expect(rows[0]?.deletedAt).toBeTruthy();
  });

  it('idempotent: nonexistent id → 204', async () => {
    const app = createApp();
    const resp = await app.request('/v1/contexts/ctx_DoesNotExistxxxxxxxxx', {
      method: 'DELETE',
      headers: authH(),
    });
    expect(resp.status).toBe(204);
  });

  it('idempotent: second DELETE on already-deleted → 204', async () => {
    const id = await createOne();
    const app = createApp();
    let resp = await app.request(`/v1/contexts/${id}`, { method: 'DELETE', headers: authH() });
    expect(resp.status).toBe(204);
    resp = await app.request(`/v1/contexts/${id}`, { method: 'DELETE', headers: authH() });
    expect(resp.status).toBe(204);
  });

  it('cross-project DELETE → 204 (treated as nonexistent; no leak)', async () => {
    const id = await createOne();
    const app = createApp();
    const resp = await app.request(`/v1/contexts/${id}`, {
      method: 'DELETE',
      headers: authH(OTHER_API_KEY),
    });
    expect(resp.status).toBe(204);
    // Original project's row should still be alive
    const handle = await getDb();
    const rows = await handle.drizzle
      .select()
      .from(contextsTable)
      .where(eq(contextsTable.id, id))
      .limit(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it('in-use → 409 context.in_use with activeSessionId in detail', async () => {
    const id = await createOne();
    // Manually set active_session_id to simulate a live session holding the lock
    // (the actual sessions integration lands in commit 4; here we shortcut DB)
    const handle = await getDb();
    // Need a real session row for the FK to resolve cleanly
    const sessionId = newId('ses');
    await handle.drizzle.insert(sessions).values({
      id: sessionId,
      projectId: TEST_PROJECT_ID,
      machineId: 'mch_fake',
      status: 'live',
      cdpInternalUrl: 'ws://fake/cdp',
      cdpPublicUrl: `ws://localhost/v1/sessions/${sessionId}/cdp`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await handle.drizzle
      .update(contextsTable)
      .set({
        activeSessionId: sessionId,
        activeSessionAcquiredAt: new Date().toISOString(),
      })
      .where(eq(contextsTable.id, id));

    const app = createApp();
    const resp = await app.request(`/v1/contexts/${id}`, {
      method: 'DELETE',
      headers: authH(),
    });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as {
      error: { code: string; detail: { activeSessionId: string; acquiredAt: string } };
    };
    expect(body.error.code).toBe('context.in_use');
    expect(body.error.detail.activeSessionId).toBe(sessionId);
    expect(body.error.detail.acquiredAt).toBeTruthy();

    // Verify row was NOT soft-deleted
    const after = await handle.drizzle
      .select()
      .from(contextsTable)
      .where(eq(contextsTable.id, id))
      .limit(1);
    expect(after[0]?.deletedAt).toBeNull();
  });

  it('feature disabled → 503 context.disabled', async () => {
    const id = await createOne();
    process.env.MOSAIQ_CONTEXT_MASTER_KEY = '';
    process.env.MOSAIQ_INTERNAL_HMAC_SECRET = '';
    resetEnvCache();
    const app = createApp();
    const resp = await app.request(`/v1/contexts/${id}`, {
      method: 'DELETE',
      headers: authH(),
    });
    expect(resp.status).toBe(503);
  });

  it('no auth → 401', async () => {
    const app = createApp();
    const resp = await app.request('/v1/contexts/ctx_xxx', { method: 'DELETE' });
    expect(resp.status).toBe(401);
  });
});
