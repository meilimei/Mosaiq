/**
 * List API keys for a project — metadata only, never plaintext or keyHash.
 *
 * Use cases:
 *   - find the right `apiKeyId` before running `revoke-api-key.js`
 *   - audit revoked vs active keys for a project
 *   - confirm a `create-api-key.js --quiet` invocation actually inserted
 *     a row (since --quiet suppresses plaintext echo, the operator wants
 *     a confirmation channel that doesn't depend on stdout JSON)
 *
 * Returns rows sorted by `created_at DESC` (newest first). Revoked rows are
 * excluded by default; pass `--include-revoked` to see them too.
 *
 * Security: this script NEVER prints `keyHash` or plaintext. `prefix` is
 * safe to log (it's only the visible UI label, e.g. `msq_sk_live_aaaaaaaa`).
 *
 * On Fly:
 *   flyctl ssh console -a mosaiq-cloud-runtime -C \
 *     'node dist/admin/list-api-keys.js proj_launchai'
 *   flyctl ssh console -a mosaiq-cloud-runtime -C \
 *     'node dist/admin/list-api-keys.js proj_launchai --include-revoked'
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys } from '../db/schema.js';

export interface ListApiKeysInput {
  projectId: string;
  /** If true, include revoked rows. Default false (active only). */
  includeRevoked?: boolean;
}

export interface ApiKeyListItem {
  apiKeyId: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/**
 * Library form — callable from tests / future admin HTTP endpoint without
 * shelling out. CLI entry below wraps this.
 */
export async function listApiKeys(input: ListApiKeysInput): Promise<ApiKeyListItem[]> {
  await ensureSchema();
  const handle = await getDb();
  const db = handle.drizzle;

  const projCond = eq(apiKeys.projectId, input.projectId);
  const whereCond = input.includeRevoked ? projCond : and(projCond, isNull(apiKeys.revokedAt));

  const rows = await db
    .select({
      id: apiKeys.id,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(whereCond)
    .orderBy(sql`${apiKeys.createdAt} DESC`);

  return rows.map((r) => ({
    apiKeyId: r.id,
    prefix: r.prefix,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt,
    lastUsedAt: r.lastUsedAt,
  }));
}

// CLI entry — direct `node dist/admin/list-api-keys.js <projectId> [--include-revoked]`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const allArgs = process.argv.slice(2);
  const flags = new Set(allArgs.filter((a) => a.startsWith('--')));
  const positional = allArgs.filter((a) => !a.startsWith('--'));

  const projectId = positional[0] ?? process.env.MOSAIQ_PROJECT_ID;
  const includeRevoked =
    flags.has('--include-revoked') || process.env.MOSAIQ_LIST_INCLUDE_REVOKED === '1';

  if (!projectId) {
    console.error('usage: node admin/list-api-keys.js <projectId> [--include-revoked]');
    console.error('   or: MOSAIQ_PROJECT_ID=... node admin/list-api-keys.js [--include-revoked]');
    process.exit(2);
  }

  try {
    const result = await listApiKeys({ projectId, includeRevoked });
    console.log(
      JSON.stringify({ projectId, includeRevoked, count: result.length, keys: result }, null, 2),
    );
    await disposeDb();
    process.exit(0);
  } catch (err) {
    console.error(
      '[admin/list-api-keys] failed:',
      err instanceof Error ? err.message : String(err),
    );
    await disposeDb();
    process.exit(1);
  }
}
