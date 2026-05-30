# Mosaiq Cloud Runtime 架构

> **定位**：Mosaiq Cloud 是多租户 headless Chromium 集群，对外提供 REST + CDP-over-WebSocket API，让 AI agent / 爬虫 / 企业自动化脚本能以 ~$0.06/min 调用一个高质量反检测浏览器。直接对标 Browserbase / Steel.dev / Hyperbrowser，差异化是反检测能力（基于 Mosaiq Chromium fork）。

> **战略地位**：双引擎中 venture-scale 一翼。Year 1 验证（M5 alpha → M14 GA），Year 2 起量（target $20M+ ARR run-rate）。

---

## 0. TL;DR

| 维度 | 决策 |
|---|---|
| **形态** | 多租户 headless Chromium 集群，REST API + CDP-over-WebSocket |
| **API 兼容** | Browserbase Stagehand SDK 100% 兼容（一行 endpoint URL 切换） + Playwright / Puppeteer / Selenium / browser-use |
| **内核** | 复用 Mosaiq Desktop 的 Chromium fork（含全部 15 个反检测 patch） |
| **隔离** | gVisor sandbox + per-session container（K8s pod） |
| **冷启动** | 热启动池实现 < 2s 冷启动延迟（vs. Browserbase ~3–5s） |
| **多 Region** | M14 GA：US-East（首发） / EU-West / APAC-Singapore |
| **计费** | Stripe Metered，per browser-minute + per persona-checkout + Proxy GB |
| **首发定价** | $0.06/min（vs. Browserbase $0.10/min，打 -40% 抢中小客户） |
| **目标毛利** | 70%（住宅 IP 转售毛利受限；Compute 自身 GM ~85%） |
| **预期单位经济** | CAC ~$300，LTV ~$8000，LTV/CAC ~27x |

---

## 1. 系统组件

### 1.1 高层架构

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
  │  R2 资产二进制)│  │  IPRoyal /     │  │  检索)         │
  │                │  │  自营住宅 IP)  │  │                │
  └────────────────┘  └────────────────┘  └────────────────┘
```

### 1.2 组件清单

| 组件 | 技术栈 | 职责 |
|---|---|---|
| **API Gateway** | Cloudflare Workers + Hono | REST 端点（`POST /v1/sessions` 等）、Auth（API key + JWT）、Quota / Rate Limit、Billing Meter 触发 |
| **CDP Gateway** | Go + gorilla/websocket | WebSocket 反向代理，把 client CDP 连接路由到对应 Browser Pool 实例；sticky session（同 session 总路由到同实例） |
| **Browser Pool Controller** | Go + Kubernetes client-go | 监控池容量，预热（warm pool）实例，按需创建/销毁 pod |
| **Browser Pod** | Mosaiq Chromium fork + gVisor + Sidecar | 单 session 单 pod；含 headless Chromium、persona 加载脚本、CDP 端点暴露、metrics 暴露 |
| **Persona Pool Service** | Rust + PostgreSQL + R2 | Persona 库 CRUD；按地区/机型/OS 筛选；R2 存储 persona 资产（字体、历史 cookie 等）；缓存到 Pod 本地 |
| **Proxy Manager** | Go + Redis | 接入 BrightData / IPRoyal / Soax / Oxylabs 多家代理；按 Persona 自动匹配地区；BYOP 用户配置 |
| **Recording Service** | Rust + S3 + DuckDB | 全程 CDP trace 录制；Playwright trace.zip 导出；Session Replay UI 后端 |
| **Observability Stack** | OpenTelemetry + Grafana + Loki + Tempo | metrics / logs / traces；客户可见仪表盘 |
| **Billing Pipeline** | Stripe Metered + ClickHouse | 每分钟聚合 browser-hours 推送到 Stripe；月底对账 |
| **Live View** | noVNC + WebRTC | 用户在管理台看到 session 实时画面 |
| **Admin Console** | Next.js + Mosaiq Cloud SDK | 用户管理台（Web UI），含 sessions 列表、replay、billing、API key 管理 |

---

## 2. API 设计

### 2.1 REST API（创建 session）

```http
POST /v1/sessions
Authorization: Bearer mosaiq_sk_live_...
Content-Type: application/json

