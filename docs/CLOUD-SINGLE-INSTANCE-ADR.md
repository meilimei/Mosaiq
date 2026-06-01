# ADR: Cloud Runtime 单实例假设与多实例解冻路径

> **状态**：Accepted（2026-06，Phase 3 夯实）  
> **背景**：`cloud-runtime` alpha 在 Fly 上以 `min_machines_running=1` 运行。以下三处状态**仅存在于进程内存**，水平扩展会在无共享存储时静默破坏正确性。

## 当前单点组件

| 组件 | 路径 | 行为 | 多实例风险 |
|---|---|---|---|
| Rate limiter | `apps/cloud-runtime/src/middleware/rate-limit.ts` | Token bucket `Map` 按 `api_key_id` | 每实例独立计数 → 限额翻倍 |
| Sticky registry | `apps/cloud-runtime/src/sticky/registry.ts` | `(projectId, stickyKey) → sessionId` | 重启失忆；多实例路由不一致 → 同 stickyKey 可能创建双 session |
| Fly machine pool | `apps/cloud-runtime/src/machine/fly-pool.ts` | In-memory pool + `#poolAlive` | 各实例各自维护 pool 视图 → cap 计算错误 |
| Database (alpha) | `apps/cloud-runtime/src/db/client.ts` | SQLite 单文件（WAL） | 多实例写同一文件 → 损坏；需 Postgres |

启动时 `cloud-runtime` 会打 **single-instance assumed** 日志（见 `apps/cloud-runtime/src/ops/single-instance-guard.ts`）。

## 解冻触发器（与 ROADMAP-90D §4 对齐）

在以下**全部**满足前，**不要**水平扩展控制平面或对外承诺 SLA：

1. 首个**付费**或明确 SLA 客户签约
2. 需要 `>1` cloud-runtime 实例（HA / 吞吐）
3. 共享存储方案评审通过（本 ADR § 解冻方案）

在此之前：Fly `min_machines_running=1`、文档标明 **alpha / 单点**。

## 解冻方案（设计稿，未实现）

### Phase B1 — Postgres + 迁移

- `DATABASE_URL=postgres://...`（`db/client.ts` 已预留 dialect 探测，当前 throw「未支持」需补 `drizzle-orm/node-postgres` 驱动）
- 引入 `drizzle-kit` migrations（替换 bootstrap `CREATE TABLE IF NOT EXISTS`）
- Session / usage / sticky 元数据全部落库

### Phase B2 — 分布式 sticky + rate-limit

**选项 A（推荐起步）**：Redis

- `sticky-registry` → `SET mosaiq:sticky:{projectId}:{stickyKey}` + TTL
- `rate-limit` → Redis token bucket（或 `INCR` + 滑动窗口）
- Bootstrap reconcile：进程启动时从 `sessions` 表重建 sticky map（消除重启失忆窗口）

**选项 B**：DB-backed

- `sticky_sessions` 表 + advisory lock；适合低 QPS，实现简单但 acquire 路径多一次 round-trip

### Phase B3 — Pool 协调

- Fly pool replenish 仅由 **一个 leader** 执行（Postgres advisory lock / Redis `SETNX mosaiq:pool-leader`）
- 或：放弃 cross-instance pool 共享，每实例 cold path only（`POOL_TARGET_SIZE=0` 回滚行为）

## 对外口径

- **现在**：Mosaiq Cloud alpha，单 region、单控制平面实例；sticky / 配额在单实例内有效
- **解冻后**：文档更新为多实例 + Postgres + 可选 Redis

## 相关文档

- [PHASE-11.5-KEEPALIVE-LONG-SESSION.md](./PHASE-11.5-KEEPALIVE-LONG-SESSION.md) — sticky 语义
- [PHASE-11.3-MACHINE-POOL.md](./PHASE-11.3-MACHINE-POOL.md) — pool 设计
- [ROADMAP-90D.md](./ROADMAP-90D.md) — Phase 3 夯实与 anti-scope
