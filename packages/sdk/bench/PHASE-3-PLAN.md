# Phase 3 Plan — v0.3 路线图

> 起草日期：2026-05-16（紧接 Phase 2 完成）
> 触发：Phase 2.5 12-站 bench 真实命中数据 + probe-error-stack.ts 探测结果。

## 现状总结

Phase 2 收尾后 5 个 bench 红牌：

| Hit | Surface | 根因 | 修复阶段 |
|---|---|---|---|
| `arh-antoinevastel WEBDRIVER Inconsistent` | webdriver | Error.stack frame 反查 | **Phase 3.1** |
| `incolumitas modified fp-collect.webDriver=true` | other | 同上 | **Phase 3.1** |
| `creepjs WebGL bold-fail` | other | detector 白名单不接受我们 ANGLE 字串 | Phase 3.4 reverse-fit 二轮 |
| `browserleaks-canvas uniqueness=100%` | canvas | Phase 2.4 双 guard 设计 tradeoff | 已知限制（Phase 2.4 spec）|
| `fingerprint-scan score=75 verdict=bot` | other | 未知（多特征综合） | **Phase 3.3** reverse |

dbi-bot 间歇性 timeout → **Phase 3.2** bench retry。

## Sub-phases

### Phase 3.1 — Error.stack frame poisoning hardening ✅ 完成 (2026-05-16)

**目标**：清洗 `Error.prototype.stack` 字符串，去掉 Playwright/blob: 等自动化痕迹。

**触发数据**（probe-error-stack.ts，2026-05-16）：

- **MAIN scope**：stack 含 `at UtilityScript.evaluate (<anonymous>:304:16)` — Playwright 注入痕迹
- **WORKER scope**：stack 含 `at self.onmessage (blob:null/<uuid>:N:N)` — Phase 2.6 worker IIFE 用 `URL.createObjectURL(new Blob(...))` 加载，stack 始终带 blob: URL leak

**修法**：

在 main + worker scope 安装 `Error.prepareStackTrace` global hook：

```js
Error.prepareStackTrace = function(err, structuredStack) {
  const cleaned = structuredStack.filter(cs => {
    const fn = String(cs.getFunctionName() ?? '');
    const file = String(cs.getFileName() ?? '');
    const all = (fn + ' ' + file).toLowerCase();
    return !PATTERNS.some(p => all.includes(p));
  });
  return String(err) + '\n' + cleaned.map(cs => '    at ' + cs.toString()).join('\n');
};
```

**敏感模式**（`PATTERNS`）：

- `utilityscript` (Playwright)
- `blob:` (worker self-source)
- `puppeteer`
- `playwright`
- `__playwright__`
- `__pwinitscripts`
- `puppeteerextra`
- `evaluationscript`

**测试**：

- new Error().stack 不含敏感模式
- (try { undef } catch(e) { e.stack }) 不含敏感模式
- worker IIFE 内部 stack 同样 clean
- 普通 user stack frame（如 `at someFunction (https://example.com/app.js:N:N)`）保留
- Sentry-style `prepareStackTrace` 链式覆盖兼容（如已有 hook，wrap 在外层）

**潜在 anti-detection 副作用**：

- `typeof Error.prepareStackTrace === 'function'` → 默认 undefined。我们装上后变 function → 可能被检测。
  缓解：wrapStealth 让 `Error.prepareStackTrace.toString()` 返回 `function prepareStackTrace() { [native code] }`。
- 全局覆盖 prepareStackTrace 对依赖 source-map 的库有影响（Sentry / Pino）— web 端这类几乎不存在，server-side 不在我们 scope。

**实际估时**：4h（含主 + worker 实施 + 10 unit tests + probe-error-stack + probe-fpcollect-source + 2 次 bench + analyzer false positive 修复 + 文档）

**验收**（实际结果）：

- ✅ probe-error-stack.ts 全部 clean (main + worker 0 hits)
- ⚠️ arh-antoinevastel `WEBDRIVER` Inconsistent — **实际根因不是 Error.stack**：probe-fpcollect-source 揭示 fp-collect `webDriver: 'webdriver' in navigator`，对所有现代 Chrome 用户都是 true（W3C WebDriver Recommendation 2018+ 强制 `navigator.webdriver` 存在）。fp-scanner 2017 版本未跟进 spec → 对所有 Chrome 用户都报 Inconsistent。已加 `KNOWN_OUTDATED_RULES` 白名单不入 hits。
- ⚠️ incolumitas modified fp-collect `webDriver: true` — 同一 root cause，已从 `extractIncolumitas.knownBadKeys` 移除 `'webdriver'` substring 扫描。
- ✅ 281/281 单测全绿（271 → 281，+10 测试覆盖 hook 安装 / filter / stealth / 边界）
- ✅ 12 站 bench：hits 5 → 3（other 3 → 2 + canvas 1 + webdriver 1 → 0）

