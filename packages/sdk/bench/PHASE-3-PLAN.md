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

### Phase 3.1 — Error.stack frame poisoning hardening 🔴 priority 1

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

**估时**：3-4h（含实施 + 测试 + probe 验证 + bench 重跑 + 文档）

**验收**：

- ✅ probe-error-stack.ts 全部 clean (main + worker 0 hits)
- ✅ arh-antoinevastel `WEBDRIVER` Inconsistent → Consistent（如果是该路径触发）
- ✅ incolumitas modified fp-collect `webDriver: true` → false（同上前提）
- ✅ 271 单测保持不退化 + 新增 ≥ 8 测试

**风险与备选**：

- 如果 fp-collect modified 用的是**别的**检测（非 Error.stack），Phase 3.1 不会让 incolumitas 转绿。但 worker `blob:` leak 修了仍是净改进。
- 如果 fp-collect 用 `Object.getPrototypeOf(navigator).webdriver` 取 raw getter — 这是 Phase 3.1 范围外，需另开 Phase 3.5 navigator getter chain hardening。

---

### Phase 3.2 — bench retry mechanism 🟡 priority 3

**目标**：dbi-bot / pixelscan 等不稳定站加重试，避免单点 timeout 污染 bench 结果。

**修法**：

- `bench/baseline-detection.ts` 单站尝试 N 次（默认 2）
- 每次 timeout 用指数退避（1s, 2s）
- 报告记录 retry count
- 全失败才 FAIL

**估时**：1h

---

### Phase 3.3 — fingerprint-scan score reverse 🟡 priority 2

**目标**：弄清楚 fingerprint-scan 75/100 的 high-weight 特征。

**侦察步骤**：

1. 跑 fingerprint-scan + dump body content（已经有 attrs 列表）
2. 对比正常 user (你自己机器 headed mode) 跑出的分数差异
3. 定位 weight 因素（可能是：CDP Check / Chrome Object / iframe consistency / Same as Main JS Context）

**修法**：取决于侦察结论。如果是单点 fix，归并入 runner.ts 既有 surface；如果跨多 surface，开 Phase 3.5+。

**估时**：3-5h（侦察重，修可能 1-2h 或 5h+ 视复杂度）

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
