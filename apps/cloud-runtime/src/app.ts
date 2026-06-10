/**
 * Hono app 工厂。
 *
 * 抽出来便于在测试里 .request() 直接打。生产路径在 index.ts 里把它挂到
 * @hono/node-server 同时挂 ws upgrade。
 */

import { Hono } from 'hono';

import { bearerAuth } from './middleware/auth.js';
import { httpMetricsMiddleware } from './middleware/http-metrics.js';
import { contextsRoute } from './routes/contexts.js';
import { healthRoute } from './routes/health.js';
import { internalContextsRoute } from './routes/internal-contexts.js';
import { metricsRoute } from './routes/metrics.js';
import { publicTrialRoute } from './routes/public.js';
import { personasRoute } from './routes/personas.js';
import { sessionsRoute } from './routes/sessions.js';
import { usageRoute } from './routes/usage.js';
import { handleApiError } from './utils/errors.js';

export function createApp(): Hono {
  const app = new Hono();

  app.onError(handleApiError);

  // 全局 HTTP metrics（在 onError 之后；middleware 内部记录最终 status）
  app.use('*', httpMetricsMiddleware);

  // /v1/health 不需要 auth
  app.route('/v1/health', healthRoute);

  // /v1/metrics 走独立 token（scraper 跟业务 key 解耦）
  app.route('/v1/metrics', metricsRoute);
  app.route('/v1/public', publicTrialRoute);

  // Phase 11.6: /v1/_internal/contexts/* 走 HMAC token（cloud-runtime ↔ pod 内
  // 部端点）；不挂 bearerAuth，token 校验在 handler 内。Mount 在 authed 之前
  // 让 Hono prefix matching 不撞 authed 的 catch-all。
  app.route('/v1/_internal/contexts', internalContextsRoute);

  // 其余 /v1/* 都过 bearer auth
  const authed = new Hono();
  authed.use('*', bearerAuth);
  authed.route('/sessions', sessionsRoute);
  authed.route('/personas', personasRoute);
  // Phase 11.6: Browserbase Contexts API. Auth-gated (same bearerAuth as
  // sessions/personas); feature-gated by ensureContextsEnabled() inside the
  // handler when MOSAIQ_CONTEXT_MASTER_KEY is unset.
  authed.route('/contexts', contextsRoute);
  // Phase 11.7: customer-visible usage query (browser-minutes + cost estimate).
  authed.route('/usage', usageRoute);
  app.route('/v1', authed);

  app.get('/', (c) =>
    c.json({
      service: 'mosaiq-cloud-runtime',
      version: '0.11.0',
      docs: 'https://github.com/meilimei/Mosaiq/blob/main/docs/CLOUD-V0-IMPLEMENTATION.md',
    }),
  );

  return app;
}

