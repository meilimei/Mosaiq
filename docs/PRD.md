# Project Mosaiq — 反指纹浏览器 + AI Agent 浏览器基础设施 PRD v0.2

> ⚠️ **愿景 vs 现实（2026-05 更新，先读这条）**：本 PRD 描述的是 Mosaiq 的**长期产品愿景**（双引擎、Chromium fork、7–9 人团队、$60–115M ARR）。**当前真实状态**是单人 + AI agent、约 20 天构建出的注入路径 SDK + CLI + 桌面应用 + cloud-runtime alpha（Chromium fork 已冷藏，见 [`chromium-fork/STATUS.md`](../chromium-fork/STATUS.md)）。未来 90 天的**务实**优先级（证明反检测真能打、拿首批真实用户、夯实质量）见 [`docs/ROADMAP-90D.md`](./ROADMAP-90D.md)。阅读本文时请把「宏大叙事」与「近期可执行项」分开看，别把愿景当承诺。

> **一句话**：**Browser Infrastructure for the Agentic AI Economy**。基于 Chromium fork 的反指纹内核，同时提供桌面浏览器（Desktop）与云端浏览器服务（Cloud Runtime），覆盖跨境电商 / 自动化 / AI Agent 全部用户场景，对标并超越 Multilogin / AdsPower / Browserbase。

> **战略定位**：双引擎产品（Desktop + Cloud），Year 1 桌面优先建立现金流与品牌，Year 2 云端为主冲击 venture-scale，Year 3 双轨年 ARR $60–115M，估值 $500M–$1.5B。

> **Mosaiq 是代号**，最终品牌名待定。文档中所有"Mosaiq"均可替换。

---

## 0. 速览（One-page）

| 维度 | 决策 |
|---|---|
| **战略形态** | **双引擎单一公司**：Mosaiq Desktop（桌面 antidetect browser，cash-cow）+ Mosaiq Cloud（AI Agent Browser Infrastructure，venture-scale） |
| **共享内核** | 单一 Chromium fork（patches + Persona Engine + LicenseService），Desktop / Cloud 两端复用 |
| **Desktop 形态** | 独立桌面应用（Win/macOS/Linux），单二进制 Chromium fork（含 native UI views + WebUI 面板，对齐 Brave/Vivaldi/AdsPower 做法） |
| **Cloud 形态** | 多租户 headless Chromium 集群，按浏览器小时计费，REST + CDP-over-WebSocket API，对标 Browserbase / Steel.dev / Hyperbrowser |
| **目标用户** | Desktop：跨境电商团队、广告投放工作室、增长黑客、爬虫/自动化开发者；Cloud：AI agent 公司、Playwright/Puppeteer 用户、企业自动化团队 |
| **核心差异化** | ① TLS/JA3+JA4 原生伪装（多数竞品做不好）② 行为生物特征模拟（无人做）③ 内置检测实验室 ④ Cloud 端反检测能力强于 Browserbase ⑤ Dev-First SDK + Persona Schema 开源 |
| **Desktop 定价** | 免费 5 号 → Solo $19/月（50 号）→ Team $49/月（200 号）→ Business $149/月 → Enterprise 定制 |
| **Cloud 定价** | Hobby $29/月（50 hours）→ Pro $99/月（200h + Stealth + Proxy）→ Scale $499/月（2000h + Persona Pool）→ Enterprise 自定义 |
| **首发市场** | 国际为主（英文先），中文同步上线 |
| **MVP 时间** | Desktop 9 个月（v0.5 公测）/ Cloud Alpha M5 / Cloud GA M14 |
| **GA 时间** | Desktop 12 个月（v1.0）/ Cloud 14 个月 |
| **启动资金** | ¥350–500 万（双引擎工程量增加 ~30%） |
| **核心团队** | 7–9 人，必含 Chromium 内核工程师 1–2 名 + Cloud Infra 工程师 1 名 |

---

## 1. 市场态势与竞品深度分析

### 1.1 Desktop 赛道头部竞品矩阵（2026 年 4 月最新）

| 排名 | 产品 | 起步价 | 起步号数 | 核心强项 | 致命弱点 |
|---|---|---|---|---|---|
| #1 | **Multilogin** | €9/mo | 10 | 双引擎（Mimic+Stealthfox）、AI Quick Actions、内置住宅代理 | 无免费版、Pro→Business 价格悬崖、移动端缺位 |
| #2 | **Octo Browser** | €10/mo | 3 | 真机指纹库、标签管理优秀、独立测评指纹质量与 Multilogin 齐平 | 无免费版、Chromium 单引擎 |
| #3 | **Kameleo** | €59/mo | 10 | Selenium/Playwright/Puppeteer 一等公民、Docker、API 1200 RPM | 起步价高、无内置代理 |
| #4 | **AdsPower** | $9/mo（年付 $5.4） | 2（永久免费） | 无代码 RPA、最便宜真机指纹、SOC 2 Type II 认证、宣传 99.2% 防封率 | 独立测评指纹质量低于头部、UI 杂乱、近期被报告 IPHey 检测穿透 |
| #5 | **Dolphin{anty}** | $10/mo | 60（免费 5） | 标签/状态管理优秀、多种代理协议（含 SSH） | $10→$89 价格悬崖、2026 年免费档从 10 砍到 5、有数据泄漏黑历史 |
| #6 | **GoLogin** | $24/mo | 100（免费 3） | 平台覆盖最广（含 Android + 云浏览器）、定价透明无悬崖 | Chromium 单引擎、50+ 号同开会卡、指纹强度中等 |
| #7 | **Vision** | $29/mo | 50 | 指纹参数 1000+（行业最深）、UDP SOCKS5 唯一、6 档定价无悬崖 | 新入场、跟踪记录短、更新频率低 |
| #8 | **GeeLark** | $29.9/设备 | 云手机模式 | 唯一真云端 Android 模拟（非 UA 伪装） | 云依赖不稳定、规模化成本爆炸 |
| #9 | **Linken Sphere** | $24/mo | 30（免费 5） | 账号 warming 专家、混合指纹模式（device-aware） | UI 不友好、丢了 Linux 支持、部分指纹参数固定 |
| #10 | **BitBrowser** | $10/mo | 50（免费 10） | 全档功能不阉割、定价梯度最平滑、团队席位便宜 | 指纹强度弱于头部、Win/Mac only |
| #11 | **Incogniton** | $19.99/mo | 10（免费 2 月 10 号→3 号） | UI 最友好、自带免费代理、cookie 导入导出顺手 | 指纹会被硬目标检穿、内核更新慢 |

