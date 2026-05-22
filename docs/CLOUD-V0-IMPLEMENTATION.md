# Mosaiq Cloud v0 实施说明（ADR）

> **状态**：v0.11 phase 11.1（2026-05-22）—— 控制平面 + browser-pod + cloud-sdk 骨架，本地 docker compose 可起，prod 部署留给后续 phase。
>
> **关系**：本文是 [`CLOUD-RUNTIME-ARCH.md`](./CLOUD-RUNTIME-ARCH.md) 的**实施落地版**。后者描述长期产品愿景（K8s + gVisor + 多 Region + Stagehand 兼容 + Persona Pool + Stripe Metered，对标 Browserbase）；本文描述 v0 真正写代码的范围与决策。两者会持续保持一致性：架构愿景里说的功能，本文标注其落地 phase。

---

## 0. 触发场景

v0.10 之前 Mosaiq 只交付 npm 包（persona-schema / sdk / cli）+ 私有 desktop，**云端 0 行代码**。同期 [LaunchAI](https://github.com/meilimei/LaunchAI)（自主化 AI 营销 agent）的 `BrowserRuntime` prod 路径 `runtime-browserbase.ts` 是 stub `throw new Error('not yet implemented')`，dev 走本地 Playwright，prod 完全没有后端。

v0.11 用 Mosaiq 自家技术栈把 LaunchAI 的 prod 路径填上，同时让架构对齐 `CLOUD-RUNTIME-ARCH.md` 的长期愿景 —— **不做一次性 hack**。

---

## 1. 范围（in / out）

### 1.1 v0.11 = phase 11.1（本次）

| 模块 | 状态 |
|---|---|
| `apps/cloud-runtime/` 控制平面（Hono on Node） | 骨架 + 本地可跑 |
| `apps/browser-pod/` 单 session 镜像（Docker） | 骨架 + 本地可跑 |
| `packages/cloud-sdk/` 客户端 SDK | 完整 v0 API |
| LaunchAI `src/lib/browser/runtime-mosaiq.ts` | 实现 `BrowserRuntime` 契约 |
| 本地 `docker compose -f docker-compose.cloud.yml up` 一键起 | ✅ |
| API 文档 + 接入手册 | ✅ |

### 1.2 明确 cut（后续 phase）

| 功能 | 何时落 |
|---|---|
| Fly.io 真部署（控制平面 + Machine API browser-pod） | v0.12 phase 11.2 |
| Warm pool（冷启动 < 2s） | v0.13 phase 11.3 |
| Usage metering 真接 Stripe Metered | v0.15 phase 11.5 |
| Browserbase 兼容 REST（Stagehand 一行迁移） | v0.13 phase 11.3（路由 stub 已存在） |
| Recording / Live View（noVNC） | v0.14 / v0.15 |
| Persona Pool Service（真机指纹收集回流） | v0.14 phase 11.4 |
| 多 Region（EU-West / APAC） | v0.16 phase 11.6 |
| Admin Console（Next.js 管理台） | v0.15 phase 11.5 |
| MCP server（Claude / Cursor 直连） | v0.16+ |
| SOC 2 Type I | M22 per PRD |
| K8s 迁移 | M14 GA 之前 |

---

## 2. 七大决策（ADR）

### ADR-1：部署形态 = Fly.io Machines（v0 → GA 前迁 K8s）

**选择**：Fly.io Machines（per-session microVM via Firecracker）。

**对比**：

| 方案 | 隔离 | 多 Region | 冷启动 | 运维 | 决策 |
|---|---|---|---|---|---|
| 单 VPS + Docker | 弱（共享 kernel） | 否 | 0.5s | 极简 | ❌ 不够安全 |
| **Fly.io Machines** | **强（Firecracker microVM）** | **原生 anycast 多 region** | **~1s** | **低** | **✅ 选定** |
| K8s + gVisor | 强 | 强 | 1-2s | 高（需 SRE） | M14 GA 前迁 |
| AWS Fargate | 强 | 强 | 3-5s | 中 | 价格贵 30% |

**理由**：
- Firecracker microVM **本身**就是 AWS Lambda / Fly 的隔离基座，强度等同于 gVisor，**无需再叠一层**
- 一个 session = 一个 Machine，Fly Machines API 直接 create/destroy，无需 K8s controller 自己写
- `fly.toml` 配 anycast 多 region 一行搞定，比 K8s + multi-cluster 简单一个数量级
- 按秒计费 + 自动 stop 闲置 Machine，cost-effective
- 用 [`fly machines`](https://fly.io/docs/machines/) 的 REST API，跟 K8s 一样命令式，迁移 K8s 时只需改 `MachineManager` 实现

**回滚条件**：若 Fly 在 chromium workload 下不稳定（GPU passthrough 缺失导致 WebGL 慢、网络抖动），考虑切 Hetzner Cloud + 自托管 Firecracker。

### ADR-2：控制平面框架 = Hono on Node（Cloudflare Workers 兼容）

**选择**：[Hono](https://hono.dev) + Node 18+ adapter。

**理由**：
- Hono 同一份代码可跑 Node / Bun / Cloudflare Workers / Vercel Edge / Deno
- `CLOUD-RUNTIME-ARCH.md` §1.2 写了 API Gateway 是 Cloudflare Workers + Hono，本次 phase 在 Node 上跑，**等多 Region edge 时迁 Workers 零改写**
- 比 Express 轻 10×，比 Fastify 类型友好，社区主流
- 内置 WebSocket upgrade（CDP proxy 需要）

**取舍**：放弃 Express / Fastify。Express 不支持 edge runtime，Fastify 类型推导差。

### ADR-3：浏览器 pod 怎么暴露 CDP = Chromium 原生 `--remote-debugging-port` + 控制平面 WS 反代

**选择**：

```
browser-pod 容器内：
  /entrypoint.sh → spawn chromium with:
    --remote-debugging-port=9223
    --remote-debugging-address=0.0.0.0
    --user-data-dir=/data/profile
    + persona 派生 flags（lang, window-size, timezone）
  端口 9222 是 pod-internal Node HTTP（健康/控制/persona 注入）
  端口 9223 是 chromium 原生 CDP

cloud-runtime 控制平面：
  GET /v1/sessions/:id/cdp（WebSocket 升级）
    → 查 DB 拿到 pod 的 internal 地址
    → 把 client 的 WS 全双工反代到 pod:9223/devtools/<...>
    → 流量永不离开 Mosaiq 边界（隐私 + 计费）
```

**为什么不是 Playwright launchServer？**
- `launchPersistentContext` **没有** `wsEndpoint()`，Playwright 不暴露 server endpoint
- `launchServer()` 只支持非 persistent，无法满足 IndexedDB / Service Worker 持久化（LaunchAI BROWSER_AUTONOMY.md §4.1 已踩过这个坑）

**为什么不是 client 直连 pod？**
- pod 在 Fly Machine 内部网络，外网拿不到稳定地址
- 计费需要控制平面看到流量（按 minute 计费要知道 session 是否在使用）
- 多租户安全：客户拿到一个 sessionId + token，控制平面验证，pod 永远不暴露给公网

**Persona 注入怎么办？**
- pod **不做** Playwright 级注入，只负责 chromium-flag 级配置（lang、window-size、proxy、user-agent via cmdline）
- 客户端 `@mosaiq/cloud-sdk` 拿到 cdpUrl 后 `chromium.connectOverCDP(cdpUrl)`，对 `browser.contexts()[0]` 调 `addInitScript()` 注入 `@mosaiq/sdk/injection` 的 `buildInjectionConfig + injectAll`
- 注入逻辑 100% 复用 SDK，无重复实现

### ADR-4：API 形状 = `@mosaiq/cloud-sdk` 原生为主，Browserbase 兼容为辅

**选择**：

| API | 形状 | phase |
|---|---|---|
| **`@mosaiq/cloud-sdk`**（TypeScript-first） | `new MosaiqCloudClient({...}).createSession({...})` → `ManagedCloudSession` | 11.1 ✅ |
| Browserbase 兼容 REST（`POST /v1/sessions` 等） | mirror Browserbase 数据格式，让 Stagehand `apiUrl` 一行切 | 11.3 路由 stub 11.1 |
| MCP server | `@mosaiq/mcp-server` 包 | 11.6+ |

**理由**：
- LaunchAI 是首要用户，TypeScript 原生 SDK 体验最好（强类型 + 完整 persona 字段暴露）
- Browserbase 兼容是 GTM 钩子，但 v0.11 没有外部客户，stub 即可
- 一套底层实现，两套门面，工作量小

### ADR-5：反检测 = 默认全开，per-session 可关

**选择**：

```typescript
client.createSession({
  persona: { ... },  // 必填
  stealth: {
    inject: true,      // 默认 true，关闭 = 纯 raw chromium
    humanize: true,    // 默认 true，关闭 = Page 上不绑 Humanize
    rebrowserPatches: true, // pod 镜像默认带，可在 session 级关
  }
})
```

**理由**：
- Mosaiq 的存在价值就是反检测；云端没有反检测 = 给 Browserbase 做嫁衣
- LaunchAI 操作的是用户**已登录**的合法账号，部分平台风控宽松，给 `stealth: false` 省启动时间是合理需求
- per-session 开关比 per-pod 开关灵活（同一 pod 复用，但不同 session 策略不同）—— phase 11.3 warm pool 后才能复用 pod，本次每个 session 一个新 pod，开关其实是 pod 级

### ADR-6：DB = Drizzle ORM + SQLite（dev）/ Postgres（prod）

**选择**：Drizzle + better-sqlite3（dev）+ postgres（prod，复用 LaunchAI 的 Supabase 或独立 Supabase 项目）。

**理由**：
- Drizzle 类型推导 + 多方言（同 schema 跑 sqlite/postgres/mysql）
- SQLite 让 `pnpm cloud:dev` 零依赖起跑（不需要 docker postgres）
- prod 切 Supabase = LaunchAI 已经在用，复用账号
- Schema 一开始就为 ClickHouse-friendly usage events 表设计，方便未来导计费数仓

### ADR-7：认证 = bearer API key + HMAC，per-project 隔离

**选择**：

```
Authorization: Bearer msq_sk_live_<32 hex>
```

- API key 在 DB 存 `sha256(key)`，明文只在创建时返回一次（Stripe 风格）
- 每个 project_id 一个或多个 key
- v0.11 不做 quota / rate limit，只做认证 + project_id 隔离
- 流量审计日志默认开启（写 `cloud_audit_events` 表）

---

## 3. 仓库与端口分布

### 3.1 新增目录

```
Mosaiq/
├── apps/
│   ├── desktop/                      # 现有
│   ├── cloud-runtime/                # 新增（本 phase）
│   └── browser-pod/                  # 新增（本 phase）
├── packages/
│   ├── persona-schema/
│   ├── sdk/
│   ├── cli/
│   └── cloud-sdk/                    # 新增（本 phase）
├── docker-compose.cloud.yml          # 新增（本 phase）
└── docs/
    ├── CLOUD-RUNTIME-ARCH.md         # 现有：愿景
    ├── CLOUD-V0-IMPLEMENTATION.md    # 本文：实施
    └── LAUNCHAI-INTEGRATION.md       # 新增：接入手册
```

### 3.2 端口约定

| 服务 | 端口 | 暴露范围 |
|---|---|---|
| `cloud-runtime` 控制平面 HTTP/WS | **8787** | 公网（dev 是 host:8787） |
| `browser-pod` 内部 HTTP（健康/控制） | 9222 | pod-internal + 控制平面（不公网） |
| `browser-pod` chromium 原生 CDP | 9223 | pod-internal + 控制平面（**不公网**） |
| Postgres（dev 可选） | 5432 | localhost |

控制平面是唯一暴露给客户端的入口；pod 永远在内部网。

### 3.3 一次 session 的数据流

```
                  ┌─────────────────────────────────────────┐
                  │ LaunchAI worker (Node)                  │
                  │  import { MosaiqCloudClient }            │
                  │     from '@mosaiq/cloud-sdk'             │
                  └────────────────┬────────────────────────┘
                                   │ 1) POST /v1/sessions
                                   │    Authorization: Bearer msq_sk_...
                                   ▼
                  ┌─────────────────────────────────────────┐
                  │ cloud-runtime (Hono + Node, :8787)       │
                  │  - 校验 API key                          │
                  │  - 调 MachineManager.acquire(spec)        │
                  │  - 拿到 pod 内部地址 + sessionId          │
                  │  - 写 cloud_sessions 表                  │
                  └────────┬────────────────────┬────────────┘
                           │ 2) acquire         │ 5) WS upgrade
                           ▼                    │   /v1/sessions/:id/cdp
                  ┌──────────────────┐         │
                  │ MachineManager    │         │
                  │  - LocalDocker    │         │
                  │  - Fly (phase B)  │         │
                  │  - K8s (future)   │         │
                  └────────┬─────────┘         │
                           │ 3) docker run /    │
                           │    fly create      │
                           ▼                    │
                  ┌─────────────────────────────┴────────────┐
                  │ browser-pod (per session)                │
                  │  - :9222 Node HTTP (health/control)      │
                  │  - :9223 chromium --remote-debugging-port│
                  │  - /data/profile Fly Volume (持久化)     │
                  │  ┌──────────────────────────────────────┐│
                  │  │ chromium 进程                         ││
                  │  │  --user-data-dir=/data/profile        ││
                  │  │  --remote-debugging-port=9223         ││
                  │  │  + persona 派生 flags                 ││
                  │  └──────────────────────────────────────┘│
                  └──────────────────────────────────────────┘
                           ▲ 6) WS 全双工反代
                           │    控制平面是透明 proxy
                           │
       client 拿到 (sessionId, ws://control-plane:8787/v1/sessions/:id/cdp)
       → chromium.connectOverCDP(wsUrl)
       → browser.contexts()[0].addInitScript({ content: <persona 注入脚本> })
       → 之后任何 newPage() / 操作 都被注入加固
```

---

## 4. 数据模型（Drizzle schema 摘录）

完整 schema 见 `apps/cloud-runtime/src/db/schema.ts`。

```typescript
// projects: 一个项目（如 LaunchAI）一行
projects {
  id: text PK         // 'proj_launchai'
  name: text
  created_at: timestamp
}

// api_keys: 一个项目可以有多个 key（rotation）
api_keys {
  id: text PK         // 'apk_xxx'
  project_id: text FK
  key_hash: text      // sha256(plaintext)
  prefix: text        // 'msq_sk_live_<8 chars>' 用于 UI 显示
  created_at: timestamp
  revoked_at: timestamp NULL
  last_used_at: timestamp NULL
}

// sessions: 一次浏览器 session 一行
sessions {
  id: text PK         // 'ses_xxx'
  project_id: text FK
  persona_id: text NULL    // 复用 persona 时填
  machine_id: text          // 'mch_xxx' / Fly machine id / docker container id
  status: text              // 'requested' | 'live' | 'closed' | 'errored'
  cdp_internal_url: text    // 控制平面用，比如 ws://pod-7:9223/...
  opened_at: timestamp
  closed_at: timestamp NULL
  ttl_seconds: integer
  last_seen_at: timestamp
  client_addr: text NULL
  error_message: text NULL
  metadata: jsonb           // headful?, stealth opts, etc.
}

// personas: cloud-side persona pool（M11+ 真正起飞，本 phase 只存）
personas {
  id: text PK         // 'pers_xxx'
  project_id: text FK NULL  // NULL = 全局可用（seed pool）
  source: text              // 'user' | 'seed' | 'capture'
  persona_json: jsonb       // 整个 Persona 对象
  created_at: timestamp
  updated_at: timestamp
}

// usage_events: 计费埋点（本 phase 只写，Stripe phase 11.5 才消费）
usage_events {
  id: text PK
  project_id: text FK
  session_id: text NULL
  kind: text                // 'session.minute' | 'persona.checkout' | 'proxy.gb'
  value: numeric            // 1.0 = 1 unit
  ts: timestamp
}

// audit_events: 审计日志（phase 11.3 起做 export）
audit_events {
  id: text PK
  project_id: text NULL
  api_key_id: text NULL
  action: text              // 'session.create' | 'session.close' | 'auth.fail'
  resource: text            // 'session:ses_xxx'
  result: text              // 'ok' | 'denied' | 'errored'
  ip: text NULL
  ts: timestamp
  detail: jsonb
}
```

---

## 5. API 契约（v0.11）

### 5.1 `POST /v1/sessions`

**Request**：

```jsonc
{
  "project_id": "proj_launchai",       // 必填，必须匹配 API key 的 project
  "persona": {
    "id": "pers_xxx",                  // 选 1：复用已注册 persona
    "inline": { /* 完整 Persona JSON */ }, // 选 2：用一次性 persona（不入库）
    "filter": { "os": "win11", "region": "US" } // 选 3（phase 11.4）：自动选
  },
  "stealth": {
    "inject": true,                    // 默认 true
    "humanize": true,                  // 默认 true
    "rebrowserPatches": true           // 默认 true
  },
  "lifecycle": {
    "ttl_seconds": 1800,               // 默认 1800（30 分钟），最大 7200
    "keep_alive": false                // phase 11.3 warm pool 后才有意义
  },
  "viewport": { "width": 1920, "height": 1080 },   // 可选，默认从 persona
  "client_label": "launchai-reddit-session-42"     // 客户端打的 tag，纯审计用
}
```

**Response 201**：

```jsonc
{
  "id": "ses_xxx",
  "project_id": "proj_launchai",
  "status": "live",
  "cdp_url": "wss://api.mosaiq.dev/v1/sessions/ses_xxx/cdp",  // dev 是 ws://localhost:8787/...
  "persona": { /* 完整 Persona JSON，client 用于本地注入 */ },
  "stealth": { "inject": true, "humanize": true, "rebrowserPatches": true },
  "expires_at": "2026-05-22T07:50:00Z",
  "live_view_url": null,               // phase 11.5 后填
  "created_at": "2026-05-22T07:20:00Z"
}
```

**Errors**：

| HTTP | code | 含义 |
|---|---|---|
| 401 | `auth.invalid_key` | API key 不存在 / 已 revoke |
| 403 | `auth.project_mismatch` | API key 不属于请求的 project |
| 422 | `request.invalid` | body 校验失败（zod 错误） |
| 503 | `pool.exhausted` | 无可用 pod（本 phase 直接 503） |
| 500 | `internal.unknown` | 兜底 |

### 5.2 `GET /v1/sessions/:id`

返回 session 当前状态（同上 response 结构，外加 `last_seen_at`）。

### 5.3 `DELETE /v1/sessions/:id`

幂等关闭 session。返回 `204`。

### 5.4 `GET /v1/sessions/:id/cdp`（WebSocket）

控制平面把 client 的 WS 全双工反代到 pod 的 chromium CDP。客户端不应直接调，而是通过 `chromium.connectOverCDP(session.cdp_url)`。

### 5.5 `GET /v1/personas`、`POST /v1/personas`、`GET /v1/personas/:id`

CRUD 复用 `@mosaiq/persona-schema` 的 Zod schema 校验。phase 11.1 只支持 user-uploaded persona；seed pool 和 capture 走 phase 11.4。

### 5.6 `GET /v1/health`

```json
{ "ok": true, "version": "0.11.0", "machine_manager": "local-docker", "pool": { "ready": 2, "busy": 0, "cap": 2 } }
```

### 5.7 Browserbase 兼容路由（phase 11.3 实现，本 phase 占位 501）

- `POST /v1/sessions/browserbase-compat` → mirror Browserbase 的 create-session 数据格式
- `GET /v1/sessions/:id/browserbase-compat` → mirror Browserbase 的 session info 格式
- `GET /v1/connect/:id` → Browserbase 的 connect 端点别名

详细字段映射在 phase 11.3 PR 里定。

---

## 6. 本地开发

### 6.1 `docker-compose.cloud.yml` 一键起

```bash
cd D:/projects/Mosaiq
pnpm install
pnpm -r --filter "./packages/*" --filter "./apps/cloud-runtime" --filter "./apps/browser-pod" build
docker compose -f docker-compose.cloud.yml up --build
```

起来后：

- 控制平面 `http://localhost:8787`，默认 API key 在 docker-compose 的 env 里（`msq_sk_dev_seed_<...>`），LaunchAI 把它放 `.env.local` 的 `MOSAIQ_API_KEY`
- 2 个预跑的 browser-pod 容器（`browser-pod-1`, `browser-pod-2`），控制平面用 `StaticPoolMachineManager` 轮询分配

### 6.2 不用 docker（纯 Node + 本地 chromium）

```bash
# 控制平面
pnpm --filter @mosaiq/cloud-runtime dev

# browser-pod（在另一个终端）
pnpm --filter @mosaiq/browser-pod dev

# 控制平面 env：MACHINE_MANAGER=static，POD_ADDRS=http://localhost:9222
```

这种模式只能起一个 pod，方便单步调试。

---

## 7. LaunchAI 接入摘要

详见 [`LAUNCHAI-INTEGRATION.md`](./LAUNCHAI-INTEGRATION.md)。一句话：

```typescript
// D:/projects/LaunchAI/src/lib/browser/runtime-mosaiq.ts
import { MosaiqCloudClient } from '@mosaiq/cloud-sdk'

const client = new MosaiqCloudClient({
  apiUrl: process.env.MOSAIQ_API_URL!,
  apiKey: process.env.MOSAIQ_API_KEY!,
})

export const mosaiqCloudRuntime: BrowserRuntime = {
  kind: 'mosaiq',
  async startSession(input) {
    const sess = await client.createSession({ /* ... */ })
    const browser = await chromium.connectOverCDP(sess.cdpUrl)
    const ctx = browser.contexts()[0] ?? await browser.newContext()
    await sess.injectInto(ctx)   // persona 注入 + humanize
    const page = ctx.pages()[0] ?? await ctx.newPage()
    if (input.startUrl) await page.goto(input.startUrl)
    return { id: sess.id, runtime: 'mosaiq', page, saveStorageState, close }
  },
}
```

LaunchAI `.env.local` 加：

```
BROWSER_RUNTIME=mosaiq
MOSAIQ_API_URL=http://localhost:8787    # prod: https://api.mosaiq.dev
MOSAIQ_API_KEY=msq_sk_dev_seed_xxxxxxxx
MOSAIQ_PROJECT_ID=proj_launchai
```

---

## 8. Phase roadmap（cloud 部分）

| Phase | 目标 | 验收 |
|---|---|---|
| **11.1（本 phase）** | 骨架 + 本地 docker compose | LaunchAI dev 可切 `BROWSER_RUNTIME=mosaiq` 完成 1 次真实 Reddit launch session |
| **11.2** | Fly.io 部署 | 控制平面跑在 fly.io；MachineManager 调 Fly Machines API；首次 LaunchAI prod 调用 |
| **11.3** | Warm pool + Browserbase 兼容 REST 真实现 | 冷启动 P50 < 2s；Browserbase Stagehand 改 apiUrl 一行能跑 |
| **11.4** | Persona Pool Service GA | 真机指纹收集回流；filter-based persona selection |
| **11.5** | Stripe Metered + Admin Console | usage_events 真扣费；Next.js 管理台上线 |
| **11.6** | 多 Region | fly.toml 加 EU-West；地理路由 |
| **11.7+** | MCP server / Captcha / SOC 2 | 见 `CLOUD-RUNTIME-ARCH.md` §6 |

---

## 9. 风险登记

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| chromium 在 Firecracker microVM 内 WebGL 性能差 | 中 | 中 | 早期跑 detection-lab 基线，若 webgl score 跌 > 10 分，加 swrast or 切方案 |
| Fly Machine API 配额（free tier 3 个 Machine） | 高 | 中 | phase 11.2 前升 hobby plan；本 phase 不依赖 Fly |
| LaunchAI 的 `BrowserStorageState`（cookies + localStorage）和 cloud-pod 的持久化模型不同 | 中 | 高 | cloud-sdk 在 `saveStorageState()` 调 `context.storageState()`；持久化由 pod /data/profile + sticky session 保证（同 userId+platform 路由到同 pod） |
| CDP WS 反代在控制平面占内存 | 中 | 中 | phase 11.2 起 metric `mosaiq_cdp_proxy_active_streams`，超过 1000 单 instance 拆 |
| Persona 注入脚本在 connectOverCDP 后的 context 不生效 | 中 | 高 | cloud-sdk 写了 e2e smoke `injection-survives-cdp.test.ts`（phase 11.1 必过） |
| LaunchAI 多 worker 并发跑同 (userId, platform) | 高 | 中 | 控制平面 sticky 路由 + pod 单写者锁（已在 LocalPlaywrightRuntime 实现，cloud 沿用） |

---

## 10. 决策修订记录

| 日期 | 修订 | 触发 |
|---|---|---|
| 2026-05-22 | 初版 | v0.11 phase 11.1 启动 |

---

**owner**：cloud infra
**review**：creator
**next update**：v0.12 phase 11.2（Fly.io 部署）
