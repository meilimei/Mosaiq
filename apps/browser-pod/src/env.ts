/**
 * Browser pod env schema。
 *
 * 单 session pod，所有路径与端口都从 env 派生。
 */

import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  POD_CONTROL_PORT: z.coerce.number().int().min(1).max(65535).default(9222),
  POD_CONTROL_HOST: z.string().default('0.0.0.0'),

  // 外部可见的 CDP port。pod 容器对外（同 docker network / Fly 6PN）暴露这个 port。
  // 我们不让 chromium 直接听这个 —— chromium issues.chromium.org/issues/40261787
  // 已知 bug：headless 模式下 --remote-debugging-address=0.0.0.0 不生效，chromium
  // 只 bind 127.0.0.1，外部 TCP 直接 ECONNREFUSED。所以 browser-pod 起一个 node
  // TCP relay 监听 0.0.0.0:POD_CDP_PORT，转发到 127.0.0.1:POD_CDP_INTERNAL_PORT。
  POD_CDP_PORT: z.coerce.number().int().min(1).max(65535).default(9223),
  // chromium 真正监听的内部 port。relay 把外部连接转到这个 port。
  // 跟 POD_CDP_PORT 错开避免自环。
  POD_CDP_INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).default(9224),
  POD_PROFILE_DIR: z.string().default('./data/profile'),

  POD_CHROME_EXECUTABLE: z.string().default(''),
  POD_HEADLESS: z
    .union([z.boolean(), z.string()])
    .default('true')
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),

  POD_CHROMIUM_BOOT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
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
    console.error(`[browser-pod] invalid env:\n${issues}`);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