{
  "project_id": "proj_xxx",
  "persona": {
    "id": "persona_8a3f...",          // 可选：复用同一 persona
    "filter": {                        // 或者 by filter
      "region": "US",
      "os": "macos",
      "device_class": "desktop"
    }
  },
  "proxy": {
    "type": "residential",             // residential / datacenter / byop
    "country": "US",
    "sticky_session_minutes": 30
  },
  "stealth": {
    "humanize": true,                  // 启用行为生物特征
    "ja4_spoof": true,
    "h2_frame_spoof": true,
    "canvas_noise": "auto"
  },
  "ttl_seconds": 1800,                 // session 最大寿命
  "viewport": { "width": 1920, "height": 1080 },
  "timezone": "America/New_York",
  "locale": "en-US"
}
```

**响应**：

```json
{
  "id": "ses_...",
  "ws_url": "wss://us-east.connect.mosaiq.dev/ses_...",
  "persona_id": "persona_8a3f...",
  "ip": "104.28.x.x",
  "live_view_url": "https://app.mosaiq.dev/sessions/ses_.../live",
  "expires_at": "2026-05-07T18:30:00Z",
  "stagehand_compatible": true
}
```

### 2.2 Stagehand SDK 兼容（关键差异化）

```javascript
// 客户原 Browserbase 代码：
import { Stagehand } from "@browserbasehq/stagehand";
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  apiKey: process.env.BROWSERBASE_API_KEY,
});

// 迁移到 Mosaiq Cloud 仅改一行 endpoint：
import { Stagehand } from "@browserbasehq/stagehand";
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  apiKey: process.env.MOSAIQ_API_KEY,
  apiUrl: "https://api.mosaiq.dev/v1",   // 仅此一行变化
});
// 余下所有调用一行不改。
```

**实现方式**：Mosaiq Cloud API 在 `/v1/sessions` 端点上**镜像 Browserbase 数据格式**，让 Stagehand SDK 无感切换。这是 Cloud GTM 的核心钩子。

> ✅ **口径（v0.11 起）**：「改一行 endpoint」现在迁移的是**连通性 + 进程级加固 + 深层 JS-layer 反指纹**——服务端注入已实现并默认开启（见 §2.5），裸 `connectOverCDP` / BB-SDK baseURL swap 的页面一加载就带 canvas / WebGL / audio / UA-CH / 字体 / worker scope 全套深层伪装。`@mosaiq/cloud-sdk` 的 `injectInto()` 仍可用且与服务端注入幂等。

### 2.3 Playwright / Puppeteer 直连

```javascript
// Playwright
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP(
  'wss://us-east.connect.mosaiq.dev/ses_xxx'
);

