# @runova/sdk

> Mosaiq SDK — 用 persona 驱动的 Chromium 反检测引擎。Drop-in 兼容
> Playwright / Stagehand / Puppeteer-style 工作流。

[![npm version](https://img.shields.io/npm/v/@runova/sdk.svg)](https://www.npmjs.com/package/@runova/sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## 定位

`@runova/sdk` 是 [Mosaiq](https://github.com/meilimei/Mosaiq) 反检测浏览器
基础设施的 **TypeScript SDK**。它提供:

- **`launchPersona(persona)`** — 启动 Chromium，注入与 persona 一致的
  navigator / canvas / WebGL / audio / WebRTC / UA-Client-Hints 指纹
- **`runDetection(persona)`** — 一键跑完 12 站反检测自检
  (creepjs / sannysoft / browserleaks / pixelscan / iphey / browserscan 等)，
  返回结构化打分与命中明细
- **Persona 管理** — 创建 / 加载 / 保存 / 克隆 / 导出导入 persona, 与 Mosaiq
  Desktop 应用 100% 数据兼容
- **Humanize 输入** — 鼠标移动 / 点击 / 键盘输入的类人节奏与轨迹
- **代理集成** — `http` / `https` / `socks5` 代理 server 参数构造、健康检查

> **Status:** v0.10 first npm release. v0.9 之前仅作为 monorepo 内部 package
> 存在；v0.10 起作为公开 npm 包发行。

---

## 安装

```bash
# v0.10.0+ (npm)
npm i @runova/sdk
# 或者
pnpm add @runova/sdk
```

Chromium 二进制由 [Playwright](https://playwright.dev) 管理：

```bash
npx playwright install chromium
```

> **Note**：SDK 在 `postinstall` 阶段会通过 [`patch-package`](https://github.com/ds300/patch-package)
> 自动 patch 你的 `node_modules/playwright-core` (302 行
> [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)，关掉
> Playwright 的 `Runtime.enable` 检测向量)。如果你用 `npm ci --ignore-scripts`
> 之类的姿势安装，patch 不会生效；SDK 启动时会 warn 一行 stderr 提示。

### 系统要求

- Node.js >= 20.10.0
- macOS / Linux / Windows
- 磁盘空间 ~500 MB（Playwright chromium 约 400 MB）

---

## 5 分钟 Quickstart

```typescript
import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';
import { launchPersona, savePersona } from '@runova/sdk';

// 1. 创建一个 persona（Win11 Chrome US locale 模板）
const alice = createWin11ChromeUsPersona({
  id: 'reddit-alice',
  displayName: 'Reddit Alice',
  tags: ['reddit', 'us'],
  timezone: 'America/New_York',
});
savePersona(alice);  // 写入 ~/.mosaiq/personas/reddit-alice.json

// 2. 启动浏览器（带完整 persona 注入）
const session = await launchPersona(alice, { headless: false });
const page = await session.open('https://creepjs.com');

// 3. 跟 Playwright API 一样用
await page.waitForLoadState('networkidle');
const screenshot = await page.screenshot();

// 4. 关闭
await session.close();
```

`session.open()` 返回的就是标准 Playwright `Page` 对象，所有 Playwright /
Stagehand / `browser-use` API 都能直接用。

---

## Detection Lab — 一键反检测自检

```typescript
import { loadPersona, runDetection, formatDetectionRunMarkdown } from '@runova/sdk';

const alice = loadPersona('reddit-alice');

const { raw, score } = await runDetection(alice, {
  onProgress: (evt) => {
    console.log(`${evt.phase} ${evt.siteId ?? ''}`);
  },
});

console.log(`Weighted hits: ${score.weightedHits}`);
console.log(`Sites OK: ${raw.sites.filter(s => s.ok).length}/${raw.sites.length}`);

// 生成 GitHub Flavored Markdown 报告
const report = formatDetectionRunMarkdown({ ...raw, score }, {
  includeMeta: true,
  includeSiteDetails: true,
});
console.log(report);
```

12 个内置检测站:

| Surface | 站点 |
|---|---|
| webdriver / runtime | sannysoft |
| canvas | browserleaks-canvas |
| webgl | browserleaks-webgl + creepjs |
| audio | creepjs |
| font | browserleaks-fonts |
| webrtc | browserleaks-webrtc |
| UA-CH | uacheck |
| 综合 | iphey / browserscan / pixelscan / amiunique / whoer |

---

## Public API surface

按功能区域组织（完整列表见 [`src/index.ts`](./src/index.ts)）：

### Browser launch

```typescript
import { launchPersona, BrowserSession, type LaunchPersonaOptions } from '@runova/sdk';
```

`launchPersona(persona, options?)` → `Promise<BrowserSession>`。
`BrowserSession` 暴露 `open(url)` / `pages()` / `context()` / `close()`，
其中 `context()` 是原生 `playwright.BrowserContext`，所有 Playwright 操作直通。

### Persona storage

```typescript
import {
  savePersona, loadPersona, listPersonas, deletePersona,
  personaExists, updatePersona, clonePersona,
  recordLaunch,
  type PersonaPatch, type CloneOptions,
} from '@runova/sdk';
```

读写 `~/.mosaiq/personas/<id>.json`，与 Mosaiq Desktop 应用同一数据目录。

### Persona portability

```typescript
import {
  serializePersona, exportPersonaJson,
  parsePersonaJson, importPersonaJson,
  type ExportOptions, type ImportOptions, type ImportConflictOptions,
} from '@runova/sdk';
```

导出 / 导入 persona JSON 文件，支持 `--include-secrets` 控制是否 redact
proxy.password 等敏感字段。

### Detection Lab

```typescript
import {
  runDetection, runOnePage, snapshotPersona,
  SITES, computeScore, attributeSurface, weightHit, weightedHitsSum,
  saveDetectionRun, loadDetectionRun, listDetectionRuns, deleteDetectionRun,
  getDetectionRunArtifactDir,
  formatDetectionRunMarkdown, diffRuns,
  type DetectionRun, type DetectionRunRaw, type DetectionRunSummary,
  type DetectionScore, type SurfaceName, type HitSeverity,
  type RunDetectionOptions, type RunDetectionResult,
  type RunProgressEvent, type RunStatus,
  type FormatMarkdownOptions, type RunDiff, type RunSnapshot, type ChangedHit,
} from '@runova/sdk';
```

12 站检测 / 打分 / 存储 / Markdown 报告 / run-vs-run diff 的完整能力。

### Humanize 输入

```typescript
import {
  Humanize,
  planMouseTrajectory, planTypingPlan,
  type HumanizeDefaults, type HumanizeSpeed,
  type MoveOptions, type ClickOptions, type TypeOptions,
} from '@runova/sdk';

const h = new Humanize(page);
await h.move({ x: 600, y: 400 });
await h.click('button[type=submit]');
await h.type('input[name=username]', 'alice_2026', { speed: 'normal' });
```

带 Bezier 曲线 + Gaussian jitter 的鼠标轨迹、Pareto 分布的击键 dwell。详见
[`docs/HUMANIZE-DESIGN.md`](https://github.com/meilimei/Mosaiq/blob/main/docs/HUMANIZE-DESIGN.md)。

### 代理

```typescript
import {
  buildProxyServerArg, toPlaywrightProxy, verifyProxy,
  type PlaywrightProxy, type ProxyVerifyResult, type ProxyVerifyOptions,
} from '@runova/sdk';
```

`http` / `https` / `socks5`，URL-encoded credentials 自动解码，
`verifyProxy()` 通过代理打 IP 检测站验证可达性 + 出口 IP。

### Paths（数据目录）

```typescript
import {
  getRuntimeRoot, getUserDataDir,
  getPersonaDir, getPersonaFile,
  getDetectionRunsRoot, getDetectionRunsDir, getDetectionRunFile,
  type PathConfig,
} from '@runova/sdk';
```

默认 `~/.mosaiq/`；通过环境变量 `MOSAIQ_RUNTIME_ROOT` 覆盖。

### Persona schema 类型 re-export

```typescript
import type { Persona, PersonaId, PersonaDraft, PersonaMetadata } from '@runova/sdk';
import { parsePersona, safeParsePersona } from '@runova/sdk';
```

`Persona` zod schema 校验。详细字段定义见
[`@runova/persona-schema`](https://www.npmjs.com/package/@runova/persona-schema)。

---

## 与 Playwright / Stagehand 集成

SDK 直接基于 `playwright-core` 1.59.1（patched）。`session.context()` 返回原生
`BrowserContext`，所以：

```typescript
import { launchPersona } from '@runova/sdk';
import { Stagehand } from '@browserbasehq/stagehand';

const session = await launchPersona(persona);
const stagehand = new Stagehand({
  env: 'LOCAL',
  localBrowserLaunchOptions: { context: session.context() },
});
await stagehand.init();
// 现在 Stagehand 的 LLM-driven 操作在 Mosaiq persona 注入的浏览器里跑
```

Puppeteer-style：把 CDP endpoint 暴露给 `puppeteer.connect()` 即可。

---

## CLI

如果你不想写 TypeScript，[`@mosaiq/cli`](https://www.npmjs.com/package/@mosaiq/cli)
提供同等能力的命令行入口：

```bash
npm i -g @mosaiq/cli
mosaiq detection-lab run reddit-alice
mosaiq personas create alice --template win11-chrome-us --display-name "Alice"
```

详见 [`@mosaiq/cli` README](https://github.com/meilimei/Mosaiq/tree/main/packages/cli#readme)。

---

## 反检测设计

`@runova/sdk` 的反检测能力分两层：

1. **Persona 注入**（`launchPersona`）— navigator / canvas / WebGL / audio /
   WebRTC / UA-CH 等指纹按 persona 配置覆盖。每个 persona 的 noise seed 都
   是确定派生，多次启动同一 persona 指纹一致
2. **Playwright 修复**（`patches/playwright-core@1.59.1.patch`）— 集成
   [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)，关掉
   `Runtime.enable` 自动暴露 execution context 的检测向量

**已知 limitation**:

- CreepJS 在 WebGL 上对所有 4 个内置 persona 模板**预期 bold-fail**（其
  237-int + 287-hex 硬编码白名单覆盖有限，新 GPU / 非典型 driver 都会被误判）。
  详细数学分析见 [`bench/PHASE-2-PLAN.md`](https://github.com/meilimei/Mosaiq/blob/main/packages/sdk/bench/PHASE-2-PLAN.md) Phase 2.2
- **没有真 TLS 指纹层**（JA3/JA4 在当前 Playwright 模式下是 Chrome 默认）。
  Cloudflare 严格 BotScore 站点能识别为「自动化 Chrome」。解决需要 Chromium
  fork + BoringSSL 层 patch（[cold storage 中](https://github.com/meilimei/Mosaiq/blob/main/chromium-fork/STATUS.md)）

---

## 开发

```bash
# 在 monorepo 内
git clone https://github.com/meilimei/Mosaiq
cd Mosaiq
pnpm install
pnpm --filter @runova/sdk build
pnpm --filter @runova/sdk test    # 593 vitest cases
pnpm --filter @runova/sdk demo:humanize   # 看 Humanize 鼠标轨迹 demo

# Detection Lab bench (本地真跑 12 站)
pnpm --filter @runova/sdk bench
pnpm --filter @runova/sdk bench:report
```

---

## License

[Apache-2.0](./LICENSE)。Copyright 2026 Mosaiq contributors。
