/**
 * diagnose-webgl — 在真实 chromium 内验证 WebGL spoof 是否生效。
 *
 * 用法：
 *   pnpm --filter @mosaiq/sdk exec tsx bench/diagnose-webgl.ts
 *   $env:HEADED='1'; pnpm --filter @mosaiq/sdk exec tsx bench/diagnose-webgl.ts
 *
 * 输出：每个 surface 的 expected vs actual 对比。
 *
 * 检查覆盖：
 *   1. WebGLRenderingContext.prototype.getParameter 是否被 hook（toString 检测）
 *   2. WebGL1: getParameter(UNMASKED_VENDOR_WEBGL) / UNMASKED_RENDERER_WEBGL
 *   3. WebGL1: gl.getExtension('WEBGL_debug_renderer_info') → ext.UNMASKED_VENDOR_WEBGL
 *   4. WebGL2: 同上
 *   5. OffscreenCanvas + getContext('webgl') 同样的检查
 *   6. Worker 内（不在 v0.1 范围，记录 NOT_TESTED）
 */

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import { deletePersona, launchPersona, personaExists, savePersona } from '../src/index.js';

const PERSONA_ID = 'webgl-diag' as const;

interface CheckResult {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

async function main() {
  console.log('[diag] starting WebGL spoof diagnostic\n');

  if (personaExists(PERSONA_ID)) deletePersona(PERSONA_ID);
  const persona = createWin11ChromeUsPersona({
    id: PERSONA_ID,
    displayName: 'WebGL Diagnostic',
    masterSeed: 'deadbeef',
  });
  savePersona(persona);

  const expectedVendor = persona.hardware.gpu.webglVendor;
  const expectedRenderer = persona.hardware.gpu.webglRenderer;
  console.log('[diag] persona expects:');
  console.log(`         webglVendor   = "${expectedVendor}"`);
  console.log(`         webglRenderer = "${expectedRenderer}"\n`);

  const headed = process.env.HEADED === '1';
  const session = await launchPersona(persona, { headless: !headed });

  try {
    const page = await session.firstPage();
    // 监听 chromium console 看 runner.ts 的 [mosaiq] 错误是否输出
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[mosaiq]')) console.log(`[chromium console ${msg.type()}] ${text}`);
    });
    await page.goto('about:blank');
    await page.waitForLoadState('domcontentloaded');

