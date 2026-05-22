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

  POD_CDP_PORT: z.coerce.number().int().min(1).max(65535).default(9223),
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
