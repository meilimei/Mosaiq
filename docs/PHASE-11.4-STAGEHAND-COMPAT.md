# Phase 11.4 — Stagehand SDK 兼容（Browserbase API mirror）

> **目标**：Stagehand "hello world" 跑在 Mosaiq Cloud 上，**唯一改动**是 `baseURL` 指向我们。PRD §1.1c / §2.2 把这条路称为 **Cloud GTM 核心钩子**：让 Browserbase 现存客户改一行就能迁。

**前置完成**：phase 11.3a（machine pool）✓、phase 11.3 admin tooling ✓、prod deploy 稳定（v0.11.3-prod-deploy）✓。

---

## 0. TL;DR

| 维度 | 决策 |
|---|---|
| 兼容策略 | **Native superset**——同一个 `/v1/sessions` 路由，response 同时含 BB 兼容字段 + 我们的 native 字段；auth 同时接受 `X-BB-API-Key` 和 `Authorization: Bearer`。 |
| 客户端切换 | `baseURL: 'https://mosaiq-cloud-runtime.fly.dev'` + `apiKey: <mosaiq-api-key>` —— 真·一行改动 |
| Stagehand 工作机制 | 通过原 `@browserbasehq/sdk`，无需 fork（`bb.sessions.create({})` → 读 `session.connectUrl` → `chromium.connectOverCDP(connectUrl)`） |
| 实现工作量 | 4 commits, 2-3 天 |
| Phase 11.4a 范围 | 创建 session（POST）+ 查询 session（GET）+ 关闭 session（DELETE）+ WS connect。三个最 hot 的 endpoint。 |
| 不在 11.4a 范围 | Contexts API / Recording / Debug URL / Downloads / Search / Fetch / Functions / Stagehand 直发 act/observe 模式（Cloud-side AI——是 Browserbase 自家产品而非 SDK 协议） |

---

## 1. 问题陈述：为什么是现在做这个

Phase 11.3a prod 灰度结束后实测 25h **0 traffic**：

```
mm_acquire_duration_seconds_count = 0
machine_pool_hits_total = 0
```

§11.3a §11.2 的剩余 decision gates（`hit_rate ≥ 80%`, `≥50 sessions/day`, `≥100 sessions/day`）**全是 traffic-based**——再多观测一周仍是 0/0。**瓶颈已从 infra 迁到 demand**。

PRD §1.1c 把 Stagehand SDK 兼容列为 GTM 核心钩子（原文）：

> **API 兼容**：与 Stagehand SDK 100% 兼容（Browserbase 只兼容自己），让 Browserbase 客户**改一行 endpoint** 就能迁移。

**Stagehand 装机量**（Browserbase 自家数据，docs.stagehand.dev）：

- 22k+ GitHub stars
- 700k+ weekly NPM downloads（npmjs.com/package/@browserbasehq/stagehand）
- 主流 LLM agent 框架已集成（OpenAI Operator、browser-use、Vercel AI SDK 等）

每接住 1% 的 Stagehand 用户 ≈ 7000 weekly active developers——这才是 pool sizing decision gates 能 fire 的 demand 量级。

---

## 2. Browserbase API 实测契约

**来源**：https://docs.browserbase.com/reference/api/create-a-session（2026-05-26 抓取）+ https://docs.browserbase.com/fundamentals/create-browser-session

### 2.1 Auth

```
X-BB-API-Key: bb_live_...
```

大小写不敏感（文档里 `X-BB-API-Key` 和 `x-bb-api-key` 都出现）。**不**走 `Authorization: Bearer` —— 这是 BB 历史决策，与我们的 native auth 不同。

### 2.2 POST /v1/sessions request body

全部 optional（`--data '{}'` 是合法请求）。SDK 文档里出现的字段：

```json
{
  "projectId": "...",         // BB SDK 会从 API key 推导，request 里也可显式传
  "region": "us-west-2",      // 我们当前只 iad，phase 11.5 多 region
  "viewport": {"width": 1920, "height": 1080},
  "keepAlive": false,         // BB 默认 false（30 分钟 TTL）
  "recording": true,          // BB 默认 true，我们暂不支持
  "logging": true,
  "browserSettings": {
    "fingerprint": {...},     // BB 自己的 fingerprint schema（与我们的 Persona 不一致）
    "context": {"id": "..."}, // BB Contexts API
    "extensionId": "..."
  },
  "proxies": [{...}],         // BYOP 或 BB 内置代理
  "userMetadata": {}          // 透传给 GET 响应
}
```

