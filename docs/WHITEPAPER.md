# Mosaiq 技术与产品白皮书

> **副标题**：为 AI 时代而生的隐身浏览器基础设施  
> **版本**：v1.0 · 2026-05-08  
> **受众**：产品用户 / 工程师 / 投资人 / 行业观察者  
> **阅读时长**：约 35 分钟

> ⚠️ **愿景 vs 现实（2026-05 更新，先读这条）**：本白皮书描述的是 Mosaiq 的**长期产品愿景**（双引擎、Chromium fork、$60–115M ARR）。**当前真实状态**是单人 + AI agent、约 20 天构建出的注入路径 SDK + CLI + 桌面应用 + cloud-runtime alpha（Chromium fork 已冷藏，见 [`chromium-fork/STATUS.md`](../chromium-fork/STATUS.md)）。未来 90 天的**务实**优先级见 [`docs/ROADMAP-90D.md`](./ROADMAP-90D.md)。请把宏大叙事与近期可执行项分开看。

---

## 阅读指南

这份白皮书一共六部分，不同读者可按需挑读：

| 你的身份 | 必读章节 | 选读 |
|---|---|---|
| **第一次听说 Mosaiq 的普通用户** | 第一部分（产品） + 第六部分（路线图） | 第二部分（行业） |
| **想了解技术细节的工程师** | 第三部分（技术） + 附录 C | 第二部分、第四部分 |
| **正在评估的投资人** | 第二部分（行业） + 第四部分（竞争） + 第六部分（路线图） | 第五部分（信任） |
| **关心合规与安全的法务 / 安全官** | 第五部分（信任） | 全部 |

我们假定你不是浏览器内核工程师，所以技术部分会用大量类比与生活化语言。如果你已经是行业老手，跳过比喻直读结论即可。

---

# 第一部分：产品篇 — 我们为什么做 Mosaiq

## 1.1 从一个故事开始

想象你是一位跨境电商运营。你管理着 30 个 Amazon 卖家账号，每个账号都按平台规则属于"独立法人"。Amazon 检测到你用同一台电脑、同一套浏览器登录这 30 个账号，于是把它们全部封号——这是去年你公司损失最大的一次事故。

或者，你是一位 AI Agent 创业者。你的产品需要让 AI 模型自动登录用户的电商后台，下单、回复客户、发货。Anthropic 的 Claude 已经能"看懂"网页并操作鼠标键盘，但 Cloudflare 的 Bot 防护在 70% 的网页上把你的 AI 拦下了——它一眼就识破"这不是真人"。

或者，你是一名数据工程师。你写了 100 行 Playwright 脚本去抓取竞品价格，第一周顺利，第二周开始返回 403，第三周整个 IP 段被封。你尝试加 stealth 插件、换代理、降速，效果忽好忽坏，没有规律。

**这三个故事有一个共同的对手**：网站的"反爬反作弊系统"——它们能在毫秒之内分辨出"这是真人还是机器"。Mosaiq 就是对手的对手。

## 1.2 Mosaiq 一句话介绍

**Mosaiq 是一个基于深度定制 Chromium 内核的"隐身浏览器"基础设施**。它对外提供两种形态：

1. **桌面端（Mosaiq Desktop）**：装在你电脑上的独立浏览器应用，可以创建几百个互相隔离的"虚拟身份"，每个身份都拥有完全独立的指纹、Cookie、IP，让网站无法识别它们来自同一个人。
2. **云端（Mosaiq Cloud）**：一个 API 服务，AI Agent 或自动化脚本只要调用一个 HTTP 接口，就能在云端启动一个真正"像人"的浏览器，并通过标准协议（CDP / Playwright / Stagehand）远程操控它。

两种形态共用同一个 Chromium 内核——这意味着我们一次研发投入，同时服务两个市场。

## 1.3 我们解决的核心问题

现代网站对每一个访问者都会做"身份盘问"。这个盘问极其细致，可能包含：

- 你的浏览器版本、操作系统、屏幕分辨率
- 你的显卡型号、字体列表、时区、语言
- 你的 TLS 握手指纹（俗称 JA3/JA4）
- 你的 HTTP/2 帧发送顺序（**真人浏览器和爬虫工具发送顺序就不一样**）
- 你的鼠标移动曲线、键盘敲击节奏、滚动惯性
- 你画一张图、播一段音、跑一段 JS 时返回的微小差异

**有几百个维度都在被偷偷测量。** 任何一项异常，你就被打上"机器人"标签。

更糟糕的是：现有的"反检测浏览器"工具（Multilogin、AdsPower、GoLogin 等）多数是 5-7 年前的架构，他们用 JavaScript 注入或浏览器插件来"伪造"指纹，但这些伪造在 2026 年已经很容易被识破——就像戴一个粗糙的硅胶面具，远看像，凑近看立刻穿帮。

**Mosaiq 的根本不同**：我们不"伪造"指纹，我们直接修改 Chromium 浏览器的源代码，让它从内核层面**真的就是另一个浏览器**。这就像不是戴面具，而是基因改造——从 DNA 开始就不一样。

## 1.4 三类核心用户

| 用户类型 | 痛点 | Mosaiq 解决方案 |
|---|---|---|
| **跨境电商 / 多账号运营者** | 多账号被关联、被封禁；现有工具被检测站打穿 | Desktop 桌面版，几百个隔离 profile，配真实指纹库 |
| **数据采集 / 自动化团队** | Playwright/Selenium 被风控墙拦截，30-50% 失败率 | Cloud API，一行代码迁移，过 IPHey/CreepJS 100% |
| **AI Agent 创业团队** | OpenAI Operator / Claude / Stagehand 需要可靠浏览器后端 | Cloud + Stagehand 兼容 SDK + MCP 服务，AI 调用即插即用 |

## 1.5 产品形态：双引擎一内核

