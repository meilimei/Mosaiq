// @vitest-environment happy-dom

/**
 * runner.ts §11 worker scope spoof — Phase 2.6 完整镜像测试。
 *
 * happy-dom 默认无 `Worker` / `SharedWorker` / `OffscreenCanvasRenderingContext2D` /
 * `WebGLRenderingContext`，所以 runner.ts §11 整块被 `typeof Worker !== 'undefined'`
 * 跳过 —— 现有 `worker scope spoof (Phase 1.5)` 测试只覆盖 main scope hook 存在性，
 * 完全没验证 worker IIFE 字符串内容。
 *
 * 本文件 polyfill `Worker` 后 `injectAll`，触发 worker hook → 拦截 `new Worker(blobUrl)`
 * 时拿到 Phase 2.6 完整 IIFE 字符串。然后:
 *
 *   1. **静态断言**：IIFE 含 Phase 2.6 标志性内容（webgl1Profile、buildSpoofMap、
 *      OffscreenCanvasRenderingContext2D、isProbeOC 等）—— 验证修改已纳入序列化输出。
 *   2. **执行断言**：在隔离 sandbox（new Function）里加 polyfill 跑 IIFE，断言 navigator
 *      / WebGL / OffscreenCanvas spoof 在 worker realm 真实生效。
 *
 * 单元测试隔离：本文件用独立 beforeAll 安装 polyfill，不污染 `runner.test.ts` /
 * `runner-canvas.test.ts`（vitest 按文件隔离 worker）。
 */

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildInjectionConfig } from './build-config.js';
import { injectAll } from './runner.js';

// ────────────────────────────────────────────────────────────────────────────
// Mock 状态：捕获 worker IIFE 字符串
// ────────────────────────────────────────────────────────────────────────────

const workerCapture = {
  /** 全部 new Worker(...) 拦截到的 blob 内容 */
  scripts: [] as string[],
  /** 全部 new Worker(...) 接收到的 scriptUrl 参数 */
  scriptUrls: [] as string[],
};

class MockWorker {
  constructor(scriptUrl: string | URL, _opts?: WorkerOptions) {
    workerCapture.scriptUrls.push(String(scriptUrl));
  }
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
  onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: AbstractWorker, ev: ErrorEvent) => unknown) | null = null;
  onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
}

// ────────────────────────────────────────────────────────────────────────────
// beforeAll：polyfill Worker + 触发 wrap + 抓 IIFE
// ────────────────────────────────────────────────────────────────────────────

let capturedIIFE = '';

beforeAll(async () => {
  // 1. polyfill Worker 全局（happy-dom 没有）
  (globalThis as unknown as { Worker: typeof MockWorker }).Worker = MockWorker;

  // 2. 跑 injectAll —— 这会 wrap MockWorker → globalThis.Worker = wrappedWorker
  const persona = createWin11ChromeUsPersona({
    id: 'worker-test',
    displayName: 'Worker Test',
    timezone: 'Asia/Tokyo',
    masterSeed: 'cafe-worker',
  });
  const config = buildInjectionConfig(persona);
  injectAll(config);

  // 3. 触发 wrappedWorker construct → 它会构造 blob 并 Reflect.construct(MockWorker, [blobUrl, opts])
  //    我们需要在 blob 被 createObjectURL 之前拦截内容。最简单：mock URL.createObjectURL
  //    捕获 blob 内容。
  //
  //    happy-dom 应该有 URL.createObjectURL 但返回 fake URL。我们 wrap 之以捕获 blob 文本。
  const origCreateObjectURL = URL.createObjectURL;
  let lastBlobText = '';
  URL.createObjectURL = function (blob: Blob): string {
    // happy-dom Blob.text() 是 Promise；我们同步读不到。退路：访问 blob 内部
    // 私有结构。但更稳：blob.size 至少能验证非空，然后用 async 读。
    // 测试 setup 是 async（beforeAll allows async），先 await。
    // 这个 wrapper 同步返回 URL，async 读 blob 内容必须在 wrapper 内 schedule。
    // 直接做法：把 blob 推入数组，beforeAll 末尾 await 全部 blob.text()。
    workerCapture.scripts.push(''); // 占位
    const slot = workerCapture.scripts.length - 1;
    void blob.text().then((t) => {
      workerCapture.scripts[slot] = t;
      if (!capturedIIFE) capturedIIFE = t;
      lastBlobText = t;
    });
    return origCreateObjectURL.call(URL, blob);
  };

  // 4. 触发 wrap
  new (globalThis as unknown as { Worker: typeof Worker }).Worker('https://test.example/foo.js');

  // 5. 等 async blob.text() 完成
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!capturedIIFE && lastBlobText) capturedIIFE = lastBlobText;
});

