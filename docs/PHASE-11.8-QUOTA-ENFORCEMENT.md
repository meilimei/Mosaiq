# Phase 11.8 — Per-Project Quota Enforcement（并发 + 月度用量上限）

> **状态**：设计（2026-05-29）。承接 11.7：11.7 *测量*用量，11.8 *强制*限额。

> **一句话**：今天**普通 session 没有任何 per-project 并发上限**——单租户能开到全局 pool 上限、饿死其他客户并跑爆 Fly 机器费（只有 keepAlive session 有 per-project cap）。本 phase 补上 (1) per-project 并发活跃 session 上限，(2) per-project 月度 browser-minutes 上限（复用 11.7 的 `aggregateUsage`），把"测量→强制"闭环。纯后端、复用现有 quota 模式、零外部依赖。

---

## 1. 决策摘要

| 维度 | 决策 |
|---|---|
| Scope | (1) `SESSIONS_PER_PROJECT_MAX` 并发活跃 session 上限（**所有** session，非仅 keepAlive）(2) `MINUTES_PER_PROJECT_PER_MONTH_MAX` 月度用量上限（默认 0=关闭）(3) `quota_denied_total{reason}` metric + docs |
| 强制点 | `POST /v1/sessions` createSession，在 acquire **之前**（拒绝不耗 pod / 不计费） |
| 并发上限错误 | `quota.sessions_exceeded` → **429** + `Retry-After: 60`（并发满，关掉一个 session 即可重试） |
| 月度上限错误 | `quota.minutes_exceeded` → **402 Payment Required**（用量耗尽，非释放资源可解，需等下月 / 升档） |
| 默认值 | `SESSIONS_PER_PROJECT_MAX=50`（成本护栏，generous）；`MINUTES_PER_PROJECT_PER_MONTH_MAX=0`（关闭，opt-in，无行为变更 + 无额外 query） |
| kill switch | 两者 `=0` 语义不同：sessions=0 → 暂停该模式所有新 session（套用 keepalive/contexts 的 0=kill-switch 约定）；minutes=0 → **关闭检查**（不是 0 分钟上限） |
| 与 11.5 keepAlive cap 关系 | `KEEPALIVE_SESSIONS_PER_PROJECT_MAX` 保留为**更紧的子限**：keepAlive session 先过总 cap，再过 keepAlive 子 cap |
| Non-goal | plan/tier 表、per-project override（DB 列）、in-flight 分钟精确计入、billing 后端（11.7b）。本期只做 env 全局默认 |

---

## 2. 背景：现状的配额缺口

11.1–11.7 已有的 per-project 限额：

| 限额 | env | 强制处 | 错误码 / status |
|---|---|---|---|
| keepAlive 并发 session | `KEEPALIVE_SESSIONS_PER_PROJECT_MAX` (默认 5) | `sessions.ts` `if (effectiveKeepAlive)` 块 | `pool.keepalive_saturated` / 429 |
| 活跃 contexts | `MOSAIQ_CONTEXTS_PER_PROJECT_MAX` (默认 100) | `contexts.ts` POST | `pool.contexts_saturated` / 429 |

**缺口**：

1. **普通（keepAlive=false）session 无 per-project 并发上限。** 只受全局 pool 容量约束（`pool.exhausted` 503）。后果：单租户可独占整个 pool，饿死其他客户 + 无界 Fly 成本。这是本期 #1 价值点（**当下就存在的滥用 / 成本向量**）。
2. **无月度用量上限。** 11.7 测了 browser-minutes 但不设顶。某客户（或 bug 导致的 session 泄漏）可在一个计费周期内累积无界分钟数。`aggregateUsage` 已就绪，缺的只是"读出来比一下"。

---

## 3. 强制点与错误语义

### 3.1 位置

`apps/cloud-runtime/src/routes/sessions.ts` createSession，在 `const handle = await getDb();`（现 L366）之后、`if (effectiveKeepAlive)`（现 L368）之前插入。此处 `auth.projectId` / `env` / `handle` 均在 scope。

检查顺序（最便宜 + 最常拒先行）：

```
1. quota.sessions_exceeded  （并发计数，always-on，便宜）   ── 所有 session
2. quota.minutes_exceeded   （月度 SUM，仅 enabled 时跑）    ── 所有 session
3. pool.keepalive_saturated （keepAlive 子 cap）             ── 仅 keepAlive
4. sticky lookup → acquire → insert
```

在 acquire 之前拒绝 → 不拨 pod、不产生计费、不占 pool slot。

### 3.2 错误码（`utils/errors.ts` 新增）

| code | status | detail | Retry-After |
|---|---|---|---|
| `quota.sessions_exceeded` | 429 | `{ activeCount, quota }` | `60` |
| `quota.minutes_exceeded` | 402 | `{ usedMinutes, quotaMinutes, windowFrom, windowTo }` | 无（释放资源解不了；下月重置或升档） |

