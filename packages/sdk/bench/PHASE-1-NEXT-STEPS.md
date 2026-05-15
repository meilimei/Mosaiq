# Phase 1 Next Steps — 基于 Baseline Detection 报告的执行计划

> 生成于：2026-05-13  
> 更新于：2026-05-14 晚（Day 1.4 完成 + Day 1.5 toString hook detection 新发现，见下方 §0.5）  
> 数据来源：`bench/results/2026-05-13T13-40-40-061Z/`（headless）+ `bench/results/2026-05-13T13-43-22-656Z/`（headed pre-fix）+ `bench/results/2026-05-14T10-52-54-209Z/`（headed post-fix）+ `bench/results/2026-05-14T11-42-00-603Z/`（webgl-only post-Day-1.4）

## 0. 🚨 Update 2026-05-14：esbuild `__name` helper undefined Bug

### TL;DR

发现 SDK 反检测注入栈**整体未生效**的根因：tsx/esbuild keepNames 把 runner.ts 编译成 13 处 `__name(fn, "name")` 调用，但 chromium init-script world 没暴露这个 helper → 第一处 `__name(makePrng, "makePrng")` 抛 ReferenceError → 整个 `injectAll` 函数静默死亡。

navigator.userAgent / hardwareConcurrency / WebGL spoof / Canvas noise / 时区 / 字体 / WebRTC / chrome shim **全部都没真正生效**。baseline 测出来的"通过"项是**chromium 真实数据碰巧匹配 persona**（如 UA 走 Playwright contextOptions.userAgent 路径，绕过 init script）。

### 诊断证据链

写 `bench/diagnose-webgl.ts` 在真实 chromium 内 evaluate：

| 检查项 | Pre-fix | Post-fix |
|---|---|---|
| `typeof globalThis.__name` | `"undefined"` | `"function"` ✅ |
| `WebGLRenderingContext.prototype.getParameter.toString()` | `[native code]`（未 hook） | hooked ✅ |
| WebGL1 `getParameter(0x9246)` | `Intel HD 520`（真实硬件） | `Intel UHD 730`（persona）✅ |
| WebGL2 同上 | 真实 | persona ✅ |
| OffscreenCanvas WebGL1 | 真实 | persona ✅ |
| `nav.hardwareConcurrency` | 4（真实 i7-6500U） | 8（persona）✅ |
| Canvas hash | `1c6abd493317125a`（真实 GPU rasterize） | `9c696fd94970afb7`（noise 生效）✅ |
| 测试通过 | 1/9 | **9/9** ✅ |

### 修复

`@d:\projects\Mosaiq\packages\sdk\src\launcher.ts:114-128` 把 `addInitScript(injectAll, config)` 改成 string 形式，prepend `__name` polyfill：

```ts
const namePolyfill =
  'globalThis.__name=globalThis.__name||function(f){return f};';
const script = `${namePolyfill}(${injectAll.toString()})(${JSON.stringify(injectionConfig)});`;
await context.addInitScript({ content: script });
```

### 此 Bug 重写了整份 NEXT-STEPS

之前 §1.2 "Headless 是包袱"和 §1.3 "真正的问题"全部基于错误前提（以为 spoof 在 headed 模式下生效，只剩 WebGL/Canvas 两个真问题）。**实际情况**：

- ❌ headless vs headed 的差异**不是 headless artifact** —— 是 **headed 模式下 chromium 自身行为更接近真实，掩盖了 spoof 失效**。
- ✅ **现有 SDK 注入栈本身设计正确**（runner.ts 逻辑没问题），只是被序列化坑害。
- ✅ Phase 1 `__name` polyfill 是**单点修复**，让 7 个反检测 surface（navigator/screen/Intl/WebGL/Canvas/Audio/Fonts/WebRTC/chrome/permissions）**全部从死状态变活**。

### 当前 baseline 状态（2026-05-14 post-fix）

```text
Headed run, 6/6 sites OK, 56.7s
hits: 2  ← 跟 pre-fix 一样数字，但语义完全不同！
top surfaces: canvas, webgl
```

**关键说明**：reporter 仍报 2 hits，但**这 2 项不再是 spoof 失败**，而是 `sites.ts` 的检测判定标准过严：

1. **WebGL "unmasked GPU info" hit**：browserleaks 给所有暴露 unmasked 的浏览器打 `!` 标记（不论真假），所以即使 unmasked 显示 `Intel UHD 730`（persona）仍被 sites.ts 判 fail。**实际 spoof 已成功**。
2. **Canvas "signature unique=100%" hit**：noise 让 hash 每次跑都新（deterministic per persona × random ephemeral persona seed），browserleaks 数据库自然没匹配。**这是 noise 设计目标，不是 bug**。

### Day 1 完成清单

- [x] Day 1.1 诊断（找到 `__name` 根因）
- [x] Day 1.2 修复（launcher.ts polyfill）
- [x] Day 1.3 清理诊断工具 + 文档（本节 + `DEVELOPMENT.md` §7 + `launcher.test.ts` regression 守卫）
- [x] **Day 1.4 完成**：reporter cross-check 接入 persona 期望值（见 §0.5）
- [x] **Day 1.5 调查**：BrowserLeaks `! ` 前缀根因锁定为 `getParameter.toString()` hook detection（见 §0.5）

---

## 0.5. Day 1.4-1.5 Update：Reporter cross-check + toString hook detection 发现

### Day 1.4：Reporter cross-check 接入 persona 期望值

**问题**：旧的 reporter 把 BrowserLeaks 的 unmasked vendor/renderer **存在性** 当 fail，导致即使 spoof 成功（unmasked 已被替换为 persona 声称的值）仍报 hit。

**修复**（`@d:/projects/Mosaiq/packages/sdk/bench/report.ts:298-368`）：

1. `baseline-detection.ts` 在 `raw.json` 多保存 `persona.hardware` + `persona.fingerprint` 字段
2. `report.ts` 的 `analyzeBrowserleaksWebgl` 改用 cross-check：
   - 取 `persona.hardware.gpu.webglVendor` / `webglRenderer` 作为期望值
   - normalize 后用子字符串匹配（站点可能加 `! ` / 大小写差异）
   - 一致 → 不 hit + 输出 `✅ WebGL spoof 验证通过`
   - 不一致 → high hit `unmasked vendor/renderer mismatch`
3. `analyzeBrowserleaksCanvas` 改用 uniqueness 阈值：
   - hash 缺失 → high hit
   - uniqueness > 50% → medium hit (noise 不足)
   - 其他 → info only（单次 run 无法判断 noise 是否真的生效，留给 Day 2+ cross-run）

**验证**（`bench/results/2026-05-14T11-42-00-603Z/report.md`）：

```text
**Unmasked Vendor**：! Google Inc. (Intel)
**Unmasked Renderer**：! ANGLE (Intel, Intel(R) UHD Graphics 730 ... D3D11)
**Persona 期望 Vendor**：Google Inc. (Intel)
**Persona 期望 Renderer**：ANGLE (Intel, Intel(R) UHD Graphics 730 ... D3D11)

> ✅ WebGL spoof 验证通过 — unmasked vendor / renderer 与 persona 声称一致
```

### Day 1.5 → Day 2.1：BrowserLeaks `! ` 前缀的真相（已反转）

**初始假设（错误）**：以为 `!` 是 BrowserLeaks 的 hook detection 输出，由 `getParameter.toString()` 不返回 `[native code]` 触发。

**Day 2.1 验证**：把 runner.ts WebGL spoof 改用 `Proxy` 包装，让 `getParameter.toString()` 透明 forward 到 target，返回 `function () { [native code] }`。`diagnose-webgl.ts` 9/9 pass，`getParameterIsHook: false` ✅。

**但 BrowserLeaks 还在标 `!`**。

**真相**：拉 `https://browserleaks.com/js/webgl.js` 源码读，精简后的关键逻辑：

```js
// 渲染 UNMASKED_RENDERER_WEBGL / UNMASKED_VENDOR_WEBGL 行：
t = i.toString();  // i = d[c][e.id]，即从 gl.getParameter 拿到的值
if (e.id.indexOf("UNMASKED_") !== -1 && t === d[c][e.id]) {
  t = ico(3) + t;  // ico(3) 就是那个 `!` span
}
```

`t === d[c][e.id]` 几乎永远为真（i 是字符串时，toString 不变）。所以：

> **`!` 不是 hook detection — 是 BrowserLeaks 给所有暴露 UNMASKED_* 字段的浏览器统一加的"隐私警告"**（Firefox 等需要 `webgl.enable-debug-renderer-info` 才能看，BrowserLeaks 在提示用户"这个浏览器暴露了 GPU 信息"）。

我们的 spoof 在 Day 1.4 cross-check 通过后**已经完全成功**。`!` 只是产品提示，不是反检测。

### Day 2.1 的实际价值

虽然 Proxy 不是为了消 `!`，但**仍然保留**，原因：

1. **CreepJS / iphey 等深度站确实查 toString hook** — Proxy 让我们对这些站隐形
2. **基本反检测卫生** — 任何留下 JS 源码的 hook 都是把柄，长期看会被新检测器抓
3. **不影响 spoof 功能** — diagnose 9/9 仍 pass

修改：`@d:/projects/Mosaiq/packages/sdk/src/injection/runner.ts:264-329`

```ts
const makeGetParameterProxy = (orig) => new Proxy(orig, {
  apply(target, thisArg, args) {
    const [pname] = args;
    if (pname === WEBGL_UNMASKED_VENDOR) return config.webglVendor;
    if (pname === WEBGL_UNMASKED_RENDERER) return config.webglRenderer;
    return Reflect.apply(target, thisArg, args);
  },
});
WebGLRenderingContext.prototype.getParameter = makeGetParameterProxy(
  WebGLRenderingContext.prototype.getParameter,
);
// WebGL2 / readPixels 同样处理
```

### 衍生工作清单（更新）

- [x] **Day 1.3 加 regression 守卫** — 完成（`@d:/projects/Mosaiq/packages/sdk/src/launcher.test.ts`）
- [x] **Day 1.3 检查其他 IIFE** — grep 全仓库确认 launcher.ts 是唯一 `addInitScript` 调用方
- [x] **Day 1.4 reporter cross-check** — 完成
- [x] **Day 2.1 Proxy 改造** — 完成，diagnose 9/9 pass，但确认 `!` 标记并非 hook detection 触发
- [x] **Day 2.2 CreepJS extractor** — 修 sites.ts selector + report.ts 输出 lies surface 列表（锁定 6 lies + 1 bold-fail）+ launcher.test.ts 加 2 条 Proxy 改造 regression guards
- [ ] **Day 2.3** _(deferred)_：webgl-spoof 抽成单独模块 `webgl-spoof.ts` + 加单测 — 当前 white-box regression guards 已守住核心，模块化 ROI 低，留待 e2e 测试基础设施建立后再做
- [ ] **Phase 1.5：Worker fingerprint** — 当前 init script 只在 main world 跑，Web Worker 内 `navigator` / WebGL 仍泄露真实值。修复：用 Playwright `page.addInitScript` + Worker hook。
- [ ] **chromium-级 e2e 测试**：Worker / OffscreenCanvas / iframe nested context 的 spoof 都要被测。
- [ ] **Canvas cross-run 验证脚本**：`bench/canvas-cross-check.ts` — 同 persona 跑 N 次，验 hash 一致；不同 persona 跑 N 次，验 hash 全不同。

---

