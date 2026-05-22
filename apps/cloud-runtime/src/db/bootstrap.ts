/**
 * Schema bootstrap：启动时一次性建表。
 *
 * 我们故意不用 drizzle-kit migrations，理由见 `db/client.ts` 注释。
 * 等 phase 11.5 真正开始改 schema 时再切到 drizzle-kit。
 *
 * 此函数幂等：所有 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。
 */

import { sql } from 'drizzle-orm';

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
    metadata_json TEXT NOT NULL DEFAULT '{}'
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

export async function ensureSchema(): Promise<void> {
  const handle = await getDb();
  const log = getLogger();
  for (const stmt of STATEMENTS) {
    handle.drizzle.run(sql.raw(stmt));
  }
  log.info({ tables: 6 }, 'schema ensured');
}