// Puppeteer
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.connect({
  browserWSEndpoint: 'wss://us-east.connect.mosaiq.dev/ses_xxx'
});
```

### 2.4 MCP Server（Cloud P1）

让 Claude Computer Use / Cursor / 任意 MCP-compatible agent 直接连：

```json
{
  "mcpServers": {
    "mosaiq": {
      "command": "npx",
      "args": ["-y", "@mosaiq/mcp-server"],
      "env": { "MOSAIQ_API_KEY": "mosaiq_sk_..." }
    }
  }
}
```

**Tools 暴露**：`createSession`、`navigateUrl`、`click`、`fill`、`screenshot`、`extract`、`closeSession` 等。

### 2.5 反指纹注入模型 + 服务端注入（v0.11 已实现）

> 本节记录「云端深层反指纹在兼容路径上未兑现」这一历史矛盾**及其修复**。服务端注入 v0.11 起**已实现并默认开启**——裸 `connectOverCDP`（含 `@browserbasehq/sdk` baseURL swap）现在就能拿到深层 stealth。

**两层模型（现状）：**

1. **进程级（pod 侧）** — `apps/browser-pod/src/persona-flags.ts` 把 persona 翻成 chromium 启动 flag：`--lang`、`--window-size`、`--proxy-server`、WebRTC policy、`--disable-blink-features=AutomationControlled`。所有经 pod 起的 chromium 都带这层。
2. **深层 JS-layer（现默认服务端注入）** — canvas / WebGL / audio / UA-CH / 字体 / worker scope 由 **pod 服务端**注入（`apps/browser-pod/src/inject.ts`），复用 `@mosaiq/sdk` 的 `buildInjectionConfig` + `injectAll`（与 desktop launcher / cloud-sdk 完全同款脚本）。客户端 `@mosaiq/cloud-sdk` 的 `injectInto()` 仍可用，但默认开启服务端注入时无需再调。

**历史矛盾（已消除）**：此前纯 `connectOverCDP` 只拿到第 1 层，深层 stealth 必须靠客户端 `injectInto()`——与「比 Browserbase 强」的定位矛盾。现服务端注入默认开启后，两条路径都拿到全套深层伪装。

**实现机制（`inject.ts` `applyServerStealth`）：**

- pod 在 `spawnChromium` 拿到 internal CDP 后，用自带 `playwright-core` `chromium.connectOverCDP('http://127.0.0.1:<internalPort>')` → `browser.contexts()[0].addInitScript({ content })`，脚本 = `namePolyfill + injectAll.toString() + JSON(config)`。
- **连接保持到 session 结束**：`Page.addScriptToEvaluateOnNewDocument` 随注册它的 CDP session 存活；`killChromium` 先 close 这条连接再 SIGTERM。
- **覆盖客户端页面**：playwright connectOverCDP 的 `Target.setAutoAttach(waitForDebuggerOnStart)` 保证 pod 注册的 init script 在**客户端另一条 connectOverCDP 创建的页面**文档加载前就生效（已用本地 probe + 真 pod 实测验证）。
- **幂等**：`injectAll` 自带 realm 级守卫（`packages/sdk/src/injection/runner.ts`），「服务端注入 + 客户端 injectInto」双重注册同一文档只生效一次。
- **gate / kill-switch**：每 session 受 `stealth.inject`（默认 true，全程透传 `routes/sessions.ts` → `AcquireSpec` → `callPodStart` → pod `StartSchema.stealth`）；pod 受 env `POD_SERVER_INJECT`（默认 true）总开关；任一为 false = raw chromium 模式即时回退。
- **依赖 / Docker**：pod 加了 `@mosaiq/sdk` 依赖；Dockerfile 用 `MOSAIQ_SDK_SKIP_POSTINSTALL=1` 跳过 sdk 的 rebrowser-patch postinstall（那 patch 是给客户端 playwright 的，pod 不需要）。pod 镜像 `docker build` 已验证通过。

**验证状态：**

- ✅ 本地单元：真 pod（`app.ts`→`spawnChromium`→`applyServerStealth`）+ 真 chromium，裸 `connectOverCDP`**不调 injectInto** 即得 `navigator.hardwareConcurrency=8` / WebGL renderer=persona GPU。
- ✅ Docker 构建：pod + cloud-runtime 镜像均构建通过（含 `@mosaiq/sdk`，`MOSAIQ_SDK_SKIP_POSTINSTALL=1`）。
- ✅ **全链路 docker-compose e2e（本地跑绿）**：`docker-compose.local-docker.yml`（cloud-runtime → LocalDocker manager → 经 docker.sock 拉起 pod 容器 → CDP ws 反代）+ `dev-local-docker-smoke.mjs`。`e2e-smoke.mjs` 现含「不调 `injectInto` 也 spoof」断言：实测 `✅ server-side injection active: hardwareConcurrency=8 (no injectInto)`，单 session + 并发 smoke 全绿。
  - 顺带修复：`LocalDockerMachineManager` 的 `podStartTimeoutMs` 35s→75s（与 Fly 对齐；pod 内 chromium boot 默认 60s，35s 会在慢机器上提前 abort 误判 `pod_unhealthy`）。
- ⏳ **待办**：CI（`cloud-runtime-e2e.yml`，ubuntu runner 已自动跑该 smoke）+ Fly 生产侧用同 smoke 跑绿后正式对外承诺。

---

## 3. 关键技术决策

### 3.1 为什么是 K8s 而不是 Fly.io / serverless？

| 候选 | 优势 | 劣势 | 决策 |
|---|---|---|---|
| **Kubernetes（GKE / EKS / 自托管）** | 多 Region 成熟、生态丰富、企业可信 | 运维复杂度高、需 1 名 SRE | **✅ 选定** |
| Fly.io | 多 Region 简单、price 友好 | 生态小、企业客户对 Fly.io 不熟 | M5 alpha 用，M14 GA 迁 K8s |
| AWS Fargate | 无需管理节点 | 价格贵 ~30% | 企业 VPC 部署可选 |
| Cloudflare Workers + Containers | 边缘性能 | 容器是 beta | 观察 |

**M5 alpha 阶段用 Fly.io 起步**（无需 K8s 运维），**M14 GA 前迁 K8s**（成熟运维 + 企业客户 SOC 2 友好）。

### 3.2 隔离方案

| 候选 | 隔离强度 | 性能损耗 | 决策 |
|---|---|---|---|
| **gVisor**（Google 用户态内核 sandbox） | 强 | 10–20% | **✅ 默认** |
| Firecracker（AWS Lambda 同款 microVM） | 极强 | 5–15% | Enterprise 选项 |
| Docker default | 弱 | 0% | ❌ 不可（多租户安全风险） |

理由：gVisor 是 Browserbase / Steel.dev 的共同选择，性能与隔离平衡。

### 3.3 冷启动 < 2s 怎么实现？

**核心**：热启动池（Warm Pool）。

```
[预热池 50 实例 (idle, browser already started)] 
  ↓ session 创建请求
