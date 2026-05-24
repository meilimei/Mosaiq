# Phase 11.3 — 预热 machine pool

**目的**：把 Mosaiq Cloud `session_create` 的 cold spawn 时间从 ~40s 压到 ~22s（phase 11.3a stopped-machine pool），后续 ~18s（phase 11.3b running-machine pool）。

**前置阅读**：

- [`docs/PHASE-11.2-FLY-DEPLOY.md`](./PHASE-11.2-FLY-DEPLOY.md) §12.6 — cold spawn 时间分解。
- [`apps/cloud-runtime/src/machine/fly.ts`](../apps/cloud-runtime/src/machine/fly.ts) — `FlyMachineManager` 当前实现。
- [`apps/cloud-runtime/src/machine/types.ts`](../apps/cloud-runtime/src/machine/types.ts) — `MachineManager` 接口契约。
- [`apps/cloud-runtime/src/machine/pod-control.ts`](../apps/cloud-runtime/src/machine/pod-control.ts) — 共享的 pod 协议（persona 注入在这里）。

---

## 1. 问题陈述

Phase 11.2 prod smoke 实测 cold spawn 端到端 ~40s。分解（来自 PHASE-11.2 §12.6）：

```
   POST /v1/sessions                                    t=0
        │
        ├─ Fly POST /machines (create)                  ~1s     ┐
        │                                                       │
        ├─ Fly 拉镜像（918MB browser-pod:latest）         5-30s  │  「machine layer」
        │                                                       │  (Phase 11.3a 攻击点)
        ├─ Fly firecracker microVM 启动 + init           ~3s    │
        │                                                       │
        ├─ pod hono /healthz 就绪                        ~2s    ┘
        │
        ├─ POST {pod}/control/start                            ┐
        │   └─ chromium spawn + DevTools 就绪              ~18s│  「chromium layer」
        │      (NetworkService + dbus + 字体扫描)              │  (Phase 11.3c+ 攻击点)
        │                                                       ┘
        ├─ DB insert session row                         ~50ms
        │
        └─ 201 created                                   t≈40s
```

**关键观察**：~22s 花在 machine layer（create + image pull + microVM boot + pod hono boot），~18s 花在 chromium layer。Machine layer 可以**预先做好**——这就是 Phase 11.3a 的全部杠杆。

**关键约束**：persona 在 `POST {pod}/control/start` 时通过 HTTP body 注入到 pod，而不是 build-time bake 到镜像。所以「pre-warm machine」和「pre-spawn chromium」是两个独立问题——可以单独 pre-warm machine 而 chromium 留到 acquire 时再起，persona 隔离不受影响。

---

## 2. 四种方案 + 选型

| | 机制 | 预热深度 | 闲置成本 | warm spawn | 复杂度 | 阶段 |
|---|---|---|---|---|---|---|
| **A. Stopped pool** | 提前 `create` Fly machine 但不 start，保持 stopped 状态 | machine 镜像层 | ~$0.15/GB·月 (storage only) | ~22s | 低 | **11.3a** ✓ |
| **B. Running pool** | 提前 `start`，pod hono 已起，chromium 未 spawn | machine + pod hono | ~$1.9/day per shared-cpu-1x | ~18s | 中 | 11.3b |
| **C. Chromium pre-spawn (generic persona)** | chromium 已起好默认 persona，acquire 时通过 CDP 切换 | machine + pod + chromium | 同 B + 内存压力 | <2s | 高 + persona 串扰风险 | 11.3c（不一定做） |
| **D. 共享 chromium 多 BrowserContext** | 1 chromium 实例，多 session 复用 | 极致 | 极低 | <1s | 极高，canvas/WebGL 噪声是进程级，无法 per-context 切 | Phase 12+ R&D |

### 选 A 的理由

1. **杠杆最大**：phase 11.3a 一刀切下 ~18s（45% 减少），是 phase 11.3 单 commit batch 能拿到的最大收益。
2. **成本几乎为零**：Fly 对 stopped machine **只收 rootfs 存储费**（~$0.15/GB·月）。5 台 stopped × 1GB rootfs ≈ $0.75/月，可忽略。运行中 machine 单价 ~$1.9/day = $57/月——B 方案 5 台就是 $285/月，量级差 400 倍。
3. **改动面最小**：复用 `FlyMachineManager` 的 `createMachine` + 加一个 `stopMachine` + `startMachine` 即可，pod 端零改动。Phase 11.3a 是纯 cloud-runtime 内部重构。
4. **safety story 干净**：每个 pool entry **single-use**——consume 后 destroy，replenish 用新 machine。chromium 永远从全新 microVM 起，无 cookies / DOM storage / history / fingerprint state 跨 session 泄漏。
5. **失败可回退**：pool 空时回退到 cold path（当前行为）。`POOL_TARGET_SIZE=0` 默认 = 完全禁用 = 跟 phase 11.2 字节对等。

