import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { resetEnvCache } from '../env.js';
import { disposeDb, getDb } from './client.js';
import { ensureSchema } from './bootstrap.js';

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