### 1.1b Cloud Browser Infra 赛道竞品矩阵（venture-scale 战场）

| 排名 | 产品 | 起步价 | ARR 估算 | 估值 | 核心强项 | 致命弱点 |
|---|---|---|---|---|---|---|
| #1 | **Browserbase** | $0.10/min | $60M+（2025） | $300M+（B 轮 KP 领投） | 18 个月跑到 $60M ARR、客户含 OpenAI / Anthropic / Perplexity、Stagehand SDK | 内核是 raw Chromium + Playwright stealth，**反检测能力弱**，IPHey 通过率约 75% |
| #2 | **Apify** | $49/mo | $60M+ | $200M+ | 老牌 web scraping 平台、Actor 生态丰富、SEO 强 | AI agent 集成晚、浏览器层薄、自动化偏 scraping |
| #3 | **Browserless** | $200/mo | $5–10M | undisclosed | 老牌（2017 起）、自托管选项 | 产品停滞、AI 时代叙事弱 |
| #4 | **Steel.dev** | $0.05/min | < $2M | YC W24 + $6M 种子 | 开源策略、dev 体验好 | 反检测能力弱、规模小 |
| #5 | **Hyperbrowser** | $0.06/min | < $1M | YC S24 | AI agent 优化方向 | 早期、内核普通 |
| #6 | **Anchor Browser** | $0.08/min | < $1M | A16Z $5M 种子（2024 末） | 反检测专精、新入场 | 早期、规模小 |

**赛道总结**：< 8 家创业公司、全球总 ARR < $100M、2027 预计赛道 ARR $1–3B。**这是最早期阶段的早期阶段**。Browserbase 用 raw Chromium + Playwright stealth，**指纹质量远不如**我们规划的 Mosaiq Chromium fork（IPHey ~75% vs 目标 100%）——这是**真空带**。

### 1.1c Mosaiq Cloud vs Browserbase 差异化（真实赢面）

| 维度 | Browserbase | **Mosaiq Cloud** |
|---|---|---|
| 浏览器内核 | raw Chromium + Playwright stealth plugin | **真 Chromium fork + 15 个内核 patch** |
| 指纹质量 | IPHey ~75–85%、CreepJS 可识别 | **目标 100% / 100% / unique** |
| Persona 库 | 无，仅参数化随机 | **真设备指纹库，按地区/机型筛选** |
| Proxy 集成 | 用户自带 | **集成 BrightData / IPRoyal，按 persona 自动匹配地区** |
| AI agent 适配 | Stagehand SDK + Playwright API | **Stagehand 兼容 + Playwright + CDP + 专用 LLM-friendly API** |
| 价格 | $0.10/min | **$0.06–0.08/min（先打价格战）** |
| 数据飞轮 | 无 | **Persona 反馈环：Cloud 检测信号回流到 Persona Engine 持续优化** |

### 1.2 共性强项（Mosaiq 必须做到不输）

1. **多 OS 桌面客户端**（Win + macOS Apple Silicon + Linux）
2. **Persona 真实设备指纹库**（不是程序生成的随机参数）
3. **Cookie / IndexedDB / localStorage 真隔离**（不是扩展级 hack）
4. **per-profile Proxy**（HTTP/SOCKS4/SOCKS5/SSH，最好支持 UDP SOCKS5）
5. **Selenium / Playwright / Puppeteer hardened drivers**
6. **团队协作**（多席位、权限、profile 共享不暴露密码）
7. **Cloud + Local profile 双模式**
8. **API + Webhook**

### 1.3 竞品共性弱点 = Mosaiq 的机会

| 弱点 | 行业现状 | Mosaiq 对策 |
|---|---|---|
| **TLS/JA3+JA4 伪装弱** | 多数仅 JS 层指纹，TLS 暴露 | **L1 P0：TLS Cipher 顺序 + Extension 顺序 + GREASE patch BoringSSL，每 persona 一个稳定 JA4** |
| **HTTP/2 SETTINGS 帧** | 几乎无人处理 | **L1 P0：H2 帧顺序、HPACK 表序、PRIORITY 帧伪装** |
| **行为生物特征忽视** | 全行业空白 | **L1 P1：键盘节奏、鼠标轨迹、滚动惯性、停留时长内置模拟引擎** |
| **检测自检工具弱** | 用户得自己跑 IPHey/CreepJS/BrowserScan | **L1 P0：内置 Detection Lab 一键体检 + 历史趋势图 + 自动修复建议** |
| **Chromium 上游跟进慢** | 部分产品落后 stable 5+ 版本（"Chrome 103 vs 120"） | **L1 P0：Auto-merge bot，stable 发布 7 天内合并 + CI 全量回归** |
| **AI Agent 集成缺失** | 还停留在 RPA 录制 | **L1 P1：原生 MCP server、Claude Computer Use 兼容、browser-use 库一等公民** |
| **Dev-First 体验差** | API 是企业版加价附加 | **L0：所有付费档全开 API + SDK + CLI；免费档 100 RPM** |
| **移动端要么没要么贵** | GeeLark 唯一真做但纯云端 | **L1 P2：本地 Android 模拟（基于 Genymotion 引擎），不依赖云** |
| **价格悬崖** | Dolphin、Multilogin 的 4–9 倍跳价让中段用户痛 | **L0：线性梯度，每 50 号 +$10** |
| **真机指纹库陈旧** | 静态库一年不更 | **L1 P0：Cloud-pushed persona DB，月度新增 + 衰减剔除** |
| **指纹一致性校验缺失** | 用户自己组合参数容易做出"不可能组合" | **L0：Persona Coherence Engine 自动拒绝不一致组合** |
| **闭源 + 黑盒** | 全行业都是闭源 | **L1 P2：Persona Schema 开源 + 检测策略可订阅 + Marketplace** |