## 0.7. Day 3 战果：Intl bold-fail 完全消除 + SpeechSynthesis spoof（2026-05-14 晚）

### TL;DR

```text
Day 2.2 baseline: 6 lies + 1 bold-fail (Intl) = 7 hits
Day 3.5 现在:    6 lies + 0 bold-fail        = 6 hits  (-1, 干掉唯一 bold-fail)
```

**Intl bold-fail 是 CreepJS 唯一的 high-severity 信号**，现已完全消除。

### Day 3.1-3.2：CreepJS 源码逆向 + diagnose 脚本

拉了 `lies/index.ts` + `creep.js` bundle (550KB)，在 chromium 内 grep + 写 `bench/diagnose-creepjs.ts` 复现 lies detector。

**锁定 8 个 hook detection 路径**（`lies/index.ts:195-260`）：
1. `Function.prototype.toString.call(fn)` 含正确 native name + `[native code]`
2. `'prototype' in fn` 必须 false（native method 不能 constructable）
3. `Object.getOwnPropertyDescriptor(fn, 'arguments|caller|prototype|toString')` 必须全 undefined
4. `fn.hasOwnProperty('arguments|caller|prototype|toString')` 全 false
5. `Object.keys(Object.getOwnPropertyDescriptors(fn)).sort().join(',')` 必须 = `'length,name'`
6. `Object.getOwnPropertyNames(fn).sort().join(',')` 同上
7. `Reflect.ownKeys(fn).sort().join(',')` 同上
8. `Object.create(new Proxy(fn, {})).toString()` 必须抛 TypeError

### Day 3.3：Proxy 重写 Date/Intl（hook fail 6 → 3）

`@d:/projects/Mosaiq/packages/sdk/src/injection/runner.ts:212-274` 把：
- `Intl.DateTimeFormat` 用 `new Proxy(orig, { construct, apply })` 重写
- `Date.prototype.getTimezoneOffset` 用 `new Proxy(orig, { apply })` 重写

效果：`diagnose-creepjs.ts` 从 6 fail → 3 fail（剩 toString name 缺失，V8 实现细节）。

**CreepJS Timezone hash 从 `cb825cf6` → `3dc15bfb` 变动** — 证明 hook trigger 数量减少。

### Day 3.5：🎯 Intl bold-fail 真正根因 = SpeechSynthesis voices

`creep.js` bundle line 7340 的唯一 `LowerEntropy.TIME_ZONE = true` setter：

```js
const { locale: localeLang } = Intl.DateTimeFormat().resolvedOptions();
if (defaultVoiceLang.split('-')[0] !== localeLang.split('-')[0]) {
    LowerEntropy.TIME_ZONE = true; // → Intl `bold-fail`
}
```

**chromium 内的 `speechSynthesis.getVoices()` 异步加载真实 OS TTS voices**：
- 中文 Windows 系统 → `Microsoft Huihui Desktop - Chinese (Simplified) [zh-CN]` 一组 voices
- persona locale = `en-US`
- `'zh' !== 'en'` → bold-fail trigger

**修复**：`@d:/projects/Mosaiq/packages/sdk/src/injection/runner.ts:287-336` 加 SpeechSynthesis spoof block：
- 根据 `config.languages[0]` 派生 voice 模板（en/zh/ja/ko/fr/de 6 种）
- 用 `Object.create(SpeechSynthesisVoice.prototype)` + `Object.defineProperties` 构造伪 voice 实例（保持 instanceof 兼容）
- Proxy 包装 `SpeechSynthesis.prototype.getVoices`，apply trap 返回 spoof voices

**实测**：CreepJS speech section 现显示：

```text
local (3): Microsoft David Desktop - English (United States)
           Microsoft Zira Desktop - English (United States)
           Google US English
lang (1): en-US
default: Microsoft David Desktop - English (United States) [en-US]
```

✅ 完全替代真实系统 voices。`LowerEntropy.TIME_ZONE = false` → Intl `bold-fail` 消失。

### Day 3.5 衍生 attribution 修复价值

这不仅仅是过 CreepJS — 是**真实 attribution 修复**。之前任何爬虫/反爬服务都能通过 `speechSynthesis.getVoices()` 看到我们运行在中文系统上：

```js
const isChineseSystem = speechSynthesis.getVoices().some((v) => v.lang.startsWith('zh'));
```

这是单点高熵指纹（多数 anti-bot SDK 都查）。Day 3.5 改造让 chromium 在反指纹层面**看起来真的是 win11 en-US 系统**。

### 待做（剩余 6 lies 都是 hook trace）

- [ ] **Day 3.6** _(deferred)_：消除 6 个 lies hash 需要全局 `Function.prototype.toString` hook（puppeteer-extra-plugin-stealth 套路）— 深井，需要谨慎设计避免触发新的 lies 检测。不在 v0.1 范围。
- [ ] **Phase 1.5 Worker fingerprint**：CreepJS 用 `!LowerEntropy.TIME_ZONE ? fp.workerScope.language : undefined` 决定是否信任 worker scope 的 language。我们的 Day 3.5 修复让 LowerEntropy.TIME_ZONE = false → worker fingerprint 现在更暴露 worker 内真实值。需要 worker init script。

---

## 0.6. Day 3 攻击计划（原版，已被 §0.7 战果取代）

### TL;DR

`@d:/projects/Mosaiq/packages/sdk/bench/results/2026-05-14T11-52-53-493Z/report.md` baseline 锁定 CreepJS 检测出 **6 lies + 1 bold-fail**：

| Surface | 严重性 | 触发条件（部分已查证） |
|---|---|---|
| **Intl** | 🔴 bold-fail | `LowerEntropy.TIME_ZONE = true`（setter 位置未明） |
| Timezone | 🟠 lies | `lieProps['Date.getTimezoneOffset']` 或 `Intl.DateTimeFormat.resolvedOptions` |
| WebGL | 🟠 lies | `lieProps['WebGLRenderingContext.prototype.getParameter']`（Proxy 改造未消） |
| Screen | 🟠 lies | `LowerEntropy.SCREEN = true` 或 lieProps['screen.*'] |
| Canvas 2d | 🟠 lies | `LowerEntropy.CANVAS`（白名单不匹配）或 lieProps['toDataURL']  |
| DOMRect | 🟠 lies | `lieProps['DOMRectReadOnly.*']` |
| Navigator | 🟠 lies | `lieProps['navigator.*']` (UA, hardwareConcurrency 等) |

### Day 3 系统性研究方法

CreepJS 用两套并行检测：

1. **`lieProps[...]`** — 检测 prototype 被 hook 的痕迹（`Object.getOwnPropertyDescriptor` deep introspection、`Function.prototype.toString` 全套对比、`Reflect.getPrototypeOf` chain 等）。来源：`src/lies/index.ts`（未拉）
2. **`LowerEntropy.{CANVAS,SCREEN,TIME_ZONE,WEBGL,AUDIO,FONTS}`** — 检测值落在已知低熵区（白名单缺失或与 OS/UA cross-check 失败）。setter 散布在多个 module

### Day 3.1：拉完剩余 CreepJS source（前置）

未拉的关键 module（按 priority）：

```bash
# 一次性脚本 — D:/projects/Mosaiq/scratch/pull-creepjs.ps1（不提交）
$base = "https://raw.githubusercontent.com/abrahamjuliot/creepjs/master/src"
$files = @(
  "lies/index.ts",        # ★ 最关键 — lieProps setter 全集
  "fingerprint/index.ts", # 主 orchestrator
  "index.ts",             # entry point，可能含 cross-module analysis
  "html/index.ts",
  "headless/index.ts",    # headless 检测（我们 headed 模式应通过）
  "worker-scope/index.ts" # Worker fingerprint（v0.2 surface）
)
foreach ($f in $files) {
  Invoke-WebRequest "$base/$f" -OutFile "scratch/creep-$($f -replace '/', '-')"
}
```

已下载（在 `$env:TEMP\creep-*.ts`，需移到 `scratch/` 保存）：
- `timezone/index.ts` (13949) `intl/index.ts` (3737) `screen/index.ts` (7784) `canvas/index.ts` (22274) `navigator/index.ts` (19465) `utils/helpers.ts` (20536)

### Day 3.2：写 `bench/diagnose-creepjs.ts`

参照 `bench/diagnose-webgl.ts` 模板，在 chromium 内 evaluate CreepJS lies path：

```ts
// 直接复现 lies/index.ts 关键检测：
const probes = {
  // 1. Function.prototype.toString 链验证（最常见的 hook 检测）
  getParameterToStringForced: Function.prototype.toString.call(
    WebGLRenderingContext.prototype.getParameter,
  ),
  
  // 2. descriptor introspection
  getParameterDescriptor: Object.getOwnPropertyDescriptor(
    WebGLRenderingContext.prototype, 'getParameter',
  ),
  
  // 3. Reflect.getPrototypeOf chain
  protoChain: (() => {
    const fn = WebGLRenderingContext.prototype.getParameter;
    return [
      Reflect.getPrototypeOf(fn)?.constructor?.name,
      // ...
    ];
  })(),

  // 4. Timezone cross-check (Date vs Intl.DateTimeFormat)
  dateTimezoneOffset: new Date().getTimezoneOffset(),
  intlTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dateToStringTz: String(new Date()).match(/\(([^)]+)\)/)?.[1],
  // ...
};
```

输出 → 与 persona 期望值对比 → 找出每个 surface 暴露真实值的 path。

### Day 3.3：按攻击优先级修

| # | Surface | 优先级 | 预期修复方案 |
|---|---|---|---|
| 1 | **Timezone** | P0 | 修 `Date.prototype.getTimezoneOffset` + `Date.prototype.toString`（runner.ts §3 已 spoof `Intl.DateTimeFormat` 但未 spoof `Date` 这边）→ 同步消 Intl bold-fail |
| 2 | **Navigator** | P0 | navigator.ts 已下载，找 lieProps 集合 — 大概率涉及 `navigator.userAgentData` / `userAgent` 序列化一致性、`hardwareConcurrency` cross-check 等 |
| 3 | **Screen** | P1 | screen.ts line 58 已有 `LowerEntropy.SCREEN = true` setter — 看条件 |
| 4 | **Canvas 2d** | P1 | canvas.ts line 489-493 — 白名单 `KnownImageData.BLINK` 不匹配，要么 noise 太异常要么完全没生效；先 diagnose 验证 noise 实际生效 |
| 5 | **WebGL** | P2 | Proxy 透明已做，但 CreepJS 仍标 lies — 看 lies/index.ts 找具体 path |
| 6 | **DOMRect** | P3 | 我们暂未 spoof DOMRect — 可能不在 v0.1 范围 |

### Day 3.4：每修一个 surface 重跑 CreepJS baseline

```bash
# 跑前 lies 数据
$env:ONLY="creepjs"; pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts
pnpm --filter @mosaiq/sdk exec tsx bench/report.ts
# 看 hits 数字 + Lies/bold-fail surfaces 列表

# 修改 runner.ts
# 跑后对比
```

预期：每修 1 个 surface，CreepJS hits −1。Day 3 完成时 hits 应从 7 → ≤ 2（DOMRect 可能保留，作为 v0.2 工作）。

---

## TL;DR (Original, 已被 §0 修订)

跑了两轮 baseline（headless + headed），证实 **现有 SDK 注入栈在 headed 模式下已能过 90%+ 反指纹检测**，Phase 1 真正待补只有 **2 个 surface**：

