# @mosaiq/cloud-runtime

Mosaiq Cloud control plane — Hono on Node, Fly.io ready.

REST API + CDP-over-WebSocket gateway for the per-session browser pool.

> **状态**：v0.11，phase 11.1 → 11.9 已落地。prod 已部署 Fly.io（region `iad`），含 fly machine pool、Browserbase 兼容、keepAlive 长会话、Contexts API、用量计费（Stripe Billing Meter）、per-project 配额、`GET /v1/sessions` 列表。仍是单实例 + 单 SQLite 卷拓扑（横向扩留后续）。
>
> **设计稿**：[`docs/CLOUD-V0-IMPLEMENTATION.md`](../../docs/CLOUD-V0-IMPLEMENTATION.md)；整体架构 + 注入口径见 [`docs/CLOUD-RUNTIME-ARCH.md`](../../docs/CLOUD-RUNTIME-ARCH.md)

---

## 本地起跑

```bash
# repo 根目录
pnpm install
pnpm --filter @runova/persona-schema build
pnpm --filter @mosaiq/cloud-runtime dev
# → 控制平面 listen :8787（环境变量见 .env.example）
```

dev 模式默认：

- `MACHINE_MANAGER=static`
- `POD_ADDRS=http://localhost:9222` （单 pod，假设你在另一个终端跑了 browser-pod）

第一次起会自动建表 + 用 `SEED_API_KEY` env 写一个 dev key。

如果要 docker compose 一键起 cloud-runtime + 2 pod：

```bash
cd <repo-root>
docker compose -f docker-compose.cloud.yml up --build
```

---

## API 端点（v0.11）

```
GET    /v1/health                      no auth
GET    /v1/metrics                     Bearer METRICS_TOKEN (Prometheus)
POST   /v1/sessions                    Bearer / X-BB-API-Key
GET    /v1/sessions                    Bearer  (BB sessions.list 兼容)
GET    /v1/sessions/:id                Bearer
DELETE /v1/sessions/:id                Bearer
WS     /v1/sessions/:id/cdp            Bearer / ?token=
GET    /v1/usage                       Bearer  (browser-minutes + 费用预估)
POST   /v1/contexts                    Bearer  (BB Contexts API)
DELETE /v1/contexts/:id                Bearer
GET    /v1/personas                    Bearer
POST   /v1/personas                    Bearer
GET    /v1/personas/:id                Bearer
DELETE /v1/personas/:id                Bearer
```

完整 API + 形状细节见 [`docs/CLOUD-RUNTIME-ARCH.md`](../../docs/CLOUD-RUNTIME-ARCH.md) §2。

---

## 子模块

```
src/
├── env.ts                env 校验（zod）
├── app.ts                Hono app 工厂（路由 + middleware）
├── index.ts              Node http.Server + ws upgrade + graceful shutdown
├── db/
│   ├── client.ts         drizzle + better-sqlite3
│   ├── schema.ts         7 张表的 schema（projects/api_keys/sessions/contexts/personas/usage_events/audit_events）
│   ├── bootstrap.ts      CREATE TABLE IF NOT EXISTS
│   └── seed.ts           dev 种子 project + API key
├── middleware/
│   ├── auth.ts           Bearer + sha256 hash 验证
│   └── audit.ts          异步写 audit_events
├── routes/
│   ├── health.ts         GET /v1/health
│   ├── sessions.ts       sessions CRUD + list + BB-compat + 配额
│   ├── personas.ts       personas CRUD
│   ├── contexts.ts       BB Contexts API (POST/DELETE /v1/contexts)
│   ├── usage.ts          GET /v1/usage（browser-minutes 计费）
│   └── metrics.ts        GET /v1/metrics（Prometheus）
├── machine/
│   ├── types.ts          MachineManager interface
│   ├── static.ts         StaticPoolMachineManager (dev 默认，预跑 pod 轮询)
│   ├── local-docker.ts   LocalDockerMachineManager (已落地，docker socket 即时拉起)
│   ├── fly.ts            FlyMachineManager (已落地) + fly-pool.ts 预置停机池 (phase 11.3a)
│   └── factory.ts        按 env.MACHINE_MANAGER 选实现 (static / local-docker / fly)
├── cdp/
│   └── proxy.ts          WS 反向代理：client → pod chromium :9223
└── utils/
    ├── errors.ts         ApiError + Hono onError
    ├── ids.ts            'ses_xxx' 风格 id
    ├── hash.ts           sha256 hex
    └── logger.ts         pino
```

---

## 测试

```bash
pnpm --filter @mosaiq/cloud-runtime test
# 覆盖 env / db bootstrap / sessions(含 BB-compat + 配额 + keepAlive) / contexts /
# usage / metrics / health 路由 + static / fly / fly-pool / local-docker machine
# manager + session-expiry reaper。具体数字以本地跑为准（持续增长）。
```

集成测试用 in-memory sqlite + mock 的 MachineManager / Fly fetch / Docker Engine API + Hono `app.request()` 直接打路由，不需要真起 docker。真实浏览器端到端见 `.github/workflows/cloud-runtime-e2e.yml`。

---

## 当前限制 / 边界（v0.11）

- ❌ **横向扩**：DB 写死 sqlite（单 Fly 卷），rate-limit / sticky registry / machine pool 均为单实例内存态 → 单实例、单点拓扑。多实例 + Postgres / 共享存储留后续。
- ✅ **深层反指纹注入（v0.11 起服务端默认开启）**：pod 在 chromium 起好后服务端注入 `injectAll`（canvas / WebGL / audio / UA-CH / 字体 / worker scope），裸 `connectOverCDP` 也带深层 stealth；每 session 受 `stealth.inject`、pod 受 `POD_SERVER_INJECT` 约束。机制 + 验证见 [`docs/CLOUD-RUNTIME-ARCH.md`](../../docs/CLOUD-RUNTIME-ARCH.md) §2.5。
- ✓ Warm pool（11.3a）+ Sticky / keepAlive 长会话（11.5）+ Contexts API（11.6）+ 用量计费（11.7，Stripe Billing Meter；`STRIPE_API_KEY` 空时走 noop reporter）+ per-project 配额（11.8）+ `GET /v1/sessions` 列表（11.9）均已落地。
- ⚠️ Browserbase compat：`/v1/sessions` dual-shape（X-BB-API-Key + native superset 响应 + BB-shape 请求体）、`keepAlive`、Contexts、`sessions.list()` 已 honor；recording / proxies / browserSettings.fingerprint 等仍为 warn-and-ignore（`response.unsupportedFields[]` 标记）。
- ❌ Live View / Recording：留后续 milestone。

---

## License

Apache-2.0. See [`../../LICENSE.md`](../../LICENSE.md).