---

## 2. 产品定位

### 2.1 愿景

**"The most truthful disguise"** — 不是把浏览器伪装成机器伪装人，而是让浏览器**真正成为另一台真实设备**。

### 2.2 目标用户分层

| 层 | 画像 | 占比 | 主产品 | 痛点 | 付费能力 |
|---|---|---|---|---|---|
| **L1 个人用户** | 增长黑客、内容创作者、跨境个人卖家 | 30% | Desktop | 价格、易用性、可信度 | $9–29/mo |
| **L2 中小团队** | 5–20 人广告/电商/SMM 工作室 | 25% | Desktop | 协作、规模化、稳定性 | $49–199/mo |
| **L3 企业 / 机构** | 50+ 人代运营、品牌保护、研究机构 | 10% | Desktop + Cloud | SLA、审计、合规、白标 | $500–5000/mo |
| **L4 开发者 / 自动化** | 爬虫团队、QA、企业自动化团队 | 15% | **Cloud + Desktop** | API、SDK、headless、Docker | $29–499/mo |
| **L5 AI Agent 公司** | OpenAI Operator 集成商、Anthropic Computer Use 使用者、Cognition / Adept / MultiOn / browser-use 生态 | **20%（高增长）** | **Cloud** | 反检测 / 并发 / 低延迟 / Persona pool / LLM-friendly API | $99–50000/mo（usage-based） |

### 2.3 五大差异化锚点（卖点说话稿）

1. **"真 TLS 伪装"**：业内首家在 BoringSSL 层级实现 JA3/JA4 + HTTP/2 帧顺序伪装，对 Cloudflare/Akamai/DataDome/Imperva 全测过。**Desktop + Cloud 同享**。
2. **"真行为模拟"**：键鼠/滚动/停留生物特征引擎，让账号"看起来像真人在用"，不只是"指纹长得像真机"。Cloud 端可被 AI agent 调用为 `humanize: true` 开关。
3. **"真自检"**：一键过 IPHey/CreepJS/BrowserScan/Pixelscan/Whoer 5 大检测站，并显示**对比头部竞品**的得分。公开 leaderboard 包含 Browserbase / AdsPower / Multilogin 对比。
4. **"真开发者友好"**：Day 1 SDK + CLI + Docker + MCP server，所有付费档全开 API。**Stagehand / Playwright / Puppeteer / Selenium 全部等同支持**，Stagehand 代码不改一行从 Browserbase 迁移到 Mosaiq Cloud。
5. **"真上游跟进"**：Chromium stable 7 天内合入，永远是当前 Chrome 版本。Cloud 默认跟进，Desktop 可选加锁版本。
6. **"真双引擎"**：同一个产品，桌面点开人用、云端 API 调人用 — **对应到 Persona Pool 是同一套**。跨境老板上午打开 GUI 贴产品链接、下午同一个 Persona 由后端路线同时在 100 个账号上跑发布脚本。**这是现任何竞品都不能提供的体验**。

---

## 3. 功能范围

### 3.1 Desktop P0 必须（v0.5 Beta，9 个月内）

| 模块 | 功能 |
|---|---|
| **Profile Manager** | 创建/编辑/删除/复制/批量导入导出 profile；标签 + 状态 + 搜索 |
| **Persona Library** | 内置 5000+ 真机指纹（按 OS/region/device 分片）；云端月度更新；持续衰减 |
| **Persona Coherence Engine** | UA + UA-CH + Platform + GPU + Screen + Fonts + Timezone + Language 自动一致性校验 |
| **Fingerprint Patches**（Chromium C++ 层）| Canvas / WebGL / Audio / Navigator / UA-CH / Screen / Hardware / Timezone / Fonts / WebRTC（10 个 patch） |
| **TLS / JA3+JA4** | BoringSSL 层 patch，每 persona 稳定 JA4 |
| **HTTP/2 帧伪装** | SETTINGS 帧顺序、HPACK 表序、PRIORITY 帧 |
| **Cookie Jar 真隔离** | 内核级 partition（基于 `network::CookieManager`），跨 profile 不渗透 |
| **per-profile Proxy** | HTTP / SOCKS4 / SOCKS5 / SOCKS5-UDP / SSH 隧道；DNS over Proxy；IP 漂移检测 |
| **Detection Lab** | 一键测 IPHey / CreepJS / BrowserScan / Pixelscan / Whoer / FingerprintJS Pro；得分对比同类竞品 |
| **License + 账号系统** | Creem 集成（复用 Shieldly）；离线 24h 宽限期 |
| **i18n** | 中 / 英（复用 Shieldly 的 i18n 框架） |
| **Auto-update** | Chromium native Omaha（Win）/ Keystone（macOS）/ apt-repo（Linux） |

### 3.1b Cloud Runtime P0 必须（Alpha M5 / GA M14）

> **定位**：Mosaiq Cloud 是多租户 headless Chromium 集群，对外提供 REST + CDP-over-WebSocket API，让 AI agent / 爬虫 / 企业自动化脚本都能以 ~$0.06/min 调用一个高质量反检测浏览器。

