/**
 * Phase 11.6 commit 3 — internal endpoint tests for download / snapshot.
 *
 * Pattern: in-memory sqlite + tmp storage dir + manually crafted HMAC tokens.
 * No bearer auth (these endpoints don't use it).
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { disposeContextStorage, getContextStorage } from '../contexts/storage.js';
import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { contexts as contextsTable, projects } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { resetRateLimitStore } from '../middleware/rate-limit.js';
import { deriveKey, encryptBlob, signInternalToken } from '../utils/crypto.js';

const TEST_PROJECT_ID = 'proj_test';

let tmpStorageRoot: string;
let masterKey: string;
let hmacSecret: string;

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  process.env.PUBLIC_BASE_URL = 'http://localhost:8787';

  masterKey = randomBytes(32).toString('base64');
  hmacSecret = randomBytes(48).toString('base64');
  process.env.MOSAIQ_CONTEXT_MASTER_KEY = masterKey;
  process.env.MOSAIQ_INTERNAL_HMAC_SECRET = hmacSecret;

  // Per-test tmp storage dir; storage path env override
  tmpStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaiq-internal-'));
  process.env.MOSAIQ_CONTEXT_STORAGE_PATH = tmpStorageRoot;

  resetEnvCache();
  resetRateLimitStore();
  disposeContextStorage();
  await ensureSchema();

  const handle = await getDb();
  await handle.drizzle.insert(projects).values({ id: TEST_PROJECT_ID, name: 'test' });
});

afterEach(async () => {
  await disposeDb();
  disposeContextStorage();
  await fs.rm(tmpStorageRoot, { recursive: true, force: true });
});

async function insertContext(opts?: {
  bytes?: number | null;
  storageKey?: string;
  deletedAt?: string | null;
}): Promise<{ id: string; storageKey: string }> {
  const handle = await getDb();
  const id = `ctx_test${Math.random().toString(36).slice(2, 18).padEnd(16, 'x')}`;
  const storageKey = opts?.storageKey ?? `${id}.tar.zst.enc`;
  await handle.drizzle.insert(contextsTable).values({
    id,
    projectId: TEST_PROJECT_ID,
    storageBackend: 'fs',
    storageKey,
    encAlgo: 'aes-256-gcm-v1',
    bytes: opts?.bytes ?? null,
    deletedAt: opts?.deletedAt ?? null,
  });
  return { id, storageKey };
}

// ─── GET /v1/_internal/contexts/:id/download ────────────────────────────────

describe('GET /v1/_internal/contexts/:id/download', () => {
  it('200 + streams blob bytes for populated context', async () => {
    const { id, storageKey } = await insertContext();
    const key = deriveKey(masterKey, TEST_PROJECT_ID);
    const { blob } = encryptBlob(Buffer.from('chromium user-data-dir tarball'), key);
    const storage = await getContextStorage(tmpStorageRoot);
    await storage.write(storageKey, await stream(blob));
    // Manually mark bytes since we bypassed the snapshot endpoint
    const handle = await getDb();
    await handle.drizzle
      .update(contextsTable)
      .set({ bytes: blob.length })
      .where(eq(contextsTable.id, id));

    const token = signInternalToken(hmacSecret, id, 'download');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/download?token=${token}`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(resp.headers.get('Content-Length')).toBe(String(blob.length));

    const recv = Buffer.from(await resp.arrayBuffer());
    expect(recv.equals(blob)).toBe(true);
  });

  it('404 when context bytes is null (empty context, never snapshotted)', async () => {
    const { id } = await insertContext({ bytes: null });
    const token = signInternalToken(hmacSecret, id, 'download');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/download?token=${token}`);
    expect(resp.status).toBe(404);
  });

  it('404 when context soft-deleted', async () => {
    const { id } = await insertContext({
      bytes: 100,
      deletedAt: new Date().toISOString(),
    });
    const token = signInternalToken(hmacSecret, id, 'download');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/download?token=${token}`);
    expect(resp.status).toBe(404);
  });

  it('404 when context id does not exist', async () => {
    const token = signInternalToken(hmacSecret, 'ctx_nonexistent_xxxxxxxxxx', 'download');
    const app = createApp();
    const resp = await app.request(
      `/v1/_internal/contexts/ctx_nonexistent_xxxxxxxxxx/download?token=${token}`,
    );
    expect(resp.status).toBe(404);
  });

  it('401 when token missing', async () => {
    const { id } = await insertContext({ bytes: 100 });
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/download`);
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('auth.missing_token');
  });

  it('401 when token malformed', async () => {
    const { id } = await insertContext({ bytes: 100 });
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/download?token=not.a.valid.token`);
    expect(resp.status).toBe(401);
  });

  it('401 when token signed for a different ctxId', async () => {
    const { id: ctxA } = await insertContext({ bytes: 100 });
    const { id: ctxB } = await insertContext({ bytes: 100 });
    // Token for ctxA, but request ctxB
    const tokenForA = signInternalToken(hmacSecret, ctxA, 'download');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${ctxB}/download?token=${tokenForA}`);
    expect(resp.status).toBe(401);
  });

  it('401 when token signed for "snapshot" op but used on download', async () => {
    const { id } = await insertContext({ bytes: 100 });
    const wrongOp = signInternalToken(hmacSecret, id, 'snapshot');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/download?token=${wrongOp}`);
    expect(resp.status).toBe(401);
  });

  it('401 when token expired', async () => {
    const { id } = await insertContext({ bytes: 100 });
    // Sign with a "now" 10 minutes in the past → token already expired
    const token = signInternalToken(hmacSecret, id, 'download', Date.now() - 10 * 60 * 1000);
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/download?token=${token}`);
    expect(resp.status).toBe(401);
  });

  it('401 when HMAC secret unset (feature disabled)', async () => {
    const { id } = await insertContext({ bytes: 100 });
    const token = signInternalToken(hmacSecret, id, 'download');
    process.env.MOSAIQ_CONTEXT_MASTER_KEY = '';
    process.env.MOSAIQ_INTERNAL_HMAC_SECRET = '';
    resetEnvCache();
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/download?token=${token}`);
    expect(resp.status).toBe(401);
  });
});

// ─── PUT /v1/_internal/contexts/:id/snapshot ────────────────────────────────

describe('PUT /v1/_internal/contexts/:id/snapshot', () => {
  it('204 + persists blob + updates bytes/lastSnapshotAt/encNonce', async () => {
    const { id, storageKey } = await insertContext();
    const key = deriveKey(masterKey, TEST_PROJECT_ID);
    const { blob, nonceHex } = encryptBlob(Buffer.from('snapshotted profile'), key);

    const token = signInternalToken(hmacSecret, id, 'snapshot');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/snapshot?token=${token}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: blob,
    });
    expect(resp.status).toBe(204);

    // Storage now has the blob bytes-for-bytes
    const storage = await getContextStorage(tmpStorageRoot);
    const back = await storage.read(storageKey);
    expect(back).not.toBeNull();
    const recv = await collect(back!);
    expect(recv.equals(blob)).toBe(true);

    // DB row updated
    const handle = await getDb();
    const row = (
      await handle.drizzle.select().from(contextsTable).where(eq(contextsTable.id, id)).limit(1)
    )[0]!;
    expect(row.bytes).toBe(blob.length);
    expect(row.lastSnapshotAt).toBeTruthy();
    expect(row.encNonce).toBe(nonceHex);
  });

  it('413 when Content-Length > MOSAIQ_CONTEXT_SIZE_MAX_MB (pre-flight)', async () => {
    process.env.MOSAIQ_CONTEXT_SIZE_MAX_MB = '1'; // 1 MB cap
    resetEnvCache();
    const { id } = await insertContext();
    const oversize = Buffer.alloc(2 * 1024 * 1024); // 2 MB

    const token = signInternalToken(hmacSecret, id, 'snapshot');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/snapshot?token=${token}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(oversize.length),
      },
      body: oversize,
    });
    expect(resp.status).toBe(413);

    // Pre-flight rejection means storage was NOT written
    const handle = await getDb();
    const row = (
      await handle.drizzle.select().from(contextsTable).where(eq(contextsTable.id, id)).limit(1)
    )[0]!;
    expect(row.bytes).toBeNull();
    expect(row.lastSnapshotAt).toBeNull();
  });

  it('404 when context id does not exist', async () => {
    const token = signInternalToken(hmacSecret, 'ctx_unknown_xxxxxxxxxxxx', 'snapshot');
    const app = createApp();
    const resp = await app.request(
      `/v1/_internal/contexts/ctx_unknown_xxxxxxxxxxxx/snapshot?token=${token}`,
      {
        method: 'PUT',
        body: Buffer.from('data'),
      },
    );
    expect(resp.status).toBe(404);
  });

  it('404 when context soft-deleted', async () => {
    const { id } = await insertContext({ deletedAt: new Date().toISOString() });
    const token = signInternalToken(hmacSecret, id, 'snapshot');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/snapshot?token=${token}`, {
      method: 'PUT',
      body: Buffer.from('data'),
    });
    expect(resp.status).toBe(404);
  });

  it('401 when token signed for "download" used on snapshot', async () => {
    const { id } = await insertContext();
    const wrongOp = signInternalToken(hmacSecret, id, 'download');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/snapshot?token=${wrongOp}`, {
      method: 'PUT',
      body: Buffer.from('data'),
    });
    expect(resp.status).toBe(401);
  });

  it('401 when token forged with wrong secret', async () => {
    const { id } = await insertContext();
    const wrongSecret = randomBytes(48).toString('base64');
    const forged = signInternalToken(wrongSecret, id, 'snapshot');
    const app = createApp();
    const resp = await app.request(`/v1/_internal/contexts/${id}/snapshot?token=${forged}`, {
      method: 'PUT',
      body: Buffer.from('data'),
    });
    expect(resp.status).toBe(401);
  });

  it('repeated snapshots overwrite the blob (atomic replace)', async () => {
    const { id } = await insertContext();
    const key = deriveKey(masterKey, TEST_PROJECT_ID);
    const v1 = encryptBlob(Buffer.from('version 1'), key).blob;
    const v2 = encryptBlob(Buffer.from('version 2 bigger'), key).blob;

    const token = signInternalToken(hmacSecret, id, 'snapshot');
    const app = createApp();
    let resp = await app.request(`/v1/_internal/contexts/${id}/snapshot?token=${token}`, {
      method: 'PUT',
      body: v1,
    });
    expect(resp.status).toBe(204);

    // Second snapshot with a fresh token (same id, op)
    const token2 = signInternalToken(hmacSecret, id, 'snapshot');
    resp = await app.request(`/v1/_internal/contexts/${id}/snapshot?token=${token2}`, {
      method: 'PUT',
      body: v2,
    });
    expect(resp.status).toBe(204);

    const handle = await getDb();
    const row = (
      await handle.drizzle.select().from(contextsTable).where(eq(contextsTable.id, id)).limit(1)
    )[0]!;
    expect(row.bytes).toBe(v2.length);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function stream(buf: Buffer): Promise<import('node:stream').Readable> {
  const { Readable } = await import('node:stream');
  return Readable.from([buf]);
}

async function collect(stream: import('node:stream').Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
