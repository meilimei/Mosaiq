/**
 * Revoke an API key by id.
 *
 * Sets `revoked_at = current ISO` on the row. Subsequent `Bearer` auth
 * attempts with this key throw `auth.invalid_key` — see
 * `middleware/auth.ts:57` (it already short-circuits on `row.revokedAt`).
 *
 * Idempotent: revoking an already-revoked key returns
 * `status='already_revoked'` with the previously-recorded timestamp,
 * never overwriting it.
 *
 * Use case: post-rollout cleanup after `admin/create-api-key.js` printed
 * a plaintext to stdout that we now consider compromised (chat history,
 * shared screen, etc.). Operator runs `list-api-keys.js` to find the id,
 * then `revoke-api-key.js <id>`. Replacement key minted via
 * `create-api-key.js --quiet` so no plaintext crosses the chat boundary.
 *
 * On Fly:
 *   flyctl ssh console -a mosaiq-cloud-runtime -C \
 *     'node dist/admin/revoke-api-key.js apk_xxxxxxxxxxxxxxxxxxxxxx'
 */

import { eq } from 'drizzle-orm';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys } from '../db/schema.js';

export interface RevokeApiKeyInput {
  apiKeyId: string;
}

export interface RevokeApiKeyResult {
  apiKeyId: string;
  projectId: string | null;
  prefix: string | null;
  /** ISO timestamp; empty string when status='not_found'. */
  revokedAt: string;
  status: 'revoked' | 'already_revoked' | 'not_found';
}

/**
 * Library form — callable from tests / future admin HTTP endpoint without
 * shelling out. CLI entry below wraps this.
 */
export async function revokeApiKey(input: RevokeApiKeyInput): Promise<RevokeApiKeyResult> {
  await ensureSchema();
  const handle = await getDb();
  const db = handle.drizzle;

  const rows = await db
    .select({
      id: apiKeys.id,
      projectId: apiKeys.projectId,
      prefix: apiKeys.prefix,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, input.apiKeyId))
    .limit(1);

  if (rows.length === 0 || !rows[0]) {
    return {
      apiKeyId: input.apiKeyId,
      projectId: null,
      prefix: null,
      revokedAt: '',
      status: 'not_found',
    };
  }

  const row = rows[0];
  if (row.revokedAt) {
    return {
      apiKeyId: row.id,
      projectId: row.projectId,
      prefix: row.prefix,
      revokedAt: row.revokedAt,
      status: 'already_revoked',
    };
  }

  const nowIso = new Date().toISOString();
  await db.update(apiKeys).set({ revokedAt: nowIso }).where(eq(apiKeys.id, input.apiKeyId));

  return {
    apiKeyId: row.id,
    projectId: row.projectId,
    prefix: row.prefix,
    revokedAt: nowIso,
    status: 'revoked',
  };
}

// CLI entry — direct `node dist/admin/revoke-api-key.js <apiKeyId>`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const apiKeyId = process.argv[2] ?? process.env.MOSAIQ_API_KEY_ID;

  if (!apiKeyId) {
    console.error('usage: node admin/revoke-api-key.js <apiKeyId>');
    console.error('   or: MOSAIQ_API_KEY_ID=apk_... node admin/revoke-api-key.js');
    process.exit(2);
  }

  try {
    const result = await revokeApiKey({ apiKeyId });
    console.log(JSON.stringify(result, null, 2));
    await disposeDb();
    // not_found is an operator error → exit 1; revoked / already_revoked → 0
    process.exit(result.status === 'not_found' ? 1 : 0);
  } catch (err) {
    console.error(
      '[admin/revoke-api-key] failed:',
      err instanceof Error ? err.message : String(err),
    );
    await disposeDb();
    process.exit(1);
  }
}
