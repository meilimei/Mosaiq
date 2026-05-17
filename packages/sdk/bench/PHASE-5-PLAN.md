# Phase 5 — Audio dB closure + bench audio surface validation + real-hardware capture

> v0.4 收尾时记录的 v0.5 候选：
> 1. AnalyserNode dB-aware noise（独立 `audioNoiseAmplitudeDb` 字段）
> 2. 真机 capture pipeline（让真用户 RTX 3060 / RX 6600 提交他们的 webglParams，verify-creepjs-profile-hash 复用）
> 3. bench 12-站 实跑验证 audio surface 无 regress
> 4. Phase 4.4 优先级 P0 `0011-tls-ja4-spoof` 的 SDK-level 探索
>
> v0.5 范围：1 + 2 + 3。第 4 项推 v0.6（风险大、可能出负面结论，独立 spike 比掺在常规 minor release 里更合适）。

---

## 0. 背景：v0.4 surface 的限制

Phase 4.1 加 AudioBuffer.getChannelData hook 时，发现一个 v0.2 留下的 silently-broken hook：

```ts
// runner.ts §6
const amplitude = config.audioNoiseAmplitude;  // 1e-7

if (typeof AnalyserNode !== 'undefined') {
  AnalyserNode.prototype.getFloatFrequencyData = wrapStealth(origGetFloat, {
    apply(target, thisArg, args) {
      Reflect.apply(target, thisArg, args);
      const [array] = args;
      for (let i = 0; i < array.length; i++) {
        array[i] = (array[i] ?? 0) + (audioPrng() - 0.5) * amplitude;
        //       ↑ array 是 dB 标度 (-100..0)
        //         Float32 ULP @ -50 dB ≈ 3.8e-6
        //         amplitude=1e-7 < ULP → 噪声被完全 round 掉
        //         hook 装上但**无任何效果**
      }
    },
  });
}
```

**根因**：`audioNoiseAmplitude=1e-7` 是为 PCM 设计的（值域 -1..1，1e-7 远高于 16-bit ULP ≈ 3e-5 实际上低于但仍可见）。AnalyserNode 返回 dB 值（-100..0），ULP 高一万倍，1e-7 noise 直接被 Float32 量化清零。

PCM hook 没问题（`AudioBuffer.getChannelData` 用 `audioNoiseAmplitude=1e-7`，ULP 区域可见）。dB hook 这一条 v0.2 起就无效。

---

## 1. v0.5 sub-phase

### Phase 5.1 — AnalyserNode dB-aware noise（修 v0.2 漏洞）

**新字段**：`AudioFingerprint.noiseAmplitudeDb`（dB 标度，独立于 `noiseAmplitude`）

**默认值**：`0.001` dB
- ≈ 250× Float32 ULP @ -50 dB → 保证可见
- ≪ 1 dB（人耳 JND）→ 任何 audio 应用都无差异
- AnalyserNode 是分析用 API，不播放音频；即使更大也仅影响 hash，不影响听感

**字段范围**：`z.number().min(0).max(5).default(0.001)`

**实现**：

| 文件 | 修改 |
|---|---|
| `packages/persona-schema/src/fingerprint.ts` | `AudioFingerprintSchema` 加 `noiseAmplitudeDb` |
| `packages/persona-schema/src/templates/*.ts` (×4) | 4 templates 不需改（Zod default 自动填） |
| `packages/sdk/src/injection/types.ts` | `InjectionConfig` 加 `audioNoiseAmplitudeDb: number` |
| `packages/sdk/src/injection/build-config.ts` | `audioNoiseAmplitudeDb: persona.fingerprint.audio.noiseAmplitudeDb` |
| `packages/sdk/src/injection/runner.ts §6` | AnalyserNode hook 改用 `config.audioNoiseAmplitudeDb` |

**worker mirror?** 否 — dedicated worker 不暴露 `AnalyserNode`（AudioContext 类只在 main scope）。仅 `OfflineAudioContext` + `AudioBuffer` 走 worker，这条已 Phase 4.2 覆盖。

**测试**：

| 文件 | 加测 |
|---|---|
| `packages/persona-schema/src/persona.test.ts` | persona schema 有 `noiseAmplitudeDb` 字段 + default 0.001 + range 校验 |
| `packages/sdk/src/injection/build-config.test.ts` | `buildInjectionConfig` 传递新字段 |
| `packages/sdk/src/injection/runner-audio.test.ts` | 改：`getFloatFrequencyData` 后 arr[0] !== -100（noise 真的可见） + 确定性 + amplitude bound（×0.001 范围） |

**估时**：~1.5 h

---

### Phase 5.2 — bench 12-site audio surface validation

