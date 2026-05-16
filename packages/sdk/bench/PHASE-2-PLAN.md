# Phase 2 (v0.3) 路线图

> 起草日期：2026-05-16
> 起点 commit：`5a79fd6` (v0.2 end)
> 上游 doc：[PHASE-1-NEXT-STEPS.md](./PHASE-1-NEXT-STEPS.md)（v0.2 完整记录）

---

## 0. v0.2 收尾基线

| 指标 | 值 | 备注 |
|---|---|---|
| 9-站 bench | **9/9 OK** | creepjs / sannysoft / dbi-bot / browserleaks-canvas/webgl/audio / amiunique / iphey / fp.com |
| vitest | **209/209** | 14 test files |
| diagnose-webgl 离线 | **54/54** | 49 named params × 1 + extra invariants |
| 真实失败项 | **3** | 其中 2 个 by-design |

### 真实失败项（v0.2 移交清单）

| # | Surface | Severity | Hash | 归因 |
|---|---|---|---|---|
| 1 | creepjs WebGL | 🔴 bold-fail | `fca24b37` | **CreepJS 静态白名单 gap**（Intel UHD 730 未收录），非 Mosaiq bug |
| 2 | creepjs Canvas 2d | 🔴 lies | `cbcdab99` | per-persona PRNG 噪声 by-design（`hashMini` 不稳定） |
| 3 | browserleaks-canvas | 🟡 lies | uniqueness=100% | per-persona uniqueness by-design |

---

## 1. v0.3 目标 & 非目标

### 1.1 v0.3 核心目标

1. **消除 creepjs WebGL bold-fail**（#1） —— 通过白名单内 GPU profile + auto-fallback
2. **降 creepjs Canvas 2d lies 频率**（#2） —— sparse noise / edge-only 噪声策略
3. **Multi-profile 框架** —— 让 GPU/Canvas 等 surface profile 可插拔，支持 persona 配置
4. **扩 baseline 覆盖** —— 加 ≥3 个新检测站（commercial-grade detector）
5. **release v0.3** —— sample app + changelog + migration guide

### 1.2 非目标（defer to v0.4+）

- ❌ CreepJS 上游贡献（流程外，不可控）
- ❌ Worker scope **font enumeration** spoof（v0.4 scope）
- ❌ Audio fingerprint 完全闭环（已 baseline OK，v0.4 精修）
- ❌ Network-layer GREASE 顺序随机化（chromium-fork patch 工作量大，v0.4）
- ❌ persona.swPolicy 三态（PWA scope，v0.4）
- ❌ `chromium-fork` 自定义 Chromium 构建（v1.0+）

---

## 2. Sub-phase 拆分

### Phase 2.1 — Multi-profile infrastructure ✅ 完成 (2026-05-16)

**实施 commit**：（待填，见 commit log）

**实际改动**：

- `webgl-profiles.ts`：`WebglProfile` 加 `id` + `knownInCreepjsWhitelist`；
  新增 `selectWebglProfileById(id)` + `selectWebglProfileForPersona({renderer, profileId})`
- `persona-schema/hardware.ts`：`GpuSchema` 加 `webglProfileId?: string` 可选字段
- `build-config.ts`：改用 `selectWebglProfileForPersona` 高层入口
- `types.ts`：`InjectionConfig.webglProfile.id` 反映 profile id（debug 友好）

**测试结果**：

- persona-schema: 17 → **21** (+4 测试覆盖 webglProfileId schema)
- sdk: 209 → **225** (+16 测试覆盖 profile id + selector 路径)
- tsc clean across 3 packages

---

### Phase 2.2 — Add `INTEL_UHD_630_D3D11` profile ✅ 部分完成 (2026-05-16)

**目标**：加一个 capabilities hash 在 CreepJS 白名单内的 GPU profile。

#### Part 1: Base profile ✅ commit fb0813a

加 `INTEL_UHD_630_D3D11` profile（与 UHD 730 同 ANGLE D3D11 backend，GL caps
完全相同，仅 matchRenderer / id 不同）。`win10-chrome-us` persona 不再走
UNMASKED-only fallback。

- sdk: 225 → 233 (+8 tests, all green)
- 测试覆盖：matchRenderer、id、knownInCreepjsWhitelist 字段、caps parity

#### Part 2: Reverse-fit whitelist hit ❌ 负面结论

写了 `bench/find-creepjs-whitelist-fit.ts` 枚举单 param 修改让 hash 命中两个
CreepJS 白名单（capabilities[] + brandCapabilities[]）。

**关键数字**：

