/**
 * GET /v1/metrics —— Prometheus exposition endpoint。
 *
 * # 鉴权
 *
 * 不复用 `bearerAuth`（API key 表）—— scraper 不应该有创建 session 的权限。
 * 用独立的 `METRICS_TOKEN` env，留空时整个 endpoint 返 404（disabled）。
 *
 * Prometheus scrape config:
 *   scrape_configs:
 *     - job_name: mosaiq-cloud-runtime
 *       authorization:
 *         credentials: <METRICS_TOKEN>
 *       static_configs:
 *         - targets: [mosaiq-cloud-runtime.fly.dev]
 *
 * # 为啥放 /v1/metrics 而非 /metrics
 *
 * 走同一 Hono app（少配 1 条 server.on(...)），跟其他 /v1/* path 一致，
 * fly proxy / TLS 一条规则全管。代价是 path 多 3 个字符，可接受。
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  keepaliveSessionsActiveGauge,
  machinePoolEntriesGauge,
  metricsRegistry,
  poolStateGauge,
} from '../metrics.js';
import { getMachineManager } from '../machine/factory.js';

export const metricsRoute = new Hono();

/**
 * Phase 11.3a 用：detect 当前 machine manager 是不是 FlyPooledMachineManager
 * （有 inspectPool 方法）。是的话刷新 machine_pool_entries gauge。
 *
 * 用 duck-typing 而非 instanceof：避免 routes 层硬依赖 fly-pool 模块（在
 * dev/static manager 下用不上，不想拉那段代码）。
 */
interface PoolIntrospectable {
  inspectPool(): { creating: number; stopped: number; consumed: number; evicting: number };
}
function hasInspectPool(mm: unknown): mm is PoolIntrospectable {
  return (
    typeof mm === 'object' &&
    mm !== null &&
    typeof (mm as { inspectPool?: unknown }).inspectPool === 'function'
  );
}

metricsRoute.get('/', async (c) => {
  const env = loadEnv();
  if (!env.METRICS_TOKEN) {
    // disabled：当作不存在
    return c.notFound();
  }

  const authz = c.req.header('Authorization') ?? c.req.header('authorization') ?? '';
  if (!authz.toLowerCase().startsWith('bearer ')) {
    return c.text('Unauthorized', 401);
  }
  const token = authz.slice(7).trim();
  if (token !== env.METRICS_TOKEN) {
    return c.text('Unauthorized', 401);
  }

  // pool_state gauge 在 scrape 时按需刷新（避免起背景定时器）
  try {
    const mm = getMachineManager();
    const cap = await mm.capacity();
    poolStateGauge.set({ state: 'ready' }, cap.ready);
    poolStateGauge.set({ state: 'busy' }, cap.busy);
    poolStateGauge.set({ state: 'cap' }, cap.cap);

    // Phase 11.3a：如果是 FlyPooledMachineManager，额外刷 machine_pool_entries gauge。
    // 拿 creating + stopped 两个有意义的 state；consumed/evicting 是临时态没必要暴露。
    if (hasInspectPool(mm)) {
      const counts = mm.inspectPool();
      machinePoolEntriesGauge.set({ state: 'creating' }, counts.creating);
      machinePoolEntriesGauge.set({ state: 'stopped' }, counts.stopped);
    }
  } catch {
    // mm 抛错就别更新 gauge —— 旧值仍可读，scrape 不能因为 mm 故障失败
  }

  // Phase 11.5: 刷新 keepalive_sessions_active{project_id} gauge。
  // SELECT project_id, count(*) FROM sessions WHERE keep_alive=1 AND status='live' GROUP BY project_id。
  // 注意：reset() 调用让上一次出现但本次没出现的 project_id label 归 0/消失，否则 gauge 会一直
  // 显示陈旧值（比如某 customer 关掉所有 keepAlive 后，仪表板还显示活跃数）。
  try {
    const handle = await getDb();
    const rows = handle.drizzle.all(
      sql`SELECT project_id AS projectId, COUNT(*) AS n FROM sessions WHERE keep_alive = 1 AND status = 'live' GROUP BY project_id`,
    ) as Array<{ projectId: string; n: number }>;
    keepaliveSessionsActiveGauge.reset();
    for (const r of rows) {
      keepaliveSessionsActiveGauge.set({ project_id: r.projectId }, Number(r.n));
    }
  } catch {
    // DB 抛错时保留 gauge 旧值；同 mm 路径同样不让 scrape 失败
  }

  const text = await metricsRegistry.metrics();
  return c.text(text, 200, { 'Content-Type': metricsRegistry.contentType });
});
