import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { resetEnvCache } from '../env.js';
import { disposeDb, getDb } from './client.js';
import { ensureDefaultPersonas, ensureSchema } from './bootstrap.js';

describe('ensureSchema', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'sqlite::memory:';
    process.env.SEED_API_KEY = '';
    resetEnvCache();
  });

  afterEach(async () => {
    await disposeDb();
  });

  it('幂等：跑两次不抛错', async () => {
    await ensureSchema();
    await ensureSchema();
    const handle = await getDb();
    const rows = handle.drizzle.all(
      sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ) as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const t of [
      'projects',
      'api_keys',
      'sessions',
      'personas',
      'usage_events',
      'audit_events',
    ]) {
      expect(names).toContain(t);
    }
  });

  /**
   * Phase 11.5 regression test (导致 v17 prod outage 的根因)：
   *
   * v16 prod DB 已经存在 sessions 表（无 keep_alive 列）→ 部署 v17 时
   * `CREATE TABLE IF NOT EXISTS sessions (...keep_alive...)` 是 no-op，
   * 老 schema 保留。如果新加的 `CREATE INDEX ... (status, keep_alive, ...)`
   * 写在 STATEMENTS 里，会在 COLUMN_ADDITIONS 之前执行 → SQLite 报
   * `no such column: keep_alive` → bootstrap 抛 → 容器 crash-loop。
   *
   * 这个测试模拟"v16 prod DB"：先建一个不带 keep_alive 列的 sessions 表，
   * 然后 ensureSchema() 必须能优雅升级，且最终包含新列 + 新索引。
   */
  it('upgrade 路径：旧 sessions 表（无 keep_alive 列）→ ensureSchema 加列 + 加索引不报错', async () => {
    // 1. 模拟 v16 schema：drop 后建一个没有 keep_alive / signing_key / user_metadata 的老表
    const handle = await getDb();
    handle.drizzle.run(sql`DROP TABLE IF EXISTS sessions`);
    handle.drizzle.run(sql`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
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
    )`);

    // 2. 跑 ensureSchema —— 应当能 ALTER TABLE 加 user_metadata / signing_key / keep_alive
    //    然后才 CREATE INDEX sessions_keepalive_idle_idx，不抛。
    await ensureSchema();

    // 3. 验证：keep_alive 列存在
    const cols = handle.drizzle.all(
      sql`PRAGMA table_info(sessions)`,
    ) as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('keep_alive');
    expect(colNames).toContain('user_metadata');
    expect(colNames).toContain('signing_key');

    // 4. 索引存在
    const idx = handle.drizzle.all(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND name='sessions_keepalive_idle_idx'`,
    ) as Array<{ name: string }>;
    expect(idx).toHaveLength(1);
  });
});

describe('ensureDefaultPersonas (phase 11.4 commit 4a)', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'sqlite::memory:';
    process.env.SEED_API_KEY = '';
    resetEnvCache();
  });

  afterEach(async () => {
    await disposeDb();
  });

  it('fresh DB → 插入 4 行 seed-source personas（与 DEFAULT_PERSONAS 等长）', async () => {
    await ensureSchema();
    await ensureDefaultPersonas();
    const handle = await getDb();
    const rows = handle.drizzle.all(
      sql`SELECT id, source, project_id FROM personas ORDER BY id`,
    ) as Array<{ id: string; source: string; project_id: string | null }>;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.id).toMatch(/^pers_default_/);
      expect(r.source).toBe('seed');
      expect(r.project_id).toBeNull();
    }
  });

  it('幂等：调两次仍然 4 行（不重复插）', async () => {
    await ensureSchema();
    await ensureDefaultPersonas();
    await ensureDefaultPersonas();
    const handle = await getDb();
    const rows = handle.drizzle.all(
      sql`SELECT COUNT(*) AS n FROM personas WHERE source = 'seed' AND project_id IS NULL`,
    ) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(4);
  });

  it('如果已存在任意 seed 行 → 跳过（保留 operator 自定义池）', async () => {
    await ensureSchema();
    const handle = await getDb();
    // operator 手动放了一个自定义 seed persona。
    handle.drizzle.run(
      sql`INSERT INTO personas (id, project_id, source, persona_json) VALUES ('pers_operator_custom', NULL, 'seed', '{}')`,
    );
    await ensureDefaultPersonas();
    const rows = handle.drizzle.all(
      sql`SELECT id FROM personas WHERE source = 'seed' AND project_id IS NULL ORDER BY id`,
    ) as Array<{ id: string }>;
    // 只该有 operator 那一条，4 个 default 都被跳过。
    expect(rows.map((r) => r.id)).toEqual(['pers_operator_custom']);
  });
});
