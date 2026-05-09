# Mosaiq v0.1 — Quickstart

> **当前里程碑**：v0.1 = 个人自用级反检测桌面浏览器。架构是 **Playwright + CDP 注入**，不是 Chromium fork。
> 这是务实起步：1 周可跑通，1 个月用得舒服，半年内根据实战需求决定是否继续推进 native 内核。

---

## 你能拿到什么

打开 Mosaiq Desktop，你会看到：

- **Persona 列表**：每个 Persona = 一个独立浏览器身份（自己的 Cookie、缓存、IndexedDB、指纹、代理）
- **新建 Persona**：选模板 → 填 ID + 显示名 → 选时区 → 配代理（可选） → 创建
- **启动 / 停止**：点击启动 → 本机 Chromium 弹出，已注入完整反检测脚本 + 代理
- **一键自检**：在已启动的 Persona 里打开 pixelscan + browserscan 检查指纹一致性

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

## 仓库布局（v0.1 实际状态）

```
Mosaiq/
├── packages/
│   ├── persona-schema/           # ✅ Zod schema + JSON Schema 导出 + 模板
│   │   ├── src/
│   │   │   ├── persona.ts        # 完整 Persona 类型定义
│   │   │   ├── templates.ts      # win11-chrome-us / macos-sonoma-chrome-us
│   │   │   ├── validate.ts       # validatePersona() / safeValidatePersona()
│   │   │   └── jsonSchema.ts     # 用于跨语言互操作 / IDE 提示
│   │   └── tests/                # 10 个测试全部通过
│   └── sdk/                      # ✅ Playwright 包装 + CDP 注入引擎
│       ├── src/
│       │   ├── launcher.ts       # launchPersona() 主 API
│       │   ├── scripts/          # 7 个反检测脚本（runtime 注入）
│       │   ├── persona-store.ts  # 文件系统 CRUD
│       │   └── ua.ts             # User-Agent 字符串 / Accept-Language 构造
│       └── ...
├── apps/
│   └── desktop/                  # ✅ Electron + React + Vite
│       ├── electron/             # main 进程 + preload IPC bridge
│       ├── src/
│       │   ├── pages/            # PersonaListPage / PersonaCreatePage
│       │   └── components/ui/    # shadcn 风组件（Button / Card / Input / ...）
│       └── scripts/dev.cjs       # 平台中立的 dev 启动器（含 ELECTRON_RUN_AS_NODE 修复）
└── docs/                         # 长期愿景文档（未变）
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

## v0.1 的诚实边界

⚠️ **当前还不能做的事**：

- 没有真 TLS 指纹层（JA3/JA4 在 Playwright 模式下还是 Chrome 默认）。Cloudflare BotScore 严格站点能识别为「自动化 Chrome」。
  → 解决方案：v0.2 引入 BoringSSL fork 或者借助 `undetected-chromedriver` patch。
- 没有键鼠生物特征模拟（自动化操作时鼠标轨迹、击键间隔仍是 robotic）。
  → 解决方案：v0.2 接入 `ghost-cursor` + 自研 Bezier + Beta 分布
- 没有 detection lab leaderboard，只有手动自检入口。
- 没有 Chromium fork（与 PRD/WHITEPAPER 的最终愿景有差距）。
  → 这是有意识的：v0.1 在 1 周内交付能用工具，比 6 个月才有第一个 patch 实在。

---

## 下一步该做什么

如果你打算在这个仓库继续推进：

1. **拉一遍 `pnpm dev:desktop`，亲手跑一次自检**，体感反检测注入的实际效果
2. **找一个 Reddit 账号实战**，跑一周，看会不会被 shadowban；这是真正的市场反馈
3. **如果实战 OK，再投资 v0.2**：TLS 指纹 + 键鼠生物特征
4. **如果实战不 OK**，根据具体被检测的指标针对性增强 — 不要无脑追求"完美"

---

## 内部参考（Mosaiq 长期愿景）

- 完整产品白皮书 + 商业战略 → [docs/WHITEPAPER.md](./docs/WHITEPAPER.md)
- PRD v0.2 → [docs/PRD.md](./docs/PRD.md)
- Chromium Fork 长期路线图 → [docs/CHROMIUM-FORK-GUIDE.md](./docs/CHROMIUM-FORK-GUIDE.md)

## 在仓库里写代码？

读一下 [DEVELOPMENT.md](./DEVELOPMENT.md) —— 累积了开发中踩过的坑（SDK 改完要重启 dev:desktop、init script 在 about:blank 不触发等），帮你少走弯路。