### 2.3 POST /v1/sessions response body（HTTP 201）

**这是我们必须 mirror 的形状**：

```json
{
  "id": "<string>",
  "createdAt": "2023-11-07T05:31:56Z",
  "updatedAt": "2023-11-07T05:31:56Z",
  "projectId": "<string>",
  "startedAt": "2023-11-07T05:31:56Z",
  "expiresAt": "2023-11-07T05:31:56Z",
  "endedAt": "2023-11-07T05:31:56Z",
  "proxyBytes": 123,
  "keepAlive": true,
  "connectUrl": "<string>",
  "seleniumRemoteUrl": "<string>",
  "signingKey": "<string>",
  "contextId": "<string>",
  "userMetadata": {}
}
```

### 2.4 Stagehand SDK 调用模式（最小实测样本）

```js
import { Browserbase } from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
const session = await bb.sessions.create({});
const browser = await chromium.connectOverCDP(session.connectUrl);
const page = (await browser.contexts())[0].pages()[0];
await page.goto("https://example.com");
```

**关键观察**：Stagehand 只读 `session.connectUrl`，不依赖其他响应字段。这是我们的 **MVP 兼容目标**。

---

## 3. 兼容策略：Native Superset

### 3.1 候选方案对比

| 方案 | 客户端改动 | 服务端复杂度 | 缺点 | 决策 |
|---|---|---|---|---|
| **A. Native superset**：单一 `/v1/sessions`，response 同时含 BB + native 字段；auth 同时接受 BB / Bearer header | 仅 `baseURL` + `apiKey` | 低（一处 schema 扩展 + 一处 auth 解析） | 响应 payload 略大（~2KB → ~3KB） | **✓ 选这个** |
| B. Path alias `/bb/v1/sessions` | `baseURL: '...fly.dev/bb'`（非常规后缀） | 中（双路由维护） | 客户端要知道有 `/bb` 前缀；BB SDK 默认追加 `/v1/sessions` 不工作 | ✗ |
| C. Header `X-API-Compat: browserbase` | 客户端要主动加 header | 中 | BB SDK 不会自然发这个 header；得自动检测 BB header 推导 | ✗（C 演化成 A 的子集） |
| D. Sub-domain `api.bb-mosaiq.fly.dev` | DNS + 多 cert | 高 | 增加运维面，看不到收益 | ✗ |

### 3.2 Native superset 详细机制

**单一 endpoint** `POST /v1/sessions`：

1. **Auth**：middleware 优先解析 `X-BB-API-Key`，回落到 `Authorization: Bearer`。两个都能识别成同一个 Mosaiq API key。
   - 实测影响：Stagehand 用户的 `BROWSERBASE_API_KEY` 必须是**我们颁发的** Mosaiq API key（`msq_sk_...`）。我们不验签 BB 自家 key，也不跟 BB 共享 keyspace——customer **必须** rotate 一次 key 到 Mosaiq。这是"改一行"原则的边界。
2. **Request body**：parse 一份 union schema（BB 字段优先，回落到 native 字段；不允许同时传两套）。MVP 只 honor 通用字段（viewport, userMetadata），其他 BB 特性（recording, proxies, contexts）记下 warning + 忽略。
3. **Response body**：扩展 `shapeSession()` 同时输出 BB 兼容字段（camelCase + RFC3339 dates + 14 个 BB 字段）和现有 native 字段（snake_case + 我们的 8 个字段）。后续考虑 `?shape=bb|native|both` 让 native caller 可以瘦身。
4. **WS connect**：`connectUrl` 直接 = 现有 `cdp_url`（已经是 wss://...fly.dev/v1/sessions/:id/cdp）。

### 3.3 为什么 native superset 而不是把 native 字段去掉

我们的 native shape 已经在用（prod-smoke-cloud.mjs、cli、未来桌面 app），**破坏式去 snake_case 字段** = 一个我们自己的 breaking change。superset 的 ~1KB payload 增量在 Mosaiq Cloud 单 session lifetime 里完全可忽略（CDP traffic 一个 session 几 MB）。

---

## 4. 字段映射矩阵

`shapeSession(row, persona, stealth)` 输出扩展后：

