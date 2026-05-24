/**
 * Cloud Runtime 环境变量 schema 校验。
 *
 * 启动时一次性 parse，失败立即退出，避免运行时遇到 undefined env 才崩。
 *
 * 设计原则：
 *   - dev 友好：所有字段都有 sensible default
 *   - prod 严格：SEED_API_KEY 在 NODE_ENV=production 时必须留空（强制走管理 CLI 建 key）
 */

import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

    DATABASE_URL: z.string().default('sqlite:./data/cloud-runtime.db'),

    MACHINE_MANAGER: z.enum(['static', 'local-docker', 'fly']).default('static'),
    POD_ADDRS: z.string().default('http://localhost:9222'),

    DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
    DOCKER_IMAGE: z.string().default('mosaiq/browser-pod:0.11.0'),
    DOCKER_NETWORK: z.string().default('bridge'),
    DOCKER_API_BASE_URL: z.string().default('http://localhost'),
    DOCKER_MAX_CONTAINERS: z.coerce.number().int().min(1).max(1024).default(8),
    DOCKER_POD_SHM_BYTES: z.coerce.number().int().min(67_108_864).default(1_073_741_824),

    FLY_API_TOKEN: z.string().optional(),
    /**
     * Fly app name housing the browser-pod Machines. 控制平面通过 Fly Machines API
     * 在这个 app 下 create/destroy machines。与控制平面自身的 app（一般叫
     * 'mosaiq-cloud-runtime'）不同。
     */
    FLY_APP_NAME: z.string().optional(),
    FLY_BROWSER_POD_IMAGE: z.string().default('registry.fly.io/mosaiq-browser-pod:latest'),
    FLY_REGION: z.string().default('iad'),
    /** Fly Machines API base URL. 单测可覆盖到 mock server。 */
    FLY_API_BASE_URL: z.string().default('https://api.machines.dev/v1'),
    /** 软上限：/v1/health 的 cap 字段；不在 Fly 侧强制（Fly app 配额另算）。 */
    FLY_MAX_MACHINES: z.coerce.number().int().min(1).max(1024).default(10),
    FLY_MACHINE_CPUS: z.coerce.number().int().min(1).max(16).default(2),
    FLY_MACHINE_MEMORY_MB: z.coerce.number().int().min(512).max(65536).default(2048),
    /** pod 控制端口（pod 镜像内部约定，默认 9222）。 */
    FLY_POD_CONTROL_PORT: z.coerce.number().int().min(1).max(65535).default(9222),

    SEED_PROJECT_ID: z.string().default('proj_launchai'),
    SEED_API_KEY: z.string().default(''),

    SESSION_TTL_DEFAULT_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
    SESSION_TTL_MAX_SECONDS: z.coerce.number().int().min(60).max(86400).default(7200),
    /**
     * session expiry reaper 的轮询间隔 ms。每个 tick 扫一次 sessions 表把
     * status='live' 但 expires_at 已过的强制 release + 标 closed。
     *
     * 默认 30s 是个保守值：跟 SESSION_TTL_DEFAULT_SECONDS=1800 比是 1/60，
     * 过期后最多多占 30s 资源。prod 真实场景 client crash 后泄漏一个 session
     * 30s 是可接受的；调小到 5s 在 cap=1000 时会让扫表噪音变大但收益有限。
     *
     * 测试可调到 1000（最小值）加速；< 1000 startSessionExpiryJob 会抛错。
     */
    SESSION_EXPIRY_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(30_000),

    PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.SEED_API_KEY !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SEED_API_KEY'],
        message:
          'SEED_API_KEY must be empty in production. Use the admin CLI to create keys instead.',
      });
    }
    if (env.MACHINE_MANAGER === 'fly') {
      if (!env.FLY_API_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FLY_API_TOKEN'],
          message: 'FLY_API_TOKEN is required when MACHINE_MANAGER=fly.',
        });
      }
      if (!env.FLY_APP_NAME) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FLY_APP_NAME'],
          message:
            'FLY_APP_NAME is required when MACHINE_MANAGER=fly (this is the browser-pod fly app, not the cloud-runtime app).',
        });
      }
    }
    if (env.SESSION_TTL_DEFAULT_SECONDS > env.SESSION_TTL_MAX_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_TTL_DEFAULT_SECONDS'],
        message: 'SESSION_TTL_DEFAULT_SECONDS must be <= SESSION_TTL_MAX_SECONDS',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`[cloud-runtime] invalid env:\n${issues}`);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

/** 测试用：清掉缓存让下次 loadEnv 重新解析。 */
export function resetEnvCache(): void {
  cached = null;
}
