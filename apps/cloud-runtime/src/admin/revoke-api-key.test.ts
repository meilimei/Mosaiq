/**
 * revokeApiKey admin utility — library form tests.
 *
 * Companion to create-api-key.test.ts: validates the lifecycle ending
 * (revoke) after a key is born. Auth middleware already enforces the
 * `revokedAt != null → reject` rule (middleware/auth.ts:57); these tests
 * only cover the DB write contract.
 *
 * Tests use in-memory sqlite + resetEnvCache to isolate state between cases,
 * matching create-api-key.test.ts conventions.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { disposeDb, getDb } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { sha256Hex } from '../utils/hash.js';
import { createApiKey } from './create-api-key.js';
import { revokeApiKey } from './revoke-api-key.js';

describe('revokeApiKey', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'sqlite::memory:';
    process.env.SEED_API_KEY = '';
    process.env.NODE_ENV = 'production';
    resetEnvCache();
  });

  afterEach(async () => {
    await disposeDb();
  });

  it('revokes an active key; sets revokedAt to a parseable ISO + persists in DB', async () => {
    const created = await createApiKey({
      projectId: 'proj_rvk_alpha',
      plaintext: 'msq_sk_live_aaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(created.status).toBe('created');

    const result = await revokeApiKey({ apiKeyId: created.apiKeyId });
    expect(result.status).toBe('revoked');
    expect(result.apiKeyId).toBe(created.apiKeyId);
    expect(result.projectId).toBe('proj_rvk_alpha');
    expect(result.prefix).toBe(created.prefix);
    // ISO format + parseable to a real date in the recent past
    expect(() => new Date(result.revokedAt).toISOString()).not.toThrow();
    expect(new Date(result.revokedAt).getTime()).toBeGreaterThan(Date.now() - 5_000);

    // DB row matches what we returned
    const handle = await getDb();
    const rows = await handle.drizzle
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, created.apiKeyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBe(result.revokedAt);
  });

  it('idempotent: revoking an already-revoked key returns status=already_revoked, does not overwrite timestamp', async () => {
    const created = await createApiKey({
      projectId: 'proj_rvk_beta',
      plaintext: 'msq_sk_live_bbbbbbbbbbbbbbbbbbbbbb',
    });
    const first = await revokeApiKey({ apiKeyId: created.apiKeyId });
    expect(first.status).toBe('revoked');
    const firstTimestamp = first.revokedAt;

    // Sleep so any wrong overwrite would produce a measurably different
    // timestamp.
    await new Promise((r) => setTimeout(r, 15));

    const second = await revokeApiKey({ apiKeyId: created.apiKeyId });
    expect(second.status).toBe('already_revoked');
    expect(second.apiKeyId).toBe(created.apiKeyId);
    expect(second.revokedAt).toBe(firstTimestamp);
  });

  it('returns status=not_found for unknown apiKeyId, does not insert anything', async () => {
    const result = await revokeApiKey({ apiKeyId: 'apk_does_not_exist_xxxxxx' });
    expect(result.status).toBe('not_found');
    expect(result.projectId).toBeNull();
    expect(result.prefix).toBeNull();
    expect(result.revokedAt).toBe('');

    const handle = await getDb();
    const rows = await handle.drizzle.select().from(apiKeys);
    expect(rows).toHaveLength(0);
  });

  it('post-revoke row still has the plaintext hash (revoke is logical, not destructive)', async () => {
    const plaintext = 'msq_sk_live_cccccccccccccccccccccc';
    const created = await createApiKey({
      projectId: 'proj_rvk_gamma',
      plaintext,
    });
    await revokeApiKey({ apiKeyId: created.apiKeyId });

    const handle = await getDb();
    const rows = await handle.drizzle
      .select({ revokedAt: apiKeys.revokedAt, keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, sha256Hex(plaintext)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[0]?.keyHash).toBe(sha256Hex(plaintext));
  });
});
