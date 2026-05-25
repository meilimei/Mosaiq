/**
 * listApiKeys admin utility — library form tests.
 *
 * Validates two security invariants:
 *   - returned items NEVER include `plaintext` or `keyHash` fields
 *   - revoked rows are hidden by default; surfacing requires explicit opt-in
 *
 * Tests use in-memory sqlite + resetEnvCache to isolate state between cases,
 * matching create-api-key.test.ts / revoke-api-key.test.ts conventions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { disposeDb } from '../db/client.js';
import { resetEnvCache } from '../env.js';
import { createApiKey } from './create-api-key.js';
import { listApiKeys } from './list-api-keys.js';
import { revokeApiKey } from './revoke-api-key.js';

describe('listApiKeys', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'sqlite::memory:';
    process.env.SEED_API_KEY = '';
    process.env.NODE_ENV = 'production';
    resetEnvCache();
  });

  afterEach(async () => {
    await disposeDb();
  });

  it('lists active keys for a project; never returns plaintext or keyHash', async () => {
    await createApiKey({
      projectId: 'proj_list_alpha',
      plaintext: 'msq_sk_live_aaaaaaaaaaaaaaaaaaaaaa',
    });
    await createApiKey({
      projectId: 'proj_list_alpha',
      plaintext: 'msq_sk_live_bbbbbbbbbbbbbbbbbbbbbb',
    });

    const rows = await listApiKeys({ projectId: 'proj_list_alpha' });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.apiKeyId).toMatch(/^apk_/);
      expect(r.prefix).toMatch(/^msq_sk_live_/);
      expect(r.revokedAt).toBeNull();
      // Belt + suspenders: exhaustively assert the no-leak surface.
      const opaque = r as unknown as Record<string, unknown>;
      expect(opaque.plaintext).toBeUndefined();
      expect(opaque.keyHash).toBeUndefined();
      expect(opaque.key_hash).toBeUndefined();
    }
  });

  it('hides revoked keys by default; includeRevoked=true surfaces them with revokedAt set', async () => {
    const k1 = await createApiKey({
      projectId: 'proj_list_beta',
      plaintext: 'msq_sk_live_aaaaaaaaaaaaaaaaaaaaaa',
    });
    const k2 = await createApiKey({
      projectId: 'proj_list_beta',
      plaintext: 'msq_sk_live_bbbbbbbbbbbbbbbbbbbbbb',
    });
    await revokeApiKey({ apiKeyId: k1.apiKeyId });

    const activeOnly = await listApiKeys({ projectId: 'proj_list_beta' });
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0]?.apiKeyId).toBe(k2.apiKeyId);

    const all = await listApiKeys({ projectId: 'proj_list_beta', includeRevoked: true });
    expect(all).toHaveLength(2);
    const revokedRow = all.find((r) => r.apiKeyId === k1.apiKeyId);
    expect(revokedRow).toBeDefined();
    expect(revokedRow?.revokedAt).not.toBeNull();
  });

  it('returns empty array for an unknown projectId (no synthetic rows / errors)', async () => {
    const rows = await listApiKeys({ projectId: 'proj_does_not_exist' });
    expect(rows).toEqual([]);
  });

  it('does not bleed across projects — separate projectIds yield disjoint key sets', async () => {
    await createApiKey({
      projectId: 'proj_list_gamma',
      plaintext: 'msq_sk_live_cccccccccccccccccccccc',
    });
    await createApiKey({
      projectId: 'proj_list_delta',
      plaintext: 'msq_sk_live_dddddddddddddddddddddd',
    });

    const gamma = await listApiKeys({ projectId: 'proj_list_gamma' });
    const delta = await listApiKeys({ projectId: 'proj_list_delta' });
    expect(gamma).toHaveLength(1);
    expect(delta).toHaveLength(1);
    expect(gamma[0]?.prefix).toBe('msq_sk_live_cccccccc');
    expect(delta[0]?.prefix).toBe('msq_sk_live_dddddddd');
  });
});
