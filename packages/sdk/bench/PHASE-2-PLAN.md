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

### Phase 2.3 — Documentation + bench verification（重新定义）

**原计划**：新增 `win11-chrome-us-uhd630.ts` alt template 给用户 trade-off
`persona-honest UHD 730` vs `whitelist-pass UHD 630`。

**重新定义原因**：Phase 2.2 Part 2 证明 UHD 630 hash 同样不在 CreepJS 白名单
（与 UHD 730 同 ANGLE backend），所以 trade-off 不存在 —— 两个 GPU 都
bold-fail。新 template 无价值。

**实际任务（缩小 scope）**：

- 文档：在 `packages/sdk/README.md` 或 `packages/persona-schema/README.md`
  加一节 "WebGL spoofing & CreepJS bold-fail expectations"，引用 Phase 2.2
  Part 2 的分析，明确告知用户：
  - 4 个内置 template (win11/win10/macos/ubuntu) 的 WebGL bold-fail 在
    creepjs.com 上预期为 trigger
  - 这是 CreepJS 白名单覆盖问题，非 spoof 缺陷
  - 其他主流 fingerprinter (browserleaks/sannysoft/fp.imperva) 不依赖此白名单
- bench：跑 `win10-chrome-us` + `win11-chrome-us` end-to-end 通过
  `bench/baseline-detection.ts`（或 9 站套件），确认非 creepjs 站点
  pass rate 不退化
- 测试：persona-schema 已有的 4 template catalog 测试足够，无需新加

**验收**：

- ✅ README 文档段落落地（≥1 个清晰说明 + 复现命令）
- ✅ baseline-detection 跑 win10 + win11，所有非 creepjs 站点保持 v0.2 baseline
- ✅ 已知 limitation 在 PHASE-2-PLAN + README 双重记录

**估时**：1-1.5h（无新代码，仅文档 + 跑 bench 验证）

---

### Phase 2.4 — Canvas lies refinement

**目标**：降 creepjs Canvas 2d lies 触发率（当前 100% trigger）+ 控制 browserleaks-canvas uniqueness ≤ 60%。

**当前问题**：

- runner.ts canvas 段对每个 pixel 加 noise（`±1` LSB）→ CreepJS `getCanvasFingerprint` 比较 native vs spoof，hash 一定不同 → lies
- 降 noise 量级 → uniqueness 下降但 lies 仍触发（因为 hash 仍不同）
- 完全无 noise → uniqueness 100%，跨 persona 不可区分（破坏多 persona 隔离）

**新策略候选**（决策前调研）：

1. **Sparse noise**：只对 < 5% pixels 加 noise，其余保持 native
2. **Region-based noise**：只对特定区域（如 emoji / text 渲染区）加 noise
3. **Determinism within session**：同一 persona 同一 page session 内 hash 稳定，跨 page 不同
4. **CreepJS `lies` 检测豁免**：研究 `lies/index.ts` `getCanvasLies()` 内部逻辑，找触发条件并避开

**实施流程**：

1. 写 `bench/diagnose-canvas-lies.ts` 复刻 CreepJS `getCanvasLies()` 检测
2. 用 4 种策略各跑一次，对比 lies trigger / uniqueness 数据
3. 选最优策略落地

**验收**：

- ✅ creepjs Canvas 2d lies 不再 trigger（or trigger 频率 ≤ 50%）
- ✅ browserleaks-canvas uniqueness ≤ 60%
- ✅ 多 persona 隔离仍生效（ephemeral 模式下，跨 persona hash 不同）
- ✅ vitest 新增 canvas tests ≥ 5

**依赖**：无（独立于 Phase 2.1-2.3）

**估时**：4-6h

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
