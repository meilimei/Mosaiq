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
| `FLY_POD_APP_NAME` env on cloud-runtime | `DOCKER_IMAGE` env on cloud-runtime      |

两边走 **同一份** `apps/cloud-runtime/src/machine/pod-control.ts`（`callPodStart` / `callPodStop` / `waitForPodReady` / `rewriteCdpHost`），所以 wire 协议一致。LocalDocker e2e 跑通后，上 Fly 风险主要在 Fly-specific 配置（fly.toml / secrets / volume）而非业务代码。

---

## 2. 前置条件

### 2.1 flyctl 安装 + 登录

```bash
# Linux / macOS / WSL2
curl -L https://fly.io/install.sh | sh

# 跑 flyctl auth login，打开浏览器一次性 OAuth
flyctl auth login
flyctl auth whoami    # 期望: ifly@163.com
```

> **当前 Fly 账号**：`ifly@163.com`（personal org）。所有 deploy / secrets / token 操作前先确认 `flyctl auth whoami` 是这个账号；如果不是，跑 `flyctl auth logout && flyctl auth login` 切回。

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

> 命名约束：`mosaiq-browser-pod` 和 `mosaiq-cloud-runtime` 是 **fly.toml 里硬编码的 `app =` 值**。如果你必须改名，同步改两个 fly.toml + `FLY_POD_APP_NAME` secret 即可。

> ⚠️  **DO NOT 把 secret 叫成 `FLY_APP_NAME` / `FLY_REGION`**。这两个名是 Fly machine runtime
> 保留名，会被自动注入为当前 app/region，覆盖 secrets。所以控制平面读的是 `FLY_POD_APP_NAME` /
> `FLY_POD_REGION`。踩过坑的征兆：FlyMachineManager 走 POST /apps/mosaiq-cloud-runtime/machines
> → Fly Machines API 返 403 unauthorized。

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
# METRICS_TOKEN 随机生成一份，存好（Prometheus scraper 要用）
METRICS_TOKEN=$(openssl rand -hex 32)
echo "METRICS_TOKEN=$METRICS_TOKEN"   # 记下来，丢了只能重新生成 + 改 scraper

flyctl secrets set \
  FLY_API_TOKEN=$(cat ~/.fly-machines-token) \
  FLY_POD_APP_NAME=mosaiq-browser-pod \
  METRICS_TOKEN=$METRICS_TOKEN \
  --app mosaiq-cloud-runtime
```

**secret 清单**（`flyctl secrets list -a mosaiq-cloud-runtime` 应该看到这三个）：

| Secret           | 必填 | 说明                                                        |
| ---------------- | ---- | ----------------------------------------------------------- |
| `FLY_API_TOKEN`     | ✅   | org-level deploy token，能调 Machines API on browser-pod app |
| `FLY_POD_APP_NAME`  | ✅   | 一般是 `mosaiq-browser-pod`。**不能**叫 `FLY_APP_NAME`（Fly 保留名）|
| `METRICS_TOKEN`  | ✅   | Prometheus scraper 用的 bearer；留空 → /v1/metrics 返 404    |
| `SEED_API_KEY`   | ❌   | prod **不能**设；env.ts 在 NODE_ENV=production 时拒          |

> Fly 会 restart 还没跑的 machine — 但因为我们还没 deploy，这里 secrets 只是预先写进 staging slot，第一次 deploy 自动注入。

**调整 rate limit / 其他非 secret 配置**：这些在 `fly.cloud-runtime.toml` 的 `[env]` 里（`RATE_LIMIT_*`、`SESSION_*` 等），改完 `flyctl deploy` 即可，不走 `flyctl secrets set`。

### 5.3 本地 preflight（推荐）

`flyctl deploy` 前在本地把 Docker image 走一遍，避免远端 build 失败浪费 10 分钟：

```powershell
pwsh scripts/preflight-fly.ps1
```

脚本会 docker build cloud-runtime → run 一个本地容器 → 打 `/v1/health` / `/v1/metrics` / `POST /v1/sessions` 验证 auth + rate-limit 配置都对，最后打印 deploy checklist。全绿才继续 5.4。

### 5.4 部署

```bash
flyctl deploy --config fly.cloud-runtime.toml \
              --dockerfile apps/cloud-runtime/Dockerfile
