/**
 * Browser Pod entry。
 *
 * 启动顺序：
 *   1) loadEnv()
 *   2) 起 hono on POD_CONTROL_HOST:POD_CONTROL_PORT（默认 ::, IPv6 dual-stack）
 *   3) 起 CDP TCP relay on POD_CDP_HOST:POD_CDP_PORT → 127.0.0.1:POD_CDP_INTERNAL_PORT
 *      默认 也是 '::'，因为 Fly 机器间的 6PN 是 IPv6-only；cloud-runtime
 *      走 `http://[fdaa:77:...]:9223` 连过来。详见 env.ts POD_CONTROL_HOST 注释。
 *      relay 在 chromium 启动之前就 listen 没问题 —— chromium 还没起时新连接会进
 *      relay 然后 upstream dial 失败立刻 destroy clientSock，cloud-runtime 看到
 *      ECONNRESET 触发重试；chromium ready 后 relay 一切如常。这避免 race window：
 *      cloud-runtime 拿到 sessionResponse 后立刻拨 WS 进来，如果 relay 还没起就
 *      ECONNREFUSED 而不是更可重试的 RST。
 *   4) graceful shutdown 接 SIGTERM —— kill chromium + close relay + close http
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { getLogger } from './logger.js';
import { shutdownChromium } from './chromium.js';
import { startCdpRelay, type CdpRelay } from './relay.js';

async function bootstrap() {
  const env = loadEnv();
  const log = getLogger();
  const app = createApp();

  const server = serve({
    fetch: app.fetch,
    port: env.POD_CONTROL_PORT,
    hostname: env.POD_CONTROL_HOST,
  });

  let relay: CdpRelay | null = null;
  try {
    relay = await startCdpRelay({
      listenHost: env.POD_CDP_HOST,
      listenPort: env.POD_CDP_PORT,
      targetHost: '127.0.0.1',
      targetPort: env.POD_CDP_INTERNAL_PORT,
    });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to start CDP relay; aborting',
    );
    process.exit(1);
  }

  log.info(
    {
      controlPort: env.POD_CONTROL_PORT,
      cdpPort: env.POD_CDP_PORT,
      cdpInternalPort: env.POD_CDP_INTERNAL_PORT,
      headless: env.POD_HEADLESS,
    },
    'browser-pod listening',
  );

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'browser-pod shutdown initiated');
    await shutdownChromium().catch(() => undefined);
    if (relay) await relay.close().catch(() => undefined);
    server.close(() => log.info('http server closed'));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[browser-pod] fatal during bootstrap:', err);
  process.exit(1);
});
