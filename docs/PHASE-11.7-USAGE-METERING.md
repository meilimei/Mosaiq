# Phase 11.7 — Usage Metering（browser-minutes → Stripe Metered）

> **状态**：11.7a 代码完成（2026-05-29），4 commits 全部落地。**11.7b 代码完成（2026-05-29）**：`StripeMeterReporter` + `projects.stripe_customer_id` + admin 绑定工具 + 测试落地（详见 §11.7b）。真账号端到端冒烟（需 Stripe live key + meter）留运维。
>
> | Commit | hash | 内容 |
> |---|---|---|
> | design | `dfd8b44` | 本设计文档 |
> | c1 | `80ac567` | emitter + session.minute emission（DELETE + reaper）+ schema reported_at |
> | c2 | `afff97f` | aggregateUsage + GET /v1/usage |
> | c3 | `38be3eb` | MeterReporter（noop）+ usage-report job |
> | c4 | _本次_ | metrics（usage_minutes_total / usage_events_unreported / usage_report_total）+ docs |
>
> **一句话**：`usage_events` 表从 phase 11.1 就建好了但**没有任何 writer**。本 phase 让 session 生命周期真的落计费埋点（browser-minutes），加聚合查询 + 客户可见 usage 端点，并把"推送到 Stripe Metered"抽象成可注入接口（真 Stripe API 调用留给需要账号的子阶段）。这是 `$0.06/min` 定价模型的地基。

---

## 1. 决策摘要

| 维度 | 决策 |
|---|---|
| Scope（11.7a） | (1) `usage_events` emitter（session.minute）(2) 聚合 helper + `GET /v1/usage` 客户端读端点 (3) Stripe push 抽象成 `MeterReporter` 接口，默认 noop，周期 report job (4) metrics + docs |
| Out-of-scope（→ 11.7b） | 真 Stripe SDK 调用（需账号 + price id）、persona.checkout / proxy.gb 计量、月度对账、客户 invoice UI、credit/quota enforcement（用量超额拒绝） |
| 计费单位 | **per-session 向上取整 browser-minutes**：`value = max(1, ceil((closedAt-openedAt)/60s))`。匹配 `$0.06/min`；最小 1 分钟（任何开过的 session）。一行 usage_event / 一个关闭的 session |
| 何时 emit | session **关闭**时（status live→closed）：DELETE handler + expiry reaper 两条真实关闭路径。**不** emit：acquire 失败（从未 live）、context-race rollback（内部失败非用量）、keepAlive WS 断开（pod 没销毁、session 仍 live） |
| emit 可靠性 | 计费事件**不可丢**：`recordUsage()` 在 DELETE / reaper 里 **await**（不像 audit 那样 fire-and-forget）。单条 indexed insert ~ms，可接受 |
| 幂等 | session 只在 live→closed **一次**转换时 emit。DELETE 幂等（已 closed 直接 204）+ reaper OCC（`WHERE status IN ('live','requested')`）天然保证不重复计费 |
| Stripe 解耦 | `MeterReporter` 接口（`report(records)`）。`NoopMeterReporter`（默认，只 log）+ `StripeMeterReporter`（11.7b，需 `STRIPE_API_KEY`）。report job 读未上报的 usage_events → 调 reporter → 标记已上报 |
| 已上报标记 | usage_events 加 `reported_at TEXT`（NULL = 未上报）。job 只捞 `reported_at IS NULL`，成功后批量 set。失败保持 NULL → 下个 tick 重试（at-least-once；Stripe 用 idempotency key 去重，11.7b 处理） |

---

## 2. 数据模型

`usage_events` 已存在（phase 11.1）。本 phase 加一列：

```sql
ALTER TABLE usage_events ADD COLUMN reported_at TEXT;  -- NULL=未推送 Stripe；非 NULL=已推送时间戳
CREATE INDEX IF NOT EXISTS usage_events_unreported_idx ON usage_events (reported_at) WHERE reported_at IS NULL;
```