| BB 字段 | 类型 | 来源（Mosaiq）| 备注 |
|---|---|---|---|
| `id` | string | `row.id`（`ses_...`） | 直接复用，BB 自家也是 opaque ID |
| `createdAt` | RFC3339 | `row.openedAt` → `.toISOString()` | 现有 native `created_at` 同源 |
| `updatedAt` | RFC3339 | `row.lastSeenAt` → `.toISOString()` | 现有 native `last_seen_at` 同源；如果 null 用 `openedAt` |
| `projectId` | string | `row.projectId`（`proj_...`） | 现有 native `project_id` 同源 |
| `startedAt` | RFC3339 | 同 `createdAt`（我们没有"创建 vs 启动"两段计时） | BB 内部 startedAt 是 chromium ready；我们在 acquire 完成后才返回，所以等价 |
| `expiresAt` | RFC3339 | `row.expiresAt` → `.toISOString()` | 直接 |
| `endedAt` | RFC3339\|null | `row.closedAt` → `.toISOString()` 或 null | 创建时一律 null |
| `proxyBytes` | int | `0`（stub） | 我们暂不计 proxy 流量；M9 加 |
| `keepAlive` | bool | `false`（stub） | 我们的 TTL 已经支持长 session（最长 SESSION_TTL_MAX_SECONDS），但还没有 BB 的 `keepAlive=true` 语义（断 WS 后保活）。phase 11.5 加 |
| `connectUrl` | string | 现有 `publicCdpUrl(sessionId)` | **核心字段**——Stagehand 唯一依赖 |
| `seleniumRemoteUrl` | string\|null | `null` | 我们不开 Selenium WebDriver，仅 CDP/Playwright |
| `signingKey` | string\|null | `null` | BB 用来 short-lived 签 connectUrl token；我们用 session id + auth middleware 替代（同等安全） |
| `contextId` | string\|null | `null` | Phase 11.6 Contexts API 才填 |
| `userMetadata` | object | `row.userMetadata`（新增 column）/ `{}` | DB schema 要加一个 jsonb column |

---

## 5. 实施计划

按 4 个 commit 落地，每个绿测后再下一个。

### Commit 1: `feat(cloud-runtime): accept X-BB-API-Key header alongside Authorization Bearer`

- `apps/cloud-runtime/src/middleware/auth.ts`（或现有 auth middleware 文件）：先查 `x-bb-api-key`，再查 `authorization`。两个都没有 → 401。两个都有且不一致 → 400 `auth.dual_header`（避免静默选 BB 优先）。
- 测试：
  - 仅 `X-BB-API-Key` ✓
  - 仅 `Authorization: Bearer` ✓
  - 两个都有且 match ✓
  - 两个都有但不一致 → 400
  - 大小写不敏感（`x-bb-api-key`, `X-BB-API-Key` 都接受）

**验收**：现有所有 auth 测试照常绿；新增 4-5 个 BB-header 测试。

### Commit 2: `feat(cloud-runtime): /v1/sessions response includes Browserbase-compat fields`

- `apps/cloud-runtime/src/routes/sessions.ts`：扩展 `shapeSession()` 输出 §4 字段映射的全部 14 个 BB 字段（与现有 native snake_case 字段并存）。
- DB schema：`sessionsTable` 加 `userMetadata jsonb DEFAULT '{}'` column；migration 文件。
- 测试：
  - POST `/v1/sessions` response 同时含 `id` + `connectUrl` + `created_at` + `cdp_url`（双 shape）
  - `connectUrl` 是合法 wss URL，与 `cdp_url` 同值
  - `userMetadata` 透传：传 `{"foo":"bar"}` → response 同款

**验收**：149 个现有单测全绿；新增 ~6 个 superset shape 测试。

### Commit 3: `feat(cloud-runtime): accept Browserbase-shape request body in POST /v1/sessions`

- 扩展 `CreateSessionSchema` 为 union：现有 native shape ∪ BB shape。
- 字段映射：
  - `viewport.{width,height}` → 现有 `viewport`
  - `userMetadata` → 新 column
  - `keepAlive` → ignored（warn log）
  - `recording` → ignored（warn log）
  - `proxies` → ignored（warn log）
  - `browserSettings.fingerprint` → ignored（warn log；和我们的 Persona 不兼容）
  - **fallback (deferred to commit 4)**：完全不传 persona 时，commit 3 先返回 422 `request.invalid` + `detail.field='persona'` 并 message 引导调用方升级或显式传 persona；commit 4 落地 default persona pool seed 后，此路径自动转 201。
