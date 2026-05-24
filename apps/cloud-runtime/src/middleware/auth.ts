/**
 * Bearer auth middleware。
 *
 * 期望 header: `Authorization: Bearer <plaintext>`
 *   - plaintext 不出现在 DB（DB 只有 sha256(plaintext)）
 *   - 校验通过后把 (apiKeyId, projectId) 注入 c.set，下游 handler 取
 *   - 校验失败 → ApiError('auth.invalid_key' | 'auth.missing_token')
 *   - 同时把 last_used_at 异步刷新（不阻塞响应）
 *
 * Hono 的 jwt / bearer middleware 都没法直接配 sha256+DB 流程，自己实现。
 */

import type { Context, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { authFailuresTotal } from '../metrics.js';
import { ApiError } from '../utils/errors.js';
import { sha256Hex } from '../utils/hash.js';
import { getLogger } from '../utils/logger.js';

export interface AuthContext {
  apiKeyId: string;
  projectId: string;
}

const AUTH_KEY = 'mosaiq:auth' as const;

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const authz = c.req.header('Authorization') ?? c.req.header('authorization');
  if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
    authFailuresTotal.inc({ reason: 'missing' });
    throw new ApiError('auth.missing_token', 'missing or malformed Authorization header');
  }
  const token = authz.slice(7).trim();
  if (token.length < 8) {
    authFailuresTotal.inc({ reason: 'invalid' });
    throw new ApiError('auth.invalid_key', 'token too short');
  }

  const handle = await getDb();
  const db = handle.drizzle;
  const tokenHash = sha256Hex(token);

  const rows = await db
    .select({ id: apiKeys.id, projectId: apiKeys.projectId, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) {
    authFailuresTotal.inc({ reason: 'invalid' });
    throw new ApiError('auth.invalid_key', 'unknown API key');
  }
  if (row.revokedAt) {
    authFailuresTotal.inc({ reason: 'revoked' });
    throw new ApiError('auth.invalid_key', 'API key revoked', { revokedAt: row.revokedAt });
  }

  c.set(AUTH_KEY, { apiKeyId: row.id, projectId: row.projectId } as AuthContext);

  // best-effort last-used update
  Promise.resolve().then(async () => {
    try {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiKeys.id, row.id));
    } catch (err) {
      getLogger().debug({ err }, 'last_used_at update failed');
    }
  });

  await next();
};

export function getAuth(c: Context): AuthContext {
  const ctx = c.get(AUTH_KEY) as AuthContext | undefined;
  if (!ctx) {
    throw new ApiError('auth.missing_token', 'auth context not set; bearerAuth not applied?');
  }
  return ctx;
}
