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
