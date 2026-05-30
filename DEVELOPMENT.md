# Mosaiq — 开发者笔记 (踩坑录)

面向**在这个仓库写代码的人**，不是面向用户的。用户文档见 [QUICKSTART.md](./QUICKSTART.md)。

每条都是真实踩过的坑，附根因和解法，避免下一个开发者重复浪费时间。

---

## 1. SDK 改动后必须重启 `pnpm dev:desktop`

**现象**：改了 `packages/sdk/src/**`，跑 `pnpm --filter @mosaiq/sdk build`，再去测桌面应用 —— 改动**没有生效**。

**根因**：`apps/desktop/vite.config.ts` 的 `rollupOptions.external` 只列了 `electron / playwright-core / playwright`，**`@mosaiq/sdk` 不是 external**。这意味着 vite-plugin-electron bundle main.cjs 时会把 SDK 整个 inline 进去。但是 vite-plugin-electron **只监听 `electron/main.ts` 的变化**，不会监听 `packages/sdk/dist/**` —— 所以 SDK 重新 build 了，dev 进程里的 main.cjs 还是上一次启动时打包的旧版本。

**解法**：

```powershell
# 1. 停掉当前 dev:desktop 进程（Ctrl+C 或关 Electron 窗口）
# 2. SDK 重 build
pnpm --filter @mosaiq/sdk build
# 3. 再启动 desktop（重启时 vite 会重新 bundle main.cjs，吃到最新 SDK）
pnpm dev:desktop
```

**验证 main.cjs 是否吃到最新 SDK**：找一个你刚加的字符串，grep `apps/desktop/dist-electron/main.cjs`，能搜到说明已 inline。

**如果以后想自动化**：在 `apps/desktop/vite.config.ts` 给 `vite-plugin-electron` 的 `main.vite.build` 加 `watch: { include: ['../../packages/sdk/dist/**'] }` —— 但当前没这么做，简单粗暴重启更省心。

---

## 2. 测试 init script 注入必须在真实 URL，不要在 `about:blank`

**现象**：启动 persona 后，在 chromium 默认打开的空白页 DevTools 跑 `navigator.deviceMemory` / `window.__某marker__`，**全是 undefined**，怀疑注入失败。

**根因**：Playwright 的 `context.addInitScript(fn, arg)` **不会在 `about:blank` 上执行**。它只在 page navigate 到一个真实文档时（new document loading）触发。`about:blank` 在 Playwright 看来不算 navigation。

**解法**：

1. 启动 persona 后，地址栏输入 `https://example.com` 或任何真实 URL
2. 等页面加载完
3. **在该页面**的 DevTools 跑测试代码

**验证 init script 真的执行了**：临时在 `injectAll` 顶部加一个 marker，例如：

```ts
Object.defineProperty(window, '__mosaiqInjected', {
  value: { ts: Date.now(), config },
  writable: false,
  enumerable: false,
  configurable: true,
});
```

build + 重启 dev:desktop，在真实 URL 上跑 `window.__mosaiqInjected`，能看到 `{ts, config}` 就证明 init script 跑了。debug 完记得删掉，避免被反检测站点用 `Reflect.ownKeys(window)` 扫到。

**别被表象误导**：以下指标即使 init script **没跑**，也会显示「正确」值：

- `navigator.userAgent` —— `launchPersistentContext` 的 `userAgent` 选项设置的，全局生效
- `navigator.webdriver` —— `--disable-blink-features=AutomationControlled` 启动 flag 让 chromium 内置不暴露 true
- `navigator.platform` / `vendor` —— chromium 在对应 OS 上的默认值
- `Intl.DateTimeFormat().resolvedOptions().timeZone` —— `timezoneId` 选项，全局生效

所以光看这些字段对就以为 init script 工作了，会被坑。要看 **WebGL UNMASKED_RENDERER 是否被改成模板里的 GPU 字符串** 之类的、只能靠 init script 修改的指标。

---

## 3. UA 版本和 chromium 引擎版本必须对齐

**现象**：BrowserScan 等高级反检测站会比对 `navigator.userAgent` 声称的 Chrome 版本与浏览器实际行为推断的版本，mismatch 直接判 Robot。

**解法**：`@/d:/projects/Mosaiq/packages/sdk/src/chromium-version.ts` 在 launch 时动态读 `playwright-core/browsers.json` 取真实版本，覆盖 persona 模板里硬编码的 `browser.fullVersion`。Persona 持久化文件不被修改，仅在内存里替换给注入用。

**升级 playwright-core 时**：

- pnpm 会自动同步 `browsers.json` 里的 chromium 版本
- 我们的代码自动跟随，**不需要改 persona 模板**
- 但如果新 chromium 引入了什么新的 `navigator.*` 字段或行为变更，可能需要在 `injection/runner.ts` 补 spoof

