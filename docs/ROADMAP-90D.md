# Mosaiq 90 天现实路线图（单人 + AI agent）

> **定位**：这份**不是**愿景文档（愿景见 [`PRD.md`](./PRD.md) / [`WHITEPAPER.md`](./WHITEPAPER.md)）。这份是「以**当前真实资源**（单人 + AI agent、低配硬件、Chromium fork 已冷藏）在未来 ~90 天能**真正执行**的事」。
>
> **战略一句话**：从「阶段工厂」（一路堆 cloud phase）转向 **证据 → 用户 → 夯实**。先证明反检测真能打、拿到首批真实用户、把已建资产做扎实；**冻结新的 cloud 功能 phase**，直到拿到 1 个付费用户或资金。
>
> **聚焦楔子**：**Cloud / Dev-First**（适合单人 + AI、有现成 dogfood 用户、Browserbase 迁移角度锋利、比消费级桌面省 UX/支付/客服/分发）。**Desktop antidetect 暂缓**（代码保留，不投新功能）。

---

## 0. 本轮已落地（用于对齐起点，避免重复）

这次「证据 → 用户 → 夯实」的第一刀已经动了：

- **云端差异化矛盾（已修复，Option A 落地）**：服务端注入**已实现并默认开启**（pod `apps/browser-pod/src/inject.ts`）——裸 `connectOverCDP` / BB-SDK baseURL swap 现在就带深层 stealth（canvas/WebGL/audio/UA-CH/字体/worker）。本地（真 pod + 真 chromium，**不调** `injectInto` 即 spoof：`hardwareConcurrency`/WebGL renderer 命中 persona）+ Docker build 均已验证；`injectAll` 的 realm 级幂等守卫保证与客户端 `injectInto` 不双注入。详见 [`CLOUD-RUNTIME-ARCH.md`](./CLOUD-RUNTIME-ARCH.md) §2.5。
- **质量护栏**：CI 加了 browser-pod 单测 + 一个 **non-blocking** 的 biome changed-files 可见性 gate；CLI 版本号改为从 package.json 读（消除 0.9.0-dev vs 0.10.0 漂移）；`audit-tarballs` 纳入 `@mosaiq/cloud-sdk`；cloud-runtime README / ci.yml 注释的大面积 doc 漂移已修。
- **证据通路**：新增 [`EVIDENCE-AND-VALIDATION.md`](./EVIDENCE-AND-VALIDATION.md) runbook + GitHub detection-report issue 模板。
- **技术债登记**：[`DEVELOPMENT.md`](../DEVELOPMENT.md) §8 集中记录了所有暂缓项与触发条件。

---

## 1. 阶段一（约第 1–3 周）：证明能打 + 修矛盾

**目标**：从「自评分 + 无证据」变成「有 committed baseline + 公开诚实对比 + 真账号实测在跑」。零预算。

1. **Bootstrap 第一份 committed baseline**（`win11-chrome-us` 起，再扩 4 模板）——按 [`EVIDENCE-AND-VALIDATION.md`](./EVIDENCE-AND-VALIDATION.md) §2。让 detection-lab CI gate 真正生效。
2. **公开 leaderboard**——`pnpm build-leaderboard` + 启用 GitHub Pages（[EVIDENCE §3]）。诚实标注过不了的项 + 竞品分可复现。
3. **硬目标 + 真账号实测一周**（人工）——4 模板 persona 跑 Cloudflare/DataDome 站 + Reddit/X/Google 登录，按 [EVIDENCE §4] 协议记录，被识破点用 detection-report 模板回流成 issue。
4. **服务端注入（Option A）已落地**——剩余仅 CI/Fly 验证：`cloud-runtime-e2e.yml` 的 e2e-smoke 已加「不调 `injectInto` 也能 spoof」断言作回归门；在 CI 跑绿 + Fly 上拉一次 session 实测后，即可正式对外承诺「比 Browserbase 强 + 无脑迁移」。

