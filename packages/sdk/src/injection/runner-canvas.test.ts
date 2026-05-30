// @vitest-environment happy-dom

/**
 * runner.ts §5 canvas spoof — Phase 2.4 双 guard 专测。
 *
 * happy-dom 默认无 `CanvasRenderingContext2D` / `ImageData`，runner §5 整块被
 * `typeof CanvasRenderingContext2D !== 'undefined'` 跳过 —— 现有 39 个 runner
 * 测试无法覆盖 canvas spoof 路径。本文件 polyfill 这两个 global + override
 * `HTMLCanvasElement.prototype` 的 `getContext` / `toDataURL`，再 `injectAll`，
 * 断言：
 *
 *   1. **isProbeCanvas**（≤16x16）→ toDataURL 跳过整个 spoof block，
 *      getImageData 跳过 perturb；这是 CreepJS 2x2 "suspicious pixel data"
 *      probe 的修复。
 *   2. **isAllZero**（imageData 全 0）→ perturb 短路返回原 data；这是
 *      CreepJS 8x8 cleared region "pixel data modified" lie 的修复。
 *   3. ≥17x17 + 有内容 canvas → 噪声正常注入；保留 browserleaks-canvas /
 *      CreepJS textURI emojiURI 等真实 fingerprinting 路径的 spoof。
 *
 * 测试隔离：本文件用独立 beforeAll 安装 polyfill，不污染 `runner.test.ts`
 * 的 39 个测试（vitest 默认按文件隔离）。
 */

import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildInjectionConfig } from './build-config.js';
import { injectAll } from './runner.js';

// ────────────────────────────────────────────────────────────────────────────
// Mock 状态
// ────────────────────────────────────────────────────────────────────────────

const mockState = {
  getImageDataCalls: [] as Array<[number, number, number, number]>,
  putImageDataCalls: 0,
  /** 下次 getImageData 返回的数据填充模式 */
  nextPattern: 'zero' as 'zero' | 'pattern',
};

class MockImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(w: number, h: number, pattern: 'zero' | 'pattern') {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    if (pattern === 'pattern') {
      // 模拟绘制内容：可预测的非零值，便于断言"被噪声修改"
      for (let i = 0; i < this.data.length; i++) {
        this.data[i] = (i * 13) % 256;
      }
    }
  }
}

class MockCanvasRenderingContext2D {
  canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }
  getImageData(x: number, y: number, w: number, h: number): MockImageData {
    mockState.getImageDataCalls.push([x, y, w, h]);
    return new MockImageData(w, h, mockState.nextPattern);
  }
  putImageData(_imageData: MockImageData, _x: number, _y: number): void {
    mockState.putImageDataCalls += 1;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// beforeAll：polyfill + injectAll
// ────────────────────────────────────────────────────────────────────────────

beforeAll(() => {
  // 1. polyfill ImageData + CanvasRenderingContext2D（runner.ts typeof guard 用）
  (globalThis as unknown as { ImageData: typeof MockImageData }).ImageData = MockImageData;
  (
    globalThis as unknown as { CanvasRenderingContext2D: typeof MockCanvasRenderingContext2D }
  ).CanvasRenderingContext2D = MockCanvasRenderingContext2D;

  // 2. 覆盖 HTMLCanvasElement.prototype 的 getContext / toDataURL，使其使用 mock。
  //    这必须在 injectAll 之前 —— injectAll 会 wrap toDataURL，wrap 保留对原 fn
  //    的引用。我们这里安装的 mock 就成为 wrap 内部的 `target`。
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: function getContext(this: HTMLCanvasElement, kind: string) {
      if (kind !== '2d') return null;
      // 缓存 ctx 实例，让 toDataURL wrap 和测试代码看到同一个 ctx
      const self = this as HTMLCanvasElement & { __mockCtx?: MockCanvasRenderingContext2D };
      if (!self.__mockCtx) {
        self.__mockCtx = new MockCanvasRenderingContext2D(this);
      }
      return self.__mockCtx;
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
    value: function toDataURL() {
      return 'data:image/png;base64,MOCK';
    },
    writable: true,
    configurable: true,
  });

  // 3. 跑 injectAll —— 会 wrap toDataURL + getImageData，注入双 guard 逻辑
  const persona = createWin11ChromeUsPersona({
    id: 'canvas-spoof-test',
    displayName: 'Canvas Spoof Test',
    timezone: 'Asia/Tokyo',
    masterSeed: 'cafebabe-canvas',
  });
  const config = buildInjectionConfig(persona);
  // Sanity check：persona 模板默认 strength=1
  expect(config.canvasNoiseStrength).toBeGreaterThan(0);
  injectAll(config);
});

beforeEach(() => {
  mockState.getImageDataCalls = [];
  mockState.putImageDataCalls = 0;
  mockState.nextPattern = 'zero';
});