| 模块 | 功能 |
|---|---|
| **Browser Pool** | K8s 上的 headless Chromium 容器集群，多租户隔离（gVisor / Firecracker），热启动池实现 < 2s 冷启动 |
| **Session API** | `POST /v1/sessions` 创建 session；返回 WebSocket CDP endpoint + Persona ID；默认 30 分钟 TTL，可推为长 session |
| **CDP Gateway** | WebSocket 反向代理，将客户端 Playwright/Puppeteer/Stagehand 连接路由到集群中的 headless 实例；支持 sticky session（同 session 总路由到同实例） |
| **Persona Pool Service** | 跨 session 共享的 Persona 库；可按地区 / 机型 / OS 筛选；重复 session 可指定同 persona ID（必要于账号会话 warming） |
| **Stealth Mode** | 默认启用全部 Chromium fork 反检测 patch（TLS / H2 / Canvas / WebGL / …）；可选 `humanize: true` 启用行为生物特征 |
| **Proxy Manager** | 按 Persona 自动匹配 BrightData / IPRoyal 住宅 IP；也可用户自带 BYOP；自营内部 IP 池作为 fallback |
| **Live View** | 用户可在管理台看到 session 实时 noVNC 画面（调试必需，Browserbase 默认黑盒不可见） |
| **Recording / Replay** | 全程 CDP trace 录制 + Playwright trace.zip 导出；Session Replay UI |
| **Stagehand Compatibility** | API 与 Browserbase Stagehand SDK 100% 兼容，用户只需改一行 endpoint URL |
| **Billing** | Stripe Metered 计费：per browser-minute + per persona-checkout + Proxy GB 附加 |
| **Quota / Rate Limit** | 按 plan 限并发 / 并发 sessions / 并发 RPM；超额上 hard limit，企业可调 |
| **Observability** | 客户可见仪表盘：session 起始 / 结束 / 错误率 / latency p50/p95/p99 / 月费实时预估 |
| **SOC 2 预准备** | 为 Cloud GA 后 6–9 个月启动 SOC 2 Type I 预备；audit log / IAM / 加密 / 备份 / 事件响应 |

**Cloud P1 强烈建议（Cloud GA 后 3–6 个月）**：MCP server（让 Claude Computer Use 直接连）、Webhooks（session 生命周期事件）、多 Region（US-East / EU-West / APAC 三个最低）、Private VPC 上接（Enterprise）、Captcha 穿破（reCAPTCHA / hCaptcha / Cloudflare Turnstile）、Browser File Storage（下载件持久化）。

### 3.2 Desktop P1 强烈建议（v1.0 GA，12 个月）

| 模块 | 功能 |
|---|---|
| **Behavioral Humanization** | 键鼠节奏 / 滚动惯性 / 停留时长引擎；可录制真人样本回放 |
| **Account Warming Scheduler** | 类似 Linken Sphere，新号 7/14/30 天活跃节律建议 + 自动执行 |
| **AI Agent 原生集成** | MCP server；Claude Computer Use 适配；browser-use / Stagehand 一等公民 |
| **Hardened Automation Drivers** | Selenium / Playwright / Puppeteer patched；CDP 调用痕迹清理 |
| **Team Collaboration** | 角色权限、profile 分享不暴露 cookie / 密码、操作审计日志 |
| **Cloud Profile Sync** | 端到端加密 + 选 S3/R2/自托管；profile 跨机器漂移 |
| **RPA 可视化编辑器** | 类似 AdsPower 的无代码流程；模板市场 |
| **Built-in Proxy 市场** | 集成 Bright Data / Smartproxy / IPRoyal，按需付费，自动 persona 匹配地区 |

### 3.3 P2 远期（v2.0+）

- **本地 Android 模拟**（对标 GeeLark，但不依赖云）
- **Persona Schema 开源 + Marketplace**
- **检测策略订阅**（社区贡献，类似 uBlock filterlists）
- **企业版**：白标、SSO、SCIM、SOC 2 审计
- **Stealthfox 等价物**：Firefox fork（覆盖部分平台偏好 FF 的场景）
- **Headless 优化**：远程 Headless 容器集群（对标 Browserless）

---

## 4. 技术架构（高层次）

### 4.1 双引擎全貌拓扑

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       Mosaiq Shared Core (共享内核层)                      │
│   Chromium fork + 15 patches + Persona Engine + LicenseService            │
└──────────────────────┬───────────────────────────────────────────────────┘
                       │ 复用同一套 patches
            ┌──────────┴────────────────┐
            ↓                           ↓
  ┌──────────────────────┐      ┌──────────────────────┐
  │ Mosaiq Desktop       │      │ Mosaiq Cloud         │
  │ (桌面应用)           │      │ (云端 API 服务)       │
  │ Win/macOS/Linux      │      │ K8s + headless       │
  │ GUI use cases        │      │ API use cases        │
  └──────────────────────┘      └──────────────────────┘
```

### 4.2 Mosaiq Desktop 架构

```
┌────────────────────────────────────────────────────────────────┐
│  Mosaiq Browser  ─  单二进制（Chromium fork）                   │
├────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────┐    ┌──────────────────────────────┐  │
│  │ Native Shell         │    │ WebUI 面板                    │  │
│  │ chrome/browser/ui/   │    │ chrome://mosaiq/...           │  │
│  │  views + cocoa       │    │  • Profile Manager            │  │
│  │  • 工具栏 / 标签     │    │  • Detection Lab              │  │
│  │  • 地址栏 / 菜单     │    │  • Settings / Onboarding      │  │
│  │  • Profile Switcher  │    │  • License / Account          │  │
│  │  • 系统托盘          │    │  (React + TS, 编译为          │  │
│  │  (定制 C++ views)    │    │   chrome:// 内部资源)         │  │
│  └──────────────────────┘    └──────────────────────────────┘  │
│  ─── Browser Process Services（C++）─────────────────────────  │
│   • PersonaService（绑定 BrowserContext）                      │
│   • LicenseService（移植 Shieldly license.ts → C++）           │
│   • Cookie Jar Partition / Proxy Router（per-profile）         │
│   • Detection Lab Runner / Persona Library Cache               │
│   • MCP / API Server（暴露 localhost 给 SDK）                  │
│  ─── Patches（注入到 Renderer / Network / GPU 进程）─────────  │
│   Canvas | WebGL | Audio | Navigator | UA-CH | Screen          │
│   Hardware | Timezone | Fonts | WebRTC | TLS-JA4               │
│   H2-Frames | Cookie-Partition | Persona-Bridge                │
│  ─── 进程拓扑（Chromium 标准多进程）─────────────────────────  │
│   Browser(1) → Renderer(N) / GPU / Utility / Network          │
└────────────────────────────────────────────────────────────────┘
              ↓                                ↓
   ┌──────────────────────┐         ┌──────────────────────┐
   │ Cloud Backend        │         │ Persona Library CDN  │
   │ (CF Workers + R2)    │         │ (R2 + signed URLs)   │
   │ - License            │         │ - Monthly delta      │
   │ - Telemetry          │         │ - Geo-sharded        │
   │ - Webhooks           │         └──────────────────────┘
   │ - Team / Auth        │
   └──────────────────────┘
```

### 4.3 Mosaiq Cloud 架构（与 Browserbase 同赛道但反检测能力更强）

```
  客户端（AI agent / Playwright / Puppeteer / Stagehand / browser-use）
        │
        │ 1) POST /v1/sessions  → 获得 ws:// endpoint + persona_id
        │ 2) WebSocket（CDP）
        ↓
  ┌───────────────────────────────────────────────────────────────┐
  │     Mosaiq Cloud Edge（Cloudflare / Fly.io 多 Region）          │
  │  • API Gateway（REST + WebSocket）                              │
  │  • Auth + Quota + Rate Limit                                   │
  │  • Billing Meter（Stripe Metered）                              │
  │  • CDP Gateway（sticky session routing）                        │
  └────────────────────────────────────┬──────────────────────────┘
                                        │
  ┌─────────────────────────────────────┴──────────────────────┐
  │   Browser Pool（Kubernetes 集群，多 Region）                  │
  │  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ │
  │  │ headless browser│ │ headless browser│ │ headless browser│ │
  │  │ 实例 1（隔离）  │ │ 实例 2（隔离）  │ │ 实例 N（隔离）  │ │
  │  │ · Mosaiq Core   │ │ · Mosaiq Core   │ │ · Mosaiq Core   │ │
  │  │ · gVisor sbox   │ │ · gVisor sbox   │ │ · gVisor sbox   │ │
  │  │ · Persona X     │ │ · Persona Y     │ │ · Persona Z     │ │
  │  └─────────────────┘ └─────────────────┘ └─────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
         │                  │                  │
         ↓                  ↓                  ↓
  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
  │ Persona Pool   │  │ Proxy Pool     │  │ Recording      │
  │ (PostgreSQL +  │  │ (BrightData /  │  │ (S3 + DuckDB   │
  │  R2 资源二进制)│  │  IPRoyal /     │  │  检索)         │
  │                │  │  自营住宅)     │  │                │
  └────────────────┘  └────────────────┘  └────────────────┘