- 测试：
  - BB-shape `{projectId, persona:{inline}, browserSettings:{viewport}}` → 应用 viewport（同形）
  - BB-shape 同时给 native viewport 与 browserSettings.viewport → native 优先
  - BB-shape 未支持字段（keepAlive/recording/proxies/extensionId/region/timezone/browserSettings.fingerprint/blockAds）→ 201 + `unsupportedFields[]` 包含全部
  - native-only 请求 → 响应**不带** unsupportedFields key
  - project_id ↔ projectId 同存且不一致 → 422 request.invalid
  - 完全省略 project id → 用 auth.projectId
  - persona 完全省略 → 422 request.invalid（commit 4 之前）
  - userMetadata round-trip：POST 设值 → POST 响应回显 → GET 仍可见

**验收**（已落地）：167 现有 + 9 新增 = **176/176 测试全绿**。

### Commit 4a: `feat(cloud-runtime): default persona pool seed for parameter-less BB-shape sessions` — LANDED

- `apps/cloud-runtime/src/seed/default-personas.ts`：4 个 default persona 调用 `@mosaiq/persona-schema/templates` 上现有的 4 个生产级别模板（win11/win10/macos-sonoma/ubuntu-2204 都是 Chrome+US East）。每个项钉 hardcoded `masterSeed` 以保证跨部署 byte-stable。
  - 原计创 5 个，调查发现 TEMPLATE_CATALOG 仅 4 项；实事求是地复用这 4 个，不伪造未经考验的第 5 个。Operator 随时可通过 admin CLI 加更多。
- `apps/cloud-runtime/src/db/bootstrap.ts`：新增 `ensureDefaultPersonas()`，独立于 `ensureSchema()`（让现有不需要 seed 的测试不受影响）。启动时 if 没有 source='seed' AND project_id IS NULL 行 → 一次性 insert 4 行。`src/index.ts` 启动顺序：ensureSchema → ensureDefaultPersonas → seedDevAuth。
- `apps/cloud-runtime/src/routes/sessions.ts`：处理器里 `req.persona ?? { id: pickDefaultPersonaDbId() }` —— 随机抽一个 default id 后纳入现有 id-lookup 通道。Operator 误删 seed 时，404 会带上清晰的 `pers_default_xxx` id 提示重 seed。
- 测试（附 6 个新增 + 1 项重写）：
  - empty body `{}` → 201 + persona_id 始于 `pers_default_` + metadata.tags 含 'default'/'seed'
  - 仅带 projectId 无 persona → 201 + default
  - personas 表里息置 4 行 seed-source，id 列表严格匹配
  - `ensureDefaultPersonas` 幂等：调二次仍是 4 行
  - 连跑 8 次：persona_id 始终在 4-id 允许集内
  - default persona 能被 native `persona: {id}` 显式引用（互通）
  - persona 省略且 default 未 seed → 404 带 default id（原 422 被重写）

**验收**（已落地）：176 + 6 = **182/182 测试全绿**。`tsc --noEmit` 位乘 0。

### Commit 4b: `feat(cloud-runtime): stagehand-compat-smoke.mjs — real Browserbase SDK smoke test` — CODE LANDED, PROD VERIFY PENDING

- `scripts/stagehand-compat-smoke.mjs`：使用真实 `@browserbasehq/sdk` + `playwright-core` 的 `chromium.connectOverCDP`。三个场景递增覆盖：
  - **s1_empty**：`bb.sessions.create({})` —— 验证 X-BB-API-Key 鉴权 + 默认 persona seed + BB response superset + connectUrl 接通。
  - **s2_userMetadata**：`bb.sessions.create({ userMetadata })` —— 验证 BB request body 接受 + userMetadata 落库+回显。
  - **s3_viewport**：`bb.sessions.create({ browserSettings: { viewport } })` —— 验证 browserSettings.viewport 被 honor（不被丢到 unsupportedFields）。
  - 每个场景都走完 `goto https://example.com` → 验证 title === "Example Domain" → `browser.close()` → best-effort DELETE 释放 fly machine。
- `package.json`：新增 root devDeps `@browserbasehq/sdk ^2.6.0` + `playwright-core 1.59.1`（与 repo 现有 pin 一致，复用同一 patch）；npm 别名 `smoke:stagehand-compat`。
- 本地验证：`biome check` 绿 + `node --check` 绿。实跑需先 `pnpm install` 装上新 devDeps，然后：
  ```pwsh
  $env:MOSAIQ_BASE_URL = 'https://mosaiq-cloud-runtime.fly.dev'
  $env:MOSAIQ_API_KEY  = 'msq_sk_live_...'
  pnpm smoke:stagehand-compat
  ```
