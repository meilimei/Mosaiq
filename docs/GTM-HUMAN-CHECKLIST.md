# Mosaiq GTM 人工清单（Track B）

> **用途**：工程夯实（Track A）可由 AI/CI 推进；下列步骤**只能由人**执行（凭据、账号、对外沟通）。每项附验收口径，完成后在方框打 `[x]`。

与 [ROADMAP-90D.md](./ROADMAP-90D.md) 阶段二「拿首批真实用户」对齐。

---

## 1. npm 公开发布（`@runova/*`）

- [ ] 按 [RELEASING.md](./RELEASING.md) §8 用真实 npm 账号登录并 `npm whoami`
- [ ] 手工首发（若尚未发布）：`@runova/persona-schema`、`@runova/sdk`、`@runova/cli`、`@runova/cloud-sdk`
- [ ] 验证：`npm i -g @runova/cli` → `mosaiq personas templates list` 成功
- [ ] 翻开 `release.yml` / changesets 自动化（maintainer 决策）

**验收**：陌生机器 `npm i @runova/sdk` 无需 link monorepo 即可 `import`。

---

## 2. GitHub Pages 上线 Leaderboard

- [ ] 仓库 Settings → Pages → Source = **GitHub Actions**
- [ ] 确认 `main` 上 `leaderboard.yml` / `jekyll-gh-pages.yml` 跑绿
- [ ] 打开 Pages URL，可见 Mosaiq vs 竞品诚实对比（来自 committed baselines）

**验收**：公开 URL 可访问；过不了的项标红（不挑数据）。

---

## 3. 硬目标 + 真账号实测（1 周）

按 [EVIDENCE-AND-VALIDATION.md](./EVIDENCE-AND-VALIDATION.md) §4：

- [ ] 4 个模板 persona（win11 / win10 / macOS / Ubuntu）
- [ ] Cloudflare 严格站 + DataDome/Akamai 站各测
- [ ] Reddit / X / Google 真账号登录（自担 ToS 风险）
- [ ] 记录表：日期 | persona | 目标站 | 路径(desktop/cli/cloud) | 结果 | 被识破 surface
- [ ] 被识破项用 [detection-report 模板](../.github/ISSUE_TEMPLATE/detection-report.yml) 开 issue

**验收**：≥1 周记录 + ≥1 个带 surface 的 issue（若有失败）。

---

## 4. LaunchAI 切 prod daily-driver

- [ ] LaunchAI worker `fly.toml` / secrets 固定 Mosaiq prod URL + API key
- [ ] `MOSAIQ_REQUEST_TIMEOUT_MS=180000`（冷启动 acquire）
- [ ] 日常 Reddit grooming 走 prod；记录长会话 / sticky / captcha 问题

**验收**：LaunchAI 生产任务默认走 Mosaiq Cloud；有 issue 或周报摘要。

---

## 5. 拉 1–2 个外部用户

- [ ] 目标：Stagehand / browser-use / Playwright 用户
- [ ] 提供：免费额度 + 一行 baseURL 迁移示例
- [ ] 收集：能否无痛迁移、`server_inject` 是否真比 Browserbase 强（用 leaderboard 背书）
- [ ] 反馈回流：`runner.ts` 修补 + baseline 更新

**验收**：≥1 个外部用户书面/口头反馈存档（邮件/Discord/issue 链接）。

---

## 反馈闭环

| 来源 | 动作 |
|---|---|
| detection-report issue | 定位 `packages/sdk/src/injection/runner.ts` → 修 → `diag:worker-scope` / `diag:webgl` 绿 → 更新 baseline |
| LaunchAI prod | 优先 cloud-runtime / browser-pod；sticky 见 phase 11.5 文档 |
| 外部用户 | 记录迁移摩擦点；API 缺口记入 ROADMAP anti-scope 评审 |
