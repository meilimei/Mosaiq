# Phase 11.2 — Fly.io 部署 Runbook

**目的**：把 Mosaiq Cloud 控制平面 + browser-pod 上 Fly.io，验证 prod 路径（per-session microVM、6PN 私网、Fly Machines API）端到端可用。

**前置阅读**：

- `docs/PHASE-11.2-LOCAL-DOCKER.md` — LocalDocker dev parity runbook（拓扑跟 Fly 同构）。
- `apps/cloud-runtime/src/machine/fly.ts` — `FlyMachineManager` 实现细节。
- `fly.cloud-runtime.toml`、`fly.browser-pod.toml` — Fly app 配置。

---

## 1. 拓扑

```
                            Internet
                                │
                                ▼  HTTPS (Fly proxy, anycast)
        ┌─────────────────── mosaiq-cloud-runtime.fly.dev ──────────────────┐
        │                                                                   │
        │   cloud-runtime  (1 long-lived VM, primary_region=iad)            │
        │   ├─ Hono :8787  (REST /v1/* + WS /v1/sessions/:id)               │
        │   ├─ sqlite on /data  (Fly Volume `cloud_runtime_data`, 1 GB)     │
        │   ├─ MACHINE_MANAGER=fly                                           │
        │   └─ env.FLY_API_TOKEN drives Fly Machines API                     │
        │             │                                                      │
        │             │ POST /v1/apps/mosaiq-browser-pod/machines            │
        │             │ DELETE .../machines/:id?force=true                   │
        │             ▼                                                      │
        │   ┌──────── mosaiq-browser-pod (Fly app, no default fleet) ──┐    │
        │   │                                                            │    │
        │   │  per-session microVM #1  (chromium :9222 control / :9223 CDP)│
        │   │  per-session microVM #2                                      │
        │   │  ...                                                         │
        │   │                                                              │
        │   │  6PN IPv6 private network (no public IPs, no [services])    │
        │   └─────────────────────────────────────────────────────────────┘
        └───────────────────────────────────────────────────────────────────┘
```

**跟 LocalDocker 的同构关系**：

| Fly                                     | LocalDocker                              |
| --------------------------------------- | ---------------------------------------- |
| `FLY_API_TOKEN`                         | mount `/var/run/docker.sock`             |
| Fly Machines API                        | Docker Engine API (via undici)           |
| 6PN IPv6 private network                | docker user-defined network internal IP  |
| Fly Machine (microVM)                   | docker container                         |
| `mosaiq-browser-pod` app namespace      | `mosaiq/browser-pod:0.11.0` image tag    |
| `FLY_APP_NAME` env on cloud-runtime     | `DOCKER_IMAGE` env on cloud-runtime      |

两边走 **同一份** `apps/cloud-runtime/src/machine/pod-control.ts`（`callPodStart` / `callPodStop` / `waitForPodReady` / `rewriteCdpHost`），所以 wire 协议一致。LocalDocker e2e 跑通后，上 Fly 风险主要在 Fly-specific 配置（fly.toml / secrets / volume）而非业务代码。

---

## 2. 前置条件

### 2.1 flyctl 安装 + 登录

```bash
# Linux / macOS / WSL2
curl -L https://fly.io/install.sh | sh

# 跑 flyctl auth login，打开浏览器一次性 OAuth
flyctl auth login
flyctl auth whoami
```

### 2.2 Fly 组织 + token

我们需要一个 **org-level deploy token** 给 cloud-runtime 用（让 cloud-runtime 在 prod 跑时能调 Machines API 操作 `mosaiq-browser-pod` app）。

```bash
# 列出 org，复制 your-org slug：
flyctl orgs list

# 在那个 org 下生成 deploy token：
flyctl tokens create deploy --org your-org --expiry 8760h > ~/.fly-machines-token
chmod 600 ~/.fly-machines-token
```

> ⚠️ 这个 token 可以创建 / 销毁 org 内任意 app 的 machine。如果你想隔离权限，可以 `flyctl tokens create deploy --org your-org --app mosaiq-browser-pod`（app-scoped），但 cloud-runtime 暂时不需要管理自己的 app，所以 app-scoped 给 browser-pod 就够。

---

## 3. 创建两个 Fly App

```bash
# 1) browser-pod template app（不长跑，只是 namespace + image registry）
flyctl apps create mosaiq-browser-pod --org your-org

# 2) cloud-runtime control plane（long-lived）
flyctl apps create mosaiq-cloud-runtime --org your-org
```

> 命名约束：`mosaiq-browser-pod` 和 `mosaiq-cloud-runtime` 是 **fly.toml 里硬编码的 `app =` 值**。如果你必须改名，同步改两个 fly.toml + `FLY_APP_NAME` secret 即可。