```

预期：build (~3-5 min cold) → push → 创建 1 个 machine → mount volume → 启动 → healthcheck 通过 → 出 anycast IP。

### 5.5 Smoke

```bash
# 1. 健康检查（包含 DB liveness）
curl -s https://mosaiq-cloud-runtime.fly.dev/v1/health | jq
```

期望：
```json
{
  "ok": true,
  "db": { "ok": true },
  "pool": { "ready": 10, "busy": 0, "cap": 10 },
  "manager": "fly",
  "version": "0.11.0",
  ...
}
```

`manager: "fly"` 确认走的是 prod 路径；`db.ok: true` 确认 sqlite 也 alive。

```bash
# 2. metrics endpoint
curl -s -H "Authorization: Bearer $METRICS_TOKEN" \
     https://mosaiq-cloud-runtime.fly.dev/v1/metrics | head -50
```

期望前几行包含：
```
# HELP cloud_runtime_process_cpu_user_seconds_total ...
# TYPE sessions_created_total counter
sessions_created_total 0
# TYPE auth_failures_total counter
# TYPE rate_limit_denied_total counter
# TYPE pool_state gauge
pool_state{state="ready"} 10
pool_state{state="busy"} 0
pool_state{state="cap"} 10
```

没 token → 401，token 错 → 401，没设 `METRICS_TOKEN` env → 404（默认 disabled，prod 必须设）。

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

> **零泄漏推荐**：常规 bootstrap / rotate **务必** 走 `--quiet` 模式，让 admin 脚本完全不回显 plaintext（caller 必须经 `MOSAIQ_NEW_API_KEY` 预供给）。配套工具：`dist/admin/list-api-keys.js`（仅 metadata，绝不含 plaintext / hash）和 `dist/admin/revoke-api-key.js`（按 `apk_*` id 吊销）。完整零泄漏剧本见 §8 → "Rotate API key（业务级，零泄漏流程）"。

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

### Rate limit observability + 调整

- **观测**：`rate_limit_denied_total{tier="strict|write|read"}` counter（在 `/v1/metrics`）。tier=strict 持续涨 ≈ 客户 SDK 在打 createSession；read 涨多半是 SDK getSession poll 太密。
- **响应头**：每个成功请求带 `X-RateLimit-Limit` + `X-RateLimit-Remaining`，被拒的请求带 `Retry-After`（秒）。SDK 可以用这个做 backoff。
- **调整 limit**：改 `fly.cloud-runtime.toml` 里 `RATE_LIMIT_STRICT_CAPACITY` / `RATE_LIMIT_STRICT_REFILL_PER_SEC`（write/read 同理）+ `flyctl deploy`。默认值已经在 toml 里：
  - strict: capacity=10, refill=1/s  → 60/min 稳态
  - write : capacity=30, refill=5/s  → 300/min
  - read  : capacity=100, refill=16/s → 1000/min
- **per-process scope**：限流是 in-memory，每个 cloud-runtime instance 各自一份。phase 11.4 上多实例时换 Redis / sqlite shared store。
- **bucket key**：`tier:api_key_id`，不同 key 互不影响（防 dev SDK 拖死 prod）。

### Metrics scraping (Prometheus / Grafana Cloud)

```yaml
# prometheus.yml（或 Grafana Cloud Hosted Prometheus 的 config）
scrape_configs:
  - job_name: mosaiq-cloud-runtime
    scrape_interval: 30s
    metrics_path: /v1/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/mosaiq-metrics-token   # 内容 = METRICS_TOKEN
    static_configs:
      - targets: ['mosaiq-cloud-runtime.fly.dev']
