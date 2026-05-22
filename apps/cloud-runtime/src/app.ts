/**
 * Hono app 工厂。
 *
 * 抽出来便于在测试里 .request() 直接打。生产路径在 index.ts 里把它挂到
 * @hono/node-server 同时挂 ws upgrade。
 */

import { Hono } from 'hono';

import { bearerAuth } from './middleware/auth.js';
import { healthRoute } from './routes/health.js';
import { personasRoute } from './routes/personas.js';
import { sessionsRoute } from './routes/sessions.js';
import { handleApiError } from './utils/errors.js';

export function createApp(): Hono {
  const app = new Hono();

  app.onError(handleApiError);

  // /v1/health 不需要 auth
  app.route('/v1/health', healthRoute);

  // 其余 /v1/* 都过 bearer auth
  const authed = new Hono();
  authed.use('*', bearerAuth);
  authed.route('/sessions', sessionsRoute);
  authed.route('/personas', personasRoute);
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