迁移顺序遵守 phase 11.5/11.6 教训：COLUMN_ADDITIONS 先于 INDEX_ADDITIONS。加 upgrade-path regression test。

现有列回顾：`id, project_id, session_id, kind, value(int), ts`。`kind='session.minute'`，`value` = 该 session 的 billable 分钟数。

---

## 3. Emitter（`src/usage/emitter.ts`）

```typescript
export type UsageKind = 'session.minute';  // 11.7a 只此一种；11.7b 加 persona.checkout / proxy.gb

/** 纯函数：从 open/close 时间戳算 billable 分钟（向上取整，最小 1）。 */
export function computeBillableMinutes(openedAtIso: string, closedAtIso: string): number {
  const ms = Date.parse(closedAtIso) - Date.parse(openedAtIso);
  if (!Number.isFinite(ms) || ms <= 0) return 1;  // 时钟漂移 / 同毫秒关闭 → 计 1 分钟
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** 写一条 usage_event。调用方 await（计费事件不可丢）。失败抛错由调用方决定吞/记。 */
export async function recordUsage(db, opts: {
  projectId: string; sessionId?: string | null; kind: UsageKind; value: number;
}): Promise<void>;
```

**emit 点**：
1. `routes/sessions.ts` DELETE：`if (row.status !== 'closed')` 块内，算 closedAt 后 `await recordUsage(...)`（释放 machine + 清 context lock 之后；emit 失败只 warn，不阻断 204——已经在 best-effort 区）。
2. `jobs/session-expiry.ts` reaper：成功 OCC update（`updated.length>0`）后 `await recordUsage(...)`，与 audit/lock-release 并列。

两处都用 `value = computeBillableMinutes(row.openedAt, closedAtIso)`。

---

## 4. 聚合 + 读端点

### 4.1 `GET /v1/usage?from=<iso>&to=<iso>`（bearer auth，read tier）

返回本 project 在区间内按 kind 聚合的用量：

```json
{
  "project_id": "proj_x",
  "from": "2026-05-01T00:00:00Z",
  "to":   "2026-06-01T00:00:00Z",
  "totals": { "session.minute": 1234 },
  "estimated_cost_usd": 74.04
}
```

- `from`/`to` 缺省：本自然月（UTC）。`to` 独占上界。
- `estimated_cost_usd` = `session.minute × UNIT_PRICE_USD_PER_MINUTE`（env，默认 0.06）。仅估算，真账单以 Stripe 为准。
- SQL：`SELECT kind, SUM(value) FROM usage_events WHERE project_id=? AND ts>=? AND ts<? GROUP BY kind`。命中 `usage_events_project_ts_idx`。

### 4.2 聚合 helper（`src/usage/aggregate.ts`）

`aggregateUsage(db, projectId, fromIso, toIso): Promise<Record<UsageKind, number>>` —— 端点 + report job 共用。

---

## 5. Stripe push（接口，11.7a 只 noop）

```typescript
// src/usage/reporter.ts
export interface UsageRecord { projectId: string; kind: UsageKind; value: number; windowEnd: string; }
export interface MeterReporter {
  readonly kind: 'noop' | 'stripe';
  report(records: UsageRecord[]): Promise<void>;  // 失败抛错 → job 不标 reported，下 tick 重试
}
```

- `NoopMeterReporter`（默认）：只 `log.info`，不外呼。让 11.7a 在没 Stripe 账号时也能跑通"emit → aggregate → report(noop) → 标 reported"全链路。
- `StripeMeterReporter`（11.7b）：`STRIPE_API_KEY` set 时启用，调 Stripe Billing Meter Events API，按 project→stripe customer 映射（需 projects 表加 `stripe_customer_id`，11.7b）。idempotency key = `${projectId}:${windowEnd}:${kind}`。
- 工厂 `getMeterReporter()`：`STRIPE_API_KEY` 有值 → stripe，否则 noop。同 MachineManager factory 套路 + `setMeterReporterForTesting()`。