### 不选 B/C/D 的理由（暂）

- **B**：闲置 compute 账单太高，且只换 ~5s。等 phase 11.3a 上线见到 latency 仍是痛点再上。
- **C**：persona 串扰风险——chromium 进程级 fingerprint 注入（canvas noise / WebGL fingerprint / 字体列表 / WebRTC IP）几乎不可能在不重启进程的情况下切换。需要重写整套 stealth 注入逻辑，超出 Phase 11.3 scope。
- **D**：跟 C 同理但更激进。需要 chromium 源码级修改或专门的 anti-detect chromium fork。Phase 12+ R&D。

---

## 3. Phase 11.3a 架构

### 3.1 类组合

```
                ┌────────────────────────────┐
                │  cloud-runtime business    │
                │  (routes/sessions.ts)      │
                └──────────────┬─────────────┘
                               │ getMachineManager()
                               ▼
                ┌────────────────────────────┐
                │  MachineManager interface  │  (types.ts, 不变)
                └──────────────┬─────────────┘
                               │
              ┌────────────────┼──────────────┐
              │                │              │
              ▼                ▼              ▼
         Static          LocalDocker       Fly (+ pool wrapper)
                                                │
                  ┌─────────────────────────────┴─────────┐
                  │                                       │
                  ▼                                       ▼
       POOL_TARGET_SIZE = 0:                  POOL_TARGET_SIZE > 0:
       FlyMachineManager（当前实现）          FlyPooledMachineManager
       直接 cold path                         │
                                              ├─ #pool: PoolEntry[]
                                              ├─ #replenishLoop: setInterval
                                              ├─ delegate: FlyMachineManager (cold path fallback)
                                              └─ Fly Machines API 直调（共享 fly.ts primitives）
```

**关键设计选择**：用 **composition** 而不是 inheritance。`FlyPooledMachineManager` 持有一个 `FlyMachineManager` 实例作为 fallback delegate（用于池空时的 cold path），但**池子自己的 provision / start / destroy** 直接调 Fly Machines API（复用 `fly.ts` 里 extract 出来的 primitives）。这样：

- Pool 可独立单测（mock fetch）
- `FlyMachineManager` 保持 pool-unaware，回归测试不动
- 万一 pool 实现有 bug，env `POOL_TARGET_SIZE=0` 立即降级到 phase 11.2 行为

### 3.2 PoolEntry 状态机

```
   ┌──────────────────────────────────────────────────────┐
   │                                                      │
   │                                                      │  destroy
   │   (replenish loop)                                   ▼  (after session)
   │       ▼                                       ┌─────────────┐
   │   ┌────────┐  Fly POST /machines        ┌──> │  consumed   │
   │   │ empty  │  (skip_launch:true)        │    │ (out of pool)│
   │   └────┬───┘  →  state=stopped          │    └─────────────┘
   │        │                                │
   │        ▼                                │ start success
   │   ┌────────────┐  POST .../stop  ┌──────┴────────────┐
   │   │ creating   │ (if Fly auto-   │ Fly POST /start   │
   │   │            │  started it)    │ + waitForStarted  │
   │   └────┬───────┘                 │ + waitForPodReady │
   │        │                         │ + callPodStart    │
   │        ▼                         └─────────▲─────────┘
   │   ┌────────────┐                           │
   │   │  stopped   │── consume (acquire) ──────┘
   │   │  (in pool) │
   │   └────┬───────┘
   │        │ max-age TTL hit / health-check fail
   │        ▼
   │   ┌────────────┐  Fly DELETE force
   │   │  evicting  │ ──────────────────────┐
   │   └────────────┘                       │
   │                                        ▼
   └────────────────────────── (back to empty, loop replenishes)
```

每个 PoolEntry 是一个 TypeScript 对象：