- 文档：`docs/PHASE-11.4-STAGEHAND-COMPAT.md` §6 实测结果填表。

**验收**：smoke 在 prod 跑通，5 次连续运行全 pass，每次 acquire latency < 60s（pool warm）。

---

## 6. 验证 / 实测结果（待填）

### 6.1 hello world 烟测

```bash
$env:MOSAIQ_API_KEY = "msq_sk_..."
$env:MOSAIQ_BASE_URL = "https://mosaiq-cloud-runtime.fly.dev"
node scripts/stagehand-compat-smoke.mjs
```

| 跑次 | 时间 | acquire ms | 结果 | 备注 |
|---|---|---|---|---|
| #1 | TBD | — | — | — |
| #2 | TBD | — | — | — |
| #3 | TBD | — | — | — |
| #4 | TBD | — | — | — |
| #5 | TBD | — | — | — |

### 6.2 与原 Browserbase 行为 diff

| 行为 | Browserbase | Mosaiq Phase 11.4a |
|---|---|---|
| `bb.sessions.create({})` 返回 connectUrl | ✓ | ✓ |
| `chromium.connectOverCDP(connectUrl)` 接通 | ✓ | ✓ |
| 默认 stealth fingerprint | BB 自己的 fingerprint stack | Mosaiq Persona（5 个 default seed） |
| `keepAlive: true` 长 session | ✓ | ⚠️ phase 11.5（暂时 30min TTL 上限） |
| `recording: true` | ✓ | ❌ 11.4a 不支持 |
| Stagehand `act()` / `observe()` / `extract()` | ✓（依赖 LLM 调度，与 SDK 无关） | ✓（这部分是 Stagehand 本地模型调用，不走 BB 服务端） |
| Contexts API（cookie/auth 持久化）| ✓ | ❌ phase 11.6 |

---

## 7. 不在 phase 11.4a scope 内

- ❌ `POST /v1/contexts` 系列（cookie persistence）—— phase 11.6
- ❌ `recording: true`（CDP trace 录制 + replay）—— M9 milestone
- ❌ `debug` URL（实时 viewer/screenshot 流）—— M9
- ❌ `keepAlive: true` 长 session 保活—— phase 11.5
- ❌ Multi-region —— phase 11.5（PRD M11 之前）
- ❌ Browserbase Search / Fetch / Functions API —— Browserbase 专属功能，非 Stagehand 依赖
- ❌ 我们这边的 fingerprint schema → BB `browserSettings.fingerprint` 双向翻译 —— BB 的 fingerprint API 不是 Stagehand 必需，跳过
- ❌ Selenium WebDriver remote endpoint（`seleniumRemoteUrl`）—— 我们 CDP-only

---

## 8. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| BB 突然改 schema 加新必填字段 | 低 | 中（Stagehand 用户报错） | 我们的 superset 设计天然向后兼容；如果 BB 加字段，我们补上即可，不破坏现有 caller |
| Stagehand SDK 内部除 `connectUrl` 外暗中读其他字段 | 中 | 中 | smoke test #4-5 跑全 stagehand-eval suite（不只是 hello world）扫雷；smoke 失败时 `console.dir(session)` 打印完整 response 对照 |
| BB SDK 把 `apiKey` 拼到非标准 header（如 `Bb-Api-Key` 而非 `X-BB-API-Key`）| 低 | 高（auth 全失败）| Commit 1 加多 header 别名识别；用真 BB SDK 跑 smoke 之前先 `curl -v` 抓一次 SDK 实际发的 header |
| 我们的 `default persona seed` 在某些 anti-bot 站点表现差 | 中 | 中（Stagehand 用户体验差）| 5 个 default persona 限定为常见桌面组合；warn 客户用真 Persona ID 获得最佳效果（差异化卖点） |
| Mosaiq API key 与 BB API key 命名冲突（用户从 BB 复制 key 直接用）| 高 | 低（401 一目了然）| 错误信息明确："Mosaiq API key starts with `msq_sk_`. If you copied a Browserbase key (`bb_live_...`), see migration guide" |

---

## 9. 与 PRD 时间线对齐

PRD §7.2 时间线：

