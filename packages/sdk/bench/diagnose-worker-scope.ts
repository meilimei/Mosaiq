/**
 * diagnose-worker-scope — 在真实 chromium 的 DedicatedWorker realm 内验证
 * `runner.ts` §11「Worker / SharedWorker scope」spoof 是否生效，仿 diagnose-webgl
 * 的 `N/N pass` 范式输出 + 任一 fail 即 `process.exit(1)`（CI 回归门）。
 *
 * 用法：
 *   pnpm --filter @runova/sdk exec tsx bench/diagnose-worker-scope.ts
 *   $env:HEADED='1'; pnpm --filter @runova/sdk exec tsx bench/diagnose-worker-scope.ts
 *
 * # 为什么需要这个
 *
 * §11 把 main-scope 的 navigator / UA-CH / WebGL / canvas / audio spoof **手工
 * 镜像**进一段 ~478 行的、被序列化进 Blob 在 worker realm 重新执行的自包含字符串
 * （`workerSpoofSrc`）。这段字符串：
 *   - 无法被 tsc / biome 类型检查（它是字符串，不是代码）
 *   - 只能靠真 Chromium E2E 验证（DEVELOPMENT.md §7 记录过整条注入栈因 esbuild
 *     keepNames 静默失效、表面字段却"看着对"的惨痛教训）
 *   - 与 main scope 逻辑靠人手同步，极易漂移
 *
 * 一旦它悄悄坏掉，CreepJS 立刻 `does not match worker scope` / `hasBadWebGL`，
 * 而 tsc/vitest/lint 全绿、CI 不报警。这个 harness 就是那道「真 worker realm」
 * 回归安全网：在去重重构（共享生成器）之前先把行为锁死。
 *
 * # 覆盖面
 *   1-8.  worker navigator.*（userAgent 无 HeadlessChrome / webdriver=false /
 *         hardwareConcurrency / deviceMemory / platform / vendor / language(s) /
 *         maxTouchPoints）= persona 期望值
 *   9-12. worker navigator.userAgentData（UA-CH）：platform / brands 无
 *         HeadlessChrome / getHighEntropyValues platform + architecture
 *   13-15. worker OffscreenCanvas WebGL：UNMASKED_VENDOR(0x9245) /
 *         UNMASKED_RENDERER(0x9246) = persona GPU + getParameter 已被 hook
 *   16-17. worker canvas / audio noise hook 已安装（OffscreenCanvas getImageData /
 *         AudioBuffer getChannelData 非 [native code]）
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';

import { deletePersona, launchPersona, personaExists, savePersona } from '../src/index.js';
import { buildInjectionConfig } from '../src/injection/build-config.js';

const PERSONA_ID = 'worker-scope-diag' as const;

interface CheckResult {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

/** worker realm 探针回传的原始数据形状。 */
interface WorkerProbe {
  ran: boolean;
  error?: string;
  userAgent?: string;
  webdriver?: unknown;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  platform?: string;
  vendor?: string;
  language?: string;
  languages?: string[];
  maxTouchPoints?: number;
  uaChPresent?: boolean;
  uaChPlatform?: string;
  uaChBrands?: Array<{ brand: string; version: string }>;
  uaChHighEntropyPlatform?: string;
  uaChHighEntropyArchitecture?: string;
  webglContext?: 'ok' | 'null' | 'unsupported';
  webglVendor?: unknown;
  webglRenderer?: unknown;
  webglGetParameterHooked?: boolean;
  offscreenGetImageDataHooked?: boolean;
  audioGetChannelDataHooked?: boolean;
}

