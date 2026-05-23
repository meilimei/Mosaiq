/**
 * 结构化日志（pino）。
 *
 * 输出模式：
 *   - 本地终端（dev + isTTY）：pino-pretty 彩色打印，开发体验友好
 *   - 容器 / CI / 重定向 stdout（!isTTY）：JSON 行直接打 stdout
 *
 * 为什么以前曾经简单按 NODE_ENV 切：那样在 docker compose 里跑 dev 配置时
 * pino-pretty 的 worker thread 会缓冲，`docker compose logs --tail=200` 抓
 * 不到最近几秒的日志，e2e 失败时排查极其痛苦。改成按 isTTY 判断后，docker
 * 容器里（stdout 是 pipe）走 sync JSON path，每行立即可见。
 */

import pino, { type Logger } from 'pino';

import { loadEnv } from '../env.js';

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (cached) return cached;
  const env = loadEnv();
  const usePretty = env.NODE_ENV === 'development' && Boolean(process.stdout.isTTY);
  cached = pino({
    level: env.LOG_LEVEL,
    base: {
      service: 'cloud-runtime',
      env: env.NODE_ENV,
    },
    ...(usePretty
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
