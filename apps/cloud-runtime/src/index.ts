/**
 * 控制平面入口。
 *
 * 一个 Node http.Server 同时承载：
 *   - REST API（@hono/node-server adapter）
 *   - WebSocket upgrade  /v1/sessions/:id/cdp（cdp/proxy.ts）
 *
 * 启动顺序：
 *   1) loadEnv() — 失败 process.exit
 *   2) ensureSchema() — 建表
 *   3) seedDevAuth() — dev 种子 key（prod env 自动 skip）
 *   4) listen
 *   5) graceful shutdown 接 SIGTERM
 */

import { createServer } from 'node:http';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { ensureSchema } from './db/bootstrap.js';
import { seedDevAuth } from './db/seed.js';
import { disposeDb } from './db/client.js';
import { loadEnv } from './env.js';
import { shutdownMachineManager } from './machine/factory.js';
import { createCdpProxy } from './cdp/proxy.js';
import { getLogger } from './utils/logger.js';

async function bootstrap() {
  const env = loadEnv();
  const log = getLogger();

  await ensureSchema();
  const seed = await seedDevAuth();
  log.info({ seed }, 'db ready');

  const app = createApp();
  const { handleUpgrade } = createCdpProxy();

  const server = createServer();

  // 把 Hono 挂到 server 上
  serve({ fetch: app.fetch, createServer: () => server, port: env.PORT, hostname: env.HOST });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (url.startsWith('/v1/sessions/') && url.includes('/cdp')) {
      handleUpgrade(req, socket, head).catch((err) => {
        log.error({ err }, 'cdp upgrade error');
        try {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        } catch {
          /* ignore */
        }
        socket.destroy();
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  server.listen(env.PORT, env.HOST, () => {
    log.info(
      { port: env.PORT, host: env.HOST, publicBaseUrl: env.PUBLIC_BASE_URL, machineManager: env.MACHINE_MANAGER },
      'cloud-runtime listening',
    );
  });

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutdown initiated');
    server.close(() => log.info('http server closed'));
    await Promise.allSettled([shutdownMachineManager(), disposeDb()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[cloud-runtime] fatal during bootstrap:', err);
  process.exit(1);
});
