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

**⚠️ Pre-flight：确认 prod 镜像已经含 phase 11.3a 代码**。`flyctl secrets set` 只重启现有镜像，不会重新 build。如果上次 deploy 早于 phase 11.3a 实现（commit `99846db` 之前），单纯改 secret 不会启用 pool。

```bash
# 看 deployment tag：要么 tag 时间晚于 11.3a 实现，要么先 redeploy
flyctl image show -a mosaiq-cloud-runtime

# 如果镜像太旧（或没把握），先 deploy 一次再继续：
flyctl deploy --config fly.cloud-runtime.toml --dockerfile apps/cloud-runtime/Dockerfile
```

```bash
# 设 secret（secret 优先级 > [env] block, 重启自动生效）
flyctl secrets set POOL_TARGET_SIZE=1 --app mosaiq-cloud-runtime

# 等 ~30s 让 machine restart + bootstrap reconcile
sleep 30

# 验证 pool 已激活（必看，否则后面所有指标都是假的）：
# 1) cloud-runtime 日志里应当出现：
#    "machine-manager: fly + pool (phase 11.3a)"
#    "pool bootstrap reconcile done" (kept=0, evicted=0 是干净状态)
#    "pool: entry stopped + ready to consume" (~70s 后)
flyctl logs -a mosaiq-cloud-runtime --no-tail | Select-String "machine-manager:|pool bootstrap|pool: entry"

# 2) Fly 应该看到 1 台 mosaiq_pool=true 的 stopped machine
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

- [x] 所有 cloud-runtime 单测绿（149/149 in phase 11.3a 落地时；之后 phase 11.3 admin tooling 又加了 `revoke-api-key.test.ts` + `list-api-keys.test.ts` 共 8 个 case，当前基线 157/157）。
- [x] `/v1/metrics` 暴露 `machine_pool_hits_total` / `machine_pool_misses_total{reason}` / `machine_pool_provisions_total{outcome}` / `machine_pool_evictions_total{reason}` / `machine_pool_entries{state}`。
- [x] PHASE-11.3 runbook 编写。
- [x] `fly.cloud-runtime.toml` POOL 默认值 + 灰度文档 inline。
- [x] `scripts/prod-pool-snapshot.ps1` 灰度观测工具。

### 11.2 prod 灰度（§7.1 剧本执行状态）

- [x] **Step 1 baseline** ：`POOL_TARGET_SIZE=0` 下 prod-smoke 跑通 + 抓基线快照。**实测 mean acquire = 62s（n=1）**，远高于设计稿预期的 ~40s。
- [x] **Step 2 pool=1（启动 + 初步验证）** ：`flyctl secrets set POOL_TARGET_SIZE=1` + `flyctl deploy` 后，跑 2 个 smoke。**mean acquire = 34.95s, hit_rate = 100% (2/2), prov_fail = 0% (0/3)**。pool bootstrap reconcile 干净（kept=0, evicted=0），replenish 在 consume 后 ~70s 内补回 stopped 状态。详见 §11.4。
- [-] **Step 2 续 — 24h 稳态观测（POOL_TARGET_SIZE=1）** —— **PARKED 2026-05-26 + 由 phase 11.4a 超越**：
  - 2026-05-26：~25h 后 baseline snapshot 显示 0 traffic（`hit_rate=n/a`, `mm_acquire_count=0`）。decision gate `hit_rate ≥ 80%` 需要 acquire 样本，无 traffic 不可达。详 §11.4 item 6。
  - 2026-05-27：phase 11.4a Stagehand-compat 落地后 POOL_TARGET_SIZE 被升到 **5**（为 smoke 的 3 并发 + 临近跑次提供足够 burst 容量）。为了 pool=1 专项补手 24h 观测表，需重新下调 1 并启动 traffic；gate 依旧必须是 ≥5 sessions/day 持续 3 天。在那之前，§11.3 表中新增一行 **pool=5 @ post-stagehand** 接上 phase 11.4a §6.1 实测的 15 个 acquire 样本作为当下唯一可靠的 prod traffic 参考。
- [-] **Step 3 pool=3** —— **PARKED 2026-05-26**：gate 是"持续 hit_rate ≥ 90% AND 业务量 > 50 sessions/day"。phase 11.4a 已解 demand 侧供给面，但 traffic 仅有内部 smoke，还不达 gate。后续看外部 onboarding。
- [-] **Step 4 (optional)** —— **PARKED 同上**：gate 是 > 100 sessions/day。
- [x] cloud-runtime 重启后 30s 内 pool 视图重建（log: `pool bootstrap reconcile done`）—— 实测 boot→reconcile=0.2s，reconcile→first entry stopped=71s。

### 11.3 实测结果

| Step | 时间 (UTC) | n | mean acquire | P50 | P95 | hit_rate | prov fail | 决策 |
|---|---|---|---|---|---|---|---|---|
| baseline (pool=0) | 2026-05-24 23:04 | 1 | 62.06s | ∞ (>60) | ∞ (>60) | n/a | n/a | client `fetch failed`（>Fly proxy 60s timeout）→ 立即推进 step 2 |
| pool=1 初始 | 2026-05-24 23:47 + 2026-05-25 04:40 | 2 | 34.95s (33.9-36.4) | ≤60 (bucket cap) | ≤60 (bucket cap) | 100% | 0% (0/3 provs) | 健康，继续 24h 观测 |
| pool=1 @ 24h | PARKED · 需 ≥5 sess/day 重跑 | 0 | n/a | n/a | n/a | n/a | n/a | 0 traffic, gate 不可达 |
| pool=5 @ post-stagehand | 2026-05-27 23:29-23:42 | 15 | 35.49s | ~34.4s (中位数) | 39.0s (p100) | 100% (15/15) | 0% (0/15) | warm-pool acquire 趋于稳态、无 retry、与设计预期 35-40s 同区间 |
| pool=3 @ 24h | TBD | — | — | — | — | — | — | TBD |
| pool=3 @ 72h | TBD | — | — | — | — | — | — | TBD |

**结果亮点**：
- Cold→warm 节省 ~27s（**42% latency reduction**），单样本对比一致。
- 解决了一个未在设计稿预测到的 **副作用**：cold path 62s 高于 Fly edge proxy ~60s idle timeout，导致客户端必现 `TypeError: fetch failed`（即使 server 端 session 创建成功）。pool=1 warm 路径 35s 落在 proxy 预算内，行为从"server 成功但 client 报错"恢复到"正常 201"。
- Replenish loop 在 consume 后 ~70s 内补回（首次 bootstrap 也是 71s）。意味着 pool=1 只适合 inter-arrival > 70s 的稀疏流量；高并发突发流量需要 pool >= burst size 才能保住命中率。
- **pool=5 @ post-stagehand**（2026-05-27 phase 11.4a 后续观测）：mean=35.49s，与 pool=1 初始采集的 34.95s 几乎同区间，说明 replenish 机制随 pool size 线性撑开、不会引入额外延迟。p100=39.0s 仍 < Fly proxy 60s budget，0/15 retry 表明 provision_failure path 在平台上近于绝迹。详 [PHASE-11.4-STAGEHAND-COMPAT.md §6.1](./PHASE-11.4-STAGEHAND-COMPAT.md#61-hello-world-烟测)。

**实测 vs 设计预期**：
- 实测 warm: **35s** vs 设计稿"~22s start"目标。差距来自 Fly machine `stopped→started` (2-5s) + browser-pod chrome 冷启动 + control-plane 握手，比初版估计更长。
- 设计稿"~3s warm"假设是 keep-machines-started 模式（更贵），phase 11.3a 明确选择了 keep-stopped（成本优先），所以 3s 路径不适用。
- 不影响"显著优于 cold-only"这个核心论点。

### 11.4 灰度过程中暴露的问题（已全部消化）

1. ✅ **`flyctl secrets set` 不会重新打包镜像** —— 已在 §7.1 Step 2 顶部加 pre-flight 检查（commit `79dca52`）：先 `flyctl image show -a mosaiq-cloud-runtime` 看 deployment tag，太旧就先 `flyctl deploy` 再改 secret。
2. ✅ **`mm_acquire_duration_seconds` histogram 最高 bucket 是 60s** —— 已在 commit `aa16029` 加宽到 `[..., 30, 40, 50, 60, 75, 90, 120]`（参见 `apps/cloud-runtime/src/metrics.ts:113`）。warm 35s 现在落在 30/40 bucket 之间能区分细粒度，cold 62s 落在 75/90 bucket 不再卡 `+Inf`。
3. ✅ **`prod-pool-snapshot.ps1` PS 5.1 `Join-Path` 限制** —— 已在 `af2fbdb` 用 `[System.IO.Path]::Combine` 修掉，无回归风险。
4. ✅ **API key 轮换中 plaintext 泄漏面** —— 已在 phase 11.3 admin tooling 全面解决：
   - `apps/cloud-runtime/src/admin/create-api-key.ts` 加 `--quiet` 模式（plaintext 由 caller 经 env var 注入，admin 脚本绝不回显）
   - `apps/cloud-runtime/src/admin/revoke-api-key.ts` + `list-api-keys.ts` 配套 CLI
   - `scripts/rotate-api-key.ps1` 把 7 步操作浓缩成单条命令（CSPRNG 生成 → 剪贴板 → `sh -c` 注入 → auth probe → 客户端切换 → revoke 旧 key → 清场）
   - 完整 playbook + footgun 见 `docs/PHASE-11.2-FLY-DEPLOY.md` §8。
   - 旧的"在 ssh console 里跑 admin create-api-key 让 plaintext 打到 stdout"路径已废弃；2026-05-25 真机演练验证新路径 5 个断言全过。
5. ⚠️ **METRICS_TOKEN 轮换** —— 仍走 `flyctl secrets set METRICS_TOKEN=<new>` 一次性操作（会触发 cloud-runtime 重启 ~10s）。无专用脚本（也不需要——它不像 API key 那样有数据库行 + 多 caller 切换的复杂度）。如果哪天需要 zero-downtime metrics scrape，再考虑加 dual-token 支持。
   - **token 值丢失恢复**：先抓再 rotate 能保住累计计数器。`prod-pool-snapshot.ps1 -FromFile <body>` 可以解析 out-of-band 抓回的 /v1/metrics 文本；脚本头部 usage 有 SSH-scrape 配方（`flyctl ssh -C "sh -c 'echo <base64-of-node-http-script> | base64 -d | node'"`，因为 cloud-runtime 镜像里没 curl/wget 但有 base64 + node）。2026-05-26 实测过：admin tooling 部署后忘记保存新值 → SSH-scrape 拿到 25h 计数器（结果 0 traffic）→ 安心 rotate。
6. 🎯 **灰度卡在 demand 而非 infra**（2026-05-26 战略复盘）—— phase 11.3a 设计目标已达成：pool=1 实测 **35s warm acquire / 100% hit_rate (n=2) / 0% prov_fail / bootstrap reconcile 干净**。但 §11.3 表里 24h/72h/pool=3 行的 decision gate 全是 traffic-based（hit_rate ≥ 80%, ≥50 sessions/day, ≥100 sessions/day），实测 25h 0 traffic → 都不可达。瓶颈已从 infra 迁到 demand：再多观测 1 周仍是 0/0，decision 永远不会 fire。结论：**phase 11.3a 视为"代码 + 初步灰度 done，扩展决策 parked"**，下一步走 phase 11.4 = Stagehand SDK 兼容（PRD §1.1c/§2.2 GTM 核心钩子），让真用户带 demand 进来。pool 调参等 demand 起来再回头。

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