为什么不复用 `pool.*_saturated`：`pool.*` 语义偏"机器池/并发饱和、释放即可重试"。月度用量上限不是释放资源能解的（402 Payment Required 才是 HTTP-正确信号）。新建干净的 `quota.*` family；旧的 `pool.keepalive_saturated` / `pool.contexts_saturated` 名字保留不改（避免破坏性 churn），文档注明同族关系。

`handleApiError` 的 status 联合类型需加入 `402`。

---

## 4. 并发 session 配额（`SESSIONS_PER_PROJECT_MAX`）

```ts
// 所有 session（keepAlive 与否都算）。复用 keepAlive cap 同款 SELECT-count 模式。
const liveRows = await handle.drizzle
  .select({ id: sessionsTable.id })
  .from(sessionsTable)
  .where(and(eq(sessionsTable.projectId, auth.projectId), eq(sessionsTable.status, 'live')));
const activeCount = liveRows.length;
if (activeCount >= env.SESSIONS_PER_PROJECT_MAX) {
  c.header('Retry-After', '60');
  audit(c, 'session.create', `project:${auth.projectId}`, 'denied',
    { reason: 'sessions_exceeded', activeCount, quota: env.SESSIONS_PER_PROJECT_MAX });
  quotaDeniedTotal.inc({ reason: 'sessions' });
  throw new ApiError('quota.sessions_exceeded',
    `project ${auth.projectId} has ${activeCount} live sessions (quota ${env.SESSIONS_PER_PROJECT_MAX})`,
    { activeCount, quota: env.SESSIONS_PER_PROJECT_MAX, retryAfterSeconds: 60 });
}
```

- 计数 `WHERE project_id=? AND status='live'`：`sessions_project_idx (project_id, opened_at)` 前缀命中 project_id；`sessions_status_idx` 备选。cap ≤ 1000 行扫描成本可忽略（同 keepAlive cap 的论证）。**不**新增 `(project_id, status)` 索引（alpha 规模没必要，避免写放大）。
- `SESSIONS_PER_PROJECT_MAX` ≥ `KEEPALIVE_SESSIONS_PER_PROJECT_MAX`（总 cap 是 keepAlive 子 cap 的超集）。默认 50 ≥ keepAlive 默认 5 ✓，且 50 = keepAlive 的 hard max，自洽。
- `=0` → kill switch：暂停该 project 所有新 session（运维手段：停掉欠费 / 滥用租户）。

---

## 5. 月度 browser-minutes 配额（`MINUTES_PER_PROJECT_PER_MONTH_MAX`）

```ts
if (env.MINUTES_PER_PROJECT_PER_MONTH_MAX > 0) {   // 0 = 关闭，跳过 SUM
  const { fromIso, toIso } = currentMonthWindowUtc();
  const totals = await aggregateUsage(handle, auth.projectId, fromIso, toIso);
  const usedMinutes = totals['session.minute'] ?? 0;
  if (usedMinutes >= env.MINUTES_PER_PROJECT_PER_MONTH_MAX) {
    audit(c, 'session.create', `project:${auth.projectId}`, 'denied',
      { reason: 'minutes_exceeded', usedMinutes, quotaMinutes: env.MINUTES_PER_PROJECT_PER_MONTH_MAX });
    quotaDeniedTotal.inc({ reason: 'minutes' });
    throw new ApiError('quota.minutes_exceeded',
      `project ${auth.projectId} used ${usedMinutes} min this month (quota ${env.MINUTES_PER_PROJECT_PER_MONTH_MAX})`,
      { usedMinutes, quotaMinutes: env.MINUTES_PER_PROJECT_PER_MONTH_MAX, windowFrom: fromIso, windowTo: toIso });
  }
}
```

- **复用** 11.7 的 `aggregateUsage` + `currentMonthWindowUtc`（零新查询逻辑）。
- **软上限语义**：usage 在 session **关闭**时才 emit，故 in-flight session 未计入。客户可能小幅超额（≈ 当前并发 session 的时长）。本期接受——硬上限要算 in-flight，over-engineering。文档注明。
- 默认 `0` = 关闭：无 plan 定义前不block 任何人，且省掉每次 createSession 的 SUM 查询。operator 按 plan opt-in。
- enabled 时每次 createSession 一条 SUM（命中 `usage_events_project_ts_idx`）。alpha 规模可忽略；未来可 per-(project,window) 缓存。

---

## 6. 配置（`env.ts`）

