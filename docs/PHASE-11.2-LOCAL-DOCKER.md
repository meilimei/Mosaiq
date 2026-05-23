# Phase 11.2 — LocalDocker 模式 Runbook

**目的**：在本机用 Docker 跑一个跟 prod (Fly per-session microVM) 拓扑同构的
Mosaiq Cloud stack，验证 `MACHINE_MANAGER=local-docker` 路径端到端可用。

**何时用**：

- 写 cloud-runtime / browser-pod 代码后想本地跑真实 chromium e2e
- 上 Fly 之前先在本机跑一遍 dry-run，避免在 Fly 上烧钱 debug
- CI 上跑真实 chromium 测试（无需 Fly account）

---

## 1. 拓扑

```
┌───────────────── docker network: mosaiq-net ─────────────────┐
│                                                              │
│  cloud-runtime container (mosaiq/cloud-runtime:0.11.0)       │
│   ├─ HTTP :8787  (publish 到 host 127.0.0.1:8787)            │
│   ├─ mounts /var/run/docker.sock                              │
│   └─ MACHINE_MANAGER=local-docker                             │
│        │                                                      │
│        │ Docker Engine API (over unix socket via undici)      │
│        ▼                                                      │
│  pod-<sess1> ┐                                                │
│  pod-<sess2> ├─ 动态创建 / 销毁，跟随 session 生命周期           │
│  ...         ┘  (mosaiq/browser-pod:0.11.0, --no-sandbox)     │
│                 podOrigin = http://<containerIp>:9222          │
│                 cdp      = ws://<containerIp>:9223/...        │
└───────────────────────────────────────────────────────────────┘
```

**跟 Fly 的对应**：

| LocalDocker             | Fly Machines                          |
| ----------------------- | ------------------------------------- |
| Docker Engine API       | Fly Machines REST API                 |
| docker network internal IP | Fly 6PN IPv6 internal address      |
| `mosaiq-pod-<id>` 容器  | Fly Machine (microVM)                 |
| `force-remove` 容器     | `DELETE /machines/:id?force=true`     |
| `mount /var/run/docker.sock` | `FLY_API_TOKEN`                  |

两者共享同一份 `pod-control.ts`（callPodStart / callPodStop / waitForPodReady /
rewriteCdpHost），所以 wire protocol 一致。

---

## 2. 前置条件

### 2.1 Docker

需要 Docker Engine + Compose v2。

- **Linux**：`docker` + `docker compose` plugin（apt: `docker.io`,
  `docker-compose-plugin`）。当前用户加入 `docker` group：
  ```bash
  sudo usermod -aG docker $USER && newgrp docker
  ```
- **macOS / Windows**：Docker Desktop（自带 docker compose）。Windows 推荐启用
  WSL2 integration，在 WSL distro 里跑命令。

验证：
```bash
docker --version          # >= 24
docker compose version    # >= v2
docker info               # 能连到 daemon
```

### 2.2 .env.cloud

复制 example 并改 `SEED_API_KEY`：
```bash
cp .env.cloud.example .env.cloud
# 编辑 .env.cloud，把 SEED_API_KEY 改成 32+ 字符随机串
```

`.env.cloud` 已在 `.gitignore`，不会泄露。

### 2.3 镜像 build（可选预热）

`docker compose up --build` 会在第一次启动时 build 镜像，全量含 chromium 下载约
**5–10 分钟**。如果想提前 build：
```bash
docker compose -f docker-compose.local-docker.yml build
```

后续 `up` 走缓存，几秒就起来。

---

## 3. 启动

```bash
docker compose -f docker-compose.local-docker.yml up --build -d
```

`-d` 跑后台。前台跑就去掉 `-d`，`Ctrl+C` 退出。

**预期日志（`docker compose logs cloud-runtime`）**：
```
[+0ms] cloud-runtime starting on 0.0.0.0:8787
[+50ms] machine manager: local-docker
[+50ms]   image=mosaiq/browser-pod:0.11.0 network=mosaiq-net cap=4
[+60ms] db ready (sqlite:/app/data/cloud-runtime.db)
[+80ms] HTTP listening :8787
```

**注意**：`browser-pod-image` service 只是个 build helper，build 完镜像就 exit 0。
看到它 `Exited (0)` 是正常的，不要去 restart 它。

---

## 4. 验证（端到端）

### 4.1 自动化（一行）

```bash
# 把 .env.cloud 里的 SEED_API_KEY 拿出来传给 smoke
export $(grep -v '^#' .env.cloud | xargs)
MOSAIQ_API_KEY="$SEED_API_KEY" \
MOSAIQ_PROJECT_ID="$SEED_PROJECT_ID" \
node scripts/dev-local-docker-smoke.mjs
```