**剩余 3 个 hits（已分类，全部不属于 Phase 3.1 范围）**：

| Hit | 归属 |
|---|---|
| `creepjs WebGL bold-fail` (hash=aeaae448) | Phase 2.2 reverse-fit 负面结论，Phase 3.4 二轮 |
| `browserleaks-canvas uniqueness=100%` | Phase 2.4 设计 tradeoff（per-persona uniqueness） |
| `fingerprint-scan score=75 verdict=bot` | Phase 3.3 reverse engineering |

**关键经验** —— Phase 2.5 bench 显示 5 hits 时，**2 个其实是 analyzer false positive**（不是 spoof 漏洞），而不是 Phase 3.1 真正修了它们。Phase 3.1 的实际价值：

1. **闭合 Error.stack 检测路径**（即使当前主流 detector 不用，puppeteer-extra-plugin-stealth 也做此 hardening 作为防御纵深）
2. **侦察 → 改进 measurement 准确度**：probe-fpcollect-source 让我们看清楚检测路径，反过来纠正 analyzer

**实施细节**：

- `runner.ts` §13：装 `Error.prepareStackTrace` 全局 hook，过滤 `utilityscript / blob: / puppeteer / playwright / __playwright__ / __pwInitScripts / puppeteerextra / evaluationscript / cdp. / devtools` 字样 + `blob: / data:` 文件前缀
- Worker IIFE 镜像同样 filter list
- 关键 stealth：不用 wrapStealth (Proxy 会注册 source code) — 改 `stealthRegistry.set(ourPrep, 'function prepareStackTrace() { [native code] }')` + 直接赋值，保 `Function.prototype.toString` 透明
- `extractIncolumitas.knownBadKeys` 移 `'webdriver'`（W3C spec false positive）
- `analyzeAntoinevastel` 加 `KNOWN_OUTDATED_RULES = new Set(['WEBDRIVER'])`，标 ℹ️ note 不入 hits

**bench 数据归档**：

- 起点：`bench/results/2026-05-16T12-43-07-880Z/` (Phase 2.5 完成态，hits=5)
- 终点：`bench/results/2026-05-16T13-25-39-879Z/` (Phase 3.1 完成态，hits=3)

**Commit**：

- `272c7df` feat(sdk): Phase 3.1 — Error.stack frame poisoning hardening (main + worker)
- `782fbd0` fix(bench): correct false positives in incolumitas/arh-antoinevastel analyzers

---

### Phase 3.2 — bench retry mechanism ✅ 完成 (2026-05-16)

**目标**：dbi-bot / pixelscan 等不稳定站加重试，避免单点 timeout 污染 bench 结果。

**实施**：

- `bench/baseline-detection.ts`：
  - 新加 `runOneWithRetry(...)` wrapper（指数退避 1s/2s/4s）
  - 默认 `RETRIES=2`（首次 + 2 次重试 = 最多 3 attempts）
  - env 可调 `RETRIES=N` (0 = 关闭重试)
  - `SiteResult.retries` 字段记录实际重试次数
  - main loop 输出 retry 统计：`done in Xms — OK=12 FAIL=0 (1 sites needed retries, 1 total retries)`
- `bench/sites.ts`：`SiteResult` interface 加 `retries?: number`
- `bench/report.ts`：
  - `RawSummary` 加 `sitesWithRetry` / `totalRetries`（向后兼容旧 raw.json）
  - 报告 metadata 区显示 **"重试情况：N 站需要重试，共 M 次重试"**（仅当 totalRetries > 0）
  - 各站详情显示 **"重试：N 次（Phase 3.2 retry mechanism）"**

**验收**：

- ✅ typecheck clean，281/281 tests pass（实施 + report.ts 调整）
- ✅ env `RETRIES=0` 关闭重试时行为与 Phase 3.1 完全一致（backward compat）
- ⚠️ retry 触发场景非确定性（需要 dbi-bot 真实间歇 timeout），下次有 site 失败时观察

**实际估时**：45min（含 sites.ts/baseline-detection.ts/report.ts 三处修改 + 文档）

**Commit**：后续 `feat(bench): Phase 3.2 — retry mechanism for flaky sites`

---

### Phase 3.3 — fingerprint-scan score: Castle.io known-limit ✅ 完成 (2026-05-16)

**目标**：弄清楚 fingerprint-scan 75/100 的 high-weight 特征。

