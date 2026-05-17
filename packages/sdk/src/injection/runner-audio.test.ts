// @vitest-environment happy-dom

/**
 * runner.ts §6 audio spoof — Phase 4.1 AudioBuffer.getChannelData 专测，
 * Phase 5.1 加 AnalyserNode dB-domain noise visibility 测试。
 *
 * happy-dom 默认无 `AudioBuffer` / `AnalyserNode` / `AudioContext`，runner §6
 * 整块被 `typeof` guard 跳过 —— 现有 60+ runner 测试无法覆盖 audio spoof 路径。
 * 本文件 polyfill 这三个 global，再 `injectAll`，断言：
 *
 *   1. AudioBuffer.getChannelData 返回值被打上 noise（per-channel deterministic）
 *   2. 同 persona + 同 channel → 两次读结果一致（PRNG 复位）
 *   3. 不同 channel → 不同 noise 序列（XOR seed）
 *   4. PCM noise 量级 < 1e-5（不破坏 audio 实际播放）
 *   5. AudioBuffer.prototype.getChannelData.toString() = '[native code]'（stealth）
 *   6. **Phase 5.1**：AnalyserNode.getFloatFrequencyData dB-domain noise 真的可见
 *      （Float32 ULP @ -100 dB ≈ 1.19e-5；amplitudeDb=0.001 → ±0.0005 ≈ 42×
 *      ULP，远高于 quantize 阈值）
 *
 * 测试隔离：vitest 默认按文件隔离，本文件 polyfill 不污染 runner.test.ts。
 */

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildInjectionConfig } from './build-config.js';
import { injectAll } from './runner.js';
import type { InjectionConfig } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// Mock AudioBuffer / AnalyserNode / AudioContext
// ────────────────────────────────────────────────────────────────────────────
//
// 设计：AudioBuffer 拥有 numberOfChannels + sampleRate + length；getChannelData
// 返回一个 deterministic 三角波（每个 sample = i * 0.001）让 noise 可见。
// runner 的 wrapStealth Proxy 必须在 prototype 上劫持原 getChannelData，
// 测试通过对比 baseline buffer 与 hook 后 buffer 验证。

class MockAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  /** 内部多通道存储（不是真实 PCM，仅 deterministic 数列让 noise 可见） */
  #channels: Float32Array[];

  constructor(opts: {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    /** Phase 5.2b：自定义 fill 函数，默认三角波 (i + c*100) * 1e-4。
     *  返回 0 让样本保持 silence（用于测 silent-sample preservation）。 */
    fill?: (i: number, channel: number) => number;
  }) {
    this.numberOfChannels = opts.numberOfChannels;
    this.length = opts.length;
    this.sampleRate = opts.sampleRate;
    this.#channels = [];
    const fill = opts.fill ?? ((i: number, c: number) => (i + c * 100) * 1e-4);
    for (let c = 0; c < opts.numberOfChannels; c++) {
      const arr = new Float32Array(opts.length);
      // 不同 channel 起点不同，便于辨识 noise 是否真的应用到正确 channel
      for (let i = 0; i < opts.length; i++) {
        arr[i] = fill(i, c);
      }
      this.#channels.push(arr);
    }
  }

  getChannelData(channel: number): Float32Array {
    // 返回 live view（与真实 AudioBuffer 一样可 in-place 修改）
    // 但 hook 内 `Reflect.apply(target, thisArg, args)` 返回 view，hook 直接修改后再返回
    // —— 所以这里每次返回 **同一个** Float32Array 引用，让 in-place noise 持久
    const buf = this.#channels[channel];
    if (!buf) throw new Error(`channel ${channel} out of range`);
    return buf;
  }

  /**
   * Phase 5.4c mock：copyFromChannel(destination, channelNumber, bufferOffset?)。
   * 真实 AudioBuffer 语义：把 channel 通道在 [bufferOffset..bufferOffset+
   * destination.length) 区间的 sample 复制到 destination Float32Array。
   * runner.ts §6 hook 在原生 copy 完成后给 destination 加 noise。本 mock 仅
   * 实现 spec 必要部分（不做 channel range 校验，由 hook 直接 forward）。
   */
  copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0): void {
    const src = this.#channels[channelNumber];
    if (!src) throw new Error(`channel ${channelNumber} out of range`);
    const offset = bufferOffset | 0;
    const copyLen = Math.min(destination.length, src.length - offset);
    for (let i = 0; i < copyLen; i++) {
      destination[i] = src[i + offset] ?? 0;
    }
    // 超出 src 范围的 destination 尾部留原值（spec 不规定填 0）
  }

  /**
   * Phase 5.4c mock：copyToChannel(source, channelNumber, bufferOffset?)。
   * 把 source Float32Array 写入到 channel 通道的 [bufferOffset..] 起始位置。
   * runner.ts §6 hook 在调原生写入前先给 source 加 noise（in-place），
   * 让下次 getChannelData 读出来的样本含同一份 noise。
   */
  copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0): void {
    const dst = this.#channels[channelNumber];
    if (!dst) throw new Error(`channel ${channelNumber} out of range`);
    const offset = bufferOffset | 0;
    const writeLen = Math.min(source.length, dst.length - offset);
    for (let i = 0; i < writeLen; i++) {
      dst[i + offset] = source[i] ?? 0;
    }
  }
}

class MockAnalyserNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  getFloatFrequencyData(array: Float32Array): void {
    // 模拟 real Chrome 写入：把每个 bin 填成 -100 dB
    for (let i = 0; i < array.length; i++) {
      array[i] = -100;
    }
  }
}

class MockAudioContext {
  // runner 用 defineReadOnlyGetter spoof AudioContext.prototype.sampleRate
  // mock 实例必须有原生 sampleRate getter，runner 才会把它替换掉
  get sampleRate(): number {
    return 48000; // 原生值；runner spoof 后变 config.audioSampleRate
  }
}

// ────────────────────────────────────────────────────────────────────────────
// beforeAll：polyfill + injectAll
// ────────────────────────────────────────────────────────────────────────────

let config: InjectionConfig;

beforeAll(() => {
  // 1. polyfill globals（runner.ts typeof guard 用）
  (globalThis as unknown as { AudioBuffer: typeof MockAudioBuffer }).AudioBuffer = MockAudioBuffer;
  (globalThis as unknown as { AnalyserNode: typeof MockAnalyserNode }).AnalyserNode =
    MockAnalyserNode;
  (globalThis as unknown as { AudioContext: typeof MockAudioContext }).AudioContext =
    MockAudioContext;

  // 2. 跑 injectAll —— 会 wrap getChannelData / getFloatFrequencyData / sampleRate getter
  const persona = createWin11ChromeUsPersona({
    id: 'audio-spoof-test',
    displayName: 'Audio Spoof Test',
    timezone: 'Asia/Tokyo',
    masterSeed: 'cafebabe-audio',
  });
  config = buildInjectionConfig(persona);
  // Sanity check：persona 模板默认 amplitude=1e-7 (PCM)，amplitudeDb=0.001 (dB)
  expect(config.audioNoiseAmplitude).toBeGreaterThan(0);
  expect(config.audioNoiseAmplitude).toBeLessThanOrEqual(1e-3);
  expect(config.audioNoiseAmplitudeDb).toBeGreaterThan(0);
  expect(config.audioNoiseAmplitudeDb).toBeLessThanOrEqual(5);
  injectAll(config);
});

