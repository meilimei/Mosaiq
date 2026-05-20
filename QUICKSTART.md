# Mosaiq v0.10 — Quickstart

> **当前里程碑**：v0.10.0 已发布（2026-05-21）。架构是 **Playwright + CDP 注入**，不是 Chromium fork（fork 路径冷藏中，详见 [`chromium-fork/STATUS.md`](./chromium-fork/STATUS.md)）。
> 4-package monorepo，三个发包包 0.10.0 lock-step 公开在 npm：`@mosaiq/persona-schema` / `@mosaiq/sdk` / `@mosaiq/cli`；`@mosaiq/desktop` 永久 private（Electron app）。
> **v0.10 的关键新事**：从 git clone-only 走到 `npm i @mosaiq/cli` 直装；SDK 通过 `patch-package` postinstall 自动应用 rebrowser-patches 给 `playwright-core@1.59.1`；changesets 接管版本。

---

## 你能拿到什么

### 桌面应用（`@mosaiq/desktop`）

打开 Mosaiq Desktop，你会看到：

- **Persona 列表**：每个 Persona = 一个独立浏览器身份（自己的 Cookie、缓存、IndexedDB、指纹、代理）。顶部搜索框按 displayName / id / notes / 代理标签过滤；点 chip 多选标签做 AND 筛选
- **新建 Persona**：从 **4 个模板**（Win11 / Win10 / macOS Sonoma / Ubuntu 22.04）选一个 → 填 ID + 显示名 → 选时区 → 配代理（可选） → 创建
- **启动 / 停止**：点击启动 → 本机 Chromium 弹出，已注入完整反检测脚本 + 代理
- **导入 / 导出 JSON**：每个 Persona 卡片右上角点 ⬇️ 可导出（默认脱敏代理密码），顶部点 ⬆️ 导入；ID 冲突自动重命名为 `<id>-imported`，永不覆盖现有 persona
- **Detection Lab**（v0.8 + v0.9 完整集成）：
  - **历史 trend**：每个 persona 显示最近 20 个 run 的 weightedHits 折线图，跌涨一眼可见
  - **一键新 Run**：跑 12 个反检测站点（CreepJS / browserleaks-canvas / sannysoft / fpscanner / browserscan / pixelscan / IPHey / Whoer / amiunique / iphey-2 / browser-info / mixvisit），实时进度条 + per-site phase
  - **per-run 详情**：12-surface 雷达图（canvas / webgl / audio / fontList / webrtc / ua / hardware / platform / locale / screen / timezone / other）+ headline 数字 + per-site grid + 截图缩略图（点开 lightbox 全屏）
  - **Persona Pool 对比**：选 2-8 个 persona 同时展示多边形 radar，找出 surface-level 差异
  - **Compare Runs side-by-side**：两个 run 间 weighted / hits / sites Δ + ok→fail / fail→ok 翻转 + Added / Removed / Changed 命中
  - **导出 .md**：在 run detail 一键导出 GitHub Flavored Markdown 报告（PR / Issue / Slack 直接贴）

注入的反检测维度（都在浏览器加载第一行 JS 之前完成）：

- `navigator.userAgent` / `userAgentData` — 与 OS / browser 模板一致
- `Accept-Language` / `navigator.languages` — 与 Persona 语言一致
- `navigator.platform` / `oscpu` / `vendor` — 跨 OS 一致
- `navigator.hardwareConcurrency` / `deviceMemory` — 用 Persona 中真实设备值
- `screen.*` / `window.devicePixelRatio` — 分辨率一致
- 时区（`Intl`、`Date.getTimezoneOffset` 全协调）
- Canvas / WebGL 噪声（每 Persona 不同的稳定种子，`getImageData` / `getParameter` 加噪）
- AudioContext fingerprint 偏移（per-buffer + per-channel 幂等 noise）
- WebGL VENDOR / RENDERER 字符串（与模板 GPU 匹配，49-param ANGLE 全覆盖；可选 captured profile 走真机抓取）
- `RTCPeerConnection` 屏蔽 STUN candidate 泄漏真实 IP
- `permissions.query`、`mediaDevices.enumerateDevices` 一致化
- 字体探测对 fallback metric 加噪

