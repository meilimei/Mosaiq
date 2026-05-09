# Phase 0 启动文档

> **Phase 0 = 从今天到正式 M1（团队基础设施搭建完成）的过渡期，预计 2–3 个月。**
>
> 这份文档是**可执行的行动清单**，每一项都有 owner、deadline、产出物。

---

## 0. 执行状态总览

| 工作流 | 责任人 | 状态 | 完成时间 |
|---|---|---|---|
| 法务主体 | 创始人 | 未启动 | T+45 天 |
| 资金到位 | 创始人 | 未启动 | T+30 天 |
| Chromium 联创/工程师招募 | 创始人 | 未启动 | T+60 天 |
| 品牌确定（含商标） | 创始人 + 品牌顾问 | 未启动 | T+30 天 |
| 基础设施 / 域名 / 仓库 | 创始人 | 未启动 | T+15 天 |
| Phase 0 投资人 / 顾问对接 | 创始人 | 未启动 | T+30 天 |

> T = Phase 0 第 0 天（你拿到 PRD 的次日）。

---

## 1. Week 1（T+0 ~ T+7）— 立刻可做

### 1.1 域名与基础设施

| 任务 | 工具 | 预算 | 备注 |
|---|---|---|---|
| 注册 `mosaiq.io` / `mosaiq.app` / `mosaiq.com` | Cloudflare Registrar | $30/年/个 | 至少抓 2 个；若 `mosaiq` 全部被占，候选 `personoapp.com` / `identica.app` / `forgebrowser.com` |
| GitHub Org 创建（独立于 Shieldly） | GitHub | 免费 | Org 名 `mosaiq` 或 `mosaiq-browser` |
| 邮箱（zoho/google workspace） | Google Workspace | $6/月/人 | `founders@mosaiq.io`、`hr@mosaiq.io` |
| Slack / Discord workspace | Free tier 起步 | $0 | 远程团队协作 |
| Figma 团队 | Figma | $15/月/人 | UI 设计 |
| Linear（项目管理） | Linear | $8/月/人 | 替代 Jira |
| Notion 团队 wiki | Notion | $10/月/人 | 内部文档 |

**Week 1 总开支**：约 ¥1500–3000

### 1.2 品牌名最终决定

PRD §11 候选清单：

| 名 | 优势 | 劣势 |
|---|---|---|
| **Mosaiq** | 拼写罕见、域名好抓、寓意"身份的马赛克" | 可能与"mosaic"混淆，发音不直观 |
| **Persono** | 含义直白 | 域名难抓、过于"产品名" |
| **Forge** | 工艺感、强烈 | 通用词、商标难注册 |
| **Identica** | 国际感 | 与 Identi.ca（已死的开源社交）冲突 |
| **Kiln** | 罕见、好记 | 含义不明 |
| **NestFox** | 动物 + 隐喻 | 冲撞 Mozilla Firefox 商标家族 |
| **Klone** | 短、易记 | 过于"copy" 暗示 |

**建议先做的事**：

