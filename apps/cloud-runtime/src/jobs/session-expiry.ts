/**
 * Session TTL expiry reaper —— prod 资源池防泄漏的最后一道防线。
 *
 * 为啥要这个 job：
 *
 *   POST /v1/sessions 时算 expires_at 写进 sessions 表（默认 30min，max 2h）。
 *   预期 client 自觉 DELETE /v1/sessions/:id 释放资源。但真实 prod 里 client 会
 *   crash / 网络断 / 忘记 close —— 没有 DELETE 就永远不会调 mm.release()，
 *   `#alive` map 一直占着 cap，新的 createSession 全部 pool.exhausted。
 *
 *   这个 job 周期扫表，把 status='live' 但 expires_at 过期的 session 强制走
 *   完整 release 流程：
 *     1) mm.release(machineId) —— best-effort，跟 DELETE 路径同形态
 *        （docker rm -f / fly machines destroy）
 *     2) DB row 更新 status='closed'、closed_at=now、error_message='expired'
 *
 * 设计选择：
 *
 *   - 纯函数 reapExpiredSessions(deps) 与长跑 wrapper startSessionExpiryJob
 *     拆开。前者完全可单测（注入 db handle + mm + 时间），后者只是 setInterval
 *     胶水代码。
 *
 *   - 防 re-entrant：若上一个 tick 还没跑完，下一个 tick 立刻 skip（不排队）。
 *     避免 release 慢时（fly destroy 走 网络几百 ms × 100 个 expired
 *     session）累积成 thundering herd。
 *
 *   - WHERE status IN ('live', 'requested')：当前 sessions.ts POST 直接写
 *     'live'，但 schema 注释里 'requested' 是预留状态。两个都收以防未来扩展。
 *
 *   - DB 更新用 `WHERE id = ? AND status IN ('live','requested')` 做乐观锁：
 *     如果 DELETE handler 抢先一步把 status 改 'closed' 了，update 就 no-op，
 *     reaper 不会重复 release（mm.release 本身也幂等，这层是 belt-and-suspenders）。
 *
 *   - mm.release 失败不阻塞 status 更新：宁可状态 drift 也不要 reaper 卡死
 *     在某个 unhealthy machine 上一直 retry。下次 tick 也不会重抓这条
 *     （已经 closed 了），但 machine 可能 leak —— 这种情况记 warn 让 ops 介入。
 *
 *   - 不立即跑首 tick：避免 bootstrap 时 schema 还没 ready 就扫表。第一次
 *     tick 在 intervalMs 之后。
 */

import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Logger } from 'pino';

import { auditEvents, sessions as sessionsTable } from '../db/schema.js';
import type { DbHandle } from '../db/client.js';
import type { MachineManager } from '../machine/types.js';
import { newId } from '../utils/ids.js';

/**
 * 一个 tick 的统计结果，便于测试断言 + prod 日志聚合。
 */
export interface ReapResult {
  /** 这次扫到的过期 session 总数（无论是否成功 release）。 */
  scanned: number;
  /** mm.release 成功的数量。 */
  released: number;
  /** mm.release 抛错但 DB row 仍标 closed 的数量。 */
  releaseFailed: number;
  /** 处理过的 session id 列表，用于审计。 */
  sessionIds: string[];
}

/**
 * 扫一次 sessions 表，把过期的 live/requested session 释放并标 closed。
 *
 * 测试角度：注入 db、mm、logger、nowIso 全部可控，不依赖 module-global。
 *
 * Prod 角度：startSessionExpiryJob 包装这个函数走 setInterval 周期触发。
 */