### 5.1 report job（`jobs/usage-report.ts`）

仿 `session-expiry.ts`：纯函数 `reportUsage(deps)` + 长跑 `startUsageReportJob`。每 `USAGE_REPORT_INTERVAL_MS`（默认 60s）：

1. 捞 `reported_at IS NULL` 的 usage_events，按 (project, kind) 聚合
2. `reporter.report(records)`
3. 成功 → `UPDATE usage_events SET reported_at=now WHERE id IN (...)`（只标本次捞到的 id，防并发误标）
4. 失败 → 不标，warn，下 tick 重试

11.7a 默认 noop reporter，所以 job 实际只是把 events 标记 reported（验证管道）。

---

## 6. env 新增

```
UNIT_PRICE_USD_PER_MINUTE   number  default 0.06                    # GET /v1/usage 成本估算用
USAGE_REPORT_INTERVAL_MS    number  default 60000                   # report job tick
STRIPE_API_KEY              string  default ''                      # 空=noop reporter；非空=StripeMeterReporter（11.7b）
STRIPE_API_BASE_URL         string  default https://api.stripe.com  # 单测/回放可覆盖（11.7b）
STRIPE_METER_EVENT_NAME     string  default mosaiq_browser_minutes  # 须与 Stripe meter 的 event_name 一致（11.7b）
```

---

## 7. metrics

- `usage_minutes_total{project_id}` counter —— emit 时 inc（dashboard 看实时计费速率）。**注意 cardinality**：project_id label 只在 active 客户上增长，可接受（同 keepalive gauge）。
- `usage_events_unreported` gauge —— scrape 时刷新未上报行数（积压 = Stripe push 卡住的报警信号）。
- `usage_report_total{outcome}` counter —— report job 成功/失败次数。

---

## 8. Commit 计划

| Commit | 内容 | 测试基线 |
|---|---|---|
| 1 | schema 加 `reported_at` + 迁移 + emitter（`computeBillableMinutes` + `recordUsage`）+ DELETE/reaper emit 接线 | +~10 |
| 2 | `aggregateUsage` helper + `GET /v1/usage` 端点 | +~8 |
| 3 | `MeterReporter` 接口 + noop/factory + `usage-report` job + 接线 index.ts | +~8 |
| 4 | metrics + docs（本 doc §9 实测、README、PRD link） | +~3 |

---

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 重复计费（同 session emit 两次）| live→closed 单次转换 + DELETE 幂等 + reaper OCC；emit 在状态已确认转换之后 |
| 漏计费（emit 失败静默）| DELETE/reaper await emit；失败 warn + 仍有 session row 可事后补；report job at-least-once |
| 时钟漂移导致负/零时长 | `computeBillableMinutes` 对 ≤0 计 1 分钟（保守计费，不计 0） |
| Stripe 重复推送（at-least-once）| 11.7b 用 idempotency key `${project}:${window}:${kind}`；Stripe 侧去重 |
| keepAlive 长 session 计费爆量 | 正常预期（24h=1440min）；report job 周期推送，不积压；客户用 `GET /v1/usage` 自查 |

---

## 10. 验收（11.7a 代码侧）

- [x] DELETE / reaper 关闭 session → 恰好一条 `session.minute` usage_event，value 正确（`app.test.ts` + `session-expiry.test.ts`）
- [x] 幂等 DELETE / 已 closed 不重抢 → 不重复计费
- [x] `GET /v1/usage` 跨 project 隔离（只返本 project）+ half-open 时间窗过滤 + tz 归一化 + 成本估算
- [x] report job：noop reporter 下 events 被标 reported；reporter 抛错时保持 NULL 重试；只标本次捞到的 id（并发不变量）
- [x] metrics：usage_minutes_total emit 自增 / usage_events_unreported scrape 刷新 / usage_report_total{outcome}
- [x] 全部测试绿（333）；迁移在已有 usage_events 表的 prod-like DB 跑通（`bootstrap.test.ts` upgrade-path regression）
- [x] `ts` 显式写 ISO（不靠 CURRENT_TIMESTAMP）保证时间窗字典序正确