```
                    ┌─────────────────────────────┐
                    │   共享内核：Chromium fork    │
                    │   • 16 个反检测 patch        │
                    │   • Persona Engine          │
                    │   • License & Telemetry     │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                  ▼
    ┌─────────────────┐               ┌─────────────────┐
    │ Mosaiq Desktop  │               │ Mosaiq Cloud    │
    │ 装在电脑上       │               │ K8s 多租户集群   │
    │ 给"人"用         │               │ 给"程序"用       │
    │ Win/macOS/Linux │               │ REST + CDP API  │
    └─────────────────┘               └─────────────────┘
       对标 Multilogin                  对标 Browserbase
       AdsPower                         Steel.dev
```

一个公司，两个引擎，复合护城河——这是我们与所有竞品最大的不同。Multilogin 等只做桌面，Browserbase 只做云端，Mosaiq 两端通吃。

---

# 第二部分：行业篇 — 为什么是现在？

## 2.1 浏览器自动化的三个时代

回顾过去 15 年，"用程序操作浏览器"经历了三个时代：

**第一代：Selenium 时代（2010-2018）**  
工程师写一行行脚本驱动 Firefox / Chrome，用于测试与简单爬虫。痛点：被网站轻易识破，每次升级都得改脚本。

**第二代：Headless 时代（2018-2024）**  
Puppeteer / Playwright 出现，配合 stealth 插件、代理 IP、CAPTCHA 打码服务，撑起了"商业级爬虫"和"反检测浏览器"两个细分市场。但底层仍是原生 Chromium，反检测靠"打补丁"。

**第三代：AI Agent 时代（2024-2030）**  
OpenAI Operator、Anthropic Computer Use、browser-use、Stagehand——AI 模型直接看屏幕、动鼠标、敲键盘，去自动完成订机票、填表单、买商品这类真人任务。**第三代的需求量级是前两代之和的 10 倍以上**，因为每一个 SaaS 产品都将集成"AI 助手"模式。

```
          需求量级（log 比例）
2010 ┤  ▏Selenium
     │
2020 ┤  ▏▏▏▏ Puppeteer/Playwright + 反检测桌面
     │
2026 ┤  ▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏ AI Agent 浪潮
     │  ↑
     │  我们在这里
```

## 2.2 网站如何识别"机器人"？

主流反爬反作弊系统（Cloudflare Bot Management / DataDome / Akamai Bot Manager / PerimeterX / FingerprintJS Pro）大致用下面五层方法：

**第一层：网络层（你都还没收到 HTML 就被识别了）**
- TLS 握手指纹（JA3 / JA4）：你的浏览器在握手时发送的加密参数顺序、扩展列表，构成一个独特"哈希"。Chrome、Firefox、curl、Python requests 各自不同，**爬虫工具一目了然**。
- HTTP/2 帧顺序：浏览器发请求时，HEADERS 帧和 SETTINGS 帧的发送顺序在 Chrome 和 Python httpx 里不一样。
- ALPN、GREASE 等扩展协议字段。

**第二层：浏览器指纹层**
- Canvas 指纹：让你画一张图，每个机器画出来的像素哈希都有微差。
- WebGL / WebGPU 指纹：暴露你的显卡型号、驱动版本。
- AudioContext 指纹：播放一段音频，硬件细微差异让信号略有不同。
- Font 指纹：枚举你装的字体。
- ClientRects：测量 DOM 元素的精确像素位置（不同字体渲染会有亚像素差异）。

**第三层：JS 行为层**
- `navigator.webdriver = true`（Selenium 默认会暴露）
- `chrome.runtime` 是否存在（无头浏览器与真浏览器有差）
- 各种 JS 函数的执行时序、`performance.now()` 精度

**第四层：行为生物特征层（最难伪造，也是最强的检测）**
- 鼠标轨迹：真人鼠标移动是平滑曲线带轻微抖动，机器人是直线或贝塞尔曲线
- 键盘节奏：真人打字有 dwell time（按下持续时间）和 flight time（按键间隔）的统计分布，机器人均匀
- 滚动惯性：真人触摸板滚动有惯性减速，机器人是匀速

**第五层：上下文行为层**
- 你的 Cookie 历史、登录习惯、浏览路径
- 是否在合理时间访问（你的 IP 时区是中国，但你在凌晨 3 点活跃）
- IP 与浏览器语言是否匹配（IP 在德国，但浏览器是英文）

**关键洞察**：每多过一层检测，作弊难度乘数级增长。停留在 JS 层修补的工具（如绝大多数 stealth 插件）只能过第三层；要过第四层必须改浏览器内核；要过第一层必须改 BoringSSL（Chromium 的加密库）。**这就是 Mosaiq 的护城河所在**。

## 2.3 反检测产品的演进史

| 年代 | 代表产品 | 技术原理 | 现状 |
|---|---|---|---|
| 2018-2020 | MultiloginX、GoLogin v1 | Firefox 改名 + JS 指纹注入 | 大量被识破 |
| 2020-2023 | AdsPower、Multilogin v6 | Chromium 套壳 + 更多 JS hook | 主流，但开始失效 |
| 2023-2025 | Browserbase、Steel.dev | 原生 Chromium + 云端 + Stagehand | 解决了 API，但反检测一般 |
| **2026+** | **Mosaiq** | **Chromium fork + 全栈 patch + AI 友好 + 双引擎** | **新一代** |

行业的代际更迭以 2-3 年为单位。当前所有头部玩家都已经"老了"，但他们的客户黏性还在。这正是新一代产品切入的窗口。

## 2.4 AI Agent 浪潮：新的原生需求

2025 年下半年开始，几个事件改变了浏览器基础设施市场：

- **OpenAI 发布 Operator**（GA 2026 中），让 ChatGPT 能直接操作浏览器
- **Anthropic Claude Computer Use** 已有 10,000+ 企业客户在生产使用
- **browser-use** 开源库 GitHub 半年涨到 30k stars
- **Stagehand** 成为"AI agent 原生浏览器 SDK"事实标准

这些产品都需要一个"真正像人"的浏览器后端。Browserbase 凭借第一个提供这种后端，18 个月做到 6000 万美元 ARR。但 Browserbase 的反检测能力只是"够用"，真到拼检测站通过率，仍然会被打穿。

