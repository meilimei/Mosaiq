/**
 * Schema bootstrap：启动时一次性建表。
 *
 * 我们故意不用 drizzle-kit migrations，理由见 `db/client.ts` 注释。
 * 等 phase 11.5 真正开始改 schema 时再切到 drizzle-kit。
 *
 * 此函数幂等：所有 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。
 */

import { sql } from 'drizzle-orm';

import { DEFAULT_PERSONAS } from '../seed/default-personas.js';
import { getLogger } from '../utils/logger.js';
import { getDb } from './client.js';

const STATEMENTS: string[] = [
  // projects
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    stripe_customer_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // api_keys
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT,
    last_used_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_uq ON api_keys (key_hash)`,
  `CREATE INDEX IF NOT EXISTS api_keys_project_idx ON api_keys (project_id)`,

  // sessions
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    persona_id TEXT,
    machine_id TEXT NOT NULL,
    status TEXT NOT NULL,
    cdp_internal_url TEXT NOT NULL,
    cdp_public_url TEXT NOT NULL,
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    client_addr TEXT,
    client_label TEXT,
    error_message TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    user_metadata TEXT NOT NULL DEFAULT '{}',
    signing_key TEXT,
    keep_alive INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id, opened_at)`,
  `CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (status)`,
  `CREATE INDEX IF NOT EXISTS sessions_machine_idx ON sessions (machine_id)`,
  // NOTE phase 11.5: sessions_keepalive_idle_idx is intentionally **not here**.
  // It references the keep_alive column which was added via COLUMN_ADDITIONS in
  // phase 11.5. STATEMENTS runs BEFORE COLUMN_ADDITIONS, so on an upgrade path
  // (existing prod DB w/ old sessions table; CREATE TABLE IF NOT EXISTS is a
  // no-op), the column doesn't exist yet at this point and `CREATE INDEX (...keep_alive...)`
  // would fail with `no such column: keep_alive`. Index creation lives in
  // INDEX_ADDITIONS below, which runs AFTER COLUMN_ADDITIONS adds the column.
  // bootstrap.test.ts has a regression test for this upgrade ordering.

  // personas
  `CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    persona_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS personas_project_idx ON personas (project_id)`,
  `CREATE INDEX IF NOT EXISTS personas_source_idx ON personas (source)`,

  // usage_events
  `CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    kind TEXT NOT NULL,
    value INTEGER NOT NULL,
    ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reported_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS usage_events_project_ts_idx ON usage_events (project_id, ts)`,
  `CREATE INDEX IF NOT EXISTS usage_events_session_idx ON usage_events (session_id)`,

  // audit_events
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    api_key_id TEXT,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    result TEXT NOT NULL,
    ip TEXT,
    ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    detail_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS audit_events_project_ts_idx ON audit_events (project_id, ts)`,
  `CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action)`,

  // contexts (Phase 11.6) — see docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md §4.1.
  // Indexes for this table go in INDEX_ADDITIONS below — same pattern phase 11.5
  // commit 6 hotfix established (referencing tables in indexes that may not
  // exist on prod-existing-DB upgrade paths must run AFTER the COLUMN_ADDITIONS
  // pass would have added them; for this fresh table the table itself is here).
  `CREATE TABLE IF NOT EXISTS contexts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    storage_backend TEXT NOT NULL DEFAULT 'fs',
    storage_key TEXT NOT NULL,
    enc_algo TEXT NOT NULL DEFAULT 'aes-256-gcm-v1',
    enc_nonce TEXT,
    bytes INTEGER,
    active_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    active_session_acquired_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_snapshot_at TEXT,
    deleted_at TEXT
  )`,
];

/**
 * Phase 11.4: 轻量"列添加"迁移。给已存在的 prod DB 补上 phase 11.4 之前
 * 没有的列。SQLite 的 `ALTER TABLE ADD COLUMN` 不幂等（重跑报 duplicate
 * column name），所以先 PRAGMA 查列，缺了才 ALTER。
 *
 * 等 phase 11.5 引入 drizzle-kit 后这块换成正经 migrations。
 */
const COLUMN_ADDITIONS: ReadonlyArray<{
  table: string;
  column: string;
  alterSql: string;
}> = [
  {
    table: 'sessions',
    column: 'user_metadata',
    alterSql: `ALTER TABLE sessions ADD COLUMN user_metadata TEXT NOT NULL DEFAULT '{}'`,
  },
  {
    // Phase 11.4 commit 4c: per-session signing key for connectUrl ?token=
    // auth (Stagehand SDK compat). Nullable — pre-existing live sessions in
    // prod won't have one and can keep using Bearer-header auth.
    table: 'sessions',
    column: 'signing_key',
    alterSql: `ALTER TABLE sessions ADD COLUMN signing_key TEXT`,
  },
  {
    // Phase 11.5: keepAlive flag. NOT NULL DEFAULT 0 preserves the phase 11.3a
    // single-use invariant on any pre-existing row (they all become keepAlive=false
    // i.e. destroy-on-close, identical to phase 11.4 behavior). New keepAlive=true
    // sessions opt into the long-session lifecycle.
    // See docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md §5 for the carve-out matrix.
    table: 'sessions',
    column: 'keep_alive',
    alterSql: `ALTER TABLE sessions ADD COLUMN keep_alive INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // Phase 11.6: link session to its bound context. Nullable FK — pre-existing
    // sessions migrate to NULL (no context, phase 11.4a behavior). Note we do
    // NOT add the FOREIGN KEY constraint via ALTER (sqlite cannot add FK after
    // table creation); the schema.ts drizzle definition declares it for fresh
    // tables, and runtime joins are checked at the application layer anyway.
    // See docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md §4.2.
    table: 'sessions',
    column: 'context_id',
    alterSql: `ALTER TABLE sessions ADD COLUMN context_id TEXT`,
  },
  {
    // Phase 11.6: persist flag for context (BB compat browserSettings.context.persist).
    // Default 0 (false) is safe — a row predating phase 11.6 has NULL contextId
    // anyway, so this column is meaningless for it. The CreateSessionSchema
    // validator defaults persist=true on new requests with context.id present.
    table: 'sessions',
    column: 'context_persist',
    alterSql: `ALTER TABLE sessions ADD COLUMN context_persist INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // Phase 11.7: usage-report watermark. NULL = not yet pushed to Stripe Metered.
    // Pre-existing usage_events rows migrate to NULL — the report job will pick
    // them up and push (or, with the default noop reporter, just mark them
    // reported). See docs/PHASE-11.7-USAGE-METERING.md §2.
    table: 'usage_events',
    column: 'reported_at',
    alterSql: `ALTER TABLE usage_events ADD COLUMN reported_at TEXT`,
  },
  {
    // Phase 11.7b: per-project Stripe customer mapping. Nullable — pre-existing
    // projects migrate to NULL (not yet wired to billing). The StripeMeterReporter
    // refuses to push usage for an unmapped project. See docs/PHASE-11.7-USAGE-METERING.md §11.7b.
    table: 'projects',
    column: 'stripe_customer_id',
    alterSql: `ALTER TABLE projects ADD COLUMN stripe_customer_id TEXT`,
  },
];

/**
 * Phase 11.5: indexes added in later phases need to be created on already-bootstrapped
 * DBs too (the STATEMENTS block above only runs for fresh tables via IF NOT EXISTS,
 * but the index itself is still wrapped in IF NOT EXISTS so it's safe to re-run
 * unconditionally on every boot).
 *
 * Why this list exists separately from STATEMENTS: STATEMENTS is the "what does
 * a fresh DB look like" source of truth. INDEX_ADDITIONS is the "what indexes
 * does an existing prod DB need that it might not have yet" list. They overlap
 * but the semantic intent is different and keeping them separate matches the
 * COLUMN_ADDITIONS / STATEMENTS split convention.
 */
const INDEX_ADDITIONS: ReadonlyArray<string> = [
  // Phase 11.5: reaper's keepAlive-idle scan
  `CREATE INDEX IF NOT EXISTS sessions_keepalive_idle_idx ON sessions (status, keep_alive, last_seen_at)`,
  // Phase 11.6: locate sessions by their bound context (release lock on close,
  // find in-flight sessions on context delete attempt). Matches the
  // sessions_context_idx defined in schema.ts.
  `CREATE INDEX IF NOT EXISTS sessions_context_idx ON sessions (context_id)`,
  // Phase 11.6: contexts table indexes. The table itself is in STATEMENTS
  // above, so on a fresh DB the table exists by the time we reach here. On an
  // upgrade DB (existing prod), STATEMENTS' CREATE TABLE IF NOT EXISTS creates
  // the table fresh (it didn't exist pre-11.6), so it's also there. Either
  // way these indexes are safe to run after STATEMENTS.
  `CREATE INDEX IF NOT EXISTS contexts_project_idx ON contexts (project_id)`,
  `CREATE INDEX IF NOT EXISTS contexts_active_session_idx ON contexts (active_session_id)`,
  // Phase 11.7: partial index for the usage-report job's "unreported" scan. Runs
  // AFTER COLUMN_ADDITIONS so reported_at exists on upgrade DBs by now. Partial
  // (WHERE reported_at IS NULL) keeps the index tiny — most rows end up reported.
  `CREATE INDEX IF NOT EXISTS usage_events_unreported_idx ON usage_events (reported_at) WHERE reported_at IS NULL`,
];

export async function ensureSchema(): Promise<void> {
  const handle = await getDb();
  const log = getLogger();
  for (const stmt of STATEMENTS) {
    handle.drizzle.run(sql.raw(stmt));
  }

  for (const { table, column, alterSql } of COLUMN_ADDITIONS) {
    const cols = handle.drizzle.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === column)) {
      handle.drizzle.run(sql.raw(alterSql));
      log.info({ table, column }, 'schema migrated: column added');
    }
  }

  // Index additions are idempotent (CREATE INDEX IF NOT EXISTS), so we can just
  // run them unconditionally. Cheap on every boot — SQLite checks sqlite_master.
  for (const stmt of INDEX_ADDITIONS) {
    handle.drizzle.run(sql.raw(stmt));
  }

  log.info({ tables: 6 }, 'schema ensured');
}

/**
 * Phase 11.4 commit 4a: idempotently seed the default persona pool so that
 * `bb.sessions.create({})` (Stagehand SDK's empty-body pattern) can fall back
 * to a hardcoded persona instead of returning 422.
 *
 * Semantics: if there is **any** `source='seed' AND project_id IS NULL` row
 * already, do nothing (operator may have curated their own set). Otherwise,
 * insert all entries from `DEFAULT_PERSONAS` in a single pass.
 *
 * Kept separate from `ensureSchema()` so existing tests don't get seeded
 * personas unless they opt in by calling this explicitly. Production startup
 * (`src/index.ts`) calls both in sequence.
 */
export async function ensureDefaultPersonas(): Promise<void> {
  const handle = await getDb();
  const log = getLogger();

  const rows = handle.drizzle.all(
    sql`SELECT COUNT(*) AS n FROM personas WHERE source = 'seed' AND project_id IS NULL`,
  ) as Array<{ n: number }>;
  const existing = rows[0]?.n ?? 0;
  if (existing > 0) {
    log.info({ existing }, 'default personas already seeded; skipping');
    return;
  }

  for (const seed of DEFAULT_PERSONAS) {
    handle.drizzle.run(
      sql`INSERT INTO personas (id, project_id, source, persona_json) VALUES (${seed.dbId}, NULL, 'seed', ${JSON.stringify(seed.persona)})`,
    );
  }
  log.info({ seeded: DEFAULT_PERSONAS.length }, 'default personas seeded');
}