```typescript
interface PoolEntry {
  machineId: string;        // Fly machine id, 24 hex
  privateIp: string;        // fdaa:77:...:5
  createdAt: number;        // for age-based eviction
  state: 'creating' | 'stopped' | 'consumed' | 'evicting';
}
```

### 3.3 并发模型

**Critical section**：`pool.consume()` 必须原子从 `stopped` 队列拿一个 entry，避免 race（两个并发 acquire 拿同一台 machine）。

实现：JavaScript 单线程 → 用同步 array `shift()`，自动原子。但 `start()` 是 async，所以 consume 拿到 entry 后立刻 `state='consumed'`，剩下的 start + callPodStart 是 per-entry 串行无 race。

**Replenish 并发**：背景 setInterval（每 `POOL_REPLENISH_INTERVAL_MS` 一次，默认 10s）检查 `stopped.length < TARGET_SIZE`，差几个就并发起几个 `provisionStoppedEntry()`。但有 `POOL_REPLENISH_CONCURRENCY` 上限（默认 2）保护 Fly API rate limit。

```
on tick:
  let need = TARGET_SIZE - stopped.length - creating.length
  if need <= 0: return
  for i in 0..min(need, REPLENISH_CONCURRENCY - creating.length):
    spawnProvision()  // 不等，异步插入 #provisioning Set
```

### 3.4 Failure modes + 容错

| 失败 | 当前行为 (phase 11.2) | Pool 行为 (phase 11.3a) |
|---|---|---|
| Fly API down (create) | acquire 500 | replenish loop 失败 + 重试；acquire 走 cold fallback |
| Fly 镜像 registry 拉不到 | acquire timeout 90s | replenish 失败安静记 metric；acquire 用 pool 里现成的 |
| 池空 (starved) | N/A | acquire **fall back to cold path** via delegate.acquire() |
| pool entry 启动失败 (state→stopped 失败) | N/A | 该 entry destroyed + 立即 replenish；acquire 重试下一个 entry（最多 3 次）后 fallback cold |
| pool entry stale (Fly host 重启 / 升级 / 我们 deploy 了新镜像 tag) | N/A | 周期性 `POOL_MAX_AGE_SECONDS` (默认 24h) eviction + `POOL_IMAGE_CHANGED_EVICT_ON_START=true` 行为：control plane 启动时 destroy 所有 pool entries（避免老镜像 entry 服务新 deploy） |
| pool replenish 抛错 (网络) | N/A | catch + log + 下一 tick 重试。永不 propagate 到 acquire |
| cloud-runtime 重启 | acquire 全 cold | bootstrap 时拉 `GET /apps/$pod-app/machines` 重建 pool 视图（带 `metadata.mosaiq_pool=true` 过滤） |
| Fly destroy 失败（孤儿 machine） | release 已经 best-effort 吞错 | 同 phase 11.2，best-effort 删 + log。Pool 自己的孤儿同此处理 |

### 3.5 重启恢复 (bootstrap reconciliation)

最 tricky 的部分。cloud-runtime 进程重启后，内存里的 `#pool` 列表全丢。但 Fly 那边还有 N 台 stopped machines 在那躺着。两边视图必须同步。

**方案**：

1. machine config 加 `metadata.mosaiq_pool: 'true'`（区分 pool 预热 entry vs in-use session 的 machine）+ `metadata.mosaiq_pool_image_digest: <sha256 of pod image at provision time>`。
2. 启动时 `GET /apps/$pod-app/machines`，过滤 `state=stopped` AND `metadata.mosaiq_pool=true`：
   - image digest 跟当前不匹配 → destroy（防 stale pool entry 服务新代码）
   - 匹配 → 加入 `#pool.stopped`
3. 同样 destroy 所有 `state=stopped` AND `metadata.mosaiq_pool != 'true'`——这些是 phase 11.2 时代孤儿（acquire 失败后没清干净的）。

### 3.6 Session lifecycle 改动点

`acquire()` 在 `FlyPooledMachineManager` 内部：

