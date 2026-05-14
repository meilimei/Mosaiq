/**
 * launcher.ts regression guards.
 *
 * 不启动真实 Chromium，只做白盒源码检查：
 *   - launcher.ts 必须含 __name polyfill
 *   - launcher.ts 必须用 string-form addInitScript（callback 形式无法 prepend polyfill）
 *
 * 背景：详见 `bench/PHASE-1-NEXT-STEPS.md` §0 与 `DEVELOPMENT.md` §6。
 * 简言之：tsx/esbuild keepNames 把 runner.ts 内每个命名/匿名函数包装成
 * `__name(fn, "name")` 调用以保留 `Function.prototype.name`。Chromium init-script
 * world 不暴露 esbuild `__name` helper，所以必须在注入前 polyfill，否则整个
 * `injectAll` 在第一行 `__name(...)` 处抛 ReferenceError，反检测全部失效。
 *
 * 注意：本 test 不能用 `injectAll.toString()` 验证 `__name(` 是否被注入，因为
 * vitest 走 vite/rollup（不开 keepNames），与 tsx runtime（开 keepNames）行为不同。
 * 真正的 runtime 验证靠 `bench/diagnose-webgl.ts`（启动 Chromium 实测）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('launcher addInitScript regression guards', () => {
  it('launcher.ts source must contain a __name polyfill', () => {
    const src = readFileSync(join(__dirname, 'launcher.ts'), 'utf-8');

    // polyfill 表达式：globalThis.__name = globalThis.__name || function(f){return f}
    // 允许任意空白；只要语义保持「不覆盖已有 __name + identity 函数」即可。
    expect(src).toMatch(/globalThis\.__name\s*=\s*globalThis\.__name\s*\|\|/);
  });

  it('launcher.ts must use addInitScript({ content: ... }) string form, not callback form', () => {
    const src = readFileSync(join(__dirname, 'launcher.ts'), 'utf-8');

    // string form 是 polyfill 能 prepend 的前提。callback 形式
    //   addInitScript(injectAll, config)
    // 会让 Playwright 直接 toString → 跳过任何手动 prepend。
    expect(src).toContain('addInitScript({ content:');

    // 不允许重新出现 callback 形式（防止 IDE 自动重构误回退）。
    expect(src).not.toMatch(/addInitScript\(injectAll\b/);
  });

  it('launcher.ts wires polyfill before injectAll IIFE', () => {
    const src = readFileSync(join(__dirname, 'launcher.ts'), 'utf-8');

    // 期望模式：const namePolyfill = '...';
    //         const script = `${namePolyfill}(${injectAll.toString()})(${...});`;
    expect(src).toMatch(/namePolyfill[\s\S]*?injectAll\.toString\(\)/);
  });
});

describe('runner.ts WebGL spoof regression guards', () => {
  /**
   * Day 2.1 的 Proxy 改造守卫：runner.ts 必须用 `new Proxy` 包装 getParameter，
   * 而非旧的 `function (this: WebGLRenderingContext, pname: number) {...}` 直接替换。
   *
   * Proxy 让 `getParameter.toString()` 透明 forward 到 target，返回
   * `function () { [native code] }` — 是基本的反检测卫生（不留 JS 源码痕迹）。
   *
   * 真实 e2e 验证靠 `bench/diagnose-webgl.ts`（启 chromium 实测 9/9 pass）。
   * 本 white-box test 只是廉价的回归保护：防止有人误把 Proxy 改回普通 function 替换。
   */
  it('runner.ts WebGL spoof must use Proxy (not direct function replacement)', () => {
    const src = readFileSync(
      join(__dirname, 'injection', 'runner.ts'),
      'utf-8',
    );

    // 必须包含 makeGetParameterProxy（Day 2.1 引入的 Proxy factory）
    expect(src).toContain('makeGetParameterProxy');
    // 必须用 `new Proxy` 包装 getParameter / readPixels
    expect(src).toMatch(/new Proxy\(\s*orig\s*,/);
    // 不能再出现旧式直接替换 — 旧版本是
    //   WebGLRenderingContext.prototype.getParameter = function (this: WebGLRenderingContext, ...)
    expect(src).not.toMatch(
      /WebGLRenderingContext\.prototype\.getParameter\s*=\s*function\s*\(\s*this:/,
    );
  });

  it('runner.ts WebGL spoof must handle WebGL2RenderingContext separately', () => {
    const src = readFileSync(
      join(__dirname, 'injection', 'runner.ts'),
      'utf-8',
    );

    // WebGL2 单独处理，避免 WebGL1/WebGL2 共享同一原始函数时 race
    expect(src).toContain('WebGL2RenderingContext.prototype');
  });
});

describe('runner.ts Timezone + SpeechSynthesis spoof regression guards', () => {
  /**
   * Day 3.3 + 3.5 改造守卫：
   *   - Date.prototype.getTimezoneOffset 必须用 Proxy（不能用普通 function 替换）
   *   - Intl.DateTimeFormat 必须用 Proxy（构造时注入 timeZone option）
   *   - SpeechSynthesis.prototype.getVoices 必须 spoof（消 CreepJS Intl bold-fail）
   *
   * Day 3.5 攻陷 CreepJS 唯一 bold-fail surface 的核心改造。任何回归会让真实 OS
   * TTS voices（如 zh-CN）泄露 → LowerEntropy.TIME_ZONE = true → Intl bold-fail。
   *
   * 真实 e2e 验证：`bench/diagnose-creepjs.ts` + `bench/baseline-detection.ts`。
   */
  it('runner.ts Date.getTimezoneOffset spoof must use Proxy', () => {
    const src = readFileSync(
      join(__dirname, 'injection', 'runner.ts'),
      'utf-8',
    );
    expect(src).toContain('proxiedGTO');
    expect(src).toContain('Date.prototype.getTimezoneOffset = proxiedGTO');
    // 不允许回退到旧 `Date.prototype.getTimezoneOffset = function (` 形式
    expect(src).not.toMatch(/Date\.prototype\.getTimezoneOffset\s*=\s*function\s*\(\s*\)/);
  });

  it('runner.ts Intl.DateTimeFormat spoof must use Proxy with construct/apply traps', () => {
    const src = readFileSync(
      join(__dirname, 'injection', 'runner.ts'),
      'utf-8',
    );
    expect(src).toContain('proxiedDTF');
    // 必须同时拦 construct 与 apply（spec 允许两种调用方式）
    // Day 3.6 起改用 wrapStealth 自注册 toString，兼容两种写法
    expect(src).toMatch(/proxiedDTF\s*=\s*(?:new Proxy|wrapStealth)\(OrigDateTimeFormat/);
  });

  it('runner.ts must spoof SpeechSynthesis.getVoices to avoid OS TTS leak', () => {
    const src = readFileSync(
      join(__dirname, 'injection', 'runner.ts'),
      'utf-8',
    );
    // Day 3.5 关键改造 — 防止真实 OS voices（如中文系统的 Microsoft Huihui [zh-CN]）泄露
    expect(src).toContain('SpeechSynthesis.prototype.getVoices');
    expect(src).toContain('voiceTemplates');
    expect(src).toContain('SpeechSynthesisVoice.prototype');
  });
});