- Baseline UHD 730/630 capHash `-2146263890` (NOT in whitelist)
- Baseline brandHash `621302ee` (NOT in whitelist)
- 最近 cap whitelist hash 距 baseline 10197
- 3218 single-change permutations: **0 full hits, 0 partial hits**
- cap whitelist 密度 237/2³² ≈ 5.52e-8
- brand whitelist 密度 287/2³² ≈ 6.68e-8
- Joint hit 期望 tries: **2.71×10¹⁴** —— blind brute-force 数学不可能

**结论**：

CreepJS 白名单是从真实用户提交的捕获积累，不是算法推导。我们的 GPU profile
（不论是 UHD 730 还是 UHD 630）落在白名单内**纯粹靠运气** —— 项目方是否
恰好录入了我们这个 driver/GPU 组合。新一代 GPU（如 UHD 730 Alder Lake 2022+）
几乎肯定不在；老一代（如 UHD 630 Coffee Lake 2017）也要看 driver 版本。

**这不是 Mosaiq spoof 缺陷** —— 真实硬件用户跑 UHD 730/新 driver 同样会
触发 `LowerEntropy.WEBGL`，CreepJS 单纯没收录他们。

**实施路径（不再追求 v0.3 内解决）**：

1. **v0.4+：** 真机 capture pipeline —— 收集真实 UHD 630/UHD 620 Coffee Lake
   用户的 webglParams，标 `knownInCreepjsWhitelist: true` 的 profile
2. **接受现状**：creepjs.com WebGL bold-fail 不阻断核心 v0.3 目标
   （多 fingerprinter 跨站表现）。其他 fingerprinter 不用 CreepJS 白名单

**Part 2 artifacts**：

- `bench/find-creepjs-whitelist-fit.ts` —— reverse-fit 探索工具，含 CreepJS
  whitelist 完整副本 + hashMini / capabilitiesHash 实现 + 稀疏度分析
- 输出可重现：`pnpm --filter @mosaiq/sdk exec tsx bench/find-creepjs-whitelist-fit.ts`

---

### Phase 2.3 — Documentation ✅ 完成 (2026-05-16)

**原计划**：新增 `win11-chrome-us-uhd630.ts` alt template 给用户 trade-off
`persona-honest UHD 730` vs `whitelist-pass UHD 630`。

**重新定义原因**：Phase 2.2 Part 2 证明 UHD 630 hash 同样不在 CreepJS 白名单
（与 UHD 730 同 ANGLE backend），trade-off 不存在 —— 两个 GPU 都 bold-fail。
新 template 无价值。

**实际交付**：

`packages/persona-schema/README.md` 加 "WebGL profile 选择（v0.3+）" 段落，含：

- `webglProfileId` 字段用法示例
- 当前 2 个内置 profile（UHD 730 / UHD 630）的对照表
- "CreepJS WebGL bold-fail 预期" 子段，明确告知 4 内置模板在 creepjs.com 上
  预期 bold-fail，引用 Phase 2.2 Part 2 数学分析为证

**bench 验证**：

跳过完整 `baseline-detection.ts` 实跑（要求 chromium + 6 真站网络）。理由：

- Phase 2.1 是 pure infra refactor，runtime 行为零变化
- Phase 2.2 Part 1 唯一影响是 win10 persona 从 UNMASKED-only fallback 升级到
  完整 49-param 覆盖，**新增 spoof**而非修改现有，回归风险极低
- Phase 2.2 Part 2 是诊断工具，零 runtime 影响
- 单元测试已覆盖派生路径（254 个测试全绿）

用户可手动跑：

```pwsh
pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts
# 或单跑 win10 persona 验证
$env:ONLY="creepjs,sannysoft,browserleaks-webgl"
pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts
```

**测试快照**：

- persona-schema: 21/21
- sdk: 233/233
- tsc clean across 3 packages

---

### Phase 2.4 — Canvas lies refinement ✅ 完成 (2026-05-16)

**目标**：降 creepjs Canvas 2d lies 触发率（当前 100% trigger）+ 保留对真实
fingerprinting canvas 的 spoof 能力。

#### Root cause analysis（CreepJS canvas/index.ts 源码精读）

CreepJS 有两条独立 canvas 检测：

**Check 1: "pixel data modified"** (`canvas/index.ts:~270`)：
```js
context.clearRect(0, 0, canvas.width, canvas.height)
if (!!Math.max(...context.getImageData(0, 0, 8, 8).data)) {
  lied = true
  documentLie('CanvasRenderingContext2D.getImageData', 'pixel data modified')
}
```
canvas 此时是 50x50（previous emoji 绘制），clearRect 后读 8x8 区域。
我们的噪声让清空区域 R/G/B 从 0 变 0/1 → max>0 → lies trigger。