---

## 11.7b — Stripe Metered 推送（代码完成 2026-05-29）

把默认 noop 换成真 Stripe Billing Meter Events 推送，env 开关、project→customer 映射、at-least-once + Stripe 侧去重，全程可注入 fetch 单测。

### 实现

- **`projects.stripe_customer_id`**（nullable）：`schema.ts` + `bootstrap.ts` STATEMENTS（fresh DB）+ COLUMN_ADDITIONS（升级路径，老行迁移成 NULL）。`bootstrap.test.ts` 加 upgrade-path regression。
- **`StripeMeterReporter`**（`usage/reporter.ts`）：每条 `UsageRecord` 发一个 meter event
  ```
  POST {STRIPE_API_BASE_URL}/v1/billing/meter_events
  Authorization: Bearer {STRIPE_API_KEY}
  Idempotency-Key: {projectId}:{windowEnd}:{kind}
  body(form): event_name, identifier=<同上>, timestamp, payload[stripe_customer_id], payload[value]
  ```
  fetch 注入（`fetchImpl`）+ base URL 可覆盖，跟 `fly-api.ts` 同款，单测无需真账号。
- **customer 解析**：`resolveStripeCustomerIdFromDb(projectId)` 查 `projects.stripe_customer_id`；空 → null。
- **未映射 project**：resolve 返 null → `report()` 抛错（行保持 unreported，`usage_events_unreported` gauge 涨成可见报警）。**绝不把无法归属的 billable minutes 静默标 reported**。运维补映射后下 tick 自动恢复。
- **工厂 `getMeterReporter()`**：`STRIPE_API_KEY` 非空 → `StripeMeterReporter`（11.7a 时这里是 fail-fast 抛错）。
- **admin 绑定工具** `admin/set-stripe-customer.ts`：`node dist/admin/set-stripe-customer.js <projectId> <cus_...|->`（`-`/空清除映射），幂等。

### at-least-once 去重

job 失败不回填 `reported_at` → 下 tick 重抓重发。相同 `identifier`（`{projectId}:{windowEnd}:{kind}`，同时作 meter event `identifier` 与 HTTP `Idempotency-Key`）的事件被 Stripe 在聚合窗口内去重。

> **残留窗口（已知，留对账兜底）**：`windowEnd` 取 job tick 的 wall-clock，所以"Stripe 已成功 200、但进程在回填 `reported_at` 前崩溃"这一极窄窗口里，重发会用不同 `windowEnd` → identifier 变化 → 不被去重 → 该批可能重复计费。缓解：(1) 主重试路径（`report()` 抛错）下 Stripe 根本没收到事件，不存在重复；(2) 月度对账（`GET /v1/usage` 本地真值 vs Stripe meter 汇总）兜底校正。彻底关闭需 per-row identifier / outbox，留后续硬化。

### 验收（11.7b 代码侧）

- [x] `STRIPE_API_KEY` 非空 → 工厂返 `StripeMeterReporter`；空 → noop（向后兼容）
- [x] meter event form/headers/idempotency key 格式正确（`reporter.test.ts` 注入 fetch 断言）
- [x] 未映射 project → 抛错且不外呼；Stripe 非 2xx → 抛错（job 重试）；多条中任一失败 → 整批抛错
- [x] `projects.stripe_customer_id` 映射 set/clear/unchanged + 升级路径迁移（`set-stripe-customer.test.ts` + `bootstrap.test.ts`）
- [x] 全 cloud-runtime 测试绿（360）

**留运维 / 后续**：真 Stripe live key + meter 端到端冒烟；prod 部署 + 真实 customer 计费验证；月度对账脚本（`GET /v1/usage` vs Stripe meter summary）；per-row identifier / outbox 关闭残留重复窗口；persona.checkout / proxy.gb 计量；客户 invoice / quota enforcement。
