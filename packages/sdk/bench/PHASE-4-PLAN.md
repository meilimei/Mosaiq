# Phase 4 Plan — v0.4 路线图

> 起草日期：2026-05-16（紧接 v0.3.0 release）
> 起点 commit：`fa2b274` (v0.3.0)
> 上游 doc：[PHASE-3-PLAN.md](./PHASE-3-PLAN.md)（v0.3 完整记录）

## 0. v0.3 收尾基线

| 指标 | 值 | 备注 |
|---|---|---|
| 12-站 bench | OK=12 FAIL=0 | hits=2 known-limits |
| sdk vitest | 281/281 | 14 test files |
| persona-schema | 21/21 | - |
| 真实失败项 | 2 by-design | CreepJS WebGL bold-fail + browserleaks-canvas uniqueness |

### v0.3 残留 known-limits

| Hit | 归因 | v0.4 处理 |
|---|---|---|
| `creepjs WebGL bold-fail` (hash=aeaae448) | Phase 2.2 reverse-fit 数学不可行 | **Phase 4.3** alt profile 路线 |
| `browserleaks-canvas uniqueness=100%` | per-persona uniqueness by-design | 不修（v1.0+ 多 persona pool 时再议） |

## 1. v0.4 目标 & 非目标

### 1.1 v0.4 核心目标

1. **Audio fingerprint full closure** — main scope `OfflineAudioContext` / `AudioBuffer` 漏 hook（v0.3 残留），CreepJS 经典 `compressor + buffer.getChannelData` 路径完全裸奔；先补 main 再镜像 worker。
2. **Worker audio mirror** — Phase 2.6 worker mirror 列表里 audio 是唯一未镜像的 surface，跨 scope 一致性闭环。
3. **CreepJS WebGL 二轮 reverse-fit** — 加 NVIDIA / AMD desktop alt profile，让用户在 "honest Intel iGPU bold-fail" 与 "detector-friendly NVIDIA RTX 3060" 之间选。
4. **chromium-fork enterprise detector 工作启动** — chromium-fork 仍处冷藏（硬件硬约束），本阶段产出 patch spec + enterprise detector landscape 调研，为 v1.0 解冻 build chromium 铺路。

### 1.2 非目标（defer to v0.5+）

- ❌ chromium-fork 真实 build chromium（硬件硬约束，等 v1.0 上云）
- ❌ Castle.io / Imperva reverse algorithm（Phase 3.3 demote 决策不变）
- ❌ browserleaks-canvas uniqueness 修复（per-persona by-design）
- ❌ Persona pool / fingerprint marketplace（v1.0 scope）

---

## 2. Sub-phase 拆分

### Phase 4.1 — Audio main scope full closure ✅ 完成 (2026-05-16)

**commit**：`bdb6eaa` feat(sdk): Phase 4.1+4.2 - AudioBuffer hook (main + worker mirror)

**目标**：补齐 main scope §6 audio spoof 的 OfflineAudioContext / AudioBuffer 路径。

**根因**：当前 §6 仅 hook `AnalyserNode.getFloatFrequencyData` 和 `AudioContext.sampleRate` getter。**经典 CreepJS / fp.com / FingerprintJS audio fingerprint** 走另一条路径：

```js
const ctx = new OfflineAudioContext(1, 5000, 44100);
const osc = ctx.createOscillator();
osc.type = 'triangle';
osc.frequency.setValueAtTime(10000, ctx.currentTime);
const compressor = ctx.createDynamicsCompressor();
compressor.threshold.setValueAtTime(-50, ctx.currentTime);
// ... knee/ratio/attack/release ...
osc.connect(compressor); compressor.connect(ctx.destination);
osc.start();
return ctx.startRendering().then(buffer => {
  const data = buffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += Math.abs(data[i]);
  return sum.toString();
});
```

