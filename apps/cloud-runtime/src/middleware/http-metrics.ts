/**
 * HTTP request duration 记录 middleware。
 *
 * 在 hono 链最外层（在 onError 之后、auth 之前）跑。无论 handler 抛错与否，
 * `await next()` 后 `c.res.status` 已经定型（onError 已转 ApiError 成响应），
 * 所以这里读到的 status 是最终发给客户端的。
 *
 * route label：
 *   - 用 c.req.routePath（hono 4.x 暴露的 route template，例 '/v1/sessions/:id'）
 *   - 拿不到时退化成 c.req.path（dev 期间的 fallback；prod 应该都有 routePath）
 *
 * status_class：
 *   - 收纳到 2xx/4xx/5xx 等 4 个 bucket，避免 series 爆炸
 */

import type { MiddlewareHandler } from 'hono';

import { httpRequestDurationSeconds, statusClass } from '../metrics.js';

export const httpMetricsMiddleware: MiddlewareHandler = async (c, next) => {
  const start = process.hrtime.bigint();
  await next();
  const end = process.hrtime.bigint();
  const seconds = Number(end - start) / 1e9;

  const method = c.req.method;
  const route = c.req.routePath ?? c.req.path;
  const sc = statusClass(c.res.status);

  httpRequestDurationSeconds.observe({ method, route, status_class: sc }, seconds);
};