**目标**：v0.4 加了 audio hook 后没跑 12-站 bench。验证：
- audio hook 无 surface regression（baseline-detection.ts hits 仍 ≤ 2）
- creepjs.com `audio` 列从 lies/red 变 OK / hashMini 变化（确认 hook 真的生效）
- fingerprint.com 等其他 detector audio 维度无新错误

**步骤**：
1. `pnpm --filter @mosaiq/sdk run bench:baseline-detection`
2. 检查 12-site report，重点：creepjs / fingerprint-scan / browserleaks / fp.com
3. 比对 v0.3.0 baseline-snapshot.json（如果有）

**预期结果**：
- 总 hits ≤ 2（CreepJS WebGL bold-fail + browserleaks-canvas uniqueness 仍存在，by-design）
- 无新 hit

**风险**：worker IIFE audio mirror 的 blob 注入路径可能在某些 CSP 站点报错。已有 fallback 但未 12-站验证。

**估时**：1 h（含 bench 跑 + 写 BENCH-V0.5-RESULTS.md）

---

### Phase 5.3 — 真机 WebGL profile capture pipeline

**目标**：让真用户能在他们的 RTX 3060 / RX 6600 / 其他 GPU 上提交 webglParams，自动转成 Mosaiq profile。

**两端**：

#### 5.3a — capture 工具（浏览器端）

新文件：`packages/sdk/bench/capture-real-webgl-profile.html`
- 单文件 HTML，本地双击打开（无 server）
- 拉取 49 个 GL 参数（用现有 `creepjs-whitelist-data.ts` 的 `extractCreepjsWebglParams` 完整 list）
- 输出 JSON 到 textarea + `Copy` 按钮
- 不发任何网络请求（隐私优先）

#### 5.3b — convert 工具（CLI）

新文件：`packages/sdk/bench/convert-captured-profile.ts`
- 读取用户粘贴的 JSON
- 自动生成 `WebglProfile` 对象（与 `webgl-profiles.ts` `KNOWN_PROFILES` 同结构）
- 自动跑 `verifyProfile`（`verify-creepjs-profile-hash.ts` 的 export），告诉用户是否撞 CreepJS 白名单
- 输出可直接复制到 `webgl-profiles.ts` 的 TS 代码片段

**用户工作流**：
```
1. 在真机 Chrome 打开 capture-real-webgl-profile.html
2. 复制 JSON
3. node bench/convert-captured-profile.ts < paste.json
4. 检查 stdout：
   ✅ Hits CreepJS whitelist! brand=NVIDIA, capHash=...
   📋 Append to webgl-profiles.ts:
   export const NVIDIA_RTX_4090_D3D11: WebglProfile = { ... };
5. 复制粘贴 + 加测试
```

**输出**：用户能贡献 profile 让 KNOWN_PROFILES 增长，且自动验证 CreepJS 白名单命中。

**估时**：3 h

---

### Phase 5.4 — release v0.5.0

- 全量 typecheck + test 回归
- 3 个 atomic commit（5.1 / 5.2 / 5.3）+ 1 release commit
- CHANGELOG.md v0.5.0 段
- bump 3 包 version 到 0.5.0
- tag v0.5.0 + push

---

## 2. v0.5 验收

| 指标 | v0.4 end | v0.5 target |
|---|---|---|
| 12-站 bench OK | 12/12 (未实跑) | 12/12 实跑 |
| bench hits | 2 known-limits (未实跑) | 2 known-limits (实跑确认) |
| sdk vitest count | 316 | ≥ 320 |
| AnalyserNode dB noise 可见 | ❌ quantized | ✅ 0.001 dB 可见 |
| 真机 GPU profile 收集流程 | 无 | ✅ HTML capture + CLI convert |
| KNOWN_PROFILES 数 | 4 | 4（v0.5 不强求增）/ 用户提交后增 |

---

## 3. 风险

| 风险 | 缓解 |
|---|---|
| `noiseAmplitudeDb=0.001` 太小，某些 audio 应用过敏 | dB 域 0.001 远低于 audio app 阈值（典型 ≥1 dB），实测前几乎无风险 |
| Schema 加新字段破坏 v0.4 saved persona | Zod default 0.001 自动填充，向后兼容 |
| capture HTML 在不同 GPU/浏览器上 49 param 顺序不同 | 用 `extractCreepjsWebglParams` 的固定 key 顺序，hash 计算无歧义 |
| bench 跑出新 hit | 修 hit；如果是 by-design（如 audio detector 的 fingerprint per-persona uniqueness）则文档化 |

---

## 4. 总估时

5.1: 1.5 h + 5.2: 1 h + 5.3: 3 h + 5.4: 0.5 h ≈ **6 h**（1 focused session）