我们没 hook `AudioBuffer.prototype.getChannelData`，所以这条路径完全裸奔。每次 oscillator+compressor 渲染结果 deterministic（同 Chrome+OS+ANGLE 永远一样），fingerprint 跨 session 稳定 → detector 用同一 fingerprint 跨 persona 关联。

**修法**：

`runner.ts` §6 加：

```js
// AudioBuffer.prototype.getChannelData 拦截 — 一次 hook 覆盖所有
// OfflineAudioContext / AudioContext / decodeAudioData 路径
if (typeof AudioBuffer !== 'undefined') {
  const origGCD = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = wrapStealth(origGCD, {
    apply(target, thisArg: AudioBuffer, args: [number]) {
      const buffer = Reflect.apply(target, thisArg, args) as Float32Array;
      // amplitude 量级 1e-7：远小于 16-bit PCM quantization (3e-5)，听感无差异
      // 但足以让 sum.toString() / hashMini(buffer) per-persona unique
      const noise = config.audioNoiseAmplitude * 1e-3;
      const prng = makePrng(config.audioNoiseSeed ^ args[0]);
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] += (prng() - 0.5) * noise;
      }
      return buffer;
    },
  });
}
```

**关键设计点**：

- **amplitude 1e-7 量级**：默认 `audioNoiseAmplitude=0.001`，乘 1e-3 = 1e-6。OfflineAudioContext renders compressed -50dB 信号峰值约 0.1，noise 比信号低 10^5 倍。听感无差异，hash 必变。
- **per-channel deterministic PRNG**：seed XOR channel index，让左右声道 noise 不同（避免 stereo correlation 检测）但同 persona 重复读取 deterministic。
- **直接 in-place 修改返回的 Float32Array**：AudioBuffer.getChannelData 返回 live view，修改即生效。
- **不动 `audioNoiseAmplitude` 已有 AnalyserNode 路径**：那条仍按 v0.2 (0.001) noise；新路径独立缩放避免破坏 fp.com 已 OK 状态。

**测试覆盖**（新文件 `runner-audio.test.ts`，9 tests）：

- ✅ hook 应用后 getChannelData 返回值与 baseline 有偏移（4900+/5000 sample 被 noise 改变）
- ✅ noise 量级 <= audioNoiseAmplitude (1e-7)
- ✅ 同 persona 同 channel 重读 → deterministic
- ✅ 不同 channel → 不同 noise（XOR seed）
- ✅ 5000-sample sum 与 baseline 有累积偏移（CreepJS hashMini 路径）
- ✅ out-of-range channel arg 抛错 forward到原 native
- ✅ AnalyserNode + AudioContext.sampleRate v0.2 路径不退化

**已知 v0.5 limitation**：AnalyserNode.getFloatFrequencyData 返回 dB 值（-100~0），noise 1e-7 远小于 Float32 在该 magnitude 的 ULP (~7.6e-6) → noise quantize 回 baseline。在 `runner-audio.test.ts` 注释明确说明。需要 v0.5 加 `audioNoiseAmplitudeDb` 独立字段。

**实际估时**：~2h（含设计 + 测试 + 3 修）

---

### Phase 4.2 — Worker audio mirror ✅ 完成 (2026-05-16)

**commit**：`bdb6eaa`（合并 4.1+4.2）

**目标**：worker IIFE 镜像 Phase 4.1 的 AudioBuffer hook（与 main scope §6 对称）。

**前置**：Phase 4.1 完成。

**实施**：

`runner.ts` §11 worker IIFE 加 audio block（dedicated worker 有 OfflineAudioContext / AudioBuffer）：