**Mosaiq 的 Cloud 引擎正是为了切入这个市场**：100% 兼容 Stagehand SDK（迁移只需改一行 endpoint URL），但反检测能力比 Browserbase 强一个数量级。

## 2.5 市场规模

| 细分市场 | 2026 TAM | 2028 TAM | 增长驱动 |
|---|---|---|---|
| 反检测桌面浏览器 | $4 亿 | $7 亿 | 跨境电商持续扩张 |
| 云端浏览器基础设施 | $3 亿 | $15 亿 | AI Agent 浪潮 |
| AI Agent 浏览器层（新品类） | $2 亿 | $12 亿 | OpenAI Operator GA |
| **总计** | **$9 亿** | **$34 亿** | **2 年增长 4 倍** |

**Mosaiq 不需要赢得整个市场**。Year 3 我们的目标是 3.4% 的市场份额，对应 $115M ARR，估值 $500M-$1.5B。

---

# 第三部分：技术篇 — 我们怎么做到的？

> 这一部分给工程师看。如果你不是技术读者，可以快速浏览每一节的标题、读"一句话总结"，跳过深入细节。

## 3.1 技术总览：从用户视角到内核

```
用户调用 SDK
   │
   ▼
┌──────────────────────────────────────────────┐
│       @runova/sdk（TypeScript / Python）      │
│       接口与 Browserbase Stagehand 100% 兼容   │
└──────┬───────────────────────────────────────┘
       │ HTTPS
       ▼
┌──────────────────────────────────────────────┐
│  Cloud Runtime — Mosaiq 自营云服务            │
│  ┌─────────────┐  ┌──────────────────────┐   │
│  │ API Gateway │  │ CDP Gateway          │   │
│  │ Hono + Auth │  │ Go + WebSocket Proxy │   │
│  └──────┬──────┘  └─────────┬────────────┘   │
│         │                   │                │
│         ▼                   ▼                │
│  ┌──────────────┐    ┌──────────────────┐    │
│  │ Pool         │    │ Browser Pod      │    │
│  │ Controller   │───▶│ (Chromium fork)  │    │
│  │ < 2s 冷启动  │    │ + Persona 注入    │    │
│  │ + 数据飞轮   │    │ + Recording      │    │
│  └──────────────┘    │ + Live View      │    │
│                      │ + Humanize 引擎  │    │
│                      └──────────────────┘    │
└──────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────┐
│  Mosaiq Chromium Fork（共享内核）             │
│  16 个 C++ patch：                           │
│  • Persona Bridge（基础设施）                │
│  • Canvas / WebGL / WebGPU / Audio / Font   │
│  • TLS JA3+JA4 / HTTP2 帧顺序                │
│  • Navigator / UA-CH / Screen / Hardware    │
│  • Cookie Jar 隔离 / Timezone / WebRTC      │
└──────────────────────────────────────────────┘
                  │
                  ▼
        gVisor 沙箱 → Linux 内核
```

**整体技术栈分四层**：

1. **客户端 SDK 层**（TypeScript，开源）：开发者唯一接触的接口
2. **云端服务层**（Go + Rust + Cloudflare Workers，闭源）：调度与资源管理
3. **浏览器内核层**（Chromium fork，C++，闭源）：核心反检测能力
4. **数据层**（Persona Engine + Telemetry Pipeline）：身份库 + 数据飞轮

下面分别拆解每个核心模块。

## 3.2 核心技术 1：Chromium Fork 内核（全栈反检测）

### 3.2.1 一句话总结

我们不是给原生 Chrome 打补丁，而是 fork 整个 Chromium 源码（约 3000 万行 C++ + JS），在五层关键代码路径里嵌入 16 个 patch，让浏览器从内核层面就长得不一样。

### 3.2.2 为什么必须 fork，而不能像别人那样"打外挂"？

把"反检测"想象成"伪装"。有三种层次：

| 层次 | 类比 | 例子 | 检测难度 |
|---|---|---|---|
| 1. JS 层 hook | 戴口罩 | `navigator.webdriver = false` | ★ 一眼看穿 |
| 2. 浏览器扩展 | 戴硅胶面具 | puppeteer-extra-plugin-stealth | ★★ 凑近看穿 |
| 3. **内核 patch** | **基因改造** | **Mosaiq 的方法** | ★★★★★ 检测不到 |

JS 层 hook 的根本问题是：**JS 代码可以被 JS 代码反查**。你重写了 `Function.prototype.toString`，对方可以用更深的 JS 技巧检查你重写的痕迹。这是一场永远在 JS 沙箱内的猫鼠游戏，**永远是猫赢**（因为检测站每天分析你最新的伪造痕迹）。

内核 patch 不一样：我们直接改 C++ 编译进去的逻辑，从 V8 引擎、Blink 渲染器、Chrome 浏览器进程到 BoringSSL，一切都从底层就是真的。**没有任何 JS 痕迹可查**——因为根本没有 JS 在做伪装。

### 3.2.3 16 个 patch 分布在哪？

```
Chromium 源码 layered view
┌────────────────────────────────────────────────────────┐
│ 第 5 层：操作系统调用                                   │
│   Patch 0007 Screen / Patch 0008 Hardware              │
├────────────────────────────────────────────────────────┤
│ 第 4 层：Chrome Browser Process（C++）                  │
│   Patch 0013 Cookie Jar / Patch 0014 Persona Bridge    │
│   Patch 0015 WebUI / Patch 0009 Timezone               │
├────────────────────────────────────────────────────────┤
│ 第 3 层：Blink 渲染引擎（C++/HTML/CSS/Canvas/WebGL）    │
│   Patch 0001 Canvas / Patch 0002 WebGL                 │
│   Patch 0003 AudioContext / Patch 0010 Fonts           │
│   Patch 0016 WebGPU（2026 反检测前沿，独家）           │
├────────────────────────────────────────────────────────┤
│ 第 2 层：V8 JavaScript 引擎                             │
│   Patch 0004 Navigator / Patch 0005 UA-CH              │
│   Patch 0006 performance.now / Patch 0009 Date 抖动    │
├────────────────────────────────────────────────────────┤
│ 第 1 层：网络栈（BoringSSL + net/）                     │
│   Patch 0011 TLS JA3+JA4（行业首家）                   │
│   Patch 0012 HTTP/2 帧顺序（行业首家）                 │
│   WebRTC 网卡列表伪装                                  │
└────────────────────────────────────────────────────────┘
```

