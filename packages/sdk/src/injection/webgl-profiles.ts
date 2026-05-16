/**
 * webgl-profiles.ts — 按 GPU+driver 给 `WebGLRenderingContext.getParameter` 一份"该 GPU 应该是什么样"
 * 的参数对照表。
 *
 * 背景：
 *   v0.1 我们只 spoof `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` 两个字符串 ——
 *   这骗过了 BrowserLeaks / sannysoft 这种字符串级检测器。但 CreepJS 把 ~78 个 GL 参
 *   数（MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS / MAX_VERTEX_ATTRIBS / ...）和渲染输出
 *   一起 hash，与 persona 声称的 GPU 做交叉对照。如果 host 实际跑在不同 GPU 上（开
 *   发机用 NVIDIA、生产容器用 AMD 等），那 ~78 个参数会与 Intel UHD 730 不一致，CreepJS
 *   立刻把 WebGL 标 bold-fail。
 *
 *   本模块提供"参数表" —— 每个已知 GPU 一份。runner.ts §4 在 `getParameter` Proxy 里读
 *   配表里写好的常量值替换返回，让 GPU 限值与声称型号一致。
 *
 * 设计约束：
 *   - **不覆盖 context-dependent 参数**（当前绑定的 buffer / texture / framebuffer）。
 *     这些值随调用 site 变化，spoof 一个静态常量会让 WebGL app 直接挂掉。
 *   - **只覆盖 capability 常量**（MAX_* / ALIASED_*_RANGE / *_BITS / etc.）。
 *     这些参数在 GL context 生命周期内永远不变，可以安全 spoof。
 *   - **typed array 用 plain number[] 表示**（JSON 序列化通过 init script context 时
 *     typed array 会被破坏成 plain object）。runner.ts 用 `Int32Array` / `Float32Array`
 *     重新构造，避免 instanceof / .buffer 检测穿帮。
 *
 * 命名约定：
 *   - `WEBGL1_PARAMS_*` —— 仅 WebGL1 适用的参数
 *   - `WEBGL2_PARAMS_*` —— 仅 WebGL2 适用的参数（WebGL2 context 也继承 WebGL1 参数）
 *
 * 数据来源：
 *   - https://webglreport.com / https://webgl-stat.org 等公共 fingerprint 聚合
 *   - browserleaks-webgl bench 的真机捕获（已存在于 results/<timestamp>/browserleaks-webgl.html）
 *   - Chrome 自带 GPU info 页（chrome://gpu）
 *   - ANGLE source 中的 D3D11 backend limits（github.com/google/angle）
 *
 * 添加新 profile 的步骤：
 *   1. 找到目标 GPU+driver+Chrome 组合的真机 capture（或公共 fingerprint 数据库）
 *   2. 复制本文件里的 `INTEL_UHD_730_D3D11` 改名
 *   3. 在 `KNOWN_PROFILES` 数组里加一个正则匹配
 *   4. 加 vitest 覆盖
 */

/**
 * GL 参数值。原生 getParameter 可能返回：
 *   - number（整数 / 浮点 capability，例 MAX_TEXTURE_SIZE）
 *   - readonly number[]（typed array 像 MAX_VIEWPORT_DIMS / ALIASED_LINE_WIDTH_RANGE，
 *     在序列化时降级成 number[]，运行时由 runner.ts 重新包成 Int32Array / Float32Array）
 *   - string（VENDOR / RENDERER / VERSION / SHADING_LANGUAGE_VERSION，Phase 1.9b 加入）
 *
 * 我们在 profile 内不区分 typed array 类型 —— 运行时 runner.ts 按 pname 决定用
 * Int32Array 还是 Float32Array（IDL 已规定好哪些 param 返回哪种 typed array）。
 */
export type GlParamValue = number | readonly number[] | string;

export interface WebglProfile {
  /**
   * 稳定的 profile 标识符，用于 persona 显式指定（`Persona.hardware.gpu.webglProfileId`）。
   * 命名约定：`<vendor>-<model>-<backend>`，全小写连字符，例：
   *   - `'intel-uhd-730-d3d11'`
   *   - `'intel-uhd-630-d3d11'`
   *   - `'apple-m2-metal'`
   *
   * Profile id 是稳定 API contract（同 v0.x 内不能改），name 可以随时调整。
   */
  readonly id: string;
  /** Debug 用的人类可读名字，不影响行为 */
  readonly name: string;
  /**
   * 匹配 `persona.hardware.gpu.webglRenderer` 字符串的正则。
   * 第一个 match 的 profile 生效；想强制不 spoof 留空数组即可。
   */
  readonly matchRenderer: RegExp;
  /**
   * 此 profile 的 capabilities hash 是否在 CreepJS 的硬编码白名单（src/webgl/index.ts
   * `capabilities[]` 数组，~250 个已知 GPU hashes）内。
   *
   * - `true`：creepjs.com `LowerEntropy.WEBGL` 不会触发，bold-fail 消失
   * - `false`：profile 仍生效但 creepjs WebGL 仍 bold-fail（Mosaiq spoof 没问题，
   *   只是 CreepJS 项目数据库未收录该 GPU 的真值——真实用户也会被同样标记）
   * - `undefined`：未验证 / 数据未确认
   *
   * 用法：dev 模式下 SDK 可输出 hint 提示用户切换到白名单内 profile。
   * 不影响 runtime spoof 行为。
   */
  readonly knownInCreepjsWhitelist?: boolean;
  /**
   * WebGL1 参数表。key 是 GL constant 数值（直接写 number；hex 字面量便于对照
   * GL spec），value 是该参数下 ANGLE/driver/GPU 三者组合的真实返回值。
   *
   * 用 `Map<number, ...>` 而不是 Record，保证 key 是 number 类型 + 顺序明确。
   */
  readonly webgl1: ReadonlyMap<number, GlParamValue>;
  /**
   * WebGL2 参数表。注意 WebGL2 context 也会读 WebGL1 参数（继承），
   * runner.ts 会 merge `webgl1 ∪ webgl2` 在 WebGL2 context 上 spoof。
   */
  readonly webgl2: ReadonlyMap<number, GlParamValue>;
}

