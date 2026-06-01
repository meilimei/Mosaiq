/**
 * Phase 11.6 — `/v1/contexts` route：Browserbase Contexts API。
 *
 *   POST   /v1/contexts        创建一个空 context
 *   DELETE /v1/contexts/:id    soft-delete（in-use → 409）
 *
 * 注意：BB 没有 GET /v1/contexts 列表 endpoint，我们 100% match。
 *
 * Session 集成（POST /v1/sessions browserSettings.context）由 commit 4 在
 * routes/sessions.ts 实现，不在本文件。本文件只管 context 资源 CRUD。
 *
 * 见 docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md §5。
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { ensureContextsEnabled } from '../contexts/feature.js';
import { getDb } from '../db/client.js';
import { contexts as contextsTable } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { contextsTotal } from '../metrics.js';
import { audit } from '../middleware/audit.js';
import { getAuth } from '../middleware/auth.js';
import { rateLimitTier } from '../middleware/rate-limit.js';
import { ApiError } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { getLogger } from '../utils/logger.js';

export const contextsRoute = new Hono();

// ─── POST /v1/contexts ──────────────────────────────────────────────────────
//
// BB 契约：body `{}`，response `{ id }`。我们超集回 `{ id, projectId, createdAt }`
// 便于客户端 debug。Body 可以完全为空 OR `{}` —— Hono 的 c.req.json() 在空 body 时
// 抛 SyntaxError，我们 catch 后当成 {} 处理（match BB 行为）。

contextsRoute.post('/', rateLimitTier('write'), async (c) => {
  ensureContextsEnabled();
  const env = loadEnv();
  const auth = getAuth(c);

  // Body 不影响行为（BB 也只是接受 `{}`），但读一下 + ignore 让请求格式对客户端
  // 更宽松（含 trailing whitespace / no-content-type 也行）。
  await c.req.json().catch(() => undefined);

  const handle = await getDb();

  // Quota: 每 project 最大活跃 contexts 数（未 soft-deleted）。
  const activeRows = await handle.drizzle
    .select({ count: sql<number>`count(*)` })
    .from(contextsTable)
    .where(and(eq(contextsTable.projectId, auth.projectId), isNull(contextsTable.deletedAt)));
  const activeCount = Number(activeRows[0]?.count ?? 0);
  if (activeCount >= env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX) {
    audit(c, 'context.create', `project:${auth.projectId}`, 'denied', {
      reason: 'contexts_saturated',
      activeCount,
      quota: env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX,
    });
    contextsTotal.inc({ op: 'create', outcome: 'failed' });
    throw new ApiError(
      'pool.contexts_saturated',
      `project ${auth.projectId} has ${activeCount} active contexts (quota ${env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX}); DELETE an unused context before retrying`,
      { activeCount, quota: env.MOSAIQ_CONTEXTS_PER_PROJECT_MAX },
    );
  }

  const id = newId('ctx');
  // storageKey 由 cloud-runtime 控制 —— 客户**不能**指定，避免 path traversal 攻击向。
  const storageKey = `${id}.tar.zst.enc`;

  await handle.drizzle.insert(contextsTable).values({
    id,
    projectId: auth.projectId,
    storageBackend: 'fs',
    storageKey,
    encAlgo: 'aes-256-gcm-v1',
    // encNonce: null   (initial empty state — first snapshot will populate)
    // bytes: null
    // activeSessionId: null
    // lastSnapshotAt: null
  });

  const row = (
    await handle.drizzle.select().from(contextsTable).where(eq(contextsTable.id, id)).limit(1)
  )[0];

  if (!row) {
    throw new ApiError('internal.unknown', 'context row missing post-insert');
  }

  audit(c, 'context.create', `context:${id}`, 'ok');
  contextsTotal.inc({ op: 'create', outcome: 'success' });
  getLogger().info({ contextId: id, projectId: auth.projectId }, 'context created');

  return c.json(
    {
      id: row.id,
      projectId: row.projectId,
      createdAt: row.createdAt,
    },
    201,
  );
});

// ─── DELETE /v1/contexts/:id ────────────────────────────────────────────────
//
// Soft delete only — sets contexts.deleted_at. Blob 物理 unlink 由 phase 11.6b
// GC job 接管，让 in-flight reads（如某 session 正在 download 装载）能完成。
//
// In-use 检查：active_session_id 不为 NULL → 409 context.in_use，让客户先 DELETE
// session 释放 lock 再删 context。
//
// 幂等：不存在 / 已 soft-deleted 都返 204（match BB 风格）—— 客户重试 DELETE
// 不应该报错。

contextsRoute.delete('/:id', rateLimitTier('write'), async (c) => {
  ensureContextsEnabled();
  const auth = getAuth(c);
  const id = c.req.param('id');
  const handle = await getDb();

  const rows = await handle.drizzle
    .select()
    .from(contextsTable)
    .where(and(eq(contextsTable.id, id), eq(contextsTable.projectId, auth.projectId)))
    .limit(1);
  const row = rows[0];

  if (!row) {
    // 不存在 OR 不属于本 project（不区分 forbidden vs not-found 防资源枚举）
    audit(c, 'context.delete', `context:${id}`, 'ok', { idempotent: true, exists: false });
    return c.body(null, 204);
  }

  if (row.deletedAt) {
    // 已 soft-deleted，幂等 204
    audit(c, 'context.delete', `context:${id}`, 'ok', { idempotent: true, alreadyDeleted: true });
    return c.body(null, 204);
  }

  if (row.activeSessionId) {
    audit(c, 'context.delete', `context:${id}`, 'denied', {
      reason: 'in_use',
      activeSessionId: row.activeSessionId,
    });
    contextsTotal.inc({ op: 'delete', outcome: 'failed' });
    throw new ApiError(
      'context.in_use',
      `context ${id} is currently held by session ${row.activeSessionId}; close the session before deleting the context`,
      {
        activeSessionId: row.activeSessionId,
        acquiredAt: row.activeSessionAcquiredAt,
      },
    );
  }

  await handle.drizzle
    .update(contextsTable)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(contextsTable.id, id));

  audit(c, 'context.delete', `context:${id}`, 'ok');
  contextsTotal.inc({ op: 'delete', outcome: 'success' });
  getLogger().info({ contextId: id, projectId: auth.projectId }, 'context soft-deleted');
  return c.body(null, 204);
});