PowerShell（WSL 外）：
```powershell
$env:MOSAIQ_API_KEY = (Select-String '^SEED_API_KEY=' .env.cloud).Line.Split('=',2)[1]
$env:MOSAIQ_PROJECT_ID = (Select-String '^SEED_PROJECT_ID=' .env.cloud).Line.Split('=',2)[1]
node scripts/dev-local-docker-smoke.mjs
```

`dev-local-docker-smoke.mjs` 依次：
1. 轮询 `/v1/health` 直到 ready（最多 60s）
2. 调 `register-persona.mjs` 把 `win11-chrome-us-default` persona 上传（幂等）
3. 调 `e2e-smoke.mjs` 跑完整链路：
   - createSession → cloud-runtime 拉 pod 容器 → chromium boot → CDP ws
   - playwright connectOverCDP → injectInto → newPage → evaluate
   - 验 navigator.userAgent / languages / hardwareConcurrency / timezone 等 12 项
   - close session → 验 pod 容器 force-removed

**预期结尾**：
```
🎉 e2e smoke PASSED in 18.2s
🎉 local-docker e2e smoke PASSED in 18.2s
```

### 4.2 手动 sanity

```bash
# health
curl -s http://127.0.0.1:8787/v1/health | jq
#   => { "ok": true, "pool": { "ready": 4, "busy": 0, "cap": 4 }, ... }

# 实时观察 docker
watch -n 1 'docker ps --filter label=com.mosaiq.runtime=cloud-runtime'
#   pod 容器在 createSession 时出现，session close 时消失
```

---

## 5. Teardown

```bash
docker compose -f docker-compose.local-docker.yml down
```

会停 cloud-runtime + 删 browser-pod-image builder。**手工清理 dangling pod 容器**
（一般 manager release 已经清完，但如果中途 crash 留了僵尸）：

```bash
docker ps -aq --filter label=com.mosaiq.runtime=cloud-runtime | \
  xargs -r docker rm -f
```

要彻底清掉 sqlite + 镜像：
```bash
docker compose -f docker-compose.local-docker.yml down -v --rmi local
```

---

## 6. Troubleshooting

### `permission denied` mount docker.sock

cloud-runtime 容器跑 root，Linux 上 docker.sock 一般 `root:docker 660`。两条路：

1. 让 docker daemon socket 给 root 读（host 上）：
   ```bash
   sudo chmod 660 /var/run/docker.sock  # 默认就是
   ```
2. 加 `group_add` 到 compose service（docker group 的 GID 因发行版而异）：
   ```yaml
   cloud-runtime:
     group_add:
       - $(stat -c '%g' /var/run/docker.sock)
   ```

macOS / WSL2 / Windows Docker Desktop 默认给容器 root 直接读，无需特殊处理。

### `docker container ... has no IP on network 'mosaiq-net'`

`DOCKER_NETWORK` 跟 compose `networks:` 段不一致。确认 `mosaiq-net` 这个名字
**完全一致**（compose 里给 fixed `name: mosaiq-net` 不带 prefix，env 里也是
`mosaiq-net`）。检查：
```bash
docker network ls | grep mosaiq
#   => mosaiq-net    bridge    local
```

### `pool.pod_unhealthy` 永远不就绪

pod 容器起来了但 `/healthz` 一直 5xx 或超时。看 pod 容器日志：
```bash
docker logs $(docker ps -lq --filter ancestor=mosaiq/browser-pod:0.11.0)
```

常见原因：
- chromium 在容器内 OOM（提高 `DOCKER_POD_SHM_BYTES`，默认 1GB 一般够）
- pod base image 还在拉（第一次冷启动；等 30s 再试）
- `--no-sandbox` 没生效（Dockerfile `USER pwuser` + chromium 的 `--no-sandbox` 是
  必要的，不然要 SYS_ADMIN cap）

### sqlite 状态污染

跨 phase 切 cloud-runtime 镜像版本时 sqlite migration 可能不兼容。删 volume
重来：
```bash
docker compose -f docker-compose.local-docker.yml down -v
docker compose -f docker-compose.local-docker.yml up -d
```

---

## 7. 与 phase 11.1 的关系

`docker-compose.cloud.yml`（11.1，`MACHINE_MANAGER=static`）保留作为「最小依赖」
的 dev path —— **不需要 docker.sock mount，不需要 user-defined network**，对
host 权限要求最低，适合：

- 给外部贡献者跑一次确认环境 OK
- LaunchAI 现场快速 demo

`docker-compose.local-docker.yml`（11.2）是「prod parity」的 dev path，**多了
docker.sock mount + 动态拉 pod**，适合：

- 验证 phase 11.2 改动（manager 重构、Fly 路径准备）
- CI 跑真实 chromium 集成测试

两套 compose 都跟 `cloud-sdk` / `register-persona.mjs` / `e2e-smoke.mjs` 兼容。

---

## 8. 下一步：上 Fly

LocalDocker 跑通后，上 Fly 风险很低（共享 `pod-control.ts`）。看
`docs/PHASE-11.2-FLY-DEPLOY.md`（待写）。
