# @mosaiq/cloud-runtime

Mosaiq Cloud control plane — Hono on Node, Fly.io ready.

REST API + CDP-over-WebSocket gateway for the per-session browser pool.

> **状态**：v0.11 phase 11.1 — 本地 docker compose 可起，prod Fly.io 部署留 phase 11.2。
>
> **设计稿**：[`docs/CLOUD-V0-IMPLEMENTATION.md`](../../docs/CLOUD-V0-IMPLEMENTATION.md)

---

## 本地起跑

```bash
# repo 根目录
pnpm install
pnpm --filter @mosaiq/persona-schema build
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

## API 端点（v0.11 phase 11.1）

```
GET    /v1/health                      no auth
POST   /v1/sessions                    Bearer
GET    /v1/sessions/:id                Bearer
DELETE /v1/sessions/:id                Bearer
WS     /v1/sessions/:id/cdp            Bearer / ?token=
GET    /v1/personas                    Bearer
POST   /v1/personas                    Bearer
GET    /v1/personas/:id                Bearer
DELETE /v1/personas/:id                Bearer
```

完整 API + 形状细节见设计稿 §5。

---

## 子模块

```
src/
├── env.ts                env 校验（zod）
├── app.ts                Hono app 工厂（路由 + middleware）
├── index.ts              Node http.Server + ws upgrade + graceful shutdown
├── db/
│   ├── client.ts         drizzle + better-sqlite3
│   ├── schema.ts         6 张表的 schema
│   ├── bootstrap.ts      CREATE TABLE IF NOT EXISTS
│   └── seed.ts           dev 种子 project + API key
├── middleware/
│   ├── auth.ts           Bearer + sha256 hash 验证
│   └── audit.ts          异步写 audit_events
├── routes/
│   ├── health.ts         GET /v1/health
│   ├── sessions.ts       sessions CRUD
│   └── personas.ts       personas CRUD
├── machine/
│   ├── types.ts          MachineManager interface
│   ├── static.ts         StaticPoolMachineManager (phase 11.1 默认)
│   ├── local-docker.ts   占位（phase 11.1 不 ship）
│   ├── fly.ts            占位（phase 11.2）
│   └── factory.ts        按 env.MACHINE_MANAGER 选实现
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
# 25/25 — 包括 static-pool / app integration / bootstrap idempotent
```

集成测试用 in-memory sqlite + fake MachineManager + Hono `app.request()` 直接打路由，不需要真起 docker。

---

## 当前限制（phase 11.1）

- ❌ Postgres：DB 写死 sqlite。phase 11.2 切 Fly + Postgres
- ❌ Warm pool / sticky session：每次 acquire 是 round-robin 的，session 重启不会复用同 pod
- ⚠️ Browserbase compat：phase 11.4 已支持 `/v1/sessions` 上 dual-shape（X-BB-API-Key 头 + native superset 响应 + BB-shape 请求体）；剩下 keepAlive / recording / proxies / browserSettings.fingerprint 等字段为 warn-and-ignore（response.unsupportedFields[] 标记）
- ❌ Stripe metered：`usage_events` 表已有，但没有 emitter。phase 11.5 起做
- ❌ Live View / Recording：phase 11.5 起做

---

## License

Apache-2.0. See [`../../LICENSE.md`](../../LICENSE.md).