---

## 4. 部署 browser-pod 镜像

只 build + push，**不** 创建任何默认 machine：

```bash
flyctl deploy --config fly.browser-pod.toml \
              --dockerfile apps/browser-pod/Dockerfile \
              --build-only --push
```

预期输出：
```
==> Building image
... [chromium download in playwright base + multistage build]
--> Pushing image to fly
==> Image pushed: registry.fly.io/mosaiq-browser-pod:deployment-...
✓ Deployment complete
```

验证 image 已 push：
```bash
flyctl image show --app mosaiq-browser-pod
```

> ⚠️ 别跑普通 `flyctl deploy ...`（不带 `--build-only --push`）— 它会 build + push **+ create 1 个 default machine**，这台 machine 会无意义 idle 烧钱。

---

## 5. 部署 cloud-runtime

### 5.1 创建 sqlite volume

```bash
flyctl volumes create cloud_runtime_data \
  --app mosaiq-cloud-runtime \
  --region iad \
  --size 1
```

volume 名 `cloud_runtime_data` 必须跟 `fly.cloud-runtime.toml` 的 `[[mounts]] source` 一致。

### 5.2 设 secrets

```bash
flyctl secrets set \
  FLY_API_TOKEN=$(cat ~/.fly-machines-token) \
  FLY_APP_NAME=mosaiq-browser-pod \
  --app mosaiq-cloud-runtime
```

> Fly 会 restart 还没跑的 machine — 但因为我们还没 deploy，这里 secrets 只是预先写进 staging slot，第一次 deploy 自动注入。

### 5.3 部署

```bash
flyctl deploy --config fly.cloud-runtime.toml \
              --dockerfile apps/cloud-runtime/Dockerfile
```

预期：build (~3-5 min cold) → push → 创建 1 个 machine → mount volume → 启动 → healthcheck 通过 → 出 anycast IP。

### 5.4 Smoke

```bash
curl -s https://mosaiq-cloud-runtime.fly.dev/v1/health | jq
```

期望：
```json
{
  "ok": true,
  "pool": { "ready": 10, "busy": 0, "cap": 10 },
  "manager": "fly",
  "version": "0.11.0",
  ...
}
```

`manager: "fly"` 确认走的是 prod 路径。

---

## 6. 首次 bootstrap prod API key

`NODE_ENV=production` 禁用了 `SEED_API_KEY`（env.ts 强制为空），所以启动时 `seedDevAuth()` 不会写入任何 key。第一个真实 key 必须用 admin 工具建：

```bash
# 进入 cloud-runtime 容器，调 admin/create-api-key.js
flyctl ssh console -a mosaiq-cloud-runtime \
  -C 'node dist/admin/create-api-key.js proj_launchai'
```

输出（保管好 `plaintext` —— 这是唯一可见的一次）：
```json
{
  "status": "created",
  "projectId": "proj_launchai",
  "apiKeyId": "apk_xxxxxxxxxxxxxxxxxxxxxx",
  "prefix": "msq_sk_live_xxxxxxxx",
  "plaintext": "msq_sk_live_aaaaaaaaaaaaaaaaaaaaaa",
  "warning": "STORE THE PLAINTEXT NOW — IT IS NOT RECOVERABLE"
}
```

如果你想 **预先生成** plaintext（例如 LaunchAI 把它写进自己的 secret manager），第二个参数传过去：
```bash
flyctl ssh console -a mosaiq-cloud-runtime \
  -C 'node dist/admin/create-api-key.js proj_launchai msq_sk_live_PRE_GENERATED_KEY'
```

幂等：同一 plaintext 跑第二次返回 `status: "exists"`、不输出 plaintext。

---

## 7. 端到端验证（SDK e2e smoke）

在本机跑 phase 11.1+ 的 e2e-smoke，把 endpoint 指到 Fly：

```bash
export MOSAIQ_API_URL=https://mosaiq-cloud-runtime.fly.dev
export MOSAIQ_API_KEY=msq_sk_live_aaaaaaaaaaaaaaaaaaaaaa  # 来自第 6 节
export MOSAIQ_PROJECT_ID=proj_launchai

# 1) 注册一个 persona（一次性）
node packages/cloud-sdk/scripts/register-persona.mjs

# 2) 跑完整 smoke：createSession → fly 拉 machine → chromium boot →
#    CDP ws over HTTPS → playwright-core connectOverCDP → injectInto →
#    page.evaluate persona assertions → close → fly destroy
node packages/cloud-sdk/scripts/e2e-smoke.mjs
```

预期结尾：
```
🎉 e2e smoke PASSED in 22.5s
```