1. 用 [Namechk](https://namechk.com/) 跑一遍候选名的全平台占用情况
2. 用 [TMView](https://www.tmdn.org/tmview/) 跑商标查询（重点检查 Class 9/42 — 软件 / SaaS）
3. 跟 3–5 位目标用户做盲测："听到这个名字第一反应是什么产品"

**T+7 deadline**：决定终选名 + 开始商标注册流程。

### 1.3 法务主体启动

| 任务 | 服务商 | 预算 | 备注 |
|---|---|---|---|
| 新加坡有限责任公司（Pte Ltd） | [Sleek](https://sleek.com/sg/) / [Osome](https://osome.com/sg) | SGD 1500–3000 一次性 + SGD 100/月 | 包含 nominee director、registered address |
| 商标注册（Madrid 系统） | 本地 IP 律师 | $1500–3000/类 / 国家 | 起步至少在 SG + US + EU + CN 注册 |
| 用户协议 / 隐私政策起草 | TermsFeed / iubenda 起步，律师定稿 | $200/年（自动模板）+ $2000–5000 律师 | 必须含 GDPR / CCPA / PIPL 兼容 |
| 银行账户 | Aspire / Wise Business / DBS | 免费 / $50/月 | Aspire 接入 Stripe / PayPal 友好 |

**Week 1 法务行动**：

- [ ] 联系 Sleek 或 Osome，启动新加坡公司注册
- [ ] 收集创始人资料：护照扫描、地址证明、银行参考
- [ ] 草拟股权架构（含未来 ESOP 池子，建议预留 15–20%）

---

## 2. Week 2–4（T+7 ~ T+30）— 团队启动

### 2.1 招聘需求矩阵（双引擎版）

| 角色 | 必要性 | 月薪（远程，按 7-9 折一线市场） | 招聘渠道 |
|---|---|---|---|
| **Chromium 内核工程师 / 联创** | ⭐⭐⭐⭐⭐ | ¥40k–60k 或股权 5–15% | 见 §2.2 |
| **Chromium UI 工程师（C++ views/cocoa + WebUI）** | ⭐⭐⭐⭐ | ¥35k–55k | LinkedIn 反查 Brave/Vivaldi/Edge UI team、Chromium chrome/browser/ui CL 作者名单 |
| **Cloud Infrastructure 工程师（K8s + gVisor + 多租户）** | ⭐⭐⭐⭐⭐ | ¥40k–55k 或股权 1–3% | LinkedIn 反查 Browserbase / Apify / Browserless / Steel.dev / Cloudflare Workers / Fly.io 现任及前任员工 |
| **前端 React 工程师（WebUI + Admin Console）** | ⭐⭐⭐ | ¥25k–35k | 国内 BOSS / Lagou、远程拓宽到东南亚 |
| **后端 / DevOps（Cloudflare + K8s SRE）** | ⭐⭐⭐⭐ | ¥30k–45k | Cloudflare community、CNCF 贡献者、GitHub K8s topic |
| **反指纹研究员**（兼 PM） | ⭐⭐⭐⭐ | ¥30k–50k 或合伙人 | r/automation、anti-detect 社区、爬虫圈 |

### 2.1b Cloud Infrastructure 工程师在哪找

这个角色比 Chromium 内核好找得多，但同样关键：

1. **Browserbase / Steel.dev / Hyperbrowser / Anchor Browser 离职员工** — LinkedIn 反查，这些公司全为创业公司，人员流动性高
2. **Cloudflare Workers 内部 / Fly.io / Hetzner 社区**—多租户边缘计算专家
3. **CNCF 贡献者**（kubernetes / containerd / gVisor / runc 作者名单）
4. **Apify / Browserless / Bright Data Cloud 集群运维团队**—这些公司里服务于浏览器集群的 SRE
5. **AWS Container Runtime、Google Cloud Run 产品团队离职人员**

**Cloud Infra 联创 / 首席 JD 草稿**：

```
[公司：Mosaiq] 寻找 Cloud Infrastructure 联创 / 首席 Cloud 工程师

我们在做：下一代反指纹云端浏览器基础设施。
对标：Browserbase（$60M ARR / $300M 估值）、Steel.dev、Hyperbrowser。
差异化：基于我们自有 Chromium fork，反检测质量远超 Browserbase。

你的工作：
- 从 0 到 1 设计与实现 Mosaiq Cloud Runtime
- K8s + gVisor 多租户 headless Chromium 集群
- CDP-over-WebSocket Gateway、Persona Pool Service、Proxy Manager
- M5 alpha 上线、10 家客户；M14 GA，多 Region；目标 M24 跑到 $18M+ ARR run-rate
- 与 Chromium 内核团队携手设计 headless mode 下的 patch 调用链路

我们要的人：
- 4 年以上 Kubernetes 生产运维 + 资深多租户集群设计经验
- 熟悉 gVisor / Firecracker / Kata Containers 任一隔离方案
- 熟悉 Chrome DevTools Protocol（CDP）与 Playwright/Puppeteer 主接口
- 熟悉 Cloudflare Workers、Fly.io、GKE / EKS 主要服务商
- 能读写 Go / Rust

我们提供：
- 1–3% 股权（Cloud 联创身份）
- 月薪 ¥40–55k
- 远程工作 + 年度线下集中
- 参与一个明确 venture-scale 赛道（AI Agent Browser Infra）的机会

联系：founders@mosaiq.io
```

### 2.2 Chromium 工程师在哪找

国内极度稀缺，但**这些渠道可达**：

1. **腾讯 / 字节 / 阿里前 Chromium 团队的离职名单** — LinkedIn 反查"Chromium" / "Blink" / "V8" 关键词 + 公司
2. **Brave / Edge / Vivaldi / Yandex 浏览器前员工** — Chrome 渠道圈子小，HR 圈有人能介绍
3. **Chromium 上游 commit 作者**（[chromium-review.googlesource.com](https://chromium-review.googlesource.com/)）— 直接看谁在给 Chromium 提 commit，发邮件
4. **GitHub `chromium` topic + Star 数高的 fork**（如 ungoogled-chromium、Bromite 维护者）— 直接联系
5. **俄罗斯 / 乌克兰反指纹圈** — Multilogin（爱沙尼亚）、Octo（地下俄圈）的核心工程师多在这里；Telegram 群组活跃；时区差合理
6. **Linux Plumbers / BlinkOn / FOSDEM 浏览器分论坛参会者名单**

**Chromium 联创的 JD 草稿**：

```
[公司：Mosaiq] 寻找 Chromium 内核技术联创 / 首席浏览器工程师

我们在做：基于 Chromium fork 的下一代反指纹浏览器。
对标：Multilogin、Octo Browser、AdsPower、GoLogin。
差异化：业内首家 BoringSSL 层 JA3/JA4 patch + 行为生物特征模拟。

你的工作：
- 主导 Chromium fork 的 patch 设计与实现（首期 10 个 patch）
- 建立上游 stable 同步流水线（7 天内合入新版本）
- 设计 Persona 一致性引擎的 native 层接口
- 招募并带 1–2 名后续 C++ / 内核工程师

我们要的人：
- 5 年以上 Chromium / Blink / V8 / Skia 任一组件的深度修改经验
- 熟悉 BoringSSL、HTTP/2、QUIC 协议栈
- 能独立从源码编译、调试、回归测试 Chromium
- 英文能读写 Chromium 设计文档

我们提供：
- 5–15% 股权（与首席工程师身份匹配）
- 月薪 ¥40–60k（视资源情况）
- 远程工作 + 年度线下集中
- 长期建立全球范围浏览器内核团队的机会
- 直接对标 SaaS 年营收 $30M+ 的赛道（AdsPower 估算）

工作地点：远程 / 新加坡（可签证）/ 中国（深圳 / 杭州 / 上海皆可）

联系：founders@mosaiq.io（PGP 公钥附件）
```

### 2.3 备用方案：找不到 Chromium 工程师怎么办

按风险递增：

1. **付费咨询 / 短期合同**：找 Chromium 老兵做 10–20 小时/周的技术顾问，自己 + 其他 C++ 工程师慢慢学。代价：进度慢 50%。
2. **基于现有 fork 起步**：从 ungoogled-chromium / Bromite / Brave 的 patch 集合开始，学习他们如何组织 patch。但**这些 fork 的 patch 不为反指纹设计**，价值有限。
3. **委托 Chromium 咨询公司**：[Igalia](https://www.igalia.com/)、[Eyeo](https://eyeo.com/) 的部分团队、国内深圳/广州做嵌入式浏览器的小厂可定制开发。代价：¥80–200 万/期，单点风险高。
4. **退回路径 A**（轻量插件版）：如果 6 个月还没找到，认真重新评估是否回退。

---

## 3. Week 4–8（T+30 ~ T+60）— 资金到位

### 3.1 三种资金路径

| 路径 | 适合 | 优劣 |
|---|---|---|
| **A. 自有资金 / Bootstrap** | 你已有 ¥300 万+ 闲置 | 无股权稀释，但失败赔光；推进慢 |
| **B. 天使轮（¥500 万–1500 万 / $70k–200k）** | 有相关创业 / 投资人脉 | 稀释 10–25%；常见配套：FA 顾问 |
| **C. 战略投资 / 行业内 LP** | 有跨境电商 / 自动化老板朋友 | 估值最低 / 资源最强；时间长 |

### 3.2 天使轮 Pitch Deck 大纲（10 页）

1. **Cover**：Mosaiq — The most truthful disguise（一句话定位）
2. **Problem**：5000 万跨境电商 / 营销 / 增长黑客每天因账号被封损失收入
3. **Market**：年营收 $30M+ 的 AdsPower、$50M+ 的 Multilogin 估值，加速 33% CAGR
4. **Solution**：5 大差异化（TLS / 行为模拟 / 自检 / Dev-First / 上游跟进）
5. **Why Now**：检测技术升级（Akamai/Cloudflare 上 AI），现有竞品技术债 3–5 年
6. **Traction**：（暂无产品）→ 用 Shieldly 5k 用户基础证明执行力
7. **Business Model**：5 档定价，60% 毛利，CAC payback < 2 月
8. **Competition**：竞品矩阵图（差异化突出）
9. **Team**：创始人 + Chromium 联创（如已签）+ 顾问
10. **Ask**：¥1000 万 18 月 runway，留 15% ESOP

### 3.3 投资人对接 Targets

- **国内**：经纬创投、红杉中国（Cyber/SaaS 组）、源码资本（开发者工具组）、明势资本、五源资本
- **海外**：Sequoia US（开发者工具）、a16z（crypto + dev tools）、Index Ventures、Hummingbird
- **行业 LP**：跨境电商上市公司高管（安克、SHEIN 系）、自动化爬虫圈头部团队

**注意**：这个赛道在国内一线 VC 中**普遍合规审查不过**（涉及"灰产"标签）。建议优先海外 VC + 战略 LP。

---

## 4. 详细预算（18 月跑道）

### 4.1 人力开支（双引擎版）

| 角色 | 人数 | 月薪 | 月开支 | 12 月开支 | 18 月开支 |
|---|---|---|---|---|---|
| 创始人 | 1 | ¥30k | ¥30k | ¥36 万 | ¥54 万 |
| Chromium 联创 / 内核工程师 | 1 | ¥50k | ¥50k | ¥60 万 | ¥90 万 |
| 高级 C++ 工程师 | 1 | ¥40k | ¥40k | ¥48 万 | ¥72 万 |
| Chromium UI 工程师（C++ views + WebUI） | 1 | ¥40k | ¥40k | ¥48 万 | ¥72 万 |
| **Cloud Infrastructure 工程师（K8s + gVisor）** | **1** | **¥45k** | **¥45k** | **¥54 万** | **¥81 万** |
| 前端 React 工程师（WebUI + Admin Console） | 1 | ¥30k | ¥30k | ¥36 万 | ¥54 万 |
| 后端 / DevOps / SRE | 1 | ¥35k | ¥35k | ¥42 万 | ¥63 万 |
| 反指纹研究员 / PM | 1 | ¥35k | ¥35k | ¥42 万 | ¥63 万 |
| **小计** | **8** | | **¥305k/月** | **¥366 万** | **¥549 万** |

> 中国 / 海外混合团队，按 7–8 折市场价 + 部分股权补偿可压到 ¥240k/月。

> **双引擎版 vs 原 Desktop 只版增量**：+1 人（1 名 Cloud Infra 工程师），+¥81 万 / 18 个月（+ DevOps 从 ¥30k 提到 ¥35k、前端从 ¥28k 提到 ¥30k、反指纹从 ¥35k 提到 ¥35k，实际总增量 ¥93 万）。**Cloud 联创在 M5 alpha 前不是必要的**，可以 M3–M4 才到位，为资金最严峻的前 2 个月节省 ¥10 万。

### 4.2 基础设施 / 服务开支

| 项目 | 月开支 | 12 月 | 18 月 |
|---|---|---|---|
| Chromium build server（自购 1 台 + AWS spillover） | ¥6k | ¥7.2 万 | ¥10.8 万 |
| GitHub Enterprise（私有 + Actions 分钟） | $50 | ¥4.3k | ¥6.4k |
| Cloudflare Workers + R2 + KV + D1 | $200 | ¥1.7 万 | ¥2.6 万 |
| Apple Developer + Notarization | $99/年 | ¥0.7k | ¥1k |
| Windows EV Code Signing 证书（DigiCert） | $700/年 | ¥5k | ¥7.5k |
| Sentry / OpenTelemetry 错误监控 | $50 | ¥4.3k | ¥6.4k |
| Postman / API 工具 | $30 | ¥2.6k | ¥3.9k |
| Figma + Linear + Notion + Slack | $300 | ¥2.6 万 | ¥3.9 万 |
| Persona 真机指纹采集（实验室设备 + 部分外包） | ¥10k | ¥12 万 | ¥18 万 |
| **Cloud Runtime 基础设施**（M5 alpha 起，12 月逐月增长） | ¥5k—30k | ¥10 万 | ¥25 万 |
| **Cloud Region 容量预留**（GKE / Fly.io 多 Region，M12+） | ¥1k–8k | ¥2 万 | ¥9 万 |
| **住宅 IP 预付 batch deal**（BrightData / IPRoyal Year 1 预付） | ¥— | ¥10 万（仅 batch） | ¥20 万 |
| **小计** | | **¥53 万** | **¥102 万** |

### 4.3 法务 / 合规 / 营销

| 项目 | 一次性 | 月开支 | 18 月总 |
|---|---|---|---|
| 公司注册 + 注册地址 | ¥3 万 | ¥0.5k | ¥3.9 万 |
| 商标注册（5 国 / 2 类） | ¥10 万 | — | ¥10 万 |
| 用户协议 / 隐私 / DPA 律师 | ¥4 万 | — | ¥4 万 |
| 财务 / 税务（外包） | — | ¥3k | ¥5.4 万 |
| 早期营销（PR、affiliate、Reddit AMA） | — | ¥10k | ¥18 万 |
| **小计** | | | **¥41 万** |

### 4.4 应急储备

PRD 风险登记册中所有风险一旦发生，按 30% buffer：

**应急预算**：¥130 万（占总预算 ~22%）

### 4.5 总预算汇总（双引擎版）

| 项 | 18 月预算 |
|---|---|
| 人力 | ¥549 万 |
| 基础设施 | ¥102 万 |
| 法务 / 合规 / 营销 | ¥41 万 |
| 应急储备 | ¥150 万 |
| **合计** | **¥842 万** |

> 与 PRD §0 估算的 ¥350–500 万差距：PRD 做的是 12 月最小启动估算；这里是 18 月完整跑道含应急。**实际启动只要先到位 ¥500 万即可启动 6 月**，6 月后拿 Desktop 初期付费信号 + Cloud Alpha 反馈进行 A 轮。

---

## 5. 12 月详细里程碑

### M0（T+0 ~ T+30）— Week 1–4：基础设施
- [ ] 公司注册启动
- [ ] 域名 / 商标 / GitHub Org 就绪
- [ ] 创始人 + Chromium 工程师面试 ≥ 5 候选
- [ ] 银行账户开通

### M1（T+30 ~ T+60）— Week 5–8：核心团队签约
- [ ] Chromium 工程师签约
- [ ] Chromium UI 工程师 + 前端工程师任一签约
- [ ] 资金 ≥ ¥350 万到账
- [ ] Chromium 编译流水线在 1 台服务器上跑通

### M2（T+60 ~ T+120）— Week 9–17：第一个 patch
- [ ] Chromium fork 在 GitHub 公开（GPL-2.0 合规）
- [ ] Canvas patch 完成 + 单元测试
- [ ] WebGL patch 完成
- [ ] 首个 native shell 定制跑通：`chrome/browser/ui/views/mosaiq/` 中改一个按钮 / 品牌元素，验证编译中 UI 变更可见
- [ ] 首个 WebUI 面板骨架：注册 `chrome://mosaiq/hello`，返回一个 React 渲染的页面
- [ ] Persona schema v0 设计完成
- [ ] **Cloud Infra 工程师到位**，启动 Cloud 架构设计

### M3（T+120 ~ T+180）— 月 4–6：Desktop Alpha + Cloud 架构
- [ ] 完成全部 10 个 v0.1 patch
- [ ] Profile Manager UI 可用
- [ ] Cookie Jar 真隔离 patch 完成
- [ ] per-profile Proxy 接通
- [ ] **第 1 个内部 dogfooding 用户跑通养号工作流**
- [ ] **CLOUD-RUNTIME-ARCH.md v1.0 定稿**（内核团队与 Cloud 团队联签）
- [ ] **Cloud Runtime 仓库初始化**（API Gateway / CDP Gateway / Browser Pool Controller 骨架）

### M4（T+180 ~ T+270）— 月 6–9：Desktop Closed Beta + Cloud Alpha
- [ ] TLS / JA3+JA4 patch 完成
- [ ] HTTP/2 帧伪装 patch 完成
- [ ] Detection Lab 上线（5 站对接）
- [ ] License + Auto-update 完整
- [ ] 中英 i18n
- [ ] **100 名外部 Beta 用户**
- [ ] **M5：Cloud Runtime alpha 上线**（Fly.io 单 Region），10 人邀请
- [ ] **M6：Stagehand SDK 兼容验证**（一行 endpoint URL 从 Browserbase 迁移可跑）

### M5（T+270 ~ T+360）— 月 9–12：Desktop Public Beta + Cloud Public Beta
- [ ] 公开下载页 + 营销站
- [ ] Free 档开放
- [ ] Persona 云端库上线
- [ ] 行为生物特征模拟引擎 v1
- [ ] **Desktop：5000 注册 / 500 DAU**
- [ ] **Cloud Public Beta（M11）**：全开注册，500 注册，75 付费
- [ ] **Desktop GA（M12）**：付费正式开通，首批 100 付费用户

---

## 6. 关键风险与对策（Phase 0 专属）

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| Chromium 联创 90 天找不到 | 高 | 致命 | 同时 4 渠道并行 + 国内大厂猎头 + 国际远程；找不到延迟 M1 |
| 资金到账延误 | 中 | 高 | 第一笔 ¥150 万先用自有 / 战略 LP 启动，VC 融资可滞后 |
| 商标被抢注 | 中 | 中 | Week 1 立即申请 + 2 个备用名 |
| 国内合规收紧 | 中 | 高 | 主体注册在新加坡 / 香港，国内仅做研发分支 |
| Apple 拒绝 notarization | 中 | 高 | 同时申请多个开发者账号；准备 Linux 优先发布的备案 |
| Stripe 拒签账号 | 高 | 中 | 直接走 Paddle MoR，已为同类公司服务 |

---

## 7. 创始人 Phase 0 的 30 个核心动作（Checklist）

> 复制这一节到 Linear / Notion，每完成一项打勾。

### 法务 / 行政
- [ ] 联系 Sleek 或 Osome 启动新加坡公司
- [ ] 准备护照、地址证明、银行参考
- [ ] 草拟股权架构 + 创始人协议
- [ ] 起草用户协议 / 隐私政策
- [ ] 申请 5 国商标
- [ ] 注册域名 ≥ 2 个
- [ ] 银行账户开通（Aspire / Wise）

### 资金
- [ ] 自有资金到位 ¥150 万启动金
- [ ] 联系 ≥ 10 位天使 / 战略 LP
- [ ] 完成 pitch deck v1
- [ ] 完成 financial model（18 月现金流）
- [ ] 法务 review SAFE 或股权协议模板

### 团队
- [ ] 写 Chromium 工程师 JD 中英版
- [ ] 在 6 个渠道发布招聘
- [ ] 面试 ≥ 10 位 Chromium 候选
- [ ] 面试 ≥ 5 位 Chromium UI / 前端候选
- [ ] 签约首批 3–5 人

### 技术准备
- [ ] 预订 Chromium build 服务器（128GB RAM 推荐）
- [ ] 创建 GitHub Org + 仓库结构
- [ ] 配置 GitHub Actions / 自托管 runner
- [ ] 申请 Apple Developer + Windows EV 证书
- [ ] 跑通 Chromium 首次编译（教学性）

### 品牌 / 营销
- [ ] 终选品牌名 + Logo 设计简报
- [ ] 招 1 个独立设计师做 Logo + 视觉系统
- [ ] 注册 Twitter / Reddit / Discord / GitHub Org 同名
- [ ] 写 launch teaser 博客（不要泄露技术细节）
- [ ] 联系 3–5 位跨境电商 / 自动化 KOL 预约访谈
- [ ] **联系 5–10 位 AI agent / dev influencer**（Theo / Fireship / Stagehand 创始人 / browser-use 作者等）预约访谈
- [ ] **预申请加入 Hacker News / Indie Hackers 社区，启用账号预热 6 个月**
- [ ] **与 Browserbase、Steel.dev、Apify 产品亲自试用各 1 次**，整理出各家“迁移过来”指南文档

---

## 8. 第一周精确动作清单（你今天就能开始）

### Day 1（今天）
- [ ] 决定品牌候选名 Top 3
- [ ] 用 Namechk 跑域名 + 社交占用
- [ ] 给自己一份 18 月跑道资金确认表（自有 + 待融）

### Day 2
- [ ] 联系 Sleek 拿新加坡公司报价
- [ ] 在 LinkedIn 搜 "Chromium engineer" + Brave/Edge/Vivaldi 离职员工

### Day 3
- [ ] 拉一份 30 人 Chromium 候选名单
- [ ] 写 JD 中英两版

### Day 4
- [ ] 起草 pitch deck（参考 Sequoia template）
- [ ] 跟 1 位现役 SaaS 创业者预约 1h 取经

### Day 5
- [ ] 注册域名 + GitHub Org
- [ ] 给 Top 5 Chromium 候选发首封邮件

### Day 6–7
- [ ] 周末复盘：本周完成什么、下周阻塞在哪
- [ ] 写 Phase 0 周报模板（每周日发自己 + 顾问）

---

**这份文档每 2 周更新一次。下次更新：T+14。**