1. **WebGL**（先做） — unmasked GPU 直接暴露真实硬件 (`Intel HD Graphics 520 / Direct3D11`)
2. **Canvas**（紧随） — hash uniqueness 99.97% (67/298939 用户)

预计 Phase 1 闭环 **5-7 天**（每 surface 1-3 天 + 集成 + 重测验证）。

---

## 1. Baseline 对比数据

### 1.1 两轮跑对比

| 维度 | Headless 跑 | HEADED 跑 |
|---|---|---|
| 用时 | 65.7s | 61.3s |
| 站点 OK | 6/6 | 6/6 |
| 失败 hits | **11** | **2** |
| sannysoft 失败 | 4 (HEADCHR_*) | **0** ✅ |
| browserleaks-canvas 失败 | 1 (high) | 1 (high) |
| browserleaks-webgl 失败 | 2 (高/SwiftShader) | 1 (high/真实 GPU) |
| iphey 解析 | 0/0（未识别检测项） | 0/0（同） |
| CreepJS 状态 | sections 抓到 21 个，trust score N/A | 同 |

### 1.2 关键洞察：Headless 是包袱

Headless 模式下 9 个失败项中有 **8 个是 headless artifact**：

- `HEADCHR_CHROME_OBJ` / `HEADCHR_PERMISSIONS` / `HEADCHR_PLUGINS` / `HEADCHR_IFRAME` (sannysoft 4 个)
- `Plugins Length (Old) = 0` / `Plugins is of type PluginArray = failed` (sannysoft 2 个)
- `Permissions (New) = prompt` (sannysoft 1 个)
- `WebGL Renderer = SwiftShader` (sannysoft + browserleaks，1 个 effective hit)

**这些在 headed 模式下全部自动通过**。

**产品启示**：
- Mosaiq desktop app 默认必须 **headed 启动**（`launchPersona` 默认已是 `headless: false` ✅）
- 如果未来出 cloud agent 服务，需要用 **xvfb / fake display**（不是真 headless），或在 cloud chromium 上做 headless-mark 反检测专项

### 1.3 真正的问题（headed 模式 2 hits）

#### 🔴 WebGL Unmasked GPU
```
Vendor: WebKit                     ← Chrome 默认 mask（OK）
Renderer: WebKit WebGL              ← 同上（OK）
Unmasked Vendor: ! Google Inc. (Intel)
Unmasked Renderer: ! ANGLE (Intel, Intel(R) HD Graphics 520 (0x00001916) Direct3D11 vs_5_0 ps_5_0, D3D11)
```

**问题**：persona 声明的硬件可能是 win11 高端机（如 RTX 3060），但 unmasked GPU 暴露真实是 i7-6500U 集显 + Direct3D11 → **硬件不一致 = 致命指纹**。

**额外证据**：CreepJS 的 `Worker` section 显示 `gpu: Google Inc. (Google) ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device...` — Worker 内 GPU 信息也泄露（headless 时是 SwiftShader，headed 时是真实 GPU），即 Worker fingerprint 同 surface。

#### 🔴 Canvas 99.97% Unique
```
canvas signature: hash=1c6abd493317125a, unique=99.97% (67 of 298939 user agents have the same signature)
```

**问题**：每次跑 hash 几乎不变（同硬件 + 同 chrome → 同 pixel rendering），298939 用户里只有 67 人有这个签名 → **追踪用户的最强单点 entropy**。

---

## 2. Phase 1 执行计划

### 2.1 第一个 surface：WebGL（优先级 1）

**为什么先做 WebGL**：
- 直接暴露真实硬件，attribution 风险最高（如：persona 声称 win11 + RTX 3060，unmasked 暴露 Intel HD 520 → mismatch）
- 实现更干净：是**点状拦截**（几个特定 `gl.getParameter` 常量）
- 验证速度快：browserleaks-webgl 测项明确，做完后通过率立即从 fail → pass

**实施 (1-2 天)**：

#### Day 1 — Spec + 实现

**新文件**：`packages/sdk/src/injection/webgl-spoof.ts`

```ts
// 拦截：
//   gl.getParameter(gl.VENDOR)                      → persona.fingerprint.webgl.vendor
//   gl.getParameter(gl.RENDERER)                    → persona.fingerprint.webgl.renderer
//   gl.getParameter(0x9245 /* UNMASKED_VENDOR_WEBGL */)   → persona.fingerprint.webgl.unmaskedVendor
//   gl.getParameter(0x9246 /* UNMASKED_RENDERER_WEBGL */) → persona.fingerprint.webgl.unmaskedRenderer
//   gl.getSupportedExtensions()                     → 去掉 WEBGL_debug_renderer_info（可选）
//
// 同时拦截 WebGL2 (WebGL2RenderingContext.prototype) 与 OffscreenCanvas 的 getContext。
//
// 不拦截的（保持真实）：
//   - MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS 等纯能力字段（拦截会让 WebGL 应用崩溃）
//   - 着色器编译结果（同上）
```

**修改 `runner.ts`**：把 `webgl-spoof` 的 spoof 函数 inline 进 init script（runner 必须自包含，不能 import）。

**修改 `build-config.ts`**：把 `persona.fingerprint.webgl.{vendor, renderer, unmaskedVendor, unmaskedRenderer}` 提取到 `InjectionConfig`。

**检查 `persona-schema/src/fingerprint.ts`**：确认这些字段存在；如缺失则补 zod schema + templates 默认值。

#### Day 2 — 单测 + 集成 + 验证

**新文件**：`packages/sdk/src/injection/webgl-spoof.test.ts`（vitest，目标 ≥ 12 测试）：

- WebGL1 / WebGL2 context spoof 各覆盖
- VENDOR / RENDERER / UNMASKED_VENDOR / UNMASKED_RENDERER 4 项
- OffscreenCanvas.getContext('webgl') 同样生效
- prototype 检查：`getOwnPropertyDescriptor(WebGLRenderingContext.prototype, 'getParameter')` 看不出 spoof
- toString 返回 `[native code]`
- 不拦截 MAX_TEXTURE_SIZE 等真实 capability 参数
- worker 内（happy-dom 不支持 WebGL，跳过 worker 测试，docs 标记 v0.2 补）

**集成 desktop**：不需要改 desktop 代码（spoof 在 SDK 层透明生效）。

**验证**：重跑 `pnpm --filter @mosaiq/sdk run bench:all`，期望：
- browserleaks-webgl 的 unmasked vendor/renderer 显示 persona 声称的值
- CreepJS Worker section 不再泄露真实 GPU
- hits 从 2 → 1（只剩 canvas）

### 2.2 第二个 surface：Canvas（优先级 2）

**实施 (2-3 天)**：

#### Day 3-4 — Spec + 实现

**新文件**：`packages/sdk/src/injection/canvas-noise.ts`

```ts
// 拦截：
//   HTMLCanvasElement.prototype.toDataURL
//   HTMLCanvasElement.prototype.toBlob
//   CanvasRenderingContext2D.prototype.getImageData
//   OffscreenCanvas.prototype.convertToBlob
//
// 噪声策略（基于 persona seed 确定性）：
//   - 用 persona.fingerprint.canvas.seed 派生 mulberry32 PRNG
//   - 每个 pixel RGB 各加 [-1, 0, 1] 中一个值（极小扰动，肉眼不可见）
//   - 同一 persona × 同一 input canvas → 同样的 hash（避免回放检测）
//   - 不同 persona × 同一 canvas → 不同 hash（避免关联）
//
// 关键参数：
//   - noiseStrength: 0-3（per-channel max delta）；默认 1
//   - applyToReadOnly: 是否对 getImageData 也应用（默认 true）
//   - skipSmallCanvas: < 8×8 px 的 canvas 不加噪（避免破坏小 icon）
```

**与 chromium-fork 草稿对齐**：参考 `chromium-fork/patches/0001-canvas-noise.spec.md`，把 native patch 设计简化为 SDK 注入版（去掉 BUILD.gn / mojom 部分）。

**persona-schema 字段**：检查 `persona.fingerprint.canvas` 是否已有 seed/strength；如缺失则补。

#### Day 5 — 单测 + 验证

`packages/sdk/src/injection/canvas-noise.test.ts`（≥ 15 测试）：

- toDataURL 噪声生效（hash 与原始不同）
- 同 persona seed 同输入 → 相同 hash（确定性）
- 不同 persona seed → 不同 hash
- `skipSmallCanvas` 8×8 小图保留原始
- getImageData 加噪（可关）
- 噪声强度可控（0/1/2/3 各覆盖）
- 不破坏 alpha=255 像素的可视效果（abs delta ≤ 1）
- prototype 检查：getOwnPropertyDescriptor 看不出 spoof
- OffscreenCanvas 同样生效
- 噪声后图像不会被 Math 检测出统计异常（KS 测试）

**验证**：重跑 baseline，期望 hits = 0，CreepJS canvas hash 每次跑都不同（随机 ephemeral persona seed）。

### 2.3 时间表

| 天 | 工作 | 产出 |
|---|---|---|
| Day 1 | WebGL spoof spec + 实现 + persona-schema 补字段 | webgl-spoof.ts, persona-schema 更新 |
| Day 2 | WebGL spoof 单测 + 重跑 bench 验证 | 12+ 测试，bench hits 2→1 |
| Day 3-4 | Canvas noise spec + 实现 | canvas-noise.ts, persona-schema 补字段 |
| Day 5 | Canvas noise 单测 + 重跑 bench 验证 | 15+ 测试，bench hits → 0 |
| Day 6 | 集成 desktop（如 persona-schema 字段变了，UI 加表单） | desktop 编辑页 |
| Day 7 | CI 集成 baseline 检测，写 v0.1 release notes | GHA workflow，CHANGELOG |

---

## 3. 已知问题（不阻塞 Phase 1）

### 3.1 CreepJS Trust Score selector 失效

`bench/sites.ts` 的 `extractCreepjs` 找 `.trust-score` 选不到。CreepJS 可能改了 className。

**影响**：报告 Trust Score 永远 N/A。但 sections 抓得到 21 个，足够判断每个 surface 状态。

**修复优先级**：低（Phase 1 完成后再做）。修法：
- 看 `bench/results/<latest>/creepjs.html` 找当前真实 selector
- 更新 `extractCreepjs` 用新 selector

### 3.2 iphey.com 解析 0/0

iphey 主页是 marketing landing page，需要等 detection 完成或导航到 `/tools/your-fingerprint`。

**修复**：
- 改 `sites.ts` URL 为 `https://iphey.com/your-fingerprint` 或类似
- 或加导航逻辑到 detection page

**优先级**：低（其他 5 站已够覆盖判断）。

### 3.3 Worker 内 fingerprint 注入

CreepJS 的 `Worker` section 显示 GPU + UA 在 Worker 内泄露真实值。runner.ts 的 init script 默认只注入到 main frame。

**修复**：
- v0.2 工作：在 launcher.ts 加 Worker init script 拦截
- 或考虑 chrome flag 控制 Worker fingerprint（不一定有）
- 或文档说明 "Worker fingerprint 暂未 spoof，敏感场景关 Worker"

**优先级**：中（高级反爬可能在 Worker 内查 UA）。Phase 1.5。

---

## 4. 不在 Phase 1 范围