// ────────────────────────────────────────────────────────────────────────────
// 测试 Group 1：静态断言 — Phase 1.5 现有内容仍存在
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5 worker IIFE: navigator + UA-CH spoof (regression guard)', () => {
  it('captures the IIFE source via new Worker(...) hook', () => {
    expect(workerCapture.scripts.length).toBeGreaterThan(0);
    expect(capturedIIFE.length).toBeGreaterThan(500);
  });

  it('IIFE contains navigator.userAgent override', () => {
    expect(capturedIIFE).toMatch(/userAgent/);
    expect(capturedIIFE).toMatch(/Object\.defineProperty\(navigator/);
  });

  it('IIFE contains UA-CH (userAgentData) brands / getHighEntropyValues / toJSON spoof', () => {
    expect(capturedIIFE).toMatch(/userAgentData/);
    expect(capturedIIFE).toMatch(/brands/);
    expect(capturedIIFE).toMatch(/getHighEntropyValues/);
    expect(capturedIIFE).toMatch(/toJSON/);
  });

  it('IIFE references WebGLRenderingContext + WebGL2RenderingContext (no scope loss)', () => {
    expect(capturedIIFE).toMatch(/WebGLRenderingContext/);
    expect(capturedIIFE).toMatch(/WebGL2RenderingContext/);
  });

  it('IIFE preserves CDP detection hardening (Error.stack accessor block)', () => {
    expect(capturedIIFE).toMatch(/_isErrInst/);
    expect(capturedIIFE).toMatch(/Reflect\.defineProperty/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试 Group 2：Phase 2.6 新增 — WebGL 49-param 镜像
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 2.6 worker IIFE: WebGL 49-param full mirror', () => {
  it('payload contains webgl1Profile + webgl2Profile (hex-keyed maps)', () => {
    // P = {...,"webgl1Profile":{"0x...":...},"webgl2Profile":{...}}
    expect(capturedIIFE).toMatch(/webgl1Profile/);
    expect(capturedIIFE).toMatch(/webgl2Profile/);
  });

  it('IIFE contains _buildSpoofMap helper (Phase 2.6 marker)', () => {
    expect(capturedIIFE).toMatch(/_buildSpoofMap/);
  });

  it('IIFE merges WebGL1 into WebGL2 spoof map (per spec, GL2 inherits GL1)', () => {
    expect(capturedIIFE).toMatch(/_gl2Merged/);
    expect(capturedIIFE).toMatch(/_gl1Map\.forEach/);
  });

  it('IIFE declares INT32 / FLOAT32 / STRING pname sets (typed array reconstruction)', () => {
    // I32S contains 0x0d3a (MAX_VIEWPORT_DIMS)
    expect(capturedIIFE).toMatch(/0x0d3a/i);
    // F32S contains 0x846e + 0x846d (ALIASED_*_RANGE)
    expect(capturedIIFE).toMatch(/0x846e/i);
    expect(capturedIIFE).toMatch(/0x846d/i);
    // STRS contains VENDOR/RENDERER/VERSION/SHADING_LANGUAGE_VERSION (0x1f00/01/02 + 0x8b8c)
    expect(capturedIIFE).toMatch(/0x1f00/i);
    expect(capturedIIFE).toMatch(/0x1f01/i);
    expect(capturedIIFE).toMatch(/0x8b8c/i);
  });

  it('IIFE replaces WebGLRenderingContext.prototype.getParameter (not just UNMASKED_VENDOR/RENDERER)', () => {
    expect(capturedIIFE).toMatch(
      /WebGLRenderingContext\.prototype\.getParameter\s*=\s*_makeGP/,
    );
  });

  it('IIFE handles WebGL2 own descriptor (Object.getOwnPropertyDescriptor)', () => {
    expect(capturedIIFE).toMatch(/Object\.getOwnPropertyDescriptor\(WebGL2RenderingContext/);
  });

  it('IIFE typed-array cloning preserves per-call freshness', () => {
    expect(capturedIIFE).toMatch(/_cloneSpoofVal/);
    expect(capturedIIFE).toMatch(/new Int32Array\(v\)/);
    expect(capturedIIFE).toMatch(/new Float32Array\(v\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试 Group 3：Phase 2.6 新增 — OffscreenCanvas spoof 镜像
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 2.6 worker IIFE: OffscreenCanvas spoof mirror', () => {
  it('payload contains canvasNoiseSeed + canvasNoiseStrength', () => {
    expect(capturedIIFE).toMatch(/canvasNoiseSeed/);
    expect(capturedIIFE).toMatch(/canvasNoiseStrength/);
  });

  it('IIFE checks typeof OffscreenCanvasRenderingContext2D (graceful no-op)', () => {
    expect(capturedIIFE).toMatch(/typeof OffscreenCanvasRenderingContext2D/);
  });

  it('IIFE contains _isProbeOC guard (≤16x16 skip — CreepJS 2x2 probe fix)', () => {
    expect(capturedIIFE).toMatch(/_isProbeOC/);
    expect(capturedIIFE).toMatch(/c\.width<=16&&c\.height<=16/);
  });

  it('IIFE contains _isAllZeroOC guard (cleared region skip — CreepJS Check 1 fix)', () => {
    expect(capturedIIFE).toMatch(/_isAllZeroOC/);
  });

  it('IIFE replaces OffscreenCanvasRenderingContext2D.prototype.getImageData', () => {
    expect(capturedIIFE).toMatch(
      /OffscreenCanvasRenderingContext2D\.prototype\.getImageData\s*=/,
    );
  });

  it('IIFE perturbation uses mulberry32 PRNG (same algo as main scope)', () => {
    expect(capturedIIFE).toMatch(/0x6d2b79f5/);
    // mulberry32 signature: Math.imul(t^(t>>>15),t|1)
    expect(capturedIIFE).toMatch(/Math\.imul\(t\^\(t>>>15\),t\|1\)/);
  });

  it('IIFE perturbation respects strength=0 short-circuit (no spoof when disabled)', () => {
    expect(capturedIIFE).toMatch(/P\.canvasNoiseStrength>0/);
  });

  it('IIFE perturbation preserves alpha channel (only modifies R/G/B at i, i+1, i+2)', () => {
    // 不写 data[i+3] = ...，所以应有 i+1 + i+2 但不 i+3 修改赋值
    expect(capturedIIFE).toMatch(/data\[i\+1\]=Math\.max/);
    expect(capturedIIFE).toMatch(/data\[i\+2\]=Math\.max/);
    // alpha (i+3) 在 perturbOC 内不被赋值
    expect(capturedIIFE).not.toMatch(/data\[i\+3\]=Math\.max/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试 Group 4：执行断言 — 在 sandbox 内 eval IIFE 验证 spoof 真生效
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 2.6 worker IIFE: execution in sandbox (live spoof verification)', () => {
  /**
   * 构造一个隔离 sandbox：用 `new Function('globalThis', ...)` 在显式 scope 内
   * 跑 IIFE，并预安装 worker-realm 必要 polyfill。
   */
  function runIIFEInSandbox(iife: string) {
    // 1. 准备隔离 scope —— 模拟 worker realm 的最小 global 表面
    const sandbox = {
      navigator: { userAgent: 'BEFORE-SPOOF' } as Record<string, unknown>,
      Promise,
      Math,
      JSON,
      Array,
      Object,
      Map,
      Set,
      Reflect,
      Int32Array,
      Float32Array,
      Uint8ClampedArray,
      console: { debug() {} },
      WebGLRenderingContext: undefined as unknown,
      WebGL2RenderingContext: undefined as unknown,
      OffscreenCanvasRenderingContext2D: undefined as unknown,
    } as Record<string, unknown>;

    // 2. 安装 WebGL prototype polyfill —— 验证 49-param spoof 生效
    class FakeWebGL1 {
      getParameter(pname: number): number | string | Int32Array | Float32Array {
        // 默认返回 base values（spoof 应覆盖这些）
        if (pname === 0x9245) return 'BASE_VENDOR';
        if (pname === 0x9246) return 'BASE_RENDERER';
        if (pname === 0x1f00) return 'BASE_VENDOR_GL';
        return -1;
      }
    }
    class FakeWebGL2 extends FakeWebGL1 {}
    sandbox.WebGLRenderingContext = FakeWebGL1;
    sandbox.WebGL2RenderingContext = FakeWebGL2;

    // 3. 安装 OffscreenCanvas polyfill
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
    }
    class FakeImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(d: Uint8ClampedArray, w: number, h: number) {
        this.data = d;
        this.width = w;
        this.height = h;
      }
    }
    class FakeOCCtx {
      canvas: FakeOffscreenCanvas;
      constructor(canvas: FakeOffscreenCanvas) {
        this.canvas = canvas;
      }
      getImageData(_x: number, _y: number, w: number, h: number) {
        const len = w * h * 4;
        const d = new Uint8ClampedArray(len);
        // 模拟内容：每个 byte = (idx * 13) % 256
        for (let i = 0; i < len; i++) d[i] = (i * 13) % 256;
        return new FakeImageData(d, w, h);
      }
    }
    sandbox.OffscreenCanvasRenderingContext2D = FakeOCCtx;
    sandbox.OffscreenCanvas = FakeOffscreenCanvas;
    sandbox.ImageData = FakeImageData;

    // 4. 移除 `buildWorkerInline` 追加的 `importScripts(absUrl)` / `import(absUrl)` 尾部
    //    —— 那是把真实 worker 脚本拉进来的桥接，不属于 spoof IIFE 本身，sandbox 内
    //    无 importScripts 全局会 ReferenceError。
    const cleanedIIFE = iife
      .replace(/\nimportScripts\([^)]*\);?\s*$/m, '')
      .replace(/\nimport\([^)]*\);?\s*$/m, '');

    // 5. eval IIFE in sandbox
    // 注意：worker IIFE 直接调用 `navigator`、`Object` 等 global，所以我们把 sandbox
    // 字段作为参数传给 Function 让其在 closure 内可见。
    const keys = Object.keys(sandbox);
    const fn = new Function(...keys, cleanedIIFE);
    fn(...keys.map((k) => sandbox[k]));
    return sandbox;
  }

  it('IIFE override navigator.userAgent in sandbox (regression: Phase 1.5 still works)', () => {
    const sb = runIIFEInSandbox(capturedIIFE);
    const navUA = (sb.navigator as { userAgent: string }).userAgent;
    expect(navUA).not.toBe('BEFORE-SPOOF');
    expect(navUA).toMatch(/Mozilla/);
  });

  it('IIFE replaces WebGLRenderingContext.prototype.getParameter (49-param spoof live)', () => {
    const sb = runIIFEInSandbox(capturedIIFE);
    const ctx = new (sb.WebGLRenderingContext as new () => unknown)() as {
      getParameter(pname: number): unknown;
    };
    // UNMASKED_VENDOR 应该被 spoof 成 webglVendor，而不是 BASE_VENDOR
    const vendor = ctx.getParameter(0x9245);
    expect(vendor).not.toBe('BASE_VENDOR');
    expect(typeof vendor).toBe('string');
  });

  it('IIFE replaces OffscreenCanvasRenderingContext2D.prototype.getImageData (canvas spoof live)', () => {
    const sb = runIIFEInSandbox(capturedIIFE);
    const Canvas = sb.OffscreenCanvas as new (w: number, h: number) => unknown;
    const Ctx = sb.OffscreenCanvasRenderingContext2D as new (
      c: unknown,
    ) => {
      getImageData(x: number, y: number, w: number, h: number): unknown;
    };

    // 50x50 canvas (非 probe) + pattern data (非全 0) → 应该被噪声
    const canvas50 = new Canvas(50, 50);
    const ctx50 = new Ctx(canvas50);
    const imageData50 = ctx50.getImageData(0, 0, 8, 8) as { data: Uint8ClampedArray };
    // 至少一个 R/G/B byte 被改动
    let modifiedCount = 0;
    for (let i = 0; i < imageData50.data.length; i += 4) {
      const origR = (i * 13) % 256;
      const origG = ((i + 1) * 13) % 256;
      const origB = ((i + 2) * 13) % 256;
      if (
        imageData50.data[i] !== origR ||
        imageData50.data[i + 1] !== origG ||
        imageData50.data[i + 2] !== origB
      ) {
        modifiedCount += 1;
      }
    }
    expect(modifiedCount).toBeGreaterThan(0);

    // 2x2 canvas (probe) → 不应该被噪声
    const canvas2 = new Canvas(2, 2);
    const ctx2 = new Ctx(canvas2);
    const imageData2 = ctx2.getImageData(0, 0, 2, 2) as { data: Uint8ClampedArray };
    for (let i = 0; i < imageData2.data.length; i++) {
      expect(imageData2.data[i]).toBe((i * 13) % 256);
    }
  });
});
