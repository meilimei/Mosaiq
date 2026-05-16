/**
 * webgl-profiles.test.ts — 验证 Phase 1.9 GL 参数表的查找 + 序列化逻辑。
 *
 * 重点：profile 选择与 serialization 是 pure function，可在 node 直接测；
 * runner.ts §4 在 chromium 内的实际 spoof 由 bench/diagnose-webgl.ts e2e 覆盖。
 */

import { describe, expect, it } from 'vitest';

import {
  FLOAT32_ARRAY_PARAMS,
  GL,
  INT32_ARRAY_PARAMS,
  INTEL_UHD_630_D3D11,
  INTEL_UHD_730_D3D11,
  KNOWN_PROFILES,
  STRING_PARAMS,
  selectWebglProfile,
  selectWebglProfileById,
  selectWebglProfileForPersona,
  serializeProfile,
} from './webgl-profiles.js';

describe('GL constants', () => {
  it('hex 值与 WebGL spec 一致（不让 typo 静默生效）', () => {
    // Spot-check 几个常量，对照 WebGL spec (Khronos)
    expect(GL.MAX_TEXTURE_SIZE).toBe(0x0d33);
    expect(GL.MAX_VIEWPORT_DIMS).toBe(0x0d3a);
    expect(GL.MAX_VERTEX_ATTRIBS).toBe(0x8869);
    expect(GL.ALIASED_LINE_WIDTH_RANGE).toBe(0x846e);
    expect(GL.ALIASED_POINT_SIZE_RANGE).toBe(0x846d);
    expect(GL.MAX_3D_TEXTURE_SIZE).toBe(0x8073);
    expect(GL.MAX_DRAW_BUFFERS).toBe(0x8824);
  });

  it('INT32_ARRAY_PARAMS / FLOAT32_ARRAY_PARAMS 不重叠', () => {
    const overlap = [...INT32_ARRAY_PARAMS].filter((p) => FLOAT32_ARRAY_PARAMS.has(p));
    expect(overlap).toEqual([]);
  });

  it('MAX_VIEWPORT_DIMS 是 Int32Array; ALIASED ranges 是 Float32Array', () => {
    expect(INT32_ARRAY_PARAMS.has(GL.MAX_VIEWPORT_DIMS)).toBe(true);
    expect(FLOAT32_ARRAY_PARAMS.has(GL.ALIASED_LINE_WIDTH_RANGE)).toBe(true);
    expect(FLOAT32_ARRAY_PARAMS.has(GL.ALIASED_POINT_SIZE_RANGE)).toBe(true);
  });

  it('STRING_PARAMS 包含 4 个 string-typed pname', () => {
    expect(STRING_PARAMS.size).toBe(4);
    expect(STRING_PARAMS.has(GL.VENDOR)).toBe(true);
    expect(STRING_PARAMS.has(GL.RENDERER)).toBe(true);
    expect(STRING_PARAMS.has(GL.VERSION)).toBe(true);
    expect(STRING_PARAMS.has(GL.SHADING_LANGUAGE_VERSION)).toBe(true);
  });

  it('STRING_PARAMS / INT32 / FLOAT32 三组互不重叠', () => {
    const allPnameSets = [STRING_PARAMS, INT32_ARRAY_PARAMS, FLOAT32_ARRAY_PARAMS];
    const seen = new Set<number>();
    for (const set of allPnameSets) {
      for (const p of set) {
        expect(seen.has(p)).toBe(false);
        seen.add(p);
      }
    }
  });

  it('Phase 1.9b 新增 GL constants hex 值正确（CreepJS short list）', () => {
    expect(GL.VENDOR).toBe(0x1f00);
    expect(GL.RENDERER).toBe(0x1f01);
    expect(GL.VERSION).toBe(0x1f02);
    expect(GL.SHADING_LANGUAGE_VERSION).toBe(0x8b8c);
    expect(GL.STENCIL_VALUE_MASK).toBe(0x0b93);
    expect(GL.STENCIL_BACK_VALUE_MASK).toBe(0x8ca4);
    expect(GL.MAX_ELEMENTS_VERTICES).toBe(0x80e8);
    expect(GL.MAX_ELEMENTS_INDICES).toBe(0x80e9);
    expect(GL.MAX_TEXTURE_LOD_BIAS).toBe(0x84fd);
    expect(GL.MAX_FRAGMENT_UNIFORM_COMPONENTS).toBe(0x8b49);
    expect(GL.MAX_VARYING_COMPONENTS).toBe(0x8b4b);
    expect(GL.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS).toBe(0x8c8a);
    expect(GL.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS).toBe(0x8a31);
    expect(GL.MAX_ELEMENT_INDEX).toBe(0x8d6b);
    expect(GL.MAX_CLIENT_WAIT_TIMEOUT_WEBGL).toBe(0x9247);
  });
});

