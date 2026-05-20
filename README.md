# Mosaiq

> **Browser Infrastructure for the Agentic AI Economy**。基于 Chromium fork 的反指纹内核，对外提供桌面浏览器（Desktop）+ 云端浏览器服务（Cloud Runtime）双引擎产品，覆盖跨境电商 / 自动化 / AI Agent 全部用户场景。

> ⚠️ **代号 Mosaiq**：最终品牌名待定。

---

## 🚀 想立即跑起来？

**v0.9.0 已发布**（2026-05-20）：Electron 桌面壳 + Playwright CDP 注入引擎 + humanize 类人输入引擎 + **完整 Detection Lab**（12 站反检测自检 / 历史 trend / per-run 雷达图 / 12-surface attribution / persona pool 横向对比 / Compare Runs side-by-side / Markdown 导出）+ **`@mosaiq/cli` 命令行**（headless `detection-lab run` / `run-all` / `compare` / `list-runs` / `show-run` / `export-run` / `personas list|show|create|update|clone|delete|export|import|templates`）。所有 4 个 workspace 包（`@mosaiq/persona-schema` / `@mosaiq/sdk` / `@mosaiq/cli` / `@mosaiq/desktop`）在 v0.9 一同 lock-step 发布。

→ **[CHANGELOG.md](./CHANGELOG.md)** — v0.1.0 → v0.9.0 完整变更（最近：Phase 9.1-9.10 CLI + Detection Lab polish）
→ **[QUICKSTART.md](./QUICKSTART.md)** — 5 分钟从 clone 到第一次自检 + Detection Lab + CLI
→ **[docs/V0.8-DETECTION-LAB.md](./docs/V0.8-DETECTION-LAB.md)** — Detection Lab 完整 product-level 设计稿（v0.8 落地、v0.9 polish）
→ **[docs/HUMANIZE-DESIGN.md](./docs/HUMANIZE-DESIGN.md)** — humanize 引擎设计稿（v0.2 起持续维护）

**Chromium fork 路径目前冷藏中**（详见 [`chromium-fork/STATUS.md`](./chromium-fork/STATUS.md)）— 硬件 + 工程效率原因 pivot 到 SDK 注入路径，所有 fork 资产（27 GB sync + 11 个脚本 + 3 个 patch 草稿）原样保留作未来 Phase 3 解冻素材。解冻触发器明确写在 STATUS.md 里。

下面的内容是 Mosaiq 的**长期产品愿景**（Chromium fork、双引擎、$60–115M ARR），与 v0.9 实际产物（注入路径 + 桌面 + CLI）存在差距。这是有意为之 —— 先用务实方案在 ≤ 1 个月内验证最小可用路径，再决定哪些愿景值得砸数百人月去落地。

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

📅 **2026-05-20** — v0.9.0 已发布（详见 [`CHANGELOG.md`](./CHANGELOG.md)）

实际产物（4-package monorepo，注入路径）：

| Package | Version | 测试 | 角色 |
|---|---|---|---|
| `@mosaiq/persona-schema` | 0.9.0 | 26 | Persona Zod schema + 4 OS 模板（Win11 / Win10 / macOS / Ubuntu）的 canonical 源 |
| `@mosaiq/sdk` | 0.9.0 | 593 | Playwright + CDP 注入引擎、humanize、persona store、Detection Lab runner + scorer + storage + 报告 formatter / diff |
| `@mosaiq/cli` | 0.9.0 | 64 | `mosaiq` 命令行：Detection Lab 全 7 个 subcommand + Personas CRUD 全 9 个 subcommand |
| `@mosaiq/desktop` | 0.9.0 | 45 | Electron + React + Vite 桌面应用：Persona 管理 + Detection Lab 完整 UI（trend / 雷达图 / per-site card / 池对比 / Compare Runs / Markdown 导出） |

里程碑时间线：

- 2026-05-10 → v0.1.0：Persona 基础、SDK launcher、桌面壳
- 2026-05-16 → v0.2.0：humanize 引擎、UA-CH + worker scope 加固
- 2026-05-17 → v0.7.1：captured WebGL profiles contributor pipeline、CI、ESM cycle fix
- 2026-05-18 → v0.8.0：Detection Lab 完整桌面集成
- 2026-05-20 → v0.9.0：CLI 上线 + Detection Lab UX polish

下一步（v0.10 候选）：见下方 [下一步行动](#下一步行动)。

长期愿景（**未落地，可能 v1.0+**）：

- Chromium fork + 15 个 C++ patch（cold storage 中，触发器见 [`chromium-fork/STATUS.md`](./chromium-fork/STATUS.md)）
- Cloud Runtime（K8s + gVisor headless 集群、REST + CDP-over-WebSocket、Stagehand SDK 兼容）
- Persona auto-tune from detection results、real-hardware capture pipeline
- 法律主体（新加坡 + Delaware C-Corp）、Phase 0 团队组建

## 下一步行动

v0.10 候选方向（**未定**，待选）：

1. **Detection Lab 作为自有 CI gate** — 在 `.github/workflows/` 用 v0.9 `detection-lab run-all --fail-on-regression` 对核心 persona 跑回归检测，闭环 SDK 注入改动的自动反检测
2. **npm publish 流程** — `@mosaiq/sdk` + `@mosaiq/cli` 走公开发布（package.json `files` / `exports` 完善、per-package README、release-please / changesets 自动化），外部能 `npx mosaiq` 或 `npm i @mosaiq/sdk`
3. **Real-hardware capture v2** — 仿 Phase 7.0 WebGL capture pipeline，扩展到 audio / canvas / font 多 surface 的真机指纹收集，由 desktop UI 引导用户一键贡献
4. **Desktop UX polish** — 主题、history pagination、persona 批量操作、多窗口

实战反馈优先级最高。如果你打算用 Mosaiq Desktop 跑真账号：

1. `pnpm dev:desktop` 跑通自检（一键 12 站 + 雷达图）
2. 用 `mosaiq detection-lab run-all --fail-on-regression` 把它接到你自己的 cron / CI
3. 找几个 sensitive 站点（Reddit / X / Cloudflare 严格站）实战跑一周
4. 把被检测的指标反馈成 Issue，会优先 v0.10 处理

## 许可证

详见 [LICENSE.md](./LICENSE.md)。简言之：**核心产品闭源**，但 Persona Schema、CLI 工具、TypeScript SDK 计划以 Apache 2.0 开源。