**Patch 0011 + 0012（网络层）是真正的护城河**。即使别人能复制我们的 JS 层伪装，也复制不了我们对 BoringSSL 的修改——这需要既懂浏览器内核又懂网络协议的工程师，全行业不到 100 人。

**Patch 0016 WebGPU 是 2026 年的前瞻**。WebGPU 在 Chrome 2024 年正式发布后，FingerprintJS 等检测库正在加入 WebGPU 指纹检测。AdsPower、Multilogin、Browserbase **都没覆盖**——我们抢占这个窗口。

### 3.2.4 一个具体 patch 是什么样子？

以 Patch 0001 Canvas Noise 为例（简化版伪代码）：

```cpp
// 原版 Chromium 的 ToDataURL 函数
String HTMLCanvasElement::ToDataURL(...) {
  // 直接把画布像素数据编码成 base64 PNG
  return EncodePixels(pixels, format);
}

// Mosaiq fork 的修改
String HTMLCanvasElement::ToDataURL(...) {
  auto persona = RendererPersonaCache::Get();
  if (persona->canvas_noise_enabled) {
    // 用 persona 绑定的种子，给每个像素加 1 比特的扰动
    AddSubpixelNoise(pixels, persona->canvas_noise_seed);
  }
  return EncodePixels(pixels, format);
}
```

关键设计：**同一个 persona 多次画同一张图，hash 完全一致**（保证不被识破"动态指纹"）；**不同 persona 之间 hash 不同**（每个身份独立）。这种"既稳定又独特"的扰动是反检测核心难点。

### 3.2.5 上游同步纪律

Chromium 每 6 周发布一个大版本，每月数次发布安全补丁。如果你 fork 后停止跟进，三个月后就成"远古浏览器"，被各种安全漏洞、Cloudflare 检测利用。

Mosaiq 承诺：**Chromium stable 发布后 7 天内合入主线**，所有 16 个 patch 自动 rebase（CI 自动跑兼容性测试）。这是行业最快的 SLA：

| 厂商 | 上游同步延迟 |
|---|---|
| Multilogin | 约 30 天 |
| AdsPower | 约 21 天 |
| GoLogin | 约 45 天 |
| Dolphin{anty} | 约 60 天 |
| **Mosaiq** | **≤ 7 天** |

## 3.3 核心技术 2：Persona Engine（数字身份引擎）

### 3.3.1 什么是 Persona？

Persona = 一个**完整连贯的数字身份**。它不只是 user-agent 或 cookie，而是数百个字段构成的一个一致性整体：

```yaml
PersonaProfile (示意):
  identity:
    user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)..."
    user_agent_client_hints:
      brands: [{brand: "Chromium", version: "134"}, ...]
      platform: "Windows"
      platform_version: "10.0.19045"
      mobile: false
      arch: "x86"
      bitness: "64"
    
  display:
    screen: {width: 1920, height: 1080, color_depth: 24}
    viewport: {width: 1536, height: 864}
    device_pixel_ratio: 1.0
    
  hardware:
    cpu_cores: 8
    memory_gb: 16
    gpu_vendor: "NVIDIA"
    gpu_renderer: "GeForce RTX 3070"
    webgpu_adapter: {vendor: "NVIDIA", device: "RTX 3070", ...}
    
  locale:
    timezone: "Asia/Shanghai"
    language: "zh-CN"
    languages: ["zh-CN", "zh", "en"]
    
  network:
    tls_ja4: "t13d1517h2_8daaf6152771_b0da82dd1658"
    http2_frame_order: ["SETTINGS", "HEADERS", "PRIORITY"]
    webrtc_local_ips: ["192.168.1.34"]
    
  fingerprints:
    canvas_noise_seed: 0x7f3a8c41
    audio_noise_seed: 0xb2e5d901
    font_list_hash: "sha256:..."
    
  behavioral:
    typing_dwell_distribution: {mean: 95, std: 23}  # 毫秒
    mouse_speed_curve: "natural_v2"
    scroll_inertia_coefficient: 0.85
```

### 3.3.2 一致性是关键

如果你说自己是"Windows + Chrome 134 + RTX 3070"，那么：
- WebGL 报告的 GPU 必须是 RTX 3070
- WebGPU 适配器信息也必须是 RTX 3070
- User-Agent 报告的版本必须是 Chrome 134
- Canvas 渲染微差异必须符合 NVIDIA 驱动的特征
- 字体列表必须包含 Windows 自带字体（Calibri、Microsoft YaHei...）

**任何一个字段不一致，整个身份就崩塌**。这是 Multilogin 等老牌产品的最大问题：他们让用户随机生成指纹，结果各个字段经常自相矛盾。

Mosaiq 的 Persona Engine 用一个 `PersonaCoherenceEngine` 在生成身份时强制校验所有字段间的相互一致性——比如 macOS persona 一定有 macOS 自带字体，Android persona 一定有 mobile = true 且 touch event 启用。

### 3.3.3 真机指纹库

随机生成是不够的——真实的浏览器指纹有"自然分布"，比如全网 16% 是 1920x1080 屏幕、12% 是 macOS Safari、显卡型号符合 Steam 硬件调查的实际分布。

Mosaiq 的 Persona Pool 计划在 M14 GA 时拥有 **5,000+ 真机采集的指纹**（通过激励系统从真实用户处合规收集），并按地区/操作系统/设备类型加权分布，对比：

| 厂商 | Persona 库规模 | 来源 |
|---|---|---|
| AdsPower | 数千 | 算法生成 |
| Multilogin | 数千 | 算法生成 |
| Browserbase | 没有显式 persona 概念 | 参数随机化 |
| **Mosaiq** | **5,000+ at M14, 25,000+ at Y3** | **真机 + 合规激励采集** |

