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
  /**
   * Hono 控制面 server 的 bind 地址。默认 '::'（IPv6 wildcard）而不是 '0.0.0.0'
   * 是因为：Fly 机器之间的私有网络（6PN）只走 IPv6——cloud-runtime 调 pod 是走
   * `http://[fdaa:77:...]:9222`。仅 bind `0.0.0.0` = IPv4-only，会让 IPv6 连接 ECONNREFUSED
   * （表现为 cloud-runtime 报 `pool.pod_unhealthy / fetch failed`）。
   *
   * Linux （生产 + CI）上 '::' 默认双栈 = 同时接受 IPv6 原生连接和 IPv4-mapped
   * IPv6 连接，所以 docker bridge （LocalDocker manager 住在那里）的 IPv4 地址也
   * 依然能连上。Windows 本地调试需双栈请显设 `POD_CONTROL_HOST=0.0.0.0`
   * 或 `POD_CONTROL_HOST=::` （仅 IPv6），看哪边的 client 需要。
   */
  POD_CONTROL_HOST: z.string().default('::'),

  // 外部可见的 CDP port。pod 容器对外（同 docker network / Fly 6PN）暴露这个 port。
  // 我们不让 chromium 直接听这个 —— chromium issues.chromium.org/issues/40261787
  // 已知 bug：headless 模式下 --remote-debugging-address=0.0.0.0 不生效，chromium
  // 只 bind 127.0.0.1，外部 TCP 直接 ECONNREFUSED。所以 browser-pod 起一个 node
  // TCP relay 监听 POD_CDP_HOST:POD_CDP_PORT，转发到 127.0.0.1:POD_CDP_INTERNAL_PORT。
  POD_CDP_PORT: z.coerce.number().int().min(1).max(65535).default(9223),
  /** 同 POD_CONTROL_HOST：Fly 6PN 只走 IPv6，默认 '::' 双栈。Windows 本地调试可覆盖。 */
  POD_CDP_HOST: z.string().default('::'),
  // chromium 真正监听的内部 port。relay 把外部连接转到这个 port。
  // 跟 POD_CDP_PORT 错开避免自环。
  POD_CDP_INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).default(9224),
  POD_PROFILE_DIR: z.string().default('./data/profile'),

  POD_CHROME_EXECUTABLE: z.string().default(''),
  POD_HEADLESS: z
    .union([z.boolean(), z.string()])
    .default('true')
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),

  /**
   * Option A 服务端深层注入的总开关（kill-switch）。默认 true：pod 在 chromium 起好后
   * 用自带 playwright connectOverCDP + addInitScript 注册 injectAll，使裸 connectOverCDP
   * 也带深层 stealth。设 'false' 可在不改逻辑的情况下线上即时回退到「仅进程级加固」
   * （客户端仍可用 cloud-sdk injectInto 自行注入）。每 session 还受 stealth.inject 约束。
   */
  POD_SERVER_INJECT: z
    .union([z.boolean(), z.string()])
    .default('true')
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),

  /**
   * Chromium spawn 后等 /json/version 就绪的超时。30s 在 LocalDocker 测试足够，但
   * Fly firecracker microVM 上 chromium 内部有 15s+ 的初始化静默期（推测是
   * NetworkService DNS resolver init + 字体配置扫描的组合，看不到 stderr log），
   * 加上 dbus 探测累积，实测 prod 启动可达 18-20s。把默认拉到 60s 给足余量。
   * 后续若能定位到具体卡点（perf-counter + strace 分析），再缩短。
   */
  POD_CHROMIUM_BOOT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),

  // ─── Phase 11.6: Browserbase Contexts (cookie/state persistence) ──────────
  /**
   * AES-256 master key（base64 32 bytes），与 cloud-runtime 的
   * MOSAIQ_CONTEXT_MASTER_KEY **同源** fly secret。pod 用它 + projectId HKDF 派生
   * per-project key 来解密装载的 context blob / 加密 snapshot。空 = 该 pod 不支持
   * context（loadContext / snapshotContext 会跳过或报错）；正常 prod 两侧都注入。
   */
  POD_CONTEXT_MASTER_KEY: z.string().default(''),
  /**
   * snapshot blob（compressed + encrypted）大小上限 MB，与 cloud-runtime 的
   * MOSAIQ_CONTEXT_SIZE_MAX_MB 对齐。pod 在 PUT 前自检超限就不上传，保留
   * cloud-runtime 上一版 good blob。
   */
  POD_CONTEXT_SIZE_MAX_MB: z.coerce.number().int().min(1).max(1024).default(200),
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