export async function reapExpiredSessions(deps: {
  db: DbHandle;
  mm: Pick<MachineManager, 'release'>;
  logger: Logger;
  /** ISO timestamp 字符串。默认 new Date().toISOString()。测试可注入定值便于复现。 */
  nowIso?: string;
}): Promise<ReapResult> {
  const { db, mm, logger } = deps;
  const nowIso = deps.nowIso ?? new Date().toISOString();

  // sqlite text(timestamp) 比较走字典序；ISO-8601 的好处就是字典序 = 时间序，
  // 所以 expiresAt < nowIso 就是 "过期了"。
  const expired = await db.drizzle
    .select({
      id: sessionsTable.id,
      machineId: sessionsTable.machineId,
      projectId: sessionsTable.projectId,
      expiresAt: sessionsTable.expiresAt,
    })
    .from(sessionsTable)
    .where(
      and(
        inArray(sessionsTable.status, ['live', 'requested']),
        lt(sessionsTable.expiresAt, nowIso),
      ),
    );

  if (expired.length === 0) {
    return { scanned: 0, released: 0, releaseFailed: 0, sessionIds: [] };
  }

  let released = 0;
  let releaseFailed = 0;
  const sessionIds: string[] = [];

  for (const row of expired) {
    sessionIds.push(row.id);
    let thisRowReleaseFailed = false;
    try {
      await mm.release(row.machineId);
      released++;
    } catch (err) {
      releaseFailed++;
      thisRowReleaseFailed = true;
      // 不抛 —— 我们仍要把 status 标 closed，让下次 tick 不重抓。
      // machine 可能 leak（fly machine 没销毁），ops 通过这条 warn 介入。
      logger.warn(
        {
          sessionId: row.id,
          machineId: row.machineId,
          projectId: row.projectId,
          cause: err instanceof Error ? err.message : String(err),
        },
        'session-expiry: mm.release failed; marking closed anyway (machine may leak)',
      );
    }

    // 乐观锁：只在 status 仍是 live/requested 时更新。
    // 若 DELETE handler 已抢先关掉，这里 no-op（drizzle update 没匹配 row 不报错）。
    const updated = await db.drizzle
      .update(sessionsTable)
      .set({
        status: 'closed',
        closedAt: nowIso,
        errorMessage: 'expired',
      })
      .where(
        and(
          eq(sessionsTable.id, row.id),
          inArray(sessionsTable.status, ['live', 'requested']),
        ),
      )
      .returning({ id: sessionsTable.id });

    // 写 audit_events 行，让 prod 能追责"是谁在什么时候关了这个 session"。
    // 跟 routes/sessions.ts 的 audit() 调用并列：那条是 client 主动 DELETE
    // 时写的 'session.close'，这条是 reaper 强制收的 'session.expire'，从
    // ip / api_key_id 都为 NULL 一眼看得出来是 background job 写的。
    //
    // 只有在乐观锁实际更新到这一行时才写 audit；如果 update no-op（DELETE
    // 抢先），则 DELETE handler 已经写过 'session.close' 了，不要重复写。
    if (updated.length > 0) {
      await db.drizzle.insert(auditEvents).values({
        id: newId('aud'),
        projectId: row.projectId,
        apiKeyId: null,
        action: 'session.expire',
        resource: `session:${row.id}`,
        result: thisRowReleaseFailed ? 'errored' : 'ok',
        ip: null,
        detailJson: JSON.stringify({
          machineId: row.machineId,
          expiresAt: row.expiresAt,
          reapedAt: nowIso,
          ...(thisRowReleaseFailed ? { releaseFailed: true } : {}),
        }),
      });
    }
  }

  logger.info(
    {
      scanned: expired.length,
      released,
      releaseFailed,
      sessionIds,
    },
    'session-expiry: reaped expired sessions',
  );

  return {
    scanned: expired.length,
    released,
    releaseFailed,
    sessionIds,
  };
}

/**
 * 长跑 wrapper：每 intervalMs 跑一次 reapExpiredSessions。
 *
 * 调用者必须在 graceful shutdown 时调 stop()，否则 setInterval 会阻止
 * process.exit。stop() 会等当前 in-flight tick 完成（最多一个 tick 周期）。
 *
 * 防 re-entrant：tick 还没跑完时下一个 interval 触发的 tick 直接 skip，
 * 避免 release 慢时累积。
 */
export function startSessionExpiryJob(opts: {
  intervalMs: number;
  /** 注入式 deps，便于集成测试。production 走 module-global。 */
  getDb: () => Promise<DbHandle>;
  getMachineManager: () => MachineManager;
  logger: Logger;
}): { stop: () => Promise<void> } {
  const { intervalMs, getDb, getMachineManager, logger } = opts;

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error(
      `startSessionExpiryJob: intervalMs must be >= 1000 (got ${intervalMs})`,
    );
  }

  let stopped = false;
  let tickInFlight: Promise<void> | null = null;

  const runOneTick = async (): Promise<void> => {
    if (stopped) return;
    if (tickInFlight) {
      // 上一个 tick 还在跑（release 慢 or DB busy），跳过这次触发。
      logger.debug({}, 'session-expiry: previous tick still running, skipping');
      return;
    }
    tickInFlight = (async () => {
      try {
        const db = await getDb();
        const mm = getMachineManager();
        await reapExpiredSessions({ db, mm, logger });
      } catch (err) {
        // 整个 tick 抛错（DB 连不上、mm factory 没初始化 等）。记 error 但
        // 让 setInterval 继续 —— 单次失败不应该停掉整个 reaper 循环。
        logger.error(
          {
            cause: err instanceof Error ? err.message : String(err),
          },
          'session-expiry: tick failed (will retry next interval)',
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

  // setInterval handle 在 node 里默认 keep event loop alive，让 process 在
  // SIGTERM 之前不会因为没 work 而退出 —— 这是我们想要的（控制平面长跑）。
  // 但如果未来要让 cli 命令短跑后自然退出，需要改 unref()。

  logger.info(
    { intervalMs },
    'session-expiry job started',
  );

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      // 等当前 in-flight tick 跑完，确保 shutdown 时不会有 stale tick
      // 突然冒出来调 mm.release（mm 那时可能已经 dispose 了）。
      if (tickInFlight) {
        try {
          await tickInFlight;
        } catch {
          // tick 自己 catch 了所有错误，理论上不会到这里；保险起见不抛。
        }
      }
      logger.info({}, 'session-expiry job stopped');
    },
  };
}
