/**
 * Phase 11.7: usage 聚合查询 —— GET /v1/usage 端点与 report job 共用。
 *
 * 设计（见 docs/PHASE-11.7-USAGE-METERING.md §4.2）：
 *   - half-open 区间 [fromIso, toIso)：to 独占上界，便于按自然月/日切片不重不漏。
 *   - SQL SUM + GROUP BY kind，命中 usage_events_project_ts_idx (project_id, ts)。
 *   - ts 是 ISO-8601（recordUsage 显式写），字典序 = 时间序，可直接与 ISO 参数比较。
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';

import type { DbHandle } from '../db/client.js';
import { usageEvents } from '../db/schema.js';
import type { UsageKind } from './emitter.js';

export type UsageTotals = Partial<Record<UsageKind, number>>;

/**
 * 聚合某 project 在 [fromIso, toIso) 内按 kind 求和的用量。
 *
 * 返回只含实际有数据的 kind（GROUP BY 不返空组）；调用方按需补 0。
 */
export async function aggregateUsage(
  db: DbHandle,
  projectId: string,
  fromIso: string,
  toIso: string,
): Promise<UsageTotals> {
  const rows = await db.drizzle
    .select({
      kind: usageEvents.kind,
      total: sql<number>`SUM(${usageEvents.value})`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.projectId, projectId),
        gte(usageEvents.ts, fromIso),
        lt(usageEvents.ts, toIso),
      ),
    )
    .groupBy(usageEvents.kind);

  const out: UsageTotals = {};
  for (const r of rows) {
    out[r.kind as UsageKind] = Number(r.total ?? 0);
  }
  return out;
}

/**
 * 当前自然月（UTC）的 [start, nextMonthStart) 区间，作为 GET /v1/usage 的默认窗口。
 */
export function currentMonthWindowUtc(now: Date = new Date()): { fromIso: string; toIso: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}
