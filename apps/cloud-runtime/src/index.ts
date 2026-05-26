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
 *   5) startSessionExpiryJob() — 周期 reap 过期 session（防止 client crash 后泄漏）
 *   6) graceful shutdown 接 SIGTERM（先停 expiry job，再 close http，再放 mm + db）
 */

import { createServer, type RequestListener } from 'node:http';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { ensureDefaultPersonas, ensureSchema } from './db/bootstrap.js';
import { seedDevAuth } from './db/seed.js';
import { disposeDb, getDb } from './db/client.js';
import { loadEnv } from './env.js';
import { getMachineManager, shutdownMachineManager } from './machine/factory.js';
import { createCdpProxy } from './cdp/proxy.js';
import { startSessionExpiryJob } from './jobs/session-expiry.js';
import { getLogger } from './utils/logger.js';

async function bootstrap() {
  const env = loadEnv();
  const log = getLogger();

  await ensureSchema();
  await ensureDefaultPersonas();
  const seed = await seedDevAuth();
  log.info({ seed }, 'db ready');

  const app = createApp();
  const { handleUpgrade } = createCdpProxy();

  // 我们要在同一个 http.Server 上同时承载：
  //   - hono REST handler（serve() 内部会 server.on('request', requestListener)）
  //   - WebSocket upgrade /v1/sessions/:id/cdp（自己 server.on('upgrade', ...)）
  //
  // 关键：@hono/node-server 的 createAdaptorServer 是这样用 `createServer`：
  //     const server = createServer(serverOptions || {}, requestListener)
  // 即把 fetch handler 作为 http.createServer 的第二个参数传入。
  // 如果我们写 `createServer: () => myServer` 把参数丢掉，hono 的 requestListener
  // 就永远没挂到 'request' 事件上 → TCP 接得通但 HTTP 永远 timeout。
  //
  // 正确做法：让 createServer factory 把 listener 转挂到我们自己的 server 上。
  // 这样 serve() 调一次 server.listen() 就完成了 REST 端口监听；upgrade 是另一
  // 个事件，互不冲突。
  const server = createServer();
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

  serve(
    {
      fetch: app.fetch,
      port: env.PORT,
      hostname: env.HOST,
      // hono 内部会用 `createServer(serverOptions, requestListener)` 调用，
      // 而 node:http 的 `createServer` 签名（重载）让 TS 推不出我们这个 factory
      // 的两参形式，所以显式 cast 成它认得的 typeof createServer。
      createServer: ((_opts: unknown, requestListener?: RequestListener) => {
        if (requestListener) server.on('request', requestListener);
        return server;
      }) as unknown as typeof createServer,
    },
    (info) => {
      log.info(
        {
          port: info.port,
          host: env.HOST,
          publicBaseUrl: env.PUBLIC_BASE_URL,
          machineManager: env.MACHINE_MANAGER,
        },
        'cloud-runtime listening',
      );
    },
  );

  // 启动 session expiry reaper —— 周期扫表把 status='live' 但 expires_at 过的
  // session 强制 release。防 client crash / 忘 close 导致 pool 永久泄漏。
  // 在 listen 之后启动，确保 reaper 第一次 tick 时 server 已经 ready。
  const expiryJob = startSessionExpiryJob({
    intervalMs: env.SESSION_EXPIRY_INTERVAL_MS,
    getDb,
    getMachineManager,
    logger: log,
  });

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutdown initiated');
    // 先停 reaper，避免 shutdown 中途 reap tick 调已 dispose 的 mm/db。
    // expiryJob.stop() 会 await 当前 in-flight tick 完成。
    await expiryJob.stop();
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