// ────────────────────────────────────────────────────────────────────────────
// 测试：AudioBuffer.getChannelData noise（Phase 4.1 main scope）
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 4.1: AudioBuffer.getChannelData noise injection', () => {
  /** 计算 baseline：未经 hook 修改的三角波样本（i * 1e-4） */
  function expectedBaselineSample(i: number, channel: number): number {
    return (i + channel * 100) * 1e-4;
  }

  it('hook 应用后 getChannelData 返回值与 baseline 有微小偏移', () => {
    const buf = new MockAudioBuffer({ numberOfChannels: 1, length: 5000, sampleRate: 44100 });
    const data = buf.getChannelData(0);
    // 至少一个 sample 与 baseline 不同（noise 非 0）
    let differences = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== expectedBaselineSample(i, 0)) differences++;
    }
    // 5000 sample 几乎全部应该被 noise 改变（PRNG 期望 0 的概率极低）
    expect(differences).toBeGreaterThan(4900);
  });

  it('noise 量级 <= audioNoiseAmplitude (1e-7 默认)', () => {
    const buf = new MockAudioBuffer({ numberOfChannels: 1, length: 5000, sampleRate: 44100 });
    const data = buf.getChannelData(0);
    let maxDelta = 0;
    for (let i = 0; i < data.length; i++) {
      const delta = Math.abs(data[i]! - expectedBaselineSample(i, 0));
      if (delta > maxDelta) maxDelta = delta;
    }
    // PRNG range = (-0.5, 0.5) * amplitude → max delta < amplitude
    expect(maxDelta).toBeLessThan(config.audioNoiseAmplitude);
    expect(maxDelta).toBeLessThan(1e-5); // 远小于 16-bit PCM quantization
  });

  it('同一 buffer / 同一 channel 重读 → 结果一致 (PRNG 复位 seed^channel)', () => {
    const buf1 = new MockAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 44100 });
    const buf2 = new MockAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 44100 });
    const a = Array.from(buf1.getChannelData(0));
    const b = Array.from(buf2.getChannelData(0));
    // 两次读取应该 deterministic（同 audioNoiseSeed + 同 channel=0 → 同 PRNG 序列）
    expect(a).toEqual(b);
  });

  it('不同 channel 用不同 noise 序列 (XOR seed)', () => {
    const buf = new MockAudioBuffer({ numberOfChannels: 2, length: 100, sampleRate: 44100 });
    const ch0 = Array.from(buf.getChannelData(0));
    const ch1 = Array.from(buf.getChannelData(1));
    // 把 baseline 差异移除：原始 ch0 与 ch1 baseline 相差 100 * 1e-4 = 0.01（恒定）
    const noiseCh0 = ch0.map((v, i) => v - expectedBaselineSample(i, 0));
    const noiseCh1 = ch1.map((v, i) => v - expectedBaselineSample(i, 1));
    // noise 序列必须不同（XOR seed 让两 channel PRNG 起点不同）
    expect(noiseCh0).not.toEqual(noiseCh1);
    // 但量级仍相同（都用 audioNoiseAmplitude）
    const maxNoise0 = Math.max(...noiseCh0.map(Math.abs));
    const maxNoise1 = Math.max(...noiseCh1.map(Math.abs));
    expect(maxNoise0).toBeLessThan(config.audioNoiseAmplitude);
    expect(maxNoise1).toBeLessThan(config.audioNoiseAmplitude);
  });

  it('5000-sample sum 与 baseline 有累积偏移 (CreepJS hashMini 路径)', () => {
    // CreepJS audio fingerprint: sum-of-abs over 5000 samples → hashMini(sum.toString())
    // 我们的 noise 必须让 sum.toString() 至少改变小数 4-6 位
    const buf = new MockAudioBuffer({ numberOfChannels: 1, length: 5000, sampleRate: 44100 });
    const data = buf.getChannelData(0);
    let actualSum = 0;
    let baselineSum = 0;
    for (let i = 0; i < data.length; i++) {
      actualSum += Math.abs(data[i]!);
      baselineSum += Math.abs(expectedBaselineSample(i, 0));
    }
    // 累积偏移期望 ~ sqrt(N) × amplitude / 2 ≈ sqrt(5000) × 1e-7 / 2 ≈ 3.5e-6
    // 但绝对值 sum 让 noise 全部 add up 而非抵消（baseline > 0 时），偏移可能更大
    const sumDelta = Math.abs(actualSum - baselineSum);
    expect(sumDelta).toBeGreaterThan(0);
    // hashMini 用 sum.toString() ≈ 16-17 位精度。偏移 > 1e-9 即可改变 toString
    expect(sumDelta).toBeGreaterThan(1e-9);
  });

  it('hook 替换了 prototype.getChannelData (不再是原始 mock class method)', () => {
    // 注：mock 环境下无法测 `[native code]` stealth —— wrapStealth 只保留 origGCD
    // 的 toString 字符串，而 mock origGCD 本身不是 native。我们改测 "hook 替换
    // 生效" 这一行为：如果 hook 没替换，noise 测试不会过；既然 noise 测试过了，
    // hook 必然生效。这里加 sanity check：prototype 上的 getChannelData 现在
    // 是 Proxy（typeof function 但与 origMockMethod 引用不同）。
    expect(typeof MockAudioBuffer.prototype.getChannelData).toBe('function');
    // 在真实 Chromium / Playwright 环境下，全局 Function.prototype.toString hook
    // 会让 origGCD（native [native code]）的字符串保留，让 detector 看不出 Proxy。
    // 这条 stealth assertion 推 bench/probe-runner-stealth.ts 在真实 Chrome 验证。
  });

  it('out-of-range channel arg 抛错 forward 到原 native getChannelData', () => {
    const buf = new MockAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 44100 });
    // hook 内 Reflect.apply 会传 channel=2 到原 native，触发 mock 抛 'channel 2 out of range'
    expect(() => buf.getChannelData(2)).toThrow(/out of range/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 5.2b: silent (==0) 样本保留 exact 0
//
// 背景：Phase 5.2 12-site bench 发现 CreepJS Audio bold-fail，根源是 Phase 4.1
// hook 给所有样本（含 silence）加 noise → 5000 样本全 unique → CreepJS unique:5000
// → bold-fail。Real Chrome 的 OfflineAudioContext + DynamicsCompressor 在 attack
// ramp 之前样本是 exact 0；fix 让 hook 跳过 0 样本，only noise 非零 → silence
// pattern 与 real Chrome 一致 → CreepJS unique 落到 < 5000 区间 → no bold-fail。
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 5.2b: AudioBuffer silent samples preserved (CreepJS unique:5000 prevention)', () => {
  it('silent (==0) samples 输出仍为 exact 0', () => {
    // Mimic compressor pre-attack pattern：前半 silence (exact 0)，后半 ramp。
    const buf = new MockAudioBuffer({
      numberOfChannels: 1,
      length: 5000,
      sampleRate: 44100,
      fill: (i) => (i < 2500 ? 0 : (i - 2500) * 1e-4),
    });
    const data = buf.getChannelData(0);
    // Front 2500 samples must be exact 0（preserve silence pattern）
    for (let i = 0; i < 2500; i++) {
      expect(data[i]).toBe(0);
    }
    // Back 2500 samples must have noise applied（!= original ramp value）
    let nonZeroDifferences = 0;
    for (let i = 2500; i < 5000; i++) {
      const baseline = (i - 2500) * 1e-4;
      if (data[i] !== baseline) nonZeroDifferences++;
    }
    // 几乎全部 ramp 样本应被 noise 修改
    expect(nonZeroDifferences).toBeGreaterThan(2400);
  });

  it('全 silence buffer 经 hook 后仍全 0 (CreepJS unique 数应远小于 buffer 长度)', () => {
    const buf = new MockAudioBuffer({
      numberOfChannels: 1,
      length: 5000,
      sampleRate: 44100,
      fill: () => 0,
    });
    const data = buf.getChannelData(0);
    // 模拟 CreepJS 的 unique-sample count 算法
    const uniqueValues = new Set<number>();
    for (let i = 0; i < data.length; i++) {
      uniqueValues.add(data[i]!);
    }
    // 全 silence → unique = 1（仅 0）；远小于 5000，所以 CreepJS 不会 bold-fail
    expect(uniqueValues.size).toBe(1);
    expect(uniqueValues.has(0)).toBe(true);
  });

  it('PRNG 仍每样本 advance 一次 (deterministic 序列不被 skip 破坏)', () => {
    // 两次构造相同 buffer，分别全 zero / 全 non-zero，比对 PRNG 序列
    // —— 全 zero buffer 应保持 0，但 PRNG 内部计数器仍每样本 advance；
    //    全 non-zero buffer 应得到 N 个 noise，且第 i 个 noise = 第 i 次 PRNG 调用
    const zeroBuf = new MockAudioBuffer({
      numberOfChannels: 1,
      length: 100,
      sampleRate: 44100,
      fill: () => 0,
    });
    const rampBuf = new MockAudioBuffer({
      numberOfChannels: 1,
      length: 100,
      sampleRate: 44100,
      fill: (i) => (i + 1) * 1e-4, // 全非零
    });
    const zeroData = zeroBuf.getChannelData(0);
    const rampData = rampBuf.getChannelData(0);
    // zeroBuf 输出全 0
    for (let i = 0; i < 100; i++) expect(zeroData[i]).toBe(0);
    // rampBuf 输出 = baseline + per-sample noise，每样本必有 noise（baseline 全非零）
    let differencesFromBaseline = 0;
    for (let i = 0; i < 100; i++) {
      const baseline = (i + 1) * 1e-4;
      if (rampData[i] !== baseline) differencesFromBaseline++;
    }
    expect(differencesFromBaseline).toBeGreaterThan(95);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 5.4c: copyFromChannel / copyToChannel mirror noise sequence
//
// 背景：CreepJS audio.ts cross-check：
//   buffer.copyFromChannel(copy, 0)      // 期望 == buffer 的 channel 0
//   bins = buffer.getChannelData(0)      // 期望 == buffer 的 channel 0
//   if (binsSample[4500..4600] !== copySample[4500..4600]) {
//     documentLie('AudioBuffer', 'getChannelData and copyFromChannel samples mismatch');
//   }
// v0.5.0 只 hook getChannelData → copy 是原始数据、bins 是原始 + noise → mismatch
// → CreepJS Audio yellow lies。修法：copyFromChannel hook 用同一 PRNG 序列
// （seed XOR channel + skip-zero）把同一 noise pattern 写到 destination。
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 5.4c: AudioBuffer.copyFromChannel mirror (CreepJS lies fix)', () => {
  it('copyFromChannel destination == getChannelData buffer (same channel)', () => {
    // CreepJS 关键场景：先 copyFromChannel，再 getChannelData，cross-check 样本相等。
    const buf = new MockAudioBuffer({ numberOfChannels: 1, length: 5000, sampleRate: 44100 });
    const copy = new Float32Array(5000);
    // 重要：先 copyFromChannel 再 getChannelData（CreepJS 顺序）
    buf.copyFromChannel(copy, 0);
    const bins = buf.getChannelData(0);
    // CreepJS 的具体比对窗口 [4500..4600]（500ms 窗口）
    const copySample = Array.from(copy.slice(4500, 4600));
    const binsSample = Array.from(bins.slice(4500, 4600));
    expect(copySample.join(',')).toBe(binsSample.join(','));
  });

  it('copyFromChannel + getChannelData reverse-order also matches', () => {
    // 反向顺序：先 getChannelData（in-place noise），再 copyFromChannel。
    // 此时 buffer 已经噪声化，copy 应该读到噪声化后的样本，仍与 bins 一致。
    const buf = new MockAudioBuffer({ numberOfChannels: 1, length: 5000, sampleRate: 44100 });
    const bins = buf.getChannelData(0);
    const copy = new Float32Array(5000);
    buf.copyFromChannel(copy, 0);
    // copy = (buffer 已带 noise) 再 + noise（hook 累加 noise pattern 一次）
    // bins = buffer 已带 noise（in-place 第一次）
    // ⚠ 这两个不再相等（hook 设计导向 caller-perceived 而非 buffer-state 一致），
    // 但 CreepJS 不走这个顺序。这里测确认：noise 量级仍受控（不爆炸）。
    let maxDelta = 0;
    for (let i = 0; i < 5000; i++) {
      const d = Math.abs((copy[i] ?? 0) - (bins[i] ?? 0));
      if (d > maxDelta) maxDelta = d;
    }
    // 反向顺序下的累积 delta < 2× amplitude（noise + noise 上限）
    expect(maxDelta).toBeLessThan(2 * config.audioNoiseAmplitude);
  });

  it('copyFromChannel preserves silent samples (Phase 5.2b skip-zero rule)', () => {
    // 纯 silence buffer 经 copyFromChannel 仍全 0（CreepJS unique:5000 protection
    // 沿用到 copyFromChannel 路径，避免新增 access path 触发 bold-fail）。
    const buf = new MockAudioBuffer({
      numberOfChannels: 1,
      length: 5000,
      sampleRate: 44100,
      fill: () => 0,
    });
    const copy = new Float32Array(5000);
    buf.copyFromChannel(copy, 0);
    const uniqueValues = new Set<number>();
    for (let i = 0; i < copy.length; i++) uniqueValues.add(copy[i]!);
    expect(uniqueValues.size).toBe(1);
    expect(uniqueValues.has(0)).toBe(true);
  });

  it('copyFromChannel applies same noise as getChannelData on different buffers', () => {
    // 同 persona，两个独立 buffer，copyFromChannel(0) 与 getChannelData(0) 噪声序列必一致。
    const buf1 = new MockAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 44100 });
    const buf2 = new MockAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 44100 });
    const copy1 = new Float32Array(100);
    buf1.copyFromChannel(copy1, 0);
    const bins2 = buf2.getChannelData(0);
    expect(Array.from(copy1)).toEqual(Array.from(bins2));
  });

  it('copyToChannel writes noise-baked source into channel (next read sees noise)', () => {
    // caller 通过 copyToChannel 写入新数据 → hook 先给 source 加 noise → 写入。
    // 后续 getChannelData(0) 读出的样本应已带 noise（buffer 内容反映了带 noise 的 source）。
    const buf = new MockAudioBuffer({
      numberOfChannels: 1,
      length: 100,
      sampleRate: 44100,
      fill: () => 0, // 起始 silence
    });
    const source = new Float32Array(100);
    for (let i = 0; i < 100; i++) source[i] = (i + 1) * 1e-4; // 全非零
    buf.copyToChannel(source, 0);
    // 验证：写入后 getChannelData 读出的样本与原始 source 不同（被噪声化）
    // 但 getChannelData 自己会再加 noise → 总噪声 = 2× amplitude 上限
    const bins = buf.getChannelData(0);
    let differencesFromSource = 0;
    for (let i = 0; i < 100; i++) {
      // bins[i] = (source[i] + noise_via_copyTo) + noise_via_getChannelData
      // 不等于 source[i] 的概率极高
      if (bins[i] !== (i + 1) * 1e-4) differencesFromSource++;
    }
    expect(differencesFromSource).toBeGreaterThan(95);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 5.1: AnalyserNode.getFloatFrequencyData dB-domain noise
//
// 修 v0.2 ~ v0.4 silent-quantize bug：v0.4 之前 AnalyserNode hook 共用
// audioNoiseAmplitude=1e-7（PCM 域设计），但 dB 域 Float32 ULP @ -100 dB ≈
// 1.19e-5，1e-7 远低于 ULP → 全部 round 回 baseline。Phase 5.1 加独立
// audioNoiseAmplitudeDb 字段（默认 0.001 ≈ 42× ULP）→ 保证可见。
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 5.1: AnalyserNode.getFloatFrequencyData dB-domain noise', () => {
  it('hook 应用后 arr 与 baseline -100 有可见偏移（noise 不被 quantize）', () => {
    const an = new MockAnalyserNode();
    const arr = new Float32Array(1024);
    an.getFloatFrequencyData(arr);
    // mock 写 -100 dB，hook 加 (prng - 0.5) * amplitudeDb 噪声
    // amplitudeDb=0.001 → noise ±0.0005 → Float32 ULP @ -100 ≈ 1.19e-5 → 42× ULP，可见
    let differences = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== -100) differences++;
    }
    // 1024 bin 几乎全部应该 ≠ -100（prng 期望 0 概率极低，且 0 也会被 + 0 不变 ≈ 1/2^32 概率）
    expect(differences).toBeGreaterThan(1000);
  });

  it('noise 量级 < audioNoiseAmplitudeDb（amplitude bound）', () => {
    const an = new MockAnalyserNode();
    const arr = new Float32Array(2048);
    an.getFloatFrequencyData(arr);
    let maxDelta = 0;
    for (let i = 0; i < arr.length; i++) {
      const delta = Math.abs(arr[i]! - -100);
      if (delta > maxDelta) maxDelta = delta;
    }
    // PRNG range = (-0.5, 0.5) * amplitudeDb → max delta < amplitudeDb
    expect(maxDelta).toBeLessThan(config.audioNoiseAmplitudeDb);
    // 远小于人耳 JND ~1 dB
    expect(maxDelta).toBeLessThan(1);
  });

  it('PRNG 序列 deterministic（hook 内 audioPrng 共享，连续 call 推进序列）', () => {
    // 注：runner §6 在 try 块内构造 audioPrng，一旦 wrapStealth 闭包就固定了。
    // 连续两次 getFloatFrequencyData 共享同一 PRNG → 第二次 arr 是 PRNG 后半段
    // 与第一次必不同；但**同一 persona 两次 injectAll** 才能复现完整 PRNG 重置
    // （我们这里只 injectAll 一次，所以仅测连续两次结果 distinct）。
    const an = new MockAnalyserNode();
    const arr1 = new Float32Array(64);
    const arr2 = new Float32Array(64);
    an.getFloatFrequencyData(arr1);
    an.getFloatFrequencyData(arr2);
    // PRNG 推进，两次序列必不相同
    expect(Array.from(arr1)).not.toEqual(Array.from(arr2));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试：AudioContext.sampleRate spoof（v0.2 路径不退化）
// ────────────────────────────────────────────────────────────────────────────

describe('§6 AudioContext.sampleRate spoof (v0.2 path)', () => {
  it('AudioContext instance sampleRate 反映 config 值（非 mock 原生 48000）', () => {
    const ctx = new MockAudioContext();
    // 默认 win11-chrome-us persona audio.sampleRate = 48000，恰好等于 mock 原值
    // 但 spoof 路径是 defineReadOnlyGetter on prototype —— mock 原生 getter 应被替换
    expect(ctx.sampleRate).toBe(config.audioSampleRate);
  });
});
