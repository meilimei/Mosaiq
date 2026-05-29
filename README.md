# Mosaiq

> **Browser Infrastructure for the Agentic AI Economy**。基于 Chromium fork 的反指纹内核，对外提供桌面浏览器（Desktop）+ 云端浏览器服务（Cloud Runtime）双引擎产品，覆盖跨境电商 / 自动化 / AI Agent 全部用户场景。

> ⚠️ **代号 Mosaiq**：最终品牌名待定。

---

## 🚀 想立即跑起来？

**v0.10.0 已发布**（2026-05-21）：v0.9 的桌面 + CLI + Detection Lab 全套能力首次**公开到 npm**——`npm i -g @mosaiq/cli` / `npm i @mosaiq/sdk` 直接用。SDK 通过 `patch-package` postinstall 自动应用 `rebrowser-patches` 给 `playwright-core@1.59.1`（关掉 `Runtime.enable` 自动暴露 execution context 这个最常见的 Playwright 检测向量）。版本管理切换为 [changesets](https://github.com/changesets/changesets) 自动化，三个发包包（persona-schema / sdk / cli）lock-step 同进同退；desktop 仍保持 `private`，不上 npm。

```bash
# 最短路径
npm i -g @mosaiq/cli
npx playwright install chromium
mosaiq personas templates list   # 看 4 个 OS 模板
```

→ **[CHANGELOG.md](./CHANGELOG.md)** — v0.1.0 → v0.10.0 完整变更（最近：Phase 10.1-10.5 npm 公开发行 + patch-package + changesets；Phase 10.6-10.9 Detection Lab CI gate + sticky PR comment + 每周 baseline 自动 refresh）
→ **[QUICKSTART.md](./QUICKSTART.md)** — 5 分钟从 `npm i` 到第一次自检 + Detection Lab + CLI（含 monorepo 开发者路径）
→ **[docs/RELEASING.md](./docs/RELEASING.md)** — maintainer release runbook：手工首发 v0.10.0 / 后续 changesets 自动化 / Detection Lab baseline bootstrap / 回滚
→ **[docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md](./docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md)** — v0.10 双轨规划（Track A npm 发行 + Track B Detection Lab CI gate 全部代码就绪；maintainer 侧仍需走 RELEASING.md 完成 npm publish + baseline bootstrap）
→ **[docs/V0.8-DETECTION-LAB.md](./docs/V0.8-DETECTION-LAB.md)** — Detection Lab 完整 product-level 设计稿（v0.8 落地、v0.9 polish）
→ **[docs/HUMANIZE-DESIGN.md](./docs/HUMANIZE-DESIGN.md)** — humanize 引擎设计稿（v0.2 起持续维护）

---

## ☁️ 想用云端 Browser API（Browserbase / Stagehand 兼容）？

**Mosaiq Cloud Runtime alpha 已上线**（2026-05-27 prod 验证 / fly.io iad / image `01KSK9NYJKX99Z6KQHS55GG57F`）。Phase 11.4a 着取与 Browserbase API 同型同垍：同时接受 `X-BB-API-Key` 与 `Authorization: Bearer`、`POST /v1/sessions` 同时说 BB 形状语句与原生 native 形状、response superset 返 14 个 BB-compat 字段 + 8 个 native 字段。原 `@browserbasehq/sdk` + `playwright-core` 不需改代码，**快手只需换一个 baseURL**：

```js
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';

const bb = new Browserbase({
  apiKey: process.env.MOSAIQ_API_KEY,                   // msq_sk_live_...
  baseURL: 'https://mosaiq-cloud-runtime.fly.dev',      // ← 唯一改动
});

const session = await bb.sessions.create({});          // 默认 persona seed
const browser = await chromium.connectOverCDP(session.connectUrl);
const page = await browser.newPage();
await page.goto('https://example.com');
console.log(await page.title());                       // → "Example Domain"
await browser.close();
```

验证路径：`scripts/stagehand-compat-smoke.mjs`。5 跑次 × 3 场景（空 body / userMetadata / browserSettings.viewport）= 15/15 sessions all-pass，mean acquire 35.5s / mean connect 6.3s / 0 retry。

**长会话 / sticky pod**（phase 11.5 起）：`{ keepAlive: true, userMetadata: { stickyKey: "..." } }` —— WS 断开 pod 不销毁、`--user-data-dir` 保留、TTL ceiling 24h、配额 5 keepAlive/project；同 stickyKey 二次创建 409 含 `connectUrl` 让客户端一步 rejoin。LaunchAI Reddit 类长会话依赖此通路。

**用量计费**（phase 11.7a 起）：session 关闭按 billable browser-minutes（`ceil(时长/60)`，最小 1）落 `usage_events`。`GET /v1/usage?from=&to=`（默认当前自然月）返回 `{ totals: { "session.minute": N }, estimated_cost_usd }`（单价 `$0.06/min`）。后台 usage-report job 周期把未上报用量推给可注入的 `MeterReporter`（11.7a 默认 noop；真 Stripe Metered 推送留 11.7b）。

**配额与限额强制**（phase 11.8 起）：在 pod 分配前拦截并阻断超额请求以防止滥用并控制 Fly 运营成本。(1) 并发活跃 session 上限 `SESSIONS_PER_PROJECT_MAX`（默认 50，设为 0 作为紧急 kill switch 阻断该 project 所有新请求，返回 429 + Retry-After: 60）；(2) 月度 browser-minutes 软上限 `MINUTES_PER_PROJECT_PER_MONTH_MAX`（默认 0 = 关闭，>0 触发月度额度拦截并返回 402 Payment Required）。

**Session 列表**（phase 11.9 起）：`GET /v1/sessions` 补齐 Browserbase `bb.sessions.list()` 兼容——project 隔离、`opened_at` 倒序，支持 `status`（同时接受 BB 大写 `RUNNING`/`COMPLETED`/`ERROR`/`TIMED_OUT` 与原生 `live`/`closed`）、`q`（按 `userMetadata` 过滤）、`limit`（默认 100）。返回 BB SDK 期望的裸数组，元素形状与 `GET /v1/sessions/:id` 一致。

→ **[docs/PHASE-11.9-SESSIONS-LIST.md](./docs/PHASE-11.9-SESSIONS-LIST.md)** — `GET /v1/sessions` 列表端点（Browserbase sessions.list() 兼容）设计
→ **[docs/PHASE-11.8-QUOTA-ENFORCEMENT.md](./docs/PHASE-11.8-QUOTA-ENFORCEMENT.md)** — per-project 并发 sessions + 自然月 browser-minutes 配额强制设计
→ **[docs/PHASE-11.7-USAGE-METERING.md](./docs/PHASE-11.7-USAGE-METERING.md)** — browser-minutes 计费埋点 + GET /v1/usage + MeterReporter 抽象 + report job（11.7a 代码完成，真 Stripe 留 11.7b）
→ **[docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md](./docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md)** — Browserbase Contexts API（跨 session 持久化加密 user-data-dir：cookies / localStorage / IndexedDB）
→ **[docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md](./docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md)** — keepAlive 长会话 + sticky pod 路由设计（pod lifecycle / sticky registry / quota / metrics labels）
→ **[docs/PHASE-11.4-STAGEHAND-COMPAT.md](./docs/PHASE-11.4-STAGEHAND-COMPAT.md)** — Stagehand-compat 设计稿 + §6.1 实测表 + commit 4c per-session signing key 根因拆解
→ **[docs/PHASE-11.3-MACHINE-POOL.md](./docs/PHASE-11.3-MACHINE-POOL.md)** — acquire 底层的 fly machine pool 设计 + Prometheus 应用仪表板上下文
→ **[docs/CLOUD-RUNTIME-ARCH.md](./docs/CLOUD-RUNTIME-ARCH.md)** — Cloud Runtime 整体架构 / Browserbase 对比 / 财务模型

**Chromium fork 路径目前冷藏中**（详见 [`chromium-fork/STATUS.md`](./chromium-fork/STATUS.md)）— 硬件 + 工程效率原因 pivot 到 SDK 注入路径，所有 fork 资产（27 GB sync + 11 个脚本 + 3 个 patch 草稿）原样保留作未来 Phase 3 解冻素材。解冻触发器明确写在 STATUS.md 里。

下面的内容是 Mosaiq 的**长期产品愿景**（Chromium fork、双引擎、$60–115M ARR），与 v0.10 实际产物（npm 发行的注入路径 + 桌面 + CLI）存在差距。这是有意为之 —— 先用务实方案在 ≤ 1 个月内验证最小可用路径，再决定哪些愿景值得砸数百人月去落地。

---

## 这是什么

**战略定位**：双引擎单一公司。Year 1 桌面优先建立品牌与现金流，Year 2 云端为主冲击 venture-scale，Year 3 双轨年 ARR $60–115M，估值 $500M–$1.5B。

### Mosaiq Desktop（桌面 antidetect browser）

对标并超越 Multilogin / Octo Browser / AdsPower / GoLogin / Dolphin{anty}。独立桌面应用，Win/macOS/Linux。

### Mosaiq Cloud（云端浏览器服务）

对标并超越 Browserbase / Steel.dev / Hyperbrowser。多租户 headless Chromium 集群，提供 REST + CDP-over-WebSocket API，与 Browserbase Stagehand SDK 100% 兼容（改一行 endpoint URL 即可迁移）。

### 五大技术差异化（两端同享）

1. **真 TLS 伪装**：BoringSSL 层 patch 实现 JA3/JA4 + HTTP/2 帧顺序，业内首家
2. **真行为模拟**：键鼠节奏 / 滚动惯性 / 停留生物特征，全行业空白
3. **真自检**：内置 Detection Lab，一键过 IPHey/CreepJS/BrowserScan/Pixelscan/Whoer；公开 leaderboard 含 Browserbase / Multilogin / AdsPower 对比
4. **真 Dev-First**：Day 1 SDK + CLI + Docker + MCP server，所有付费档全开 API；Stagehand / Playwright / Puppeteer / Selenium / browser-use 全等同支持
5. **真上游跟进**：Chromium stable 7 天内合入

## 文档导航

### 总览（推荐先读）

- 📖 [**Mosaiq 技术与产品白皮书（中文）**](./docs/WHITEPAPER.md) — 面向用户、工程师、投资人的统一入口；深入浅出讲清楚我们是谁、做什么、怎么做、为什么是现在

### 战略与产品

- 📋 [产品需求文档（PRD v0.2）](./docs/PRD.md) — 双引擎战略、定位、功能、商业模式、年 ARR 预测
- ☁️ [Cloud Runtime 技术架构](./docs/CLOUD-RUNTIME-ARCH.md) — K8s 集群 / API 设计 / Browserbase 对比 / 财务模型
- � [Chromium Fork 技术指南](./docs/CHROMIUM-FORK-GUIDE.md) — 编译环境、patch 清单、上游同步策略

### 启动与融资

- �🚀 [Phase 0 启动文档](./docs/PHASE-0-LAUNCH.md) — 招聘 JD、预算、里程碑、法务
- � [Pitch Deck v1（英文，22 + 5 页）](./docs/PITCH-DECK-V1.md) — 投资人版本，可直接渲染为 PDF / PPTX / Gamma.app
- 💰 [Seed 融资 Playbook](./docs/FUNDRAISING-PLAYBOOK.md) — VC 名单、冷邮件模板、Q&A 应对、备选计划

### 操作与运维

- 🌐 [住宅代理选购与配置指南](./docs/PROXY-GUIDE.md) — IPRoyal / Decodo / BrightData 对比、sticky session 命名约定、Mosaiq 集成完整流程

### 历史 / 迁移

- 🔄 [从 Shieldly 迁移](./docs/MIGRATION-FROM-SHIELDLY.md) — 哪些资产复用、怎么剥离

## 项目结构（规划中）

> **架构决定**：
> - **共享内核**：Chromium fork + 15 个反检测 patch + Persona Engine + LicenseService，双引擎复用。
> - **Desktop 壳**：单二进制 Chromium fork，无 Tauri/Electron 壳。UI = native Chromium views（工具栏/标签页） + WebUI 面板（profile manager / detection lab 等）。参考 Brave / Vivaldi / AdsPower 业内做法。
> - **Cloud 运行时**：K8s + gVisor 多租户 headless 集群，API Gateway 走 Cloudflare，M5 alpha 阶段使用 Fly.io、M14 GA 迁 GKE。

```
Mosaiq/
├── chromium-fork/                          # 共享内核仓库（submodule）
│   ├── patches/                            # 反指纹 patch 集（15 个）
│   ├── src/chrome/browser/mosaiq/         # C++ Browser Process Services
│   │   │ # PersonaService / LicenseService / ProxyRouter / DetectionLab
│   │   └── ...
│   ├── src/chrome/browser/resources/mosaiq/  # WebUI 面板（React + TS）
│   │   ├── profile_manager/                # Desktop 专属
│   │   ├── detection_lab/                  # Desktop 专属
│   │   └── settings/
│   └── src/chrome/browser/ui/views/mosaiq/   # native shell 定制（Desktop 专属）
├── cloud-runtime/                          # 云端服务仓库（独立）
│   ├── api-gateway/                        # Cloudflare Workers + Hono REST API
│   ├── cdp-gateway/                        # Go WebSocket reverse proxy
│   ├── browser-pool-controller/            # Go + K8s client-go
│   ├── browser-pod/                        # Mosaiq Chromium fork 的 headless Docker 镜像
│   ├── persona-pool-service/               # Rust + PostgreSQL + R2
│   ├── proxy-manager/                      # Go + Redis、接 BrightData / IPRoyal / Soax
│   ├── recording-service/                  # Rust + S3 + DuckDB
│   ├── admin-console/                      # Next.js 管理台
│   └── k8s-manifests/                      # Kustomize / Helm 部署资源
├── packages/
│   ├── sdk-typescript/                     # 跨 Desktop / Cloud 统一 TS SDK（开源）
│   ├── persona-schema/                     # Persona 数据格式定义（开源）
│   ├── cli/                                # `mosaiq` CLI（开源）
│   └── mcp-server/                         # MCP 服务器（开源，Claude / Cursor 连）
├── backend/
│   ├── workers/                            # Cloudflare Workers（License、Persona CDN、Telemetry）
│   └── persona-pipeline/                   # 真机指纹采集与处理流水线
├── tools/
│   ├── chromium-build/                     # 构建脚本与 CI runner 配置
│   └── detection-lab/                      # 自动检测站回归套件、公开 leaderboard 生成器
├── docs/                                   # 本目录
└── README.md
```

> “从 Shieldly 移植”的逻辑不再作为独立 TS 包存在：Schema 与 SDK 依然是 TS，但 license 业务逻辑、存储在 Chromium Browser Process 用 C++ 重写。详见 [MIGRATION-FROM-SHIELDLY.md](./docs/MIGRATION-FROM-SHIELDLY.md)。

## 当前状态

📅 **2026-05-21** — v0.10.0 已发布（详见 [`CHANGELOG.md`](./CHANGELOG.md)）

实际产物（4-package monorepo，注入路径）：

| Package | Version | 在 npm | 测试 | 角色 |
|---|---|---|---|---|
| `@mosaiq/persona-schema` | 0.10.0 | ✅ public | 26 | Persona Zod schema + 4 OS 模板（Win11 / Win10 / macOS / Ubuntu）的 canonical 源 |
| `@mosaiq/sdk` | 0.10.0 | ✅ public (含 postinstall patch) | 593 | Playwright + CDP 注入引擎、humanize、persona store、Detection Lab runner + scorer + storage + 报告 formatter / diff |
| `@mosaiq/cli` | 0.10.0 | ✅ public | 64 | `mosaiq` 命令行：Detection Lab 全 7 个 subcommand + Personas CRUD 全 9 个 subcommand |
| `@mosaiq/desktop` | 0.10.0 | ❌ private（永久） | 45 | Electron + React + Vite 桌面应用：Persona 管理 + Detection Lab 完整 UI（trend / 雷达图 / per-site card / 池对比 / Compare Runs / Markdown 导出） |

里程碑时间线：

- 2026-05-10 → v0.1.0：Persona 基础、SDK launcher、桌面壳
- 2026-05-16 → v0.2.0：humanize 引擎、UA-CH + worker scope 加固
- 2026-05-17 → v0.7.1：captured WebGL profiles contributor pipeline、CI、ESM cycle fix
- 2026-05-18 → v0.8.0：Detection Lab 完整桌面集成
- 2026-05-20 → v0.9.0：CLI 上线 + Detection Lab UX polish
- 2026-05-21 → v0.10.0：三发包包 npm 公开发行 + patch-package 分发 rebrowser-patches + changesets 自动化 + Detection Lab CI gate（fixture persona + 每周 baseline auto-refresh + sticky PR regression comment）

下一步（v0.11 候选）：见下方 [下一步行动](#下一步行动)。

长期愿景（**未落地，可能 v1.0+**）：

- Chromium fork + 15 个 C++ patch（cold storage 中，触发器见 [`chromium-fork/STATUS.md`](./chromium-fork/STATUS.md)）
- Cloud Runtime：**alpha 已在 fly.io 跑**（phase 11.4a Browserbase 一行切换、phase 11.3a fly machine pool + Prometheus）；K8s + gVisor 多租户集群 / context API / recording 仍位于 v1.0+ 路径上
- Persona auto-tune from detection results、real-hardware capture pipeline
- 法律主体（新加坡 + Delaware C-Corp）、Phase 0 团队组建

## 下一步行动

v0.11 候选方向（**未定**，待选）：

1. **Real-hardware capture v2** — 仿 Phase 7.0 WebGL capture pipeline，扩展到 audio / canvas / font 多 surface 的真机指纹收集，由 desktop UI 引导用户一键贡献。v0.10 npm 发行后才有意义（之前没有外部 contributor 池）
2. **Public Detection Lab leaderboard** — 持续 e2e 跑收集 + 静态站托管 Mosaiq vs Browserbase / Multilogin / AdsPower 对比；PRD §2 已承诺
3. **Detection Lab matrix 扩容** — 目前 CI gate 只覆盖 `win11-chrome-us` 一个 fixture persona。扩到 win10 / macOS / Ubuntu × 多 GPU profile，验证跨平台一致性
4. **Desktop UX polish** — 主题、history pagination、persona 批量操作、多窗口、截图 lightbox 增强

实战反馈优先级最高。如果你打算用 Mosaiq 跑真账号：

1. `npm i -g @mosaiq/cli && npx playwright install chromium` 走 npm 路径起步
2. `mosaiq personas create alice --template win11-chrome-us --display-name "Alice"`
3. `mosaiq detection-lab run alice` 体感反检测 score
4. 找几个 sensitive 站点（Reddit / X / Cloudflare 严格站）实战跑一周
5. 用 `mosaiq detection-lab run-all --fail-on-regression` 把它接到你自己的 cron / CI（外部 CI gate 路径；本仓库内置的 detection-lab.yml + 每周 baseline refresh 见 [docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md](./docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md) §10-12）
6. 把被检测的指标反馈成 Issue，会优先 v0.11 处理

## 许可证

详见 [LICENSE.md](./LICENSE.md)。简言之：**核心产品闭源**，但 Persona Schema、CLI 工具、TypeScript SDK 计划以 Apache 2.0 开源。
