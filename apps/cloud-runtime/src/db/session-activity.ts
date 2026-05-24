/**
 * sessions.last_seen_at 维护 helper。
 *
 * 抽出来便于：
 *   1) cdp/proxy.ts 在 ws upgrade / 周期 / close 三个时机调用
 *   2) 未来若加 REST endpoint（POST /v1/sessions/:id/extend）也能复用
 *   3) 单测可直接验证 SQL 行为，不用走 ws 协议
 *
 * 语义约定：
 *   - 只更新 last_seen_at；不动 status / expires_at / closed_at（policy 由
 *     调用方决定，比如 extend TTL 是另一个 helper）
 *   - 失败不抛 —— 即使 sqlite 暂时挂了，业务路径（CDP 帧转发）也不应该被
 *     last_seen_at 写入失败拖累，loop 下一个 tick 自然会重试
 */

import { eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { sessions as sessionsTable } from './schema.js';

/**
 * 把指定 session 行的 last_seen_at 更新到 nowIso（默认当前 UTC ISO）。
 *
 * 不抛错；DB 失败只记 console（不引日志依赖避免循环 import）。返回是否成功。
 */
export async function bumpLastSeenAt(
  db: DbHandle,
  sessionId: string,
  nowIso?: string,
): Promise<boolean> {
  try {
    await db.drizzle
      .update(sessionsTable)
      .set({ lastSeenAt: nowIso ?? new Date().toISOString() })
      .where(eq(sessionsTable.id, sessionId));
    return true;
  } catch {
    // 不抛 —— prod 路径上业务（CDP 转发）远比 last_seen_at 重要
    return false;
  }
}
