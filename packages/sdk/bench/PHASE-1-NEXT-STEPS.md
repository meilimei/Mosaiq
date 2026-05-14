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
- [ ] `userAgentData` 在 worker scope 仍泄露 `HeadlessChrome 147`（CreepJS 没把它判 lies 但是潜在 surface）。等 chromium fork 阶段直接改 source。
- [ ] ServiceWorker realm 自身的 fetch interception（用 CDP `Network.requestIntercepted` + `Fetch.fulfillRequest` 在网络层改写 SW 脚本）。这是 Chrome blob 拒绝后唯一能让 SW 自己也 spoof 的路径，复杂度高。

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