- **M5 Cloud Alpha**：✓ 已落地（phases 11.0 → 11.3）
- **M6 Cloud Stagehand 兼容**：⬅️ **本 phase 11.4a**
- **M7 Persona Pool Service**：phase 11.4 Commit 4 落最小 default seed（5 个），完整版（5000+ + region/device filter API + Detection Lab capture pipeline）留 phase 11.5 / 11.6
- **M9 Live View / Recording / Replay**：phase 11.7 之后
- **M11 Public Beta**：取决于 M6 + M7 + 公开注册流程
- **M12 Cloud Pro / Scale 付费**：取决于 Stripe Metered + 配额管理

phase 11.4a 是 **从 M5 跨到 M6 的关键一跨**——也是从 "infra 跑通了" 到 "客户能用" 的语义跨越。

---

## 10. 决策追加（待你确认）

| # | 问题 | 选项 | 默认建议 |
|---|---|---|---|
| 1 | 如果客户传 BB-shape 不支持字段（recording/proxies），返回 400 还是 warn? | (a) 400 严格 (b) warn 忽略 (c) 200 + response 含 `unsupportedFields: [...]` 提示 | **(c)**——Stagehand 用户大概率也不在意 recording，硬 400 阻断迁移；c 是最佳折中 |
| 2 | `signingKey` 字段，我们返回 `null` 还是 `""`? | null / 空串 / 假 key | **null**——BB SDK 不会用我们的 signingKey 因为 connectUrl 已经是绝对 URL；null 比假 key 更诚实 |
| 3 | Default persona seed 写在 migration 里还是 bootstrap 里? | (a) 一次性 SQL migration 插入 (b) bootstrap 时 `if not exists` 插入 | **(b)**——bootstrap 适合"应该总是存在的种子数据"语义；migration 适合"一次性数据迁移"语义 |
| 4 | `userMetadata` column 类型 | text(JSON.stringify) / jsonb（postgres）/ blob | **jsonb**（postgres）—— 但 SQLite 也接受 jsonb-as-text 透明 |

---

## 11. 验收标准

### 11.1 代码侧

- [x] Commit 1 落地：dual auth header（X-BB-API-Key + Authorization Bearer），+5 测试 → 162/162
- [x] Commit 2 落地：response superset（14 BB-compat 字段 + userMetadata 列），+5 测试 → 167/167
- [x] Commit 3 落地：BB-shape request body（projectId/userMetadata/browserSettings.viewport honor + 7 字段 warn-and-ignore），+9 测试 → 176/176
- [x] Commit 4a 落地：default persona seed（4 personas）+ ensureDefaultPersonas 启动调用 + handler fallback，+6 测试（1 重写） → 182/182
- [x] Commit 4b 落地（code）：scripts/stagehand-compat-smoke.mjs + root devDeps `@browserbasehq/sdk ^2.6.0` & `playwright-core 1.59.1`。biome + node --check 绿。Prod 5 跑次验证仍留在 §11.2。

### 11.2 prod 验证

- [ ] `scripts/stagehand-compat-smoke.mjs` 5 次连跑全 pass
- [ ] 同 5 次跑出的 acquire 进入 `mm_acquire_duration_seconds_count`，让 phase 11.3a §11.3 表 `pool=1 @ post-stagehand` 行有真实数据
- [ ] Stagehand `eval/` 仓库其中 1 个 baseline test 跑通（待具体选 case）

### 11.3 文档

- [ ] 本 doc §6.1 实测结果填表
- [ ] `docs/PHASE-11.3-MACHINE-POOL.md` §11.2 加补充："phase 11.4a 落地后重启 24h pool=1 观测"
- [ ] `README.md` 顶部加 Stagehand quickstart code block（PRD §1.1c 卖点的对外展示）

---

## 附录 A — 参考链接

- Browserbase Create a Session API: https://docs.browserbase.com/reference/api/create-a-session
- Browserbase Session API overview: https://docs.browserbase.com/reference/api/overview
- Stagehand SDK GitHub: https://github.com/browserbase/stagehand
- Stagehand docs: https://docs.stagehand.dev/
- `@browserbasehq/sdk` NPM: https://www.npmjs.com/package/@browserbasehq/sdk
- PRD §1.1c "Mosaiq Cloud vs Browserbase 差异化": `docs/PRD.md`
- ARCH §2.2 "Stagehand SDK 兼容（关键差异化）": `docs/CLOUD-RUNTIME-ARCH.md`
