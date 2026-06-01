/**
 * Phase 11.6 — `/v1/_internal/contexts/...`：cloud-runtime ↔ pod 内部端点。
 *
 *   GET /v1/_internal/contexts/:id/download?token=<hmac>
 *     pod 拉取加密 blob（fresh session 启动时 mount 进 user-data-dir）
 *
 *   PUT /v1/_internal/contexts/:id/snapshot?token=<hmac>
 *     pod 上传加密 blob（DELETE w/ persist=true 路径触发）
 *
 * **不属于公开 API**——不挂 bearerAuth、不在 OpenAPI、不上限流（pod 完全可信）。
 * 鉴权走 HMAC token：MOSAIQ_INTERNAL_HMAC_SECRET 是 cloud-runtime 与 pod 共享的
 * fly secret；token 5min TTL 防重放；拼 ctxId+op+expiresAt 防换 endpoint 攻击。
 *
 * Pod 不需要持有客户 API key—— design §3 decision 2 + §5.5 discussion。
 *
 * Cloud-runtime 这层**不解密** blob：pod 已经用 master+projectId-derived key
 * AES-GCM 加密好了，我们只是拿 storage backend 落盘 / 流出。这样即使 cloud-runtime
 * 内存被 dump 也拿不到 plaintext context。
 */

import { Readable } from 'node:stream';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';

