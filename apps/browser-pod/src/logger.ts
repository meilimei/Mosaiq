import pino, { type Logger } from 'pino';

import { loadEnv } from './env.js';

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (cached) return cached;
  const env = loadEnv();
  cached = pino({
    level: env.LOG_LEVEL,
    base: { service: 'browser-pod', env: env.NODE_ENV },
    // 跟 cloud-runtime 一致：只在本地终端（dev + isTTY）走 pino-pretty；
    // 容器里 stdout 是 pipe，走 JSON 直写避免 worker thread 缓冲让 docker logs 看不到。
    ...(env.NODE_ENV === 'development' && Boolean(process.stdout.isTTY)
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  });
  return cached;
}
