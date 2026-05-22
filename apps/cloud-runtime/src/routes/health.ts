/**
 * GET /v1/health —— liveness + machine pool 容量。
 *
 * 设计稿 §5.6 形状：
 *   { ok, version, machine_manager, pool: { ready, busy, cap } }
 *
 * 不需要 auth（探针 + 公开监控）。
 */

import { Hono } from 'hono';

import { getMachineManager } from '../machine/factory.js';

export const healthRoute = new Hono();

healthRoute.get('/', async (c) => {
  const mm = getMachineManager();
  const pool = await mm.capacity();
  return c.json({
    ok: true,
    version: '0.11.0',
    machine_manager: mm.kind,
    pool,
  });
});
