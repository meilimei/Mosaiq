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
    const cols = handle.drizzle.all(sql`PRAGMA table_info(sessions)`) as Array<{ name: string }>;
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

  /**
   * Phase 11.6 upgrade-path regression test (sustaining the discipline phase 11.5
   * commit 6 outage taught us)：
   *
   * v18 prod DB 已经有 sessions 表（带 keep_alive 列）但**没有** contexts 表，也没有
   * sessions.context_id / sessions.context_persist 列。部署 v19 时：
   *   - STATEMENTS 段必须 CREATE TABLE IF NOT EXISTS contexts（fresh 表，无 ALTER 烦恼）
   *   - COLUMN_ADDITIONS 段必须把 context_id / context_persist 加到 sessions
   *   - INDEX_ADDITIONS 段必须 CREATE INDEX sessions_context_idx + contexts indexes
   *
   * 本测试模拟"v18 prod 现状"：sessions 已有 keep_alive 列 但无 context_id；
   * contexts 表还不存在。ensureSchema() 必须能优雅升级，最终包含全部新结构。
   *
   * 与 phase 11.5 测试的区别：phase 11.5 测的是 v16 → v17（无 keep_alive）；
   * 本测试是 v18 → v19（已有 keep_alive，缺 context_*）。两者都覆盖能让
   * "新 phase 在已运行的旧 schema 上跑通"。
   */
  it('upgrade 路径：v18 sessions 表（有 keep_alive，无 context_id）→ ensureSchema 加列 + 加索引 + 建 contexts 表不报错', async () => {
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
      metadata_json TEXT NOT NULL DEFAULT '{}',
      user_metadata TEXT NOT NULL DEFAULT '{}',
      signing_key TEXT,
      keep_alive INTEGER NOT NULL DEFAULT 0
    )`);
    // contexts table doesn't exist yet — STATEMENTS' CREATE TABLE IF NOT EXISTS will create it

    await ensureSchema();

    // 1. sessions 加了 context_id + context_persist 列
    const sessionCols = handle.drizzle.all(sql`PRAGMA table_info(sessions)`) as Array<{
      name: string;
    }>;
    const sessionColNames = sessionCols.map((c) => c.name);
    expect(sessionColNames).toContain('context_id');
    expect(sessionColNames).toContain('context_persist');
    expect(sessionColNames).toContain('keep_alive'); // 旧列保留

    // 2. contexts 表存在 + 关键列就位
    const ctxCols = handle.drizzle.all(sql`PRAGMA table_info(contexts)`) as Array<{ name: string }>;
    const ctxColNames = ctxCols.map((c) => c.name);
    expect(ctxColNames).toContain('id');
    expect(ctxColNames).toContain('project_id');
    expect(ctxColNames).toContain('storage_backend');
    expect(ctxColNames).toContain('storage_key');
    expect(ctxColNames).toContain('enc_algo');
    expect(ctxColNames).toContain('active_session_id');
    expect(ctxColNames).toContain('deleted_at');

    // 3. 索引就位
    const idx = handle.drizzle.all(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('sessions_context_idx', 'contexts_project_idx', 'contexts_active_session_idx')`,
    ) as Array<{ name: string }>;
    expect(idx.map((r) => r.name).sort()).toEqual([
      'contexts_active_session_idx',
      'contexts_project_idx',
      'sessions_context_idx',
    ]);
  });

  /**
   * Phase 11.7 upgrade-path regression test（延续 phase 11.5/11.6 的迁移纪律）：
   *
   * v19 prod DB 已有 usage_events 表（phase 11.1 起就在）但**没有** reported_at 列。
   * 部署 v20 时：
   *   - STATEMENTS 的 CREATE TABLE IF NOT EXISTS usage_events 是 no-op（表已存在），
   *     所以老 schema（无 reported_at）保留 —— 不能靠它加列。
   *   - COLUMN_ADDITIONS 必须 ALTER TABLE usage_events ADD COLUMN reported_at。
   *   - INDEX_ADDITIONS 的 partial index `WHERE reported_at IS NULL` 必须在 COLUMN_ADDITIONS
   *     之后跑，否则 SQLite 报 `no such column: reported_at` → crash-loop。
   *
   * 本测试模拟"v19 prod 现状"并验证优雅升级。
   */
  it('upgrade 路径：旧 usage_events 表（无 reported_at 列）→ ensureSchema 加列 + 加 partial 索引不报错', async () => {
    const handle = await getDb();
    handle.drizzle.run(sql`DROP TABLE IF EXISTS usage_events`);
    handle.drizzle.run(sql`CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL,
      value INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    // 放一行老数据（无 reported_at），验证 ALTER 后它的 reported_at 默认 NULL（待 report job 捞）。
    handle.drizzle.run(
      sql`INSERT INTO usage_events (id, project_id, kind, value) VALUES ('use_legacy', 'proj_x', 'session.minute', 5)`,
    );

    await ensureSchema();

    // 1. reported_at 列已加
    const cols = handle.drizzle.all(sql`PRAGMA table_info(usage_events)`) as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain('reported_at');

    // 2. 老行的 reported_at = NULL（会被 report job 拾起）
    const legacy = handle.drizzle.all(
      sql`SELECT reported_at FROM usage_events WHERE id = 'use_legacy'`,
    ) as Array<{ reported_at: string | null }>;
    expect(legacy[0]?.reported_at).toBeNull();

    // 3. partial 索引就位
    const idx = handle.drizzle.all(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND name='usage_events_unreported_idx'`,
    ) as Array<{ name: string }>;
    expect(idx).toHaveLength(1);
  });

  /**
   * Phase 11.7b upgrade-path regression：旧 projects 表（无 stripe_customer_id 列）。
   * 老行迁移后 stripe_customer_id 默认 NULL（未接计费），StripeMeterReporter 会拒绝
   * 推送其用量直到运维补上映射。
   */
  it('upgrade 路径：旧 projects 表（无 stripe_customer_id 列）→ ensureSchema 加列，老行默认 NULL', async () => {
    const handle = await getDb();
    handle.drizzle.run(sql`DROP TABLE IF EXISTS projects`);
    handle.drizzle.run(sql`CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    handle.drizzle.run(sql`INSERT INTO projects (id, name) VALUES ('proj_legacy', 'legacy')`);

    await ensureSchema();

    const cols = handle.drizzle.all(sql`PRAGMA table_info(projects)`) as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('stripe_customer_id');

    const legacy = handle.drizzle.all(
      sql`SELECT stripe_customer_id FROM projects WHERE id = 'proj_legacy'`,
    ) as Array<{ stripe_customer_id: string | null }>;
    expect(legacy[0]?.stripe_customer_id).toBeNull();
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
