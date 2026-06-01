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

import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';
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
  URL.createObjectURL = (blob: Blob): string => {
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
    // Phase 3 夯实去重：I32S/F32S/STRS 不再硬编码 hex，改由 injectAll 顶部共享的
    // INT32_PNAMES/FLOAT32_PNAMES/STRING_PNAMES（与 main scope §4 同源）动态生成
    // 为十进制 key（对象 key 强制成字符串，"3386" === String(0x0d3a)，行为等价）。
    // 断言生成出的具体 key 既验证「sets 存在」又锁住「与 §4 同源」这一去重不变量。
    expect(capturedIIFE).toMatch(/I32S\[3386\]=1/); // 0x0d3a MAX_VIEWPORT_DIMS
    expect(capturedIIFE).toMatch(/F32S\[33902\]=1/); // 0x846e ALIASED_LINE_WIDTH_RANGE
    expect(capturedIIFE).toMatch(/F32S\[33901\]=1/); // 0x846d ALIASED_POINT_SIZE_RANGE
    expect(capturedIIFE).toMatch(/STRS\[7936\]=1/); // 0x1f00 VENDOR
    expect(capturedIIFE).toMatch(/STRS\[7937\]=1/); // 0x1f01 RENDERER
    expect(capturedIIFE).toMatch(/STRS\[7938\]=1/); // 0x1f02 VERSION
    expect(capturedIIFE).toMatch(/STRS\[35724\]=1/); // 0x8b8c SHADING_LANGUAGE_VERSION
  });

  it('IIFE replaces WebGLRenderingContext.prototype.getParameter (not just UNMASKED_VENDOR/RENDERER)', () => {
    expect(capturedIIFE).toMatch(/WebGLRenderingContext\.prototype\.getParameter\s*=\s*_makeGP/);
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
    expect(capturedIIFE).toMatch(/OffscreenCanvasRenderingContext2D\.prototype\.getImageData\s*=/);
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

// ────────────────────────────────────────────────────────────────────────────
// 测试 Group 5：Phase 4.2 新增 — AudioBuffer audio spoof 镜像（静态断言）
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 4.2 worker IIFE: AudioBuffer audio spoof mirror (static)', () => {
  it('payload contains audioNoiseSeed + audioNoiseAmplitude', () => {
    expect(capturedIIFE).toMatch(/audioNoiseSeed/);
    expect(capturedIIFE).toMatch(/audioNoiseAmplitude/);
  });

  it('IIFE checks typeof AudioBuffer (worker realm graceful no-op)', () => {
    expect(capturedIIFE).toMatch(/typeof AudioBuffer/);
  });

  it('IIFE contains _mkAudioPrng + per-channel seed XOR (Phase 4.2 marker)', () => {
    expect(capturedIIFE).toMatch(/_mkAudioPrng/);
    // Phase 5.4c: per-channel XOR seed pattern moved into shared
    // `_applyAudioNoise(arr,ch)` helper; the XOR call site uses `(ch|0)` to
    // explicitly coerce the channel arg before XOR (worker IIFE has no static
    // typing).
    expect(capturedIIFE).toMatch(/_audioSeed\^\(ch\|0\)/);
  });

  it('IIFE replaces AudioBuffer.prototype.getChannelData', () => {
    expect(capturedIIFE).toMatch(/AudioBuffer\.prototype\.getChannelData\s*=\s*function/);
  });

  it('IIFE uses mulberry32 PRNG (same algo as main scope §6)', () => {
    // 已在 OffscreenCanvas group 测过 0x6d2b79f5 存在；audio block 复用 mulberry32
    // 这里只验证 IIFE 内含独立 audio prng helper（与 canvas _mkPrng 区分）
    expect(capturedIIFE).toMatch(/_mkAudioPrng/);
  });

  it('IIFE noise pattern: per-sample PRNG advance + 条件 add (Phase 5.2b silent-skip)', () => {
    // Phase 5.2b：silent samples 保留 exact 0，避免 CreepJS unique:5000 bold-fail。
    // Phase 6.1：noise 应用逻辑包在共享 `_ensureNoised(buf,ch,arr)` helper 内（替换
    // 5.4c 的 `_applyAudioNoise`），三个 hook 都先查 WeakMap 避免重复加 noise。
    // 关键不变量：
    //   1. 每样本 PRNG advance 一次（保 deterministic 序列） → `(prng()-0.5)*_audioAmp`
    //   2. 仅当 sample !== 0 时把 noise 写回 arr[i]            → `if(s!==0)arr[i]=s+n`
    expect(capturedIIFE).toMatch(/var s=arr\[i\]\|\|0/);
    expect(capturedIIFE).toMatch(/var n=\(prng\(\)-0\.5\)\*_audioAmp/);
    expect(capturedIIFE).toMatch(/if\(s!==0\)arr\[i\]=s\+n/);
  });

  it('IIFE replaces copyFromChannel + copyToChannel (Phase 6.1 idempotent memoization)', () => {
    // Phase 6.1 worker mirror —— main scope §6 用 WeakMap<AudioBuffer, Set<channel>>
    // 记忆化 noise，三个 hook 都通过 `_ensureNoised` 早退避免重复加 noise。
    // worker IIFE 必须同步覆盖（worker realm 内的 OfflineAudioContext path 同样会
    // 触发 CreepJS getNoiseFactor cross-check）。
    expect(capturedIIFE).toMatch(/AudioBuffer\.prototype\.copyFromChannel\s*=\s*function/);
    expect(capturedIIFE).toMatch(/AudioBuffer\.prototype\.copyToChannel\s*=\s*function/);
    // 共享 helper 名 _ensureNoised 锁住三处 hook 复用同一逻辑
    expect(capturedIIFE).toMatch(/_ensureNoised/);
  });

  it('IIFE contains _noisedChannels WeakMap + set.has(ch) early return (Phase 6.1)', () => {
    // 6.1 的 trap-fix 核心：WeakMap 记录 (buffer, channel) 已 noise 过 → 后续读
    // 直接 return 不再叠加 noise → caller 写入幸存 → CreepJS noiseFactor === 0。
    // 锁这三处文本结构防止重构丢功能。
    expect(capturedIIFE).toMatch(/_noisedChannels=new WeakMap/);
    expect(capturedIIFE).toMatch(/function _ensureNoised\(buf,ch,arr\)/);
    expect(capturedIIFE).toMatch(/if\(set\.has\(ch\)\)return/);
  });

  it('IIFE copyToChannel marks (buf, ch) synced after native call (Phase 6.1)', () => {
    // 6.1：copyToChannel 写完不再加 noise（caller 数据完整保留），用 set.add(ch)
    // 标记 synced，禁止后续 ensureNoised 给 underlying 加 noise。
    // copyToChannel hook body 内必含 native call _origCopyTo + set.add(ch) 顺序。
    expect(capturedIIFE).toMatch(/_origCopyTo\.call\(this,source,channelNumber,bufferOffset\)/);
    expect(capturedIIFE).toMatch(/set\.add\(ch\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试 Group 6：Phase 4.2 — sandbox 执行验证 AudioBuffer hook 真生效
// ────────────────────────────────────────────────────────────────────────────

describe('Phase 4.2 worker IIFE: AudioBuffer execution in sandbox', () => {
  /**
   * 复制 Group 4 sandbox 基础设施 + 加 AudioBuffer polyfill。
   * 这是 closure-isolated helper，与 Group 4 的 `runIIFEInSandbox` 不耦合。
   */
  function runIIFEWithAudio(iife: string) {
    // 模拟 worker realm：navigator + WebGL/OffscreenCanvas/AudioBuffer 都要 polyfill
    // 因为 IIFE 在一个 try block 内串联多个独立 try block，前面的 hook 失败不影响后面
    class FakeWebGL1 {
      getParameter(): unknown {
        return -1;
      }
    }
    class FakeWebGL2 extends FakeWebGL1 {}
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(w: number, h: number) {
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
        return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      }
    }

    // 关键：FakeAudioBuffer polyfill —— 模拟 worker realm 的 OfflineAudioContext
    // 渲染结果。getChannelData 返回内部 Float32Array view（与真实行为一致）。
    // Phase 5.4c 加 copyFromChannel/copyToChannel polyfill —— worker IIFE
    // 用 typeof === 'function' 守护，没有这两个方法就跳过 hook；为了在 sandbox
    // 里真正验证 hook 生效，需要 polyfill 它们。
    class FakeAudioBuffer {
      length: number;
      sampleRate: number;
      numberOfChannels: number;
      #channels: Float32Array[];
      constructor(numberOfChannels: number, length: number, sampleRate: number) {
        this.numberOfChannels = numberOfChannels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.#channels = [];
        for (let c = 0; c < numberOfChannels; c++) {
          const arr = new Float32Array(length);
          // 三角波 baseline：每 sample = (i + c*100) * 1e-4
          for (let i = 0; i < length; i++) arr[i] = (i + c * 100) * 1e-4;
          this.#channels.push(arr);
        }
      }
      getChannelData(channel: number): Float32Array {
        const buf = this.#channels[channel];
        if (!buf) throw new Error(`channel ${channel} out of range`);
        return buf;
      }
      copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0): void {
        const src = this.#channels[channelNumber];
        if (!src) throw new Error(`channel ${channelNumber} out of range`);
        const offset = bufferOffset | 0;
        const copyLen = Math.min(destination.length, src.length - offset);
        for (let i = 0; i < copyLen; i++) destination[i] = src[i + offset] ?? 0;
      }
      copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0): void {
        const dst = this.#channels[channelNumber];
        if (!dst) throw new Error(`channel ${channelNumber} out of range`);
        const offset = bufferOffset | 0;
        const writeLen = Math.min(source.length, dst.length - offset);
        for (let i = 0; i < writeLen; i++) dst[i + offset] = source[i] ?? 0;
      }
    }

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
      Error,
      console: { debug() {} },
      WebGLRenderingContext: FakeWebGL1,
      WebGL2RenderingContext: FakeWebGL2,
      OffscreenCanvasRenderingContext2D: FakeOCCtx,
      OffscreenCanvas: FakeOffscreenCanvas,
      AudioBuffer: FakeAudioBuffer,
    } as Record<string, unknown>;

    const cleanedIIFE = iife
      .replace(/\nimportScripts\([^)]*\);?\s*$/m, '')
      .replace(/\nimport\([^)]*\);?\s*$/m, '');

    const keys = Object.keys(sandbox);
    const fn = new Function(...keys, cleanedIIFE);
    fn(...keys.map((k) => sandbox[k]));
    return { sandbox, FakeAudioBuffer };
  }

  it('IIFE replaces AudioBuffer.prototype.getChannelData (hook live in sandbox)', () => {
    const { FakeAudioBuffer } = runIIFEWithAudio(capturedIIFE);
    // hook 后实例化 + 读 channel data，应该看到 noise 注入
    const buf = new FakeAudioBuffer(1, 5000, 44100);
    const data = buf.getChannelData(0);
    let differences = 0;
    for (let i = 0; i < data.length; i++) {
      const baseline = i * 1e-4;
      if (data[i] !== baseline) differences++;
    }
    // 5000 sample 几乎全应该被 PRNG noise 改变
    expect(differences).toBeGreaterThan(4900);
  });

  it('IIFE per-channel XOR seed produces distinct noise sequences', () => {
    const { FakeAudioBuffer } = runIIFEWithAudio(capturedIIFE);
    const buf = new FakeAudioBuffer(2, 100, 44100);
    const ch0 = Array.from(buf.getChannelData(0));
    const ch1 = Array.from(buf.getChannelData(1));
    // 去掉 baseline 差（channel-XOR seed 让 noise 序列不同）
    const noise0 = ch0.map((v, i) => v - i * 1e-4);
    const noise1 = ch1.map((v, i) => v - (i + 100) * 1e-4);
    expect(noise0).not.toEqual(noise1);
    // 量级仍受 amplitude (1e-7) 约束
    const maxNoise0 = Math.max(...noise0.map(Math.abs));
    const maxNoise1 = Math.max(...noise1.map(Math.abs));
    expect(maxNoise0).toBeLessThan(1e-6);
    expect(maxNoise1).toBeLessThan(1e-6);
  });

  it('IIFE copyFromChannel applies same noise as getChannelData (Phase 5.4c CreepJS lies fix)', () => {
    // Phase 5.4c worker mirror — 同 main scope 测试，验证 worker IIFE 在
    // sandbox 里 hook 了 copyFromChannel，且产生与 getChannelData 一致的 noise
    // 序列。这是 CreepJS audio cross-check 的关键：copy 与 bins 必须逐样本相等。
    const { FakeAudioBuffer } = runIIFEWithAudio(capturedIIFE);
    const buf1 = new FakeAudioBuffer(1, 5000, 44100);
    const buf2 = new FakeAudioBuffer(1, 5000, 44100);
    // buf1 走 copyFromChannel 路径，buf2 走 getChannelData 路径，两者初始 baseline 相同
    const copy = new Float32Array(5000);
    buf1.copyFromChannel(copy, 0);
    const bins = buf2.getChannelData(0);
    // CreepJS 比对窗口 [4500..4600]
    const copySample = Array.from(copy.slice(4500, 4600));
    const binsSample = Array.from(bins.slice(4500, 4600));
    expect(copySample.join(',')).toBe(binsSample.join(','));
  });

  it('IIFE copyToChannel preserves caller source (Phase 6.1 synced contract, sandbox)', () => {
    // Phase 6.1 worker mirror：copyToChannel native 写完后，set.add(channel) 标记
    // (buffer, channel) 已 synced；后续 getChannelData 触发 _ensureNoised → 命中
    // set.has(ch) → 直接 return → caller 数据 byte-equal 写入值。这是闭合 CreepJS
    // getNoiseFactor() trap 的关键不变量。
    const { FakeAudioBuffer } = runIIFEWithAudio(capturedIIFE);
    // baseline 全 0：FakeAudioBuffer 默认 fill 是三角波，但 copyToChannel 是写覆盖，
    // 我们看的是 caller-provided source 是否在写完后保持不变。
    const buf = new FakeAudioBuffer(1, 100, 44100);
    const source = new Float32Array(100);
    for (let i = 0; i < 100; i++) source[i] = (i + 1) * 1e-4;
    const sourceCopy = Float32Array.from(source); // Float32 量化基准
    buf.copyToChannel(source, 0);
    const bins = buf.getChannelData(0);
    // 6.1 强不变量：bins 与 sourceCopy 逐字节相等（无任何 noise 叠加）
    expect(Array.from(bins)).toEqual(Array.from(sourceCopy));
  });

  it('IIFE getChannelData idempotent re-read (Phase 6.1 sandbox)', () => {
    // 6.1 第二条强不变量：同一 buffer + channel 多次读返回 byte-equal 序列。
    const { FakeAudioBuffer } = runIIFEWithAudio(capturedIIFE);
    const buf = new FakeAudioBuffer(1, 200, 44100);
    const a = Array.from(buf.getChannelData(0));
    const b = Array.from(buf.getChannelData(0));
    expect(b).toEqual(a);
  });

  it('IIFE caller-write survives subsequent getChannelData (Phase 6.1 sandbox)', () => {
    // 6.1 第三条强不变量：caller 写入 underlying view 的值，下次读应原样返回。
    // 这是 CreepJS getCopyFrom(rand, ...) 三个 rand 写能 survive 的根本前提。
    const { FakeAudioBuffer } = runIIFEWithAudio(capturedIIFE);
    const buf = new FakeAudioBuffer(1, 200, 44100);
    const RAND = Math.fround(0.6789);
    const view = buf.getChannelData(0);
    view[80] = RAND;
    view[120] = RAND;
    const reread = buf.getChannelData(0);
    expect(reread[80]).toBe(RAND);
    expect(reread[120]).toBe(RAND);
  });
});