```

> 详细架构以及财务成本模型见 [`CLOUD-RUNTIME-ARCH.md`](./CLOUD-RUNTIME-ARCH.md)。

**关键技术决策：**

1. **不用 Tauri / Electron 壳层**：参照 Brave / Vivaldi / Edge / AdsPower 业内统一做法——单二进制 Chromium fork。理由：
   - 单进程树，无 Tauri↔Chromium 双层 IPC overhead
   - 单更新通道（不用同时维护壳与内核两套升级）
   - 安装体积约 200MB（vs. Tauri+Chromium ≈ 410MB）
   - **反检测**：Tauri 用系统 WebView（macOS WebKit / Windows WebView2），同时跑两套引擎本身就是 fingerprint 信号
2. **UI 实现分两层**：
   - **Native Shell**：工具栏、标签、地址栏、菜单、系统托盘、多窗口管理 — 全部用 Chromium 自带的 `chrome/browser/ui/views/`（Win/Linux）和 `chrome/browser/ui/cocoa/`（macOS）。Brave / Vivaldi / Edge 同款做法。
   - **WebUI 面板**：Profile Manager、Detection Lab、Settings、License 等产品页面 — 用 Chromium WebUI 基础设施，注册为 `chrome://mosaiq/...`，React + TS 编写，编译为 `.grd` 资源打包到二进制。`chrome://settings` 同款做法。
3. **State Management**：所有 persona、license、proxy、cookie partition 状态由 **Browser Process 的 C++ Services** 持有（基于 Chromium 的 `KeyedService` + `BrowserContext` 模型），通过 `mojom` IPC 与 Renderer / WebUI 通信。**不需要单独的 Rust daemon**。
4. **Cookie Jar 真隔离**：在 `services/network/cookie_manager.cc` 加 `partition_key`（基于 persona id），`StoragePartition` 同步分区，不靠 storeId hack。
5. **Persona 加载链路**：Browser 启动 → 命令行 `--mosaiq-persona-id=xxx` → `PersonaService` 从本地 SQLite 加载（用 Chromium 自带 `sql::Database`）→ 通过 `mojom` 推到 Renderer → Patches 调用 `PersonaService::Get()` 拿数据。
6. **License 加密**：用 Chromium 自带 `OSCrypt`（macOS Keychain / Windows DPAPI / Linux KWallet+GNOME），不再自己实现 AES-GCM。Shieldly 的 `license.ts` 业务逻辑在 C++ 重写，但流程不变。
7. **后端**：Cloudflare Workers + D1（License）+ R2（persona 库）+ KV（telemetry）；超低运维成本。
8. **可选 v1.0+ 增强**：独立的 Qt Profile Hub 守护进程（参照 AdsPower Dashboard），让用户在所有浏览器窗口关闭时也能管理 profile。**MVP 不做**。

---

## 5. UX 原则

1. **零学习曲线启动**：首次启动 → 选 region → 一键创建第一个 profile → 跑 Detection Lab → 看绿色"全部通过" → 浏览。**3 分钟内**。
2. **一切可见**：fingerprint 现在是什么、proxy 是不是工作、检测得分多少 —— 不藏。
3. **设计语言**：暗色优先，参考 Linear / Vercel / Arc 现代风；可调亮色。
4. **键盘党友好**：所有操作都有快捷键 + Command Palette（⌘K）。
5. **CLI 与 GUI 平等**：所有 GUI 能做的事 CLI 都能做。

---

## 6. 商业模式

### 6.1 Desktop 定价（seat-based + profile quota）

| 档 | 价格 | Profiles | 团队席位 | API RPM | 重点功能 |
|---|---|---|---|---|---|
| **Free** | $0 | 5 | 1 | 100 | 全功能（除 RPA 模板市场） |
| **Solo** | $19/mo（年付 $9） | 50 | 1 | 500 | + Cloud Sync、Detection Lab Pro |
| **Team** | $49/mo（年付 $29） | 200 | 5 | 1500 | + 协作、审计、profile 共享 |
| **Business** | $149/mo | 1000 | 20 | 5000 | + Webhooks、SLA 99.5%、优先支持 |
| **Enterprise** | 定制（起步 $999/mo） | 无限 | 无限 | 无限 | + 白标、SSO、SCIM、SOC 2、私有部署 |