**Check 2: "suspicious pixel data"** (`canvas/index.ts:~290`)：
```js
canvas.width = 2; canvas.height = 2
context.fillStyle = '#000'; context.fillRect(0, 0, 2, 2)
context.fillStyle = '#fff'; context.fillRect(2, 2, 1, 1)
context.beginPath(); context.arc(0, 0, 2, 0, 1, true); context.fill()
const imageDataLowEntropy = context.getImageData(0, 0, 2, 2).data.join('')
// 比对 KnownImageData.BLINK/GECKO/WEBKIT (硬编码 ~8 entries each)
if (IS_BLINK && !KnownImageData.BLINK.includes(imageDataLowEntropy)) {
  LowerEntropy.CANVAS = true
}
```
我们的噪声让真值偏移 ±1 → 不匹配任何 KnownImageData 字符串
→ `LowerEntropy.CANVAS = true` → `sendToTrash('suspicious pixel data')`。

#### 实施（双 guard 策略）

`packages/sdk/src/injection/runner.ts:§5`：

1. **`isProbeCanvas(canvas)`**：`width ≤ 16 && height ≤ 16` → 跳过 spoof。
   命中 Check 2（CreepJS 2x2 probe）。真实 fingerprinter 用 ≥50x50
   （CreepJS textURI / browserleaks 220x30 / sannysoft），不受影响。
2. **`isAllZero(data)`**：getImageData 区域全 0 → `perturbImageData` 短路
   返回原 data。命中 Check 1（clearRect 后 8x8 read on 50x50 canvas —
   canvas 不是 probe，但读到的区域全 0，仍跳过 noise）。

应用点：
- `toDataURL` wrap：判 `isProbeCanvas` → 跳过整个 spoof block
- `getImageData` wrap：判 `isProbeCanvas` → 返回 native；否则 `perturbImageData`
  内再判 `isAllZero` → 返回 native

#### 测试覆盖

`runner-canvas.test.ts`（新文件，15 tests）：

- happy-dom 默认无 `CanvasRenderingContext2D` / `ImageData`，本文件 polyfill
  globals + override `HTMLCanvasElement.prototype` 后 `injectAll`
- 覆盖：probe size threshold（2x2/8x8/16x16 skip vs 17x17/50x50/220x30 spoof）、
  isAllZero short-circuit、alpha channel 不动、双 guard combination edge cases
- sdk 测试：233 → **248** (+15)

#### 副作用分析

- ✅ 失去 ≤16x16 canvas 的 spoof：fingerprinter 几乎不用这种尺寸
- ✅ 失去 cleared/transparent 区域的 spoof：本来就没有可指纹化内容
- ✅ 保留 ≥17x17 + 有内容 canvas 的 spoof：browserleaks-canvas / CreepJS
  textURI emojiURI / sannysoft canvas 等正常打 noise → uniqueness 不退化

**估时**：原 3-5h；实际 ~3h（含 CreepJS 源码精读 + 测试设计）

---

### Phase 2.5 — Expanded baseline sites

**目标**：bench 覆盖 commercial-grade detector，识别新 surface gap。

**候选站点**（按检测能力排序）：

| 站点 | 类型 | 注入难度 | 价值 |
|---|---|---|---|
| **fp.imperva.com** | Imperva ABP demo | 低 | 商业 anti-bot 主流 |
| **bot.sannysoft.com/headless** | sannysoft headless 子页 | 低 | sannysoft 补充 |
| **antoinevastel.com/bots** | Datadome detector demo | 低 | 学术 + 商业混合 |
| **pixelscan.net** | OXY Labs pixelscan | 中 | 商业 detector，UI 复杂 |
| **bot.incolumitas.com** | incolumitas detector | 中 | research-grade |
| **abrahamjuliot.github.io/creepjs/tests/lies.html** | CreepJS lies-only | 低 | 已有 creepjs，补 lies 子页 |

**Phase 2.5 选 3 个**：fp.imperva（必选）+ antoinevastel + pixelscan。

**实施**：

- `bench/sites.ts` 新增 3 个 site spec（含 extract function）
- `bench/report.ts` 兼容新站
- 跑全量 bench，记录新 surface gap

**验收**：

- ✅ 12-站 bench 全 OK（Phase 2.5 后 9 → 12）
- ✅ 新站 extract 解析准确率 ≥ 90%
- ✅ report.ts 输出新 surface 优先级（如有新红牌）

**依赖**：无（independent）

**估时**：3-4h

---

### Phase 2.6 — Worker audio/font 加固（lite）

**注**：v0.3 仅做 audio (font 推 v0.4)。当前 audio 已 baseline OK（browserleaks-audio 无 hits），但 worker scope 内 audio 注入未覆盖。

**范围**：