```ts
/** 每 project 同时 status='live' 的 session 上限（keepAlive 与否都算）。
 *  默认 50 = 成本护栏（50 pods/project 已是 generous alpha 顶）。范围 [0, 1000]：
 *  - 0 = kill switch，该 project 所有新 session 立即 429 quota.sessions_exceeded
 *  - 必须 ≥ KEEPALIVE_SESSIONS_PER_PROJECT_MAX（总 cap 是 keepAlive 子 cap 超集） */
SESSIONS_PER_PROJECT_MAX: z.coerce.number().int().min(0).max(1000).default(50),

/** 每 project 每自然月（UTC）billable browser-minutes 上限。
 *  默认 0 = 关闭（不设顶、且跳过 SUM 查询）。范围 [0, 10_000_000]：
 *  - >0 时超额 → 402 quota.minutes_exceeded（软上限，in-flight 未计） */
MINUTES_PER_PROJECT_PER_MONTH_MAX: z.coerce.number().int().min(0).max(10_000_000).default(0),
```

`fly.cloud-runtime.toml [env]` 显式写出默认值，便于 ops `flyctl secrets set` 调整。

---

## 7. Metrics

```
quota_denied_total{reason}   counter   reason=sessions|minutes
```

`metrics.ts` 新增。在两处 throw 前 inc。dashboard 看每种配额的拒绝速率（持续高 = 该客户该升档 / 或有滥用 / 或 cap 设太紧）。不加 project_id label（counter + project_id 在拒绝场景 cardinality 可控但本期从简；需要时 11.8b 加）。

---

## 8. 测试计划

**commit 1（并发 cap）**——`app.test.ts`：

- 满 `SESSIONS_PER_PROJECT_MAX` → 429 `quota.sessions_exceeded` + `Retry-After: 60` + detail `{activeCount, quota}`
- `=0` → 所有新 session 即时 429（kill switch）
- 关闭一个 session（DELETE）后名额释放 → 下一个 201
- per-project 独立（A 满不影响 B）
- keepAlive session 也计入总 cap（总 cap < keepAlive cap 时总 cap 先触发）

**commit 2（月度 cap）**——`app.test.ts`：

- `MINUTES_PER_PROJECT_PER_MONTH_MAX=0` → 不检查（即使有历史用量也放行，且不跑 SUM）
- 预插 usage_events 使本月 used ≥ quota → 402 `quota.minutes_exceeded` + detail（usedMinutes/quotaMinutes/window）
- used < quota → 放行；上月用量（窗口外）不计入
- per-project 独立

**commit 3**：`metrics.test.ts` 断言 `quota_denied_total{reason="sessions"|"minutes"}` 自增。

全程保持既有 333 测试绿 + typecheck clean。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 默认 cap 误伤合法高并发客户 | 默认 50 generous（远超 alpha 单客户需求）；minutes 默认关闭；都可 env 即时放宽 |
| 月度软上限超额 | 接受小幅超额（in-flight 未计）；文档明示；硬上限留 future |
| 每次 createSession 加查询延迟 | 并发 count 走索引 ~ms；minutes SUM 仅 enabled 时跑；acquire 本就 3–60s，占比可忽略 |
| sticky-rejoin 在满 cap 时被 429 抢先（拿不到 409+connectUrl 重连）| 已存在行为（keepAlive cap 同样在 sticky lookup 之前）；本期保持一致不回归，未来可把 sticky lookup 前移修正。文档记录 |
| 402 被某些 client/proxy 误处理 | 402 是 billing-aware API 的正确信号；detail 给足上下文；并发 cap 仍用 429 |

---

## 10. Commit 拆分

1. **commit 1** — 并发 session cap：`env.ts` `SESSIONS_PER_PROJECT_MAX` + `errors.ts` `quota.sessions_exceeded`(429) + `metrics.ts` `quota_denied_total` + `sessions.ts` 强制 + `app.test.ts`。
2. **commit 2** — 月度 minute cap：`env.ts` `MINUTES_PER_PROJECT_PER_MONTH_MAX` + `errors.ts` `quota.minutes_exceeded`(402) + `handleApiError` 加 402 + `sessions.ts` 强制（复用 aggregateUsage）+ `app.test.ts`。
3. **commit 3** — `fly.cloud-runtime.toml` env 默认值 + README 段落 + `metrics.test.ts` 断言 + 本 doc 验收勾选。

---

## 11. 验收

- [x] 普通（keepAlive=false）session 满 `SESSIONS_PER_PROJECT_MAX` → 429 quota.sessions_exceeded；关一个即可再建
- [x] `SESSIONS_PER_PROJECT_MAX=0` → kill switch；per-project 独立
- [x] keepAlive session 计入总 cap（总 cap 先于 keepAlive 子 cap 触发）
- [x] `MINUTES_PER_PROJECT_PER_MONTH_MAX=0` → 不检查、不跑 SUM；>0 且本月超额 → 402；窗口外用量不计
- [x] 拒绝发生在 acquire 之前（不耗 pod / 不计费 / 不占 slot）
- [x] `quota_denied_total{reason}` 两路径自增
- [x] 既有 333 测试保持绿；typecheck clean
