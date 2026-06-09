# 展示站推广文案包

这份文档配合 `_site/index.html` 使用。产品名仍可替换，文案里先使用 Mosaiq 作为代号。

## 30 秒介绍

Mosaiq 是面向 AI Agent、Playwright 自动化和跨账号运营的浏览器基础设施。它不是只给你一个 headless browser，而是把 Persona 管理、反检测注入、Detection Lab 自检、CLI 工作流和 Browserbase 兼容形状放在同一条路径上。当前重点是用真实 baseline 证明能力，并让 Stagehand / Browserbase 风格用户通过 baseURL 低成本试用。

## 一句话版本

Mosaiq 是带 Detection Lab 证据链的 agentic browser infrastructure，支持 Persona、CLI、Desktop UI 和 Browserbase-style Cloud Runtime alpha。

## 开发者外联

Hi，我在做 Mosaiq，一个面向 Playwright / Stagehand / browser-use 用户的浏览器基础设施项目。当前重点不是包装概念，而是把 persona-based anti-detection 和 Detection Lab baseline 做成可复现证据。  

如果你现在用 Browserbase / raw Playwright 跑自动化，可以先看这个展示页和 leaderboard；Cloud alpha 的迁移路径是换 baseURL，SDK 形状尽量保持兼容。

## 早期用户外联

我们在找 1-3 个真实自动化/账号运营场景做早期实测。你可以用 Mosaiq CLI 或 Cloud alpha 跑一组 persona，然后把 Detection Lab 结果、硬目标站点 challenge/block 情况回流给我们。失败结果也有价值，因为我们会把具体 surface 变成修复项。

## 投资人 / 合伙人版本

Mosaiq 的切入点是把 antidetect browser 和 cloud browser API 收敛到同一套 Persona / Detection Lab / SDK 证据链里。短期先用 SDK、CLI、Desktop 和 Cloud alpha 验证真实需求；长期再判断是否投入 Chromium fork 和更深层 TLS/JA4 路径。展示站刻意把当前已交付能力和远期路线拆开，降低过度承诺风险。

## 上线前检查

- GitHub Pages 已启用，Source 选择 GitHub Actions
- `_site/index.html` 可以打开，`_site/leaderboard/index.html` 可以打开
- `pnpm build-leaderboard` 只更新 `_site/leaderboard/index.html`
- 域名确定后更新 `SITE_CONFIG.productName`、`primaryDomain`、`cloudBaseUrl`
- Open Graph / Twitter Card 的静态 meta 已改成最终品牌和绝对图片 URL
- README、QUICKSTART、npm homepage、pitch deck 链接指向同一个主域名

