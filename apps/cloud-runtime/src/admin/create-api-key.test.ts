/**
 * createApiKey admin utility — library form tests.
 *
 * Phase 11.2 prod bootstrap path: env.ts forbids SEED_API_KEY in production
 * but the control plane still needs at least one API key. createApiKey is
 * the inverse: takes (projectId, optional plaintext) and writes a project +
 * api_keys row directly, bypassing env-driven seed.
 *
 * Tests use in-memory sqlite + resetEnvCache to isolate state between cases.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys, projects } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { sha256Hex } from '../utils/hash.js';
import { createApiKey } from './create-api-key.js';

describe('createApiKey', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'sqlite::memory:';
    process.env.SEED_API_KEY = '';
    process.env.NODE_ENV = 'production'; // prod-shaped env, no seed key
    resetEnvCache();
  });

  afterEach(async () => {
    await disposeDb();
  });

  it('creates a new project + key when neither exists; returns plaintext exactly once', async () => {
    const result = await createApiKey({
      projectId: 'proj_test_alpha',
      plaintext: 'msq_sk_live_aaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(result.status).toBe('created');
    expect(result.projectId).toBe('proj_test_alpha');
    expect(result.apiKeyId).toMatch(/^apk_/);
    expect(result.prefix).toBe('msq_sk_live_aaaaaaaa');
    expect(result.plaintext).toBe('msq_sk_live_aaaaaaaaaaaaaaaaaaaaaa');

    const handle = await getDb();
    const projRows = await handle.drizzle
      .select()
      .from(projects)
      .where(eq(projects.id, 'proj_test_alpha'));
    expect(projRows).toHaveLength(1);

    const keyRows = await handle.drizzle
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, sha256Hex(result.plaintext!)));
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]!.projectId).toBe('proj_test_alpha');
  });

  it('idempotent: same plaintext twice returns status=exists, no plaintext echoed', async () => {
    const first = await createApiKey({
      projectId: 'proj_test_beta',
      plaintext: 'msq_sk_live_bbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(first.status).toBe('created');

    const second = await createApiKey({
      projectId: 'proj_test_beta',
      plaintext: 'msq_sk_live_bbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(second.status).toBe('exists');
    expect(second.apiKeyId).toBe(first.apiKeyId);
    expect(second.plaintext).toBeUndefined();

    const handle = await getDb();
    const keyRows = await handle.drizzle.select().from(apiKeys);
    expect(keyRows).toHaveLength(1);
  });

  it('existing project + new key: does not duplicate project row', async () => {
    const handle = await getDb();
    await ensureSchema();
    await handle.drizzle.insert(projects).values({ id: 'proj_test_gamma', name: 'pre-existing' });

    const result = await createApiKey({
      projectId: 'proj_test_gamma',
      plaintext: 'msq_sk_live_cccccccccccccccccccccc',
      projectName: 'should-be-ignored', // we won't overwrite existing project name
    });
    expect(result.status).toBe('created');

    const projRows = await handle.drizzle
      .select()
      .from(projects)
      .where(eq(projects.id, 'proj_test_gamma'));
    expect(projRows).toHaveLength(1);
    expect(projRows[0]!.name).toBe('pre-existing');
  });

  it('generates a fresh msq_sk_live_<22> when plaintext omitted', async () => {
    const result = await createApiKey({
      projectId: 'proj_test_delta',
    });
    expect(result.status).toBe('created');
    expect(result.plaintext).toMatch(/^msq_sk_live_[A-HJ-NP-Za-km-z2-9]{22}$/);
    expect(result.prefix).toBe(result.plaintext!.slice(0, 20));
  });

  it('rejects too-short plaintext', async () => {
    await expect(
      createApiKey({
        projectId: 'proj_test_epsilon',
        plaintext: 'too_short',
      }),
    ).rejects.toThrow(/too short/);
  });
});