`@runova/persona-schema` 包将以 **Apache 2.0 开源**，让全行业受益于这个数据格式标准。

## 3.4 核心技术 3：Cloud Runtime（云端浏览器集群）

### 3.4.1 一句话总结

Cloud Runtime 是一个 K8s 多租户集群，用 gVisor 做安全隔离，跑数千个 Mosaiq Chromium fork 的 headless 实例，对外提供 REST + WebSocket（CDP）API。

### 3.4.2 端到端用户路径

```
1. 用户调用 SDK：
   const session = await mosaiq.sessions.create({ persona: "us-mac-chrome" })
       │
2. SDK 走 HTTPS 到 api-gateway：
   POST /v1/sessions  →  返回 ws_url
       │
3. api-gateway 调 browser-pool-controller：
   "给我一个绑定 us-mac-chrome 的 idle 浏览器"
       │
4. pool-controller 在 warm pool 里挑一个：
   • idle 池预热 8 个实例（已启动 Chromium，未绑 persona）
   • 注入 persona 配置（< 800ms）
   • 标记 bound，返回 pod 地址
       │
5. SDK 拿 ws_url 连上 cdp-gateway，开始发 CDP 命令
       │
6. cdp-gateway 透传 CDP 帧到 browser-pod
       │
7. browser-pod 执行 + 录像 + 上报 metrics
       │
8. 用户调 session.close()，pod 进入 draining，pool 补一个新 idle
```

### 3.4.3 < 2 秒冷启动 SLO

Browserbase 创建一个 session 通常需要 3-5 秒（用户实测）。**Mosaiq 的目标是 P95 < 2 秒**。怎么做到？

- **预热 8 个 idle Chromium 实例**：Chromium 启动是冷启动 1-2 秒大头，预热掉
- **persona 注入路径优化**：通过启动命令行参数 `--mosaiq-persona-id=xxx`，让浏览器进程启动时直接读 persona，避免 CDP 注入往返
- **后台 reconciler 监控低水位**：< 5 个 idle 时立即扩容，不等用户请求
- **Prometheus 指标暴露**：`mosaiq_session_create_duration_seconds` histogram 持续监控 P95

### 3.4.4 多租户安全：gVisor

如果一个客户的 session 被攻击，攻击者**不能**通过共享内核漏洞影响其他客户。我们的隔离方案：

```
Linux Kernel
   │
   ├─ gVisor sandbox A  ←  客户 X 的 session 1, session 2, ...
   │     └─ Chromium fork（已被 chrome sandbox 再隔离）
   │
   ├─ gVisor sandbox B  ←  客户 Y 的 session 3, session 4, ...
   │     └─ Chromium fork
   │
   └─ ...（每 16-32 个 session 共享一个 gVisor，每客户单独 namespace）
```

gVisor 是 Google 开源的"用户态内核"，把 syscall 拦截在用户空间执行，攻击者无法触达真实 Linux kernel。**这是 Browserbase 同款的隔离方案**，行业标准。

### 3.4.5 Live View + Recording

用户能实时看到浏览器画面、回放历史 session：

- **Live View**：通过 noVNC + websockify，把 Chromium 的 X11 显示流式传输到 admin-console iframe
- **Recording**：Playwright 内置的 `tracing.start()` 录全程，输出 trace.zip，admin-console 内嵌 Playwright Trace Viewer 直接回放（含 DOM 快照、网络请求、控制台、截图、视频）

## 3.5 核心技术 4：行为模拟引擎（humanize）

### 3.5.1 为什么这个是杀手锏？

回顾 §2.2 的检测五层：第四层"行为生物特征"是**最难伪造的**。即使你的 Canvas 指纹完美，TLS 完美，但鼠标走直线、键盘等距敲击，DataDome 一眼就识破。

**全行业目前没有任何一家把行为模拟做到生产级**。Browserbase 没做，Multilogin 没做，AdsPower 没做。这是我们的独家优势。

### 3.5.2 我们怎么模拟？

`humanize: true` 启用后，Mosaiq 在 CDP 命令路径上注入：

**鼠标移动**：用三阶贝塞尔曲线 + 微抖动 + 偶尔的"小回退"模拟真人手部肌肉颤抖。曲线参数从真人录制库随机抽样。

```
普通机器人：A ────直线───→ B
普通模拟：    A ──贝塞尔──→ B（仍然平滑）
Mosaiq：     A ─~~~曲线~~~→ B（含 1-3 次微小回退、抖动幅度匹配人手生理）
```

**键盘节奏**：每个按键有 dwell time（按下持续时间，正态分布 90-120ms）+ flight time（按键间隔，受字母对影响：'th' 间隔短，'qz' 间隔长）+ 偶尔的 backspace 修正。

**滚动**：触发滚动事件时，用减速曲线模拟惯性而非匀速。在 Mac 触摸板模式下还要加横向微小漂移。

**CDP 命令延迟**：每个 `Input.dispatchMouseEvent` 调用后注入 80-250ms 的随机延迟（正态分布，非均匀），模拟人类反应。

### 3.5.3 模块化与可控

不是所有场景都需要完整 humanize（也会拖慢自动化）。我们提供细粒度开关：

```typescript
const session = await mosaiq.sessions.create({
  humanize: {
    mouse: true,      // 鼠标曲线
    keyboard: true,   // 键盘节奏
    scroll: true,     // 滚动惯性
    delays: false,    // CDP 延迟（关闭以加速）
  }
})
```

Session 1 提供算法版打底（基于数学分布），Session 2-3 升级为基于真人录制的轨迹库回放（更真实，更难检测）。

## 3.6 核心技术 5：Detection Lab + 公开 Leaderboard

### 3.6.1 自检自证

我们不只是说"我们反检测最强"——我们提供工具让任何人验证。

**Detection Lab** 是一个内置的 CLI + Web 工具，会自动跑 5 大检测站：

- browserleaks.com（Canvas / WebGL / TLS / IP / Audio / Font 共 12 项）
- creepjs-8tbo.onrender.com（综合 fingerprint trust score）
- amiunique.org/fingerprint
- pixelscan.net
- iphey.com（IP / TLS / WebRTC）