**关键定价决策：**
- Free 5 号比 Dolphin 现在的 5 号、AdsPower 的 2 号更慷慨，但比 BitBrowser 的 10 号紧
- 年付 50% off，比业内 40% 更激进
- 没有 Multilogin 那种 $35→$75 的悬崖，每档线性

### 6.1b Cloud 定价（usage-based，对标 Browserbase）

| 档 | 月费 | 含浏览器小时 | 并发 sessions | Persona Pool | 住宅 IP | 重点功能 |
|---|---|---|---|---|---|---|
| **Free trial** | $0 | 5 hours（一次性） | 1 | 共享库 | 不含 | 试用 |
| **Hobby** | $29/mo | 50 hours | 2 | 共享库 | 不含（BYOP） | 个人开发者 |
| **Pro** | $99/mo | 200 hours | 10 | 专属 | 含 5GB | 中小 AI agent 初创 |
| **Scale** | $499/mo | 2000 hours | 50 | 专属 + [sticky](./PHASE-11.5-KEEPALIVE-LONG-SESSION.md) | 含 50GB | 中型自动化团队 |
| **Business** | $1999/mo | 10000 hours | 200 | 专属 + warming | 含 200GB | 大型 AI agent 公司 |
| **Enterprise** | 定制（起 $5k/mo） | 无限 | 无限 | 专属 + 定制入库 | 无限 | + Private VPC、SOC 2、SSO、专属支持 |

**超额价格**：
- 超出浏览器小时：$0.06/min（vs. Browserbase $0.10/min）
- Persona checkout：$0.10/persona（仅调用 unique persona pool 时）
- 住宅 IP：$8/GB（vs. BrightData zero-margin，我们走 ~30% 毛利）

**关键定价决策**：
- 价格打低 Browserbase 40%（打价格战抢中小创业客户）
- Hobby 档 $29 进场，与 Browserbase Free Trial（$1 + 1h）差异化
- Enterprise 起 $5k，该金额远低于 Multilogin Enterprise——压制 self-hosted 市场

### 6.1c 双引擎财务模型（24 个月 ARR 预测）

| 阶段 | 时间 | Desktop ARR | Cloud ARR | 总 ARR | 估值（8–12x ARR） |
|---|---|---|---|---|---|
| **MVP 后** | M6 | $0–100k | $0（alpha） | < $100k | seed |
| **Desktop GA** | M12 | $1–2M | $200k–500k | $1.2–2.5M | $10–20M（seed/A） |
| **双引擎起量** | M18 | $3–5M | $3–10M | $6–15M | $50–150M（A） |
| **venture-scale** | M24 | $5–8M | $15–40M | $20–48M | $200–500M（B） |
| **未来三年** | M36 | $8–15M | $40–80M | $48–115M | $500M–$1.5B（C） |

**双引擎资本效率（capital efficiency）**：
- Desktop 单位经济：GM ~85%，CAC ~$50，LTV ~$800，LTV/CAC ~16x
- Cloud 单位经济：GM ~70%（住宅 IP 转售毛利受限），CAC ~$300（dev-first 自然偏低），LTV ~$8000，LTV/CAC ~27x
- **双引擎 blended**：GM ~75%，CAC ~$150，LTV ~$3500，LTV/CAC ~23x
- **远超 SaaS 行业平均**（3–5x LTV/CAC 即为优质）

### 6.2 获客

**Desktop GTM：**

1. **开发者社区**：GitHub 开源 Persona Schema、CLI 工具、Playwright/Puppeteer integration；PR 文章
2. **检测对比内容**：每月发"5 大检测站本月通过率对比"博客【**含 Browserbase / Multilogin / AdsPower 对比**】
3. **Affiliate 30% 终身佣金**：对标 Multilogin 的合作渠道生态
4. **YouTube 教程合作**：跨境电商 KOL（找 Wholesale Ted 这类）
5. **r/asmongold / r/Affiliate / r/dropship Reddit AMA**
6. **微信生态**（中国市场）：知识星球、公众号合作

**Cloud GTM（AI agent / dev 为主）**：

1. **“Cursor for browser automation” 定位切入点**：Hacker News + dev.to + Twitter dev influencer
2. **Stagehand 迁移推广**：“一行 endpoint URL 从 Browserbase 迁移过来”的示例代码 + 配套迁移文档
3. **AI agent 生态集成**：CrewAI / LangChain / LlamaIndex / browser-use 首选适配
4. **公开反检测 leaderboard**：IPHey / BrowserScan / CreepJS / Pixelscan / Whoer 每周对比 Browserbase / Steel.dev / Hyperbrowser
5. **YC / Cohere / a16z agents 社群 outreach**（包含 YC 校友、a16z agents portfolio、AI engineer 定期大会闭门社群）
6. **公关与线下活动**：Product Hunt launch、Indie Hackers AMA、主流 dev podcast 邀约嘉宾

### 6.2b Dev-First 在双引擎中的核心位置

**哲学**：桌面 GUI 是人的使用接口，云端 API 是 AI agent 的使用接口。同一个 Persona、同一套反检测内核、同一个账号体系。**Day 1 SDK 全部付费档开放**，免费档也能调 100 RPM。Stagehand / Playwright / Puppeteer / Selenium / browser-use 全等同支持。

### 6.3 生态

- **Persona Schema 开源**（Apache 2.0）→ 开发者可自做工具
- **Plugin SDK**（Chromium WebUI + 受限 Extension API）→ 第三方扩展
- **Marketplace**（v2.0）：Persona 包、RPA 模板、检测策略包

---

## 7. 24 个月里程碑（双引擎版本）

### 7.1 Year 1：Desktop 优先，Cloud Alpha 验证

