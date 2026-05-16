# Patch 0017 — Audio Fingerprint Noise (native)

**Phase**: A.7+（v1.0 解冻后） **优先级**: P3 **难度**: ⭐⭐ **预期工时**: 1-2 周

## 目标

在 Blink AudioBuffer C++ 层注入 per-persona deterministic noise，**取代 SDK 注入版**（`packages/sdk/src/injection/runner.ts` §6 + Phase 4.2 worker mirror）。

## 为什么需要 native patch？

### SDK 注入版的局限

1. **JS Proxy detection 风险**：
   - SDK 注入版用 `wrapStealth(AudioBuffer.prototype.getChannelData)` 装 Proxy
   - 同 patch 0002 WebGL 部分，Proxy 在 `Function.prototype.toString` reverse / cross-realm 比较 / perf timing diff 等深度反检测下仍有暴露面
   - Enterprise detector（如 Imperva ABP）已开始用 cross-realm prototype 对比检测

2. **Worker scope 重复实施**：Phase 4.2 worker IIFE 复刻一次 `_origGCD` / `_mkAudioPrng`，每个 Worker 构造都付出 spawn cost。Native patch 一次实施覆盖所有 realm。

3. **OfflineAudioContext 渲染时机**：SDK hook 在 `getChannelData` 调用时加 noise，detector 可在 `startRendering().then` 之后立即 capture buffer 引用，之后多次读 channel data 比对（如果 PRNG 不复位会暴露）。Native patch 在渲染完成时一次性写入 noise，**永久持久化在 buffer**，多次读返回同一组 noise，无 timing 暴露。

### Native patch 优势

- **零 Proxy overhead** + 无 toString reverse 风险
- **覆盖 OfflineAudioContext / AudioContext / decodeAudioData 全部 AudioBuffer 来源**
- **跨 realm / cross-origin iframe 自动 mirror**
- **持久化 noise 写入 buffer**：buffer 数据一次性 noise，后续读多次返回相同结果，匹配真实硬件 behavior

---

## 触点文件（待 v1.0 时确认精确行号）

```
third_party/blink/renderer/modules/webaudio/
├── audio_buffer.cc                       # AudioBuffer::getChannelData / createBuffer
├── audio_buffer.h
├── offline_audio_context.cc              # OfflineAudioContext::startRendering
└── analyser_node.cc                      # AnalyserNode::GetFloatFrequencyData

third_party/blink/renderer/platform/audio/
└── audio_array.h                         # AudioFloatArray internals

chrome/browser/mosaiq/
├── persona_service.cc                    # 已含 audio_noise_seed / audio_noise_amplitude
└── renderer_persona_cache.cc             # Renderer 端拿到 persona audio params
```

## 方案设计

### 阶段 1：扩展 PersonaProfile mojom（patch 0014 依赖）

```
// chrome/browser/mosaiq/persona_provider.mojom
struct PersonaProfile {
  // ... 已有字段 ...
  uint32 audio_noise_seed;          // mulberry32 seed
  double audio_noise_amplitude;     // 默认 1e-7（与 SDK persona-schema 同）
};
```

### 阶段 2：在 AudioBuffer::CreateBuffer 时立即注入 noise

```cpp
// third_party/blink/renderer/modules/webaudio/audio_buffer.cc
AudioBuffer* AudioBuffer::Create(unsigned num_channels,
                                  uint32_t length,
                                  float sample_rate,
                                  ExceptionState& exception_state) {
  auto* buffer = MakeGarbageCollected<AudioBuffer>(
      num_channels, length, sample_rate);

  // ── Mosaiq: 创建时一次性 noise 写入 ──
  if (auto* cache = mosaiq::RendererPersonaCache::Get()) {
    for (unsigned ch = 0; ch < num_channels; ++ch) {
      auto* channel_array = buffer->channels_[ch].get();
      InjectMulberry32Noise(channel_array->Data(),
                            channel_array->size(),
                            cache->audio_noise_seed() ^ ch,
                            cache->audio_noise_amplitude());
    }
  }
  return buffer;
}

// 也在 decodeAudioData / OfflineAudioContext::startRendering 完成后 hook
```

`InjectMulberry32Noise` 复刻 SDK `runner.ts` 的 mulberry32 算法（保持跨 SDK / native 一致）：

```cpp
// third_party/blink/renderer/platform/audio/mosaiq_noise.cc
void InjectMulberry32Noise(float* data, size_t length,
                           uint32_t seed, double amplitude) {
  uint32_t a = seed;
  for (size_t i = 0; i < length; ++i) {
    a = a + 0x6d2b79f5;
    uint32_t t = a;
    t = (t ^ (t >> 15)) * (t | 1);
    t ^= t + ((t ^ (t >> 7)) * (t | 61));
    double r = static_cast<double>((t ^ (t >> 14)) >> 0) / 4294967296.0;
    data[i] = data[i] + (r - 0.5) * amplitude;
  }
}
```

### 阶段 3：OfflineAudioContext.startRendering 完成时 hook

```cpp
// third_party/blink/renderer/modules/webaudio/offline_audio_context.cc
void OfflineAudioContext::FireCompletionEvent() {
  AudioBuffer* rendered_buffer = render_target_;
  // ── Mosaiq: 渲染完成时对结果加 noise（双保险，AudioBuffer::Create 已加 noise，
  // 但 OAC 内部用 `audio_buffer_->channels_[ch]->ZeroRange` reset 过，
  // 渲染结果是干净的，所以再加一遍）──
  if (auto* cache = mosaiq::RendererPersonaCache::Get()) {
    for (unsigned ch = 0; ch < rendered_buffer->numberOfChannels(); ++ch) {
      auto* channel_array = rendered_buffer->channels_[ch].get();
      InjectMulberry32Noise(channel_array->Data(), channel_array->size(),
                            cache->audio_noise_seed() ^ ch,
                            cache->audio_noise_amplitude());
    }
  }
  // ── 原有 dispatch event ──
  DispatchEvent(*OfflineAudioCompletionEvent::Create(rendered_buffer));
}
```