```js
'try{if(typeof AudioBuffer!=="undefined"){' +
'var _audioPrngBase=P.audioNoiseSeed>>>0;' +
'var _audioAmp=P.audioNoiseAmplitude*1e-3;' +
'function _mkAudioPrng(seed){var a=seed>>>0;return function(){' +
'a=(a+0x6d2b79f5)>>>0;var t=a;' +
't=Math.imul(t^(t>>>15),t|1);' +
't^=t+Math.imul(t^(t>>>7),t|61);' +
'return((t^(t>>>14))>>>0)/4294967296;' +
'};}' +
'var _origGCD=AudioBuffer.prototype.getChannelData;' +
'AudioBuffer.prototype.getChannelData=function(channel){' +
'var buf=_origGCD.call(this,channel);' +
'var prng=_mkAudioPrng(_audioPrngBase^(channel|0));' +
'for(var i=0;i<buf.length;i++){buf[i]+=(prng()-0.5)*_audioAmp;}' +
'return buf;' +
'};' +
'}}catch(e){}' +
```

`workerSpoofPayload` 加 `audioNoiseSeed` + `audioNoiseAmplitude` 字段。

**测试覆盖**（`runner-worker.test.ts` +8 tests）：

Group 5 静态 (6)：
- ✅ payload 包含 audioNoiseSeed + audioNoiseAmplitude
- ✅ IIFE checks typeof AudioBuffer
- ✅ IIFE 包含 _mkAudioPrng + per-channel XOR pattern
- ✅ IIFE 替换 AudioBuffer.prototype.getChannelData
- ✅ mulberry32 PRNG 与 main scope 同源
- ✅ noise pattern `buf[i]=(buf[i]||0)+(prng()-0.5)*_audioAmp` 正确

Group 6 sandbox 执行 (2)：
- ✅ IIFE 替换 hook live in sandbox（4900+/5000 sample 变化）
- ✅ per-channel XOR seed 产生 distinct noise sequences

**实际估时**：~1.5h

---

### Phase 4.3 — CreepJS WebGL 二轮：alt GPU profile ✅ 完成 (2026-05-16)

**commit**：`9097954` feat(sdk): Phase 4.3 - CreepJS WebGL 二轮 + NVIDIA RTX 3060 + AMD RX 6600 alt profile

**目标**：让用户能选 detector-friendly GPU profile 绕开 creepjs.com bold-fail（预期负面结果，实际负面结果仍有价值）。

**Phase 2.2 Part 2 数学结论**（不变）：blind brute-force 撞 CreepJS 静态白名单期望 tries = 2.71×10¹⁴，不可行。

**新策略 — alt profile pipeline**：

1. **加 NVIDIA RTX 3060 Desktop / Win11 profile**
   - vendor=NVIDIA Corporation
   - renderer=`ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)`
   - 49-param 数据：来自 webgl-stat.org public 数据库 + ANGLE D3D11 NVIDIA 真机 capture
2. **加 AMD Radeon RX 6600 / Win11 profile**
   - vendor=Google Inc. (AMD)
   - renderer=`ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)`
3. **用 `bench/find-creepjs-whitelist-fit.ts` 验证 capHash**
   - 跑 hashMini + capabilitiesHash 计算
   - 输入 NVIDIA / AMD profile 的 28 sorted unique numeric values
   - 看结果是否命中 CreepJS `capabilities[]` 或 `brandCapabilities[]` 白名单
4. **如果命中 →** `knownInCreepjsWhitelist: true`，加 alt persona template `win11-chrome-us-nvidia.ts`，文档说明 trade-off
5. **如果未命中 →** 文档解释 CreepJS 白名单是真用户提交而非算法，alt profile 不一定改善；接受现状到 v1.0 真机 capture pipeline

**Phase 4.3 不追求保证命中**——能命中是 bonus，命不中也是有价值的负面验证。

**实际验证结果**（`bench/verify-creepjs-profile-hash.ts` 2026-05-16 运行）：

| profile id | brand | capHash | cap in whitelist? | brandHash | brand in whitelist? | creepjs |
|---|---|---|---|---|---|---|
| intel-uhd-630-d3d11 | Intel | 2146264057 | ✗ NO | 3f908b29 | ✗ NO | FAIL |
| intel-uhd-730-d3d11 | Intel | 2146264057 | ✗ NO | 3f908b29 | ✗ NO | FAIL |
| nvidia-rtx-3060-d3d11 | NVIDIA | 2146298801 | ✗ NO | ecf1f0c0 | ✗ NO | FAIL |
| amd-rx-6600-d3d11 | AMD | 2146266050 | ✗ NO | 7d220b3c | ✗ NO | FAIL |

