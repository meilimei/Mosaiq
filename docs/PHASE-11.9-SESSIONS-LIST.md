# Phase 11.9 — `GET /v1/sessions` 列表端点（Browserbase `sessions.list()` 兼容）

> **状态**：设计 + 实现（2026-05-29）。承接 11.4 的 Browserbase-compat 主线：补齐 BB SDK 最常用的 list 调用。

> **一句话**：今天控制平面只有 `POST /v1/sessions`、`GET /v1/sessions/:id`、`DELETE /v1/sessions/:id` —— **没有 list 端点**。Browserbase SDK 的 `bb.sessions.list({ status, q })` 打到 `GET /v1/sessions` 会直接命中 `/:id` 之外的空路由返回 404，是 BB 兼容面里一个明显的缺口。本 phase 补上 project 隔离的 list，支持 `status` / `q` / `limit` 过滤，复用 `shapeSession` 单一来源。纯后端、可完整单测、零外部依赖。

---

## 1. 决策摘要

| 维度 | 决策 |
|---|---|
| 路由 | `GET /v1/sessions`（mount 在 `authed.route('/sessions', sessionsRoute)` 下，即 `sessionsRoute.get('/')`） |
| Scope | 严格 `WHERE project_id = auth.projectId`（与 `GET /:id` / `DELETE /:id` 同款 project 隔离，**绝不**跨租户泄漏） |
| 响应形状 | **裸 JSON 数组** `[ {...}, {...} ]`（BB SDK `sessions.list()` 期望 array；与原生 `{ items }` 列表约定**有意分歧**，因为本端点存在的唯一目的就是 BB 兼容，没有原生消费者） |
| 元素形状 | 复用 `shapeSession(row, null, stealth)`，与 `GET /:id` 逐字段一致（native snake_case + BB camelCase superset，persona=null） |
| `status` 过滤 | 可选。同时接受 BB 大写枚举（`RUNNING`/`COMPLETED`/`ERROR`/`TIMED_OUT`）与原生小写（`live`/`closed`/`requested`/`errored`），大小写不敏感。无法识别 → 422 `request.invalid` |
| `q` 过滤 | 可选。`key:value` → 匹配 `userMetadata[key] === value`（字符串相等）；无冒号 → 对 `userMetadata` 原始 JSON 文本做子串匹配。在应用层 filter（避免 sqlite JSON 函数移植性问题） |
| `limit` 分页 | 可选，默认 100，范围 `[1, 1000]`。越界 → 422 `request.invalid` |
| 排序 | `opened_at DESC`（最新优先，命中 `sessions_project_idx (project_id, opened_at)`） |
| Rate limit | `rateLimitTier('read')`（与 `GET /:id` 同档） |
| Non-goal | 游标 / offset 分页、BB `q` 全语法（`user_metadata['k']:'v'` 引号嵌套）、跨 project admin list、按 `opened_at` 范围过滤。这些超出 alpha 需求 |

---

## 2. 背景：现状缺口

`apps/cloud-runtime/src/routes/sessions.ts` 当前只注册三个 handler：

```
POST   /v1/sessions          L260
GET    /v1/sessions/:id      L701
DELETE /v1/sessions/:id      L730
```

Browserbase SDK 的 `sessions.list()` 是 dashboard / 运维脚本 / "列出我所有在跑的 session" 这类场景的高频调用。缺它意味着：

1. 用 BB SDK 切到 Mosaiq 的客户，`bb.sessions.list()` 直接 404 —— 一行 baseURL 切换的承诺出现裂缝。
2. 没有任何 API 途径枚举一个 project 的 session（只能逐个 `GET /:id`，但拿不到 id 列表本身是鸡生蛋问题）。

`shapeSession`（L203）已是 POST 与 GET /:id 的单一形状来源，list 直接复用即可，零形状漂移风险。

---

## 3. 路由实现

注册在 `GET /:id` **之前**（Hono 里 `/` 与 `/:id` 不冲突，但放一起便于阅读）：

