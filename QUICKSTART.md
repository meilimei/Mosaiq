# Mosaiq v0.2 — Quickstart

> **当前里程碑**：v0.1 全部完成 + v0.2 humanize 引擎落地。架构是 **Playwright + CDP 注入**，不是 Chromium fork。
> 这是务实起步：1 周可跑通，1 个月用得舒服，半年内根据实战需求决定是否继续推进 native 内核。

---

## 你能拿到什么

打开 Mosaiq Desktop，你会看到：

- **Persona 列表**：每个 Persona = 一个独立浏览器身份（自己的 Cookie、缓存、IndexedDB、指纹、代理）
- **新建 Persona**：从 **4 个模板**（Win11 / Win10 / macOS Sonoma / Ubuntu 22.04）选一个 → 填 ID + 显示名 → 选时区 → 配代理（可选） → 创建
- **启动 / 停止**：点击启动 → 本机 Chromium 弹出，已注入完整反检测脚本 + 代理
- **一键自检**：在已启动的 Persona 里打开 pixelscan + browserscan 检查指纹一致性
- **搜索 + 标签筛选**：Persona 多了用顶部搜索框按 displayName / id / notes / 代理标签过滤，点 chip 多选标签做 AND 筛选
- **导入 / 导出 JSON**：每个 Persona 卡片右上角点 ⬇️ 可导出（默认脱敏代理密码），顶部点 ⬆️ 导入；ID 冲突自动重命名为 `<id>-imported`，永不覆盖现有 persona

注入的反检测维度（都在浏览器加载第一行 JS 之前完成）：

- `navigator.userAgent` / `userAgentData` — 与 OS / browser 模板一致
- `Accept-Language` / `navigator.languages` — 与 Persona 语言一致
- `navigator.platform` / `oscpu` / `vendor` — 跨 OS 一致
- `navigator.hardwareConcurrency` / `deviceMemory` — 用 Persona 中真实设备值
- `screen.*` / `window.devicePixelRatio` — 分辨率一致
- 时区（`Intl`、`Date.getTimezoneOffset` 全协调）
- Canvas / WebGL 噪声（每 Persona 不同的稳定种子，`getImageData` / `getParameter` 加噪）
- AudioContext fingerprint 偏移
- WebGL VENDOR / RENDERER 字符串（与模板 GPU 匹配）
- `RTCPeerConnection` 屏蔽 STUN candidate 泄漏真实 IP
- `permissions.query`、`mediaDevices.enumerateDevices` 一致化
- 字体探测对 fallback metric 加噪

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

## 仓库布局（v0.2 实际状态）

```
Mosaiq/
├── packages/
│   ├── persona-schema/           # ✅ Zod schema + 4 模板（17 测试）
│   │   ├── src/
│   │   │   ├── persona.ts        # Persona 类型定义 + parsePersona / safeParsePersona
│   │   │   ├── templates/        # win11 / win10 / macos-sonoma / ubuntu-2204
│   │   │   ├── fingerprint.ts    # canvas / webgl / audio / fontList / webrtc 子 schema
│   │   │   ├── system.ts         # OS / locale / timezone / screen 子 schema
│   │   │   └── utils/seed.ts     # mulberry32 + xfnv1a，与 sdk humanize 共用 PRNG 算法
│   │   └── 17 tests
│   └── sdk/                      # ✅ Playwright 包装 + CDP 注入 + humanize 引擎（143 测试）
│       ├── src/
│       │   ├── launcher.ts             # launchPersona() 主 API
│       │   ├── browser-session.ts      # context + firstPage + humanize getter
│       │   ├── injection/              # 反检测 init script 模板 + runner（注入到页面）
│       │   ├── humanize/               # ★ v0.2：mouse / keyboard / rng / Humanize 类
│       │   ├── persona-store.ts        # 文件系统 CRUD
│       │   ├── persona-portability.ts  # ★ v0.1：导入/导出 JSON + 冲突解决
│       │   ├── proxy.ts                # 代理 URL 构造 + Playwright proxy 转换 + 验证
│       │   ├── ua.ts                   # User-Agent + Accept-Language 构造
│       │   └── chromium-version.ts     # 读取 playwright-core Chromium 版本号
│       └── examples/humanize-demo.ts   # 一键跑通 humanize 的可执行示例
├── apps/
│   └── desktop/                  # ✅ Electron + React + Vite
│       ├── electron/             # main 进程 IPC handlers + preload bridge
│       ├── src/
│       │   ├── pages/            # PersonaListPage（搜索/筛选/导入/导出）/ Create / Edit / Clone
│       │   └── components/       # ProxyFieldset / Toast / shadcn ui
│       └── scripts/dev.cjs       # 平台中立的 dev 启动器（含 ELECTRON_RUN_AS_NODE 修复）
└── docs/                         # 长期愿景 + HUMANIZE-DESIGN.md（v0.2 设计稿）
```