```

**关注的几个指标**：

| 指标                                       | 类型      | 应当观察的趋势                                    |
| ------------------------------------------ | --------- | ------------------------------------------------- |
| `sessions_created_total`                   | counter   | rate() 应当 ≈ 业务 createSession 速率              |
| `sessions_closed_total{reason="expired"}`  | counter   | 持续 > 0 说明 SDK 没 close session，有泄漏        |
| `auth_failures_total{reason}`              | counter   | 突涨 = 有人在扫 token / SDK 配置错                |
| `rate_limit_denied_total{tier}`            | counter   | 见上节                                            |
| `pool_state{state="busy"}/state="cap"`     | gauge     | 接近 1 → 该扩 `FLY_MAX_MACHINES` / 升 Fly plan    |
| `http_request_duration_seconds`            | histogram | p95 应该 < 500ms（createSession 除外，cold ~5-15s） |
| `mm_acquire_duration_seconds`              | histogram | p95 > 30s 说明 Fly Machines API / chromium 启动慢 |

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

### Rotate API key（业务级，零泄漏流程）

旧的 stop-gap（直接 SQL UPDATE）已被 phase 11.3 的 admin 工具替换。完整工具链：

| 工具 | 作用 | 是否输出 plaintext |
| --- | --- | --- |
| `dist/admin/create-api-key.js`（默认）| 建 key + echo plaintext | ✅ stdout 一次 |
| `dist/admin/create-api-key.js --quiet` | 建 key，**不**回显 plaintext（要求 caller 预生成）| ❌ |
| `dist/admin/list-api-keys.js` | 列出 project 的所有 key（仅 metadata，绝不含 plaintext / hash）| ❌ 永远不会 |
| `dist/admin/revoke-api-key.js` | 按 `apk_*` id 吊销，写 `revoked_at = ISO`（中间件 `auth.ts:57` 立刻拒绝）| n/a |

#### 推荐流程（已在 2026-05-25 真机演练验证 — dryrun key 跑通五个断言）

**两个 gotcha 必看**：
- `flyctl ssh -C "VAR=val cmd"` **不行** — flyctl 直接 `exec()` 命令而不经过 shell，`MOSAIQ_NEW_API_KEY=...` 会被当成可执行文件名。**必须**用 `sh -c '...'` 包一层。
- Plaintext **会**短暂出现在你本机 `flyctl` 进程的 argv（PowerShell 把 `$plaintext` 展开后再传给 flyctl）。这在你**自己的受信本机**上是可接受的（不进 chat、不进 git、不跨网络明文）；如果你不放心，用下面的 §"严格模式"通过 stdin 注入。

```powershell
# 1) 本地受信终端预生成 plaintext。用 CSPRNG，不用 Get-Random（不是 CSPRNG）。
#    ↓ 不要在共享屏 / chat 里跑这条
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 22
$rng.GetBytes($bytes)
$alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'  # 去掉 0/O/1/l/I 易混淆字符
$body = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
$plaintext = "msq_sk_live_$body"
# 立刻存进 1Password / Bitwarden，再继续下一步

# 2) 注入容器（用 sh -c 包一层；plaintext 会短暂在你本机 argv 内）
flyctl ssh console -a mosaiq-cloud-runtime `
  -C "sh -c 'MOSAIQ_NEW_API_KEY=$plaintext MOSAIQ_QUIET=1 node /app/dist/admin/create-api-key.js proj_launchai'"
# 输出（实测）：
# {
#   "status": "created",
#   "projectId": "proj_launchai",
#   "apiKeyId": "apk_xxxxxxxxxxxxxxxxxxxxxx",
#   "prefix": "msq_sk_live_<first 20 chars>",
#   "note": "--quiet: plaintext omitted from stdout (caller-supplied; not echoed)"
# }
# 关键：JSON 里**没有** plaintext 字段，也没有 warning 字段（区别于默认模式）。

# 3) 验证新 key 能用（auth-only check，不创建 session，零成本）
$resp = Invoke-WebRequest `
  -Uri 'https://mosaiq-cloud-runtime.fly.dev/v1/sessions?project_id=proj_launchai' `
  -Headers @{ Authorization = "Bearer $plaintext" } -UseBasicParsing
$resp.StatusCode  # 期望 200
# (如果要跑完整 e2e 含 session create，用 scripts/prod-smoke-cloud.mjs，但会真起一台 Fly machine)

# 4) 客户端 / LaunchAI 把 MOSAIQ_API_KEY 切到新 plaintext，确认线上业务正常后，列旧 key
flyctl ssh console -a mosaiq-cloud-runtime `
  -C 'node /app/dist/admin/list-api-keys.js proj_launchai'

# 5) 吊销旧 key（每个泄漏的 id 都跑一次）
flyctl ssh console -a mosaiq-cloud-runtime `
  -C 'node /app/dist/admin/revoke-api-key.js apk_OLD_xxxxxxxxxxxxxxxxxxxxxx'
# { status: 'revoked', apiKeyId, prefix, revokedAt: 'ISO ...' }

# 6) 验证旧 key 立刻 401（auth 中间件 src/middleware/auth.ts:57 读 revokedAt）
try {
  Invoke-WebRequest -Uri 'https://mosaiq-cloud-runtime.fly.dev/v1/sessions?project_id=proj_launchai' `
    -Headers @{ Authorization = 'Bearer msq_sk_live_OLD_LEAKED_KEY' } -UseBasicParsing
} catch {
  $_.Exception.Response.StatusCode.value__  # 期望 401
  $_.ErrorDetails.Message  # 期望 {"error":{"code":"auth.invalid_key","message":"API key revoked","detail":{"revokedAt":"..."}}}
}

