/**
 * Browser Pod entry。
 *
 * 启动顺序：
 *   1) loadEnv()
 *   2) 起 hono on POD_CONTROL_PORT
 *   3) graceful shutdown 接 SIGTERM —— kill chromium + close http
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { getLogger } from './logger.js';
import { shutdownChromium } from './chromium.js';

async function bootstrap() {
  const env = loadEnv();
  const log = getLogger();
  const app = createApp();

  const server = serve({
    fetch: app.fetch,
    port: env.POD_CONTROL_PORT,
    hostname: env.POD_CONTROL_HOST,
  });

  log.info(
    { controlPort: env.POD_CONTROL_PORT, cdpPort: env.POD_CDP_PORT, headless: env.POD_HEADLESS },
    'browser-pod listening',
  );

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'browser-pod shutdown initiated');
    await shutdownChromium().catch(() => undefined);
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