---

## 常用命令

```powershell
# 全仓库 typecheck
pnpm -r typecheck

# 全仓库 build
pnpm -r build

# 跑 persona-schema 测试
pnpm --filter @mosaiq/persona-schema test

# 仅 build SDK / Schema
pnpm --filter @mosaiq/sdk build
pnpm --filter @mosaiq/persona-schema build

# 启动 desktop 应用（dev 模式 + 热重载）
pnpm dev:desktop

# 跑 humanize 引擎 demo（启动 headed Chromium，10s 后自清理）
pnpm --filter @mosaiq/sdk demo:humanize

# 跑全部测试（17 schema + 143 sdk = 160 个）
pnpm -r test

# 打包桌面应用为可分发安装包（使用 electron-builder）
pnpm --filter @mosaiq/desktop electron:dist
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

## v0.2 的诚实边界

⚠️ **当前还不能做的事**：

- 没有真 TLS 指纹层（JA3/JA4 在 Playwright 模式下还是 Chrome 默认）。Cloudflare BotScore 严格站点能识别为「自动化 Chrome」。
  → v0.3+ 在 Chromium fork 后 BoringSSL 层处理，v0.2 范围之外。
- humanize 仅覆盖鼠标 + 键盘，尚未覆盖滚动惯性 / 页面停留时长建模。
  → v0.4 计划作 thinking pause（Pareto 分布 500–3000ms）+ scroll inertia。
- 没有 detection lab leaderboard，只有手动自检入口。
- 没有 Chromium fork（与 PRD/WHITEPAPER 的最终愿景有差距）。
  → 这是有意识的：v0.1–0.2 在 < 1 个月内交付能用工具，比 6 个月才有第一个 fork patch 实在。

---

## 下一步该做什么

如果你打算在这个仓库继续推进：

1. **拉一遍 `pnpm dev:desktop`，亲手跑一次自检**，体感反检测注入的实际效果
2. **跑一跑 `pnpm --filter @mosaiq/sdk demo:humanize`**，看看 humanize 产出的鼠标轨迹 / 键盘节律
3. **找一个 Reddit 账号实战**，跑一周，看会不会被 shadowban；这是真正的市场反馈
4. **如果实战 OK，再投资 v0.3+**：TLS/JA4 伪装 + Chromium fork 反检测 patch
5. **如果实战不 OK**，根据具体被检测的指标针对性增强 — 不要无脑追求"完美"。

---

## 内部参考（Mosaiq 长期愿景）

- 完整产品白皮书 + 商业战略 → [docs/WHITEPAPER.md](./docs/WHITEPAPER.md)
- PRD v0.2 → [docs/PRD.md](./docs/PRD.md)
- Chromium Fork 长期路线图 → [docs/CHROMIUM-FORK-GUIDE.md](./docs/CHROMIUM-FORK-GUIDE.md)

## 在仓库里写代码？

读一下 [DEVELOPMENT.md](./DEVELOPMENT.md) —— 累积了开发中踩过的坑（SDK 改完要重启 dev:desktop、init script 在 about:blank 不触发等），帮你少走弯路。