```typescript
async acquire(spec: AcquireSpec): Promise<AcquiredMachine> {
  // 1) 试 pool consume
  const entry = this.#tryConsumePoolEntry();
  if (!entry) {
    // 池空 → cold fallback
    poolMissesTotal.inc({ reason: 'starved' });
    return this.#cold.acquire(spec);
  }

  // 2) 在 pool entry 上 start + bind session
  try {
    await this.#startMachine(entry.machineId);   // Fly POST /start, ~3s
    await this.#waitForState(entry.machineId, 'started');  // ~2s
    const podOrigin = `http://[${entry.privateIp}]:${this.#podControlPort}`;
    await waitForPodReady({ podOrigin, ... });   // ~2s pod hono 就绪
    const podResp = await callPodStart({ podOrigin, spec, ... }); // ~18s chromium spawn

    // 3) 入 #alive，rename pool entry → session machine
    this.#alive.set(entry.machineId, podOrigin);
    poolHitsTotal.inc();
    return { id: entry.machineId, podOrigin, cdpInternalUrl: rewriteCdpHost(...) };
  } catch (err) {
    // start/pod ready/callPodStart 失败 → destroy 这台、重试一次、最后 fallback cold
    await this.#destroyMachine(entry.machineId).catch(noop);
    poolAcquireErrorsTotal.inc({ phase: '...' });
    // 不递归重试 pool（避免 thundering herd），直接 fallback
    return this.#cold.acquire(spec);
  } finally {
    // 4) replenish loop 自动补一个新的（不在这里同步触发）
  }
}
```

`release()` 跟 phase 11.2 不变——destroy machine。Pool 不回收（single-use semantics）。

---

## 4. 配置 knobs

| Env | 默认 | 范围 | 说明 |
|---|---|---|---|
| `POOL_TARGET_SIZE` | `0` | 0-50 | 期望保持的 stopped pool 数量。`0` = pool 完全禁用 = phase 11.2 行为。 |
| `POOL_REPLENISH_INTERVAL_MS` | `10_000` | 1000-60000 | 后台补充 loop 间隔。 |
| `POOL_REPLENISH_CONCURRENCY` | `2` | 1-10 | 同时跑几个 provision。保护 Fly API rate limit + 控制突发账单。 |
| `POOL_MAX_AGE_SECONDS` | `86_400` (24h) | 3600-604800 | pool entry 最大年龄。过期自动 destroy + 补。 |
| `POOL_BOOTSTRAP_EVICT_FOREIGN` | `true` | bool | 启动时 destroy 所有非 pool-metadata 的 stopped machines（清孤儿）。 |
| `POOL_PROVISION_TIMEOUT_MS` | `120_000` | 60000-300000 | 单次 provision (create → stopped) 的硬超时。 |

**defaults are conservative**：`POOL_TARGET_SIZE=0` 意味着这次 deploy 默认行为不变。运维上调到 `3` 或 `5` 来开启 pool。

---

## 5. Observability

### 5.1 Metrics（接 `apps/cloud-runtime/src/metrics.ts`）

```
# Counter
pool_hits_total                    # acquire 成功从 pool 拿到 entry
pool_misses_total{reason}          # reason=starved|entry_failed|fallback_to_cold
pool_provisions_total{outcome}     # outcome=success|failed
pool_evictions_total{reason}       # reason=max_age|image_changed|bootstrap_foreign|consume_failed

# Gauge
pool_size{state}                   # state=stopped|creating|consumed|evicting
                                   # scrape 时刷新（同 pool_state）

# Histogram
pool_acquire_duration_seconds      # warm acquire 单独统计，对比 mm_acquire_duration_seconds (cold)
pool_provision_duration_seconds    # 从 POST /machines 到 state=stopped 的耗时
```

### 5.2 Log events

- `pool: provision started`（debug）
- `pool: entry stopped + in pool`（info, machineId, durationMs）
- `pool: consume`（info, machineId, age_ms, stopped_remaining）
- `pool: starved, falling back to cold`（warn）
- `pool: entry consume failed`（warn, machineId, phase=start|ready|start_chromium, cause）
- `pool: evict`（info, machineId, reason, age_ms）
- `pool: bootstrap reconcile`（info, found=N, evicted=M, kept=K）

---

## 6. 实施计划

3-4 个 commit，每个绿测后再下一个：

### Commit 1: `refactor(cloud-runtime): extract pool-friendly primitives from FlyMachineManager`

把 `fly.ts` 里 `#createMachine` / `#getMachine` / `#waitForState` / `#destroyMachine` 改成 `#protected` 或加 `internal` 命名 export，**行为零变化**，全部测试照常绿。Pool 实现复用这几个。

新加：
- `#stopMachine(id)` — Fly POST `/v1/apps/.../machines/:id/stop`
- `#startMachine(id)` — Fly POST `/v1/apps/.../machines/:id/start`