### CLI（`@mosaiq/cli`，v0.9 新增）

`mosaiq` 一行入口，与桌面读同一个 `~/.mosaiq/` store：

- **Detection Lab**: `run` / `run-all` / `compare` / `list-runs` / `show-run` / `delete-run` / `export-run`
  - `run-all --fail-on-regression` 是多 persona CI gate（exit 1 = 任一 persona 回归）
  - `compare --fail-on-regression` 是单 persona run-vs-run gate
- **Personas**: `list` / `show` / `create` / `update` / `clone` / `delete` / `export` / `import` / `templates list`
  - 所有 CRUD 都在桌面之外可脚本化（`--json` 输出方便 jq）
  - `create --master-seed <hex>` 可重现 persona 用于 fixture
  - `clone` 重新派生 canvas / webgl / audio noise seeds（即 baseline 相同但指纹独立）

详见下文 [CLI 入门](#cli-入门)。

---

## 准备工作

要求：

- Windows / macOS / Linux 桌面
- Node.js **20.18+** （`node --version`）
- pnpm **9+** （`pnpm --version`，没有就 `npm i -g pnpm`）
- 磁盘 ~500 MB（Electron + Chromium）
- 可访问 `playwright.azureedge.net` 下载 Chromium（网络受限时见下文）

⚠️ **特别注意 Windows / 部分 IDE 终端用户**：
有些环境会预设 `ELECTRON_RUN_AS_NODE=1` 这个环境变量（典型场景：VS Code 的 task runner、某些 corepack 包装器）。
我们已经在 `apps/desktop/scripts/dev.cjs` 里 _强制 unset_ 它；不需要你手动处理。

---

## 5 分钟跑起来

两条路径任选一条。路径 A 适合**只想用 CLI / SDK 跑反检测的最终用户**；路径 B 适合**想看桌面 UI 或参与开发的贡献者**。

### 路径 A：npm（v0.10+，end user，无需 git clone）

```bash
# 1. 全局装 mosaiq CLI （会自动装 @mosaiq/sdk + @mosaiq/persona-schema）
#    安装时 SDK 的 postinstall 会自动应用 rebrowser-patches 给 playwright-core
npm i -g @mosaiq/cli

# 2. 装 Playwright Chromium（约 140 MB，跨项目共用）
npx playwright install chromium

# 3. 看 4 个 OS 模板
mosaiq personas templates list

# 4. 创建一个 persona（这里用 Win11 Chrome US 模板）
mosaiq personas create alice --template win11-chrome-us --display-name "Alice"

# 5. 跑 12 站反检测自检
mosaiq detection-lab run alice
```

如果你想脚本化集成而不是命令行：

```typescript
// any-node-project/index.ts
import { loadPersona, launchPersona, runDetection } from '@mosaiq/sdk';

const alice = loadPersona('alice');           // 读 ~/.mosaiq/personas/alice.json
const session = await launchPersona(alice);   // 启动 Chromium，已注入指纹
const page = await session.open('https://creepjs.com');
// ... 跟 Playwright API 一样
await session.close();

// 或者一键自检
const { score } = await runDetection(alice);
console.log(`Weighted hits: ${score.weightedHits}`);
```

Persona 数据 + Cookie + 缓存默认存在 `~/.mosaiq/`。CLI 跟桌面 app 共用同一个目录，
所以在 CLI 创建的 persona 在桌面里能直接看到（**前提是你也装了桌面 app，走路径 B**）。

⚠️ **`patch-package` postinstall 注意**：如果你的 CI 用 `npm ci --ignore-scripts`
安装，SDK 的 postinstall 不会跑，`playwright-core` 不会被 patch，sannysoft
会多出 1 个 `webdriver` high hit。绕开方法：CI 里手工 `npx patch-package
--patch-dir node_modules/@mosaiq/sdk/patches` 显式 apply，或者放开 postinstall。

### 路径 B：monorepo（贡献者 / 想跑桌面 UI / dev 模式）

```powershell
# 1. 克隆 / 拉到本地，进入目录
cd d:\projects\Mosaiq

# 2. 装依赖（首次会下 Electron + 各种 React 生态包）
pnpm install

# 3. 装 Playwright 用的 Chromium（约 140 MB，下载一次终生使用）
pnpm --filter @mosaiq/sdk exec playwright install chromium

# 4. 启动桌面应用（dev 模式，热重载开启）
pnpm dev:desktop
```

第一次启动会：

1. 编译 React UI（renderer），输出到 `apps/desktop/dist/`
2. 编译 Electron 主进程 + preload，输出到 `apps/desktop/dist-electron/`
3. 启动 Vite dev server (`http://localhost:5173`)
4. 启动 Electron 窗口加载 dev server

Persona 数据 + Cookie + 缓存默认存在 `~/.mosaiq/`。

### 想换存储路径？

```powershell
$env:MOSAIQ_RUNTIME_ROOT="D:\my-mosaiq-data"
pnpm dev:desktop
```

---

## 你的第一个 Persona（实战）

1. 启动应用 → 点 **「新建 Persona」**
2. 选模板 **`Windows 11 + Chrome 130 (US)`**（如果你要刷 Reddit US 用户）
3. ID：`reddit-alpha`（kebab-case，3-64 字符，字母开头）
4. 显示名：`Reddit Alpha`
5. 时区：自动填 `America/New_York`
6. **强烈建议**勾上代理：
   - 协议 `HTTP`
   - 主机 `residential.iproyal.com`（或你的住宅代理）
   - 端口 `12321`
   - 用户名 / 密码：填你的 sticky session 凭证
   - 标签：`iproyal-us-sticky-001`（让你日后一眼能识别）
7. **创建**

回到列表 → 点 **「启动」** → 一个 Chromium 窗口打开 → 先点 **「自检」** 按钮 → 它会同时打开 pixelscan + browserscan，确认：

- 显示的 OS = Windows 11 ✓
- 显示的 Browser = Chrome 130 ✓
- 显示的 IP = 你的代理出口 IP ✓
- 显示的时区 = America/New_York ✓
- WebRTC IP 不泄漏真实地址 ✓

通过自检后，可以正常去 Reddit / 任何站点干活。Cookie 会自动存到 `~/.mosaiq/profiles/<id>/`。

---

## 仓库布局（v0.10 实际状态）

```
Mosaiq/
├── packages/
│   ├── persona-schema/           # ✅ Zod schema + 4 OS 模板（26 测试）
│   │   ├── src/
│   │   │   ├── persona.ts        # Persona 类型定义 + parsePersona / safeParsePersona
│   │   │   ├── templates/        # win11 / win10 / macos-sonoma / ubuntu-2204 + TEMPLATE_CATALOG
│   │   │   ├── fingerprint.ts    # canvas / webgl / audio / fontList / webrtc 子 schema
│   │   │   ├── system.ts         # OS / locale / timezone / screen 子 schema
│   │   │   └── utils/seed.ts     # mulberry32 + xfnv1a，与 sdk humanize 共用 PRNG
│   │   └── 26 tests
│   ├── sdk/                      # ✅ Playwright + CDP 注入 + Detection Lab（593 测试 / 28 文件）
│   │   ├── src/
│   │   │   ├── launcher.ts             # launchPersona() 主 API
│   │   │   ├── browser-session.ts      # context + firstPage + humanize getter
│   │   │   ├── injection/              # 反检测 init script + runner（canvas/webgl/audio/ua/...）
│   │   │   ├── humanize/               # mouse / keyboard / rng / Humanize 类
│   │   │   ├── persona-store.ts        # 文件系统 CRUD（含 updatePersona / clonePersona）
│   │   │   ├── persona-portability.ts  # 导入/导出 JSON + 冲突解决
│   │   │   ├── detection-lab/          # ★ v0.8/0.9：runner / scorer / run-store / run-format
│   │   │   │                           #   types / sites / run-compare (diffRuns)
│   │   │   ├── proxy.ts                # 代理 URL 构造 + Playwright proxy 转换 + 验证
│   │   │   ├── ua.ts                   # User-Agent + Accept-Language 构造
│   │   │   └── chromium-version.ts     # 读取 playwright-core Chromium 版本号
│   │   ├── bench/                      # Phase 7 captured-WebGL-profiles pipeline
│   │   └── examples/humanize-demo.ts
│   ├── cli/                      # ✅ v0.9 新增：mosaiq 命令行（64 测试 / 3 文件）
│   │   ├── bin/mosaiq.js               # bin shim
│   │   └── src/
│   │       ├── cli.ts                  # 入口 + 命令路由
│   │       ├── commands/
│   │       │   ├── detection-lab/      # run / run-all / compare / list-runs /
│   │       │   │                       #   show-run / delete-run / export-run
│   │       │   └── personas/           # list / show / create / update / clone /
│   │       │                           #   delete / export / import / templates
│   │       └── output.ts               # 轻量 color/box/table（无 chalk/cli-table3 依赖）
│   └── (CLI = 公开发布候选，目前 private + 走 workspace 内部)
├── apps/
│   └── desktop/                  # ✅ Electron + React + Vite（45 测试 / 2 文件）
│       ├── electron/             # main 进程 IPC handlers + preload bridge
│       │   ├── artifact-protocol.ts    # ★ v0.9：mosaiq-artifact:// 协议（截图缩略图）
│       │   └── artifact-protocol-core.ts # pure 路径解析（33 测试覆盖路径穿越）
│       ├── src/
│       │   ├── pages/            # PersonaListPage / Create / Edit / Clone /
│       │   │                     #   DetectionLabPage / DetectionRunDetailPage /
│       │   │                     #   DetectionRunComparePage / PersonaPoolPage
│       │   ├── components/       # ProxyFieldset / Toast / shadcn ui /
│       │   │                     #   detection-lab/{HitsBySurfaceRadar, RunsTrendChart,
│       │   │                     #   SiteResultCard, SurfaceHitBadge, PoolRadarChart,
│       │   │                     #   PoolSurfaceTable}
│       │   └── lib/artifact-url.ts     # mosaiq-artifact:// URL builder (12 测试)
│       └── scripts/dev.cjs       # 平台中立的 dev 启动器（含 ELECTRON_RUN_AS_NODE 修复）
└── docs/                         # 长期愿景 + HUMANIZE-DESIGN + V0.8-DETECTION-LAB 等
```

总测试数：26 + 593 + 64 + 45 = **728**。`pnpm test` 跑全部，CI 在 `.github/workflows/ci.yml` 每 PR + push 跑（typecheck + 4 包 vitest + captured-profiles drift check）。

---

## 常用命令

```powershell
# 全仓库 typecheck（4 包）
pnpm -r typecheck

# 全仓库 build（先 sdk + persona-schema，cli + desktop 依赖它们）
pnpm -r build

# 跑全部测试（26 schema + 593 sdk + 64 cli + 45 desktop = 728）
pnpm -r test

# 单包测试
pnpm --filter @mosaiq/persona-schema test
pnpm --filter @mosaiq/sdk test
pnpm --filter @mosaiq/cli test
pnpm --filter @mosaiq/desktop test

# 启动 desktop 应用（dev 模式 + 热重载）
pnpm dev:desktop

# 跑 mosaiq CLI（不需要 install，直接 tsx 执行 src 入口）
pnpm mosaiq detection-lab run <persona-id>
pnpm mosaiq personas list

# 跑 humanize 引擎 demo（启动 headed Chromium，10s 后自清理）
pnpm --filter @mosaiq/sdk demo:humanize

# Phase 7 captured-WebGL-profiles 工作流
pnpm --filter @mosaiq/sdk run bench:integrate-profiles            # 从 bench/captured-profiles/*.json 重新生成 TS
pnpm --filter @mosaiq/sdk run bench:integrate-profiles -- --check # CI drift gate（exit 1 = 漂移）

# 打包桌面应用为可分发安装包（使用 electron-builder）
pnpm --filter @mosaiq/desktop electron:dist

# 全仓 biome 格式化（lint 还未 CI 强制，convention 是 "changed files only clean"）
pnpm format
```

---

## 网络受限的中国大陆用户

`.npmrc` 已经预设了 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，pnpm install 会走国内镜像。

但 Playwright 的 Chromium 下载只能走官方 CDN（`playwright.azureedge.net`），npmmirror 对该路径覆盖不完整。如果下不动：

- 临时设置代理：`$env:HTTPS_PROXY="http://127.0.0.1:7890"; pnpm --filter @mosaiq/sdk exec playwright install chromium`
- 或者从 [playwright.azureedge.net/builds/chromium/1140/](https://playwright.azureedge.net/builds/chromium/1140/chromium-win64.zip) 手动下载，解压到 `%LOCALAPPDATA%\ms-playwright\chromium-1140\`

---

## SDK 进阶：humanize 输入引擎（v0.2）

上层 desktop UI 允许人手操作 Persona。如果你要写 Playwright 脚本 / 接 Stagehand 跟随 AI 代理走流程，直接调 `BrowserSession.humanize` 让鼠标/键盘走类人节律，避免「事件密度 / 轨迹直线 / 按键零间隔」被风控打分。

```ts
import { launchPersona, loadPersona } from '@mosaiq/sdk';

const persona = loadPersona('reddit-alpha');
const session = await launchPersona(persona, { headless: false });

// 类人输入：三阶贝塞尔鼠标轨迹 + lognormal flight 键盘节律
const h = await session.humanize({ speed: 'normal' });
await h.click('a.login');
await h.type('input[name=username]', 'alpha-user');
await h.type('input[name=password]', 'p@ssw0rd', {
  // 可选：启用 typo + Backspace 修正 (默认 0)
  typoRate: 0.05,
});
await h.click('button[type=submit]');
```

**设计要点**（完整设计见 [docs/HUMANIZE-DESIGN.md](./docs/HUMANIZE-DESIGN.md)）：
- 鼠标：三阶贝塞尔 + ease-in-out + 可选 overshoot，默认 60Hz 采样
- 键盘：dwell `N(70, 20)` clamp[25,250]、flight `lognormal(ln110, 0.35)` clamp[25,1000]，空格后 ×1.4 / 标点后 ×1.6 / 重复字符 ×0.8
- speed: `slow` / `normal` / `fast`，同时缩放 flight + dwell + mouse 时长
- 默认 seed = `humanize:<persona.id>`，同 persona = 一致输入风格，便于排查回放

### 跑 demo 肉眼验证

```powershell
pnpm --filter @mosaiq/sdk demo:humanize
```

会创建一个临时 persona、启动 Chromium、打开 [bot.sannysoft.com](https://bot.sannysoft.com)、跳动鼠标并输入一句话，10s 后自动关闭并清理。用 DevTools Performance 录一段就能看到 mousemove 事件是曲线而非直线。

---

## CLI 入门

`@mosaiq/cli` 是 v0.9 新增的 headless 入口，跟桌面读同一个 `~/.mosaiq/` store。**所有桌面能做的 persona / Detection Lab 操作，CLI 都能脚本化**。完整 per-command 文档见 [`packages/cli/README.md`](./packages/cli/README.md)（580 行）；这里只列最常用的几条。

```powershell
# 第一次：列出现有 persona（与桌面 PersonaListPage 一致）
pnpm mosaiq personas list

# 列出所有 OS 模板（与桌面 "新建 Persona" 卡片一致）
pnpm mosaiq personas templates list

# 创建一个新 persona（桌面创建表单的 CLI 等价物）
pnpm mosaiq personas create reddit-alpha `
  --template win11-chrome-us `
  --display-name "Reddit Alpha" `
  --timezone America/New_York `
  --tags "reddit,us,sticky" `
  --proxy "http://user:pass@residential.iproyal.com:12321" `
  --proxy-label "iproyal-us-sticky-001"

# 跑一次 Detection Lab（与桌面 "新 Run" 按钮一致；同一个 ~/.mosaiq/detection-runs/ store）
pnpm mosaiq detection-lab run reddit-alpha

# 看历史
pnpm mosaiq detection-lab list-runs reddit-alpha
pnpm mosaiq detection-lab show-run reddit-alpha <run-id>

# 导出某次 run 成 GitHub Flavored Markdown（贴 PR / Issue / Slack）
pnpm mosaiq detection-lab export-run reddit-alpha <run-id> --out report.md
```

### CI gate（关键 v0.9 用例）

**单 persona run-vs-run 回归**：

```powershell
# Exit 1 = run-b 比 run-a 有回归（新增 hits / Δweighted > 0 / 任一 site 翻 ok→fail）
pnpm mosaiq detection-lab compare reddit-alpha <baseline-run-id> <candidate-run-id> --fail-on-regression
```

**多 persona 全量批量（推荐 nightly cron）**：

```powershell
# 跑所有 persona 一遍；任一 persona 回归 → exit 1，CI 红
pnpm mosaiq detection-lab run-all --fail-on-regression

# 子集选择 + JSON 输出（喂 jq / dashboard）
pnpm mosaiq detection-lab run-all `
  --only "reddit-alpha,reddit-bravo" `
  --only-sites "creepjs,browserleaks-canvas,sannysoft" `
  --fail-on-regression `
  --json > batch-result.json
```

`run-all` 的 `BatchRunResult` JSON 包含每 persona status / weightedHits / regression flag + 聚合 `personasCompleted/failed`、worstPersona、Verdict 决策原因 — 直接喂 Grafana 或 Slack webhook。

### 与 SDK 关系

CLI 没有自己的反检测/注入逻辑 — 它是 `@mosaiq/sdk` 公共 API（`runDetection` / `formatDetectionRunMarkdown` / `diffRuns` / `listPersonas` / `savePersona` 等）的 thin wrapper。所有"算 detection score"、"format markdown"、"diff runs" 这种 pure logic 都住在 SDK，CLI 只做 argv 解析 + TTY 渲染 + 退出码策略。这意味着任何第三方脚本只要 `import { runDetection } from '@mosaiq/sdk'` 就能复制 CLI 行为。

---

## v0.10 的诚实边界

✅ **v0.10 比 v0.9 多解决的事**：

- ✅ **三发包包公开在 npm** — `@mosaiq/persona-schema` / `@mosaiq/sdk` / `@mosaiq/cli` 都是 0.10.0 lock-step 公开，外部 `npm i` 直装；之前必须 git clone monorepo
- ✅ **playwright-core 补丁随 SDK 分发** — `rebrowser-patches` 302 行 patch 通过 `patch-package` postinstall 自动作用到消费者的 `playwright-core@1.59.1`；之前只在 monorepo 内 pnpm 装时生效
- ✅ **版本管理自动化** — changesets 接管, 三发包包 `fixed` group 同进同退; 之前手工编辑 4 个 package.json + commit
- ✅ **发布前 tarball 审计** — `scripts/audit-tarballs.mjs` 在 CI + release.yml 都过, 防 `bench/` / `chromium-fork` / `*.test.*` 等意外漏进 npm
- ✅ **patch 漂移 gate** — `scripts/check-sdk-patch-drift.mjs` 锁住 workspace 根 `patches/` 与 `packages/sdk/patches/` 字节一致

✅ **从 v0.8/0.9 继承的关键能力**：

- ✅ **自检不再是手动入口** — Detection Lab 已 12 站 + 雷达图 + history trend + 池对比 + Compare Runs + Markdown 导出 + CLI run/run-all + 回归 gate；既有桌面 UI 又有脚本入口
- ✅ **WebGL 真机指纹收集流程已有** — Phase 7 captured-profiles 工作流（`bench:integrate-profiles`），用户能贡献自己的 GPU profile
- ✅ **AudioBuffer 已修** — Phase 6.1 per-(buffer, channel) 幂等 noise，CreepJS audio trap 关闭

⚠️ **当前仍然不能做的事**：

- **没有真 TLS 指纹层**（JA3/JA4 在 Playwright 模式下还是 Chrome 默认）。Cloudflare BotScore 严格站点能识别为「自动化 Chrome」。
  → 解决需要 Chromium fork + BoringSSL 层 patch（cold storage 中，触发器见 [`chromium-fork/STATUS.md`](./chromium-fork/STATUS.md)）。Detection Lab 站集里有 `browserscan` / `iphey` 能侧面映射 TLS 失败，但不是直接 JA3 比对
- **humanize 仅覆盖鼠标 + 键盘**，滚动惯性 / 页面停留时长 / 阅读 dwell 仍未建模
  → v0.11+ 计划：thinking pause（Pareto 500-3000ms）+ scroll inertia
- **没有 detection lab public leaderboard**（与 PRD 提到的 "公开 leaderboard 含 Browserbase / Multilogin / AdsPower 对比" 还有差距）
  → 需要持续 e2e 跑收集 + 静态站点托管，是 v0.11 候选
- **没有 Cloud Runtime**（与 PRD/WHITEPAPER 双引擎愿景的另一半还没开始）
  → K8s + gVisor + CDP-over-WebSocket gateway 是大工程，看市场反馈决定时机
- **CI 还没用自己的 Detection Lab 当反检测回归 gate**（v0.9 ship 了 `run-all --fail-on-regression`，v0.10 双轨规划里的 Track B 是接到 `.github/workflows/detection-lab.yml`，但 v0.10 只 ship 了 Track A npm 发行）
  → **v0.11 Track A 主线**；完整规划见 [V0.10 plan](./docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md) §10-12
- **没有 real-hardware capture v2**（Phase 7.0 WebGL capture 还没扩展到 audio / canvas / font 多 surface）
  → v0.11 候选；v0.10 npm 公开发行后才会有外部 contributor 池支持这件事
- **patch-package postinstall 与 `--ignore-scripts` 不兼容**（CI 用 `npm ci --ignore-scripts` 时反检测降级）
  → 文档明确写了绕开方法（手工 `npx patch-package --patch-dir node_modules/@mosaiq/sdk/patches`）。runtime warn 检查推到 v0.11 评估

---

## 下一步该做什么

如果你打算在这个仓库继续推进：

1. **`pnpm dev:desktop`，新建一个 persona，跑一次 Detection Lab**，看 12 站 + 雷达图 + 历史 trend；用截图缩略图打开 lightbox 检查每站抓到的页面
2. **`pnpm --filter @mosaiq/sdk demo:humanize`**，DevTools Performance 录鼠标轨迹确认是曲线
3. **`pnpm mosaiq detection-lab run-all`**，体感 CLI 批量入口 — 没 persona 会提示创建，有 persona 会按序跑
4. **找一个 sensitive 站点（Reddit / X / Cloudflare 严格站）实战跑一周**，被 shadowban 的指标提 Issue
5. **如果实战 OK 但想批量监控**：把 `mosaiq detection-lab run-all --fail-on-regression` 写到自己的 cron / GitHub Actions
6. **如果实战不 OK**：先 `compare` 出 baseline → candidate 的具体差异，定位是哪个 surface 退化的

---

## 内部参考（Mosaiq 长期愿景）

- 完整产品白皮书 + 商业战略 → [docs/WHITEPAPER.md](./docs/WHITEPAPER.md)
- PRD v0.2 → [docs/PRD.md](./docs/PRD.md)
- Detection Lab 完整设计 → [docs/V0.8-DETECTION-LAB.md](./docs/V0.8-DETECTION-LAB.md)
- humanize 引擎设计 → [docs/HUMANIZE-DESIGN.md](./docs/HUMANIZE-DESIGN.md)
- Chromium Fork 长期路线图 → [docs/CHROMIUM-FORK-GUIDE.md](./docs/CHROMIUM-FORK-GUIDE.md)（cold storage 中）
- 反检测 enterprise detector 调研 → [docs/ENTERPRISE-DETECTORS.md](./docs/ENTERPRISE-DETECTORS.md)

## 在仓库里写代码？

读一下 [DEVELOPMENT.md](./DEVELOPMENT.md) —— 累积了开发中踩过的坑（SDK 改完要重启 dev:desktop、init script 在 about:blank 不触发、UA 版本要与 chromium 引擎对齐等），帮你少走弯路。

CLI 完整 per-command 文档：[`packages/cli/README.md`](./packages/cli/README.md)（580 行，所有 flag + 退出码语义 + 示例）。