每跑完一次，输出一个 0-100 的"健康分"，记录在 dashboard，按 persona 维度聚合。

### 3.6.2 公开 Leaderboard

我们做一件**没有任何竞品敢做的事**：定期把 Mosaiq vs Browserbase vs Steel.dev vs Hyperbrowser vs raw Chromium 在所有检测站的得分自动公开。

```
docs/LEADERBOARD.md（每周自动更新）

| 检测站            | Mosaiq Cloud | Browserbase | Steel.dev | raw Chromium |
|-------------------|--------------|-------------|-----------|--------------|
| browserleaks/canvas| 100% ✅     | 75%        | 80%      | 0%          |
| browserleaks/webgl | 100% ✅     | 70%        | 75%      | 0%          |
| creepjs trust     | 100% ✅     | 65%        | 75%      | 30%          |
| ...                                                                |
```

为什么敢公开？**因为我们有信心。** 如果有一天我们不再领先，公开数据会逼我们自己跑去修。这就是 PRD 里强调的"真自检"。

## 3.7 核心技术 6：数据飞轮（超越竞品的真正护城河）

### 3.7.1 飞轮怎么转？

```
       ┌──────────────────────────┐
       │  客户跑 Cloud Session    │
       └────────┬─────────────────┘
                │ 持续上报 telemetry：
                │ • HTTP 状态码异常
                │ • Captcha 触发率
                │ • 域名重定向链
                │ • JS 检测脚本指纹
                ▼
    ┌────────────────────────────┐
    │ Telemetry Pipeline 聚合     │
    │ • 每小时跑一次              │
    │ • 输出 persona_health_score │
    │ • 输出 domain_difficulty    │
    └────────────┬───────────────┘
                 │
                 ▼
    ┌────────────────────────────┐
    │ Persona Pool 自动调权       │
    │ • 低分 persona 衰减权重     │
    │ • 高分 persona 优先派发     │
    │ • 难站点切换强 persona      │
    └────────────┬───────────────┘
                 │
                 ▼
       ┌──────────────────────────┐
       │  下一个客户拿到的 persona │
       │  天然更适合目标域名       │
       └──────────────────────────┘
```

**我们用得越多，Persona 库越聪明，新客户体验越好，吸引更多客户用，飞轮加速。**

Browserbase 没有这个——他们只做 Chromium 隧道，不做 persona 优化。Multilogin 没有云端集中数据，无法跨用户聚合。**这是 Mosaiq 在 18 个月后真正难以被复制的护城河**。

### 3.7.2 隐私保护

数据飞轮容易让人担心隐私。我们的设计：

- **客户级 opt-in**：默认开启可关闭
- **完全脱敏**：永远不存 URL 路径、cookies、payloads，只存抽象信号（"这个 persona 在这个域名遇到了 captcha"）
- **聚合存储**：原始事件 24 小时后强制聚合丢弃
- **GDPR / CCPA 兼容**：用户可一键导出 / 删除

详见第五部分。

---

# 第四部分：竞争与差异化

## 4.1 竞品全景

```
                  桌面端                          云端
    ┌──────────────────────────────────┐ ┌──────────────────────────┐
    │  Multilogin   $60M+ ARR          │ │ Browserbase $60M ARR     │
    │  AdsPower     未公开估 $30M+    │ │ Steel.dev    $30M ARR    │
    │  GoLogin      $15M+ ARR          │ │ Hyperbrowser  ~$10M ARR  │
    │  Dolphin{anty} $20M+ ARR         │ │ Anchor       较新         │
    │  Octo Browser $10M+ ARR          │ │                           │
    └──────────────────────────────────┘ └──────────────────────────┘
                     │                              │
                     └─────────┬────────────────────┘
                               ▼
                     ┌──────────────────────────────┐
                     │  Mosaiq（双引擎跨界）         │
                     │  Year 1 Desktop $1-3M        │
                     │  Year 2 Cloud   $15-40M      │
                     │  Year 3 Combined $48-115M    │
                     └──────────────────────────────┘
```

## 4.2 五大差异化护城河

| # | 差异化点 | Mosaiq | 竞品现状 |
|---|---|---|---|
| 1 | **真 TLS 伪装**（BoringSSL JA3/JA4 + HTTP/2 帧顺序） | ✅ Patch 0011/0012 | 全行业空白 |
| 2 | **真行为模拟**（鼠标曲线 + 键盘节奏 + 滚动惯性） | ✅ humanize 引擎 | 全行业空白 |
| 3 | **真自检公开**（Detection Lab + Leaderboard） | ✅ 每周自动发布 | 全行业空白 |
| 4 | **真 Dev-First**（Day 1 SDK + CLI + MCP + Docker） | ✅ 全开源、所有付费档全开 API | Multilogin / AdsPower 收费门槛高 |
| 5 | **真上游跟进**（Chromium stable ≤ 7 天合入） | ✅ 自动化 CI 保证 | 行业最快 21 天 |

## 4.3 商业差异化：双引擎复合

| 维度 | 单引擎竞品 | Mosaiq 双引擎 |
|---|---|---|
| 研发投入 | 单一产品 | 一个内核两个引擎，边际成本 +30% |
| 用户覆盖 | 桌面或云端单一群体 | 跨境电商 + AI Agent + 自动化全覆盖 |
| 交叉销售 | 不存在 | Desktop 用户升级 Cloud，反之亦然 |
| 数据飞轮 | 局部 | 双端 telemetry 共享，优化更快 |
| 抗周期能力 | 单一市场风险 | 跨境电商遇政策风险时云端业务对冲 |

## 4.4 我们不是什么

为了避免误解，明确划清边界：

- **我们不是 VPN / 代理服务商**：我们集成代理（BrightData、IPRoyal、BYOP），不自己卖 IP
- **我们不是 CAPTCHA 打码服务**：我们集成 2Captcha 等，不自己解决验证码
- **我们不是 RPA 平台**：我们是基础设施，UiPath / Automation Anywhere 这类是我们的**潜在客户**而非竞品
- **我们不是黑灰产工具**：参见第五部分合规边界