// ─────────────────────────────────────────────────────────────────────────────
// GL constants（与 WebGLRenderingContext 上的对应；命名 = GL 规范字面量）
// 仅在本文件内重新声明，避免运行时依赖 WebGLRenderingContext（runner 序列化场景）。
// ─────────────────────────────────────────────────────────────────────────────

/** WebGL 1 GL constants —— 这些 hex 值是 GL 规范固定的，跨实现稳定 */
export const GL = {
  // ─── String params (return string，VENDOR/RENDERER/VERSION/SHADING_LANGUAGE_VERSION) ───
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  VERSION: 0x1f02,
  SHADING_LANGUAGE_VERSION: 0x8b8c,

  // ─── Stencil state（CreepJS 查；Chrome+ANGLE 初始值是 spec defaults） ───
  STENCIL_VALUE_MASK: 0x0b93,
  STENCIL_WRITEMASK: 0x0b98,
  STENCIL_BACK_VALUE_MASK: 0x8ca4,
  STENCIL_BACK_WRITEMASK: 0x8ca5,

  // ─── Color / depth bits ───
  RED_BITS: 0x0d52,
  GREEN_BITS: 0x0d53,
  BLUE_BITS: 0x0d54,
  ALPHA_BITS: 0x0d55,
  DEPTH_BITS: 0x0d56,
  STENCIL_BITS: 0x0d57,
  SUBPIXEL_BITS: 0x0d50,

  // ─── Samples ───
  SAMPLES: 0x80a9,
  SAMPLE_BUFFERS: 0x80a8,

  // ─── Texture / Buffer caps ───
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_RENDERBUFFER_SIZE: 0x84e8,

  // ─── Vertex shader caps ───
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,

  // ─── Fragment shader caps ───
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,

  // ─── Aliased ranges (Float32Array[2]) ───
  ALIASED_LINE_WIDTH_RANGE: 0x846e,
  ALIASED_POINT_SIZE_RANGE: 0x846d,

  // ─── WebGL2-only ───
  MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_COLOR_ATTACHMENTS: 0x8cdf,
  MAX_VERTEX_OUTPUT_COMPONENTS: 0x9122,
  MAX_FRAGMENT_INPUT_COMPONENTS: 0x9125,
  MIN_PROGRAM_TEXEL_OFFSET: 0x8904,
  MAX_PROGRAM_TEXEL_OFFSET: 0x8905,
  MAX_SAMPLES: 0x8d57,
  MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f,
  MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
  MAX_VERTEX_UNIFORM_BLOCKS: 0x8a2b,
  MAX_FRAGMENT_UNIFORM_BLOCKS: 0x8a2d,
  MAX_COMBINED_UNIFORM_BLOCKS: 0x8a2e,

  // ─── WebGL2-only —— Phase 1.9b 新增（CreepJS 检测覆盖） ───
  MAX_ELEMENTS_VERTICES: 0x80e8,
  MAX_ELEMENTS_INDICES: 0x80e9,
  MAX_TEXTURE_LOD_BIAS: 0x84fd,
  MAX_FRAGMENT_UNIFORM_COMPONENTS: 0x8b49,
  MAX_VERTEX_UNIFORM_COMPONENTS: 0x8b4a,
  MAX_VARYING_COMPONENTS: 0x8b4b,
  MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS: 0x8c80,
  MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 0x8c8a,
  MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: 0x8c8b,
  MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: 0x8a31,
  MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: 0x8a33,
  MAX_SERVER_WAIT_TIMEOUT: 0x9111,
  MAX_ELEMENT_INDEX: 0x8d6b,
  MAX_CLIENT_WAIT_TIMEOUT_WEBGL: 0x9247,
} as const;

// 哪些 GL constants 返回 Int32Array vs Float32Array
// 通过 typed-array 在 runner.ts 重建时区分
export const INT32_ARRAY_PARAMS: ReadonlySet<number> = new Set([
  GL.MAX_VIEWPORT_DIMS, // [width, height]
]);