`#createMachine` 加可选参数 `{ skipLaunch?: boolean }`，pool 传 `true`，session-direct path 不传（保持 phase 11.2 行为）。

### Commit 2: `feat(cloud-runtime): FlyPooledMachineManager — stopped-machine pool implementation + tests`

新文件：

- `apps/cloud-runtime/src/machine/fly-pool.ts` — pool class
- `apps/cloud-runtime/src/machine/fly-pool.test.ts` — 10+ tests

测试覆盖：
- pool empty → fallback cold path
- pool replenish loop 补到 TARGET_SIZE
- consume → start → start fails → destroy + fallback
- consume → start ok → pod start fails → destroy + fallback
- max-age eviction
- bootstrap reconcile（mock 现有 machines list）
- 并发 acquire 不拿同一 entry
- shutdown destroys all pool entries

### Commit 3: `feat(cloud-runtime): wire FlyPooledMachineManager into factory + env vars`

- `apps/cloud-runtime/src/env.ts` — 6 个新 env vars + superRefine validation
- `apps/cloud-runtime/src/env.test.ts` — 4-5 个新测试
- `apps/cloud-runtime/src/machine/factory.ts` — 分支：`MACHINE_MANAGER=fly && POOL_TARGET_SIZE>0` → 包一层 pool
- `apps/cloud-runtime/.env.example` — 文档化新 vars
- `fly.cloud-runtime.toml` — `[env]` 块加 `POOL_*` 占位 + 注释
- `apps/cloud-runtime/src/routes/metrics.ts` + `src/metrics.ts` — 接入 pool metrics

### Commit 4: `docs(phase-11.3): forward-ref + runbook entry`

- `docs/PHASE-11.3-MACHINE-POOL.md` ← 本文件
- `docs/PHASE-11.2-FLY-DEPLOY.md` §13 / 附录 — 简介 + 链回 11.3
- Memory update（手工写）

---

## 7. 灰度 + 回滚 plan

### 7.0 观测路径（MVP）

**不**搭 Prometheus + Grafana 整套基建（我们不是 SaaS at 1000 req/s）。改用 `scripts/prod-pool-snapshot.ps1`：每个阶段前后各抓一次 `/v1/metrics`、解析 5 个 pool counter + acquire histogram、本地 diff 算 hit rate / P50 / P95。够指导 4 步灰度决策。

```powershell
# 一次性：把 METRICS_TOKEN 放到环境变量（不要 commit）
$env:METRICS_TOKEN = "<from flyctl secrets list>"

# 抓快照
powershell -File scripts/prod-pool-snapshot.ps1 -Label "baseline-pool-0"

# 输出 tmp/pool-snapshots/snapshot-<ts>-baseline-pool-0.json
```

### 7.1 prod 灰度（4 步执行剧本）

**Step 1 — 基线 (POOL_TARGET_SIZE=0)**

```powershell
# 0a. 跑一波真实业务流量（至少 5-10 个 createSession，可用 prod-smoke-cloud.mjs）
node scripts/prod-smoke-cloud.mjs
# 0b. 抓基线快照（应看到 hit_rate=n/a, mean_acquire 反映 cold path ~40s）
powershell -File scripts/prod-pool-snapshot.ps1 -Label "baseline-pool-0"
```

**Step 2 — 启用 pool=1（最小风险）**

```bash
# 设 secret（secret 优先级 > [env] block, 重启自动生效, 不需要 redeploy）
flyctl secrets set POOL_TARGET_SIZE=1 --app mosaiq-cloud-runtime

# 等 ~30s 让 machine restart + bootstrap reconcile
sleep 30

# 确认 pool 起来了：应该看到 1 台 mosaiq_pool=true 的 stopped machine
flyctl machine list --app mosaiq-browser-pod
```

```powershell
# 跑业务流量，观察 acquire 是否变快
node scripts/prod-smoke-cloud.mjs
node scripts/prod-smoke-cloud.mjs    # 第 2 次应该命中 pool（如果第 1 次消耗后 pool 补到了）

# 抓 1h / 6h / 24h 三个时间点的快照
powershell -File scripts/prod-pool-snapshot.ps1 -Label "pool-1-h1"
# ... 6 小时后
powershell -File scripts/prod-pool-snapshot.ps1 -Label "pool-1-h6"
# ... 24 小时后
powershell -File scripts/prod-pool-snapshot.ps1 -Label "pool-1-h24"
```