按 plan §10：
- ❌ Audio fingerprint 注入（Phase 1.5）
- ❌ Font enumeration 注入（Phase 1.5）
- ❌ WebRTC IP 处理（已在 launcher.ts 用 chrome flag 处理，无需改）
- ❌ AI agent SDK / Stagehand 类（Phase 1.5）
- ❌ Live view / Session recording（Phase 2）
- ❌ fork chromium（Phase 3，PMF 后）

---

## 5. 决策依据（数据驱动）

| 决策 | 数据依据 |
|---|---|
| 先做 WebGL 而非 Canvas | WebGL unmasked **直接暴露真实硬件**，硬件 attribution 风险 > Canvas hash uniqueness |
| Phase 1 只做 2 个 surface | HEADED 实测仅 2 hits；其他都是 headless artifact，desktop app 不会触发 |
| 不再做 plugins / permissions / HEADCHR | sannysoft 已 0 失败（headed 模式），现状已过 |
| WebRTC 不进 Phase 1 | launcher.ts:71-74 已加 `--force-webrtc-ip-handling-policy` flag，proxy_only 模式生效 |
| Audio / Font 推迟到 Phase 1.5 | baseline 没检测出当前问题；等 Phase 2 客户实测再决定 |

---

## 5.5 Day 4 — Phase 1.5 Worker scope spoof（2026-05-15 完成）

### TL;DR

之前 baseline 有 2 项 hit：`Canvas（故意 pixel noise）`+`Navigator（worker-scope 不一致）`。今天补齐 worker-scope 后剩 1 lies + 1 bold-fail，且都是 Canvas 噪声策略的**下游成本**（CreepJS `LowerEntropy.CANVAS=true` 自动给 WebGL section 同时打 bold-fail）。**Navigator worker-scope 彻底清零**。

### 调研：CreepJS 怎么读 worker

读 `creep.js` bundle 发现 worker section 走三级 fallback：

```js
// line 2007: 先试 ServiceWorker（最快也最隐蔽）
let workerScope = await getServiceWorker({ scriptSource: './creep.js' }).catch(...);

// line 2015: SW 失败 → SharedWorker
if (!workerScope?.userAgent) workerScope = await getSharedWorker({...});

// line 2024: 还是失败 → DedicatedWorker
if (!workerScope?.userAgent) workerScope = await getDedicatedWorker({...});
```

每个 worker 在 worker realm 里读 `navigator.userAgent / hardwareConcurrency / deviceMemory / language / languages / platform / userAgentData / webglRenderer / webglVendor` post 回 main scope，CreepJS 拿这些跟 main scope 比对，不一致 → `does not match worker scope` lies。

### 修法：三 hook 联合

`@d:\projects\Mosaiq\packages\sdk\src\injection\runner.ts` §11 新增：

1. **`Worker` 构造器 hook**：`new Worker(src, opts)` → 把 src 包成 Blob URL，blob 内容是 `[spoof IIFE] + importScripts(absoluteSrc)`（classic）或 `+ import(absoluteSrc)`（module）。spoof IIFE 用 `Object.defineProperty(navigator, key, {get})` 覆盖 9 个 navigator 字段 + WebGL `getParameter(0x9245/0x9246)` UNMASKED vendor/renderer。
2. **`SharedWorker` 构造器 hook**：同上策略。
3. **`navigator.serviceWorker.register(url)` hook**：fetch 同源脚本 → 拼装 → 用 blob: 注册。**Chrome M96+ 拒绝 blob: 协议作为 SW 脚本**（实测 `TypeError: The URL protocol of the script ('blob:...') is not supported`），所以这条路必然在 v0.1 失败。
   - 关键设计：**失败时 reject**（不 fallback 到原始 register），让 CreepJS 跌到 SharedWorker 路径（被 hook 1+2 拦下）。
   - 代价：真实 PWA 注册 SW 也会失败（offline / push 降级）。
   - v0.2 计划：加 `persona.swPolicy: 'spoof' | 'passthrough' | 'block'` 选项可配置。

### 验证

```text
bench/probe-worker-scope.ts:
  field                  main                                               worker
  userAgent            "Chrome/147..."                                     "Chrome/147..."        ✓
  appVersion           "5.0 (Win NT 10.0..."                               "5.0 (Win NT 10.0..."  ✓
  platform             "Win32"                                              "Win32"                ✓
  vendor               "Google Inc."                                        "Google Inc."          ✓
  language             "en-US"                                              "en-US"                ✓
  languages            ["en-US","en"]                                       ["en-US","en"]         ✓
  hardwareConcurrency  8                                                    8                      ✓
  deviceMemory         8                                                    8                      ✓
  maxTouchPoints       0                                                    0                      ✓
  ✅ ALL MATCH — worker scope spoof works
```

CreepJS Worker section 显示 `gpu: Google Inc. (Intel) / ANGLE (Intel UHD 730 D3D11)` + `cores: 8, ram: 8` + `userAgent: Chrome/147`（无 HeadlessChrome）。`hasBadWebGL: false`。

### 战果对比

| 指标 | Day 3.5 末 | Day 4 末 |
|---|---|---|
| Lies surfaces | 2（Canvas + Navigator） | 1（Canvas，故意） |
| Bold-fail | 1（WebGL，源自 Canvas） | 1（WebGL，源自 Canvas） |
| report.ts hits | 3 | 2 |
| 已消除 | Timezone/WebGL/Screen/Fonts/DOMRect/SVGRect/Audio/Math | ＋ Navigator worker-scope |
| 剩余 | Canvas（故意）、Navigator（worker） | **Canvas（故意）+ 下游 WebGL bold-fail** |

### 残余分析：为什么 WebGL 还在 bold-fail

`creep.js:8812`：
```js
<span class="${lied ? 'lies ' : (LowerEntropy.CANVAS || LowerEntropy.WEBGL) ? 'bold-fail ' : ''}hash">
```

WebGL bold-fail = `LowerEntropy.CANVAS || LowerEntropy.WEBGL`。我们的 Canvas pixel-noise 让 `imageDataLowEntropy` 不在 `KnownImageData.BLINK` 白名单 → `LowerEntropy.CANVAS = true` → WebGL section 跟着染色。**这不是 WebGL spoof 失效，是 Canvas 噪声策略的 CreepJS 下游成本**。

要清掉：要么放弃 Canvas 噪声（pixel hash 可被跨站追踪，product 不接受），要么让噪声 deterministic 到匹配 BLINK 白名单（深度 reverse engineering，ROI 低）。

**结论**：当前 1 lies + 1 bold-fail 都标记在 Canvas/WebGL，是策略性接受的成本，不再细抠。

### 回归保护

- `@d:\projects\Mosaiq\packages\sdk\src\injection\runner.test.ts:166-189`：2 条新测试守住 `Worker.prototype.constructor.name === 'Worker'` 和 `navigator.serviceWorker.register` instance-own 覆盖。
- `@d:\projects\Mosaiq\packages\sdk\bench\probe-worker-scope.ts`：可重跑的 9 字段 main↔worker parity 验证脚本。
- 总测试：151 → **153 通过**（+2）。

### v0.2 待补

- [ ] `persona.swPolicy: 'spoof' | 'passthrough' | 'block'` —— 让 PWA 用户选择是放弃 spoof 还是放弃 SW。
- [ ] ServiceWorker realm 自身的 fetch interception（用 CDP `Network.requestIntercepted` + `Fetch.fulfillRequest` 在网络层改写 SW 脚本）。这是 Chrome blob 拒绝后唯一能让 SW 自己也 spoof 的路径，复杂度高。

---

## 5.6 Day 4.5 — UA-CH (`navigator.userAgentData`) 全覆盖（2026-05-15 完成）

### 起因

§5.5 worker scope 修完后再跑 probe，发现 `navigator.userAgentData` 在 **main + worker 两 scope 都泄露 `HeadlessChrome 147`**：

```text
brands: HeadlessChrome/147, Not.A/Brand/8, Chromium/147
highEntropy.fullVersionList: HeadlessChrome v147.0.7727.15
platformVersion: "10.0" (而不是 Win11 reduction 后的 "15.0.0")
```

CreepJS Worker section 把它直接渲染成 `HeadlessChrome 147 (147.0.7727.15)`，虽然没被判 lies（main/worker 一致），但是这是真实 surface 泄露：

- 任何检测脚本 `navigator.userAgentData.brands.some(b => b.brand === "HeadlessChrome")` 一查一个准。
- 也表明 persona 声称的 Win11 跟 Chrome 自报的 `platformVersion: "10.0"` 不一致（应是 "15.0.0"）。

### 调研：为什么旧 spoof 只动了 `platform`

`@d:\projects\Mosaiq\packages\sdk\src\injection\runner.ts` 旧代码：

```ts
if (uad) defineReadOnlyGetter(uad, 'platform', () => ...);
```

只覆盖了 `platform`。而且 `defineReadOnlyGetter` 是 `Object.defineProperty(instance, ...)`，里面 try-catch 静默。

加诊断 probe 测出 root cause：**`NavigatorUAData` 实例是 WebIDL interface，own slot 加不上去**——`Object.defineProperty(uad, 'brands', ...)` 直接静默失败。proto 上的 brands getter 倒是 `configurable: true`，可以原地替换。旧 `platform` override 看起来"成功"只是因为 Chrome 在 Windows 上本来就报 `platform: "Windows"`，巧合一致。

### 修法：proto-level 完整覆盖

`@d:\projects\Mosaiq\packages\sdk\src\injection\runner.ts:317-430` 重写 main scope UA-CH 块，所有改动落在 `Object.getPrototypeOf(navigator.userAgentData)`（= `NavigatorUAData.prototype`）上：

1. `brands` getter → 返回 persona 派生的 GREASE 三元组 `[真品牌, Not.A/Brand v8, Chromium]`
2. `mobile` getter → `false`
3. `platform` getter → `"Windows" | "macOS" | "Linux"`
4. `getHighEntropyValues(hints)` 方法 → 按 hints 返回 `{architecture, bitness, model, platformVersion, wow64, fullVersionList, formFactors}` 子集，永远附带 brands/mobile/platform low-entropy baseline
5. `toJSON()` 方法 → CreepJS 等用 `JSON.stringify(uad)` 时拿到同一组 spoofed 值

worker IIFE (`workerSpoofSrc`) 同步加上等价 proto-level 覆盖（line 1014-1043，ES5 string-concat style）。

### 派生函数 `deriveUaCh(persona)`

`@d:\projects\Mosaiq\packages\sdk\src\injection\build-config.ts:28-103`，按 Chromium 现行 GREASE + UA-CH reduction 政策派生：

| persona OS | platform | platformVersion |
|---|---|---|
| Win11 (build ≥ 22000) | `"Windows"` | `"15.0.0"` |
| Win10 (build < 22000) | `"Windows"` | `"10.0.0"` |
| macOS | `"macOS"` | `"<major>.0.0"`（e.g. `"14.0.0"` for Sonoma）|
| Linux | `"Linux"` | `""`（Chrome 105+ Linux 上 UA-CH 减熵为空串）|

architecture 按 `system.os.arch` 翻译（`x86_64 → "x86"`、`arm64 → "arm"`）。bitness 桌面默认 `"64"`。

如果 persona 显式提供 `browser.uaClientHints`，则用户原值优先（用户意图保留）。

### 验证

