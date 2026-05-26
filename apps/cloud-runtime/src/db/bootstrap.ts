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
    user_metadata TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id, opened_at)`,
  `CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (status)`,
  `CREATE INDEX IF NOT EXISTS sessions_machine_idx ON sessions (machine_id)`,

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
    ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
];

export async function ensureSchema(): Promise<void> {
  const handle = await getDb();
  const log = getLogger();
  for (const stmt of STATEMENTS) {
    handle.drizzle.run(sql.raw(stmt));
  }

  for (const { table, column, alterSql } of COLUMN_ADDITIONS) {
    const cols = handle.drizzle.all(
      sql.raw(`PRAGMA table_info(${table})`),
    ) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      handle.drizzle.run(sql.raw(alterSql));
      log.info({ table, column }, 'schema migrated: column added');
    }
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