describe('INTEL_UHD_730_D3D11 profile', () => {
  it('matchRenderer 匹配 win11-chrome-us 模板的 webglRenderer', () => {
    const personaRenderer =
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    expect(INTEL_UHD_730_D3D11.matchRenderer.test(personaRenderer)).toBe(true);
  });

  it('matchRenderer 不会误伤 Mesa / Apple M2', () => {
    // 注：Phase 2.2 后 UHD 630 有专用 profile，在 selectWebglProfileForPersona 里会被选中；
    // 这里仅验证 UHD 730 的 regex 不跨匹配到 UHD 630。
    expect(
      INTEL_UHD_730_D3D11.matchRenderer.test(
        'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ),
    ).toBe(false);
    const others = [
      'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2) (0x00009BC4), OpenGL 4.6 ...)',
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    ];
    for (const r of others) {
      expect(INTEL_UHD_730_D3D11.matchRenderer.test(r)).toBe(false);
    }
  });

  it('WebGL1 表覆盖 ≥ 20 个 capability 参数（涵盖 CreepJS hash 的核心 surface）', () => {
    expect(INTEL_UHD_730_D3D11.webgl1.size).toBeGreaterThanOrEqual(20);
  });

  it('WebGL1 表关键参数值与真机 capture 一致', () => {
    const m = INTEL_UHD_730_D3D11.webgl1;
    expect(m.get(GL.MAX_TEXTURE_SIZE)).toBe(16384);
    expect(m.get(GL.MAX_CUBE_MAP_TEXTURE_SIZE)).toBe(16384);
    expect(m.get(GL.MAX_RENDERBUFFER_SIZE)).toBe(16384);
    expect(m.get(GL.MAX_VERTEX_ATTRIBS)).toBe(16);
    expect(m.get(GL.MAX_TEXTURE_IMAGE_UNITS)).toBe(16);
    expect(m.get(GL.MAX_FRAGMENT_UNIFORM_VECTORS)).toBe(1024);
    expect(m.get(GL.RED_BITS)).toBe(8);
    expect(m.get(GL.DEPTH_BITS)).toBe(24);
    expect(m.get(GL.STENCIL_BITS)).toBe(8);
  });

  it('WebGL1 表 typed-array 参数返回 number[]（序列化友好）', () => {
    const m = INTEL_UHD_730_D3D11.webgl1;
    expect(m.get(GL.MAX_VIEWPORT_DIMS)).toEqual([16384, 16384]);
    expect(m.get(GL.ALIASED_LINE_WIDTH_RANGE)).toEqual([1, 1]);
    expect(m.get(GL.ALIASED_POINT_SIZE_RANGE)).toEqual([1, 1024]);
  });

  it('WebGL2 表包含 WebGL2-only 参数（不与 WebGL1 重复）', () => {
    const m2 = INTEL_UHD_730_D3D11.webgl2;
    expect(m2.get(GL.MAX_3D_TEXTURE_SIZE)).toBe(2048);
    expect(m2.get(GL.MAX_DRAW_BUFFERS)).toBe(8);
    expect(m2.get(GL.MAX_COLOR_ATTACHMENTS)).toBe(8);
    expect(m2.get(GL.MAX_FRAGMENT_INPUT_COMPONENTS)).toBe(128);

    // WebGL1 参数不应出现在 WebGL2 表里（runner.ts 自己 merge 给 WebGL2 context）
    expect(m2.has(GL.MAX_TEXTURE_SIZE)).toBe(false);
    expect(m2.has(GL.MAX_VERTEX_ATTRIBS)).toBe(false);
  });

  /**
   * Phase 1.9b：CreepJS 用 49 个 named params hash WebGL fingerprint。
   * 此 test 套验证 INTEL_UHD_730_D3D11 完整覆盖该 short list。
   */
  it('WebGL1 表覆盖 string params (VENDOR/RENDERER/VERSION/SHADING_LANGUAGE_VERSION)', () => {
    const m = INTEL_UHD_730_D3D11.webgl1;
    expect(m.get(GL.VENDOR)).toBe('WebKit');
    expect(m.get(GL.RENDERER)).toBe('WebKit WebGL');
    expect(m.get(GL.VERSION)).toBe('WebGL 1.0 (OpenGL ES 2.0 Chromium)');
    expect(m.get(GL.SHADING_LANGUAGE_VERSION)).toBe(
      'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    );
  });

  it('WebGL2 表 string params 应是 WebGL 2.0 版本号（merge 时覆盖 WebGL1）', () => {
    const m2 = INTEL_UHD_730_D3D11.webgl2;
    expect(m2.get(GL.VERSION)).toBe('WebGL 2.0 (OpenGL ES 3.0 Chromium)');
    expect(m2.get(GL.SHADING_LANGUAGE_VERSION)).toBe(
      'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)',
    );
  });

  it('WebGL1 表覆盖 stencil initial state (CreepJS short list)', () => {
    const m = INTEL_UHD_730_D3D11.webgl1;
    // GL ES 2.0 spec 初始值：value mask = max signed int31，writemask = all bits
    // 实测 ANGLE 在 D3D11 上返回 0x7FFFFFFF for both（chromium 对 stencil mask
    // 默认值的处理；CreepJS 的 short list 直接 hash 这个值）
    expect(m.get(GL.STENCIL_VALUE_MASK)).toBe(0x7fffffff);
    expect(m.get(GL.STENCIL_WRITEMASK)).toBe(0x7fffffff);
    expect(m.get(GL.STENCIL_BACK_VALUE_MASK)).toBe(0x7fffffff);
    expect(m.get(GL.STENCIL_BACK_WRITEMASK)).toBe(0x7fffffff);
  });

  it('WebGL2 表覆盖 Phase 1.9b 新增的 14 个 WebGL2-only 参数（真机 capture 数据）', () => {
    const m2 = INTEL_UHD_730_D3D11.webgl2;
    // 来源：browserleaks-webgl Real-device capture (Intel UHD 730 / Win11 / Chrome 147)
    expect(m2.get(GL.MAX_ELEMENTS_VERTICES)).toBe(1048575);
    expect(m2.get(GL.MAX_ELEMENTS_INDICES)).toBe(1048575);
    expect(m2.get(GL.MAX_TEXTURE_LOD_BIAS)).toBe(15);
    expect(m2.get(GL.MAX_FRAGMENT_UNIFORM_COMPONENTS)).toBe(16384);
    expect(m2.get(GL.MAX_VERTEX_UNIFORM_COMPONENTS)).toBe(16384);
    expect(m2.get(GL.MAX_VARYING_COMPONENTS)).toBe(124);
    expect(m2.get(GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS)).toBe(4);
    expect(m2.get(GL.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS)).toBe(128);
    expect(m2.get(GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS)).toBe(4);
    expect(m2.get(GL.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS)).toBe(245760);
    expect(m2.get(GL.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS)).toBe(245760);
    expect(m2.get(GL.MAX_SERVER_WAIT_TIMEOUT)).toBe(0);
    expect(m2.get(GL.MAX_ELEMENT_INDEX)).toBe(0xfffffffe);
    expect(m2.get(GL.MAX_CLIENT_WAIT_TIMEOUT_WEBGL)).toBe(0);
  });

  it('CreepJS 49-param short list 覆盖率 ≥ 100% (WebGL1 ∪ WebGL2)', () => {
    // CreepJS src/webgl/index.ts getParamNames() 公开列表（去除 commented out）
    const creepjsShortList = new Set([
      GL.ALIASED_POINT_SIZE_RANGE,
      GL.ALIASED_LINE_WIDTH_RANGE,
      GL.STENCIL_VALUE_MASK,
      GL.STENCIL_WRITEMASK,
      GL.STENCIL_BACK_VALUE_MASK,
      GL.STENCIL_BACK_WRITEMASK,
      GL.MAX_TEXTURE_SIZE,
      GL.MAX_VIEWPORT_DIMS,
      GL.SUBPIXEL_BITS,
      GL.MAX_VERTEX_ATTRIBS,
      GL.MAX_VERTEX_UNIFORM_VECTORS,
      GL.MAX_VARYING_VECTORS,
      GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS,
      GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS,
      GL.MAX_TEXTURE_IMAGE_UNITS,
      GL.MAX_FRAGMENT_UNIFORM_VECTORS,
      GL.SHADING_LANGUAGE_VERSION,
      GL.VENDOR,
      GL.RENDERER,
      GL.VERSION,
      GL.MAX_CUBE_MAP_TEXTURE_SIZE,
      GL.MAX_RENDERBUFFER_SIZE,
      GL.MAX_3D_TEXTURE_SIZE,
      GL.MAX_ELEMENTS_VERTICES,
      GL.MAX_ELEMENTS_INDICES,
      GL.MAX_TEXTURE_LOD_BIAS,
      GL.MAX_DRAW_BUFFERS,
      GL.MAX_FRAGMENT_UNIFORM_COMPONENTS,
      GL.MAX_VERTEX_UNIFORM_COMPONENTS,
      GL.MAX_ARRAY_TEXTURE_LAYERS,
      GL.MAX_PROGRAM_TEXEL_OFFSET,
      GL.MAX_VARYING_COMPONENTS,
      GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS,
      GL.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS,
      GL.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS,
      GL.MAX_COLOR_ATTACHMENTS,
      GL.MAX_SAMPLES,
      GL.MAX_VERTEX_UNIFORM_BLOCKS,
      GL.MAX_FRAGMENT_UNIFORM_BLOCKS,
      GL.MAX_COMBINED_UNIFORM_BLOCKS,
      GL.MAX_UNIFORM_BUFFER_BINDINGS,
      GL.MAX_UNIFORM_BLOCK_SIZE,
      GL.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS,
      GL.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS,
      GL.MAX_VERTEX_OUTPUT_COMPONENTS,
      GL.MAX_FRAGMENT_INPUT_COMPONENTS,
      GL.MAX_SERVER_WAIT_TIMEOUT,
      GL.MAX_ELEMENT_INDEX,
      GL.MAX_CLIENT_WAIT_TIMEOUT_WEBGL,
    ]);
    // 49 param 期望
    expect(creepjsShortList.size).toBe(49);

    const merged = new Set<number>([
      ...INTEL_UHD_730_D3D11.webgl1.keys(),
      ...INTEL_UHD_730_D3D11.webgl2.keys(),
    ]);
    const uncovered = [...creepjsShortList].filter((p) => !merged.has(p));
    expect(uncovered).toEqual([]);
  });
});

describe('INTEL_UHD_630_D3D11 profile (Phase 2.2)', () => {
  it('matchRenderer 匹配 win10-chrome-us 模板的 webglRenderer', () => {
    const personaRenderer =
      'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    expect(INTEL_UHD_630_D3D11.matchRenderer.test(personaRenderer)).toBe(true);
  });

  it('matchRenderer `\\b630\\b` 不跨匹配 UHD 730 / 6300 / 6300U etc.', () => {
    const negatives = [
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) ...)',
      'NVIDIA GeForce GTX 6300', // 假想 — 防止子串匹配
    ];
    for (const r of negatives) {
      expect(INTEL_UHD_630_D3D11.matchRenderer.test(r)).toBe(false);
    }
  });

  it('id 为 "intel-uhd-630-d3d11"', () => {
    expect(INTEL_UHD_630_D3D11.id).toBe('intel-uhd-630-d3d11');
  });

  it('knownInCreepjsWhitelist 标 undefined（数据未实测白名单命中）', () => {
    expect(INTEL_UHD_630_D3D11.knownInCreepjsWhitelist).toBeUndefined();
  });

  it('WebGL1 / WebGL2 表 size 与 UHD 730 等同（同 ANGLE D3D11 backend）', () => {
    expect(INTEL_UHD_630_D3D11.webgl1.size).toBe(INTEL_UHD_730_D3D11.webgl1.size);
    expect(INTEL_UHD_630_D3D11.webgl2.size).toBe(INTEL_UHD_730_D3D11.webgl2.size);
  });

  it('关键 caps 与 UHD 730 数值一致（ANGLE D3D11 硬限制共享）', () => {
    const a = INTEL_UHD_630_D3D11.webgl1;
    const b = INTEL_UHD_730_D3D11.webgl1;
    for (const pname of [GL.MAX_TEXTURE_SIZE, GL.MAX_VERTEX_ATTRIBS, GL.MAX_RENDERBUFFER_SIZE]) {
      expect(a.get(pname)).toBe(b.get(pname));
    }
  });
});

