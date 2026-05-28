/**
 * Phase 11.7: usage-report job —— 把未上报的 usage_events 推给 MeterReporter。
 *
 * 仿 session-expiry.ts 的结构：纯函数 reportUsage(deps)（完全可单测，注入
 * db/reporter/logger/时间）+ 长跑 wrapper startUsageReportJob（setInterval 胶水 +
 * re-entrant guard + graceful stop）。
 *
 * 每个 tick：
 *   1) 捞一批 reported_at IS NULL 的 usage_events（记下它们的 id），走
 *      usage_events_unreported_idx 这个 partial index，O(backlog)。
 *   2) 按 (projectId, kind) 在 JS 里聚合成 UsageRecord[]（batch 有上界，安全）。
 *   3) reporter.report(records)。
 *   4) 成功 → UPDATE ... SET reported_at=now WHERE id IN (本次捞到的 id)。
 *      失败 → 不回填、warn、下 tick 重试（at-least-once）。
 *
 * **关键不变量**：第 4 步只标"本次实际捞到的那批 id"，绝不用
 * `WHERE reported_at IS NULL` 回标——否则在 report() 期间并发插入的新 event 会被
 * 误标成已上报却从未真正推送（无声丢营收）。
 */

import { inArray, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { DbHandle } from '../db/client.js';
import { usageEvents } from '../db/schema.js';
import type { UsageKind } from '../usage/emitter.js';
import type { MeterReporter, UsageRecord } from '../usage/reporter.js';

/** 一个 tick 的结果，便于测试断言 + prod 日志。 */
export interface ReportResult {
  /** 本 tick 捞到的未上报行数。 */
  scanned: number;
  /** 成功回填 reported_at 的行数（reporter 失败时为 0）。 */
  reported: number;
  /** 聚合后推给 reporter 的记录条数。 */
  records: number;
  /** reporter 是否抛错（true 时 reported=0，行保持 NULL 待下 tick）。 */
  failed: boolean;
}

/**
 * 默认单 tick 最多处理多少行 usage_event。防 backlog 巨大时一次性 load 爆内存；
 * 没处理完的下个 tick 接着捞。
 */
const DEFAULT_BATCH_SIZE = 1000;

export async function reportUsage(deps: {
  db: DbHandle;
  reporter: MeterReporter;
  logger: Logger;
  /** ISO timestamp。默认 new Date().toISOString()。测试可注入定值。 */
  nowIso?: string;
  batchSize?: number;
}): Promise<ReportResult> {
  const { db, reporter, logger } = deps;
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  // 1) 捞一批未上报行。ORDER BY ts 让最老的先上报（公平 + 便于排查积压）。
  const unreported = await db.drizzle
    .select({
      id: usageEvents.id,
      projectId: usageEvents.projectId,
      kind: usageEvents.kind,
      value: usageEvents.value,
    })
    .from(usageEvents)
    .where(isNull(usageEvents.reportedAt))
    .orderBy(usageEvents.ts)
    .limit(batchSize);

  if (unreported.length === 0) {
    return { scanned: 0, reported: 0, records: 0, failed: false };
  }

  // 2) 按 (projectId, kind) 聚合。\u0000 作分隔不会出现在 id/kind 里。
  const groups = new Map<string, UsageRecord>();
  for (const row of unreported) {
    const key = `${row.projectId}\u0000${row.kind}`;
    const existing = groups.get(key);
    if (existing) {
      existing.value += row.value;
    } else {
      groups.set(key, {
        projectId: row.projectId,
        kind: row.kind as UsageKind,
        value: row.value,
        windowEnd: nowIso,
      });
    }
  }
  const records = [...groups.values()];

  // 3) 推送。失败不回填——下 tick 重试（at-least-once）。
  try {
    await reporter.report(records);
  } catch (err) {
    logger.warn(
      {
        scanned: unreported.length,
        records: records.length,
        reporter: reporter.kind,
        cause: err instanceof Error ? err.message : String(err),
      },
      'usage-report: reporter.report failed; leaving rows unreported for retry next tick',
    );
    return { scanned: unreported.length, reported: 0, records: records.length, failed: true };
  }

  // 4) 成功 → 只回填本次捞到的 id（绝不用 reported_at IS NULL 回标，防误标并发新行）。
  const ids = unreported.map((r) => r.id);
  await db.drizzle
    .update(usageEvents)
    .set({ reportedAt: nowIso })
    .where(inArray(usageEvents.id, ids));

  logger.info(
    { scanned: unreported.length, reported: ids.length, records: records.length, reporter: reporter.kind },
    'usage-report: pushed + marked reported',
  );

  return { scanned: unreported.length, reported: ids.length, records: records.length, failed: false };
}

/**
 * 长跑 wrapper：每 intervalMs 跑一次 reportUsage。
 *
 * 同 startSessionExpiryJob 的语义：re-entrant guard（上一个 tick 没跑完就 skip）、
 * graceful stop()（await 当前 in-flight tick）、tick 内吞错不停循环。
 */
export function startUsageReportJob(opts: {
  intervalMs: number;
  getDb: () => Promise<DbHandle>;
  getMeterReporter: () => MeterReporter;
  logger: Logger;
}): { stop: () => Promise<void> } {
  const { intervalMs, getDb, getMeterReporter, logger } = opts;

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error(`startUsageReportJob: intervalMs must be >= 1000 (got ${intervalMs})`);
  }

  let stopped = false;
  let tickInFlight: Promise<void> | null = null;

  const runOneTick = async (): Promise<void> => {
    if (stopped) return;
    if (tickInFlight) {
      logger.debug({}, 'usage-report: previous tick still running, skipping');
      return;
    }
    tickInFlight = (async () => {
      try {
        const db = await getDb();
        const reporter = getMeterReporter();
        await reportUsage({ db, reporter, logger });
      } catch (err) {
        logger.error(
          { cause: err instanceof Error ? err.message : String(err) },
          'usage-report: tick failed (will retry next interval)',
        );
      } finally {
        tickInFlight = null;
      }
    })();
    await tickInFlight;
  };

  const handle = setInterval(() => {
    void runOneTick();
  }, intervalMs);

  logger.info({ intervalMs }, 'usage-report job started');

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      if (tickInFlight) {
        try {
          await tickInFlight;
        } catch {
          /* tick 自己 catch 了所有错误 */
        }
      }
      logger.info({}, 'usage-report job stopped');
    },
  };
}
