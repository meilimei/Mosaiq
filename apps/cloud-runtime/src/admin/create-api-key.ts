/**
 * Bootstrap a production API key.
 *
 * Use case: first-time `flyctl deploy` of cloud-runtime in `NODE_ENV=production`
 * mode. env.ts forbids SEED_API_KEY in production (so seed.ts is effectively
 * a no-op on Fly), but the control plane still needs at least one valid
 * `Bearer` key for clients to call /v1/sessions. This admin utility inserts
 * one directly into the prod sqlite, prints the plaintext exactly once,
 * then exits.
 *
 * On Fly:
 *   flyctl ssh console -a mosaiq-cloud-runtime -C \
 *     'node dist/admin/create-api-key.js proj_launchai'
 *
 * If the second positional arg is supplied, it is used as the plaintext key
 * verbatim (so external systems can pre-generate). Otherwise a fresh
 * `msq_sk_live_<22>` is generated via newApiKey().
 *
 * Idempotent: re-running with the same plaintext (or its sha256) is a no-op
 * and reports `status: "exists"` without printing the plaintext (since we
 * never store it).
 *
 * SECURITY: the only line of stdout containing the plaintext is the JSON
 * `plaintext` field. Pipe to file or `--mask` carefully; the key is NOT
 * recoverable from the DB after this command exits.
 */

import { eq } from 'drizzle-orm';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys, projects } from '../db/schema.js';
import { sha256Hex } from '../utils/hash.js';
import { newApiKey, newId } from '../utils/ids.js';

export interface CreateApiKeyInput {
  projectId: string;
  /** Plaintext to use verbatim. If omitted, a fresh `msq_sk_live_<22>` is generated. */
  plaintext?: string;
  /** Used only when the project does not yet exist; defaults to projectId. */
  projectName?: string;
}

export interface CreateApiKeyResult {
  projectId: string;
  apiKeyId: string;
  /** First ~20 chars of plaintext, safe to store in DB / log / dashboard. */
  prefix: string;
  /** Plaintext, present ONLY when status === 'created'. */
  plaintext?: string;
  status: 'created' | 'exists';
}

/**
 * Library form: callable from tests / future admin HTTP endpoint without
 * shelling out. CLI entry below just wraps this.
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  await ensureSchema();
  const handle = await getDb();
  const db = handle.drizzle;

  // upsert project — same shape as seed.ts but with explicit projectName.
  const existingProj = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (existingProj.length === 0) {
    await db.insert(projects).values({
      id: input.projectId,
      name: input.projectName ?? input.projectId,
    });
  }

  // Determine plaintext + prefix.
  let plaintext: string;
  let prefix: string;
  if (input.plaintext !== undefined) {
    if (input.plaintext.length < 24) {
      throw new Error(
        `api key plaintext too short (${input.plaintext.length}); need >= 24 chars`,
      );
    }
    plaintext = input.plaintext;
    prefix = plaintext.slice(0, 20);
  } else {
    const generated = newApiKey();
    plaintext = generated.plaintext;
    prefix = generated.prefix;
  }

  const keyHash = sha256Hex(plaintext);
  const existing = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (existing.length > 0 && existing[0]) {
    return {
      projectId: input.projectId,
      apiKeyId: existing[0].id,
      prefix,
      status: 'exists',
    };
  }

  const id = newId('apk');
  await db.insert(apiKeys).values({
    id,
    projectId: input.projectId,
    keyHash,
    prefix,
  });

  return {
    projectId: input.projectId,
    apiKeyId: id,
    prefix,
    plaintext,
    status: 'created',
  };
}

// CLI 入口 — 直接 `node dist/admin/create-api-key.js <projectId> [plaintext] [projectName] [--quiet]`
//
// `--quiet` (or `MOSAIQ_QUIET=1`) suppresses the plaintext echo on
// status=created. Only valid when the operator pre-supplied plaintext
// (positional or `MOSAIQ_NEW_API_KEY`) — otherwise we'd silently destroy
// the only copy of a freshly-generated key. The script hard-errors in
// that footgun case so it's caught before disposing the DB.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const allArgs = process.argv.slice(2);
  const flags = new Set(allArgs.filter((a) => a.startsWith('--')));
  const positional = allArgs.filter((a) => !a.startsWith('--'));

  const projectId = positional[0] ?? process.env.MOSAIQ_PROJECT_ID;
  const plaintext = positional[1] ?? process.env.MOSAIQ_NEW_API_KEY;
  const projectName = positional[2] ?? process.env.MOSAIQ_PROJECT_NAME;
  const quiet = flags.has('--quiet') || process.env.MOSAIQ_QUIET === '1';

  if (!projectId) {
    console.error(
      'usage: node admin/create-api-key.js <projectId> [<plaintextKey>] [<projectName>] [--quiet]',
    );
    console.error(
      '   or: MOSAIQ_PROJECT_ID=... [MOSAIQ_NEW_API_KEY=...] [MOSAIQ_PROJECT_NAME=...] [MOSAIQ_QUIET=1] node ...',
    );
    process.exit(2);
  }

  if (quiet && !plaintext) {
    console.error(
      '[admin/create-api-key] --quiet requires a caller-supplied plaintext (positional arg or MOSAIQ_NEW_API_KEY).',
    );
    console.error(
      '  Without plaintext, a fresh key would be generated and silently discarded — refusing to do that.',
    );
    process.exit(2);
  }

  try {
    const result = await createApiKey({ projectId, plaintext, projectName });
    if (result.status === 'created') {
      const payload: Record<string, unknown> = {
        status: 'created',
        projectId: result.projectId,
        apiKeyId: result.apiKeyId,
        prefix: result.prefix,
      };
      if (quiet) {
        payload.note =
          '--quiet: plaintext omitted from stdout (caller-supplied; not echoed)';
      } else {
        payload.plaintext = result.plaintext;
        payload.warning = 'STORE THE PLAINTEXT NOW — IT IS NOT RECOVERABLE';
      }
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(
        JSON.stringify(
          {
            status: 'exists',
            projectId: result.projectId,
            apiKeyId: result.apiKeyId,
            prefix: result.prefix,
          },
          null,
          2,
        ),
      );
    }
    await disposeDb();
    process.exit(0);
  } catch (err) {
    console.error(
      '[admin/create-api-key] failed:',
      err instanceof Error ? err.message : String(err),
    );
    await disposeDb();
    process.exit(1);
  }
}
