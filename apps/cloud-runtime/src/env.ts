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
     *
     * ⚠️  NAMING: this MUST NOT be called `FLY_APP_NAME` —— Fly 的 machine runtime
     * 会自动注入 `FLY_APP_NAME=<当前-app-name>` 到每个 machine 的 env，覆盖我们
     * `flyctl secrets set` 的值（无声覆盖、无错误日志），结果 manager 把 control
     * plane 自己当成 pod app，所有 POST /apps/{app}/machines 走到错的 app → 403
     * unauthorized。同理 `FLY_REGION` 也是 reserved，所以这边叫 FLY_POD_REGION。
     * 完整 reserved 列表见 https://fly.io/docs/machines/runtime-environment。
     */
    FLY_POD_APP_NAME: z.string().optional(),
    FLY_BROWSER_POD_IMAGE: z.string().default('registry.fly.io/mosaiq-browser-pod:latest'),
    /** ⚠️ 同上 FLY_POD_APP_NAME 注释：FLY_REGION 是 Fly 保留名，必须叫 FLY_POD_REGION。 */
    FLY_POD_REGION: z.string().default('iad'),
    /** Fly Machines API base URL. 单测可覆盖到 mock server。 */
    FLY_API_BASE_URL: z.string().default('https://api.machines.dev/v1'),
    /** 软上限：/v1/health 的 cap 字段；不在 Fly 侧强制（Fly app 配额另算）。 */
    FLY_MAX_MACHINES: z.coerce.number().int().min(1).max(1024).default(10),
    FLY_MACHINE_CPUS: z.coerce.number().int().min(1).max(16).default(2),
    FLY_MACHINE_MEMORY_MB: z.coerce.number().int().min(512).max(65536).default(2048),
    /** pod 控制端口（pod 镜像内部约定，默认 9222）。 */
    FLY_POD_CONTROL_PORT: z.coerce.number().int().min(1).max(65535).default(9222),

    // ─── Phase 11.3a stopped-machine pool ──────────────────────────────────
    // 见 docs/PHASE-11.3-MACHINE-POOL.md。所有 knob 加 `POOL_` 前缀，仅对
    // MACHINE_MANAGER=fly 生效；其他 manager 模式（static / local-docker）忽略。
    //
    // POOL_TARGET_SIZE=0 → 池禁用，factory 回退到 FlyMachineManager（phase 11.2 行为）。
    // 这是 prod 的"紧急回滚"开关：`flyctl secrets set POOL_TARGET_SIZE=0` 即可
    // 重启后立即关闭 pool。
    POOL_TARGET_SIZE: z.coerce.number().int().min(0).max(50).default(0),
    /** 后台补充 loop 间隔 ms，默认 10s。 */
    POOL_REPLENISH_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(10_000),
    /** 单 tick 最多并发起几个 provision，默认 2（防 Fly API rate limit）。 */
    POOL_REPLENISH_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
    /** Pool entry 最大年龄秒数；超过则 evict + 补新。默认 86400 = 24h（避免镜像过期 / 节点漂移）。 */
    POOL_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(7 * 86400).default(86_400),
    /** 单次 provision 硬超时 ms（含 POST create + waitForState=stopped）。默认 120s。 */
    POOL_PROVISION_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
    /**
     * Bootstrap reconcile 时是否 destroy 看似孤儿的 stopped machine（即非 pool-marked）。
     * 默认 true（避免账单泄漏）。设 false 用于第一次 deploy pool 上线时谨慎观察。
     */
    POOL_BOOTSTRAP_EVICT_FOREIGN: z
      .union([z.literal('true'), z.literal('false')])
      .default('true')
      .transform((v) => v === 'true'),

    SEED_PROJECT_ID: z.string().default('proj_launchai'),
    SEED_API_KEY: z.string().default(''),

    SESSION_TTL_DEFAULT_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
    SESSION_TTL_MAX_SECONDS: z.coerce.number().int().min(60).max(86400).default(7200),

    // ─── Phase 11.5 keepAlive long sessions ────────────────────────────────
    // 见 docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md。三个 knob 仅作用于
    // `keepAlive: true` 路径（POST /v1/sessions BB-shape 字段或 native lifecycle）；
    // `keepAlive: false`（默认）路径完全沿用 phase 11.4 行为，受 SESSION_TTL_MAX_SECONDS
    // 封顶，pool entry single-use destroy 不变。

    /**
     * keepAlive=true session 的 TTL 上限秒数。默认 86400 = 24h，覆盖 LaunchAI Reddit
     * 类 daily grooming 窗口。SESSION_TTL_MAX_SECONDS 必须 ≤ 这个值（superRefine 校验）。
     * 上限 604800 = 7 天 —— 超过这值的需求应该考虑 Browserbase Contexts API 风格的
     * cookie 持久化（phase 11.6）而不是无限延长 pod 生命周期。
     */
    SESSION_TTL_MAX_KEEPALIVE_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .max(7 * 86400)
      .default(86400),
    /**
     * keepAlive=true session 在 WS 断开后允许的最大无活动时间，过此则 reaper 标 closed +
     * release(hold=false) 销毁 pod。默认 3600 = 1h —— 多数客户端崩溃 / 重启场景
     * 内能恢复，1h 之后还没重连基本是业务 abandoned 而非短暂网络抖动。范围
     * [60, 86400]：< 60s 会让任何 WS 断重连测试都 false-positive，> 24h 没意义
     * （hard TTL 默认也是 24h）。
     */
    SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86400)
      .default(3600),
    /**
     * 每 project 同时存活的 keepAlive=true session 上限。默认 5 ——
     * 5 × ~$1.9/天/running-pod ≈ $9.5/天/customer，覆盖 PRD §3 Scale tier
     * $499/mo 的 keepAlive 占比预算（cost < 2% of revenue）。范围 [0, 50]：
     * - 0 = 紧急 kill switch，所有 keepAlive: true 请求立即 429 pool.keepalive_saturated
     *       （参考 POOL_TARGET_SIZE=0 的 disable-flag 模式）
     * - 上限 50 是 hard safety cap 防 cost runaway，customer 真需要可以走 ticket
     *   升档（phase 11.5b 考虑加 per-project override）。
     */
    KEEPALIVE_SESSIONS_PER_PROJECT_MAX: z.coerce.number().int().min(0).max(50).default(5),

    // ─── Phase 11.6 Browserbase Contexts API ────────────────────────────────
    // 见 docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md。Contexts 让用户跨多个 session
    // 持久化整个 chromium user-data-dir（cookies + localStorage + IndexedDB + ...）。
    // 与 phase 11.5 keepAlive 互补：keepAlive 跨 WS 重连，contexts 跨 sessionId。

    /**
     * 每 project 同时存活（未 soft-delete）的 contexts 上限。默认 100 ——
     * 100 contexts × ~50MB avg compressed = 5GB/project，单 fly volume (100GB)
     * 容下 20 projects；远超 Hobby tier (5 contexts) / Pro tier (50 contexts) 需求。
     * 范围 [0, 1000]：
     * - 0 = kill switch；POST /v1/contexts 立即 429 pool.contexts_saturated
     * - 上限 1000 是 hard safety cap；客户真要更多走 ticket 升档（phase 11.6b
     *   引入 plan-aware override）
     */
    MOSAIQ_CONTEXTS_PER_PROJECT_MAX: z.coerce.number().int().min(0).max(1000).default(100),
    /**
     * 单个 context snapshot 的最大字节数（compressed + encrypted blob，PUT 入参
     * 大小）。默认 200MB —— 覆盖典型 chromium profile（多数 5–50MB；含重 IDB
     * 用户偶发 100MB+）。范围 [1, 1024]MB。
     *
     * pod snapshotContext 在 PUT 之前自检 size > limit → 不上传，cloud-runtime
     * 收到 413 后保留旧 blob，response 加 snapshotFailed=true 告知客户。
     */
    MOSAIQ_CONTEXT_SIZE_MAX_MB: z.coerce.number().int().min(1).max(1024).default(200),
    /**
     * FsContextStorage 落盘根目录。Prod 走 fly volume mount 在 `/data`，所以
     * 默认 `/data/contexts/`（与 fly.cloud-runtime.toml [mounts] 对齐）。dev /
     * test 单测可覆盖到 tmp 目录。phase 11.6b 加 's3' backend 时此 knob 仅作用
     * 于 storage_backend='fs' 行。
     */
    MOSAIQ_CONTEXT_STORAGE_PATH: z.string().default('/data/contexts'),
    /**
     * AES-GCM master key（32 bytes，base64 编码）。从 fly secrets 注入，**绝不**
     * 出现在源码 / 镜像 / 日志。运行时 HKDF-SHA256(masterKey, projectId, info='mosaiq-ctx-v1')
     * 派生 per-project 32-byte key 用于加密 / 解密 context blob。
     *
     * 缺省空字符串 = phase 11.6 contexts 功能整体禁用（POST /v1/contexts 返 503
     * configuration_error）；这是 prod 必须显式配置才启用的安全姿态，与
     * METRICS_TOKEN 的 disable-by-default 模式同款。
     *
     * Generation: `openssl rand -base64 32`，长度 == 44（含 padding）。
     * 长度 < 44 → schema 报错（防 fly secret 设置错值）。
     */
    MOSAIQ_CONTEXT_MASTER_KEY: z.string().default(''),
    /**
     * HMAC secret（≥ 32 chars） 用于签发 cloud-runtime ↔ pod 内部 endpoint 的
     * 短期 bearer token（5 min TTL）。pod 拿 GET /v1/_internal/contexts/{id}/download
     * 时校验签名 + expiresAt；伪造 token 在 secret 不泄漏前提下 unforgeable。
     *
     * 与 master key 分离：master key 泄漏 → 已落盘的 context blob 可解；HMAC
     * secret 泄漏 → 攻击者可拖取 in-flight context 流量但不能解密。Defense in
     * depth: 两个独立的 fly secrets 同时被攻破才致命。
     *
     * Generation: `openssl rand -base64 64`。
     */
    MOSAIQ_INTERNAL_HMAC_SECRET: z.string().default(''),
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

    // ─── Rate limit (token bucket per api_key_id) ───────────────────────────
    //
    // 三档配置 —— 严格 / 写 / 读，对应不同 cost 的 endpoint：
    //
    //   strict   createSession            （拨 fly machine + 启动 chromium，重）
    //   write    DELETE / PATCH / persona create
    //   read     GET                      （只读 sqlite，便宜）
    //
    // CAPACITY = bucket 容量 = 最大 burst；REFILL_PER_SEC = 稳态 RPS。
    // 计算：稳态 = REFILL_PER_SEC * 60 次/分钟。
    //
    // 默认值参考：
    //   strict 1 RPS (60/min) + burst 10  对应单 SDK 启动连开 10 session 然后稳定
    //   write  5 RPS (300/min) + burst 30 一般写不会爆
    //   read   16 RPS (≈1000/min) + 100 burst SDK getSession poll 不会被卡
    //
    // 运行时调整：改 secrets 然后重启 cloud-runtime 即可，无需 deploy。
    RATE_LIMIT_STRICT_CAPACITY: z.coerce.number().int().min(1).max(10000).default(10),
    RATE_LIMIT_STRICT_REFILL_PER_SEC: z.coerce.number().min(0.01).max(1000).default(1),
    RATE_LIMIT_WRITE_CAPACITY: z.coerce.number().int().min(1).max(10000).default(30),
    RATE_LIMIT_WRITE_REFILL_PER_SEC: z.coerce.number().min(0.01).max(1000).default(5),
    RATE_LIMIT_READ_CAPACITY: z.coerce.number().int().min(1).max(10000).default(100),
    RATE_LIMIT_READ_REFILL_PER_SEC: z.coerce.number().min(0.01).max(1000).default(16),

    // ─── Metrics (prom-client /v1/metrics) ──────────────────────────────────
    //
    // METRICS_TOKEN 留空 → /v1/metrics 整个 disabled（return 404）。这是
    // prod 默认安全姿态：必须显式开启才暴露指标。Prometheus scraper 用
    // Authorization: Bearer <METRICS_TOKEN> 拉。
    //
    // 跟普通 API key 分离：scraper 只看指标，不应该有创建 session 的权限。
    METRICS_TOKEN: z.string().default(''),

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
      if (!env.FLY_POD_APP_NAME) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FLY_POD_APP_NAME'],
          message:
            'FLY_POD_APP_NAME is required when MACHINE_MANAGER=fly (this is the browser-pod fly app, not the cloud-runtime app). NOTE: do NOT name this FLY_APP_NAME — Fly auto-injects that into every machine and would override your secret.',
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
    // Phase 11.5: keepAlive ceiling must accommodate the non-keepAlive ceiling.
    // Otherwise a keepAlive=true request with high ttlSeconds would land on a
    // smaller cap than a normal request, which is nonsensical.
    if (env.SESSION_TTL_MAX_SECONDS > env.SESSION_TTL_MAX_KEEPALIVE_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_TTL_MAX_KEEPALIVE_SECONDS'],
        message:
          'SESSION_TTL_MAX_KEEPALIVE_SECONDS must be >= SESSION_TTL_MAX_SECONDS (keepAlive sessions only extend the ceiling, never shrink it)',
      });
    }
    // Phase 11.6: when MOSAIQ_CONTEXT_MASTER_KEY is set, enforce strong format.
    // Empty (default) = contexts disabled and downstream code returns 503; both
    // secrets being non-empty = enabled. Mismatched (one set, other empty) is a
    // misconfiguration we reject early.
    const ctxKeySet = env.MOSAIQ_CONTEXT_MASTER_KEY !== '';
    const hmacSet = env.MOSAIQ_INTERNAL_HMAC_SECRET !== '';
    if (ctxKeySet !== hmacSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [ctxKeySet ? 'MOSAIQ_INTERNAL_HMAC_SECRET' : 'MOSAIQ_CONTEXT_MASTER_KEY'],
        message:
          'Phase 11.6 contexts require BOTH MOSAIQ_CONTEXT_MASTER_KEY and MOSAIQ_INTERNAL_HMAC_SECRET to be set, or both empty (feature disabled). One-of-two is a misconfiguration.',
      });
    }
    if (ctxKeySet) {
      // base64 32 bytes = 44 chars (incl. padding). Reject shorter to catch
      // truncation in fly secrets shell escaping.
      if (env.MOSAIQ_CONTEXT_MASTER_KEY.length < 40) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MOSAIQ_CONTEXT_MASTER_KEY'],
          message:
            'MOSAIQ_CONTEXT_MASTER_KEY too short; expected base64-encoded 32 bytes (~44 chars). Generate with: openssl rand -base64 32',
        });
      }
      if (env.MOSAIQ_INTERNAL_HMAC_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MOSAIQ_INTERNAL_HMAC_SECRET'],
          message:
            'MOSAIQ_INTERNAL_HMAC_SECRET too short; expected ≥ 32 chars (recommended: openssl rand -base64 64)',
        });
      }
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