第一次跑因为 fly machine 冷启动会多 ~10-15s（image pull + chromium boot）。

---

## 8. 运维

### 实时日志

```bash
# 控制平面
flyctl logs -a mosaiq-cloud-runtime

# 某个 session 的 pod machine（machine id 在 cloud-runtime 日志里）
flyctl logs -a mosaiq-browser-pod -i <machine-id>
```

### 列 / 销毁僵尸 machine

```bash
flyctl machine list -a mosaiq-browser-pod
# manager 应该已经 force-destroy 了 release 的 machine；找孤儿：
flyctl machine list -a mosaiq-browser-pod --json | \
  jq '.[] | select(.state == "stopped" or .state == "failed") | .id' -r | \
  xargs -I {} flyctl machine destroy --force {} -a mosaiq-browser-pod
```

### Session 过期自动清理（reaper job）

控制平面启动时会跑一个内置 reaper：每 `SESSION_EXPIRY_INTERVAL_MS`（默认 30000ms）扫一次 sessions 表，把 `status='live'` 但 `expires_at < now()` 的 row 强制走完整 release（`fly machines destroy` + DB row 标 `closed`，`error_message='expired'`）。

这是 prod 资源池防泄漏的最后一道防线 —— SDK / client 即使 crash 不调 `DELETE /v1/sessions/:id`，pod machine 也会在 TTL 过期 + 一个 reaper tick 之内被回收。

观察 reaper 是否在跑：
```bash
flyctl logs -a mosaiq-cloud-runtime | grep -E 'session-expiry'
# 看到这两类日志：
#   "session-expiry job started"          — bootstrap 时一次
#   "session-expiry: reaped expired sessions"  — 每 tick 找到 ≥1 条时
# 没找到过期 session 的 tick 不打日志（避免噪音），属正常。
```

手动触发 reap（不需要 —— reaper 自己跑）；如果想 debug 某条 expired session 没被收，sql 直查：
```bash
flyctl ssh console -a mosaiq-cloud-runtime
sqlite3 /data/cloud-runtime.db \
  "SELECT id, machine_id, status, expires_at FROM sessions \
   WHERE status IN ('live','requested') AND expires_at < datetime('now') \
   ORDER BY expires_at LIMIT 20;"
# reaper 下次 tick 应该全部清掉；如果不清，看 cloud-runtime 日志里 reaper warn。
```

调小 `SESSION_EXPIRY_INTERVAL_MS` 到 5000 可以让 prod 更激进回收（代价：sqlite 扫表 6× 变频），不建议设 < 1000ms（启动会被 env schema 拒）。

### 滚动升级 cloud-runtime

普通 deploy 即可：
```bash
flyctl deploy --config fly.cloud-runtime.toml --dockerfile apps/cloud-runtime/Dockerfile
```

Fly 会建新 machine → healthcheck 通过 → 切流量 → 销毁旧 machine。**正在跑的 session 不会受影响**（pod machine 是独立 app，跟 control plane 重启解耦），只是新建 session 短时不可用。

### 滚动升级 browser-pod

```bash
flyctl deploy --config fly.browser-pod.toml --dockerfile apps/browser-pod/Dockerfile --build-only --push
```

新镜像 `:latest` 推上去后，**已经存在的 pod machine 还是用旧镜像**（fly machine 一旦创建就 frozen 它的 image ref）。新 session 用新镜像。如果想强制现有 machine 也切，destroy 它们让 manager 重新拉：
```bash
flyctl machine list -a mosaiq-browser-pod --json | jq '.[].id' -r | \
  xargs -I {} flyctl machine destroy --force {} -a mosaiq-browser-pod
```

### Rotate secrets

```bash
# 新 token
flyctl tokens create deploy --org your-org --expiry 8760h > ~/.fly-machines-token.new

# 灌进 cloud-runtime
flyctl secrets set FLY_API_TOKEN=$(cat ~/.fly-machines-token.new) -a mosaiq-cloud-runtime
# secrets set 自动 restart machine

# 撤销老 token
flyctl tokens list
flyctl tokens revoke <old-token-id>
```

### Rotate API key（业务级）

```bash
# 建新 key
flyctl ssh console -a mosaiq-cloud-runtime \
  -C 'node dist/admin/create-api-key.js proj_launchai'

# 把新 plaintext 给 LaunchAI / 客户端，等他们切完，再吊销旧 key
# (revoke 工具是 phase 11.3 的事；现在的 stop-gap：
#   flyctl ssh console -a mosaiq-cloud-runtime
#   sqlite3 /data/cloud-runtime.db "UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'apk_xxx';"
# )
```

---

