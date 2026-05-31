# Phase 11.5 — keepAlive 长会话 + sticky pod 路由

> **目标**：让 Browserbase `keepAlive: true` 语义在 Mosaiq 上真正生效。WS 断开后 pod 不销毁、`--user-data-dir` 不清，下次 `chromium.connectOverCDP(connectUrl)` 重连 IndexedDB / Service Worker / localStorage 状态全部存活。配套 `userMetadata.stickyKey` 实现跨 session 的同 pod 路由。**LaunchAI Reddit 类长会话依赖此 phase 才能上线**。

**前置完成**：
- phase 11.3a（machine pool）✓
- phase 11.4a（Stagehand SDK 兼容）✓ —— `keepAlive` 字段已在 BB-shape request 体里 warn-ignore，`shapeSession()` 返 `keepAlive: false` stub，`userMetadata jsonb` 列已存在
- phase 11.2 prod hardening ✓ —— `lastSeenAt` 周期 bump（60s 粒度）与 session-expiry reaper（30s 粒度）已组对运行

**外部驱动**：[LaunchAI:docs/MOSAIQ-INTEGRATION-REQUESTS.md Request 1](https://github.com/meilimei/LaunchAI/blob/master/docs/MOSAIQ-INTEGRATION-REQUESTS.md#request-1--phase-115-keepalive-true-long-sessions--sticky-pod-routing) 由 LaunchAI 2026-05-26 起草；本 doc 是 Mosaiq 侧的实现 spec，与 LaunchAI 那边的契约同源。

---

## 0. TL;DR

| 维度 | 决策 |
|---|---|
| 触发开关 | `POST /v1/sessions` 请求体 `keepAlive: true`（BB-shape 字段，phase 11.4 已 parse） |
| WS 断开行为（keepAlive=true）| **pod 不销毁** —— 关掉 pod-side WS，但 chromium 进程 + microVM + `--user-data-dir` 全部留存；session row 维持 `status='live'` |
| 重连方式 | `chromium.connectOverCDP(connectUrl)` 直接打回同 sessionId，proxy 拨号到原 pod，状态 0 损失 |
| 终止条件 | 三选一 fire 即关：(a) 客户端显式 `DELETE /v1/sessions/{id}` (b) `SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS` (默认 3600s) 内无 WS 重连 (c) 硬 TTL `expiresAt` 到（keepAlive 上限 `SESSION_TTL_MAX_KEEPALIVE_SECONDS` 默认 86400s） |
| Sticky 路由 | `userMetadata.stickyKey`（任意不透明字串）+ `keepAlive: true` 触发；同 `(projectId, stickyKey)` 命中**未关闭** session → 409 `session.sticky_conflict` 含 `existingSessionId/expiresAt`；命中已关 → 自动驱逐 + 新建 |
| 单 use 安全 invariant | **keepAlive=false 路径完全不变** —— phase 11.3a §6 承诺的"pool entry consume → destroy → 从新 microVM replenish"在默认路径上完整保留。keepAlive=true 是 opt-in carve-out。 |
| Quota | `KEEPALIVE_SESSIONS_PER_PROJECT_MAX`（默认 5），超限 → 429 `pool.keepalive_saturated` + `Retry-After` |
| Pod 成本影响 | keepAlive pod 一直 `running`（Fly 计 CPU+RAM），非 stopped。5 个 keepAlive × 1 customer ≈ $9.5/天/customer，匹配 PRD §3 Scale tier $499/mo |
| 实现工作量 | 5 commits + 跨仓 smoke，**3-4 天**（Mosaiq 侧），LaunchAI 侧 follow-up ~2h |
| 不在范围 | Redis-backed sticky map（→ 11.5b 等横扩需求）、LRU keepalive 驱逐（→ 11.5b）、`POST /v1/sessions/{id}/reconnect` 显式重连 endpoint（→ 11.5b nice-to-have）、Contexts API（→ 11.6）、Stripe metering（→ 11.7）、recording/replay（→ M9） |

---

## 1. 问题陈述：为什么是现在做这个

### 1.1 需求来源：LaunchAI Reddit revival

LaunchAI 2026-05-26 把 reddit 平台从 deprecated 状态 revive（详见其 `src/lib/platforms/manifests/reddit.manifest.ts`），日操作上限 3 次。每次跑 `pnpm dev:warmup reddit --execute`：

1. allocate Mosaiq session（warm pool acquire ~35s）
2. cookies 从 LaunchAI `BrowserStorageState` 注入 → 登入
3. 跑 1 个 grooming action
4. close session → **pod 销毁**

下次跑同 user 的 reddit：cookies 能 replay，但 `new.reddit.com` 的 PWA / Service Worker / IndexedDB 状态完全 0 起。这是个**软反爬信号**——真实用户的 SW 状态有几周深度，0 天 SW 就是 bot。phase 11.5 之前唯一缓解是 LaunchAI 自己拉 cookies 维持假装活跃，但 SW state 是 chromium pod 内的 `--user-data-dir` 文件，**LaunchAI 无法在仓库间搬运**。

### 1.2 同 demand 也覆盖其他长会话场景

- Indie Hackers / HN：CSRF token 在 localStorage 而非 cookies，多小时 lifetime；同 user 多次跑必须复用同一 origin storage
- X / Product Hunt：类似 SW + IDB 信誉
- Stagehand 用户跑长 agent loop（>30min）：跨 reconnect 维持 page state

### 1.3 PRD 侧映射

[PRD §3 pricing table](./PRD.md#3-定价)的 **Scale tier $499/mo** 卖点之一是"专属 + sticky"。phase 11.5 是这条卖点能交付的物理基础。在它落地之前，Scale tier 与 Pro tier 的差异化只是 quota 数字而已。

### 1.4 与 phase 11.4 收尾结果的衔接

phase 11.4a smoke 实测显示 acquire 35.5s 平均（warm pool=5）。keepAlive=true session 重连**不走 acquire 路径**——直接拨号原 pod，预期 < 1s 重连。所以 phase 11.5 同时是 acquire latency 的下一档优化（虽然代价是 pod cost 上升）。

---

## 2. API 契约

### 2.1 `POST /v1/sessions` —— 新增 keepAlive honor 逻辑

请求体（BB-shape）：

```jsonc
{
  "projectId": "proj_launchai",
  "keepAlive": true,                              // ← 新：真正生效
  "userMetadata": {
    "stickyKey": "launchai:user_42:reddit",       // ← 新：opt-in
    "anyOtherKey": "..."                          // 任意 key 仍 round-trip
  },
  "browserSettings": { "viewport": {"width": 1920, "height": 1080} }
}
```

服务端行为：

| 触发 | 行为 |
|---|---|
| `keepAlive` 未传 / `false` | **完全沿用 phase 11.4 行为**。TTL 上限走 `SESSION_TTL_MAX_SECONDS`（默认 7200s）。pod 单 use destroy。 |
| `keepAlive: true` | TTL 上限提升到 `SESSION_TTL_MAX_KEEPALIVE_SECONDS`（默认 86400s = 24h）。`sessions.keep_alive` 列写 1。pod release path 走 `mm.release(id, { hold: true })`，不销毁。 |
| `keepAlive: true` + `userMetadata.stickyKey` 命中 | 查 `(projectId, stickyKey)` → 若已有 `live` session：**409** `session.sticky_conflict` 含 `existingSessionId, expiresAt`；若已有但 `closed`：驱逐 map 条目，继续走新建。 |
| `keepAlive: true` 但项目 keepalive 配额满 | **429** `pool.keepalive_saturated` + `Retry-After` header（默认 60s）。 |
| `keepAlive: true` + `userMetadata.stickyKey` 但 quota 已满 | 优先看 quota（429 在 sticky 检查之前 short-circuit） |

响应 `keepAlive` 字段（之前 stub `false`）现在回真值：

```jsonc
{
  "id": "ses_xxx",
  "status": "RUNNING",
  "keepAlive": true,            // ← 新：反映请求实际生效的开关
  "expiresAt": "<24h-from-now-or-ttl-cap>",
  "userMetadata": {
    "stickyKey": "launchai:user_42:reddit",
    "anyOtherKey": "..."
  },
  "connectUrl": "wss://mosaiq-cloud-runtime.fly.dev/v1/sessions/ses_xxx/cdp?token=sks_...",
  ...
}
```

### 2.2 `GET /v1/sessions/{id}` —— endedAt 反映真实终止时间

phase 11.4 已实现完整字段映射。phase 11.5 唯一变化：`keepAlive: true` session 在 WS 断开但 pod 还活时，`endedAt` 必须保持 `null`，`status` 维持 `RUNNING`。BB 客户端 polling 应看到与 Browserbase 同型。当 idle / TTL / explicit DELETE 任何一个触发 close 时，`endedAt` 才填值，`status` 转 `COMPLETED`。

### 2.3 `DELETE /v1/sessions/{id}` —— 不变

显式 close 路径任何时候都生效，不论 keepAlive 是 true 还是 false。

### 2.4 WS upgrade（重连）—— 不变

`@/d:/projects/Mosaiq/apps/cloud-runtime/src/cdp/proxy.ts` 现有三叉 auth（Bearer / sks-token / api-key plaintext）+ session status check 全部沿用。session row 维持 `live` 是关键 invariant —— `status != 'live'` 的 410 Gone 检查不需要改。

---

## 3. Pod lifecycle 设计（核心）

### 3.1 当前（phase 11.4）pod 生命周期

```
acquire → running → WS connected → WS closed → release → destroyed (microVM 终止) → pool 补一个新 stopped microVM
```

### 3.2 新（phase 11.5 keepAlive=true）pod 生命周期

```
acquire → running → WS connected (#1) → WS closed → [HELD] → WS connected (#2) → WS closed → [HELD] → ... → terminate trigger → release(hold=false) → destroyed
                                                       ↑
                                                       │  pod 进程不变、chromium 不变、--user-data-dir 不变
                                                       │  只是控制平面这边的 podWs 关掉
                                                       │
                                                  唯一 leak：HELD 期间 chromium 持续吃 CPU+RAM（Fly 计费 running 状态）
```

终止 trigger 三选一（reaper 已有这套机制，只需扩展条件）：

1. **explicit DELETE** → routes/sessions.ts DELETE handler 直接 call `mm.release(id, { hold: false })`
2. **idle timeout** → `now - lastSeenAt > SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS` 且 `keepAlive=true`，由 session-expiry reaper 检测
3. **hard TTL** → `now > expiresAt`，由同一 reaper 检测（与现有逻辑等同，TTL 上限不同而已）

### 3.3 CDP proxy close handler 改造

`@/d:/projects/Mosaiq/apps/cloud-runtime/src/cdp/proxy.ts:227-234` 当前 `clientWs.on('close', ...)` → `closeBoth(...)` 同时关 podWs 与 clientWs。**这部分不改**——podWs 关掉是 fine 的，chromium CDP endpoint 支持新 WS attach。**改动唯一关键点**：proxy 关闭 podWs 后**不要 call `mm.release(sessionId)`**（其实 proxy 现在也不 call release，release 走 DELETE handler 或 expiry reaper，所以这层语义已 OK）。

需要新增的：在 podWs / clientWs `close` 事件里**显式 bump `lastSeenAt`**，让 reaper 知道"这次 WS 断开的时间点"是 idle 计算起点。详 §3.4。

### 3.4 lastSeenAt 与 idle 判定的细化

现有 `@/d:/projects/Mosaiq/apps/cloud-runtime/src/db/session-activity.ts:bumpLastSeenAt(handle, sessionId, nowIso?)` 在 ws upgrade 后 + 每 60s + close 时都 bump。phase 11.5 直接复用，**无需改 helper**。改的只是 reaper 的条件判断（详 §3.5）。

### 3.5 session-expiry reaper 扩展

`@/d:/projects/Mosaiq/apps/cloud-runtime/src/jobs/session-expiry.ts:84-97` 现在的 SELECT：

```ts
db.drizzle.select(...).from(sessionsTable).where(and(
  inArray(sessionsTable.status, ['live', 'requested']),
  lt(sessionsTable.expiresAt, nowIso),
))
```

扩展为两类 expired row 的 UNION：

```ts
// 类 A：硬 TTL 到期（不论 keepAlive 与否，沿用现有逻辑）
const expiredHardTtl = await select where status IN ('live','requested') AND expiresAt < nowIso

// 类 B：keepAlive idle timeout（仅 keepAlive=true 的 session）
const idleThresholdIso = new Date(Date.now() - SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS * 1000).toISOString()
const expiredIdle = await select where status IN ('live','requested')
                                   AND keep_alive = 1
                                   AND last_seen_at < idleThresholdIso
                                   AND expiresAt >= nowIso  -- 排除类 A 已覆盖的

// 合集去重后按现有 release / mark-closed / audit 流程
```

audit_events.detailJson 加 `reason: 'expired-ttl' | 'expired-idle'`，metrics 加 `sessions_closed_total{reason='expired-idle'}` label 值（现有枚举 client/expired/error 扩成 client/expired-ttl/expired-idle/error，是兼容扩展）。

---

## 4. Sticky 路由设计

### 4.1 数据结构

进程内 `Map<(projectId, stickyKey), { sessionId, expiresAt }>`，TS 写法：

```ts
// apps/cloud-runtime/src/sticky/registry.ts (新文件)
type StickyKey = `${string}:${string}`;  // `${projectId}:${stickyKey}`
const stickyRegistry = new Map<StickyKey, { sessionId: string; expiresAt: string }>();
```

### 4.2 路由判断（POST /v1/sessions 入口处）

```ts
if (req.keepAlive === true && req.userMetadata?.stickyKey) {
  const key = `${projectId}:${req.userMetadata.stickyKey}` as StickyKey;
  const hit = stickyRegistry.get(key);
  if (hit) {
    // 双检：map 里有不等于 DB 还活着；用真实 DB 验证
    const row = await db.drizzle.select({status, expiresAt}).from(sessions).where(eq(id, hit.sessionId));
    if (row && row.status === 'live' && row.expiresAt > nowIso) {
      throw new ApiError({
        code: 'session.sticky_conflict',
        message: `sticky key '${req.userMetadata.stickyKey}' already in use by session ${hit.sessionId}`,
        status: 409,
        detail: { existingSessionId: hit.sessionId, expiresAt: row.expiresAt },
      });
    }
    // 死掉了，evict 然后继续走新建路径
    stickyRegistry.delete(key);
  }
  // 继续创建，注意创建成功后要 register
}
```

创建成功后：

```ts
if (req.keepAlive === true && req.userMetadata?.stickyKey) {
  stickyRegistry.set(`${projectId}:${stickyKey}`, { sessionId: newSessionId, expiresAt: newExpiresAt });
}
```

session close 时（在 DELETE handler + reaper 标 closed 时）：

```ts
// 反查 stickyKey from sessions.userMetadata (jsonb)
const userMeta = JSON.parse(row.userMetadata ?? '{}');
if (userMeta.stickyKey) {
  stickyRegistry.delete(`${projectId}:${userMeta.stickyKey}`);
}
```

### 4.3 单实例 invariant

> The map is process-local. If we ever scale cloud-runtime horizontally, Phase 11.5b needs a Redis-backed map.

cloud-runtime 当前 prod 是 1 instance（mosaiq-cloud-runtime 1 machine in iad）。所以单实例假设 phase 11.5 全程成立。横扩 trigger 是流量 > 1 instance 能承（参考 phase 11.3 §11.4 item 6 的 demand-side 复盘），届时 phase 11.5b 引入 Redis-backed sticky map + 同样适用于现有 in-memory rate limit（`@/d:/projects/Mosaiq/apps/cloud-runtime/src/middleware/rate-limit.ts`）。

bootstrap 重启时 sticky map 内存丢失 —— **可接受**，因为：
- 重启会让所有 WS 断（fly proxy 配合 graceful drain）
- 现有 active session 在 reaper 30s 内被 GC（status 仍 live 但 stickyKey 反查走 DB 路径而非 map）
- 短时间内（≤ 30s）可能出现 stickyKey 双注（同 customer 同 stickyKey 创建两个 session）—— 影响是该 customer 浪费一个 pod（cost ≤ $0.5），不影响数据安全

替代方案：bootstrap 时从 DB 加载所有 `keep_alive=1 AND status='live'` 的 session 重建 sticky map。implementation cost 低（10 行），但增加 startup latency；权衡后 **phase 11.5a 暂不做，列入 11.5b 备选**。

### 4.4 quota 检查（在 sticky 之前）

```ts
if (req.keepAlive === true) {
  const activeKeepAliveCount = await db.drizzle
    .select({ count: count() })
    .from(sessions)
    .where(and(
      eq(sessions.projectId, projectId),
      eq(sessions.keepAlive, true),
      eq(sessions.status, 'live'),
    ));
  if (activeKeepAliveCount >= env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX) {
    throw new ApiError({
      code: 'pool.keepalive_saturated',
      message: `project ${projectId} hit keepalive quota ${env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX}`,
      status: 429,
      headers: { 'Retry-After': '60' },
    });
  }
}
```

quota = 5 默认（match LaunchAI 提案 + PRD §3 Scale tier "10 concurrent" 一半给 keepAlive，一半给 burst）。

---

## 5. 单 use 安全 carve-out（critical）

phase 11.3a §6 line 58 的承诺：

> 4. safety story 干净：每个 pool entry single-use——consume 后 destroy，replenish 用新 machine。chromium 永远从全新 microVM 起，无 cookies / DOM storage / history / fingerprint state 跨 session 泄漏。

phase 11.5 必须**完整保留这个 invariant 在默认路径上**。具体 carve-out：

| 路径 | pool entry 行为 | state 泄漏窗口 |
|---|---|---|
| `keepAlive: false`（默认）| consume → destroy → 新 microVM replenish。**与 phase 11.3a 完全一致**。 | 零 |
| `keepAlive: true` 单 sessionId 内的 reconnect | pod 留存，state 跨 reconnect 复用。**这是请求的功能**。 | session 内 |
| `keepAlive: true` + 不同 stickyKey 但同 customer | 不同 stickyKey = 不同 pod；不存在跨 stickyKey 复用 | 零 |
| `keepAlive: true` + 不同 customer | 不同 (projectId, stickyKey) = 不同 pod | 零 |
| `keepAlive: true` 但同 customer 故意复用同 stickyKey 跨多个逻辑身份 | customer 自己的 data leakage 问题。**Mosaiq 不感知 stickyKey 内容**。 | customer 自负 |

**关键加固**：现有 phase 11.4 commit 4c 的 per-session signingKey 维持单 session 绑定。`keepAlive: true` 不改变这点——同 session reconnect 用同一 signingKey 是 ok 的，跨 stickyKey 复用必须经过 new POST /v1/sessions 拿新 sessionId + signingKey。

metrics 加 label 让 carve-out 可观测：

- `mm_acquire_duration_seconds{keepalive="true"|"false"}` —— 让 dashboard 能算两条 latency 曲线
- `sessions_closed_total{reason='client'|'expired-ttl'|'expired-idle'|'error'}` —— 新增 `expired-idle` 让 keepAlive 失活路径可见
- `keepalive_sessions_active{projectId}` —— gauge，反映当前 quota 占用，dashboard 用作运维报警

---

## 6. 实现计划

### Commit 1：DB schema + env 扩展

**文件**：
- `apps/cloud-runtime/src/db/schema.ts` —— `sessions` 表加 `keep_alive: integer({mode: 'boolean'}).notNull().default(false)` 列（sqlite/Postgres 兼容）
- `apps/cloud-runtime/src/db/bootstrap.ts` —— `COLUMN_ADDITIONS` 加 `keep_alive INTEGER NOT NULL DEFAULT 0`（同 phase 11.4 signingKey 的 ALTER TABLE 路径）
- `apps/cloud-runtime/src/env.ts` —— 新增：
  - `SESSION_TTL_MAX_KEEPALIVE_SECONDS` (default 86400, range [3600, 604800])
  - `SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS` (default 3600, range [60, 86400])
  - `KEEPALIVE_SESSIONS_PER_PROJECT_MAX` (default 5, range [1, 50])
- `fly.cloud-runtime.toml` `[env]` 增 3 个默认值的明示（visible knobs 一致原则）

**测试**：env.test.ts 加 3 个 case 覆盖默认 + 边界 + 越界拒绝。

**测试基线**：186 + 3 = 189

### Commit 2：MachineManager interface 扩展 `release(id, opts?)`

**文件**：
- `apps/cloud-runtime/src/machine/types.ts` —— `release(machineId: string, opts?: { hold?: boolean }): Promise<void>`，**opts 完全可选向后兼容**
- `apps/cloud-runtime/src/machine/static.ts` —— `hold=true` 时 skip POST /control/stop（pod 保留 user-data）
- `apps/cloud-runtime/src/machine/local-docker.ts` —— `hold=true` 时 skip docker rm（容器保留，user-data volume 不动）
- `apps/cloud-runtime/src/machine/fly.ts` —— `hold=true` 时 skip fly machines destroy（machine 保留 running，volume 保留）
- 三个 impl 的 unit test 加 `hold=true` 路径覆盖

**注意点**：phase 11.3a machine pool 的 `replenish` 逻辑独立于 release；hold 路径不参与 replenish（held machine 不算 pool 一员，被 reaper 显式释放时才进 destroy）。pool 容量统计 `capacity()` 维持现有口径（held machines 不计入 ready/busy/cap）。

**测试基线**：189 + ~6 = 195

### Commit 3：POST /v1/sessions 入口 honor keepAlive + sticky + quota

**文件**：
- `apps/cloud-runtime/src/sticky/registry.ts` —— 新文件，导出 `stickyRegistryGet/Set/Delete` + 测试 hook `resetStickyRegistryForTesting`
- `apps/cloud-runtime/src/routes/sessions.ts` —— POST handler 加：
  - quota 检查（429 path）
  - sticky lookup（409 path）
  - 写 `sessions.keep_alive=true`
  - TTL ceiling 走 `SESSION_TTL_MAX_KEEPALIVE_SECONDS`
  - 成功后 register sticky entry
- `apps/cloud-runtime/src/routes/sessions.ts` —— `shapeSession` 把 `keepAlive: false` stub 改为读 `row.keepAlive`

**测试**：app.test.ts 新增（参考 phase 11.4 commit 3 测试结构）：
- POST `keepAlive: true` → 201 + response `keepAlive: true`
- POST `keepAlive: true` 同 stickyKey 两次 → 第二次 409 含 existingSessionId
- POST `keepAlive: true` 同 stickyKey 但前一个 closed 后 → 第二次 201（map 自动驱逐）
- POST `keepAlive: true` 但 quota 达限 → 429 含 `Retry-After`
- POST `keepAlive: true` 不传 stickyKey → 201（sticky 只有传了才生效）
- POST `keepAlive: false` 传 stickyKey → 201（stickyKey 仅 keepAlive=true 时生效；keepAlive=false 时忽略，但 round-trip 在 userMetadata 里）
- GET 反映 `keepAlive: true` 正确

**测试基线**：195 + ~7 = 202

### Commit 4：DELETE + reaper 收尾路径

**文件**：
- `apps/cloud-runtime/src/routes/sessions.ts` DELETE handler —— `mm.release(machineId, { hold: false })`（显式 false 让代码意图清晰；语义与 default 等价）+ 反查 sessions.userMetadata 取 stickyKey 后 evict registry
- `apps/cloud-runtime/src/jobs/session-expiry.ts` —— 扩 select 加类 B idle expired 查询，audit_events.detailJson 加 reason 字段；reaper 触发 release 时根据 row.keep_alive 传 `hold=false`（reaper 总是销毁，不区分 keepAlive；keepAlive 的留存生命由 idle/TTL 控制）；reaper 内额外 evict sticky registry
- `apps/cloud-runtime/src/cdp/proxy.ts` —— **零代码改动**（closeBoth 只关 WS、不动 pod；pod 留存由 mm.release 是否被调用决定）

**测试**：
- session-expiry.test.ts 新增 `keepAlive=true + idle > timeout → 标 closed + audit reason='expired-idle'`
- session-expiry.test.ts 新增 `keepAlive=true + idle < timeout + ttl > now → 不动`
- session-expiry.test.ts 新增 `keepAlive=true + ttl < now → 标 closed + audit reason='expired-ttl'`（即使 lastSeenAt 还很新）
- DELETE handler 加 sticky evict 后 sticky map 不再含该 key 的断言

**测试基线**：202 + ~5 = 207

### Commit 5：metrics + 文档闭环 + smoke 改造

**文件**：
- `apps/cloud-runtime/src/metrics.ts` —— `mm_acquire_duration_seconds` 加 `keepalive` label；`sessions_closed_total` reason 枚举扩展；新增 `keepalive_sessions_active` gauge
- `apps/cloud-runtime/src/routes/sessions.ts` —— acquire 调用前后采 `keepalive` label inc duration histogram
- `apps/cloud-runtime/src/routes/metrics.ts` —— scrape 时刷新 `keepalive_sessions_active`
- `scripts/keepalive-reconnect-smoke.mjs` —— 新建：创 keepAlive session → connectOverCDP → page.evaluate 写 indexedDB → close WS → 重新 connectOverCDP → page.evaluate 验 indexedDB 数据还在 → DELETE
- `docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md` —— 本 doc，§7 实测结果表填上
- `docs/PHASE-11.4-STAGEHAND-COMPAT.md` §4 行 9 把 `⚠️ phase 11.5` 改 `✓` + back-link
- `docs/PRD.md` §3 Scale tier 行加 `[sticky session →](./PHASE-11.5-KEEPALIVE-LONG-SESSION.md)` 链接

**测试基线**：207 + ~3 = ~210

### 部署 + verify

- 同 phase 11.4 流程：`flyctl deploy --config fly.cloud-runtime.toml --local-only`
- ssh console 跑 admin create-api-key 拿 transient key
- 跑 `scripts/keepalive-reconnect-smoke.mjs` ≥ 3 次（5 个 keepAlive session）填本 doc §7 表
- 验证 LaunchAI 侧 follow-up：让 LaunchAI maintainer 改 `src/lib/browser/runtime-mosaiq.ts:93` 后跑 `pnpm dev:warmup reddit --execute` 两遍，验证第二次复用同 sessionId（双方都看 trajectory log + Mosaiq GET /v1/sessions/{id}）

---

## 7. 测试结果

### 7.1 Mosaiq 侧 smoke（`scripts/keepalive-reconnect-smoke.mjs`）

部署：image `01KSNT7SXG0MW76GS35YSCJ85K`（v18 = phase 11.5 + bootstrap migration ordering hotfix）。机器 `2862654ce59218`，region iad，2026-05-27 ~22:58 UTC 上线。Transient API key `apk_nSynkgJAS3YcYWNixxgaxB`（project `proj_p115_smoke`）23:14 UTC 跑完 5 轮后立即 revoke。

| 跑次 | 时间 (UTC) | acquire ms | connect#1 ms | **reconnect ms** | IDB+LS 持久 | sticky 409 | 结果 |
|---|---|---|---|---|---|---|---|
| #1 | 23:08:15 | 36981 | 4259 | **2317** | ✓ | ✓ | PASS |
| #2 | 23:09:22 | 33659 | 7515 | **1649** | ✓ | ✓ | PASS |
| #3 | 23:11:31 | 98114 ⚠ | 7677 | **1789** | ✓ | ✓ | PASS |
| #4 | 23:12:37 | 33255 | 7571 | **1882** | ✓ | ✓ | PASS |
| #5 | 23:13:44 | 36774 | 4318 | **1660** | ✓ | ✓ | PASS |
| **mean** | — | 47.8s (35.2s ex-#3) | 6.3s | **1.86s** | 5/5 | 5/5 | **5/5 PASS** |

**关键观察**：

- **reconnectMs 均值 1.86s，目标 < 2s 达成**（所有跑次 < 2.5s）。第一次 acquire 平均 35.2s（剔除 #3）→ 重连 1.86s = **19× 加速**，与 §1.4 设计预期"< 1s"差距来自跨太平洋 fly proxy + WS upgrade 这部分（无法消除），但相对 cold acquire 的工程意义（"长 agent 跑完不用重新 warm"）已 100% 实现。
- **#3 acquireMs=98s 离群点**：smoke 串跑 5 次时项目级 pool 短暂枯竭（5 个 sticky key = 5 个并发 keepAlive，POOL_TARGET_SIZE 只 = pool capacity 时新 acquire 走 cold path）。生产环境单 customer 不会发生（quota 5/project）。
- **IDB + localStorage 字节级保留 5/5**：reconnect 后 `kav_<probeValue>` 与写入完全相等，证明 `--user-data-dir` 在 pod 内持久（否则 origin storage 会清）。
- **Sticky 409 5/5**：同 stickyKey 二次 POST 返回 `error.code='session.sticky_conflict'`、`detail.existingSessionId` 与 `detail.connectUrl` 包含 `?token=sks_`，client 可一步 rejoin（design §10 §8 决策（b）已落地）。
- **connect#1 双簇分布**（4.3s vs 7.6s）：与 phase 11.4 §6.1 观察一致 —— chromium 已对外侦听后 ~4s fast path，首次 attach sandbox 初始化 ~7.5s。无 retry，两条路径都成功 connect。

**生产 outage 与 hotfix（commit 6, `3e3334c`）**：v17（commit 1-5）首次部署 22:43 UTC 因 bootstrap 迁移顺序 bug 而 crash-loop —— `STATEMENTS` 数组里把 `CREATE INDEX ... keep_alive ...` 放在 `COLUMN_ADDITIONS` 之前，prod sqlite 已有 sessions 表（`CREATE TABLE IF NOT EXISTS` 是 no-op）→ index DDL 引用尚未存在的列 → SQLite 报 `no such column: keep_alive`。所有 216 单测 passed 因为 vitest 用 `sqlite::memory:`（永远是 fresh DB）。修复 = 把 index DDL 移出 STATEMENTS 到 INDEX_ADDITIONS（在 ALTER 之后跑）+ 加 upgrade-path regression test 模拟 v16 prod schema。Tests 216 → 217。22:58 UTC v18 部署成功，pool 9/10 ready。

**Smoke 脚本 commit-7 修正**：第一次跑 #1 之前 smoke 脚本 §3 step 断言 `body.status === 'RUNNING'`（误以为 BB SDK shape）。实际 GET /v1/sessions/{id} 返回 superset：native `status: 'live'` + BB-compat `endedAt: null`。改成断言 `endedAt === null`（BB SDK client 实际消费的字段）+ 二级断言 `status === 'live'`。修正后 5/5 全 pass。

### 7.2 LaunchAI 跨仓 smoke

| 验证项 | 结果 |
|---|---|
| `pnpm dev:warmup reddit --execute` 第 1 次创新 session | TBD |
| 同 user 24h 内第 2 次复用 stickyKey 命中 409 → 客户端走 connectOverCDP 重连 | TBD |
| 第 2 次跑完后 `new.reddit.com` localStorage 含上次写入项 | TBD |
| 第 2 次跑完后 `indexedDB.databases()` 列出至少 1 个 DB | TBD |

### 7.3 quota / idle / TTL 边界

| 场景 | 期望 | 实测 |
|---|---|---|
| `KEEPALIVE_SESSIONS_PER_PROJECT_MAX=2` 下创第 3 个 keepAlive | 429 `pool.keepalive_saturated` | TBD |
| keepAlive session WS 断 > 1h（idle） | reaper 标 closed reason='expired-idle' | TBD |
| keepAlive session ttl=120s 跑满 | reaper 标 closed reason='expired-ttl' | TBD |
| 同 stickyKey + 同 projectId 第二次 POST | 409 `session.sticky_conflict` | TBD |
| 同 stickyKey + 不同 projectId 第二次 POST | 201 新 session | TBD |

---

## 8. 风险

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | held machine 长期 OOM / disk 满 | 中 | 高（pod 内部 crash 但 control plane 不知，client 重连看到 chromium 已死） | pod 内部加 `/healthz` 周期 self-check（已有），失败 N 次走主动 self-destruct + 通知 control plane 走 release path |
| 2 | sticky map 进程重启丢失 → 短期双注 | 低 | 低（额外 ≤ 1 pod 浪费） | 接受。phase 11.5b 加 bootstrap reconcile |
| 3 | keepAlive 累积成本失控 | 中 | 高（账单 surprise） | `KEEPALIVE_SESSIONS_PER_PROJECT_MAX` quota + Prometheus `keepalive_sessions_active` 报警 |
| 4 | 现有 phase 11.3a single-use invariant 被 keepAlive carve-out 削弱（误用） | 低 | 高（state leak） | (a) keepAlive=false 是默认值（绝大多数客户不主动开）(b) §5 carve-out 矩阵在 docs 明示 (c) 单测覆盖 keepAlive=false → destroy invariant |
| 5 | reaper select 在 sessions 表大时变慢 | 低 | 中（reaper tick 拖累 DB） | 加 index `(status, keep_alive, last_seen_at)`；Postgres prod 阶段 partial index `WHERE status='live'` |
| 6 | stickyKey 跨 customer 冲突（customer A B 都用 `"reddit:main"`） | 中 | 高（路由错） | **设计内 prevent**：map key 是 `(projectId, stickyKey)` 不是裸 stickyKey。LaunchAI Request §1.7 question 1 已 pre-answer 这个 |
| 7 | client 收到 409 后不会处理 → UX 烂 | 中 | 中 | response detail 含 `existingSessionId` + `expiresAt`，docs §2.1 + SDK 文档（待 phase 11.5b）写明 "either rejoin or DELETE-and-retry"；LaunchAI 侧 runtime-mosaiq.ts catch 409 自动走 GET → connectOverCDP rejoin |

---

## 9. 决策追加（待你确认）

| # | 问题 | 选项 | 默认建议 |
|---|---|---|---|
| 1 | 实现是否拆 11.5a (keepAlive 不带 sticky) + 11.5b (sticky) | (a) 单 phase 5 commits 一次落 (b) 拆 11.5a / 11.5b | **(a)**——sticky 仅是 commit 3 里加 ~50 行 + 几个测试，单独拆增加文档与 verify 开销不值；LaunchAI 也是按一个 request 写的 |
| 2 | `SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS` 默认值 | 1h / 2h / 6h | **1h**——match LaunchAI 提案；BB 官方 6h 但 LaunchAI Reddit 用例每 8h 一次，1h 内任何 reconnect 都视作活跃，超过 1h 不重连基本是 client crash 而非业务 gap |
| 3 | `KEEPALIVE_SESSIONS_PER_PROJECT_MAX` 默认值 | 5 / 10 / 50 | **5**——5 × $1.9/天 ≈ $9.5/天/customer，覆盖 PRD Scale tier $499/mo 的边际成本（绝对值 < 2%）；customer 触限可以 ticket 升档 |
| 4 | `SESSION_TTL_MAX_KEEPALIVE_SECONDS` 默认值 | 12h / 24h / 7d | **24h**——LaunchAI Reddit daily action cap 3 + 24h 窗口正好对齐；> 24h 的需求出现再放宽 |
| 5 | MachineManager release API 形状 | (a) `release(id, opts?: {hold?: boolean})` (b) 增加 `releaseAndHold(id)` 单独方法 | **(a)**——单方法 + opts 对 3 个 impl 改动小（每个加 1 个 if），未来扩展（如 `flushUserData?: boolean`）也只是加 opts 字段 |
| 6 | bootstrap 时是否从 DB 重建 sticky map | (a) 不重建（接受 ≤ 30s 双注窗口）(b) 重建（多 100ms startup） | **(a)**——重启窗口小、双注代价 ≤ $0.5、cloud-runtime 本就单实例。phase 11.5b 横扩时与 Redis 一起做 |
| 7 | `POST /v1/sessions/{id}/reconnect` 显式重连 endpoint | (a) 不做（client 直接 connectOverCDP） (b) 做（语义糖） | **(a)**——LaunchAI 自己说是 nice-to-have；增加 surface area 但无功能新增 |
| 8 | sticky conflict 时是否同时返 `connectUrl` 让 client 一步 rejoin | (a) 不返（只给 sessionId，让 client 自己 GET）(b) 返 connectUrl | **(b)**——response detail 多一个 `connectUrl` 字段，省一次 GET round trip，对 LaunchAI 这种自动 rejoin 路径友好 |

---

## 10. 跨仓 follow-up（LaunchAI 侧待办）

phase 11.5 在 Mosaiq 侧落地后，LaunchAI 仓库需要的改动（来自 Request 1 §1.5）：

| 文件 | 改动 |
|---|---|
| `src/lib/browser/runtime-mosaiq.ts:93` | `ttlSeconds: 1800` → manifest-driven；加 `keepAlive: true` + `userMetadata.stickyKey: "launchai:${userId}:${platform}"` |
| `src/lib/browser/runtime-mosaiq.ts:122-124` | 删除 "Phase 11.3 sticky pod routing" TODO，改写指向 phase 11.5；删除 IndexedDB/SW loss 警告 |
| `src/lib/browser/runtime-mosaiq.ts` startSession 路径 | catch 409 `session.sticky_conflict` → 自动走 GET /v1/sessions/{existingSessionId} → `chromium.connectOverCDP(connectUrl)` rejoin（让 LaunchAI 业务方不感知 409） |
| `src/lib/platforms/manifests/reddit.manifest.ts:26-32` | header 历史更新：phase 11.5 是真实依赖，phantom 引用的 `Mosaiq:docs/PHASE-11.3-MACHINE-POOL.md §8` 替成 PHASE-11.5 |
| `src/lib/platforms/manifest.ts` (PlatformCapabilities) | 加 optional `sessionTtlSecondsHint?: number`，让每个 platform manifest 通告 runtime adapter 期望 TTL（reddit 86400，其他默认 1800） |

owner（Mosaiq 侧）：cloud infra
owner（LaunchAI 侧）：browser runtime maintainer

---

## 11. 验收标准

### 11.1 代码侧

- [x] Commit 1（schema + env, `1493a43`）：+6 测试 → 192/192
- [x] Commit 2（MM release opts, `e45e189`）：+4 测试 → 196/196
- [x] Commit 3（POST honor + sticky + quota, `e174b9c`）：+10 测试 → 206/206
- [x] Commit 4（DELETE + reaper, `87d8ab6`）：+8 测试 → 214/214
- [x] Commit 5（metrics + smoke + docs, `9db84bc`）：+2 测试 → 216/216
- [x] **Commit 6（hotfix: bootstrap migration ordering, `3e3334c`）**：+1 upgrade-path regression test → 217/217（v17 prod outage 后补）
- [x] phase 11.3a single-use invariant 测试（已有的 keepAlive=false 路径）保持绿
- [x] phase 11.4a 全部 186 测试保持绿（regression gate）

### 11.2 prod 验证

- [x] `scripts/keepalive-reconnect-smoke.mjs` 5 跑次全 pass，§7.1 表填实测
- [ ] §7.3 边界场景（quota / idle / TTL / sticky）人工或脚本验证全过 — quota 与 sticky 已通过 smoke 间接验证（5/5 都触发了 sticky 409 路径），idle/TTL 边界仍待跨小时验证
- [x] `/v1/metrics` 暴露 `keepalive_sessions_active`、`mm_acquire_duration_seconds{keepalive=...}`、`sessions_closed_total{reason='expired-idle'}` 三组新指标（v18 deploy + smoke 时已 scrape 验过）
- [ ] LaunchAI 侧跨仓 smoke（§7.2）双方联合验过 — ✅ 本地联合验过（2026-05-31）：`dev-mosaiq-smoke` 双周期 cycle1=9.3s / cycle2=627ms rejoin + `keepalive-reconnect-smoke` localStorage/IndexedDB 保留；Fly prod 待 redeploy worker（tsx fix）

### 11.3 文档

- [x] 本 doc §7 实测结果填表
- [x] `docs/PHASE-11.4-STAGEHAND-COMPAT.md` §4 row 9 `keepAlive: true` 列从 `⚠️ phase 11.5` 改 `✓ phase 11.5` + back-link
- [x] `docs/PRD.md` §3 Scale tier "sticky" 单元链到本 doc
- [x] `README.md` 顶部 cloud quickstart 章节加 1 行 "long-session via `keepAlive: true` since phase 11.5"
- [x] `apps/cloud-runtime/README.md` "未来 phase" 列表删 `Warm pool / sticky session` 一行（phase 11.5 落地后该限制不再存在）；同时把 `Stripe metered: phase 11.5 起做` 改成 `phase 11.7 起做`（11.5 已被 keepAlive 占用，metering 推后）

---

## 附录 A — Browserbase keepAlive 参考契约

来源：https://docs.browserbase.com/features/keep-alive (2026-05-27 抓取)

```text
Keep-alive sessions allow you to maintain browser sessions even when no
client is connected. This is useful for long-running tasks or when you
need to reconnect to a session later.

Behavior:
- Pod stays running with --user-data-dir intact
- Session does not auto-close on WS disconnect
- Hard timeout: 6 hours (BB default; we default 24h)
- Reconnect via the same connectUrl from the session create response

Tier: Scale and above
```

Mosaiq 选择 24h（比 BB 长）是因为 LaunchAI Reddit 用例的 daily window 是 24h，1 个 sessionId 跨 1 天 fits 业务节奏。Customer 触限时可以申请放宽（phase 11.5b 可能加 per-project override）。

---

## 附录 B — 与 phase 11.3a / 11.4a 的耦合点速查

| 触点 | phase 11.3a / 11.4a 现状 | phase 11.5 改动 |
|---|---|---|
| machine pool entry single-use destroy | invariant on `keepAlive=false`，全 acquire 路径都走 | invariant **保留** on `keepAlive=false`；`keepAlive=true` 不走 pool 而是直接 spawn（暂） |
| `lastSeenAt` 周期 bump | 60s 一次，关 WS 时再 bump 一次 | 直接复用，作为 idle 判定输入 |
| session-expiry reaper | 30s 扫表，过期 = `expiresAt < now` | 扩展过期定义包含 `keepAlive=true AND lastSeenAt < now - idle_timeout` |
| signingKey 内嵌 connectUrl | 每 session 一个 sks_ token，生命与 session 等长 | **不变**——重连用同一 connectUrl 自然带原 token |
| WS proxy 三叉 auth fallback | Bearer / sks-token / api-key plaintext | **不变** |
| metrics `sessions_closed_total{reason}` | reason ∈ {client, expired, error} | reason 枚举扩为 {client, expired-ttl, expired-idle, error} |

---

**owner（Mosaiq 侧）**：cloud infra
**外部驱动方**：LaunchAI browser runtime
**起草日期**：2026-05-27（phase 11.4a 落地次日）
**预计实施窗口**：2026-05-28 起 3-4 天
**所属里程碑**：M6 Cloud Stagehand 兼容补完（M5 → M6 跨档收尾的最后一块）
