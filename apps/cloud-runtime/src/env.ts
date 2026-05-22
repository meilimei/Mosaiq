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

    FLY_API_TOKEN: z.string().optional(),
    FLY_APP_NAME: z.string().optional(),
    FLY_REGION: z.string().default('iad'),

    SEED_PROJECT_ID: z.string().default('proj_launchai'),
    SEED_API_KEY: z.string().default(''),

    SESSION_TTL_DEFAULT_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
    SESSION_TTL_MAX_SECONDS: z.coerce.number().int().min(60).max(86400).default(7200),

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
    if (env.MACHINE_MANAGER === 'fly' && !env.FLY_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FLY_API_TOKEN'],
        message: 'FLY_API_TOKEN is required when MACHINE_MANAGER=fly.',
      });
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