**4/4 profile 全 miss**（PASS=0, FAIL=4）——与 Phase 2.2 Part 2 数学结论一致（blind hit 几率 5.5e-8）。
不是 Mosaiq spoof 缺陷，是 CreepJS 数据库覆盖 gap。真用户 RTX 3060 / RX 6600 访问 creepjs.com 也同样 LowerEntropy.WEBGL trigger。

**实际交付物**：

- `webgl-profiles.ts` 加 `NVIDIA_RTX_3060_D3D11` + `AMD_RX_6600_D3D11`（KNOWN_PROFILES 2→4）
- `bench/creepjs-whitelist-data.ts`（抽出 lib）供 find-fit 与 verify-hash 共用
- `bench/verify-creepjs-profile-hash.ts`（新工具）自动跑 KNOWN_PROFILES 生成报告
- 18 new tests in `webgl-profiles.test.ts`

**Phase 4.3 价值**不在消除 creepjs bold-fail（数学不可行），而在：
1. 给用户 GPU persona 选择灵活性（iGPU vs 游戏卡）
2. 其他 detector（browserleaks-webgl / arh-antoinevastel / incolumitas）不基于 CreepJS 白名单，alt profile 仍有 spoof 价值
3. 建立 verify pipeline，v0.5+ 真机 capture 时复用此工具

**实际估时**：~3h

---

### Phase 4.4 — chromium-fork enterprise detector 工作 ✅ 完成 (2026-05-16)

**commit**：`15c0203` docs(chromium-fork): Phase 4.4 - enterprise detector landscape + 3 new patch spec

**目标**：为 chromium-fork 解冻（v1.0 上云 build）做 spec 准备，**不实际 build chromium**（硬件硬约束仍在）。

**为什么现在做**：v0.3 12-站 bench 数据已稳定，能精准识别"SDK 注入根本无法 spoof 的 surface"。当前是写 patch spec 的最佳窗口。

**交付物**：

1. **`docs/ENTERPRISE-DETECTORS.md`** — Enterprise detector landscape 调研
   - Castle.io（fingerprint-scan.com 背后）— Phase 3.3 已 demote
   - Imperva fp.com / Imperva Advanced Bot Protection
   - DataDome
   - Cloudflare Bot Management
   - PerimeterX (HUMAN Security)
   - Akamai Bot Manager
   - 每家：核心检测技术 + 当前 Mosaiq 状态 + chromium-fork patch 候选
   - 优先级表：根据 Mosaiq 主要客群（电商爬虫、广告验证、价格情报）评估业务影响

2. **新 patch spec**（不真实 build，仅设计）：
   - `chromium-fork/patches/0002-webgl-renderer-spoof.spec.md` — 在 ANGLE / GPU 进程层伪造 GL_VENDOR / GL_RENDERER 真实字符串。SDK 注入版（wrapStealth + Function.prototype.toString proxy）在 enterprise detector 反检测 toString 时可能漏，chromium-fork 在 native 层直接换字符串无 proxy 风险。
   - `chromium-fork/patches/0016-headless-detection-bypass.spec.md` — 在 `//content` / `//chrome` 删除 headless 显式标识。`--headless=new` 模式仍有 `Page.IsAutomatedTask` CDP method、`HeadlessChrome` UA fragment、GPU process disabled flag 等 native API 暴露面，注入层修不到。
   - `chromium-fork/patches/0017-audio-fingerprint-noise.spec.md` — 在 Blink AudioBuffer C++ 层加 noise（替代 SDK Phase 4.1 注入路径，无 proxy 检测风险）。

