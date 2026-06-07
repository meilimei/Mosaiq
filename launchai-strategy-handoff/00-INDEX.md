# LaunchAI 战略修订交付包（handoff）

> 作者：资深产品/架构评审（受 meilimei 委托）
> 日期：2026-06-02
> 来源：基于 LaunchAI `master` HEAD 的 `README.md` / `docs/PRD.md` / `docs/TECH.md` /
> `docs/COMPETITIVE_ANALYSIS.md` / `docs/MOSAIQ-INTEGRATION-REQUESTS.md`，
> 以及 Mosaiq 仓库内 `docs/LAUNCHAI-INTEGRATION.md` 的交叉比对。

---

## 这是什么

这是一份对 LaunchAI 当前产品定位的**深度评审 + 修订方案**。核心结论一句话：

> **LaunchAI 的代码完成度不是问题，叙事一致性才是。** 当前存在「两个互相矛盾的
> LaunchAI」——对外是"合规文案副驾（绝不代发）"，对内（Mosaiq 集成）在建"反检测自动
> 养号 + 自动发帖"基建。同时，原竞品分析（2026-04）的核心假设"市场空白"在 2026-06
> 已被 Markey / Submit.DIY / Scaloom 等填补。本包给出一套把裂缝补成护城河的方案。

---

## 为什么这些文件在 Mosaiq 仓库里

评审者的文件写权限被限制在 Mosaiq 工作区内，无法直接写入独立仓库 `D:/projects/LaunchAI`。
因此交付物以「可直接拷贝」的成品形式放在这里。**落地方式**：把下表文件拷到 LaunchAI 仓库
对应路径，按需 review 后 commit。

| 本包文件 | 落到 LaunchAI 的位置 | 动作 |
|---|---|---|
| `01-STRATEGY-DECISION-v0.2.md` | `docs/STRATEGY-DECISION-v0.2.md` | 新增（**先读这份**，是 keystone） |
| `02-COMPETITIVE-ANALYSIS-2026-06.md` | `docs/COMPETITIVE_ANALYSIS.md` | 替换旧版（旧版归档为 `COMPETITIVE_ANALYSIS-2026-04.md`） |
| `03-GEO-VISIBILITY-SPEC.md` | `docs/GEO-VISIBILITY-SPEC.md` | 新增（P1 功能 spec） |
| `04-AUTHORIZED-EXECUTION-COMPLIANCE.md` | `docs/AUTHORIZED-EXECUTION-COMPLIANCE.md` | 新增（P0 合规护栏） |
| `05-DATA-FLYWHEEL-SPEC.md` | `docs/DATA-FLYWHEEL-SPEC.md` | 新增（P2 数据飞轮） |

PRD 的修订点（定位重写、定价、out-of-scope 消歧、roadmap 提前数据飞轮）集中写在
`01-STRATEGY-DECISION-v0.2.md` 的「PRD diff 清单」一节，落地时按清单改 `docs/PRD.md`。

---

## 阅读顺序

1. **`01-STRATEGY-DECISION-v0.2.md`** —— 决策与全局方案。看完这份就懂整体。
2. `02-COMPETITIVE-ANALYSIS-2026-06.md` —— 为什么"市场空白"假设失效了。
3. `03` / `04` / `05` —— 三个支撑性 spec，分别对应 GEO 机会、自动执行合规、数据飞轮护城河。

---

## 优先级速览（来自 keystone 文档）

| 级别 | 行动 | 一句话 |
|---|---|---|
| **P0** | 战略归一 + 合规护栏 | 拍板"你是哪个 LaunchAI"，消除文档自相矛盾 |
| **P1** | GEO/AEO 做成第一公民 | 把"被 AI 引用"做成正面叙事 + 高溢价功能 |
| **P2** | 数据飞轮前置 | 把 v3 的 outcome 闭环提到 v1.1，建私有数据壁垒 |
| **P3** | 定价与 wedge 修正 | 别在 $12-19 区间和 Markey 拼纯文案 |
| **P4** | 架构夯实 | 保持线性 DAG；自动执行需账号隔离 + 可观测性沉淀 |

---

## 引用来源（2026-06 市场校验）

文中竞品与市场数据来自公开网络检索，已按 30 词以内改写以符合内容授权：

- Markey（markey.app）：URL → 30+ 跨渠道内容 + launch 后每周持续产出，起价 $12/月
- Submit.DIY：all-in-one AI launch platform，AI Sidekick 一键多渠道 ready-to-publish
- Scaloom AI：Reddit 专用，养号攒 karma + 找 sub + 发帖 + 自动回复
- GEO/AEO 赛道：2026-02 头部玩家累计融资 > $1.8 亿，主流定价 $99–$399/月

具体链接见各文档内联引用。内容已为合规改写。