```text
bench/probe-uach.ts (post-fix):
=== MAIN scope ===
brands:        Google Chrome/147, Not.A/Brand/8, Chromium/147
platform:      Windows
mobile:        false
highEntropy.platformVersion:  15.0.0     ✓  Win11 reduction
highEntropy.fullVersionList:  Google Chrome 147.0.7727.15
highEntropy.architecture:     x86
highEntropy.bitness:          64

=== WORKER scope === (DedicatedWorker)
brands:        Google Chrome/147, Not.A/Brand/8, Chromium/147   ✓ 一致
highEntropy.platformVersion:  15.0.0                            ✓ 一致
... (其余字段全部 main↔worker 完全一致)
```

CreepJS Worker section 渲染从：

```
userAgentData:  HeadlessChrome 147 (147.0.7727.15) | Windows 10 (...) [10.0.0] x86_64
```

变成：

```
userAgentData:  Google Chrome 147 | Windows 11 [15.0.0] x86_64
```

### 战果

| 指标 | Day 4 末 (§5.5) | Day 4.5 末 (§5.6) |
|---|---|---|
| `navigator.userAgentData.brands` (main) | `HeadlessChrome/147` ❌ | `Google Chrome/147` ✓ |
| `navigator.userAgentData.brands` (worker) | `HeadlessChrome/147` ❌ | `Google Chrome/147` ✓ |
| `highEntropy.platformVersion` (main) | `10.0` ❌（错版本号 + Win10 而非 Win11） | `15.0.0` ✓（Win11 reduction）|
| `highEntropy.platformVersion` (worker) | `10.0` ❌ | `15.0.0` ✓ |
| CreepJS Lies / Bold-fail | 1 / 1（Canvas 下游）| 1 / 1（Canvas 下游，**不动**——CreepJS 不就 UA-CH 判 lies）|

Lies 计数不变属于符合预期：CreepJS 只比较 main↔worker 是否一致而不验证 brand 是否包含 HeadlessChrome；但 surface 真实泄露彻底消除，**advanced 检测脚本（fingerprint.com / 自研 anti-bot）抓 `HeadlessChrome` brand 的攻击线全部失效**。

### 回归保护

- `@d:\projects\Mosaiq\packages\sdk\src\injection\build-config.test.ts:206-309`：+8 条 UA-CH 派生测试，覆盖 Win11/Win10/macOS/Linux 四个 OS 路径、x86/arm 两个 arch、brand 三元组形状、`persona.browser.uaClientHints` 显式覆盖优先级。
- `@d:\projects\Mosaiq\packages\sdk\bench\probe-uach.ts`：可重跑的 main↔worker UA-CH parity 验证脚本。
- 总测试：153 → **161 通过**（+8）。

### v0.3 待补

- [ ] **GREASE 顺序随机化**：当前 brand list 顺序固定 `[真品牌, Not.A/Brand, Chromium]`；Chromium 真实顺序是 GREASE 算法 per-launch seeded 随机的。对 fingerprinter 看的是集合不是顺序，影响很小，但是高保真目标下值得做（用 persona masterSeed 派生稳定顺序）。
- [ ] **CDP `Network.setExtraHTTPHeaders`** 同步把 `Sec-CH-UA*` 请求头改写——目前 Playwright `extraHTTPHeaders` 已经把 `Accept-Language` 改了，UA-CH 头按 `userAgent` option 自动派生但仍可能含 HeadlessChrome marker。需实测确认。

---

## 5.7 Day 4.6 — Canvas determinism + uniqueness 产品 gate（2026-05-15 完成）

### 起因

我们对外承诺：
- **(D) Determinism** —— 同 persona（同 `masterSeed`）跨多次 launch 的 Canvas hash 必须**完全相同**。否则用户跨会话再登同站会被判为不同设备，多账号场景失败。
- **(U) Uniqueness** —— 不同 persona 的 Canvas hash 必须**互不相同**。否则两 persona 在同站会被关联，账号隔离被破。

但这两条核心承诺**从未被实测过**。`runner.test.ts` 里有 unit 测试覆盖 `seedToUint32` / 噪声参数 propagate 路径，但是端到端的"同 seed → 同 hash"链路一直没跑过——存在静默 bug 风险。

### 实施

`@d:\projects\Mosaiq\packages\sdk\bench\canvas-cross-check.ts`：4 个 OS 模板 × 2 次 launch（Win11/Win10/macOS/Linux 各 2 次，共 8 个 session），每个 session：

1. headless launch 该 persona（masterSeed 固定）
2. 在 `about:blank` 上画固定 canvas 内容（`fillRect` + `fillText` 两次叠加 + `arc` 圆 + 几何字符）
3. `toDataURL()` → Node 端 SHA-256 截 16 hex 当 hash
4. session close + persona/dir 清理

**Why Node-side SHA-256**：`about:blank` 不是 secure context，浏览器 `crypto.subtle` 不可用。改在 Node 端 `node:crypto.createHash` 算。

### 跑一次结果

```text
[win11-A#0]  hash=9d60fc13f3a2f21d  dataUrlLen=10790  805ms
[win11-A#1]  hash=9d60fc13f3a2f21d  ...                799ms   ← 同 seed = 同 hash
[win10-B#0]  hash=6e8dfdc578e52e50
[win10-B#1]  hash=6e8dfdc578e52e50  ← 同
[macos-C#0]  hash=24314180beeea737
[macos-C#1]  hash=24314180beeea737  ← 同
[ubuntu-D#0] hash=4e65cfeea235e9d2
[ubuntu-D#1] hash=4e65cfeea235e9d2  ← 同

  ✓ determinism  win11-A      all 2 runs = 9d60fc13f3a2f21d
  ✓ determinism  win10-B      all 2 runs = 6e8dfdc578e52e50
  ✓ determinism  macos-C      all 2 runs = 24314180beeea737
  ✓ determinism  ubuntu-D     all 2 runs = 4e65cfeea235e9d2
  ✓ uniqueness   4 personas → 4 distinct hashes
```

**两条产品承诺都成立**。

### 跑法

```bash
pnpm --filter @mosaiq/sdk bench:canvas
# 或
pnpm --filter @mosaiq/sdk exec tsx bench/canvas-cross-check.ts
```

退出码：通过 0、任何 determinism 或 uniqueness 失败 → 1，方便 CI 接入。

### v0.2 待补

- [ ] **WebGL cross-check**：同样模式但读 `getParameter(UNMASKED_RENDERER)` + `readPixels` 噪声。注意：UNMASKED 由 persona 静态字段决定，跨同 OS 不同 masterSeed persona 应当 SAME；只有 readPixels noise 的 hash 才区分。
- [ ] **Audio cross-check**：相同思路，AudioContext 渲染 + getChannelData 噪声采样 → hash。
- [ ] 把脚本搬进 vitest 作为 integration test —— 当前 `vitest run` 是纯 happy-dom 单元测试（~7s），加这个会到 ~13s，需要单独 suite 或 `test:integration` 路径区分。

---

## 5.8 Phase 1 收尾 — 加 3 个新 baseline 站（2026-05-15）

### 动机

v0.1 的 6 个 baseline 站（sannysoft / browserleaks-{js,canvas,webgl} / iphey / creepjs）覆盖了**通用**指纹检测，但没有任何站直接暴露**布尔形式的 spoof 失败信号**。我们需要扩展防御面，找到 v0.1 已实施的 spoof 之外的未知漏洞。

为此引入 3 个新站：

| 站点 | URL | 价值 | settleMs |
|---|---|---|---|
| `dbi-bot` | `deviceandbrowserinfo.com/are_you_a_bot` | **20 个布尔信号**直接对应我们的 spoof 面 | 9_000 |
| `amiunique` | `amiunique.org/fingerprint` | 给每属性的**全球独特性百分比** → 识别 outlier 组合 | 8_000 |
| `pixelscan` | `pixelscan.net/fingerprint-check` | 商业反检测圈最常用 mask 检测站 | 15_000（需 commit + headed） |

### 实施

文件：`packages/sdk/bench/sites.ts`、`packages/sdk/bench/report.ts`、`packages/sdk/bench/baseline-detection.ts`。

新增关键能力：

1. **`SiteSpec.waitUntil`** —— 允许 per-site 覆盖 page.goto 的 waitUntil。pixelscan 需要 `'commit'` 才能跳过 Cloudflare gating 的 `domcontentloaded` 卡死。
2. **截图失败容错** —— 改 `runOne()` 让 `page.screenshot` 超时降级用 viewport 截图，不再让整站 FAIL（pixelscan 在 Cloudflare gating 下字体永远不 ready）。
3. **DBI 布尔信号路由表** —— `report.ts` 的 `DBI_KEY_TO_SURFACE` 把 20 个 detection key 一一映射到我们的 surface 分类 + severity，让 hits 归因表直接对应 v0.1 spoof 面。
4. **AmIUnique outlier 检测** —— 标记 `similarityPct < 0.5%` 的属性，提示 spoof 出了"真人不会有的组合"。
5. **Pixelscan 白名单 + stillLoading 检测** —— 只信任 5 个核心 card 标题，跳过 FAQ 误判；明确识别 SPA 卡在 "Collecting Data..." 状态时输出警告而非伪结果。

### 跑法

```bash
pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts                 # 全部 9 站
ONLY=dbi-bot,amiunique,pixelscan pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts
HEADED=1 ONLY=pixelscan pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts  # pixelscan 推荐 headed
pnpm --filter @mosaiq/sdk exec tsx bench/report.ts <results-dir>
```

### 首跑结果（2026-05-15 headless）

```text
✓ dbi-bot:    18/20 spoof 信号通过；2 个 true
✓ amiunique:  42 attributes，0 outliers
○ pixelscan:  headless + 默认 IP 走不到结果（"Collecting Data..." 警告，不入 hits）
```

### 🔴 新发现：CDP detection 是结构性漏洞（JS init script 无法关）

dbi-bot 触发的 2 个信号都是**同一类**：

- `isAutomatedWithCDP` = true
- `isAutomatedWithCDPInWebWorker` = true

#### Day 1.6 调查（2026-05-15）：先按 dbi-bot 2024 文章实施 JS hook，再实测发现真因