**出阶段标准**：`tests/fixtures/baseline-runs/` 有至少 1 个真实 baseline；leaderboard 可访问；≥1 周真账号实测记录 + 对应 issue。

---

## 2. 阶段二（约第 3–8 周）：拿首批真实用户

**目标**：从「0 用户」到「1 个 dogfood + 1–2 个外部实测用户」。实战反馈优先级最高。

1. **Dogfood LaunchAI**——按 [`LAUNCHAI-INTEGRATION.md`](./LAUNCHAI-INTEGRATION.md) 把自己的 LaunchAI 项目切到 Mosaiq Cloud 跑起来，当设计伙伴 #0；记录真实使用中暴露的问题。
2. **npm @mosaiq scope go-live**（需真实 npm 账号，人工）——按 [`RELEASING.md`](./RELEASING.md) §8 清单：注册 scope → 手工首发 0.10 三包 + cloud-sdk(0.11) → 翻开 `release.yml` 的 push 触发。让 `npm i @mosaiq/cli` / `@mosaiq/cloud-sdk` 真能装。
3. **拉 1–2 个外部用户实测**——目标 Stagehand / browser-use / Playwright 用户，给免费额度，重点收集：能否无痛迁移、stealth 是否真比 Browserbase 强（用 §1 的证据背书）。

**出阶段标准**：LaunchAI 在 Mosaiq Cloud 上稳定跑；npm 包可公开安装；≥1 个外部用户给出真实反馈。

---

## 3. 阶段三（约第 6–12 周，与阶段二重叠）：夯实

**目标**：把单人 + AI 大量产出的代码做扎实，降低 bus-factor 与生产风险。

1. **Biome 全仓清理 → lint gate 翻 blocking**（[`DEVELOPMENT.md`](../DEVELOPMENT.md) §8）——清掉 ~500 legacy findings（`runner.ts` 手工逐条，别 `--unsafe`），然后去掉 ci.yml lint job 的 `continue-on-error`。
2. **`runner.ts` worker-scope 注入串去重**——高风险（crown jewel），先补 `bench/diagnose-*.ts` 真 Chromium 回归覆盖，再提取共享生成器。
3. **Cloud 单点拓扑评估**——接真实付费/SLA 前，定多实例 + Postgres / 共享存储方案；在此之前明确对外「alpha、单点」边界。

---

## 4. 明确不做（anti-scope，直到拿到 1 个付费用户或资金）

- 不再开新的 cloud 功能 phase（多 region、captcha solver、MCP server、recording/replay）。
- 不解冻 Chromium fork（触发器见 [`chromium-fork/STATUS.md`](../chromium-fork/STATUS.md)）。
- 不投 Desktop UX 打磨、Android 模拟、Marketplace、warming scheduler 等远期项。

---

## 5. 仍待拍板的决策

- 服务端注入：**已落地 Option A（默认开启，本地 + Docker build 验证）**。待确认：Fly 生产是否默认保持开启（建议 `cloud-runtime-e2e.yml` 跑绿后保持）。
- `@mosaiq` npm scope 现在就正式发布，还是继续内部迭代？
- 接受把战略楔子定在 **Cloud / Dev-First**（Desktop 暂缓）吗？

---

## 6. 关联文档

- 证据 / 验证：[`EVIDENCE-AND-VALIDATION.md`](./EVIDENCE-AND-VALIDATION.md)
- 云端注入模型 + 服务端注入 deferred 设计：[`CLOUD-RUNTIME-ARCH.md`](./CLOUD-RUNTIME-ARCH.md) §2.5
- 发布 / npm go-live：[`RELEASING.md`](./RELEASING.md) §8
- 技术债 / 已知 follow-up：[`DEVELOPMENT.md`](../DEVELOPMENT.md) §8
- 长期愿景：[`PRD.md`](./PRD.md) / [`WHITEPAPER.md`](./WHITEPAPER.md)