`chromium-version.ts` 里有个硬编码 `FALLBACK_CHROME_VERSION` 兜底（极端情况下读 browsers.json 失败时用），升级 playwright-core 时记得同步改一下，让兜底值不至于太陈旧。

---

## 4. Navigator 类属性的 spoof 必须改 prototype 层级

**现象**：用 `Object.defineProperty(navigator, 'webdriver', ...)` 直接在 instance 上覆盖，反检测库通过 `Object.getOwnPropertyDescriptor(navigator, 'webdriver')` 检测到 own property 立即识破。

**根因**：真实 Chrome 里 `navigator.webdriver` / `deviceMemory` / `userAgent` 这些字段的 getter 都挂在 `Navigator.prototype` 或更深的 mixin prototype（如 `NavigatorDeviceMemory`）上，instance 上**没有** own property。注入到 instance 上 = 自露马脚。

**解法**：见 `@/d:/projects/Mosaiq/packages/sdk/src/injection/runner.ts` 的 `defineProtoGetter`。流程：

1. 从 navigator 实例往上 walk prototype 链，找到属性真实定义所在的 proto
2. 在该 proto 上用 `Proxy` 包装原生 getter，apply 时返回 fake 值，但 `getter.toString()` 仍输出 `[native code]`
3. 反检测的三个常见探针都被绕过：
   - `Object.getOwnPropertyDescriptor(navigator, 'X')` —— 无 own property ✓
   - `Object.getOwnPropertyDescriptor(Navigator.prototype, 'X')` —— 仍有 getter ✓
   - `getter.toString().includes('[native code]')` —— 是 ✓

加新 navigator 字段 spoof 时，直接调 `defineProtoGetter(navigator, 'X', value)` 就行，walker 自动找位置。

---

## 5. pnpm + Electron 的依赖路径

`apps/desktop/dist-electron/main.cjs` 运行时 `require('playwright-core')` 走 Node 的 module resolution。pnpm 在 `apps/desktop/node_modules/playwright-core` 留了 symlink 指向 `.pnpm/playwright-core@1.59.1/...`。所以：

- `apps/desktop/package.json` 里 `playwright-core` **必须显式声明**（即使 SDK 已声明），否则 pnpm 不会在 desktop 的 node_modules 里建 symlink，运行时 require 会找不到
- 版本号建议**精确锁定**（不用 caret），避免 SDK 与 desktop 的 chromium 不一致
- SDK 的 `playwright-core` 也要精确锁定（`packages/sdk/package.json`）

升级 playwright-core 时同时改这两个文件，跑 `pnpm install`。

---

## 6. v0.1 反检测的诚实边界

`SDK init script + chromium launch flags` 这条路只能覆盖 JS 层指纹。下面这些 v0.1 都做不到，**别浪费时间在 SDK 里追**：

- **TLS JA3/JA4 指纹** —— Playwright 用的是 chromium 自带的 BoringSSL，握手特征是真 Chrome 的，但和我们模板声称的 OS 不一定 100% 对齐。要改只能 fork BoringSSL。
- **HTTP/2 SETTINGS / window-size 指纹** —— 同上。
- **Behavioral fingerprint**（鼠标轨迹、键盘节奏） —— 自动化时仍是机器人模式。
- **Pixelscan 的 "inconsistent" 标记** —— Pixelscan 用了多种行为侧通道（字体探测时间差、JS 引擎 timing、Canvas 子像素细节），v0.1 注入层不可能全过。

**v0.1 设计目标**：BrowserScan 全部 Normal、可以正常登录 Reddit / X / Gmail 等中等敏感站点。Cloudflare BotScore 严格保护的站点和 Pixelscan 完美一致是 v0.2+ 工作。

---

## 7. tsx/esbuild keepNames 把 init script 序列化坑成静默死

**现象**：`navigator.userAgent` 看着是 persona 声称的 UA，`Intl.DateTimeFormat().resolvedOptions().timeZone` 也对，但 `navigator.hardwareConcurrency` 是真实硬件值（不是 persona 声称的），`WebGLRenderingContext.prototype.getParameter.toString()` 显示 `[native code]`（说明 hook 没生效），canvas hash 是真实硬件 raster 出来的。`bench/baseline-detection.ts` 跑下来一堆 hits，但**所有 hits 都不是真问题** —— 是注入栈整体没生效。

**根因**：tsx 用 esbuild 加载 `.ts` 文件，esbuild 默认开 `keepNames`。在编译 `runner.ts` 时，所有 `function fn() {}` declaration 之后会自动 append `__name(fn, "fn")` 调用，所有 `const x = function() {}` / `const x = () => {}` 也会被改写成 `const x = __name(function() {}, "x")`。这是 esbuild 用来保留 `Function.prototype.name` 的。

但 Playwright 的 `context.addInitScript(callback, arg)` 用 `callback.toString()` 序列化函数注入到 chromium init-script world，**那个 world 不暴露 esbuild 的 `__name` helper**。结果：