[挑选 idle 实例 → bind persona → 返回 ws_url]  ← 1.5s
  ↓
[后台立即创建新 idle 实例填补空缺]
```

**对比 Browserbase**：他们冷启动 ~3–5s（公开数据），我们目标 < 2s 是真实可达的（K8s pod 已 running，仅需 bind persona + 启动 browser session ≈ 1s）。

### 3.4 Persona Pool 数据飞轮

> **这是 Cloud 端独有的 moat**。

每个 Cloud session 完成后：
1. CDP trace 自动汇总（脱敏后）
2. 检测信号回流（哪些 persona 在哪些站点被识破，响应码 / 重定向 / Captcha）
3. Persona Engine 后台批处理：识破率高的 persona 衰减权重，新 persona 上线
4. **Cloud 用户用得越多，Persona 库越好**——Browserbase 没有这个机制

**Desktop 用户也贡献**（opt-in，匿名遥测）：让数据飞轮覆盖两端。

---

## 4. 财务成本模型

### 4.1 单位经济（per browser-hour）

| 项 | 成本 |
|---|---|
| K8s pod compute（GKE n2-standard-2，spot）| **$0.012/hr** |
| 流量出入（多 Region 平均） | **$0.005/hr** |
| 存储（持久化 + recording） | **$0.002/hr** |
| 监控 / 日志 | **$0.001/hr** |
| **小计 compute 成本** | **$0.020/hr** |
| 住宅 IP（按 Pro plan 含 5GB / 200hrs ≈ 25MB/hr，BrightData $5/GB） | **$0.125/hr** |
| **总成本（含 IP）** | **$0.145/hr** |
| **售价（Pro plan）** | **$99 / 200hrs ≈ $0.495/hr** |
| **毛利（含 IP）** | **70.7%** |
| **毛利（不含 IP，BYOP）** | **96.0%** |

**关键洞察**：BYOP（用户自带代理）模式毛利可达 95%+，这是企业客户和 AI agent 公司的偏好。Mosaiq Cloud 应该**主推 BYOP + 可选 managed proxy**，而不是绑定代理。

### 4.2 24 个月 ARR 预测（敏感性分析）

**保守场景**（NPS = 40，转化率 5%，月流失 5%）：

| 月 | MRR | ARR run-rate | browser-hours/月 |
|---|---|---|---|
| M5（alpha） | $0 | $0 | 5k |
| M14（GA） | $30k | $360k | 100k |
| M18 | $150k | $1.8M | 600k |
| M24 | $500k | $6M | 2.5M |

**中性场景**（NPS = 55，转化率 8%，月流失 4%）：

| 月 | MRR | ARR run-rate | browser-hours/月 |
|---|---|---|---|
| M5 | $0 | $0 | 5k |
| M14 | $50k | $600k | 200k |
| M18 | $300k | $3.6M | 1M |
| M24 | $1.5M | $18M | 6M |

**乐观场景**（NPS = 70，转化率 12%，月流失 3%，OpenAI Operator 助推）：

| 月 | MRR | ARR run-rate | browser-hours/月 |
|---|---|---|---|
| M5 | $0 | $0 | 5k |
| M14 | $100k | $1.2M | 400k |
| M18 | $700k | $8.4M | 2.5M |
| M24 | $3M | $36M | 12M |

**PRD §6.1c 引用的是中性场景的 ARR**。

### 4.3 基础设施月度成本预估

| 阶段 | browser-hours/月 | K8s 成本 | IP 成本 | 总基础设施成本 | 总收入 | 毛利率 |
|---|---|---|---|---|---|---|
| M5 alpha | 5k | $100 | $0（free tier） | $100 | $0 | — |
| M14 GA | 200k | $4k | $20k | $24k | $50k | 52% |
| M18 | 1M | $20k | $100k | $120k | $300k | 60% |
| M24 | 6M | $120k | $600k | $720k | $1.5M | 52% |

**注**：早期毛利低（52–60%），Year 2 后随规模 + BYOP 比例上升到 70%+。

---

## 5. 安全 / 合规

### 5.1 多租户隔离

- **每 session 独立 K8s pod**，gVisor sandbox
- **网络隔离**：每 pod 仅可访问目标网站 + Mosaiq 内部 metrics 端点；不可互访
- **Persona 资产加密存储**：R2 + AES-256-GCM
- **Recording 存储**：S3 server-side encryption + 客户密钥可选

### 5.2 SOC 2 Type I（M14 启动准备 → M22 完成）

要求清单：
- [ ] Audit log（所有 API 调用记录 12 月）
- [ ] IAM with MFA（员工 + 客户）
- [ ] 加密 at-rest + in-transit（TLS 1.3 only）
- [ ] 数据备份 + DR 演练
- [ ] 事件响应 playbook
- [ ] 第三方渗透测试（每年一次）
- [ ] Vendor management（BrightData / IPRoyal / AWS / GCP DPA）

### 5.3 合规边界

- **GDPR**：客户即"data controller"，Mosaiq Cloud 是"data processor"；签 DPA
- **CCPA**：同上
- **PIPL**（中国）：Cloud Region 在中国大陆**不部署**；中国客户访问海外 Region 由其自负
- **ToS**：客户承诺合规使用，禁止：DDoS、身份盗用、未授权测试、违反目标平台 ToS

---

## 6. 团队与里程碑

### 6.1 Cloud 子团队（M14 GA 前需到位）

| 角色 | 职责 | 何时到位 |
|---|---|---|
| **Cloud Infrastructure 工程师**（Sr） | K8s + gVisor + 多 Region；与 Chromium 内核团队对接 | M3（Cloud 架构设计前） |
| **Backend 工程师**（API + Billing） | Go/Rust + Cloudflare Workers + Stripe Metered | M5 |
| **DevOps / SRE** | 监控 / 告警 / 事件响应 | M10 |
| **Solutions Engineer**（pre-sales + 客户成功） | 大客户技术对接 + 集成支持 | M14 |

**总 Cloud 子团队规模**：M5 1 人 → M14 3–4 人 → M24 6–8 人。

### 6.2 关键里程碑（呼应 PRD §7.2）

| 月 | 里程碑 | 验收 |
|---|---|---|
| **M3** | Cloud 架构定稿 | 本文档 v1.0 + 内核团队签字 |
| **M5** | Cloud Alpha | 10 客户跑通 Stagehand + Playwright；100 sessions/日；P0 bugs ≤ 2 |
| **M7** | Persona Pool Service GA | Desktop / Cloud 双端互通；月度新增 ≥ 200 persona |
| **M9** | Live View / Recording GA | 客户可在 UI 看 session、回放 trace |
| **M11** | Cloud Public Beta | 全开注册；500 注册；75 付费；P1 bugs ≤ 5 |
| **M14** | **Cloud GA** | 多 Region；SLA 99.9%；Stripe Metered 计费稳；SOC 2 Type I 审计启动 |
| **M16** | MCP server | Claude Computer Use / Cursor 直连可用 |
| **M22** | SOC 2 Type I 完成 | 第三方审计通过 |
| **M24** | $1.5M+ MRR | run-rate $18M+ ARR |

---

## 7. 与 Browserbase 的细粒度对比

| 维度 | Browserbase 现状（2026 Q1） | Mosaiq Cloud 目标（M14 GA） |
|---|---|---|
| 内核 | raw Chromium + Playwright stealth plugin | **真 Chromium fork + 15 patch** |
| IPHey 通过率 | ~75% | **目标 100%** |
| BrowserScan 通过率 | ~85% | **目标 100%** |
| CreepJS bot detection | 部分识破 | **unique（不可识别）** |
| TLS / JA4 spoof | 部分（基于 patchright） | **全量（BoringSSL 层 patch）** |
| HTTP/2 frame order | 无 | **全量** |
| Persona 库 | 无（仅参数化随机） | **真设备指纹库 5000+** |
| Stagehand SDK | 原生 | **100% 兼容** |
| Playwright / Puppeteer | 原生 | 原生 |
| MCP server | 部分（Claude integration） | **全量（M16）** |
| Live View | ✅ | ✅ |
| Recording / Replay | ✅（Stagehand observed） | ✅ |
| Captcha solver | ✅（reCAPTCHA + hCaptcha） | M20 |
| 价格（per min） | $0.10 | **$0.06（-40%）** |
| Free tier | $1/1h | **$0/5h** |
| 自托管选项 | ❌ | Enterprise 可选（M22 后） |
| 开源 SDK | Stagehand 开源 | **Stagehand 兼容 + 自有 mosaiq-sdk 开源 + Persona Schema 开源** |
| 多 Region | US-East / EU-West | **US-East（M14） + EU-West（M16） + APAC（M18）** |
| SOC 2 | Type II ✅ | **Type I（M22）→ Type II（M30）** |

---

## 8. 风险与对策

| 风险 | 影响 | 概率 | 对策 |
|---|---|---|---|
| Browserbase 价格反降 -50% | 高 | 中 | 利润主要在 BYOP（毛利 95%）；价格战只伤 managed proxy 用户 |
| K8s 多租户安全事件 | 致命 | 低 | gVisor + 渗透测试 + bug bounty；SOC 2 Type I 强制 |
| BrightData API 涨价 / 拒服 | 高 | 中 | 同时接 IPRoyal / Soax / Oxylabs 三家；BYOP 是默认 |
| Chromium fork 跟主线落后 | 高 | 中 | 内核团队同时服务 Desktop + Cloud，Cloud 默认跟最新 stable |
| OpenAI Operator 不开放 API | 中 | 低 | Operator 是 OpenAI 闭环；我们瞄准的是**用 Operator-style 自建 agent 的公司**，不是 Operator 本身 |
| 客户用 Cloud 干灰产 → Stripe 封我们 | 高 | 中 | 用 Paddle MoR 兜底；客户审核 + 流量监控；ToS 严格 |
| Persona 库被竞品反向工程 | 中 | 中 | 服务端不下发原始 persona；客户端只看到生效后的 navigator/screen 等 |

---

## 9. 待你确认的关键决策

| # | 问题 | 选项 | 默认建议 |
|---|---|---|---|
| 1 | M5 alpha 用 Fly.io 还是直接 K8s | Fly.io / GKE / EKS | **Fly.io 先起步，M14 前迁 GKE** |
| 2 | Stagehand SDK 兼容是 P0 还是 P1 | P0（M5 alpha） / P1（M11） | **P0 — 这是 GTM 的核心钩子** |
| 3 | BYOP 是否默认开启 | 默认开 / 默认关 | **默认开** — 保护毛利率，企业偏好 |
| 4 | 自有住宅 IP 池是否做 | 做 / 不做 | **不做**（法律灰区，IP 质量也不行） |
| 5 | 首发 Region | US / EU / APAC / 多发 | **US-East 单 Region GA**，3 个月内加 EU |
| 6 | 是否做 Captcha solver | 自做 / 集成 2Captcha / 不做 | **集成 2Captcha 先**（M14），自做 M20 |
| 7 | Pricing：跟 Browserbase 还是定差异 | 跟 / 低 -40% / 高端定位 | **低 -40% 抢中小** |

---

**版本**：v0.1（2026-05-07，与 PRD v0.2 同步）
**owner**：Cloud Infra 工程师 + 创始人
**下次更新**：M3（Cloud 架构定稿）