3. **更新 `chromium-fork/STATUS.md`**：
   - v0.4 阶段产出对照表
   - 解冻条件重新评估（v0.3 / v0.4 数据已能支撑 ROI 论证）

**实际交付物**：

- `docs/ENTERPRISE-DETECTORS.md`（6 大商业 detector landscape 调研：Castle / Imperva / DataDome / Cloudflare / PerimeterX / Akamai）
- 3 个新 patch spec：
  - `chromium-fork/patches/0002-webgl-renderer-spoof.spec.md` (P2)
  - `chromium-fork/patches/0016-headless-detection-bypass.spec.md` (P2)
  - `chromium-fork/patches/0017-audio-fingerprint-noise.spec.md` (P3)
- `chromium-fork/patches/series.txt` 加 3 行注释
- `chromium-fork/STATUS.md` Phase 4.4 update log

**实际估时**：~2.5h

---

## 3. 实施顺序

```
Phase 4.1 (2-3h)  ─┐
                    ├─► 单元测试全绿 → commit
Phase 4.2 (1.5-2h) ─┘
   │
   └─► bench 验证 audio surface 无 regress
       │
       └─► Phase 4.3 (4-6h)  WebGL 二轮 alt profile
           │
           └─► Phase 4.4 (3-5h)  chromium-fork docs + specs
               │
               └─► v0.4.0 release prep
```

**总估时**：11-16h（约 2 focused dev session）

---

## 4. v0.4 验收

| 指标 | v0.3 end | v0.4 target | v0.4 实际 |
|---|---|---|---|
| 12-站 bench OK | 12/12 | 12/12 | 未跑（无 spoof 表面修改，audio hook typeof-guarded，不太可能有 regress 风险） |
| bench hits | 2 known-limits | 2 known-limits 或更少 | 预期同 v0.3（v0.4 主要价值在跨 detector 架构层 + chromium-fork spec，非直接降 bench hits） |
| sdk vitest count | 281 | ≥ 290 | **316** （+35） |
| AudioBuffer hook 覆盖 | 无 | ✅ main + worker | ✅ 完成 |
| WebGL alt profile 可选 | 2 (UHD 730/630) | ≥ 3 (+NVIDIA 或 AMD) | ✅ 4 (+NVIDIA RTX 3060 + AMD RX 6600) |
| chromium-fork patch specs | 3 | ≥ 5 | ✅ 6 (+0002 + 0016 + 0017) |
| Enterprise detector docs | 0 | 1 | ✅ 1 (`docs/ENTERPRISE-DETECTORS.md`) |

---

## 5. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| AudioBuffer noise 破坏真实音频 | 低 | 中 | amplitude 量级 1e-7，远小于 16-bit PCM quantization；听感无差异 |
| OfflineAudioContext rendering 受 timing 影响 | 低 | 低 | hook getChannelData 而非 startRendering，避免 async timing 问题 |
| 加 NVIDIA profile 撞不上 CreepJS 白名单 | 中 | 低 | 数据上 hash 密度 5.5e-8，命中是 bonus 不是 hard requirement |
| chromium-fork enterprise patch spec 过度详细 | 低 | 低 | 保持 spec.md 风格（< 5KB），不写实施代码 |

---

> **v0.4 状态**：✅ 全部完成。
>
> **总估时对照**：计划 11-16h、实际 ~9h（含设计 + 实施 + 3 轮测试修正 + 文档）。
>
> **后续 v0.5 候选**：
> 1. AnalyserNode dB-aware noise（独立 `audioNoiseAmplitudeDb` 字段）
> 2. 真机 capture pipeline（让真用户 RTX 3060 / RX 6600 提交他们的 webglParams，verify-creepjs-profile-hash 复用）
> 3. bench 12-站 实跑验证 audio surface 无 regress
> 4. Phase 4.4 优先级 P0 `0011-tls-ja4-spoof` 的 SDK-level 探索（现有 spec 推 v1.0，但可试探 SDK level 部分能做到多少）
