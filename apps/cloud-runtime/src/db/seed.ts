/**
 * Dev/Test 种子：按 env 创建一个 project + 一个 API key。
 *
 * 调用时机：
 *   - `pnpm seed`：手工把 SEED_API_KEY 灌进 DB，方便本地调试不每次重置
 *   - 启动时 `index.ts` 也会调一次（仅在 NODE_ENV !== 'production' 时）
 *
 * Prod 安全：
 *   - env.ts 强制 NODE_ENV=production 时 SEED_API_KEY 必须为空
 *   - 所以 prod 下本函数实际不会写入任何 key
 */

import { eq } from 'drizzle-orm';

import { loadEnv } from '../env.js';
import { sha256Hex } from '../utils/hash.js';
import { newId } from '../utils/ids.js';
import { getLogger } from '../utils/logger.js';
import { getDb } from './client.js';
import { apiKeys, projects } from './schema.js';

export interface SeedResult {
  /** 已存在 / 已被使用过的 project（不重置） */
  projectId: string;
  /** 'created' | 'exists'：本次启动是否真的创建了 seed key */
  apiKey: 'created' | 'exists' | 'skipped';
}

export async function seedDevAuth(): Promise<SeedResult> {
  const env = loadEnv();
  const log = getLogger();

  if (!env.SEED_API_KEY) {
    log.debug({ projectId: env.SEED_PROJECT_ID }, 'no SEED_API_KEY, skip seed');
    return { projectId: env.SEED_PROJECT_ID, apiKey: 'skipped' };
  }

  const handle = await getDb();
  const db = handle.drizzle;

  // upsert project
  const existingProj = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, env.SEED_PROJECT_ID))
    .limit(1);
  if (existingProj.length === 0) {
    await db.insert(projects).values({
      id: env.SEED_PROJECT_ID,
      name: env.SEED_PROJECT_ID,
    });
    log.info({ projectId: env.SEED_PROJECT_ID }, 'seed: created project');
  }

  // upsert api key (by hash)
  const keyHash = sha256Hex(env.SEED_API_KEY);
  const existingKey = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (existingKey.length > 0) {
    return { projectId: env.SEED_PROJECT_ID, apiKey: 'exists' };
  }

  await db.insert(apiKeys).values({
    id: newId('apk'),
    projectId: env.SEED_PROJECT_ID,
    keyHash,
    prefix: env.SEED_API_KEY.slice(0, 20),
  });

  log.warn(
    { projectId: env.SEED_PROJECT_ID, prefix: env.SEED_API_KEY.slice(0, 20) },
    'seed: API key created. KEEP THIS OUT OF PROD.',
  );

  return { projectId: env.SEED_PROJECT_ID, apiKey: 'created' };
}

// 直接 `tsx src/db/seed.ts` 运行
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { ensureSchema } = await import('./bootstrap.js');
  await ensureSchema();
  const result = await seedDevAuth();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
