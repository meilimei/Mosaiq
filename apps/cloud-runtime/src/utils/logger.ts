/**
 * 结构化日志（pino）。
 *
 * dev: pretty 打印
 * prod: JSON line（Fly logs / Loki / Datadog 直接消费）
 */

import pino, { type Logger } from 'pino';

import { loadEnv } from '../env.js';

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (cached) return cached;
  const env = loadEnv();
  cached = pino({
    level: env.LOG_LEVEL,
    base: {
      service: 'cloud-runtime',
      env: env.NODE_ENV,
    },
    ...(env.NODE_ENV === 'development'
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