    // 在 page context 里跑一组检查
    const probe = await page.evaluate((_expectedRenderer) => {
      void _expectedRenderer;
      const out: Record<string, unknown> = {};

      // Phase 1.9 — GL capability 参数 spoof（Intel UHD 730 reference values）
      // 把每个我们认为 spoof 了的 pname 在 WebGL1 / WebGL2 / OffscreenCanvas 三个
      // context 上都查一遍，全部应该返回 profile 内常量。
      const PHASE_1_9_REFS: Record<string, { pname: number; expected: unknown }> = {
        MAX_TEXTURE_SIZE: { pname: 0x0d33, expected: 16384 },
        MAX_CUBE_MAP_TEXTURE_SIZE: { pname: 0x851c, expected: 16384 },
        MAX_RENDERBUFFER_SIZE: { pname: 0x84e8, expected: 16384 },
        MAX_VERTEX_ATTRIBS: { pname: 0x8869, expected: 16 },
        MAX_VERTEX_UNIFORM_VECTORS: { pname: 0x8dfb, expected: 4096 },
        MAX_VARYING_VECTORS: { pname: 0x8dfc, expected: 30 },
        MAX_TEXTURE_IMAGE_UNITS: { pname: 0x8872, expected: 16 },
        MAX_FRAGMENT_UNIFORM_VECTORS: { pname: 0x8dfd, expected: 1024 },
        MAX_COMBINED_TEXTURE_IMAGE_UNITS: { pname: 0x8b4d, expected: 32 },
        RED_BITS: { pname: 0x0d52, expected: 8 },
        DEPTH_BITS: { pname: 0x0d56, expected: 24 },
        STENCIL_BITS: { pname: 0x0d57, expected: 8 },
      };
      const probeContext = (
        gl: WebGLRenderingContext | WebGL2RenderingContext,
        label: string,
      ) => {
        const result: Record<string, unknown> = {};
        for (const [name, ref] of Object.entries(PHASE_1_9_REFS)) {
          result[name] = gl.getParameter(ref.pname);
        }
        // typed-array 类型保护：MAX_VIEWPORT_DIMS / ALIASED_*_RANGE
        const viewportDims = gl.getParameter(0x0d3a);
        result.MAX_VIEWPORT_DIMS = viewportDims instanceof Int32Array
          ? [viewportDims[0], viewportDims[1]]
          : `WRONG_TYPE:${Object.prototype.toString.call(viewportDims)}`;
        const lineRange = gl.getParameter(0x846e);
        result.ALIASED_LINE_WIDTH_RANGE = lineRange instanceof Float32Array
          ? [lineRange[0], lineRange[1]]
          : `WRONG_TYPE:${Object.prototype.toString.call(lineRange)}`;
        const pointRange = gl.getParameter(0x846d);
        result.ALIASED_POINT_SIZE_RANGE = pointRange instanceof Float32Array
          ? [pointRange[0], pointRange[1]]
          : `WRONG_TYPE:${Object.prototype.toString.call(pointRange)}`;
        out[`phase19_${label}`] = result;
      };
      try {
        const c1p = document.createElement('canvas');
        const gl1p = c1p.getContext('webgl');
        if (gl1p) probeContext(gl1p, 'webgl1');
        const c2p = document.createElement('canvas');
        const gl2p = c2p.getContext('webgl2');
        if (gl2p) probeContext(gl2p, 'webgl2');
        if (typeof OffscreenCanvas !== 'undefined') {
          const ocp = new OffscreenCanvas(64, 64);
          const oglp = ocp.getContext('webgl');
          if (oglp) probeContext(oglp as WebGLRenderingContext, 'offscreen_webgl1');
        }
      } catch (e) {
        out.phase19_error = (e as Error).message;
      }

      // ── 1. Hook 痕迹检测 ─────────────────────────────────────────
      try {
        const gpStr = WebGLRenderingContext.prototype.getParameter.toString();
        out.getParameterToString = gpStr;
        out.getParameterIsHook = !gpStr.includes('[native code]');
      } catch (e) {
        out.getParameterToString = `ERROR: ${(e as Error).message}`;
      }

      // ── 2. WebGL1 直接 getParameter(0x9245 / 0x9246) ─────────────
      try {
        const c1 = document.createElement('canvas');
        const gl1 = c1.getContext('webgl');
        if (!gl1) {
          out.webgl1 = 'CONTEXT_NULL';
        } else {
          out.webgl1_direct_vendor = gl1.getParameter(0x9245);
          out.webgl1_direct_renderer = gl1.getParameter(0x9246);

          const ext1 = gl1.getExtension('WEBGL_debug_renderer_info');
          if (ext1) {
            out.webgl1_ext_vendor = gl1.getParameter(ext1.UNMASKED_VENDOR_WEBGL);
            out.webgl1_ext_renderer = gl1.getParameter(ext1.UNMASKED_RENDERER_WEBGL);
            out.webgl1_ext_constants = {
              UNMASKED_VENDOR_WEBGL: ext1.UNMASKED_VENDOR_WEBGL,
              UNMASKED_RENDERER_WEBGL: ext1.UNMASKED_RENDERER_WEBGL,
            };
          } else {
            out.webgl1_ext = 'NULL';
          }

          out.webgl1_vendor_via_VENDOR = gl1.getParameter(gl1.VENDOR);
          out.webgl1_renderer_via_RENDERER = gl1.getParameter(gl1.RENDERER);
        }
      } catch (e) {
        out.webgl1_error = (e as Error).message;
      }

      // ── 3. WebGL2 ────────────────────────────────────────────────
      try {
        const c2 = document.createElement('canvas');
        const gl2 = c2.getContext('webgl2');
        if (!gl2) {
          out.webgl2 = 'CONTEXT_NULL';
        } else {
          out.webgl2_direct_vendor = gl2.getParameter(0x9245);
          out.webgl2_direct_renderer = gl2.getParameter(0x9246);

          const ext2 = gl2.getExtension('WEBGL_debug_renderer_info');
          if (ext2) {
            out.webgl2_ext_vendor = gl2.getParameter(ext2.UNMASKED_VENDOR_WEBGL);
            out.webgl2_ext_renderer = gl2.getParameter(ext2.UNMASKED_RENDERER_WEBGL);
          }
        }
      } catch (e) {
        out.webgl2_error = (e as Error).message;
      }

      // ── 3.5 Prototype descriptor 检查（仅记录，不再做 in-page spoof 覆盖 — 会污染 OffscreenCanvas 测试）
      try {
        const desc1 = Object.getOwnPropertyDescriptor(
          WebGLRenderingContext.prototype,
          'getParameter',
        );
        out.webgl1_proto_desc = desc1
          ? {
              configurable: desc1.configurable,
              writable: desc1.writable,
              enumerable: desc1.enumerable,
              hasGet: !!desc1.get,
              hasValue: typeof desc1.value === 'function',
            }
          : 'NO_DESCRIPTOR';
      } catch (e) {
        out.in_page_spoof_error = (e as Error).message;
      }

      // ── 4. OffscreenCanvas ────────────────────────────────────────
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          const oc = new OffscreenCanvas(64, 64);
          const ogl = oc.getContext('webgl');
          if (ogl) {
            out.offscreen_webgl_direct_vendor = (ogl as WebGLRenderingContext).getParameter(0x9245);
            out.offscreen_webgl_direct_renderer = (ogl as WebGLRenderingContext).getParameter(0x9246);

            const oext = (ogl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
            if (oext) {
              out.offscreen_webgl_ext_vendor = (ogl as WebGLRenderingContext).getParameter(
                oext.UNMASKED_VENDOR_WEBGL,
              );
              out.offscreen_webgl_ext_renderer = (ogl as WebGLRenderingContext).getParameter(
                oext.UNMASKED_RENDERER_WEBGL,
              );
            }
          } else {
            out.offscreen_webgl = 'CONTEXT_NULL';
          }

          const ogl2 = oc.getContext('webgl2');
          if (ogl2) {
            out.offscreen_webgl2_direct_vendor = (ogl2 as WebGL2RenderingContext).getParameter(
              0x9245,
            );
            out.offscreen_webgl2_direct_renderer = (
              ogl2 as WebGL2RenderingContext
            ).getParameter(0x9246);
          }
        } else {
          out.offscreen = 'NOT_SUPPORTED';
        }
      } catch (e) {
        out.offscreen_error = (e as Error).message;
      }

      // ── 5. window marker 检查 — runner.ts 是否真的执行了 ─────
      // (在 runner.ts WebGL 块开头会加 globalThis.__mosaiqWebglMark)
      out.runnerWebglMark =
        (globalThis as Record<string, unknown>).__mosaiqWebglMark ?? 'NOT_SET';
      out.runnerWebglError =
        (globalThis as Record<string, unknown>).__mosaiqWebglError ?? 'NO_ERROR';

      // ── 6. esbuild __name helper 检查 ──
      out.typeof_name = typeof (globalThis as Record<string, unknown>).__name;

      // ── 7. 检查 navigator spoof 是否生效（作为对照基准） ──
      out.nav_userAgent = navigator.userAgent;
      out.nav_hardwareConcurrency = navigator.hardwareConcurrency;
      out.timezone_resolved = new Intl.DateTimeFormat().resolvedOptions().timeZone;

      return out;
    }, expectedRenderer);

    // ── 输出对比 ───────────────────────────────────────────────────
    console.log('[diag] probe result (raw):');
    console.log(JSON.stringify(probe, null, 2));

    const checks: CheckResult[] = [
      {
        // Day 2.1 起期望反过来：Proxy 让 toString 透明（返回 native code），
        // 这是绕过 BrowserLeaks `! ` 标记的关键。
        // 任何回归会让 `IsHook` 变 true，立刻被这条 check 抓到。
        name: 'getParameter toString stealth (transparent Proxy)',
        expected: 'false',
        actual: String(probe.getParameterIsHook),
        pass: probe.getParameterIsHook === false,
      },
      {
        name: 'WebGL1 getParameter(0x9245) [direct]',
        expected: expectedVendor,
        actual: String(probe.webgl1_direct_vendor ?? 'N/A'),
        pass: probe.webgl1_direct_vendor === expectedVendor,
      },
      {
        name: 'WebGL1 getParameter(0x9246) [direct]',
        expected: expectedRenderer,
        actual: String(probe.webgl1_direct_renderer ?? 'N/A'),
        pass: probe.webgl1_direct_renderer === expectedRenderer,
      },
      {
        name: 'WebGL1 ext.UNMASKED_VENDOR_WEBGL',
        expected: expectedVendor,
        actual: String(probe.webgl1_ext_vendor ?? 'N/A'),
        pass: probe.webgl1_ext_vendor === expectedVendor,
      },
      {
        name: 'WebGL1 ext.UNMASKED_RENDERER_WEBGL',
        expected: expectedRenderer,
        actual: String(probe.webgl1_ext_renderer ?? 'N/A'),
        pass: probe.webgl1_ext_renderer === expectedRenderer,
      },
      {
        name: 'WebGL2 getParameter(0x9245) [direct]',
        expected: expectedVendor,
        actual: String(probe.webgl2_direct_vendor ?? 'N/A'),
        pass: probe.webgl2_direct_vendor === expectedVendor,
      },
      {
        name: 'WebGL2 getParameter(0x9246) [direct]',
        expected: expectedRenderer,
        actual: String(probe.webgl2_direct_renderer ?? 'N/A'),
        pass: probe.webgl2_direct_renderer === expectedRenderer,
      },
      {
        name: 'OffscreenCanvas WebGL1 getParameter(0x9245)',
        expected: expectedVendor,
        actual: String(probe.offscreen_webgl_direct_vendor ?? 'N/A'),
        pass: probe.offscreen_webgl_direct_vendor === expectedVendor,
      },
      {
        name: 'OffscreenCanvas WebGL1 getParameter(0x9246)',
        expected: expectedRenderer,
        actual: String(probe.offscreen_webgl_direct_renderer ?? 'N/A'),
        pass: probe.offscreen_webgl_direct_renderer === expectedRenderer,
      },
    ];

    // ── Phase 1.9 GL 参数对照表验证 ────────────────────────────────
    const phase19Refs: Array<{ name: string; expected: unknown }> = [
      { name: 'MAX_TEXTURE_SIZE', expected: 16384 },
      { name: 'MAX_CUBE_MAP_TEXTURE_SIZE', expected: 16384 },
      { name: 'MAX_RENDERBUFFER_SIZE', expected: 16384 },
      { name: 'MAX_VERTEX_ATTRIBS', expected: 16 },
      { name: 'MAX_VERTEX_UNIFORM_VECTORS', expected: 4096 },
      { name: 'MAX_VARYING_VECTORS', expected: 30 },
      { name: 'MAX_TEXTURE_IMAGE_UNITS', expected: 16 },
      { name: 'MAX_FRAGMENT_UNIFORM_VECTORS', expected: 1024 },
      { name: 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', expected: 32 },
      { name: 'RED_BITS', expected: 8 },
      { name: 'DEPTH_BITS', expected: 24 },
      { name: 'STENCIL_BITS', expected: 8 },
      { name: 'MAX_VIEWPORT_DIMS', expected: [16384, 16384] },
      { name: 'ALIASED_LINE_WIDTH_RANGE', expected: [1, 1] },
      { name: 'ALIASED_POINT_SIZE_RANGE', expected: [1, 1024] },
    ];
    for (const ctx of ['webgl1', 'webgl2', 'offscreen_webgl1'] as const) {
      const ctxResult = probe[`phase19_${ctx}`] as Record<string, unknown> | undefined;
      if (!ctxResult) continue;
      for (const ref of phase19Refs) {
        const actual = ctxResult[ref.name];
        const pass = JSON.stringify(actual) === JSON.stringify(ref.expected);
        checks.push({
          name: `[Phase 1.9] ${ctx} ${ref.name}`,
          expected: JSON.stringify(ref.expected),
          actual: JSON.stringify(actual),
          pass,
        });
      }
    }

    console.log('\n[diag] check results:');
    console.log('─'.repeat(100));
    let pass = 0;
    let fail = 0;
    for (const c of checks) {
      const icon = c.pass ? '✅' : '❌';
      console.log(`${icon} ${c.name}`);
      if (!c.pass) {
        console.log(`   expected: ${c.expected}`);
        console.log(`   actual:   ${c.actual}`);
      }
      if (c.pass) pass++;
      else fail++;
    }
    console.log('─'.repeat(100));
    console.log(`[diag] summary: ${pass}/${checks.length} pass, ${fail} fail`);
  } finally {
    await session.close();
    deletePersona(PERSONA_ID);
  }
}

main().catch((err) => {
  console.error('[diag] fatal:', err);
  process.exit(1);
});