**Decision gate (Step 2 → 3)**：
- `hit_rate_pct` ≥ 80% → 继续 Step 3
- `prov_fail_rate_pct` < 5% → Fly API 健康
- `evictions{max_age}` 速率 < 业务量 5x（pool 不在做无用功）
- 任一不满足 → 留在 1 多观察 / 或回滚到 0 调试

**Step 3 — 扩到 pool=3（稳态）**

```bash
flyctl secrets set POOL_TARGET_SIZE=3 --app mosaiq-cloud-runtime
sleep 60   # bootstrap 时间稍长（要补到 3）
flyctl machine list --app mosaiq-browser-pod   # 应看到 3 台 stopped
```

```powershell
powershell -File scripts/prod-pool-snapshot.ps1 -Label "pool-3-h24"
powershell -File scripts/prod-pool-snapshot.ps1 -Label "pool-3-h72"
```

**Decision gate (Step 3 → 4)**：仅在持续 hit_rate ≥ 90% 且业务量 > 50 sessions/day 时才扩大。否则 3 是最优。

**Step 4 — pool=5（仅当业务量 > 100 sessions/day）**

```bash
flyctl secrets set POOL_TARGET_SIZE=5 --app mosaiq-cloud-runtime
```

### 7.2 回滚

任何 issue 直接 `flyctl secrets set POOL_TARGET_SIZE=0 --app mosaiq-cloud-runtime` —— 不需要重新 deploy 代码。Pool 会停止补充，存量 entry 自然消耗或被 max-age evict。这就是为啥选 composition 而不是改 `FlyMachineManager` 内部行为：pool 完全是 opt-in 包装层。

**触发回滚的红线**:
- 任一 acquire 耗时 > 60s（pool 反而更慢，bug）
- `prov_fail_rate_pct` > 20%（Fly API 故障，pool 在制造账单不增加价值）
- `evictions{consume_failed}` 持续增长（pool entry 起不来，warm 路径变 cold + 1 次 destroy 调用）
- 账单 6h 内超出 cold-only 基线 2x

### 7.3 紧急孤儿清理

`flyctl machine list --app mosaiq-browser-pod` 看到一堆 stopped 但 cloud-runtime 视图为空？跑：

```bash
flyctl machine list --app mosaiq-browser-pod --json \
  | jq -r '.[] | select(.state=="stopped") | .id' \
  | xargs -I {} flyctl machine destroy --force --app mosaiq-browser-pod {}
```

（实际上 `POOL_BOOTSTRAP_EVICT_FOREIGN=true` 应该已经在每次 cloud-runtime 启动时自动清掉这些。这条命令是兜底。）

### 7.4 快照对比（手工 diff）

PowerShell 没内建 JSON diff，用 `Compare-Object` 处理简单字段：

```powershell
$base = Get-Content tmp/pool-snapshots/snapshot-*-baseline-pool-0.json | ConvertFrom-Json
$pool = Get-Content tmp/pool-snapshots/snapshot-*-pool-3-h24.json     | ConvertFrom-Json

# Mean acquire 对比
"$($base.summary.mean_acquire_sec)s -> $($pool.summary.mean_acquire_sec)s"
# 比如 "40.2s -> 18.4s" = pool 工作了，砍掉 ~22s
```

实测数据填到 §11 验收标准下面的 "实测结果" 段。

---

## 8. Phase 11.3b/c 前瞻

**11.3b（如果 ~22s 仍不够快）**：加 `POOL_HOT_SIZE` env。pool 多一层 `running` tier：N 台 stopped + M 台 running（chromium 未起，pod hono 已起）。Hot tier 加速 ~5s（去掉 microVM boot）。代价：每台 hot machine ~$1.9/day 闲置。

**11.3c（如果 sub-2s 才能满足产品）**：研究 chromium pre-spawn with stealth-neutral persona + per-session BrowserContext + CDP-level fingerprint overrides。需要重写 stealth 注入逻辑使之 per-context 而非进程级。Phase 12 R&D。

**11.3d / phase 12+ R&D**：自定义 anti-detect chromium fork，把 canvas noise / WebGL fingerprint 做成进程内可切换。这才能真正 sub-1s。

---

## 9. 不在 phase 11.3a scope 内