**第一轮假设（错的）**：dbi-bot 的[2024 公开文章](https://deviceandbrowserinfo.com/learning_zone/articles/detecting-headless-chrome-puppeteer-2024)给出探测代码：

```js
var detected = false;
var e = new Error();
Object.defineProperty(e, 'stack', { get() { detected = true; } });
console.log(e);                  // CDP 序列化时调 getter → detected = true
if (detected) isBot = true;
```

文章说的攻击面是"CDP 序列化 Error 时同步读 .stack"，于是我加了 `runner.ts §12 CDP Detection Hardening`：

- 拦截 `Object.defineProperty` / `Reflect.defineProperty` / `Object.defineProperties` 三条路径
- 当目标是 Error 实例 + 属性是 `stack` + descriptor 是 accessor 时**静默吞掉**
- 同样的逻辑镜像到 worker scope（`workerSpoofSrc`）
- 加了 7 条 vitest（happy-dom 里全部通过，168/168）

**第二轮实测（揭露真因）**：重跑 `bench:dbi-bot` 后两条 flag **依然 true**。

读 [Rebrowser 的技术文章](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries) 后真相浮出：

> dbi-bot 实际用的是 `Runtime.consoleAPICalled` **事件触发** 来检测：只要 Playwright /
> Puppeteer 调过 `Runtime.enable`（每个 frame 都调，无法用配置关），V8 inspector 就会
> 在 console.* 时把消息序列化送给 host —— **这一步发生在 V8 内部，JS 完全拦不住。**

因此：

- 我加的 JS hook **不能**让 `isAutomatedWithCDP` 翻 false
- 真正的修法在 **Playwright 源码层面禁掉自动 `Runtime.enable`**，参考 [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) 的两种方案：
  1. 用 `Page.createIsolatedWorld` 创建未知 ID 的 isolated context（不能访问 main world）
  2. 调 `Runtime.enable` 后立刻 `Runtime.disable`，从 `executionContextCreated` 事件捕获 ID（可访问 main world，有微小时间窗口风险）
- 或者在 chromium-fork 层面 patch V8 inspector 的 `Runtime.consoleAPICalled` 触发条件

#### JS hook 是否保留

**保留**。理由：

1. dbi-bot 自己升级到 Runtime.consoleAPICalled 检测了，但很多自部署反爬 / 教学站 / 第三方 stealth-test 仍在用 2024 文章里那段老代码片段
2. 我们的 hook 精确针对该 pattern，零误伤合法库（sentry / pino / mocha / jest / lodash / react 都读 stack 但不会用 defineProperty + getter 模式重定义它）
3. 防御纵深：万一某检测同时跑两条 probe，至少老的能挡住

#### v0.2 真正要做的事

##### 2026-05-15 实测后的修订评估

仔细看了 rebrowser-patches 的 [`patches/playwright-core/lib.patch`](https://github.com/rebrowser/rebrowser-patches/blob/main/patches/playwright-core/lib.patch)（11.6 KB，触及 6 个 playwright-core 文件）后，**之前的"低难度"评估错了**：

- rebrowser-patches CLI **last fully tested**: Playwright **1.52.0**（2025-04 发版）
- `rebrowser-playwright-core`（预打补丁的 fork）npm 最新：**1.52.0**
- 我们当前装的：**1.59.1**（差 7 个 minor 版本，~6 个月）
- patch 期望 `crPage.js:425` 附近紧跟 `Runtime.addBinding` 调用；1.59.1 已经把这个调用挪进 `exposePlaywrightBinding()` 里 —— **patch 直接 apply 会拒（hunk fail）**

| 路径 | 真实难度 | 收益 | 备注 |
|---|---|---|---|
| **降级 Playwright 到 1.52.0 + 切到 `rebrowser-playwright-core`** | 极低 | 高 | 一行 package.json 改动；缺点：丢 7 个 minor 的 bugfix/feature/Chromium 版本 |
| **保持 1.59.1，自己重写 patch** | 高 | 高 | 4–8 小时 focused session：理解 addBinding flow + 适配 1.59.1 重构 + 跨 5 文件改 + 充分测试 |
| **保持 1.59.1，pin rebrowser-playwright-core 当 dev-only optional dep** | 中 | 中 | 用户运行时可选切，CI 测两条；管理复杂度上升 |
| **defer 到 chromium-fork 阶段** | 低（现在）/高（届时） | 高 | patch V8 inspector，是真正的根治；但 fork 流水线短期出不来 |
| **完全不修，留 JS 层 defense-in-depth** | 0 | 局部 | 当前状态；dbi-bot `isAutomatedWithCDP` 持续亮 |

##### 推荐路径（按时间窗口）

1. **本周（v0.1 收尾）**：保持现状。JS 层 hook 留作 defense-in-depth，文档老老实实写明 dbi-bot CDP 信号未关。
2. **下次专项 session（4–8h，v0.2 第一炮）**：自己重写 patch for 1.59.1。步骤：
   1. 用 `pnpm patch playwright-core@1.59.1` 拿到可写副本
   2. 把 rebrowser 的 `lib.patch` 拆成 6 个独立 hunk，分文件 apply
   3. `crPage.js` 那个 hunk 必须重写（addBinding 调用位置已变）
   4. 跑 `bench:dbi-bot` 验证 `isAutomatedWithCDP=false`
   5. 跑全量 vitest + 全 9 站 bench，确认无回归
   6. `pnpm patch-commit` 把 diff 落到 `patches/playwright-core@1.59.1.patch`
   7. 在 `pnpm-workspace.yaml` 或 `package.json` 加 `pnpm.patchedDependencies` 自动 apply
3. **Phase 2（chromium-fork 上线后）**：把 Playwright patch 退役，改在 V8 inspector 层根治。

### Pixelscan 处理建议

- pixelscan 在 headless 模式下基本无法取到结果（Cloudflare 拦阻）；
- v0.1 把它放在 SITES 里，但通过 `stillLoading` 检测**自动降级为不入 hits**；
- 真要测请用 `HEADED=1 ONLY=pixelscan` + 干净 IP，或人工开浏览器跑。

### v0.2 优先级（更新）

按 dbi-bot + amiunique + pixelscan 引入后的视角排序：

1. 🔴 **结构性 CDP defense**（rebrowser-patches 评估 + 集成）— 详见 5.8.3
2. 🟡 **WebGL/Audio cross-check**（v0.1 5.7 已立项）
3. 🟡 **persona.swPolicy** 三态（PWA 用户）
4. 🟢 **GREASE 顺序随机化** + `Network.setExtraHTTPHeaders`（v0.3）

### Phase 1.6 落地清单（已完成，2026-05-15）

- [x] 加 `runner.ts §12` JS-layer CDP hardening（main + worker scope）
- [x] 加 `runner.test.ts` 7 条 vitest，168/168 通过
- [x] 实测 `bench:dbi-bot` 验证 JS hook 效果不到 dbi-bot 真探测（仍 2 个 true）
- [x] 文档老老实实记录："为什么留 + 真正修法是什么"
- [x] 评估 rebrowser-patches 集成可行性：**1.52→1.59 drift 导致 patch 不能直接 apply**；自己重写需要 4–8h focused session
- [x] 在 PHASE-1-NEXT-STEPS §5.8 给出 v0.2 第一炮的具体步骤清单（7 步）

### Phase 1 真正完结状态（2026-05-15）

✅ **可以收尾**。Phase 1 v0.1 范围内的 baseline 工作全部完成。

#### 最终 9 站全量 bench 快照（§12 CDP hook 落地后回归测试）

| 站点 | 状态 | 备注 |
|---|---|---|
| sannysoft | ⚠️ 60s timeout | 个人页面间歇性挂；非 §12 回归 |
| browserleaks-js | ✅ clean | 0 flagged surface |
| browserleaks-canvas | ✅ 噪声 by design | `uniqueness=100%` 是 persona 确定性种子的预期产物 |
| browserleaks-webgl | ✅ spoof 生效 | UHD 730 与 persona 一致 |
| iphey | ✅ clean | 0 flagged surface |
| dbi-bot | ⚠️ 60s timeout / 18-20 pass | 焦点跑确认 18/20 spoof 信号 OK；剩 2 个 CDP 结构性遗留 |
| amiunique | ✅ 0 outliers | 42 attributes 全过 |
| pixelscan | ✅ 干净降级 | 0 hits + 2 ⚪ undetermined（Cloudflare 限制内容） |
| creepjs | ⚠️ 与基线一致 | 1 Lies (Canvas, 噪声 by design) + 1 Bold-fail (WebGL unmasked, 预期) |

**关键判定**：§12 CDP hook 上线**零新回归**——所有 7 个内容加载成功的站给出与 Phase 1.5 baseline 完全一致的 fingerprint pattern。

#### 验证矩阵

- ✅ `tsc --noEmit`: clean
- ✅ `vitest`: 168/168 通过（161 旧 + 7 新 §12 CDP 测试）
- ✅ `bench:dbi-bot,creepjs` 焦点跑：dbi-bot 18/20 + creepjs lies/bold-fail 模式与基线一致
- ✅ 全 9 站 bench：7/9 内容成功 + 2/9 网络超时（非 §12 回归）
- ✅ 所有 trade-off 与下一步路径在文档里说清楚

### Phase 1.7 — v0.2 第一炮：playwright-core 1.59.1 rebrowser patch（已完成，2026-05-15）

按 §5.8.3「2026-05-15 实测后的修订评估」给出的 7 步清单一次性完成：

1. ✅ `pnpm patch playwright-core@1.59.1 --edit-dir node_modules/.tmp-playwright-patch`
2. ✅ `scripts/apply-rebrowser-patches.mjs` — 把上游 rebrowser `lib.patch` 的 6 文件 11 hunks 适配到 1.59.1
3. ✅ `crPage.js` 三处 hunk 全部重写（`Runtime.addBinding` 已搬进 `exposePlaywrightBinding()`，1.52 patch 不能直接 apply）
4. ✅ `bench:dbi-bot` 焦点跑：**20/20 flags FALSE**，`isAutomatedWithCDP=false`、`isAutomatedWithCDPInWebWorker=false` 全消
5. ✅ 全 9 站 bench：**OK=9 FAIL=0**，零回归（sannysoft / dbi-bot 都从原 60s timeout 变成 12-20s 正常返回）
6. ✅ `pnpm patch-commit` 落到 `patches/playwright-core@1.59.1.patch`（13.2 KB / 300 行）
7. ✅ `pnpm.patchedDependencies` 自动写入根 `package.json`（pnpm patch-commit 副作用）

#### 关键修订（vs 上游 rebrowser 1.52 patch）

| 路径 | 1.52 行为 | 1.59 行为 | 适配 |
|---|---|---|---|
| `crPage.js` `Runtime.addBinding` | 紧跟 `Runtime.enable` 同 promise array | 移进条件分支 `exposePlaywrightBinding()` | 只 wrap `Runtime.enable`，addBinding 路径不动 |
| Worker 实现 | `_executionContextPromise` + `_existingExecutionContext` | `ManualPromise` + `existingExecutionContext` (无下划线) | `getExecutionContext()` 用新属性名 |
| `frames.js` 内部访问 | `this._page._delegate` (下划线) | `this._page.delegate` (无下划线，但 `_sessions`/`_mainFrameSession` 仍下划线) | 双重命名共存 |
| `page.js` Worker.dispatch | 走旧 binding 路径 | 走 `${PageBinding.kController}` controller-based API | 仅保留 `!payload.includes("{")` 早返回守卫 |
| **`utilityWorldName`** | 常量 `__playwright_utility_world__` | `__playwright_utility_world_${page.guid}` 动态 | **`__re__emitExecutionContext` 接 `utilityWorldName` 参数；`frames._context` 从 `this._page.delegate.utilityWorldName` 透传** |

最后一行是 1.59 独有的隐形 deadlock 根因：1.52 patch 硬编码 `name: "__playwright_utility_world__"` 在 emit payload 里，在 1.59 上 `_onExecutionContextCreated` 会因 `contextPayload.name !== this._crPage.utilityWorldName` 静默忽略整个 utility context → `page.title()`/`page.locator()` 等任何走 utility world 的 API 永久 hang。诊断靠 `REBROWSER_PATCHES_DEBUG=1` + `bench/smoke-patch.ts` 5 步分段计时。

#### 验证矩阵

- ✅ `tsc --noEmit`: clean
- ✅ `vitest`: 168/168 通过（与 Phase 1.6 同总数）
- ✅ `bench/smoke-patch.ts`：`launchPersona → goto → title → evaluate(1+1)=2 → innerText` 全 OK，PATCH-ON 与 PATCH-OFF (MODE=0) 双模式均通过
- ✅ `bench:all`（9 站全跑）：OK=9 FAIL=0，143.9s 总耗时
- ✅ dbi-bot：`flagsTriggered: []`、`flagsTrue: 0`（之前 18/20 → 现 20/20）
- ✅ creepjs：lies/bold-fail surfaces 仍为 1 + 1（与基线完全一致）

#### 后续维护

- 重跑 patch 流程：见 `scripts/apply-rebrowser-patches.mjs` 头部注释（6 步从 fresh 状态完整重建）
- patch 行为开关：`REBROWSER_PATCHES_RUNTIME_FIX_MODE=0` 关闭 rebrowser 行为，回退到 vanilla Playwright 路径
- 调试 trace：`REBROWSER_PATCHES_DEBUG=1` 打 isolated-world / main-world / bindingCalled 全链路 log

#### dbi-bot 完整 20 flag 对照

| flag | Phase 1.6 baseline | Phase 1.7 (patched) |
|---|---|---|
| hasBotUserAgent | false | false |
| hasWebdriverTrue | false | false |
| hasWebdriverInFrameTrue | false | false |
| isPlaywright | false | false |
| hasInconsistentChromeObject | false | false |
| isPhantom | false | false |
| isNightmare | false | false |
| isSequentum | false | false |
| isSeleniumChromeDefault | false | false |
| isHeadlessChrome | false | false |
| isWebGLInconsistent | false | false |
| **isAutomatedWithCDP** | **true** | **false** ✅ |
| **isAutomatedWithCDPInWebWorker** | **true** | **false** ✅ |
| hasInconsistentClientHints | false | false |
| hasInconsistentGPUFeatures | false | false |
| isIframeOverridden | false | false |
| hasInconsistentWorkerValues | false | false |
| hasHighHardwareConcurrency | false | false |
| hasHeadlessChromeDefaultScreenResolution | false | false |
| hasSuspiciousWeakSignals | false | false |

**净增收益**：dbi-bot 上 `isAutomatedWithCDP*` 两个 CDP 结构性指标全部翻转为 FALSE。v0.2 的第一个"硬指标"全部落地。

### Phase 1.8 — sannysoft legacy 扫尾：plugins + mimeTypes + Notification.permission（代码完成 2026-05-15）

**目标**：消掉 9 站 bench 上 sannysoft 的 4 个 legacy 检测 fail：

| sannysoft 检测项 | 根因 | 修法 |
|---|---|---|
| `Permissions (New)` → prompt | `Notification.permission='denied'` (headless 默认) 与 `permissions.query.state='prompt'` 不一致，触发老 headless bug | Notification.permission spoof 成 `'default'` |
| `Plugins Length (Old)` → 0 | `navigator.plugins.length === 0` (Playwright 默认空) | 注入 5 PDF plugins |
| `Plugins is of type PluginArray` → failed | `navigator.plugins` 不是 `PluginArray` 实例 | 用 `Object.create(PluginArray.prototype)` 构造 |
| `HEADCHR_PLUGINS` / `HEADCHR_PERMISSIONS` | fpscanner 同源检测 | 上面两个修复顺带 fix |

#### 实现要点

新增 §10.5（[`runner.ts:938-1095`](../src/injection/runner.ts)）：

- **5 个 PDF plugins**（Chrome 88+ 全用户硬编码，0 entropy 增量）：
  - PDF Viewer / Chrome PDF Viewer / Chromium PDF Viewer / Microsoft Edge PDF Viewer / WebKit built-in PDF
  - 全部 `filename: "internal-pdf-viewer"`, `description: "Portable Document Format"`
- **2 个 mime types**：`application/pdf` + `text/pdf`，`enabledPlugin` 指向 PDF Viewer
- **`navigator.pdfViewerEnabled = true`**（Chrome 88+ 引入的布尔 feature flag）
- **`Notification.permission = 'default'`**（与 §10 permissions.query='prompt' 组成 sannysoft 期望的"真人态"）

#### 反检测兼容

- `Object.create(PluginArray.prototype)` / `Object.create(Plugin.prototype)` / `Object.create(MimeType.prototype)` 让所有 `instanceof` 检测过
- `defineProtoGetter(navigator, 'plugins', fakePluginArray)` 等 → 同 §1 navigator 字段一致的 stealth 路径（getter on `Navigator.prototype`，不留 own property，`Function.prototype.toString` 仍是 `[native code]`）
- `wrapStealth` 包装 Notification.permission getter，CreepJS getPrototypeLies 扫不到异常

#### 验证矩阵

- ✅ `tsc --noEmit`：clean
- ✅ `vitest`：**178/178 通过**（168 → 178，runner.test.ts 25 → 35），新增 10 测试：
  - plugins.length === 5 / instanceof PluginArray
  - plugins[0] is "PDF Viewer" / instanceof Plugin
  - 5 个 plugin names 完整枚举
  - plugins.namedItem("PDF Viewer") 返回正确实例
  - mimeTypes.length === 2 / instanceof MimeTypeArray
  - mimeTypes[0] instanceof MimeType + enabledPlugin → plugins[0]
  - pdfViewerEnabled === true
  - Notification.permission === "default"（happy-dom 跳过，仅 Chrome 环境验证）
  - 无 own property 泄露（CreepJS getPrototypeLies 守卫）

#### bench 验证状态

- ⏸️ **本地 TLS 网络问题暂缓**：bench 跑时 `net::ERR_CONNECTION_CLOSED`，
  `curl.exe` 也确认 schannel CRL/OCSP server 当前不可达（`CRYPT_E_REVOCATION_OFFLINE`），
  全网 HTTPS 暂时挂掉。**与 Phase 1.8 修改完全无关**（同样 curl 直连 example.com / github 都失败）。
- 等本地网络恢复后跑：
  ```bash
  $env:ONLY='sannysoft,dbi-bot'; pnpm --filter @mosaiq/sdk run bench:all; Remove-Item env:ONLY
  ```
  预期结果：sannysoft 4 个 plugins/permissions 红 → 全绿；dbi-bot 仍 20/20。

#### 后续：v0.2 剩余主炮

下一锤目标是 **creepjs WebGL bold-fail (`72f45525`)** + **Canvas 2d lies (`e9cf3faa`)**——这两个是
9 站 bench 上唯一两个还亮 🔴 的硬指标。预计 4-8h focused session：
1. 启 `bench/diagnose-creepjs.ts` + `bench/diagnose-webgl.ts` 复现单帧
2. 对照 Intel UHD 730 实机 gl.getParameter() 全 78 参数 → 找 mismatch
3. 加 `WEBGL_debug_renderer_info.UNMASKED_*` extension 一致性
4. Canvas: 检查 toDataURL/getImageData/measureText 三 surface 噪声是否引入"非随机"模式（CreepJS lies 引擎核心）

### Phase 1.9 — WebGL GL 参数对照表（代码完成 + 离线验证 2026-05-15）

**目标**：消 creepjs **WebGL bold-fail (`72f45525`)** —— v0.1 只 spoof 两个字符串
（`UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL`），但 CreepJS 把 ~78 个 GL
capability 参数（MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS / MAX_VERTEX_ATTRIBS 等）一起
hash 与声称 GPU 交叉对照。host 实际 GPU 与 Intel UHD 730 不一致 → CreepJS 立刻 bold-fail。

#### 关键诊断

跑了 `bench/diagnose-creepjs.ts`（已存在的 lies detector 移植）：所有 `scan_*: []`，
说明 queryLies 在 WebGL/Navigator/Screen/DOMRect/Permissions/Intl/Date 上**全 clean**
（我们的 wrapStealth + Proxy + native toString preservation 技术完美）。

那 bold-fail 必然来自 **GL 参数值本身**与声称 GPU 不一致 —— 这就是 v0.2 #2 立项的
"WebGL/Audio cross-check"。

#### 实现

新增 `packages/sdk/src/injection/webgl-profiles.ts`（180 行）：
- `WebglProfile`：`{ name, matchRenderer, webgl1: Map<number, GlParamValue>, webgl2: Map<...> }`
- `INTEL_UHD_730_D3D11`：硬编码 21 个 capability 参数（基于 chrome://gpu + webgl-stat 公共聚合）
  - WebGL1: 22 项（MAX_TEXTURE_SIZE=16384、MAX_VIEWPORT_DIMS=[16384,16384]、MAX_VERTEX_ATTRIBS=16、
    各 *_BITS=8/8/8/8/24/8/4、SAMPLES=0、ALIASED_*_RANGE 等）
  - WebGL2: 14 项（MAX_3D_TEXTURE_SIZE=2048、MAX_DRAW_BUFFERS=8、MAX_COLOR_ATTACHMENTS=8、
    MAX_FRAGMENT_INPUT_COMPONENTS=128、MIN/MAX_PROGRAM_TEXEL_OFFSET、MAX_SAMPLES=16、UBO 参数 ×6）
- `selectWebglProfile(renderer)` → 按字符串正则匹配 KNOWN_PROFILES 第一个 hit
- `serializeProfile(profile)` → 降级成可 JSON 化的 `{ webgl1: Record<hex, val>, webgl2: ... }`

`build-config.ts`：派生 `webglProfile` 字段（null 表示无 profile 时跳过 spoof，向后兼容）。

`runner.ts §4`：扩展 `makeGetParameterProxy` 接受 spoofMap 参数：
- 反序列化 hex 字符串 key → number；number[] value 按 pname 重建成 Int32Array / Float32Array
- Proxy.apply 增加 `spoofMap.get(pname)` 查表分支
- 每次返回新构造的 typed array（real GL 也是 fresh 一份；同一引用会被 CreepJS 检出"返回相同对象"）
- WebGL2 context 用 `webgl1 ∪ webgl2` merged map（因 WebGL2 继承 WebGL1 capability）

#### 关键设计点

- **不覆盖 context-dependent 参数**（当前绑定的 buffer/texture/framebuffer/viewport）。这些值随
  调用 site 变化，spoof 一个静态常量会让 WebGL app 直接挂掉。**只覆盖 capability 常量**
  （MAX_*  / *_BITS / ALIASED_*_RANGE），这些值在 context 生命周期不变，安全 spoof。
- **typed array 用 plain `number[]` 序列化**（typed array 过 JSON 会丢失）。runner.ts 用
  `INT32_PNAMES` / `FLOAT32_PNAMES` 两个 Set 按 pname 决定重建成哪种 typed array。
- **per-call clone**：每次 getParameter 调用返回一份新 typed array copy（real GL 行为）。

#### 验证矩阵

- ✅ `tsc --noEmit`：clean
- ✅ `vitest`：**197/197 通过**（178 → 197，新增 19 测试）：
  - `webgl-profiles.test.ts` 16 新测：hex 常量正确性 / typed-array set 互斥 /
    profile 字段值与真机一致 / selector 正负匹配 / 序列化 JSON 往返
  - `build-config.test.ts` 3 新测：Win11 → INTEL_UHD_730 派生 / Win10+macOS+Ubuntu → null /
    JSON 往返不变
- ✅ `bench/diagnose-webgl.ts`：**54/54 pass**（9 原 UNMASKED + 45 Phase 1.9 GL 参数检查），
  覆盖 WebGL1 + WebGL2 + OffscreenCanvas 三 context，全部 12 个 number 参 + 3 个 typed-array 参
  返回值与 Intel UHD 730 reference 完全一致。
- ⏸️ **网络恢复后**跑 `bench:all` 验证 creepjs 站 WebGL bold-fail 真正消失（72f45525 hash 应变）。

#### 后续：profile 库扩展

当前只有 Intel UHD 730 (Win11/D3D11) 一份 profile。未来 session 按需添加：
- Intel UHD 630 (Win10/D3D11) —— win10-chrome-us 模板
- Apple M2 (macOS/Metal) —— macos-sonoma 模板
- Mesa Intel (Ubuntu/OpenGL) —— ubuntu-2204 模板
- NVIDIA / AMD 桌面常见型号

添加流程：fork `INTEL_UHD_730_D3D11`、改 webgl1/webgl2 数值、加 `matchRenderer` 正则、加 vitest 覆盖、
push 到 `KNOWN_PROFILES` 数组首位（顺序决定优先级）。

#### v0.2 主炮剩余

Phase 1.9 后唯一还红的是 **creepjs Canvas 2d lies (`e9cf3faa`)** —— v0.1 引入的 per-persona
确定性 noise 与"真机自然变异"分布不同，CreepJS 把它标 lies。修法选项：
1. **降低 noise 强度**（仅修改 LSB，让分布更接近 anti-aliasing 抖动）
2. **接受这条 lies**（per-persona uniqueness 是核心特性，1 条 lies 可接受）
3. **chromium-fork** 在 Skia / Cc layer 注入 GPU-side noise（v1.0 计划）

短期推荐选项 2（接受），把精力转向 v0.3 工作（GREASE 顺序随机化 / Network.setExtraHTTPHeaders）。

### Phase 1.9 后续修复 — Navigator lies (getPluginLies enumerable 污染)

**日期**：2026-05-15（Phase 1.9 同日）

**症状**：Phase 1.9 部署后 creepjs bench 真机测出**新**的 Navigator lies (`b067dc4a`)，这是
Phase 1.8（plugins/mimeTypes spoof）引入但之前未触发的回归。Phase 1.9 的 GL 参数 spoof
本身并未引入此 lie，只是首次跑 creepjs 真机 bench 才暴露。

**Root cause**（reading [creepjs/src/lies/index.ts](https://github.com/abrahamjuliot/creepjs/blob/master/src/lies/index.ts) `getPluginLies`）：

```js
pluginsList.forEach((plugin) => {
  const pluginMimeTypes = Object.values(plugin).map((m) => m.type);
  pluginMimeTypes.forEach((mt) => {
    if (!trustedMimeTypes.has(mt)) lies.push('invalid mimetype');
  });
});
```

CreepJS 期望 `Object.values(plugin)` **只返回 MimeType 列表**（数字索引）。而我们的
Phase 1.8 实现中 Plugin metadata 设了 `enumerable: true`：

```ts
Object.defineProperties(plugin, {
  name: { value: p.name, enumerable: true, configurable: false },        // ❌
  description: { value: p.description, enumerable: true, configurable: false }, // ❌
  filename: { value: p.filename, enumerable: true, configurable: false },      // ❌
  length: { value: ..., enumerable: false, ... },
  '0': { value: mt0, enumerable: true },
  '1': { value: mt1, enumerable: true },
});
```

`Object.values(plugin)` 返回 `[<MimeType>, <MimeType>, "PDF Viewer", "Portable...",
"internal-pdf-viewer"]`。后续 `.map(m => m.type)` 中字符串 `.type` 是 `undefined`，
CreepJS 标 5 个 invalid mimetype × 5 plugins = **25 invalid mimetype lies** → Navigator lies。

**修复**（`@/d:/projects/Mosaiq/packages/sdk/src/injection/runner.ts:1075-1144`）：把 Plugin
的 `name/description/filename` 与 MimeType 的 `type/suffixes/description/enabledPlugin` 都
改为 `enumerable: false`。这与真实 Chrome IDL 一致 —— 这些 attributes 在真 Chromium 中
是 prototype getter 而非 instance own enumerable property。

#### 验证（real chrome bench）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `liesCount` (CreepJS) | 2 | **1** |
| `boldFailCount` | 1 | 1 |
| Navigator lies | 🔴 `b067dc4a` | **✅ clean** (`Navigator90812eb0`，普通 hash，非 lies class) |
| Canvas 2d lies | 🟡 已知 by-design | 🟡 已知 by-design |
| WebGL bold-fail | 🔴 still partial | 🔴 still partial |

#### 9 站综合 bench

- ✅ 9/9 sites accessible
- ✅ vitest **201/201 passing**（197 → 201，新增 4 回归测试覆盖 Object.values 路径）
- ✅ 唯一剩余真实失败：3 项
  - 🔴 creepjs WebGL bold-fail —— 需扩展 INTEL_UHD_730 profile 到 78 参数（当前 36）
  - 🟡 creepjs Canvas 2d lies —— per-persona PRNG 噪声 by-design（接受）
  - 🟡 browserleaks-canvas 100% uniqueness —— per-persona uniqueness by-design（接受）

#### 关键测试（`runner.test.ts:259-310`）

防退化：
1. `Object.values(plugin)` 只返回 MimeType 列表（无 metadata 污染）
2. Plugin metadata 全 `enumerable: false`
3. MimeType IDL attributes 全 `enumerable: false` + `Object.values(mt).length === 0`
4. **完整模拟 CreepJS getPluginLies 路径**：5 plugins × 2 mimeTypes 全 `valid` → 0 lies

### Phase 1.9b — 完整 49 named params 覆盖 + WebGL bold-fail root cause

**日期**：2026-05-15（Phase 1.9 同日扩展）

**目标**：把 INTEL_UHD_730_D3D11 profile 从 36 → 49 个 named params 全覆盖，对应 CreepJS
`src/webgl/index.ts` `getParamNames()` 完整 short list。

**新增 22 个 spoof entry**（`@/d:/projects/Mosaiq/packages/sdk/src/injection/webgl-profiles.ts`）：

- **String params (4)** — VENDOR / RENDERER / VERSION / SHADING_LANGUAGE_VERSION
  - WebGL1: `"WebKit"` / `"WebKit WebGL"` / `"WebGL 1.0 (OpenGL ES 2.0 Chromium)"` / `"WebGL GLSL ES 1.0..."`
  - WebGL2: 同 vendor/renderer，version+SLV 改为 2.0/3.00
  - merge 逻辑：`webgl2MergedSpoof = [...webgl1, ...webgl2]` —— webgl2 同 key 覆盖 webgl1
- **Stencil initial state (4)** — STENCIL_VALUE_MASK / WRITEMASK / BACK_VALUE_MASK / BACK_WRITEMASK
  - 全 `0x7fffffff`（GL ES 2.0 spec 初始值，real device capture 一致）
- **WebGL2-only caps (14)** —— 来自 browserleaks-webgl 真机捕获：
  - MAX_ELEMENTS_VERTICES/INDICES = 1048575
  - MAX_TEXTURE_LOD_BIAS = 15（Intel UHD 730 实测，spec 默认 2.0）
  - MAX_FRAGMENT_UNIFORM_COMPONENTS / MAX_VERTEX_UNIFORM_COMPONENTS = 16384
  - MAX_VARYING_COMPONENTS = 124（注意非 30×4=120）
  - MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS = 128 / SEPARATE_COMPONENTS = 4 / SEPARATE_ATTRIBS = 4
  - MAX_COMBINED_VERTEX/FRAGMENT_UNIFORM_COMPONENTS = 245760
  - MAX_SERVER_WAIT_TIMEOUT = 0
  - MAX_ELEMENT_INDEX = 0xfffffffe
  - MAX_CLIENT_WAIT_TIMEOUT_WEBGL = 0

**runner.ts §4 扩展**：`buildSpoofMap` + `cloneSpoofValue` 加 string return type，`SpoofVal = number | string | Int32Array | Float32Array`，sanity check `STRING_PNAMES`。

#### bench：WebGL hash 进展轨迹（每次 hash 都变 = spoof 生效）

| 阶段 | WebGL surface hash | 状态 |
|---|---|---|
| Phase 1.6 (UNMASKED-only) | `72f45525` | bold-fail |
| Phase 1.9 (36 params) | `aafac93b` → `b0672fc5` | bold-fail |
| Phase 1.9 + Navigator fix | `a310665c` | bold-fail |
| Phase 1.9b (49 params 100% 覆盖) | `6f274475` → `fca24b37` | **仍 bold-fail** |

#### Root cause 锁定 — CreepJS 白名单 gap（不是 Mosaiq 的 bug）

`bench/diagnose-creepjs-webgl-hash.ts` 直接复刻 CreepJS `Analysis` 计算路径，结果：

```
UNMASKED_RENDERER_WEBGL: ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 ...)
GPU brand:               Intel
numeric value count:     28
webglParams (sorted):    1,4,6,7,8,10,14,15,16,23,28,30,31,32,60,64,124,127,128,
                         1024,2048,4096,16384,65536,245760,1048575,2147483647,4294967294
caps hash (estimated):   -2146263890
```

CreepJS LowerEntropy.WEBGL 触发逻辑（`src/webgl/index.ts`）：

```js
const webglCapabilities = webglParams.reduce((acc, val, i) => acc ^ (+val + i), 0)
const hasSusCapabilities = webglCapabilities && !capabilities.includes(webglCapabilities)
if (hasSusCapabilities) LowerEntropy.WEBGL = true   // ← 触发 bold-fail
```

`capabilities` 是 CreepJS 项目维护的 ~250 个静态白名单（已知 GPU 真值 hash 集合）。我们
hash `-2146263890` **不在** 白名单（邻近值有 -2146253671/-2146277218/-2146286438 等，但
间隙正好命中我们的 hash）。

**核心结论**：Intel UHD 730 是 2022 年 Alder Lake 12 代，CreepJS 静态数据库未及时收录。
**真正的** Intel UHD 730 用户访问 creepjs.com 也会被同样标 bold-fail —— 这不是 Mosaiq spoof
错误，而是 CreepJS 项目 GPU 数据库覆盖率 gap。

#### 验证

| 测试 | 修复前 | Phase 1.9b 后 |
|---|---|---|
| vitest | 197/197 | **209/209** (+12 测试覆盖 Phase 1.9b) |
| diagnose-webgl 离线 | 54/54 | 54/54 |
| 49 named params 覆盖率 | 36/49 (73%) | **49/49 (100%)** |
| 9 站真机 bench | 9/9 OK | 9/9 OK |
| 真实失败项 | 3 | **3** (无回归) |

#### 后续选项（v0.3+）

| 选项 | 优势 | 劣势 |
|---|---|---|
| **A. 接受 bold-fail** | 与真实 Intel UHD 730 用户行为一致，persona-honest | 视觉指标差 |
| **B. 切到白名单内 GPU**（如 Intel UHD 630） | 立即消 bold-fail | 需多 profile + persona migration |
| **C. 提交指纹至 CreepJS upstream** | 长期解决 + 帮助生态 | 不可控 / 慢 |
| **D. 多 profile auto-fallback** | 灵活 persona-driven | 实现复杂，~v0.4 |

短期推荐 **A**（接受），同时 v0.3 实现 **B**（添加 INTEL_UHD_630_D3D11 等已知白名单 profile），
让 user 可选 persona 模板 trade-off uniqueness vs CreepJS pass。

---

## 6. 启动 Day 1 的命令

```bash
# 看现有 webgl 相关代码
rg "webgl" packages/sdk/src/injection -i

# 看 persona-schema fingerprint 字段
cat packages/persona-schema/src/fingerprint.ts | head -100

# 看 chromium-fork 已有的 webgl patch 草案（虽然冷藏，spec 可参考）
ls chromium-fork/patches/

# 重跑 baseline（验证起点状态）
pnpm --filter @mosaiq/sdk run bench:all
```