```ts
const ListSessionsQuerySchema = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

// BB 大写枚举 → 原生 status 的映射。原生小写直接放行。
const BB_STATUS_ALIASES: Record<string, string> = {
  RUNNING: 'live',
  COMPLETED: 'closed',
  ERROR: 'errored',
  TIMED_OUT: 'closed',
};
const NATIVE_STATUSES = new Set(['requested', 'live', 'closed', 'errored']);

sessionsRoute.get('/', rateLimitTier('read'), async (c) => {
  const auth = getAuth(c);
  const parsed = ListSessionsQuerySchema.safeParse({
    status: c.req.query('status'),
    q: c.req.query('q'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    throw new ApiError('request.invalid', 'invalid list-sessions query', {
      issues: parsed.error.issues,
    });
  }
  const { status, q, limit } = parsed.data;

  // status → 原生值（或保持原生小写）。无法识别 → 400。
  let nativeStatus: string | undefined;
  if (status !== undefined) {
    const upper = status.toUpperCase();
    const lower = status.toLowerCase();
    if (BB_STATUS_ALIASES[upper]) nativeStatus = BB_STATUS_ALIASES[upper];
    else if (NATIVE_STATUSES.has(lower)) nativeStatus = lower;
    else throw new ApiError('request.invalid', `unknown status filter "${status}"`); // → 422
  }

  const handle = await getDb();
  const where = nativeStatus
    ? and(eq(sessionsTable.projectId, auth.projectId), eq(sessionsTable.status, nativeStatus))
    : eq(sessionsTable.projectId, auth.projectId);

  const rows = await handle.drizzle
    .select()
    .from(sessionsTable)
    .where(where)
    .orderBy(desc(sessionsTable.openedAt));

  const filtered = q ? rows.filter((r) => matchUserMetadata(r.userMetadata, q)) : rows;
  const limited = filtered.slice(0, limit ?? 100);

  return c.json(limited.map((row) => shapeSession(row, null, stealthFromRow(row))));
});
```

`matchUserMetadata(raw, q)`：解析 `q`，含冒号取首个冒号切 `key:value`，比对 `JSON.parse(raw)[key] === value`；无冒号则对 `raw` 原文做 `includes(q)`。解析失败一律不匹配（不抛）。

`stealthFromRow(row)`：把 `GET /:id`（L713-719）里 inline 的 `metadataJson` → `stealth` 解析逻辑抽成共享 helper，list 与 `GET /:id` 同时复用，保证 stealth 字段输出一致。

---

## 4. 为什么裸数组而非 `{ items }`

原生 `GET /v1/personas`、`GET /v1/contexts` 用 `{ items: [...] }` 信封。但 BB SDK 的 `sessions.list()` 反序列化期望一个**数组**，包进对象会让 SDK 直接崩。本端点没有任何原生消费者（`packages/cloud-sdk` 至今没有 `list` 方法），它存在的唯一理由就是 BB 兼容，所以选 BB 形状。文档与代码注释显式标注这一有意分歧。

---

## 5. 测试计划（`app.test.ts`）

- 空 project → `[]`
- 创建 N 个 session → list 返回 N 个，`opened_at DESC` 最新优先
- project 隔离：A 的 key 看不到 B 的 session
- 元素形状 = `GET /:id`（断言含 `connectUrl` / `signingKey` / `keepAlive` / `userMetadata` 等 BB-compat 字段）
- `status=RUNNING` 只返回 live；`status=COMPLETED` 只返回 closed（DELETE 后那条）
- `status=live`（原生小写）等价 `RUNNING`
- `status=garbage` → 422 `request.invalid`
- `q=key:value` 命中 userMetadata 匹配的 session；不匹配的被滤掉
- `limit=1` → 只回 1 条（且是最新那条）；`limit=0` / `limit=99999` → 422
- 鉴权：无 token → 401（auth 中间件已覆盖，附带断言一次）

全程保持既有 360 测试绿 + typecheck clean。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 裸数组偏离原生 `{ items }` 约定造成困惑 | 代码注释 + 本文 §4 显式说明；该端点专为 BB SDK |
| 大 project 全表扫描 | `WHERE project_id` 命中 `sessions_project_idx`；`limit` 默认 100 封顶；alpha 规模 project 行数远小于需要游标分页的量级。未来量级上来再加 cursor（Non-goal） |
| `q` 应用层过滤在 limit 之前/之后语义 | 明确：先 status(SQL) → 全取 → q(JS filter) → slice(limit)。文档化 |
| 跨租户泄漏 | `WHERE project_id = auth.projectId` 硬编码，单测专门断言隔离 |

---

## 7. 后续

已交付（同 phase 11.9）：

- `packages/cloud-sdk` 原生封装 `client.listSessions({ status?, q?, limit? })` → `SessionInfo[]`
  （沿用现有扁平方法命名 `createSession` / `getSession` / `closeSession`，而非嵌套 `.sessions` 命名空间）。
  状态过滤入参类型 `ListSessionsStatus` 同时接受原生小写与 BB 大写别名；映射与 `getSession` 共用同一套 snake_case → camelCase 规则。

留 future：

- 游标 / `offset` 分页（量级触发）
- BB `q` 全语法（`user_metadata['key']:'value'` 引号嵌套解析）
- cloud-sdk `listSessions` 的 live e2e smoke（当前为 fake-fetch 单测覆盖）
- `opened_at` / `expires_at` 范围过滤