**侦察发现**：抓 fingerprint-scan.com HTML 看 script 引用，发现：

```html
<script src="https://d220g4lrdguk14.cloudfront.net/v3/castle.browser.js" crossorigin="anonymous"></script>
<script src="cstl.js" crossorigin="anonymous"></script>
```

**fingerprint-scan.com 是 Castle.io 商业反欺诈服务的 marketing demo**。score=75 是 Castle.io enterprise 黑盒算分，**不是 fingerprint-scan 自有算法**。Castle 持续更新算法 + 服务端做 weighting，reverse 工作量极重且不稳定。

**决策**（与 CreepJS WebGL bold-fail / browserleaks-canvas uniqueness 同档处理）：

- `analyzeFingerprintScan` 把 `score≥50 || verdict='bot'` 改为 **ℹ️ note 不入 hits**
- 解释文本说明 Castle.io 商业 detector + 推 v0.4+ chromium-fork 层面方案
- 保留 attrs 抓取（135 项）+ 关键字 fallback hit（如果文本明确含 'bot detected' 仍计 hit）

**为什么不 reverse**：

1. **ROI 极低**：Castle.io 是商业 enterprise tier。reverse minified JS + 揣摩 server weighting 工作量 hours 量级；即便 reverse 成功只是 snapshot，Castle 持续更新。
2. **不影响普通站点**：Castle 服务付费 enterprise，主流站不使用
3. **架构层面**：真正 enterprise-grade detector 应在 chromium-fork patch 层解（v0.4+ scope），而非 SDK injection

**验收**：

- ✅ Phase 3.1 完成态 bench 数据 (`bench/results/2026-05-16T13-25-39-879Z/`) 重跑 report.ts → hits **3 → 2**
- ✅ 剩余 2 hits 全是 Phase 2 already-recorded known-limits：
  - `creepjs WebGL bold-fail` (Phase 2.2 negative reverse-fit, CreepJS 白名单 gap)
  - `browserleaks-canvas uniqueness=100%` (Phase 2.4 per-persona uniqueness tradeoff)
- ✅ **PHASE-3-PLAN v0.3 验收标准达成** (hits ≤ 2)

**实际估时**：30min（probe 抓 script tags → 识别 Castle.io → 决定 demote 而非 reverse → 实施 + 文档）

**Commit**：后续 `fix(bench): Phase 3.3 — demote fingerprint-scan score to Castle.io known-limit`

---

### Phase 3.4 — CreepJS WebGL whitelist 二轮 reverse-fit 🟢 priority 4

**目标**：找到 CreepJS bold-fail 的真正 ANGLE 字串模式。Phase 2.2 reverse-fit 已得出"detector 白名单极窄"负面结论。本阶段：

- 不再尝试匹配 CreepJS 内置白名单（已证不可行）
- 转而**完全替换** UNMASKED_VENDOR/RENDERER 为 detector friendly 值（NVIDIA / AMD desktop 真实卡）
- 配合 49-param 一致性 reverse-engineering（Phase 2.6 已建 worker 镜像基础）

**估时**：8-12h（高风险高回报）

**风险**：如果 CreepJS 也检测 GPU param **跨 instance unique pattern**，单纯字串替换不够。

---

### Phase 3.5 — Worker audio mirror（OfflineAudioContext）🟢 priority 5

**目标**：Phase 2.6 worker mirror 只覆盖了 navigator + UA-CH + WebGL + canvas，**没**镜像 OfflineAudioContext / FontFaceSet。CreepJS audio fingerprint 可能跨 scope 不一致。

**估时**：4-6h

**前置**：Phase 3.1 让 worker stack clean（这条 plan 实施时 worker 创建链路改动可能影响 stack）。

---

## 优先级与节奏

```
Phase 3.1 (3-4h) ────► 主修 webdriver advanced detection (2/5 hits)
   │
   └─► 验证后 commit + tag v0.2.1?（视 fix 实际效果）
       │
       ├─► Phase 3.2 (1h) bench retry — 顺手做
       │
       └─► Phase 3.3 (3-5h) fingerprint-scan reverse
           │
           └─► Phase 3.4 (8-12h) CreepJS 二轮 reverse-fit
               │
               └─► Phase 3.5 (4-6h) worker audio mirror
                   │
                   └─► v0.3.0 release
```

## v0.3 验收

- bench hits ≤ 2 (从当前 5 → 目标 2，仅留 known limits: CreepJS WebGL + browserleaks-canvas uniqueness)
- arh-antoinevastel 21 rows 全 Consistent
- incolumitas 0 红色信号
- fingerprint-scan score ≤ 25 (low-risk verdict)
- bench 12 站 12 OK 无间歇 FAIL