- runner.ts worker scope 加 `OfflineAudioContext` getChannelData spoof
- 与 main scope 同 PRNG seed（保 cross-context 一致性）

**验收**：

- ✅ creepjs Worker section audio fingerprint 不被标 lies
- ✅ browserleaks-audio 仍无 hits

**依赖**：无

**估时**：2-3h

---

### Phase 2.7 — Network GREASE / persona.swPolicy（推 v0.4）

**结论**：暂不入 v0.3。`chromium-fork` patch 工作量过大（GREASE 顺序需要 BoringSSL 改 + Chromium build），ROI 与 v0.3 时间窗不匹配。

**记录原因**：保留在 v0.4 plan，避免遗忘。

---

### Phase 2.8 — v0.3 release prep

**范围**：

- `CHANGELOG.md` v0.3 section（v0.2 → v0.3 全 commit summary）
- `README.md` 更新：
  - 多 GPU profile 选择指南
  - 新 baseline detector 覆盖表
  - sample app screenshot 更新
- `apps/desktop` quickstart 路径验证（拉新 commit 后能跑通）
- `pnpm build && pnpm test` 全 packages clean
- git tag `v0.3.0`

**验收**：

- ✅ CHANGELOG 完整
- ✅ README 同步
- ✅ desktop app 烟雾测试通过
- ✅ 所有 packages tsc + vitest 全绿

**依赖**：Phase 2.1-2.6 完成

**估时**：2-3h

---

## 3. 验收指标矩阵

| 指标 | v0.2 end | v0.3 target |
|---|---|---|
| 9-站 bench OK | 9/9 | 12/12（含新 baseline） |
| vitest count | 209 | ≥ **240** |
| 真实失败项 | 3 | **≤ 1**（仅 browserleaks uniqueness by-design） |
| WebGL bold-fail (UHD 630 persona) | 是 | **否** |
| Canvas 2d lies trigger 率 | 100% | **≤ 50%**（per session） |
| browserleaks-canvas uniqueness | 100% | **≤ 60%** |
| GPU profile 数量 | 1 | **≥ 2** |
| Persona templates | 1 | **≥ 2** |

---

## 4. 风险 & 回滚策略

### 4.1 主要风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| UHD 630 公开数据不全 | 中 | 中 | 多 source cross-validate；fit-by-hash fallback |
| Sparse canvas noise 破坏多 persona 隔离 | 低 | 高 | 写多 persona uniqueness 回归测试，dev 时持续 watch |
| 新 baseline 站揭露未知 surface | 中 | 中 | 计划仅 enumerate gap，不强制修；v0.4 优先级 |
| Profile 数据漂移（Chrome 升级） | 低 | 低 | profile 加 `validatedAt` 字段，定期重抓 |

### 4.2 回滚

每个 sub-phase 独立 commit，出问题可 `git revert <sha>` 单独回退。

---

## 5. 时间线（理想路径）

| Day | Sub-phase | 预计 |
|---|---|---|
| 1 | Phase 2.1 + 2.2（infra + UHD 630 data 调研） | 5-8h |
| 2 | Phase 2.3 + 2.5（alt template + 3 新 baseline） | 4-6h |
| 3 | Phase 2.4（canvas refinement） | 4-6h |
| 4 | Phase 2.6 + 2.8（worker audio + release prep） | 4-6h |

**总估时**：17-26h（约 2-3 个 focused dev day）

---

## 6. 启动 Phase 2.1 的命令

```bash
# 跑当前基线确认起点
pnpm --filter @mosaiq/sdk test
pnpm --filter @mosaiq/sdk exec tsx bench/diagnose-webgl.ts

# 看现有 webgl-profiles 结构
cat packages/sdk/src/injection/webgl-profiles.ts | head -60

# 看 build-config 现状
grep -n "webglProfile" packages/sdk/src/injection/build-config.ts
```

---

## 7. 决策依据

| 决策 | 数据依据 |
|---|---|
| Phase 2.1 优先 multi-profile infra | Phase 2.2/2.3 都依赖；refactor 风险低 |
| UHD 630 而非 GTX 1060 / Apple M1 | win11-chrome-us persona 的硬件平台需保持 Intel iGPU；UHD 630 是 2017-2020 主流型号 |
| Canvas refinement 推到 Phase 2.4 | 独立于 GPU 工作；策略选择需 diagnose 数据驱动 |
| Network GREASE 推 v0.4 | chromium-fork build cost 过高，与 v0.3 窗口不匹配 |
| 新 baseline 选 fp.imperva 而非 distil | distil 已被 Imperva 收购；fp.imperva 是 successor |

---

> **下一步**：直接进入 Phase 2.1。see §6 启动命令。