### 阶段 4：AnalyserNode.getFloatFrequencyData native noise

修复 SDK 注入版的 known limitation（amplitude=1e-7 在 dB 量级被 Float32 ULP quantize 吃掉）：

```cpp
// third_party/blink/renderer/modules/webaudio/analyser_node.cc
void AnalyserNode::getFloatFrequencyData(NotShared<DOMFloat32Array> array,
                                          ExceptionState& exception_state) {
  // ── 原有数据写入 ──
  analyser_.GetFloatFrequencyData(array->Data(), array->length());

  // ── Mosaiq: dB-aware noise（数量级独立于 PCM noise）──
  if (auto* cache = mosaiq::RendererPersonaCache::Get()) {
    double db_amplitude = cache->audio_noise_amplitude() * 1e7;
    // 1e-7 * 1e7 = 1.0 dB unit；但实际取一个 sensible default 0.01 dB
    db_amplitude = std::min(db_amplitude, 0.01);
    InjectMulberry32NoiseDb(array->Data(), array->length(),
                            cache->audio_noise_seed(),
                            db_amplitude);
  }
}
```

## 单元测试

- `third_party/blink/renderer/modules/webaudio/audio_buffer_test.cc` 加：
  - PersonaService active + seed=1234 → CreateBuffer + getChannelData 数据 != 0
  - 同 seed 两次 CreateBuffer → 结果一致（deterministic）
  - 不同 channel → 不同 noise 序列（XOR seed）
- Integration test：
  - launch chrome --mosaiq-persona-id=foo
  - DevTools `new OfflineAudioContext(1, 5000, 44100).startRendering().then(b => b.getChannelData(0))` 数据有 noise

## Done condition

```bash
./out/Default/chrome --mosaiq-persona-id=test-001 --no-sandbox

# DevTools console (CreepJS / fp.com 经典 audio fingerprint)：
> const ctx = new OfflineAudioContext(1, 5000, 44100);
> const osc = ctx.createOscillator();
> osc.type = 'triangle';
> osc.frequency.setValueAtTime(10000, ctx.currentTime);
> const cmp = ctx.createDynamicsCompressor();
> osc.connect(cmp); cmp.connect(ctx.destination);
> osc.start();
> const buf = await ctx.startRendering();
> let sum = 0;
> for (let i = 0; i < buf.length; i++) sum += Math.abs(buf.getChannelData(0)[i]);
> sum

# 期望：sum 与 vanilla chrome / 其他 persona 不同（per-persona unique）
# 期望：连续两次跑相同 persona id 得相同 sum（deterministic）

# 关键：toString reverse 不出端倪
> AudioBuffer.prototype.getChannelData.toString()
< "function getChannelData() { [native code] }"  // 原 native，没有任何 Proxy 痕迹
```

## 与 SDK 注入版的关系

SDK 注入版 (`runner.ts` §6 + Phase 4.2 worker IIFE) 保留作为免 fork 用户兜底。Native
版启动时 PersonaService.audio_noise_amplitude_ 设为 0 → SDK 注入版的 hook 仍生效但
noise=0（实际无 noise）；同时 native 端独立加 noise。**两边互斥 OR 叠加，由 launcher
统一控制**：

- chromium-fork build → 启用 native + 关闭 SDK 注入 audio
- vanilla playwright-core → 关闭 native（无 PersonaService）+ 保留 SDK 注入 audio

通过 launch flag `--mosaiq-disable-sdk-audio-noise` 让 desktop app launcher 控制。

## 增量 build 时间预估

- `audio_buffer.cc` 改动：5-10 min（modules/webaudio 较小）
- 新建 `mosaiq_noise.{h,cc}` 在 `platform/audio/`：15-25 min（platform 重链）
- `offline_audio_context.cc` + `analyser_node.cc` 改动：5-15 min

## 风险点

1. **AudioBuffer noise 累积破坏 streaming audio**：实时 AudioContext 多次 fill buffer，每次 noise 叠加可能让长 stream 振幅漂移。**修法**：seed 与 buffer 创建时间戳混入，而非全 seed。但这破坏 per-persona deterministic。**最终选择**：noise amp 量级 1e-7 远小于 16-bit PCM ULP，长 stream 也几乎无累积可闻效应。
2. **AudioWorklet / ScriptProcessorNode**：用户提供的自定义 audio processor 在 worklet realm 内，patch 不直接覆盖。但他们自己读 channel data 也不会被检测当 fingerprint 路径（fingerprinter 总用 standard `startRendering().then(buf.getChannelData)`）。
3. **AudioBuffer 重复 noise**：如果同一 buffer instance 被 OAC 渲染后再传给 createBuffer 加 noise，可能 double-add。**修法**：用 buffer GC marker (`audio_noise_applied_` 字段)，每个 buffer 最多 1 次。

## 参考

- `packages/sdk/src/injection/runner.ts:983-1024` SDK §6 main scope audio hook
- `packages/sdk/src/injection/runner.ts:1559-1579` SDK Phase 4.2 worker audio mirror
- `packages/sdk/src/injection/runner-audio.test.ts` SDK audio noise 测试模板
- `chromium-fork/STATUS.md` §3.1 解冻条件
- Blink WebAudio source: `third_party/blink/renderer/modules/webaudio/`