- ❌ Multi-region pool（per-region pool）—— 当前 `iad` 单 region 就够。phase 11.4 再说。
- ❌ Pool entry 跨 session 复用（destroy + replenish 的成本被认为 acceptable）。
- ❌ chromium-level 优化（pre-spawn / 复用 chromium 进程）。
- ❌ 自动 scaling 基于 traffic（pool size 是手工 env 设定的，不自动伸缩）。
- ❌ LocalDocker pool（dev 模式 cold spawn 已经只有 ~3s，不值得）。

---

## 10. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Pool entry stale 导致 acquire 用了老 chromium 镜像 | 中 | 高（detection 失败） | image digest in metadata + 启动时 reconcile + max-age eviction |
| Replenish loop 死循环 / 资源泄漏 | 低 | 中（cloud-runtime OOM） | bounded concurrency + 错误吞 + log；测试覆盖 |
| Fly API rate limit 撞墙 | 中 | 中（pool 短期补不上） | REPLENISH_CONCURRENCY=2 上限 + exponential backoff on 429 |
| pool entry consume race | 低 | 高（同 entry 给两个 session） | array.shift() 同步原子 + state='consumed' 守门 |
| cloud-runtime 重启后丢视图 + 重启时正好有 acquire | 低 | 中（短时间 cold path） | bootstrap reconcile 优先于 acquire serving；可接受 |
| 账单失控（pool 异常补充） | 低 | 高 | hard cap MAX_MACHINES + POOL_TARGET_SIZE 上限 50 |

---

## 11. 验收标准

### 11.1 代码侧（已完成）

- [x] 所有 cloud-runtime 单测绿（包括新加的 `fly-pool.test.ts` 24 个 + `routes/metrics.test.ts` 11 个，共 149/149）。
- [x] `/v1/metrics` 暴露 `machine_pool_hits_total` / `machine_pool_misses_total{reason}` / `machine_pool_provisions_total{outcome}` / `machine_pool_evictions_total{reason}` / `machine_pool_entries{state}`。
- [x] PHASE-11.3 runbook 编写。
- [x] `fly.cloud-runtime.toml` POOL 默认值 + 灰度文档 inline。
- [x] `scripts/prod-pool-snapshot.ps1` 灰度观测工具。

### 11.2 prod 灰度（待执行 — §7.1 剧本）

- [ ] **Step 1 baseline** ：`POOL_TARGET_SIZE=0` 下 prod-smoke 跑通 + 抓基线快照（应 ~40s mean acquire）。
- [ ] **Step 2 pool=1** ：`flyctl secrets set POOL_TARGET_SIZE=1` 后 24h，hit_rate ≥ 80% 且 prov_fail_rate < 5%。
- [ ] **Step 3 pool=3** ：扩到 3 后 72h，`flyctl machine list` 持续显示 3 台 stopped（稳态）。
- [ ] **Step 4 (optional)** ：仅在 business volume > 100 sessions/day 时考虑 pool=5。
- [ ] cloud-runtime 重启后 30s 内 pool 视图重建（log: `pool bootstrap reconcile done`）。

### 11.3 实测结果（灰度执行时填）

| Step | 时间 | mean acquire | P50 | P95 | hit_rate | prov fail | 决策 |
|---|---|---|---|---|---|---|---|
| baseline | TBD | TBD | TBD | TBD | n/a | n/a | → step 2 |
| pool=1 @ 24h | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| pool=3 @ 24h | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| pool=3 @ 72h | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

**预期**: pool=3 稳态下 mean acquire 应从 ~40s 降到 ~22s（warm 路径主导）。如未达到，回 §7.2 红线诊断。

---

## 附录 A — Fly Machines API skip_launch 行为

```http
POST /v1/apps/mosaiq-browser-pod/machines
Content-Type: application/json
Authorization: Bearer ...

{
  "region": "iad",
  "skip_launch": true,
  "config": {
    "image": "registry.fly.io/mosaiq-browser-pod:latest",
    "env": {...},
    "guest": {...},
    "metadata": { "mosaiq_pool": "true", "mosaiq_pool_image_digest": "sha256:..." }
  }
}
```

响应：`{ "id": "...", "state": "created", "private_ip": "fdaa:..." }` —— 注意 state 是 `created` 不是 `started`。需要后续 `POST .../start` 才会到 `started`。

> **注意**：Fly docs 显示 `skip_launch` 在 created 后 machine 状态会迁移到 `stopped`（非 `created`）。具体在 phase 11.3a 实现里要测一下实际行为，可能需要 `waitForState(id, 'stopped')` 而不是直接相信 POST response。