| 月 | 里程碑 | Desktop 交付 | Cloud 交付 | 团队 |
|---|---|---|---|---|
| **M1** | 团队 + 基础设施 | Chromium 工程师到位、build pipeline、首个自定义 native UI 视图跑通 | — | 3 |
| **M2** | 第一个 patch | Canvas + WebGL patch；最简 UI | — | 4 |
| **M3** | Desktop Alpha 内部 | 全 10 个 patch；Profile / Persona / Proxy 跑通 | — | 5 |
| **M4** | TLS / H2 完成 | BoringSSL patch；Detection Lab v1 | **Cloud 架构设计完成**（仅文档阶段） | 6 |
| **M5** | Cloud Alpha（10 人邀请） | — | **Cloud Runtime alpha**：Session API + CDP Gateway + Browser Pool MVP（单 region）；10 个 alpha 客户用 free credits | 7 |
| **M6** | Cloud Stagehand 兼容 | — | Stagehand SDK 适配 → “一行 endpoint 迁移”可行 | 7 |
| **M7** | Desktop Closed Beta（100 人） | License、自动更新、i18n 完整 | Persona Pool Service；Cloud beta 拓到 50 人 | 8 |
| **M9** | Desktop Public Beta（v0.5） | 公开下载；Free 档开放；初步获客 | Cloud Live View / Recording / Replay | 8 |
| **M11** | RPA + AI Agent | MCP、browser-use 集成；RPA 编辑器 | Cloud Public Beta（全开注册） | 8 |
| **M12** | **Desktop GA（v1.0）** | 团队协作、Cloud Sync、付费正式开通 | Cloud Pro / Scale 付费开启 | 8 |

### 7.2 Year 2：Cloud 为主，冲击 venture-scale

| 月 | 里程碑 | Desktop 交付 | Cloud 交付 | 团队 |
|---|---|---|---|---|
| **M14** | **Cloud GA（v1.0）** | Desktop 增量迭代 | 多 Region（US-East / EU-West / APAC）；SLA 99.9%；Stripe Metered；SOC 2 Type I 预准备 | 10 |
| **M16** | MCP server | Desktop MCP 上线 | Cloud MCP server（Claude Computer Use 直连） | 11 |
| **M18** | A 轮 | $1–1.5M MRR | $20M+ ARR run-rate | 12 |
| **M20** | Captcha 穿破 | — | Cloud 内置 Captcha solver（reCAPTCHA / hCaptcha / Turnstile） | 14 |
| **M22** | Browser File Storage | Cloud Sync 增量能力 | Cloud File Storage + persistent browser context | 14 |
| **M24** | **Cloud SOC 2 Type II** | — | 首个企业级合规里程 | 16 |

### 7.3 关键决策门

- **M5 Cloud Alpha gate**：10 人 alpha 反馈 NPS ≥ 50 且 P0 bugs 已修，才启 Cloud GA 资源。**不达标则 Cloud 推到 Year 2**，集中资源优化 Desktop。
- **M12 Desktop GA gate**：$1M ARR run-rate 且 5 大检测站全绿，才启 Cloud GA 加速。
- **M18 A 轮 gate**：$10M+ ARR run-rate 且 Cloud 增长 ≥ 200% YoY，才足以讲 venture-scale 故事。

---

## 8. 成功指标

### 8.1 Desktop 指标

| 阶段 | 目标 |
|---|---|
| Public Beta（M9） | 5000 注册、500 DAU、Detection Lab 平均得分 ≥ 头部竞品 |
| GA（M12） | 20k 注册、2k MAU、首批 100 付费、$5k MRR |
| 18 月 | 100k 注册、10k MAU、1500 付费、$80k MRR |
| 24 月 | 1M 注册、50k MAU、10k 付费、$500k MRR（达到 AdsPower 早期规模） |

### 8.2 Cloud 指标

| 阶段 | 目标 |
|---|---|
| Cloud Alpha（M5） | 10 alpha 客户、NPS ≥ 50、集群稳定跑 100 sessions/日 |
| Cloud Public Beta（M11） | 500 注册、75 付费、8k browser-hours/月、P0 bug ≤ 0 在生产 |
| Cloud GA（M14） | 2k 注册、100 付费、$50k MRR、20k browser-hours/月 |
| 18 月 | 10k 注册、500 付费、$300k MRR、100k browser-hours/月、首 enterprise 签约 |
| 24 月 | 50k 注册、3k 付费、$1.5M+ MRR（run-rate $18M+ ARR）、500k browser-hours/月、3 个 Region、SOC 2 Type I |

### 8.3 双引擎 blended 指标

| 阶段 | 目标 |
|---|---|
| 12 月 | $5k Desktop MRR + $0 Cloud → 总 $5k MRR，达到 seed 里程 |
| 18 月 | $80k Desktop + $300k Cloud → 总 $380k MRR（run-rate $4.5M+ ARR），A 轮就位 |
| 24 月 | $500k Desktop + $1.5M Cloud → 总 $2M MRR（run-rate $24M+ ARR），B 轮就位 |
| 36 月 | $1M Desktop + $5M Cloud → 总 $6M MRR（run-rate $72M+ ARR），$500M–$1.5B 估值 |

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| Chromium 内核工程师招不到 | 国内招 1 人 + 海外远程（俄罗斯/乌克兰反指纹圈活跃）; 短期外包过渡 |
| Chrome 升级追不上 | 第一年只跟 stable 不跟 dev/beta；自动 merge bot + 全量 CI |
| 首次合并冲突爆炸 | patch 设计遵循"最小入侵"原则，尽量加 hook 不改逻辑 |
| Meta / X 法律函 | 公司主体注册新加坡或 BVI；ToS 加 "user agrees to comply with target platforms' ToS" |
| Stripe 拒绝服务 | 直接用 Paddle（MoR），他们已为 Multilogin / Octo 服务 |
| 反指纹军备竞赛 | 1 人专职 Detection Research，月度对照 5 大检测站；社区贡献策略包 |
| 客服爆炸 | 自助 Detection Lab 解决 60% 问题；社区 Discord；FAQ 自动化 |
| 上线即被 IPHey 等检测站针对 | 与 BrowserScan 等合作（很多检测站本身和反指纹工具有商业关系） |

---

## 10. Shieldly 资产复用清单