import { getContextStorage } from '../contexts/storage.js';
import { getDb } from '../db/client.js';
import { contexts as contextsTable } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { contextSnapshotBytes, contextsTotal } from '../metrics.js';
import { verifyInternalToken } from '../utils/crypto.js';
import { ApiError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

export const internalContextsRoute = new Hono();

/**
 * Token 校验 + context 查询的共用前置。
 *
 * Returns context row when valid; throws ApiError otherwise. We do NOT distinguish
 * "context truly absent" from "soft-deleted" to the pod —— both are "no data, treat
 * as fresh boot" (pod 行为一致：fresh user-data-dir，chromium 跑空)。
 *
 * 安全边界：token 仅校验 (ctxId, op, expiresAt) 配对；不带 projectId。攻击者若能
 * 偷到一个 valid token，能读 / 写**那个**特定 ctxId 的 blob，但只 5min。
 * 进一步隔离：token 由 cloud-runtime 在 POST /v1/sessions 处理过 auth + 锁后才发
 * 给 pod，所以攻击向只能是"先攻入 pod 网络流量"，而 pod 与 cloud-runtime 之间走
 * private fly network，外部不可达。
 */
async function verifyAndLoad(
  ctxId: string,
  op: 'download' | 'snapshot',
  token: string | undefined,
): Promise<
  | {
      row: NonNullable<Awaited<ReturnType<typeof loadCtxRow>>>;
      storageKey: string;
      storageBackend: string;
    }
  | { row: null }
> {
  const env = loadEnv();
  if (!env.MOSAIQ_INTERNAL_HMAC_SECRET) {
    // Feature disabled — internal endpoints behave like 401 (don't leak that the
    // feature is disabled vs token wrong; both look like "you don't belong here")
    throw new ApiError('auth.invalid_key', 'internal endpoints disabled');
  }
  if (!token) {
    throw new ApiError('auth.missing_token', 'missing token query param');
  }
  const verify = verifyInternalToken(token, env.MOSAIQ_INTERNAL_HMAC_SECRET, ctxId, op);
  if (!verify.ok) {
    throw new ApiError('auth.invalid_key', `internal token invalid: ${verify.reason}`);
  }

  const row = await loadCtxRow(ctxId);
  if (!row) return { row: null };
  return { row, storageKey: row.storageKey, storageBackend: row.storageBackend };
}

async function loadCtxRow(ctxId: string) {
  const handle = await getDb();
  const rows = await handle.drizzle
    .select()
    .from(contextsTable)
    .where(and(eq(contextsTable.id, ctxId), isNull(contextsTable.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

// ─── GET /:id/download ──────────────────────────────────────────────────────
//
// Pod 在 /control/start 处理流程里发起。404 = empty context（pod 行为：fresh
// chromium，跳 untar）。200 = stream encrypted blob（pod 收到后解密 + untar 到
// userDataDir）。

internalContextsRoute.get('/:id/download', async (c) => {
  const env = loadEnv();
  const ctxId = c.req.param('id');
  const token = c.req.query('token');

  const result = await verifyAndLoad(ctxId, 'download', token);
  if (result.row === null) {
    return c.body(null, 404);
  }
  const { row } = result;

  // Empty context（创建后从未 snapshot）—— 行为同 not_found，让 pod 走 fresh boot。
  // 我们不返 200 + empty body 避免 pod 有歧义（"是空 blob 还是 net 截断了"）。
  if (row.bytes === null || row.bytes === 0) {
    getLogger().info({ ctxId }, 'internal download: empty context, returning 404');
    return c.body(null, 404);
  }

  const storage = await getContextStorage(env.MOSAIQ_CONTEXT_STORAGE_PATH);
  const stream = await storage.read(row.storageKey);
  if (stream === null) {
    // DB 说有 blob，storage 说没有 —— 落盘 / DB 不一致，告警 + 404。
    getLogger().error(
      { ctxId, storageKey: row.storageKey, dbBytes: row.bytes },
      'internal download: DB says present but storage missing',
    );
    contextsTotal.inc({ op: 'download', outcome: 'failed' });
    return c.body(null, 404);
  }

  // Hono 的 c.body() 接受 ReadableStream（web）。Node Readable → web ReadableStream。
  const webStream = Readable.toWeb(stream);
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Length', String(row.bytes));
  contextsTotal.inc({ op: 'download', outcome: 'success' });
  return c.body(webStream as unknown as ReadableStream<Uint8Array>, 200);
});

// ─── PUT /:id/snapshot ──────────────────────────────────────────────────────
//
// Pod 在 chromium killed + tar 完成 + 加密之后发起。Body = encrypted tar.zst
// stream。我们流式落盘（never holds the full blob in memory）。
//
// 大小检查：先看 Content-Length header（pod 知道精确大小）—— 超 limit 直接 413
// 不开始 drain，省 100MB+ 浪费。流式时 storage 后端 写入字节数也复检一遍兜底。

internalContextsRoute.put('/:id/snapshot', async (c) => {
  const env = loadEnv();
  const log = getLogger();
  const ctxId = c.req.param('id');
  const token = c.req.query('token');

  const result = await verifyAndLoad(ctxId, 'snapshot', token);
  if (result.row === null) {
    // 4xx 而不是 404：pod tar 完了发现 context 没了 = 用户 race-deleted；pod 应该
    // log warn，但不要 retry。返 410 gone 比 404 更清晰，但保持简单先 404。
    log.warn({ ctxId }, 'internal snapshot: context not found / soft-deleted');
    contextsTotal.inc({ op: 'snapshot', outcome: 'failed' });
    return c.body(null, 404);
  }
  const { row } = result;

  // Pre-flight size check via Content-Length header
  const contentLength = c.req.header('content-length');
  const maxBytes = env.MOSAIQ_CONTEXT_SIZE_MAX_MB * 1024 * 1024;
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      log.warn(
        { ctxId, declaredBytes, maxBytes },
        'internal snapshot: rejected oversize blob (Content-Length pre-check)',
      );
      contextsTotal.inc({ op: 'snapshot', outcome: 'failed' });
      return c.body(null, 413);
    }
  }

  const reqBody = c.req.raw.body;
  if (!reqBody) {
    return c.body(null, 400);
  }

  // Hono / fetch web ReadableStream → Node Readable for storage.write
  const nodeStream = Readable.fromWeb(
    reqBody as unknown as import('node:stream/web').ReadableStream,
  );

  const storage = await getContextStorage(env.MOSAIQ_CONTEXT_STORAGE_PATH);
  let bytes: number;
  try {
    bytes = await storage.write(row.storageKey, nodeStream);
  } catch (err) {
    log.error({ err, ctxId }, 'internal snapshot: storage write failed');
    contextsTotal.inc({ op: 'snapshot', outcome: 'failed' });
    throw err;
  }

  // 兜底大小检查：pod 上报 Content-Length 可能缺 / 错。
  if (bytes > maxBytes) {
    log.warn(
      { ctxId, bytes, maxBytes },
      'internal snapshot: oversize after streaming, rolling back',
    );
    // Best-effort cleanup; the row keeps its old metadata (bytes/lastSnapshotAt
    // not updated below), so a subsequent download still gets the previous good blob.
    await storage.delete(row.storageKey).catch(() => undefined);
    contextsTotal.inc({ op: 'snapshot', outcome: 'failed' });
    return c.body(null, 413);
  }

  // Extract nonce from blob header (first 12 bytes per crypto.ts wire format).
  // We re-read just those bytes from disk —— way smaller than holding all in memory.
  let encNonceHex: string | null = null;
  try {
    const headerStream = await storage.read(row.storageKey);
    if (headerStream) {
      const header = await readFirstNBytes(headerStream, 12);
      if (header) encNonceHex = header.toString('hex');
    }
  } catch (err) {
    log.warn({ err, ctxId }, 'internal snapshot: failed to read nonce header');
  }

  const nowIso = new Date().toISOString();
  const handle = await getDb();
  await handle.drizzle
    .update(contextsTable)
    .set({
      bytes,
      lastSnapshotAt: nowIso,
      ...(encNonceHex ? { encNonce: encNonceHex } : {}),
    })
    .where(eq(contextsTable.id, ctxId));

  contextsTotal.inc({ op: 'snapshot', outcome: 'success' });
  contextSnapshotBytes.observe(bytes);
  log.info({ ctxId, bytes }, 'internal snapshot: blob persisted');
  return c.body(null, 204);
});

/**
 * Reads the first N bytes of a Readable stream and aborts the rest.
 * Used to extract AES-GCM nonce header without slurping the whole 100MB blob.
 */
async function readFirstNBytes(stream: Readable, n: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let collected = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    chunks.push(buf);
    collected += buf.length;
    if (collected >= n) {
      stream.destroy();
      return Buffer.concat(chunks).subarray(0, n);
    }
  }
  return collected > 0 ? Buffer.concat(chunks).subarray(0, Math.min(n, collected)) : null;
}
