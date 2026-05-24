/**
 * GET /v1/health —— liveness + machine pool 容量 + DB 连通性。
 *
 * 设计稿 §5.6 形状：
 *   { ok, version, machine_manager, db: { ok }, pool: { ready, busy, cap } }
 *
 * 不需要 auth（探针 + 公开监控）。
 *
 * 状态码：
 *   - 200 ok=true     —— 全部子系统正常
 *   - 503 ok=false    —— DB 或 mm 任意一项失败（Fly proxy 据此摘流量）
 *
 * 为啥也要 SELECT 1：
 *   控制平面挂载 Fly volume 跑 sqlite，volume mount 失败 / 文件被删 / WAL
 *   journal 损坏时进程还在但所有读写报错。靠 `mm.capacity()` 检测不到这种
 *   情况（mm 走的是 Fly Machines API，跟 sqlite 解耦）。所以加一次 raw
 *   `SELECT 1`，比 ORM 路径更轻 + 比 mock-friendly。
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { getMachineManager } from '../machine/factory.js';

export const healthRoute = new Hono();

healthRoute.get('/', async (c) => {
  // 1) DB liveness —— SELECT 1，不解析返回值
  let dbOk = false;
  let dbError: string | null = null;
  try {
    const handle = await getDb();
    handle.drizzle.all(sql`SELECT 1`);
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  // 2) MachineManager 容量 —— mm.capacity 自身可能抛（Fly API 中断）
  let mmKind: string;
  let pool: Awaited<ReturnType<ReturnType<typeof getMachineManager>['capacity']>> | null = null;
  let mmError: string | null = null;
  try {
    const mm = getMachineManager();
    mmKind = mm.kind;
    pool = await mm.capacity();
  } catch (err) {
    mmKind = 'unknown';
    mmError = err instanceof Error ? err.message : String(err);
  }

  const ok = dbOk && pool !== null;

  return c.json(
    {
      ok,
      version: '0.11.0',
      machine_manager: mmKind,
      db: dbError ? { ok: dbOk, error: dbError } : { ok: dbOk },
      pool,
      ...(mmError ? { mm_error: mmError } : {}),
    },
    ok ? 200 : 503,
  );
});
