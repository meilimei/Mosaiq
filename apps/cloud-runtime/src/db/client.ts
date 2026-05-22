/**
 * Drizzle + better-sqlite3 客户端。
 *
 * **v0.11 只支持 sqlite**。Phase 11.2（Fly 部署）会加 postgres schema 镜像。
 * 这里把方言识别也写好，prod 走 postgres 时立刻报错 + 友好指引升 phase。
 *
 * 我们不用 drizzle-kit migrations 目录管 schema —— 而是在 bootstrap.ts
 * 里用 `CREATE TABLE IF NOT EXISTS` 跑一次。理由：
 *   1) v0 schema 简单，一次性建表足够
 *   2) 避免新人 clone 后忘记跑 drizzle-kit migrate 的人体工程学坑
 *   3) 真正的 schema migration（加字段、改类型）在 phase 11.5 上 Stripe + admin console 时再引入
 */

import path from 'node:path';
import fs from 'node:fs';

import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { loadEnv } from '../env.js';
import { getLogger } from '../utils/logger.js';
import * as schema from './schema.js';

export type Dialect = 'sqlite' | 'postgres';

export interface DbHandle {
  dialect: Dialect;
  drizzle: BetterSQLite3Database<typeof schema>;
  close(): Promise<void>;
}

let cached: DbHandle | null = null;

function detectDialect(url: string): Dialect {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgres';
  if (url.startsWith('sqlite:')) return 'sqlite';
  if (url.endsWith('.db') || url.startsWith('file:')) return 'sqlite';
  throw new Error(
    `DATABASE_URL 无法识别方言（应以 sqlite: 或 postgres:// 开头）: ${url.slice(0, 32)}...`,
  );
}

export async function getDb(): Promise<DbHandle> {
  if (cached) return cached;
  const env = loadEnv();
  const dialect = detectDialect(env.DATABASE_URL);
  const log = getLogger();

  if (dialect === 'postgres') {
    throw new Error(
      'Postgres 在 v0.11 phase 11.1 还未支持，请改用 DATABASE_URL=sqlite:./data/cloud-runtime.db。' +
        ' Postgres schema 计划在 v0.12 phase 11.2 Fly 部署 PR 里加。',
    );
  }

  // sqlite
  const raw = env.DATABASE_URL.replace(/^sqlite:/, '').replace(/^file:\/\//, '');
  // ":memory:" 是 better-sqlite3 的特殊文件名，单元测试路径用这个；
  // path.resolve 会把它误解析成 ./[memory] —— 单独短路。
  const isMemory = raw === ':memory:';
  const filePath = isMemory ? ':memory:' : path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  if (!isMemory) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  log.info({ filePath }, 'opening sqlite');

  // 动态 import 让 prod 镜像若漏装 better-sqlite3 编译产物，错误信息更清晰
  const BetterSqlite = (await import('better-sqlite3')).default;
  const sqlite = new BetterSqlite(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  cached = {
    dialect,
    drizzle: drizzle(sqlite, { schema }),
    async close() {
      sqlite.close();
    },
  };
  return cached;
}

/** 测试 / shutdown 用：清缓存并关闭连接。 */
export async function disposeDb(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = null;
  }
}
