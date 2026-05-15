/**
 * diagnose-creepjs-webgl-hash — 验证 WebGL bold-fail 是否由 CreepJS hardcoded
 * brandCapabilities/capabilities 白名单未收录我们 GPU 的 hash 引起。
 *
 * CreepJS 的 LowerEntropy.WEBGL 触发条件：
 *   1. webglBrandCapabilities = hashMini([gpuBrand, sortedNumericParams])
 *   2. webglCapabilities = sortedParams.reduce((acc, v, i) => acc ^ (v+i), 0)
 *   3. 如果 hash 不在 brandCapabilities[] / capabilities[] 白名单 → suspicious → bold-fail
 *
 * 用法：tsx bench/diagnose-creepjs-webgl-hash.ts
 *
 * 输出：我们的 webglParams sorted unique numbers + 计算 hashes，以及是否 in 白名单。
 */

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import { deletePersona, launchPersona, personaExists, savePersona } from '../src/index.js';

const PERSONA_ID = `diag-webgl-hash-${Date.now().toString(36)}`;

async function main() {
  const persona = createWin11ChromeUsPersona({ id: PERSONA_ID, displayName: 'WebglHashDiag' });
  await savePersona(persona);

  let session: Awaited<ReturnType<typeof launchPersona>> | undefined;
  try {
    session = await launchPersona(persona, { headless: true });
    const page = await session.firstPage();
    await page.goto('about:blank');

    const probe = await page.evaluate(() => {
      // 重现 CreepJS getCanvasWebgl() 的 Analysis 计算
      const out: Record<string, unknown> = {};

      // 用 document canvas（OffscreenCanvas 不支持 WEBGL_debug_renderer_info）
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const canvas2 = document.createElement('canvas');
      canvas2.width = 256;
      canvas2.height = 256;
      const gl = (canvas.getContext('webgl') ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (canvas as any).getContext('experimental-webgl')) as WebGLRenderingContext;
      const gl2 = canvas2.getContext('webgl2') as WebGL2RenderingContext;

      // 加 UNMASKED_*_WEBGL 进 merged params（CreepJS getUnmasked 行为）
      const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
      const dbgUnmaskedRenderer = dbgExt
        ? gl.getParameter(
            (dbgExt as unknown as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL,
          )
        : null;
      const dbgUnmaskedVendor = dbgExt
        ? gl.getParameter(
            (dbgExt as unknown as { UNMASKED_VENDOR_WEBGL: number }).UNMASKED_VENDOR_WEBGL,
          )
        : null;

      // CreepJS short list (49 params)
      const paramNames = [
        'ALIASED_POINT_SIZE_RANGE', 'ALIASED_LINE_WIDTH_RANGE',
        'STENCIL_VALUE_MASK', 'STENCIL_WRITEMASK',
        'STENCIL_BACK_VALUE_MASK', 'STENCIL_BACK_WRITEMASK',
        'MAX_TEXTURE_SIZE', 'MAX_VIEWPORT_DIMS', 'SUBPIXEL_BITS',
        'MAX_VERTEX_ATTRIBS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS',
        'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
        'MAX_TEXTURE_IMAGE_UNITS', 'MAX_FRAGMENT_UNIFORM_VECTORS',
        'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER', 'VERSION',
        'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_3D_TEXTURE_SIZE',
        'MAX_ELEMENTS_VERTICES', 'MAX_ELEMENTS_INDICES', 'MAX_TEXTURE_LOD_BIAS',
        'MAX_DRAW_BUFFERS', 'MAX_FRAGMENT_UNIFORM_COMPONENTS',
        'MAX_VERTEX_UNIFORM_COMPONENTS', 'MAX_ARRAY_TEXTURE_LAYERS',
        'MAX_PROGRAM_TEXEL_OFFSET', 'MAX_VARYING_COMPONENTS',
        'MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS',
        'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS',
        'MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS',
        'MAX_COLOR_ATTACHMENTS', 'MAX_SAMPLES',
        'MAX_VERTEX_UNIFORM_BLOCKS', 'MAX_FRAGMENT_UNIFORM_BLOCKS',
        'MAX_COMBINED_UNIFORM_BLOCKS', 'MAX_UNIFORM_BUFFER_BINDINGS',
        'MAX_UNIFORM_BLOCK_SIZE', 'MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS',
        'MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS',
        'MAX_VERTEX_OUTPUT_COMPONENTS', 'MAX_FRAGMENT_INPUT_COMPONENTS',
        'MAX_SERVER_WAIT_TIMEOUT', 'MAX_ELEMENT_INDEX', 'MAX_CLIENT_WAIT_TIMEOUT_WEBGL',
      ];

      const getParams = (g: WebGLRenderingContext | WebGL2RenderingContext) => {
        if (!g) return {};
        const protoNames = Object.getOwnPropertyNames(Object.getPrototypeOf(g))
          .filter((n) => paramNames.includes(n));
        const result: Record<string, unknown> = {};
        for (const name of protoNames) {
          const pname = (g as unknown as Record<string, number>)[name];
          const val = g.getParameter(pname);
          if (val && typeof val === 'object' && 'buffer' in val) {
            result[name] = Array.from(val as Iterable<number>);
          } else {
            result[name] = val;
          }
        }
        return result;
      };

      const params1 = getParams(gl);
      const params2 = getParams(gl2);
      const merged: Record<string, unknown> = { ...params1, ...params2 };
      if (dbgUnmaskedRenderer) merged.UNMASKED_RENDERER_WEBGL = dbgUnmaskedRenderer;
      if (dbgUnmaskedVendor) merged.UNMASKED_VENDOR_WEBGL = dbgUnmaskedVendor;

      // 加 antialias / shader precision / extensions params (CreepJS 完整 data.parameters)
      merged.antialias = gl.getContextAttributes()?.antialias;
      merged.MAX_VIEWPORT_DIMS = Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) ?? []);

      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) {
        merged.MAX_TEXTURE_MAX_ANISOTROPY_EXT = gl.getParameter(
          (ext as unknown as { MAX_TEXTURE_MAX_ANISOTROPY_EXT: number }).MAX_TEXTURE_MAX_ANISOTROPY_EXT,
        );
      }

      const drawBuffersExt = gl.getExtension('WEBGL_draw_buffers');
      if (drawBuffersExt) {
        merged.MAX_DRAW_BUFFERS_WEBGL = gl.getParameter(
          (drawBuffersExt as unknown as { MAX_DRAW_BUFFERS_WEBGL: number }).MAX_DRAW_BUFFERS_WEBGL,
        );
      }

      // shader precision (24 fields)
      const shaderTypes = ['VERTEX_SHADER', 'FRAGMENT_SHADER'] as const;
      const precisions = ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'HIGH_INT'] as const;
      for (const st of shaderTypes) {
        for (const p of precisions) {
          const fmt = gl.getShaderPrecisionFormat(
            (gl as unknown as Record<string, number>)[st],
            (gl as unknown as Record<string, number>)[p],
          );
          if (fmt) {
            merged[`${st}.${p}.precision`] = fmt.precision;
            merged[`${st}.${p}.rangeMax`] = fmt.rangeMax;
            merged[`${st}.${p}.rangeMin`] = fmt.rangeMin;
          }
        }
      }

      // CreepJS webglParams 计算（移植）
      const webglParamsRaw = Object.values(merged)
        .filter((v) => v && typeof v !== 'string')
        .flat()
        .map((v) => Number(v));
      const webglParams = [...new Set(webglParamsRaw)].sort((a: number, b: number) => a - b);
      const webglParamsStr = String(webglParams);

      out.parameters = merged;
      out.webglParams = webglParams;
      out.webglParamsStr = webglParamsStr;
      out.numericValueCount = webglParams.length;

      // hashMini polyfill (CreepJS uses simpler djb2-like hash)
      // See creepjs/src/utils/crypto.ts: hashMini
      // 简易版本：accept any → string → cyrb53 hash → 8-char hex
      const cyrb53 = (str: string, seed = 0): string => {
        let h1 = 0xdeadbeef ^ seed;
        let h2 = 0x41c6ce57 ^ seed;
        for (let i = 0; i < str.length; i++) {
          const ch = str.charCodeAt(i);
          h1 = Math.imul(h1 ^ ch, 2654435761);
          h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        const result = 4294967296 * (2097151 & h2) + (h1 >>> 0);
        return result.toString(16).padStart(13, '0').slice(-8);
      };

      // GPU brand 简易提取（CreepJS getGpuBrand）
      const unmasked = String(merged.UNMASKED_RENDERER_WEBGL || '');
      let gpuBrand = '';
      if (/Intel/i.test(unmasked)) gpuBrand = 'Intel';
      else if (/NVIDIA/i.test(unmasked)) gpuBrand = 'NVIDIA';
      else if (/AMD|Radeon/i.test(unmasked)) gpuBrand = 'AMD';
      else if (/Apple/i.test(unmasked)) gpuBrand = 'Apple';
      else if (/Mali/i.test(unmasked)) gpuBrand = 'Mali';
      else if (/Adreno/i.test(unmasked)) gpuBrand = 'Adreno';

      const brandHash = cyrb53(JSON.stringify([gpuBrand, webglParamsStr]));
      const capabilitiesHash = webglParams.reduce(
        (acc: number, v: number, i: number) => acc ^ (v + i),
        0,
      );

      out.gpuBrand = gpuBrand;
      out.UNMASKED_RENDERER_WEBGL = unmasked;
      out.brandHash_estimated = brandHash;
      out.capabilitiesHash_estimated = capabilitiesHash;
      return out;
    });

    console.log('[diag] Spoofed WebGL fingerprint:');
    console.log(`  UNMASKED_RENDERER_WEBGL: ${probe.UNMASKED_RENDERER_WEBGL}`);
    console.log(`  GPU brand:               ${probe.gpuBrand}`);
    console.log(`  numeric value count:     ${probe.numericValueCount}`);
    console.log(
      `  webglParamsStr length:   ${(probe.webglParamsStr as string).length} chars`,
    );
    console.log(`  webglParams (sorted):    ${probe.webglParamsStr}`);
    console.log(`  brand hash (estimated):  ${probe.brandHash_estimated}`);
    console.log(`  caps hash (estimated):   ${probe.capabilitiesHash_estimated}`);
    console.log(
      '\n  ⚠️  Note: hashMini in actual CreepJS source uses different algo, our estimate',
    );
    console.log('  may diverge. Real validation: visit creepjs.com and check Analysis.');
  } finally {
    if (session) await session.close();
    if (await personaExists(PERSONA_ID)) {
      try {
        deletePersona(PERSONA_ID);
      } catch (e) {
        console.error('[diag] persona cleanup failed', e);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