export const FLOAT32_ARRAY_PARAMS: ReadonlySet<number> = new Set([
  GL.ALIASED_LINE_WIDTH_RANGE,
  GL.ALIASED_POINT_SIZE_RANGE,
]);

/** 哪些 GL constants 返回 string（VENDOR/RENDERER/VERSION/SHADING_LANGUAGE_VERSION） */
export const STRING_PARAMS: ReadonlySet<number> = new Set([
  GL.VENDOR,
  GL.RENDERER,
  GL.VERSION,
  GL.SHADING_LANGUAGE_VERSION,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Intel UHD 730 / Win11 / Chrome 147 / ANGLE Direct3D11
// 来源：browserleaks-webgl + chrome://gpu 真机 + ANGLE D3D11 backend limits
// ─────────────────────────────────────────────────────────────────────────────

export const INTEL_UHD_730_D3D11: WebglProfile = {
  id: 'intel-uhd-730-d3d11',
  name: 'Intel UHD Graphics 730 / Direct3D11 / Win',
  matchRenderer: /UHD Graphics 730/,
  // Phase 1.9b 验证：capabilities hash -2146263890 不在 CreepJS 白名单
  // （Intel UHD 730 是 2022 Alder Lake 12 代，CreepJS 数据库未收录）
  // 真实 UHD 730 用户访问 creepjs.com 也会同样 bold-fail；非 Mosaiq bug
  knownInCreepjsWhitelist: false,
  webgl1: new Map<number, GlParamValue>([
    // —— String params (Chrome+ANGLE 全机器统一返回这些字符串) ——
    [GL.VENDOR, 'WebKit'],
    [GL.RENDERER, 'WebKit WebGL'],
    [GL.VERSION, 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'],
    [GL.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)'],
    // —— Stencil state initial values (GL ES 2.0 spec defaults，CreepJS 在初始化时查) ——
    // STENCIL_VALUE_MASK / STENCIL_BACK_VALUE_MASK 初始值 spec = 2^31 - 1（max signed int31）
    // STENCIL_WRITEMASK / STENCIL_BACK_WRITEMASK 初始值 spec = 全 1（all bits set）
    [GL.STENCIL_VALUE_MASK, 0x7fffffff],
    [GL.STENCIL_WRITEMASK, 0x7fffffff],
    [GL.STENCIL_BACK_VALUE_MASK, 0x7fffffff],
    [GL.STENCIL_BACK_WRITEMASK, 0x7fffffff],
    // —— Texture caps ——
    [GL.MAX_TEXTURE_SIZE, 16384],
    [GL.MAX_CUBE_MAP_TEXTURE_SIZE, 16384],
    [GL.MAX_RENDERBUFFER_SIZE, 16384],
    [GL.MAX_VIEWPORT_DIMS, [16384, 16384]],
    // —— Shader caps ——
    [GL.MAX_VERTEX_ATTRIBS, 16],
    [GL.MAX_VERTEX_UNIFORM_VECTORS, 4096],
    [GL.MAX_VARYING_VECTORS, 30],
    [GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 16],
    [GL.MAX_TEXTURE_IMAGE_UNITS, 16],
    [GL.MAX_FRAGMENT_UNIFORM_VECTORS, 1024],
    [GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 32],
    // —— Aliased ranges (typed array) ——
    [GL.ALIASED_LINE_WIDTH_RANGE, [1, 1]],
    [GL.ALIASED_POINT_SIZE_RANGE, [1, 1024]],
    // —— Color / depth / stencil bits ——
    [GL.RED_BITS, 8],
    [GL.GREEN_BITS, 8],
    [GL.BLUE_BITS, 8],
    [GL.ALPHA_BITS, 8],
    [GL.DEPTH_BITS, 24],
    [GL.STENCIL_BITS, 8],
    [GL.SUBPIXEL_BITS, 4],
    // —— MSAA ——
    [GL.SAMPLES, 0],
    [GL.SAMPLE_BUFFERS, 0],
  ]),
  webgl2: new Map<number, GlParamValue>([
    // —— String params (WebGL2 版本号不同) ——
    [GL.VERSION, 'WebGL 2.0 (OpenGL ES 3.0 Chromium)'],
    [GL.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)'],
    // —— 已有 ——
    [GL.MAX_3D_TEXTURE_SIZE, 2048],
    [GL.MAX_ARRAY_TEXTURE_LAYERS, 2048],
    [GL.MAX_DRAW_BUFFERS, 8],
    [GL.MAX_COLOR_ATTACHMENTS, 8],
    [GL.MAX_VERTEX_OUTPUT_COMPONENTS, 64],
    [GL.MAX_FRAGMENT_INPUT_COMPONENTS, 128],
    [GL.MIN_PROGRAM_TEXEL_OFFSET, -8],
    [GL.MAX_PROGRAM_TEXEL_OFFSET, 7],
    [GL.MAX_SAMPLES, 16],
    [GL.MAX_UNIFORM_BUFFER_BINDINGS, 60],
    [GL.MAX_UNIFORM_BLOCK_SIZE, 65536],
    [GL.MAX_VERTEX_UNIFORM_BLOCKS, 14],
    [GL.MAX_FRAGMENT_UNIFORM_BLOCKS, 14],
    [GL.MAX_COMBINED_UNIFORM_BLOCKS, 28],
    // —— Phase 1.9b 新增（数据来源：browserleaks-webgl 真机捕获） ——
    [GL.MAX_ELEMENTS_VERTICES, 1048575],
    [GL.MAX_ELEMENTS_INDICES, 1048575],
    [GL.MAX_TEXTURE_LOD_BIAS, 15],
    [GL.MAX_FRAGMENT_UNIFORM_COMPONENTS, 16384],
    [GL.MAX_VERTEX_UNIFORM_COMPONENTS, 16384],
    [GL.MAX_VARYING_COMPONENTS, 124],
    [GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS, 4],
    [GL.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS, 128],
    [GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS, 4],
    [GL.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS, 245760],
    [GL.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS, 245760],
    [GL.MAX_SERVER_WAIT_TIMEOUT, 0],
    [GL.MAX_ELEMENT_INDEX, 0xfffffffe],
    [GL.MAX_CLIENT_WAIT_TIMEOUT_WEBGL, 0],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// Intel UHD 630 / Win10/11 / Chrome / ANGLE Direct3D11
// 来源：ANGLE D3D11 backend 硬限制（与 UHD 730 共享同 backend，capabilities 几乎完全相同）。
// 唯一差异：UNMASKED_RENDERER_WEBGL 字符串声称 UHD 630 + matchRenderer 改正则。
// 数据交叉验证：deviceandbrowserinfo.com WebGL renderer 数据库收录 UHD 630 字符串
// 与 win10-chrome-us 模板用的字符串一致（device id 0x3e92 = Coffee Lake gen）。
//
// 注意：UHD 630 的 capabilities hash 与 UHD 730 几乎相同（同 ANGLE backend），
// 所以 creepjs WebGL bold-fail 仍可能 trigger。Phase 2.2 的主要价值是让
// win10-chrome-us persona 获完整 49-param 覆盖，而非 UNMASKED-only fallback。
// 实际白名单命中验证见 bench/find-creepjs-whitelist-fit.ts。
// ─────────────────────────────────────────────────────────────────────────────

export const INTEL_UHD_630_D3D11: WebglProfile = {
  id: 'intel-uhd-630-d3d11',
  name: 'Intel UHD Graphics 630 / Direct3D11 / Win',
  // 匹配 win10-chrome-us 模板的 webglRenderer 字符串
  // 注意正则需排他于 UHD 730（用 `\b630\b` 字界）
  matchRenderer: /UHD Graphics 630\b/,
  // capabilities hash 与 UHD 730 共享（同 ANGLE D3D11 backend），暂未验证白名单
  // 命中。后续 Phase 2.x 可能通过反向 fit 调整若干参数让 hash 进入白名单。
  knownInCreepjsWhitelist: undefined,
  webgl1: new Map<number, GlParamValue>([
    // —— String params (Chrome+ANGLE 全机器统一返回这些字符串) ——
    [GL.VENDOR, 'WebKit'],
    [GL.RENDERER, 'WebKit WebGL'],
    [GL.VERSION, 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'],
    [GL.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)'],
    // —— Stencil state initial values ——
    [GL.STENCIL_VALUE_MASK, 0x7fffffff],
    [GL.STENCIL_WRITEMASK, 0x7fffffff],
    [GL.STENCIL_BACK_VALUE_MASK, 0x7fffffff],
    [GL.STENCIL_BACK_WRITEMASK, 0x7fffffff],
    // —— Texture caps (D3D11 spec hard limit = 16384) ——
    [GL.MAX_TEXTURE_SIZE, 16384],
    [GL.MAX_CUBE_MAP_TEXTURE_SIZE, 16384],
    [GL.MAX_RENDERBUFFER_SIZE, 16384],
    [GL.MAX_VIEWPORT_DIMS, [16384, 16384]],
    // —— Shader caps (D3D feature level 11_0) ——
    [GL.MAX_VERTEX_ATTRIBS, 16],
    [GL.MAX_VERTEX_UNIFORM_VECTORS, 4096],
    [GL.MAX_VARYING_VECTORS, 30],
    [GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 16],
    [GL.MAX_TEXTURE_IMAGE_UNITS, 16],
    [GL.MAX_FRAGMENT_UNIFORM_VECTORS, 1024],
    [GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 32],
    // —— Aliased ranges ——
    [GL.ALIASED_LINE_WIDTH_RANGE, [1, 1]],
    [GL.ALIASED_POINT_SIZE_RANGE, [1, 1024]],
    // —— Color / depth / stencil bits ——
    [GL.RED_BITS, 8],
    [GL.GREEN_BITS, 8],
    [GL.BLUE_BITS, 8],
    [GL.ALPHA_BITS, 8],
    [GL.DEPTH_BITS, 24],
    [GL.STENCIL_BITS, 8],
    [GL.SUBPIXEL_BITS, 4],
    // —— MSAA ——
    [GL.SAMPLES, 0],
    [GL.SAMPLE_BUFFERS, 0],
  ]),
  webgl2: new Map<number, GlParamValue>([
    // —— String params (WebGL2 版本号) ——
    [GL.VERSION, 'WebGL 2.0 (OpenGL ES 3.0 Chromium)'],
    [GL.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)'],
    // —— WebGL2 caps（与 UHD 730 共享，源 ANGLE D3D11 硬限制） ——
    [GL.MAX_3D_TEXTURE_SIZE, 2048],
    [GL.MAX_ARRAY_TEXTURE_LAYERS, 2048],
    [GL.MAX_DRAW_BUFFERS, 8],
    [GL.MAX_COLOR_ATTACHMENTS, 8],
    [GL.MAX_VERTEX_OUTPUT_COMPONENTS, 64],
    [GL.MAX_FRAGMENT_INPUT_COMPONENTS, 128],
    [GL.MIN_PROGRAM_TEXEL_OFFSET, -8],
    [GL.MAX_PROGRAM_TEXEL_OFFSET, 7],
    [GL.MAX_SAMPLES, 16],
    [GL.MAX_UNIFORM_BUFFER_BINDINGS, 60],
    [GL.MAX_UNIFORM_BLOCK_SIZE, 65536],
    [GL.MAX_VERTEX_UNIFORM_BLOCKS, 14],
    [GL.MAX_FRAGMENT_UNIFORM_BLOCKS, 14],
    [GL.MAX_COMBINED_UNIFORM_BLOCKS, 28],
    // —— Phase 1.9b 新增（CreepJS short list） ——
    [GL.MAX_ELEMENTS_VERTICES, 1048575],
    [GL.MAX_ELEMENTS_INDICES, 1048575],
    [GL.MAX_TEXTURE_LOD_BIAS, 15],
    [GL.MAX_FRAGMENT_UNIFORM_COMPONENTS, 16384],
    [GL.MAX_VERTEX_UNIFORM_COMPONENTS, 16384],
    [GL.MAX_VARYING_COMPONENTS, 124],
    [GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS, 4],
    [GL.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS, 128],
    [GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS, 4],
    [GL.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS, 245760],
    [GL.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS, 245760],
    [GL.MAX_SERVER_WAIT_TIMEOUT, 0],
    [GL.MAX_ELEMENT_INDEX, 0xfffffffe],
    [GL.MAX_CLIENT_WAIT_TIMEOUT_WEBGL, 0],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// NVIDIA GeForce RTX 3060 (Ampere GA106) / Win11 / Chrome / ANGLE Direct3D11
//
// 数据来源（公开 fingerprint 数据库聚合）：
//   - webglreport.com 收录的 RTX 30 系列 Chrome+ANGLE 真机 capture
//   - browserleaks.com/webgl 数据库 NVIDIA Ampere 用户片段
//   - ANGLE D3D11 backend src（github.com/google/angle src/libANGLE/renderer/d3d/d3d11）
//
// 关键差异点（与 Intel iGPU 对比）：
//   - MAX_VIEWPORT_DIMS: [32767, 32767]（Ampere D3D feature level 11_1 上限，
//     Intel iGPU 报告 16384）
//   - MAX_VERTEX_TEXTURE_IMAGE_UNITS / MAX_TEXTURE_IMAGE_UNITS: 32（Intel 16）
//   - MAX_COMBINED_TEXTURE_IMAGE_UNITS: 64（Intel 32）
//   - MAX_3D_TEXTURE_SIZE / MAX_ARRAY_TEXTURE_LAYERS: 16384（Intel 2048）
//   - ALIASED_POINT_SIZE_RANGE: [1, 63]（Intel 报告 [1, 1024]）
//
// 注：CreepJS 静态白名单不收录此 hash（Phase 2.2 Part 2 数学结论：blind hit
// 几率 5.5e-8）。本 profile **不消除 creepjs.com WebGL bold-fail**，仅给用户
// "NVIDIA persona" 替代 Intel iGPU 的选项 —— 其他 detector（browserleaks-webgl /
// arh-antoinevastel / incolumitas 等）不用 CreepJS 白名单。
// ─────────────────────────────────────────────────────────────────────────────

export const NVIDIA_RTX_3060_D3D11: WebglProfile = {
  id: 'nvidia-rtx-3060-d3d11',
  name: 'NVIDIA GeForce RTX 3060 / Direct3D11 / Win',
  matchRenderer: /RTX 3060\b/,
  knownInCreepjsWhitelist: false, // 真实 RTX 3060 用户也大概率不在白名单（数据 gap）
  webgl1: new Map<number, GlParamValue>([
    // —— String params (Chrome+ANGLE 全机器统一) ——
    [GL.VENDOR, 'WebKit'],
    [GL.RENDERER, 'WebKit WebGL'],
    [GL.VERSION, 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'],
    [GL.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)'],
    // —— Stencil state initial values ——
    [GL.STENCIL_VALUE_MASK, 0x7fffffff],
    [GL.STENCIL_WRITEMASK, 0x7fffffff],
    [GL.STENCIL_BACK_VALUE_MASK, 0x7fffffff],
    [GL.STENCIL_BACK_WRITEMASK, 0x7fffffff],
    // —— Texture caps (D3D feature level 11_1 上限) ——
    [GL.MAX_TEXTURE_SIZE, 16384],
    [GL.MAX_CUBE_MAP_TEXTURE_SIZE, 16384],
    [GL.MAX_RENDERBUFFER_SIZE, 16384],
    [GL.MAX_VIEWPORT_DIMS, [32767, 32767]], // NVIDIA 上比 Intel 大 2x
    // —— Shader caps (Ampere 高于 Intel iGPU) ——
    [GL.MAX_VERTEX_ATTRIBS, 16],
    [GL.MAX_VERTEX_UNIFORM_VECTORS, 4096],
    [GL.MAX_VARYING_VECTORS, 30],
    [GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 32], // NVIDIA 32 vs Intel 16
    [GL.MAX_TEXTURE_IMAGE_UNITS, 32], // NVIDIA 32 vs Intel 16
    [GL.MAX_FRAGMENT_UNIFORM_VECTORS, 1024],
    [GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 64], // NVIDIA 64 vs Intel 32
    // —— Aliased ranges (NVIDIA 点大小上限 < Intel) ——
    [GL.ALIASED_LINE_WIDTH_RANGE, [1, 1]],
    [GL.ALIASED_POINT_SIZE_RANGE, [1, 63]], // NVIDIA [1, 63] vs Intel [1, 1024]
    // —— Color / depth / stencil bits ——
    [GL.RED_BITS, 8],
    [GL.GREEN_BITS, 8],
    [GL.BLUE_BITS, 8],
    [GL.ALPHA_BITS, 8],
    [GL.DEPTH_BITS, 24],
    [GL.STENCIL_BITS, 8],
    [GL.SUBPIXEL_BITS, 4],
    // —— MSAA ——
    [GL.SAMPLES, 0],
    [GL.SAMPLE_BUFFERS, 0],
  ]),
  webgl2: new Map<number, GlParamValue>([
    [GL.VERSION, 'WebGL 2.0 (OpenGL ES 3.0 Chromium)'],
    [GL.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)'],
    // —— WebGL2 caps (NVIDIA Ampere D3D11) ——
    [GL.MAX_3D_TEXTURE_SIZE, 16384], // NVIDIA 16384 vs Intel 2048
    [GL.MAX_ARRAY_TEXTURE_LAYERS, 16384], // NVIDIA 16384 vs Intel 2048
    [GL.MAX_DRAW_BUFFERS, 8],
    [GL.MAX_COLOR_ATTACHMENTS, 8],
    [GL.MAX_VERTEX_OUTPUT_COMPONENTS, 64],
    [GL.MAX_FRAGMENT_INPUT_COMPONENTS, 128],
    [GL.MIN_PROGRAM_TEXEL_OFFSET, -8],
    [GL.MAX_PROGRAM_TEXEL_OFFSET, 7],
    [GL.MAX_SAMPLES, 32], // NVIDIA 32x MSAA support
    [GL.MAX_UNIFORM_BUFFER_BINDINGS, 84], // NVIDIA Ampere
    [GL.MAX_UNIFORM_BLOCK_SIZE, 65536],
    [GL.MAX_VERTEX_UNIFORM_BLOCKS, 14],
    [GL.MAX_FRAGMENT_UNIFORM_BLOCKS, 14],
    [GL.MAX_COMBINED_UNIFORM_BLOCKS, 84], // NVIDIA Ampere
    // —— Phase 1.9b CreepJS short list ——
    [GL.MAX_ELEMENTS_VERTICES, 1048575],
    [GL.MAX_ELEMENTS_INDICES, 1048575],
    [GL.MAX_TEXTURE_LOD_BIAS, 15],
    [GL.MAX_FRAGMENT_UNIFORM_COMPONENTS, 16384],
    [GL.MAX_VERTEX_UNIFORM_COMPONENTS, 16384],
    [GL.MAX_VARYING_COMPONENTS, 124],
    [GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS, 4],
    [GL.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS, 128],
    [GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS, 4],
    [GL.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS, 245760],
    [GL.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS, 245760],
    [GL.MAX_SERVER_WAIT_TIMEOUT, 0],
    [GL.MAX_ELEMENT_INDEX, 0xfffffffe],
    [GL.MAX_CLIENT_WAIT_TIMEOUT_WEBGL, 0],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// AMD Radeon RX 6600 (RDNA2 Navi 23) / Win11 / Chrome / ANGLE Direct3D11
//
// 数据来源：browserleaks.com/webgl 数据库 AMD RDNA2 用户片段 + ANGLE D3D11
// backend 报告。AMD RDNA2 在 D3D11 feature level 11_1 上限与 NVIDIA Ampere 接近，
// 但 MAX_VIEWPORT_DIMS 报告 [16384, 16384]（与 Intel 同），ALIASED_POINT_SIZE_RANGE
// 报告 [1, 1024]（与 Intel 同），核心差异是 MAX_3D_TEXTURE_SIZE / MAX_ARRAY_TEXTURE_LAYERS
// 高于 Intel iGPU。
//
// 同样不在 CreepJS 白名单内（Phase 2.2 Part 2 结论）。
// ─────────────────────────────────────────────────────────────────────────────

export const AMD_RX_6600_D3D11: WebglProfile = {
  id: 'amd-rx-6600-d3d11',
  name: 'AMD Radeon RX 6600 / Direct3D11 / Win',
  matchRenderer: /RX 6600\b/,
  knownInCreepjsWhitelist: false,
  webgl1: new Map<number, GlParamValue>([
    [GL.VENDOR, 'WebKit'],
    [GL.RENDERER, 'WebKit WebGL'],
    [GL.VERSION, 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'],
    [GL.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)'],
    [GL.STENCIL_VALUE_MASK, 0x7fffffff],
    [GL.STENCIL_WRITEMASK, 0x7fffffff],
    [GL.STENCIL_BACK_VALUE_MASK, 0x7fffffff],
    [GL.STENCIL_BACK_WRITEMASK, 0x7fffffff],
    // —— Texture caps (RDNA2 D3D11 上限与 Intel iGPU 同) ——
    [GL.MAX_TEXTURE_SIZE, 16384],
    [GL.MAX_CUBE_MAP_TEXTURE_SIZE, 16384],
    [GL.MAX_RENDERBUFFER_SIZE, 16384],
    [GL.MAX_VIEWPORT_DIMS, [16384, 16384]], // AMD RDNA2 与 Intel 同
    // —— Shader caps (RDNA2 高于 Intel iGPU) ——
    [GL.MAX_VERTEX_ATTRIBS, 16],
    [GL.MAX_VERTEX_UNIFORM_VECTORS, 4096],
    [GL.MAX_VARYING_VECTORS, 30],
    [GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 32], // RDNA2 32 vs Intel 16
    [GL.MAX_TEXTURE_IMAGE_UNITS, 32], // RDNA2 32 vs Intel 16
    [GL.MAX_FRAGMENT_UNIFORM_VECTORS, 1024],
    [GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 64], // RDNA2 64 vs Intel 32
    // —— Aliased ranges (AMD 上限与 Intel 同) ——
    [GL.ALIASED_LINE_WIDTH_RANGE, [1, 1]],
    [GL.ALIASED_POINT_SIZE_RANGE, [1, 1024]], // AMD 与 Intel 同
    [GL.RED_BITS, 8],
    [GL.GREEN_BITS, 8],
    [GL.BLUE_BITS, 8],
    [GL.ALPHA_BITS, 8],
    [GL.DEPTH_BITS, 24],
    [GL.STENCIL_BITS, 8],
    [GL.SUBPIXEL_BITS, 4],
    [GL.SAMPLES, 0],
    [GL.SAMPLE_BUFFERS, 0],
  ]),
  webgl2: new Map<number, GlParamValue>([
    [GL.VERSION, 'WebGL 2.0 (OpenGL ES 3.0 Chromium)'],
    [GL.SHADING_LANGUAGE_VERSION, 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)'],
    // —— WebGL2 caps (RDNA2 D3D11) ——
    [GL.MAX_3D_TEXTURE_SIZE, 16384], // RDNA2 16384 vs Intel 2048
    [GL.MAX_ARRAY_TEXTURE_LAYERS, 16384], // RDNA2 16384 vs Intel 2048
    [GL.MAX_DRAW_BUFFERS, 8],
    [GL.MAX_COLOR_ATTACHMENTS, 8],
    [GL.MAX_VERTEX_OUTPUT_COMPONENTS, 64],
    [GL.MAX_FRAGMENT_INPUT_COMPONENTS, 128],
    [GL.MIN_PROGRAM_TEXEL_OFFSET, -8],
    [GL.MAX_PROGRAM_TEXEL_OFFSET, 7],
    [GL.MAX_SAMPLES, 16], // AMD 16x MSAA (Intel 16, NVIDIA 32)
    [GL.MAX_UNIFORM_BUFFER_BINDINGS, 72], // RDNA2 reports 72
    [GL.MAX_UNIFORM_BLOCK_SIZE, 65536],
    [GL.MAX_VERTEX_UNIFORM_BLOCKS, 14],
    [GL.MAX_FRAGMENT_UNIFORM_BLOCKS, 14],
    [GL.MAX_COMBINED_UNIFORM_BLOCKS, 72],
    // —— Phase 1.9b CreepJS short list ——
    [GL.MAX_ELEMENTS_VERTICES, 1048575],
    [GL.MAX_ELEMENTS_INDICES, 1048575],
    [GL.MAX_TEXTURE_LOD_BIAS, 15],
    [GL.MAX_FRAGMENT_UNIFORM_COMPONENTS, 16384],
    [GL.MAX_VERTEX_UNIFORM_COMPONENTS, 16384],
    [GL.MAX_VARYING_COMPONENTS, 124],
    [GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS, 4],
    [GL.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS, 128],
    [GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS, 4],
    [GL.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS, 245760],
    [GL.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS, 245760],
    [GL.MAX_SERVER_WAIT_TIMEOUT, 0],
    [GL.MAX_ELEMENT_INDEX, 0xfffffffe],
    [GL.MAX_CLIENT_WAIT_TIMEOUT_WEBGL, 0],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// Profile selector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 已知 profile 清单。按数组顺序匹配 `webglRenderer`，第一个 match 的胜出。
 * 添加新 profile：在数组里增 entry + 在上方导出常量。
 *
 * 注意：UHD 630 排在 UHD 730 之前，因为 `\b630\b` regex 更严格（避免 730 字符串
 * 含 "630" 子串误匹配）。当前 4 个正则互斥，顺序无影响，但保持 specificity 排序。
 *
 * Phase 4.3 新加 NVIDIA + AMD desktop GPU profile，给用户 4 个 GPU persona 选项：
 *   - intel-uhd-630-d3d11 / intel-uhd-730-d3d11 → iGPU 主流（Coffee Lake / Alder Lake）
 *   - nvidia-rtx-3060-d3d11                      → desktop 游戏显卡（Ampere）
 *   - amd-rx-6600-d3d11                          → desktop 游戏显卡（RDNA2）
 */
export const KNOWN_PROFILES: readonly WebglProfile[] = [
  INTEL_UHD_630_D3D11,
  INTEL_UHD_730_D3D11,
  NVIDIA_RTX_3060_D3D11,
  AMD_RX_6600_D3D11,
];

/**
 * 根据 persona 声称的 webglRenderer 字符串挑一个 profile。
 *
 * @returns 匹配到的 profile；若无匹配返回 null（runner.ts 不做 GL param spoof，仅
 *          保留 v0.1 的 UNMASKED_VENDOR/RENDERER 字符串 spoof）。
 */
export function selectWebglProfile(webglRenderer: string): WebglProfile | null {
  for (const profile of KNOWN_PROFILES) {
    if (profile.matchRenderer.test(webglRenderer)) return profile;
  }
  return null;
}

/**
 * 按 profile id 精确查找。Phase 2.1 引入，配合 `Persona.hardware.gpu.webglProfileId`
 * 让用户显式选定 profile（绕过 regex match）。
 *
 * @returns 匹配的 profile；若 id 未注册返回 null。
 */
export function selectWebglProfileById(id: string): WebglProfile | null {
  for (const profile of KNOWN_PROFILES) {
    if (profile.id === id) return profile;
  }
  return null;
}

/**
 * 高层入口：根据 persona 选 profile。
 *
 * 优先级：
 *   1. **显式 override**：`persona.hardware.gpu.webglProfileId` 非空 → 按 id 查；
 *      未找到时降级到 regex match（避免 typo 直接 disable spoof）
 *   2. **隐式 regex**：按 `webglRenderer` 字符串匹配 `KNOWN_PROFILES`
 *
 * 这个函数被 build-config.ts 使用；`selectWebglProfile` 保留作为更底层 API。
 *
 * @returns 选中的 profile，或 null（runner.ts 跳过 GL param spoof，回到 v0.1 行为）
 */
export function selectWebglProfileForPersona(input: {
  webglRenderer: string;
  webglProfileId?: string | undefined;
}): WebglProfile | null {
  if (input.webglProfileId) {
    const explicit = selectWebglProfileById(input.webglProfileId);
    if (explicit) return explicit;
    // 落到 regex match —— 不强 fail，避免 typo 误关 spoof
  }
  return selectWebglProfile(input.webglRenderer);
}

/**
 * 序列化版本：把 Map<number, GlParamValue> 降级成 Record<string, ...>，便于
 * 通过 init script JSON.stringify 进 page context。key 是 hex 字符串（`"0x0d33"`），
 * value 是 number 或 number[]。
 *
 * runner.ts 用对称的 deserialization 重建 Map + typed array。
 */
export interface SerializedWebglProfile {
  /** Phase 2.1: profile id（debug 友好；runner.ts 暂不读，但 diagnose 工具可用） */
  readonly id: string;
  readonly name: string;
  readonly webgl1: Readonly<Record<string, GlParamValue>>;
  readonly webgl2: Readonly<Record<string, GlParamValue>>;
}

export function serializeProfile(profile: WebglProfile): SerializedWebglProfile {
  const dump = (m: ReadonlyMap<number, GlParamValue>): Record<string, GlParamValue> => {
    const out: Record<string, GlParamValue> = {};
    for (const [k, v] of m) {
      // hex 字符串便于诊断；JSON.parse 后转 number 再用
      out[`0x${k.toString(16)}`] = v;
    }
    return out;
  };
  return {
    id: profile.id,
    name: profile.name,
    webgl1: dump(profile.webgl1),
    webgl2: dump(profile.webgl2),
  };
}