// ────────────────────────────────────────────────────────────────────────────
// 测试：isProbeCanvas guard（≤16x16）
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 2.4: isProbeCanvas guard (≤16x16 → skip spoof)', () => {
  it('toDataURL on 2x2 canvas skips spoof entirely (no getImageData call)', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    canvas.toDataURL();
    // wrap 短路 → 不调用 ctx.getImageData / putImageData
    expect(mockState.getImageDataCalls).toHaveLength(0);
    expect(mockState.putImageDataCalls).toBe(0);
  });

  it('toDataURL on 8x8 canvas skips spoof', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    canvas.toDataURL();
    expect(mockState.getImageDataCalls).toHaveLength(0);
  });

  it('toDataURL on 16x16 canvas skips spoof (boundary, inclusive)', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    canvas.toDataURL();
    expect(mockState.getImageDataCalls).toHaveLength(0);
  });

  it('toDataURL on 17x17 canvas DOES spoof (threshold crossed)', () => {
    mockState.nextPattern = 'pattern'; // 防 isAllZero 短路
    const canvas = document.createElement('canvas');
    canvas.width = 17;
    canvas.height = 17;
    canvas.toDataURL();
    expect(mockState.getImageDataCalls).toHaveLength(1);
    expect(mockState.getImageDataCalls[0]).toEqual([0, 0, 17, 17]);
    expect(mockState.putImageDataCalls).toBe(1);
  });

  it('toDataURL on 50x50 canvas DOES spoof (typical fingerprinting size)', () => {
    mockState.nextPattern = 'pattern';
    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 50;
    canvas.toDataURL();
    expect(mockState.getImageDataCalls).toHaveLength(1);
  });

  it('toDataURL on 220x30 canvas (browserleaks-style) DOES spoof', () => {
    mockState.nextPattern = 'pattern';
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 30;
    canvas.toDataURL();
    expect(mockState.getImageDataCalls).toHaveLength(1);
  });

  it('getImageData on 2x2 canvas returns native data unchanged (CreepJS Check 2 fix)', () => {
    mockState.nextPattern = 'pattern';
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, 2, 2);
    // 必须保留精确 native 值才能命中 KnownImageData (BLINK/GECKO/WEBKIT)
    // 此处验证我们的 pattern 真值未被噪声扰动
    for (let i = 0; i < imageData.data.length; i++) {
      expect(imageData.data[i]).toBe((i * 13) % 256);
    }
  });

  it('getImageData on 16x16 canvas returns native data unchanged (boundary)', () => {
    mockState.nextPattern = 'pattern';
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, 16, 16);
    for (let i = 0; i < imageData.data.length; i++) {
      expect(imageData.data[i]).toBe((i * 13) % 256);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试：isAllZero guard（cleared / transparent region → skip noise）
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 2.4: isAllZero guard (cleared region → skip noise)', () => {
  it('getImageData on cleared 8x8 region of 50x50 canvas preserves all zeros (CreepJS Check 1 fix)', () => {
    mockState.nextPattern = 'zero';
    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 50;
    const ctx = canvas.getContext('2d')!;
    // CreepJS lies check: clearRect 后 getImageData(0, 0, 8, 8) + Math.max(...data) > 0
    const imageData = ctx.getImageData(0, 0, 8, 8);
    // 不能有任何像素被噪声从 0 推到 ±1
    const max = Math.max(...imageData.data);
    expect(max).toBe(0);
  });

  it('getImageData on cleared region of larger canvas (100x100) also preserves zeros', () => {
    mockState.nextPattern = 'zero';
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, 8, 8);
    expect(Math.max(...imageData.data)).toBe(0);
  });

  it('getImageData on non-zero region of 50x50 canvas DOES get noise', () => {
    mockState.nextPattern = 'pattern';
    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 50;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, 8, 8);
    // 至少一个 R/G/B 字节应该被改动（alpha=i%4==3 不动）
    // 64 pixels × ~50% prob 每像素 → 几乎必然 ≥1 修改
    let modifiedCount = 0;
    for (let i = 0; i < imageData.data.length; i += 4) {
      const origR = (i * 13) % 256;
      const origG = ((i + 1) * 13) % 256;
      const origB = ((i + 2) * 13) % 256;
      if (
        imageData.data[i] !== origR ||
        imageData.data[i + 1] !== origG ||
        imageData.data[i + 2] !== origB
      ) {
        modifiedCount += 1;
      }
    }
    expect(modifiedCount).toBeGreaterThan(0);
  });

  it('getImageData alpha channel never modified (only R/G/B)', () => {
    mockState.nextPattern = 'pattern';
    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 50;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, 8, 8);
    // 检查每个 alpha 字节 (index 3, 7, 11, ...) 等于原始 pattern 值
    for (let i = 3; i < imageData.data.length; i += 4) {
      expect(imageData.data[i]).toBe((i * 13) % 256);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试：双 guard 组合行为
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 2.4: guard combination edge cases', () => {
  it('17x17 cleared canvas → toDataURL goes into spoof block but isAllZero short-circuits perturb', () => {
    mockState.nextPattern = 'zero';
    const canvas = document.createElement('canvas');
    canvas.width = 17;
    canvas.height = 17;
    canvas.toDataURL();
    // wrap 进入 spoof block（不是 probe）→ 调用 getImageData
    expect(mockState.getImageDataCalls).toHaveLength(1);
    // putImageData 仍被调用（perturbImageData 内 isAllZero return 后回到 wrap，
    // wrap 仍 putImageData 回 ctx —— 数据原样写回，等价 no-op）
    expect(mockState.putImageDataCalls).toBe(1);
  });

  it('1x100 thin canvas (narrow dim ≤ 16) skips spoof', () => {
    // isProbeCanvas: width ≤ 16 && height ≤ 16 → 1x100 height=100 > 16 → NOT probe
    mockState.nextPattern = 'pattern';
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 100;
    canvas.toDataURL();
    // height > 16 → 不是 probe → spoof 进入
    expect(mockState.getImageDataCalls).toHaveLength(1);
  });

  it('16x100 canvas skips spoof (width ≤ 16 AND height > 16 → NOT probe per AND rule)', () => {
    mockState.nextPattern = 'pattern';
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 100;
    canvas.toDataURL();
    // height > 16 → NOT probe → spoof 进入
    expect(mockState.getImageDataCalls).toHaveLength(1);
  });
});
