/**
 * GET /v1/usage —— 客户可见用量查询（browser-minutes + 成本估算）。
 *
 * 见 docs/PHASE-11.7-USAGE-METERING.md §4.1。
 *
 *   GET /v1/usage?from=<iso>&to=<iso>
 *     → { project_id, from, to, totals: { "session.minute": N }, estimated_cost_usd }
 *
 * from/to 缺省 = 当前自然月（UTC）。任何合法 datetime 输入（含带时区偏移的）都会被
 * 归一化成 Z-form ISO 再比较 —— 因为 usage_events.ts 存的是 toISOString()（UTC + Z），
 * 字典序比较要求两侧同形，否则 `+08:00` 之类会比错。
 */

import { Hono } from 'hono';

import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { getAuth } from '../middleware/auth.js';
import { rateLimitTier } from '../middleware/rate-limit.js';
import { aggregateUsage, currentMonthWindowUtc } from '../usage/aggregate.js';
import { ApiError } from '../utils/errors.js';

export const usageRoute = new Hono();

/**
 * 解析单个 from/to query：
 *   - undefined（未传）→ undefined（调用方补默认）
 *   - 非法 datetime → null（调用方报 400）
 *   - 合法 → 归一化的 Z-form ISO 字符串
 */
function parseTsParam(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

usageRoute.get('/', rateLimitTier('read'), async (c) => {
  const auth = getAuth(c);
  const env = loadEnv();

  const fromParsed = parseTsParam(c.req.query('from'));
  const toParsed = parseTsParam(c.req.query('to'));
  if (fromParsed === null || toParsed === null) {
    throw new ApiError('request.invalid', 'from/to must be valid ISO-8601 datetimes', {
      from: c.req.query('from') ?? null,
      to: c.req.query('to') ?? null,
    });
  }

  const def = currentMonthWindowUtc();
  const fromIso = fromParsed ?? def.fromIso;
  const toIso = toParsed ?? def.toIso;
  if (fromIso >= toIso) {
    throw new ApiError('request.invalid', '`from` must be strictly before `to`', {
      from: fromIso,
      to: toIso,
    });
  }

  const handle = await getDb();
  const totals = await aggregateUsage(handle, auth.projectId, fromIso, toIso);

  const minutes = totals['session.minute'] ?? 0;
  // toFixed(4) 防浮点尾巴（0.06 × 17 = 1.0199999...）；仅估算，真账单以 Stripe 为准。
  const estimatedCostUsd = Number((minutes * env.UNIT_PRICE_USD_PER_MINUTE).toFixed(4));

  return c.json({
    project_id: auth.projectId,
    from: fromIso,
    to: toIso,
    totals: { 'session.minute': minutes },
    estimated_cost_usd: estimatedCostUsd,
    unit_price_usd_per_minute: env.UNIT_PRICE_USD_PER_MINUTE,
  });
});
