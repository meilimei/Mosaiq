/**
 * Phase 11.7: usage metering emitter —— 计费埋点的唯一写入口。
 *
 * `usage_events` 表从 phase 11.1 就建好了但一直没有 writer。这里给 session
 * 生命周期提供 browser-minutes 落账：session 关闭时记一条 `session.minute`。
 *
 * 设计选择（见 docs/PHASE-11.7-USAGE-METERING.md §3）：
 *
 *   - `computeBillableMinutes` 是纯函数，单测覆盖取整 / 时钟漂移 边界，不碰 DB。
 *
 *   - `recordUsage` 由调用方 **await**（计费事件不可丢，区别于 fire-and-forget
 *     的 audit()）。单条 indexed insert ~ms，DELETE / reaper 都能承受这点延迟，
 *     换来"绝不静默丢账单"。失败抛错由调用方决定吞/记（两处调用都在 best-effort
 *     区，warn 即可——session row 仍在，可事后补账）。
 *
 *   - `reported_at` 留 NULL —— 待 phase 11.7 commit 3 的 usage-report job 推送
 *     Stripe Metered 后回填。
 */

import type { DbHandle } from '../db/client.js';
import { usageEvents } from '../db/schema.js';
import { usageMinutesTotal } from '../metrics.js';
import { newId } from '../utils/ids.js';

/** Phase 11.7a 只此一种 kind；11.7b 加 'persona.checkout' / 'proxy.gb'。 */
export type UsageKind = 'session.minute';

/**
 * 从 session 的 open/close 时间戳算 billable 分钟数。
 *
 *   - **向上取整**：per-session 计费增量 = 1 分钟，直接乘单价即营收（匹配 $0.06/min）。
 *   - **最小 1 分钟**：任何开过的 session 至少计 1 分钟（同多数云厂商最小计费增量）。
 *   - **保守兜底**：时钟漂移 / 同毫秒关闭（ms <= 0 或 NaN）→ 计 1 分钟，绝不计 0 或负。
 */
export function computeBillableMinutes(openedAtIso: string, closedAtIso: string): number {
  const ms = Date.parse(closedAtIso) - Date.parse(openedAtIso);
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / 60_000));
}

/**
 * 写一条 usage_event。调用方必须 await —— 计费事件不可丢。
 *
 * `ts` **显式**写 ISO-8601（`toISOString()`），不依赖 sqlite 的 CURRENT_TIMESTAMP
 * 默认（后者是 `YYYY-MM-DD HH:MM:SS` 空格分隔、无时区，字典序 ≠ 时间序，且无法
 * 与 GET /v1/usage 的 ISO from/to 参数正确比较）。这与 sessions.openedAt 等全表
 * 一致的"app 显式写 ISO"约定对齐。`reported_at` 默认 NULL（待 report job）。
 */
export async function recordUsage(
  db: DbHandle,
  opts: {
    projectId: string;
    sessionId?: string | null;
    kind: UsageKind;
    /** 计费数值。kind='session.minute' 时是 billable 分钟数。 */
    value: number;
  },
): Promise<void> {
  await db.drizzle.insert(usageEvents).values({
    id: newId('use'),
    projectId: opts.projectId,
    sessionId: opts.sessionId ?? null,
    kind: opts.kind,
    value: opts.value,
    ts: new Date().toISOString(),
  });
  // Phase 11.7 commit 4: 累加 billable 分钟 counter（仅 session.minute；其他 kind
  // 走各自的 metric，11.7b 加）。inc 在 insert 之后——只有真落库的用量才计数。
  if (opts.kind === 'session.minute') {
    usageMinutesTotal.inc({ project_id: opts.projectId }, opts.value);
  }
}