# 7) 抹掉本地 plaintext 变量
Remove-Variable plaintext
```

#### 严格模式（plaintext 绝对不进 argv — 适合极端审计需求）

走 interactive ssh + `read -rs`（echo suppressed，stdin only）：

```powershell
# 生成 plaintext（同上 §1），然后：
flyctl ssh console -a mosaiq-cloud-runtime
# 进入容器 bash 后，手动输入：
#   read -rs MOSAIQ_NEW_API_KEY   <-- 粘贴 plaintext，回车，无回显
#   export MOSAIQ_NEW_API_KEY
#   MOSAIQ_QUIET=1 node /app/dist/admin/create-api-key.js proj_launchai
#   unset MOSAIQ_NEW_API_KEY
#   history -c  # 清掉这个 session 的 bash history（虽然 read -rs 本来就不进 history）
#   exit
```

代价：6 步纯手动，typo 风险高。常规 rotate 用上面的"推荐流程"即可，sh -c 路径已在 prod 跑通且 plaintext 暴露面只在你本机。

#### 紧急吊销（已经泄漏，先封后补）

如果你发现 plaintext 已经进 chat / log / git，**先吊销，再换**：

```powershell
# 1) 拿 id（按 prefix 对照——prefix 是日志可见前缀，本身不敏感）
flyctl ssh console -a mosaiq-cloud-runtime -C 'node /app/dist/admin/list-api-keys.js proj_launchai'

# 2) 立刻 revoke（每个泄漏 id 跑一次；幂等，再 revoke 一遍返 already_revoked + 不改时间戳）
flyctl ssh console -a mosaiq-cloud-runtime -C 'node /app/dist/admin/revoke-api-key.js apk_LEAKED_xxxxxxxxxxxxx'

# 3) 走上面"推荐流程"建替换 key
```

吊销是逻辑删除（保留 row + key_hash），所以可审计。**真物理 delete** 仅在 §9 灾难恢复 `rm /data/cloud-runtime.db` 才会发生。

---

## 9. Troubleshooting

### `flyctl deploy --local-only` 卡在 `dialing registry-1.docker.io:443`

China 网络下 `docker.io` 经常无法直连，本地 Docker Desktop 拉不到 `node:20.18-bookworm-slim` base 镜像，build 在 stage `#2 [internal] load metadata for ...` 直接失败：

```
ERROR: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/20.18-bookworm-slim":
  dialing registry-1.docker.io:443 ... A connection attempt failed because the connected party
  did not properly respond after a period of time
```

**临时方案**：直接用 Fly remote builder（Fly 自家 depot 服务器在 us-east，拉 docker.io 没问题）：

```powershell
flyctl deploy --remote-only `
  --config fly.cloud-runtime.toml `
  --dockerfile apps/cloud-runtime/Dockerfile `
  --app mosaiq-cloud-runtime