| Shieldly 资产 | 复用度 | 用途 |
|---|---|---|
| `crypto.ts` AES-GCM 加密 | ⚠️ 30% | License 加密改用 Chromium `OSCrypt`；TS 版仅在 SDK 包中保留（profile 导出加密） |
| `license.ts` Creem 集成 | ✅ 90% | 业务逻辑在 C++ `LicenseService` 重写，流程不变；TS SDK 提供同步 wrapper |
| `i18n.ts` + `_locales/*` | ✅ 100% | UI 国际化 |
| `types.ts` 数据模型概念 | ⚠️ 30% | Persona / Site Rule 概念延续，schema 重写 |
| Popup React UI 设计语言 | ⚠️ 50% | 颜色 / 间距 / 组件复用，但桌面 App 重新布局 |
| `identity-generator.ts` | ❌ | 直接废弃；Persona 来自云端真机库 |
| `injectFingerprintSpoofing` | ❌ | 整段废弃；patch 在 C++ 层做 |
| Tracker 阻挡（DNR） | ❌ | 反过来：Mosaiq **不应**阻挡 trackers，避免触发反常 |

---

## 11. 待你确认的关键决策

| # | 问题 | 选项 | 默认建议 |
|---|---|---|---|
| 1 | 品牌名 | Mosaiq / Persono / Identica / Forge / 其他 | **Mosaiq**（暂用） |
| 2 | 公司主体注册地 | 中国 / 香港 / 新加坡 / BVI / 美国 Delaware | **新加坡 + Delaware C-Corp 双层结构**（面向 venture-scale、迎 US VC） |
| 3 | 首发市场重心 | 国际为主（英文先） / 中国为主（中文先） / 双线 | **国际为主，中文同步**；Cloud 赛道全英文 |
| 4 | 内核工程师方案 | 全职招聘 / 海外远程外包 / 联创换股权 | **联创换股权 + 1 名全职 + 1 名 Cloud Infra 工程师** |
| 9 | UI 壳方案 | Tauri+Rust / Native Chromium views+WebUI / Qt 壳 | **Native Chromium views + WebUI 面板**（已确认，对齐业内做法） |
| 5 | 首版是否含 Firefox fork | 是 / 否（仅 Chromium） | **否**，v2.0 再做 |
| 6 | 开源策略 | 全闭源 / Schema + CLI 开源 / 内核开源 | **Schema + CLI + Cloud SDK 开源**（Vercel / Supabase 路径） |
| 7 | 是否做内置代理 | 自建 / 集成第三方 / 不做 | **集成第三方**（Bright Data / IPRoyal 分成） |
| 8 | 是否独立 GitHub Org | 与 Shieldly 同 Org / 独立 Org | **独立 Org**（法务隔离） |
| 10 | **产品重心** | 仅 Desktop / 仅 Cloud / 双引擎 | **双引擎**（Year 1 Desktop 优先、Year 2 Cloud 为主） |
| 11 | **Cloud 云平台选型** | AWS / GCP / Fly.io / 自托管 | **Fly.io 或 Hetzner 启动，AWS 作补充**，低单位成本 |
| 12 | **是否与 Browserbase 打价格战** | 高位 / 持平 / 低位 | **低位（-40%）** 抢中小，Year 2 后调高 |

---

## 12. 双引擎战略深度说明

### 12.1 为什么双引擎？

**单独 Desktop 的天花板**：$200M 估值，年 ARR $5–15M。这是个好生意，但**不足以讲 venture-scale 故事**。

**单独 Cloud 的风险**：还未验证产品、未建立品牌、CAC 高、需要首轮 $2–3M 资金起步，且与 Browserbase 正面竞争。

**双引擎的杀手锏**（killer move）：
- **同一套内核，工程边际成本仅 ~30%**（不到两个独立产品的 200%）
- **Desktop = 品牌 + 现金流**：Year 1 拉到 $1–3M ARR，脱离对融资的依赖
- **Cloud = venture-scale 故事 + 估值乘数**：Year 2–3 起量，打 7–14x ARR multiple
- **共享 Persona Engine = 数据飞轮**：代码一处复用，检测信号两端回流
- **跨卖 reverse**：Desktop 客户发现“原来你们还有 API” 跨销 Cloud；Cloud 客户发现“原来你们还有桌面应用给运营同事” 跨销 Desktop

### 12.2 双引擎 vs 竞品

| 能力 | Multilogin | AdsPower | Browserbase | **Mosaiq** |
|---|---|---|---|---|
| 桌面 antidetect browser | ✅ | ✅ | ❌ | ✅ |
| 云端 API browser infra | ⚠️仅企业版 | ⚠️仅企业版 | ✅ | ✅ |
| 反检测能力（IPHey/CreepJS/BrowserScan） | ✅ | ⚠️ | ⚠️ | ✅ |
| Stagehand SDK 兼容 | ❌ | ❌ | ✅ | ✅ |
| AI agent 适配 | ⚠️ | ❌ | ✅ | ✅ |
| Persona 库互通 Desktop 与 Cloud | ❌ | ❌ | ❌ | **✅ 唯一** |
| 市场价格位 | 贵 | 中 | 贵 | **中（Desktop）+ 低（Cloud）** |

### 12.3 双引擎出现的关键时机

1. **市场信号**：2025 年底起“跨境电商 + AI agent”需求联动出现。越多中型代运营公司已开始用 Operator + Computer Use 跨平台运作。双引擎产品是这类客户唯一能在一家供应商中一次到位的选择。
2. **OpenAI Operator GA**（预计 2026 中）会引爆 Cloud Browser Infra 需求；Mosaiq 在那个时间点已有 Cloud Beta 可接口。
3. **Browserbase B 轮 下一轮 raise**（预计 2026 H1）会拉高赛道的市场关注度。Mosaiq 可以以“由 antidetect engineer 创始的 Browserbase 替代选择”定位，承接 Browserbase 服务不了的中小客户。

---

**下一步**：你审完后告诉我哪几条要改 / 要细化。确认后我可以接着出：
- 《CLOUD-RUNTIME-ARCH.md》（Cloud Runtime 详细架构 + 财务成本模型）
- 《Phase 0 启动文档》双引擎扩充版（招聘 JD、预算明细、技术调研）
- 《Chromium fork 入门技术调研》（编译流水线、最小 patch 示范、上游同步策略）