```js
// chromium 里跑的代码（赋值给 init script）：
function makePrng(seed) { ... }
__name(makePrng, "makePrng");  // ← ReferenceError: __name is not defined
function defineReadOnly(obj, key, value) { ... }
__name(defineReadOnly, "defineReadOnly");  // 永远到不了
...
try {
  defineProtoGetter(navigator, 'userAgent', config.userAgent);
  ...
} catch (err) {
  console.debug('[mosaiq] navigator spoof failed', err);
}
```

整个 `injectAll` 函数体在第一行 `__name(makePrng, "makePrng")` 就挂了。**所有反检测 spoof 都没跑过**。表面上看 navigator/screen/timezone "对了"，是因为：

- `navigator.userAgent`：`launchPersistentContext({ userAgent: ... })` 选项独立设置（绕过 init script）
- `timezone`：`launchPersistentContext({ timezoneId: ... })` 同上
- `navigator.platform`：chromium 在 OS 上的默认值碰巧匹配 Win11 persona

**解法**：见 `@d:/projects/Mosaiq/packages/sdk/src/launcher.ts:114-128`。把 `addInitScript(injectAll, config)` 改用 string 形式，prepend `__name` polyfill：

```ts
const namePolyfill =
  'globalThis.__name=globalThis.__name||function(f){return f};';
const script = `${namePolyfill}(${injectAll.toString()})(${JSON.stringify(injectionConfig)});`;
await context.addInitScript({ content: script });
```

**回归保护**：
- `@d:/projects/Mosaiq/packages/sdk/src/launcher.test.ts` 白盒检查 launcher.ts 含 polyfill + 用 string 形式
- `@d:/projects/Mosaiq/packages/sdk/bench/diagnose-webgl.ts` 启动真 chromium 验证 9 项 spoof 全生效

**验证 polyfill 生效**：跑 `pnpm --filter @mosaiq/sdk exec tsx bench/diagnose-webgl.ts`，看末尾 `summary: 9/9 pass, 0 fail` + `typeof_name: "function"`。任何回归会立刻把这数字打回 1/9。

**未来加新 init script 时**：所有 `addInitScript` 都必须用 string 形式 + 带 polyfill。如果有第二处需要注入，把 polyfill+IIFE 提成共享 helper（`packages/sdk/src/injection/inject-helper.ts`）。

---

## 8. 已知后续 / 技术债（开 issue / 动手前先看这里）

这些是已识别、有意**暂缓**的项，附原因与触发条件，避免重复发现 + 防止误以为没人知道。

| 项 | 现状 | 触发 / 解冻条件 |
|---|---|---|
| **Biome 全仓清理** | `pnpm lint` 仍约 500 条 legacy findings（pre-v0.8 bench 脚本 + 部分 renderer 页面 + 2k 行 `runner.ts`）。CI 的 `lint` job 因此设为 **non-blocking**（`biome ci --changed` 会整文件 lint，碰到 legacy 文件会 false-fail）。 | 全仓清理（注意 `--unsafe` 自动修复别碰 `runner.ts`，手工逐条）后，去掉 `.github/workflows/ci.yml` `lint` job 的 `continue-on-error`，翻成 blocking。 |
| **`runner.ts` worker-scope 注入串重复** | worker spoof 是约 270 行内嵌字符串（`src/injection/runner.ts` §11），与 main scope 逻辑手工保持同步，易漂移。 | 提取共享生成器。**高风险**（crown-jewel 文件，esbuild 序列化 + 真 Chromium 行为只能 E2E 验证，见 §7），动手前先补 `bench/diagnose-*.ts` 的真 Chromium 回归覆盖。 |
| **Cloud 服务端注入** | ✅ **已实现（v0.11，默认开启）**：pod `src/inject.ts` `applyServerStealth` 用 connectOverCDP + addInitScript 注册 `injectAll`，裸 connectOverCDP 也带深层 stealth。**三重验证**：真 pod 本地实测 + pod/cloud-runtime Docker build + **全链路 `docker-compose.local-docker.yml` e2e 跑绿**（e2e-smoke 的「不调 injectInto 也 spoof」断言通过）。 | 剩余：CI（`cloud-runtime-e2e.yml`）+ Fly 生产侧用同 smoke 跑绿后正式对外承诺。每 session `stealth.inject`、pod `POD_SERVER_INJECT` 可即时回退。 |
| **Cloud 单点拓扑** | `cloud-runtime` 单 SQLite 卷 + 单 region + 内存态（rate-limit / sticky registry / machine pool）= 单实例、单点。alpha 可接受。 | 接真实付费客户 / 需要 SLA 前，定多实例 + Postgres / 共享存储 + 分布式锁方案。 |

---

_文档持续累积。新踩到的坑请追加在这里，附根因 + 解法。_