describe('selectWebglProfile', () => {
  it('Intel UHD 730 renderer → INTEL_UHD_730_D3D11', () => {
    const profile = selectWebglProfile(
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    expect(profile).toBe(INTEL_UHD_730_D3D11);
  });

  it('Intel UHD 630 renderer → INTEL_UHD_630_D3D11 (Phase 2.2)', () => {
    const profile = selectWebglProfile(
      'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    expect(profile).toBe(INTEL_UHD_630_D3D11);
  });

  it('未知 renderer → null（runner.ts 跳过 GL param spoof）', () => {
    expect(selectWebglProfile('ANGLE (NVIDIA, GeForce RTX 4090, D3D11)')).toBeNull();
    expect(selectWebglProfile('Apple M2 Pro')).toBeNull();
    expect(selectWebglProfile('')).toBeNull();
  });

  it('KNOWN_PROFILES 数组顺序决定优先级（specificity 高的在前）', () => {
    // Phase 2.2: UHD 630 的 regex `\b630\b` 更严格（留字界避免抑 730 中含 630三字的问题），
    // 所以排在 UHD 730 之前。当前两 regex 互斥，顺序不影响行为。
    expect(KNOWN_PROFILES.length).toBeGreaterThanOrEqual(2);
    expect(KNOWN_PROFILES.map((p) => p.id)).toContain('intel-uhd-630-d3d11');
    expect(KNOWN_PROFILES.map((p) => p.id)).toContain('intel-uhd-730-d3d11');
  });
});

describe('Phase 2.1: WebglProfile id + selectors', () => {
  it('每个 KNOWN_PROFILES entry 有唯一 id（命名约定 <vendor>-<model>-<backend>）', () => {
    const ids = KNOWN_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // 命名格式：全小写 + 连字符 + 数字
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(id.length).toBeGreaterThanOrEqual(3);
      expect(id.length).toBeLessThanOrEqual(64);
    }
  });

  it('INTEL_UHD_730_D3D11.id === "intel-uhd-730-d3d11"', () => {
    expect(INTEL_UHD_730_D3D11.id).toBe('intel-uhd-730-d3d11');
  });

  it('每个 profile 标注 knownInCreepjsWhitelist（true | false | undefined）', () => {
    for (const p of KNOWN_PROFILES) {
      const v = p.knownInCreepjsWhitelist;
      expect(v === undefined || typeof v === 'boolean').toBe(true);
    }
  });

  it('UHD 730 标记为 knownInCreepjsWhitelist=false（Phase 1.9b 验证）', () => {
    expect(INTEL_UHD_730_D3D11.knownInCreepjsWhitelist).toBe(false);
  });
});

describe('selectWebglProfileById', () => {
  it('id 命中返回对应 profile', () => {
    expect(selectWebglProfileById('intel-uhd-730-d3d11')).toBe(INTEL_UHD_730_D3D11);
  });

  it('id 未注册返回 null（不强 fail）', () => {
    expect(selectWebglProfileById('nonexistent-zzz')).toBeNull();
    expect(selectWebglProfileById('')).toBeNull();
  });
});

describe('selectWebglProfileForPersona', () => {
  /**
   * Phase 2.1 高层入口。验证三类路径：
   *   1. webglProfileId 命中 → 用 id 选（绕过 regex）
   *   2. webglProfileId typo / 未注册 → 降级 regex
   *   3. webglProfileId 未提供 → 走 regex
   */

  const UHD_730 =
    'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)';

  it('webglProfileId 显式命中 → 选 id（绕过 regex）', () => {
    const profile = selectWebglProfileForPersona({
      webglRenderer: 'irrelevant string that does not match any regex',
      webglProfileId: 'intel-uhd-730-d3d11',
    });
    expect(profile).toBe(INTEL_UHD_730_D3D11);
  });

  it('webglProfileId typo → 降级到 regex match（避免 typo 关 spoof）', () => {
    const profile = selectWebglProfileForPersona({
      webglRenderer: UHD_730,
      webglProfileId: 'typo-zzz',
    });
    expect(profile).toBe(INTEL_UHD_730_D3D11); // regex match 兜底
  });

  it('webglProfileId 未提供 → 走 regex（向后兼容旧行为）', () => {
    const profile = selectWebglProfileForPersona({ webglRenderer: UHD_730 });
    expect(profile).toBe(INTEL_UHD_730_D3D11);
  });

  it('webglProfileId 未提供 + renderer 不 match → null', () => {
    const profile = selectWebglProfileForPersona({
      webglRenderer: 'ANGLE (NVIDIA, GeForce RTX 4090, D3D11)',
    });
    expect(profile).toBeNull();
  });

  it('webglProfileId 显式 + 同 id → 等同于 regex 选择结果', () => {
    const a = selectWebglProfileForPersona({
      webglRenderer: UHD_730,
      webglProfileId: 'intel-uhd-730-d3d11',
    });
    const b = selectWebglProfileForPersona({ webglRenderer: UHD_730 });
    expect(a).toBe(b);
  });
});

describe('serializeProfile', () => {
  it('Map<number, ...> → Record<hex string, ...>', () => {
    const ser = serializeProfile(INTEL_UHD_730_D3D11);
    expect(ser.name).toBe(INTEL_UHD_730_D3D11.name);
    expect(ser.webgl1[`0x${GL.MAX_TEXTURE_SIZE.toString(16)}`]).toBe(16384);
    expect(ser.webgl1[`0x${GL.MAX_VIEWPORT_DIMS.toString(16)}`]).toEqual([16384, 16384]);
    expect(ser.webgl2[`0x${GL.MAX_3D_TEXTURE_SIZE.toString(16)}`]).toBe(2048);
  });

  it('Phase 2.1: serialize 保留 id 字段', () => {
    const ser = serializeProfile(INTEL_UHD_730_D3D11);
    expect(ser.id).toBe('intel-uhd-730-d3d11');
  });

  it('序列化结果可 JSON.parse / JSON.stringify 往返不变', () => {
    const ser = serializeProfile(INTEL_UHD_730_D3D11);
    const roundTrip = JSON.parse(JSON.stringify(ser));
    expect(roundTrip).toEqual(ser);
  });

  it('Key 是合法 hex（runner.ts 用 parseInt(hex, 16) 还原）', () => {
    const ser = serializeProfile(INTEL_UHD_730_D3D11);
    for (const key of Object.keys(ser.webgl1)) {
      expect(key).toMatch(/^0x[0-9a-f]+$/);
      expect(Number.isFinite(parseInt(key, 16))).toBe(true);
    }
  });

  it('全部 WebGL1 entry 都被序列化（无 entry 丢失）', () => {
    const ser = serializeProfile(INTEL_UHD_730_D3D11);
    expect(Object.keys(ser.webgl1)).toHaveLength(INTEL_UHD_730_D3D11.webgl1.size);
    expect(Object.keys(ser.webgl2)).toHaveLength(INTEL_UHD_730_D3D11.webgl2.size);
  });
});
