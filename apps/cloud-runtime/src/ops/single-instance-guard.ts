/**
 * 启动时声明 cloud-runtime 的单实例假设，防止误水平扩展而不自知。
 *
 * rate-limit / sticky-registry / fly-pool 均为进程内 Map（见 docs/CLOUD-SINGLE-INSTANCE-ADR.md）。
 * 多实例无共享存储时：sticky 路由分裂、rate limit 失效、pool cap 漂移。
 */

import type { Env } from '../env.js';
import type { Logger } from '../utils/logger.js';

export function logSingleInstanceAssumption(log: Logger, env: Env): void {
  const sqliteFile = env.DATABASE_URL.startsWith('sqlite:') || env.DATABASE_URL.endsWith('.db');

  log.warn(
    {
      assumption: 'single_control_plane_instance',
      inMemoryState: ['rate-limit (token bucket)', 'sticky-registry', 'fly-machine-pool'],
      database: sqliteFile ? 'sqlite-single-file' : env.DATABASE_URL.split(':')[0],
      doc: 'docs/CLOUD-SINGLE-INSTANCE-ADR.md',
    },
    'cloud-runtime assumes ONE control-plane instance — do NOT scale horizontally without shared sticky/rate-limit storage (see ADR)',
  );

  if (env.NODE_ENV === 'production' && sqliteFile) {
    log.warn(
      { DATABASE_URL: env.DATABASE_URL.replace(/\/[^/]+$/, '/***') },
      'prod uses SQLite file DB — multi-instance or HA requires Postgres (ADR § Phase B1)',
    );
  }
}