async function main() {
  console.log('[diag] starting WORKER-SCOPE spoof diagnostic (runner.ts §11)\n');

  if (personaExists(PERSONA_ID)) deletePersona(PERSONA_ID);
  const persona = createWin11ChromeUsPersona({
    id: PERSONA_ID,
    displayName: 'Worker Scope Diagnostic',
    masterSeed: 'deadbeef',
  });
  savePersona(persona);

  // 期望值来自 persona（与 launcher 同源），UA-CH 走 buildInjectionConfig 派生。
  // 注意：UA-CH brands 的 version 在 launcher 内会被对齐到真实 chrome major，
  // 故下面只断言 platform / architecture / 无 HeadlessChrome 这些版本无关项。
  const expectedConfig = buildInjectionConfig(persona);
  const expectedVendor = persona.hardware.gpu.webglVendor;
  const expectedRenderer = persona.hardware.gpu.webglRenderer;
  const expectedCores = persona.hardware.cpu.cores;
  const expectedMem = persona.hardware.deviceMemoryGb;
  const expectedPlatform = persona.system.os.platformLabel;
  const expectedLanguages = [...persona.system.languages];
  const expectedTouch = persona.hardware.maxTouchPoints;
  const expectedVendorNav = expectedConfig.vendor;
  const expectedUaChPlatform = expectedConfig.uaCh.platform;
  const expectedUaChArch = expectedConfig.uaCh.architecture;

  console.log('[diag] persona expects (worker realm should mirror main scope):');
  console.log(`         webglVendor   = "${expectedVendor}"`);
  console.log(`         webglRenderer = "${expectedRenderer}"`);
  console.log(`         hwConcurrency = ${expectedCores}   deviceMemory = ${expectedMem}`);
  console.log(`         uaCh.platform = "${expectedUaChPlatform}"  arch = "${expectedUaChArch}"\n`);

  // 在 127.0.0.1（potentially-trustworthy origin = 安全上下文）起一个极简页面。
  // 这点很关键：navigator.userAgentData 在 worker realm 仅在**安全上下文**暴露；
  // about:blank/blob 的 opaque origin 不是安全上下文 → worker 里 userAgentData 为
  // undefined，UA-CH worker 镜像（§11 ~50 行）就测不到。CreepJS 跑在 https 安全
  // 上下文，worker 里 userAgentData 存在 —— 用 localhost 复刻这个真实威胁面。
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>worker-scope diag</body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const pageUrl = `http://127.0.0.1:${port}/`;
  console.log(`[diag] local secure-context page: ${pageUrl}\n`);

  const headed = process.env.HEADED === '1';
  const session = await launchPersona(persona, { headless: !headed });

  try {
    const page = await session.firstPage();
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[mosaiq]')) console.log(`[chromium console ${msg.type()}] ${text}`);
    });
    // probe-worker-scope.ts 已证明 blob worker 能触发 §11 的 Worker 构造器 hook
    // （init script 在 launch 时已注册）；这里换成 127.0.0.1 页面让 worker 处于
    // 安全上下文，从而 userAgentData 在 worker realm 也暴露、UA-CH 镜像可测。
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    const probe: WorkerProbe = await page.evaluate(() => {
      // 这段 worker 源在 worker realm 内执行：读取被 §11 spoof 覆盖后的所有 surface
      // 然后 postMessage 回 main thread。getHighEntropyValues 是 async，故整体 await。
      const workerSrc = `
        self.onmessage = async function () {
          var out = { ran: true };
          try {
            var nav = self.navigator || {};
            out.userAgent = nav.userAgent;
            out.webdriver = nav.webdriver;
            out.hardwareConcurrency = nav.hardwareConcurrency;
            out.deviceMemory = nav.deviceMemory;
            out.platform = nav.platform;
            out.vendor = nav.vendor;
            out.language = nav.language;
            out.languages = nav.languages ? Array.from(nav.languages) : null;
            out.maxTouchPoints = nav.maxTouchPoints;

            // ── UA-CH ─────────────────────────────────────────────
            var uad = nav.userAgentData;
            out.uaChPresent = !!uad;
            if (uad) {
              out.uaChPlatform = uad.platform;
              out.uaChBrands = (uad.brands || []).map(function (b) {
                return { brand: b.brand, version: b.version };
              });
              try {
                var he = await uad.getHighEntropyValues([
                  'platform',
                  'architecture',
                  'platformVersion',
                ]);
                out.uaChHighEntropyPlatform = he.platform;
                out.uaChHighEntropyArchitecture = he.architecture;
              } catch (e) {
                out.uaChHighEntropyPlatform = 'ERR:' + (e && e.message);
              }
            }

            // ── WebGL (OffscreenCanvas in worker) ─────────────────
            try {
              if (typeof OffscreenCanvas !== 'undefined') {
                var oc = new OffscreenCanvas(64, 64);
                var gl = oc.getContext('webgl') || oc.getContext('webgl2');
                if (gl) {
                  out.webglContext = 'ok';
                  out.webglVendor = gl.getParameter(0x9245);
                  out.webglRenderer = gl.getParameter(0x9246);
                } else {
                  out.webglContext = 'null';
                }
              } else {
                out.webglContext = 'unsupported';
              }
              if (typeof WebGLRenderingContext !== 'undefined') {
                var gpStr = WebGLRenderingContext.prototype.getParameter.toString();
                out.webglGetParameterHooked = gpStr.indexOf('[native code]') === -1;
              }
            } catch (e) {
              out.webglContext = 'ERR:' + (e && e.message);
            }

            // ── canvas / audio noise hook 安装检测 ────────────────
            try {
              if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
                var gidStr =
                  OffscreenCanvasRenderingContext2D.prototype.getImageData.toString();
                out.offscreenGetImageDataHooked = gidStr.indexOf('[native code]') === -1;
              }
            } catch (e) { /* leave undefined */ }
            try {
              if (typeof AudioBuffer !== 'undefined') {
                var gcdStr = AudioBuffer.prototype.getChannelData.toString();
                out.audioGetChannelDataHooked = gcdStr.indexOf('[native code]') === -1;
              }
            } catch (e) { /* leave undefined */ }
          } catch (e) {
            out.error = String(e && e.message ? e.message : e);
          }
          self.postMessage(out);
        };
      `;
      const blobUrl = URL.createObjectURL(
        new Blob([workerSrc], { type: 'application/javascript' }),
      );

      return new Promise<WorkerProbe>((resolve) => {
        const worker = new Worker(blobUrl);
        const t = setTimeout(() => {
          worker.terminate();
          resolve({ ran: false, error: 'worker timeout (5s)' });
        }, 5000);
        worker.onmessage = (ev) => {
          clearTimeout(t);
          worker.terminate();
          resolve(ev.data as WorkerProbe);
        };
        worker.onerror = (ev) => {
          clearTimeout(t);
          worker.terminate();
          resolve({ ran: false, error: `worker error: ${(ev as ErrorEvent).message}` });
        };
        worker.postMessage('go');
      });
    });

    console.log('[diag] worker probe result (raw):');
    console.log(JSON.stringify(probe, null, 2));

    if (!probe.ran) {
      console.error(`\n[diag] FATAL: worker did not run — ${probe.error ?? 'unknown'}`);
      process.exit(1);
    }

    const ua = String(probe.userAgent ?? '');
    const skipped: string[] = [];

    // ── 基础断言（这些 surface 在 DedicatedWorker realm 必然暴露）──────────
    const checks: CheckResult[] = [
      {
        name: 'worker UA contains "Windows NT 10.0"',
        expected: 'true',
        actual: String(ua.includes('Windows NT 10.0')),
        pass: ua.includes('Windows NT 10.0'),
      },
      {
        name: 'worker UA contains "Chrome/"',
        expected: 'true',
        actual: String(ua.includes('Chrome/')),
        pass: ua.includes('Chrome/'),
      },
      {
        name: 'worker UA has NO "HeadlessChrome"',
        expected: 'true',
        actual: String(!/headless/i.test(ua)),
        pass: !/headless/i.test(ua),
      },
      {
        name: 'worker navigator.webdriver === false',
        expected: 'false',
        actual: String(probe.webdriver),
        pass: probe.webdriver === false,
      },
      {
        name: 'worker hardwareConcurrency = persona',
        expected: String(expectedCores),
        actual: String(probe.hardwareConcurrency),
        pass: probe.hardwareConcurrency === expectedCores,
      },
      {
        name: 'worker deviceMemory = persona',
        expected: String(expectedMem),
        actual: String(probe.deviceMemory),
        pass: probe.deviceMemory === expectedMem,
      },
      {
        name: 'worker navigator.platform = persona',
        expected: expectedPlatform,
        actual: String(probe.platform),
        pass: probe.platform === expectedPlatform,
      },
      {
        name: 'worker navigator.vendor = persona',
        expected: expectedVendorNav,
        actual: String(probe.vendor),
        pass: probe.vendor === expectedVendorNav,
      },
      {
        name: 'worker navigator.languages = persona',
        expected: JSON.stringify(expectedLanguages),
        actual: JSON.stringify(probe.languages),
        pass: JSON.stringify(probe.languages) === JSON.stringify(expectedLanguages),
      },
      {
        name: 'worker navigator.maxTouchPoints = persona',
        expected: String(expectedTouch),
        actual: String(probe.maxTouchPoints),
        pass: probe.maxTouchPoints === expectedTouch,
      },
      {
        name: 'worker WebGLRenderingContext.getParameter hooked (§11 mirror installed)',
        expected: 'true',
        actual: String(probe.webglGetParameterHooked),
        pass: probe.webglGetParameterHooked === true,
      },
      {
        name: 'worker OffscreenCanvas getImageData hooked (canvas noise mirror)',
        expected: 'true',
        actual: String(probe.offscreenGetImageDataHooked),
        pass: probe.offscreenGetImageDataHooked === true,
      },
    ];

    // ── UA-CH worker 镜像（§11 ~50 行）：仅在 worker realm 暴露 userAgentData
    // 时断言。安全上下文（127.0.0.1）下应当存在；若某 chromium 版本/上下文不暴露，
    // 则不存在 HeadlessChrome 泄露面 —— 标记为 skip 而非 fail，并随版本自适应。
    if (probe.uaChPresent === true) {
      const brandsHaveHeadless = /headless/i.test(JSON.stringify(probe.uaChBrands ?? []));
      checks.push(
        {
          name: 'worker UA-CH platform = persona',
          expected: expectedUaChPlatform,
          actual: String(probe.uaChPlatform),
          pass: probe.uaChPlatform === expectedUaChPlatform,
        },
        {
          name: 'worker UA-CH brands have NO "HeadlessChrome"',
          expected: 'true',
          actual: String(!brandsHaveHeadless),
          pass: !brandsHaveHeadless,
        },
        {
          name: 'worker UA-CH getHighEntropyValues.platform = persona',
          expected: expectedUaChPlatform,
          actual: String(probe.uaChHighEntropyPlatform),
          pass: probe.uaChHighEntropyPlatform === expectedUaChPlatform,
        },
        {
          name: 'worker UA-CH getHighEntropyValues.architecture = persona',
          expected: expectedUaChArch,
          actual: String(probe.uaChHighEntropyArchitecture),
          pass: probe.uaChHighEntropyArchitecture === expectedUaChArch,
        },
      );
    } else {
      skipped.push(
        'navigator.userAgentData 在 worker realm 未暴露（非安全上下文或版本差异）→ ' +
          '跳过 UA-CH worker 镜像断言（无 HeadlessChrome 泄露面）',
      );
    }

    // ── Audio worker 镜像：Chromium 不向 DedicatedWorker 暴露 Web Audio
    // （AudioBuffer/OfflineAudioContext 为 window-only），故 §11 audio 镜像在
    // DedicatedWorker 内是 no-op。仅当某版本真暴露 AudioBuffer 时才断言 hook。
    if (probe.audioGetChannelDataHooked === undefined) {
      skipped.push(
        'AudioBuffer 未暴露给 DedicatedWorker（Chromium Web Audio 为 window-only）→ ' +
          '跳过 audio worker 镜像 hook 断言',
      );
    } else {
      checks.push({
        name: 'worker AudioBuffer getChannelData hooked (audio noise mirror)',
        expected: 'true',
        actual: String(probe.audioGetChannelDataHooked),
        pass: probe.audioGetChannelDataHooked === true,
      });
    }

    // ── WebGL renderer/vendor 值断言：仅当 worker 真拿到 GL context 时硬断言。
    if (probe.webglContext === 'ok') {
      checks.push(
        {
          name: 'worker WebGL UNMASKED_VENDOR(0x9245) = persona GPU',
          expected: expectedVendor,
          actual: String(probe.webglVendor),
          pass: probe.webglVendor === expectedVendor,
        },
        {
          name: 'worker WebGL UNMASKED_RENDERER(0x9246) = persona GPU',
          expected: expectedRenderer,
          actual: String(probe.webglRenderer),
          pass: probe.webglRenderer === expectedRenderer,
        },
      );
    } else {
      skipped.push(
        `worker WebGL context = ${probe.webglContext} → 跳过 renderer/vendor 值断言（getParameter-hooked 主信号仍生效）`,
      );
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
    for (const s of skipped) console.log(`➖ SKIP: ${s}`);
    console.log(
      `[diag] summary: ${pass}/${checks.length} pass, ${fail} fail, ${skipped.length} skipped`,
    );

    if (fail > 0) {
      console.error(
        '\n[diag] ❌ WORKER-SCOPE REGRESSION — runner.ts §11 spoof 未完全生效。' +
          '\n      在动 §11（尤其是去重重构）之前必须让本 harness 回到全绿。',
      );
      process.exit(1);
    }
    console.log('\n[diag] ✅ worker-scope spoof intact');
  } finally {
    await session.close();
    deletePersona(PERSONA_ID);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((err) => {
  console.error('[diag] fatal:', err);
  process.exit(1);
});
