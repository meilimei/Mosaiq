# Mosaiq

> **Browser Infrastructure for the Agentic AI Economy**。基于 Chromium fork 的反指纹内核，对外提供桌面浏览器（Desktop）+ 云端浏览器服务（Cloud Runtime）双引擎产品，覆盖跨境电商 / 自动化 / AI Agent 全部用户场景。

> ⚠️ **代号 Mosaiq**：最终品牌名待定。

---

## 🚀 想立即跑起来？

**v0.1 已可用**：Electron 桌面壳 + Playwright CDP 注入引擎，能创建 Persona、启动隔离浏览器、跑指纹自检。

→ **[QUICKSTART.md](./QUICKSTART.md)** — 5 分钟从 clone 到第一次自检

下面的内容是 Mosaiq 的**长期产品愿景**（Chromium fork、双引擎、$60–115M ARR），与 v0.1 实际产物存在差距。这是有意为之 —— 先用务实方案在 1 周内验证最小可用路径，再决定哪些愿景值得砸数百人月去落地。

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

📅 **2026-05-07**：Pre-Phase 0
- ✅ PRD v0.2 完成（双引擎版本）
- ✅ Cloud Runtime 架构文档 v0.1 完成
- ✅ 竞品调研完成（Desktop 11 家 + Cloud 6 家）
- ⏳ 正在筹组 Phase 0 团队（Chromium 内核 + Cloud Infra 工程师招募中）
- ⏳ 法律主体注册中（新加坡 + Delaware C-Corp 双层结构）

## 下一步行动

1. **本周**：阅读 [PHASE-0-LAUNCH.md](./docs/PHASE-0-LAUNCH.md)，开始执行 Week 1 任务
2. **本月**：找到 Chromium 内核工程师联创 + Cloud Infra 工程师
3. **下月**：跑通 Chromium fork 编译流水线，提交第一个 patch（Canvas）
4. **M3**：Cloud 架构最终定稿 + Cloud Runtime 仓库初始化

## 许可证

详见 [LICENSE.md](./LICENSE.md)。简言之：**核心产品闭源**，但 Persona Schema、CLI 工具、TypeScript SDK 计划以 Apache 2.0 开源。