---

# 第五部分：信任篇 — 合规、安全、开源

## 5.1 合规边界：我们做什么 / 不做什么

**做的**（合法商业自动化）：
- 跨境电商运营（多账号管理、平台合规自动化）
- 数据采集（在 robots.txt 与法律允许范围）
- AI Agent 应用（用户授权下代为操作自己的账号）
- QA 自动化测试
- 安全研究（红队测试自己授权的目标）

**不做的**：
- 协助破解他人账号、盗号、冒名顶替
- 协助大规模虚假评论 / 刷单
- 协助选举操纵、网络骚扰、信息操纵
- 协助规避制裁名单上的合规要求

我们的服务条款明确禁止上述行为。检测到违规账号将立即停止服务并配合执法部门调查。

## 5.2 安全设计

### 5.2.1 多租户隔离

如 §3.4.4 所述，gVisor 沙箱 + Chromium sandbox 双层隔离。

### 5.2.2 客户数据加密

- **传输层**：TLS 1.3，强制 HSTS
- **存储层**：D1（SQLite）+ Cloudflare R2，所有 PII 字段 AES-256-GCM 加密（密钥用 Cloudflare KMS 托管）
- **API key**：服务端只存 SHA-256 哈希，明文一次性返回（不可恢复）

### 5.2.3 录像与隐私

- 录像默认开启但**仅客户自己可见**（presigned URL 有效期 24h）
- 客户可在 admin-console 一键删除（实际删除而非软删）
- prod 环境保留 30 天后自动 GC
- enterprise 客户可选择**完全不录**

### 5.2.4 端到端可观测性

所有服务用 OpenTelemetry 端到端插桩：
- Trace：每个 API 调用的全链路（admin-console → api-gateway → cdp-gateway → browser-pod）
- Metrics：Prometheus 指标暴露（性能 / 错误率 / SLO）
- Logs：结构化 JSON 日志

客户可对接自有 OTel backend（Jaeger / Datadog / Honeycomb 等），把 Mosaiq trace 与自身系统统一观测。

### 5.2.5 合规认证路线

- **M22**：SOC 2 Type I
- **M30**：SOC 2 Type II
- **M30**：GDPR DPIA 完成
- **M36**：ISO 27001（如客户需要）

## 5.3 开源策略

我们坚信"开源构建信任、闭源构建生意"的平衡：

| 模块 | 许可 | 理由 |
|---|---|---|
| `@runova/persona-schema` | **Apache 2.0** | 推动行业标准，让 Valibot/ArkType 等生态共用 |
| `@runova/sdk` | **Apache 2.0** | 客户可审查、可二次开发 |
| `@mosaiq/cli` | **Apache 2.0** | 让独立开发者方便集成 |
| `@mosaiq/mcp-server` | **Apache 2.0** | AI Agent 生态共建 |
| Detection Lab CLI | **Apache 2.0** | 行业自检标准 |
| **Chromium fork patches** | **闭源** | 这是核心竞争力 |
| **Cloud Runtime 全栈** | **闭源** | 商业产品 |

## 5.4 商业模式

**定价（计划，最终以官网为准）**：

| 档位 | 价格 | 适合 |
|---|---|---|
| **Free**（开发者） | $0/月 | 5 小时 browser-time、10 个 persona |
| **Starter** | $29/月 | 50 小时、100 个 persona、邮件支持 |
| **Pro** | $99/月 | 200 小时、500 个 persona、Slack 支持 |
| **Business** | $399/月 | 1000 小时、2000 个 persona、SLA、专属客户成功 |
| **Enterprise** | 议价 | 无限、自部署选项、SOC 2、专属架构师 |

**计费模型**：browser-minute + persona-count + add-on（代理、captcha solving）。比 Browserbase 主流定价 **低 40%**（$0.06 vs $0.10 per browser-minute）。

---

# 第六部分：路线图与未来

## 6.1 阶段时间线

```
2026
 ├─ Q1-Q2: Phase 0 — 招聘 + 法律主体 + 编译流水线（已进行）
 ├─ Q3:    M5  Cloud Alpha（Fly.io US-East 单 Region，受邀客户）
 └─ Q4:    M9  Desktop Beta（Win/macOS）+ Cloud Beta（公开注册）

2027
 ├─ Q1:    M14 Cloud GA（K8s on GKE，多 Region）+ SOC 2 Type I
 ├─ Q2:    M16 Linux Desktop GA + Cloud EU-West
 └─ Q3-Q4: M22 Enterprise tier launch + APAC region

2028+
 ├─ M30:   SOC 2 Type II + ISO 27001
 ├─ Mobile：Android emulation Cloud（v2.0）
 └─ ...
```

## 6.2 三年财务展望（保守 vs 乐观）

| 指标 | Year 1 (M12) | Year 2 (M24) | Year 3 (M36) |
|---|---|---|---|
| Desktop ARR | $1-3M | $4-8M | $8-15M |
| Cloud ARR | $0.5-2M | $15-40M | $40-80M |
| **总 ARR** | **$1.5-5M** | **$19-48M** | **$48-115M** |
| 估值倍数 | 8-12x | 10-15x | 10-15x |
| 估值 | $12-60M | $190-720M | $500M-1.5B |
| 团队规模 | 8-12 人 | 25-40 人 | 50-80 人 |

## 6.3 长期愿景

> **三年内**：成为全球反检测浏览器市场前 3、AI Agent 浏览器基础设施前 2。  
> **五年内**：行业事实标准。每个跨境电商团队、每个 AI Agent 公司都用 Mosaiq。  
> **十年内**：定义"浏览器即基础设施"这个品类，如同 Stripe 之于支付、Twilio 之于通信、Cloudflare 之于网络边缘。

---

# 附录 A：术语表（小白补完）