```

**长期方案**：给 Docker Desktop 配 registry mirror（settings → docker engine → `registry-mirrors: ["https://docker.mirrors.ustc.edu.cn"]`），或者拉一个企业 proxy。`.dockerignore`（commit `df5447d`）已经把 host node_modules / dist / .git 全部排除，上传基本只剩源码 + lockfile + patches，国内上传到 fly depot 也是可接受速度。

### PowerShell 把 `flyctl` 成功也报成 "exit 1"

`flyctl deploy` / `flyctl ssh console -C` 完成后 PowerShell 经常输出：

```
flyctl :
所在位置 行:1 字符: 1
    + CategoryInfo : NotSpecified: (...:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
```

并把 exit code 报成 1，**即使命令本身成功**。这是 PS 5.1 把 native command 写到 stderr 的任何行（包括 flyctl 的 banner + spinner）当成 `RemoteException` 包装的行为，跟 `$ErrorActionPreference = 'Stop'` 互相加成。

**判断方法**：看实际 stdout 末尾的成功标志，**不**信 `$LASTEXITCODE`：
- `flyctl deploy` 真正完成时 stdout 最后会有 `Visit your newly deployed app at https://...`
- `flyctl ssh -C` 完成时 stdout 倒数第二行是命令输出，最后一行的 `Error: The handle is invalid.` 是 fly 退出时恢复 Windows console handle 的副作用，不是真错误
- 终极证据：单独跑 `flyctl status -a <app>` 看 machine state + checks，看到 `started` + `1/1 passing` 就是真成功

**永久缓解**：在 deploy 脚本里把 `flyctl` 输出 `2>&1` 合并到 stdout，再用关键字判定，**不**靠 exit code。

### `flyctl ssh console -C` 输出乱码刷屏 `Connecting to ... 猓?`

PS 5.1 在中文 Windows codepage 下把 fly 的 UTF-8 spinner 字符（`⡿ ⣟ ⣯ ⣷ ⣾ ⣽ ⣻ ⢿`）解码成乱码。只是显示问题，不影响命令执行 — 等到出现 `Connecting to fdaa:... complete` 那行之后才是真正的命令 stdout。

### Image build 慢（better-sqlite3 编译两遍）

观察到 build stage + deploy stage 各编译一次 better-sqlite3，每次 ~70s。`node:20.18-bookworm-slim` 是 debian glibc，better-sqlite3 12.x 应该有 prebuilt 但 npm registry 没返回。**不影响功能**，build 总时长仍在 3-4 min 内，pnpm-store cache 在第二次 build 时会复用。如果想优化：

- 切到 `node:20-alpine` 并接受 musl 重编代价（不推荐 — alpine 上 better-sqlite3 prebuilt 更稀有）
- 切到 base image 含预装 better-sqlite3 的 fork（维护成本高）
- 给 pnpm install 加 `--prefer-offline` + cache hit 后跳过 install gypi（已经在做）

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

**Deploy-ready，已通过 prod first-deploy（账号 `ifly@163.com` 2026-05-24 跑通端到端）。**
首次冷启 session_create ~40s（image pull 5s + microVM boot 3s + chromium boot 18s + 控制
roundtrip 5s + 余量），稳定 reproducible。详见 §12「2026-05-24 首次部署踩坑」。

phase 11.2 在 dev 机器写完，所有制品就绪：
- `fly.browser-pod.toml`、`fly.cloud-runtime.toml` 配置完整（含 rate-limit + metrics env knobs）
- `apps/cloud-runtime/src/admin/create-api-key.ts` 单测 5 个 case 全过
- `FlyMachineManager`（`apps/cloud-runtime/src/machine/fly.ts`）11 单测 + 1 并发 race regression 测试全过（mocked Fly Machines API）
- LocalDocker 拓扑同构验证过（GHA `cloud-runtime-e2e.yml` serial + concurrent smoke 全跑）
- Session expiry reaper（`apps/cloud-runtime/src/jobs/session-expiry.ts`）13 单测全过；防 client crash 后 pool 永久泄漏
- **prod hardening（本 phase 新加）**：
  - `/v1/health` 加 `SELECT 1` DB liveness（fail → 503）
  - CDP proxy ws lifecycle 周期 bump `last_seen_at`（连接时 + 60s 心跳 + close 时各一次）
  - per-api-key rate limit（token bucket, 3 tier strict/write/read），429 + `Retry-After`
  - `/v1/metrics` prom-client exposition，独立 `METRICS_TOKEN` bearer auth
  - 全套 sessions_/auth_/rate_limit_/pool_/http_duration counters/gauges/histograms 已接入业务路径
- `scripts/preflight-fly.ps1`：deploy 前本地 docker build + smoke 一键脚本

第一次 fly deploy 时这份 runbook 应该 1:1 work。如果某一步打架，**优先怀疑 fly.toml 配置错误**（manager 代码已经经过 mocked + LocalDocker 双重验证），常见点：

- volume name 跟 fly.cloud-runtime.toml `[[mounts]] source` 不一致 → mount 失败
- `FLY_POD_APP_NAME` secret 拼写错误 → manager 调 Machines API 404。2026-05-24 踩过坑：
  如果你看到的是 `403 unauthorized` 而不是 404，九成是 secret 误设为 `FLY_APP_NAME`（Fly
  保留名），运行时被自动注入覆盖为控制平面自己的 app名——表现为拿控制平面的
  token 去写控制平面自己的 machines。
- `mosaiq-browser-pod` app 还没 deploy 镜像 → 新 machine 拉镜像失败
- `METRICS_TOKEN` secret 漏设 → `/v1/metrics` 返 404，Prometheus scraper 收不到数据（业务功能不影响）

Cross-region 部署、Postgres replication（取代 sqlite）、admin HTTP endpoint 取代 `flyctl ssh` admin script、Redis-shared rate limit（多实例时必要）都是 phase 11.3+ 的事。

---

## 12. 2026-05-24 首次部署踩坑

第一次真跑 deploy 之后，有几个在 dev / mocked / LocalDocker 下没暴露过的 prod-only 坑。
这一节按现场遇到的顺序记录，复盘 + 给后人作弊条。**runbook 上面的代码已经包含全部修复**，
读这一节是为了理解 *为什么* 默认值长那样，以及 future 撞类似问题时怎么 debug。

### 12.1 Fly 6PN 是 IPv6-only —— pod 必须 bind `::` 而不是 `0.0.0.0`

**症状**：cloud-runtime 调 pod `/healthz` 失败，错误码 `pool.pod_unhealthy / fetch failed`。
pod 自己看着没事（hono listening、relay listening 都打了 log），但 cloud-runtime 那边
`fetch('http://[fdaa:77:...]:9222/healthz')` 在 connect 阶段就 ECONNREFUSED。

**根因**：Fly 机器之间走的是 6PN —— 一个 IPv6-only 的私有 anycast 网络（地址是
`fdaa:xx:xxxx::/48`）。cloud-runtime 拿到的 pod machine `private_ip` 永远是 IPv6。
pod 的 hono `serve({ hostname: '0.0.0.0' })` = IPv4 wildcard only，Linux 上 IPv6 的
incoming 直接 connection refused。

**修复**：`apps/browser-pod/src/env.ts` 把 `POD_CONTROL_HOST` 和 `POD_CDP_HOST` 默认值
从 `'0.0.0.0'` 改成 `'::'`（IPv6 wildcard）。Linux 上 `::` 默认 dual-stack（同时收
IPv6 原生 + IPv4-mapped IPv6），所以 LocalDocker 经 docker bridge 的 IPv4 也照样
连得上，零向后兼容代价。Windows 本地调试如果需要 IPv4-only 行为，显设
`POD_CONTROL_HOST=0.0.0.0` 覆盖即可。

**回归保护**：`apps/browser-pod/src/env.test.ts` pin 默认值 = `'::'`。

### 12.2 Chromium 在没 dbus 的容器里启动慢 18 秒

**症状**：pod 的 `/control/start` 返 500，body 含 `chromium /json/version did not become
ready within 30000ms`。chromium 进程是真的起来了（stderr 末尾能看到
`DevTools listening on ws://127.0.0.1:9224/devtools/browser/<uuid>`），但启动到能
serve `/json/version` 的 HTTP 探活，要差不多 18 秒。

**根因**：`mcr.microsoft.com/playwright` base 镜像不带 dbus daemon。chromium 启动期
会陆续访问 system bus（`/run/dbus/system_bus_socket`）做电源 / 网络 / Cast 设备 / 密码
管理 / MediaRouter 等子系统的 service discovery。每次调用底层 libdbus 在没 daemon
情况下会等一个 transport-level timeout（1-5s），累积下来 ~15s 静默期。pod 看到的
现象是 chromium "卡了"，stderr 时不时蹦个 dbus 错。

**修复**（双管齐下）：
- `apps/browser-pod/src/persona-flags.ts` 增加一组「无 dbus / 无桌面」chromium flags：
  `--no-first-run`, `--no-default-browser-check`, `--disable-background-networking`,
  `--disable-sync`, `--disable-default-apps`, `--password-store=basic`,
  `--use-mock-keychain`，并把 `MediaRouter` 加到 `--disable-features` 里
  （MediaRouter 走 dbus 探 Cast/DIAL 设备，不关掉就一直 retry）。
- `apps/browser-pod/src/chromium.ts` 给 chromium child process 注入 env：
  `DBUS_SYSTEM_BUS_ADDRESS=disabled:` + `DBUS_SESSION_BUS_ADDRESS=disabled:`，
  让 libdbus 直接 fail-fast on parse 而不是 timeout。

**回归保护**：`apps/browser-pod/src/persona-flags.test.ts` 新增 `emits no-dbus /
no-desktop container flags` 测试 pin 关键 flags，避免 future refactor 误删。

**为什么不直接装 dbus**：装 dbus + 起 daemon 的复杂度（user namespaces / cgroup
permissions / 在 single-process 容器里怎么 supervise）远大于关掉 chromium 这边的
dbus 调用，且我们根本不需要任何 dbus 暴露的功能（Cast 设备、桌面通知等）。

### 12.3 Chromium 真正起来还是要 ~18 秒，得 bump 各级超时

**症状**：12.2 mitigation 上完后，dbus 错误从「持续 retry」变成「fail-fast 一次」，
但 chromium 启动到 `/json/version` ready 仍然 ~18s（剩下的延迟猜测是
NetworkService DNS resolver init + 字体配置首次扫描，stderr 里看不到具体动作）。
这超过 phase 11.2 设的 30s 内部超时，pod 会在 chromium 即将就绪的瞬间 SIGKILL 掉。

**修复**：把超时一组上调，给 microVM 冷启的本征延迟留余量：
- `POD_CHROMIUM_BOOT_TIMEOUT_MS`: 30s → 60s（`apps/browser-pod/src/env.ts`）
- `FlyMachineManager.waitForStartedTimeoutMs`: 30s → 90s
  （Fly 镜像 pull + firecracker boot；918MB 镜像冷拉实测 30-60s）
- `FlyMachineManager.waitForPodReadyTimeoutMs`: 15s → 30s
- `FlyMachineManager.podStartTimeoutMs`: 35s → 75s
  （**关键约束**：必须 > pod 内部的 60s POD_CHROMIUM_BOOT_TIMEOUT_MS，让 pod 端先
  fire timeout 把 chromium stderr 拼进 500 response body，cloud-runtime 才能拿到
  可诊断的错误而不是 fetch abort。）

全在 `apps/cloud-runtime/src/machine/fly.ts` 的 FlyMachineManager 默认值。

### 12.4 看不到 chromium stderr 是因为 prod LOG_LEVEL=info 把它吃了

**症状**：12.2 / 12.3 调查过程中，pod 端 `chromium.ts` 用 `log.debug({chromiumStderr})`
打 chromium 错误。LocalDocker 默认 LOG_LEVEL=debug 时一切正常。Prod 用 LOG_LEVEL=info，
debug 级日志全丢，**看到的只有 "did not become ready within 30000ms" 而没有 chromium
自己说什么**，根因定位不下去。

**修复**：`apps/browser-pod/src/chromium.ts` 重写 spawn 失败处理：
- 给 child process 挂 `TailBuffer`（ring buffer，留最后 16KB stderr/stdout）
- spawn 失败时把 buffer 内容
  - 走 `log.error(...)` 打到 prod 日志
  - 拼到抛出的 `Error.message` 后缀
  - 经过 `pod-control` → `/v1/sessions` 响应 `detail.body`
  - 直接出现在 cloud-runtime 客户端看到的 500 body 里，无需 `flyctl ssh` 进 pod
即使再次撞类似问题，stderr 已经在 client 手上了，立等可取。

### 12.5 Fly 保留名 secret 静默被覆盖

（这个 §11 已经有提到，再点一次：）`FLY_APP_NAME` / `FLY_REGION` 是 Fly machine
runtime 保留 env，**会被 fly-init 自动注入为当前 machine 所属 app/region 名，覆盖
任何用户设的同名 secret**。所以 cloud-runtime 必须用 `FLY_POD_APP_NAME`、
`FLY_POD_REGION` 这种带 `_POD_` 前缀的命名。如果不小心写成 `FLY_APP_NAME`，
表现是控制平面拿自己的 token 去写自己 app 下的 machines —— Fly Machines API 返
**403** （而不是 404，迷惑性比较强）。

### 12.6 Performance baseline (post-fix)

冷启 session_create 端到端 ~40 秒，breakdown：
- ~5s machine create + image pull（warm registry CDN 时）
- ~3s firecracker boot + node entrypoint
- ~18s chromium spawn → /json/version ready
- ~5s healthcheck + control roundtrip
- ~10s 余量 + sequential 网络往返

**Phase 11.3+ 目标**：维护一个 pre-warmed stopped-machine pool，session_create 走
`fly machine start <stopped-id>` 而不是 `POST /machines`，预期 < 2s（省掉 image
pull 和 chromium 冷启 —— machine resume 时 chromium 还在内存里）。