## 9. Troubleshooting

### `pool.exhausted` from createSession

`FLY_MAX_MACHINES=10` 在 fly.cloud-runtime.toml [env]。dev 给 10，prod 想给更多就改这个值 + `flyctl deploy`。Fly org-level concurrent-machine 上限也可能在 ~25 起，需要升级 Fly plan。

### Machine 一直 `state: starting` 不到 `started`

```bash
flyctl logs -a mosaiq-browser-pod -i <machine-id>
```

常见原因：
- 镜像 pull 慢（Fly registry 第一次 cold pull 可达 1-2 min）— 提高 `waitForStartedTimeoutMs` 到 60s（phase 11.3 改）
- chromium OOM — guest memory 太小，把 `FLY_MACHINE_MEMORY_MB` 调到 2048+（默认 2048 应该够，1024 容易 OOM）
- pod 容器 entrypoint crash — pod 日志里通常有 stack

### `Machines API 401`

`FLY_API_TOKEN` secret 没设 / 已过期 / 没权限。重发 secret：
```bash
flyctl secrets set FLY_API_TOKEN=$(cat ~/.fly-machines-token) -a mosaiq-cloud-runtime
```

### sqlite 状态异常

```bash
flyctl ssh console -a mosaiq-cloud-runtime
sqlite3 /data/cloud-runtime.db ".schema"
sqlite3 /data/cloud-runtime.db "SELECT id, status, opened_at, expires_at FROM sessions ORDER BY opened_at DESC LIMIT 10;"
```

灾难恢复（**会丢所有 API key + 历史 session 记录**）：
```bash
flyctl ssh console -a mosaiq-cloud-runtime
rm /data/cloud-runtime.db
exit
flyctl machine restart -a mosaiq-cloud-runtime <machine-id>
# 启动时 bootstrap 自动重建表，再跑第 6 节建 prod key
```

### CDP ws 连不上

cloud-runtime ws 走 wss（fly proxy 强制 https）。SDK 用：
```ts
const session = await client.createSession({ ... });
// session.cdpUrl === 'wss://mosaiq-cloud-runtime.fly.dev/v1/sessions/ses_xxx'
const browser = await chromium.connectOverCDP(session.cdpUrl, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
```

注意 **`wss://` 不是 `ws://`**（prod TLS）。phase 11.1 dev smoke 用 `ws://localhost`，prod 必须 `wss`。`session.cdpUrl` 是控制平面根据 `PUBLIC_BASE_URL` 算出来的，fly.cloud-runtime.toml `[env]` 已经把它配成 `https://...fly.dev`，session.cdpUrl 自动 `wss://...fly.dev/...`。

---

## 10. Teardown

```bash
# 销毁所有 pod machine
flyctl machine list -a mosaiq-browser-pod --json | jq '.[].id' -r | \
  xargs -I {} flyctl machine destroy --force {} -a mosaiq-browser-pod

# 销毁两个 app（**会同时销毁 volume + 数据，不可恢复**）
flyctl apps destroy mosaiq-browser-pod
flyctl apps destroy mosaiq-cloud-runtime

# 撤 token
flyctl tokens revoke <token-id>
```

---

## 11. 此 runbook 当前状态

**Deploy-ready，未真实 dry-run。**

phase 11.2 在 dev 机器（无 Fly account）写完，所有制品就绪：
- `fly.browser-pod.toml`、`fly.cloud-runtime.toml` 配置完整
- `apps/cloud-runtime/src/admin/create-api-key.ts` 单测 5 个 case 全过
- `FlyMachineManager`（`apps/cloud-runtime/src/machine/fly.ts`）11 单测 + 1 并发 race regression 测试全过（mocked Fly Machines API）
- LocalDocker 拓扑同构验证过（GHA `cloud-runtime-e2e.yml` serial + concurrent smoke 全跑）
- Session expiry reaper（`apps/cloud-runtime/src/jobs/session-expiry.ts`）13 单测全过；防 client crash 后 pool 永久泄漏

第一次 fly deploy 时这份 runbook 应该 1:1 work。如果某一步打架，**优先怀疑 fly.toml 配置错误**（manager 代码已经经过 mocked + LocalDocker 双重验证），常见点：

- volume name 跟 fly.cloud-runtime.toml `[[mounts]] source` 不一致 → mount 失败
- `FLY_APP_NAME` secret 拼写错误 → manager 调 Machines API 404
- `mosaiq-browser-pod` app 还没 deploy 镜像 → 新 machine 拉镜像失败

Cross-region 部署、Postgres replication（取代 sqlite）、admin HTTP endpoint 取代 `flyctl ssh` admin script 等都是 phase 11.3+ 的事。