| 术语 | 一句话解释 |
|---|---|
| **Chromium** | Google 开源的浏览器内核，Chrome / Edge / Brave / Opera 都基于它 |
| **fork** | 把开源代码完整拷贝一份并独立维护，可以做深度定制 |
| **patch** | 一组对源码的修改，可以独立打入或移除 |
| **CDP** | Chrome DevTools Protocol，浏览器与外部工具通信的标准协议 |
| **Playwright / Puppeteer** | 浏览器自动化框架，通过 CDP 控制浏览器 |
| **Stagehand** | Browserbase 出品的 AI Agent 友好的 SDK，已成为事实标准 |
| **MCP** | Model Context Protocol，Anthropic 主导的 AI agent 工具协议 |
| **指纹（fingerprint）** | 浏览器/设备暴露给网站的各种技术参数组合 |
| **TLS / JA3 / JA4** | 加密握手指纹，能识别"是 Chrome 还是 Python 在请求" |
| **Canvas/WebGL/WebGPU 指纹** | 网站让你画图，根据像素微差识别你的设备 |
| **persona** | Mosaiq 内的"虚拟身份"概念，包含数百个相关字段 |
| **headless** | 无界面浏览器，常用于自动化场景 |
| **K8s（Kubernetes）** | 容器编排系统，行业标准 |
| **gVisor** | Google 开源的"用户态内核"沙箱，提供强隔离 |
| **WebRTC** | 浏览器实时通信协议，会暴露真实 IP，需要伪装 |
| **OpenTelemetry** | 可观测性事实标准，统一追踪/指标/日志 |

---

# 附录 B：常见问题 FAQ

**Q1：Mosaiq 与 Browserbase 的根本区别？**  
A：Browserbase 是基于原生 Chromium + 第三方 stealth 插件搭起来的云服务，反检测靠"打外挂"；Mosaiq 是从 Chromium 内核 fork 出去深度修改，反检测靠"基因改造"。这意味着我们能做到 Browserbase 做不到的：JA3/JA4、HTTP/2 帧顺序、行为生物特征。同时我们 100% 兼容 Stagehand SDK，迁移只需改一行 endpoint URL。

**Q2：Mosaiq 与 Multilogin 的根本区别？**  
A：Multilogin 也声称"反检测桌面浏览器"，但他们的方案是 Chromium 套壳 + JS 注入，本质上还是第二代技术。Mosaiq 是真 fork，且我们额外提供 Cloud API 给 AI Agent 用，他们没有。

**Q3：用 Mosaiq 做事情合法吗？**  
A：取决于你做什么。合法用途（跨境电商账号管理、QA 测试、合规数据采集、AI Agent 代用户操作）我们全力支持。违法用途（盗号、刷单、欺诈）我们的服务条款明确禁止并主动检测拦截。

**Q4：Mosaiq 会被检测站封吗？**  
A：检测是猫鼠游戏。我们做了三件事降低风险：1）内核级 patch 难以被识别；2）真机指纹库不出 outlier；3）公开 Detection Lab 让我们持续自检。即使某一天某一站短暂识破我们，因为是内核改动，修复速度比"插件型"竞品快一个数量级。

**Q5：我现在用 Browserbase / Multilogin，迁移成本多大？**  
A：Cloud 用户：改一行 endpoint URL，Stagehand SDK 100% 兼容。Desktop 用户：我们提供 profile 导入工具，从 Multilogin / AdsPower 一键迁移历史 profile。

**Q6：Persona 库会让我用上别人的"身份"吗？**  
A：不会。每个 persona 都是去标识化的"指纹模板"，绑到客户的 session 上才使用。你的 cookie / 登录状态完全独立，永远不与其他客户共享。

**Q7：你们什么时候融资？多少估值？**  
A：我们正在筹备种子轮 $3-5M，目标投后 $20-30M。详见 [docs/FUNDRAISING-PLAYBOOK.md](./FUNDRAISING-PLAYBOOK.md)。

**Q8：开源吗？**  
A：核心 Chromium fork patches 与 Cloud Runtime 闭源，但所有面向开发者的接口（SDK / CLI / Persona Schema / MCP Server / Detection Lab CLI）都以 Apache 2.0 开源。

**Q9：自部署可以吗？**  
A：M22 Enterprise tier 提供 self-hosted 选项。一般 Cloud 客户使用我们的多租户云服务。

**Q10：和 OpenAI Operator 是什么关系？**  
A：Operator 需要一个浏览器后端来"操作"。Mosaiq 可以作为 Operator 的浏览器后端（通过 MCP / CDP），提供比 Operator 自带的更强反检测能力。我们是它的基础设施，不是竞品。

---

# 附录 C：技术深读索引

如果你想进一步了解：

| 主题 | 文档 |
|---|---|
| 完整产品需求 | [PRD.md](./PRD.md) |
| Cloud Runtime 详细架构 | [CLOUD-RUNTIME-ARCH.md](./CLOUD-RUNTIME-ARCH.md) |
| Chromium Fork 工程指南 | [CHROMIUM-FORK-GUIDE.md](./CHROMIUM-FORK-GUIDE.md) |
| Phase 0 启动计划 | [PHASE-0-LAUNCH.md](./PHASE-0-LAUNCH.md) |
| 投资人 Pitch Deck | [PITCH-DECK-V1.md](./PITCH-DECK-V1.md) |
| 融资 Playbook | [FUNDRAISING-PLAYBOOK.md](./FUNDRAISING-PLAYBOOK.md) |
| 从 Shieldly 迁移 | [MIGRATION-FROM-SHIELDLY.md](./MIGRATION-FROM-SHIELDLY.md) |

---

**版权与联系**

© 2026 Mosaiq. 本白皮书可自由分享与引用，请保留原始出处。

- 主页：https://mosaiq.dev（建设中）
- 邮箱：hello@mosaiq.dev
- 招聘：careers@mosaiq.dev
- 投资人：founders@mosaiq.dev
- GitHub：https://github.com/mosaiq（建设中）
- Discord：（M5 后开放）

---

**文档维护**

- v1.0 · 2026-05-08 · 初稿，对齐 PRD v0.2 / Cloud Runtime v0.1 / Chromium Fork Guide v0.1
- 下次更新：M5 Cloud Alpha 发布时，加入 alpha 客户实测数据与 Detection Lab 实跑结果
