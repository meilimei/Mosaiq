/**
 * 审计日志写入辅助。
 *
 * 不挂 middleware 在所有路由 —— 因为 audit 语义随路由不同（创建 session vs 列
 * persona），统一 middleware 反而要解析 c.req.path 拼 action 名字。直接在 handler
 * 末尾调 `audit(c, 'session.create', 'session:ses_xxx', 'ok')` 简单清楚。
 *
 * 异步写入：不阻塞响应。失败只 warn。
 */

import type { Context } from 'hono';

import { getDb } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { getLogger } from '../utils/logger.js';
import { getAuth } from './auth.js';

export type AuditResult = 'ok' | 'denied' | 'errored';

export function audit(
  c: Context,
  action: string,
  resource: string,
  result: AuditResult,
  detail?: Record<string, unknown>,
): void {
  // 取 auth context（如果存在）—— 比如 401 路径上没有
  let projectId: string | null = null;
  let apiKeyId: string | null = null;
  try {
    const a = getAuth(c);
    projectId = a.projectId;
    apiKeyId = a.apiKeyId;
  } catch {
    /* no-auth path, e.g. 401 */
  }

  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;

  Promise.resolve().then(async () => {
    try {
      const handle = await getDb();
      await handle.drizzle.insert(auditEvents).values({
        id: newId('aud'),
        projectId,
        apiKeyId,
        action,
        resource,
        result,
        ip,
        detailJson: detail ? JSON.stringify(detail) : null,
      });
    } catch (err) {
      getLogger().warn({ err, action, resource }, 'audit write failed');
    }
  });
}
