/**
 * Auth middleware。
 *
 * 接受两种 header（择一）：
 *   - `Authorization: Bearer <plaintext>` —— Mosaiq native
 *   - `X-BB-API-Key: <plaintext>`        —— Browserbase SDK 兼容（phase 11.4）
 *
 * 两个都传且值一致 → OK；都传但值不一致 → ApiError('auth.dual_header', 400)。
 *
 * 任一 header 里的 plaintext 都是 Mosaiq API key（`msq_sk_...`），不是 BB key——
 * 兼容的是协议形状（header name），不是 keyspace。
 *
 *   - plaintext 不出现在 DB（DB 只有 sha256(plaintext)）
 *   - 校验通过后把 (apiKeyId, projectId) 注入 c.set，下游 handler 取
 *   - 校验失败 → ApiError('auth.invalid_key' | 'auth.missing_token' | 'auth.dual_header')
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

/**
 * 从请求 header 中提取 API key plaintext。
 *
 * 顺序：
 *   1. 优先看 `X-BB-API-Key`（不区分大小写）
 *   2. 再看 `Authorization: Bearer <token>`
 *   3. 都没有 → throw auth.missing_token
 *   4. 都有但值不一致 → throw auth.dual_header（400，协议错误，不是 401）
 *   5. 都有且值一致 → 返回该值（容忍重复）
 *
 * 不在这里做长度 / 格式校验，留给 caller。
 */
function extractToken(c: Context): string {
  const bbHeader = (c.req.header('X-BB-API-Key') ?? c.req.header('x-bb-api-key') ?? '').trim();
  const authzHeader = c.req.header('Authorization') ?? c.req.header('authorization') ?? '';
  let bearerToken = '';
  if (authzHeader.toLowerCase().startsWith('bearer ')) {
    bearerToken = authzHeader.slice(7).trim();
  }

  if (bbHeader && bearerToken && bbHeader !== bearerToken) {
    authFailuresTotal.inc({ reason: 'dual_header' });
    throw new ApiError(
      'auth.dual_header',
      'Both X-BB-API-Key and Authorization Bearer headers are set with different tokens; pick one',
    );
  }

  const token = bbHeader || bearerToken;
  if (!token) {
    authFailuresTotal.inc({ reason: 'missing' });
    throw new ApiError(
      'auth.missing_token',
      'missing or malformed Authorization or X-BB-API-Key header',
    );
  }
  return token;
}

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const token = extractToken(c);
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
