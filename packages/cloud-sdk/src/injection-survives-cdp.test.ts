// @vitest-environment happy-dom
/**
 * Phase 11.1 必过的 smoke：验证 ManagedCloudSession.injectInto() 产出的脚本
 * 在浏览器 context 中 eval 后，navigator/screen 等 surface 真的被 persona 覆盖。
 *
 * 不真启 chromium —— 那需要 Playwright bundled binary、容器、CDP gateway 全
 * 都跑起来，超出 unit test 范畴。本测试用 happy-dom 模拟一个 frame，复刻
 * Playwright `addInitScript` 的核心承诺：脚本在 page 任何代码前执行，对 `window`
 * / `navigator` 全局做修改。
 *
 * 失败定义：
 *   - inject 后 navigator.hardwareConcurrency 仍是 happy-dom 默认值 0
 *   - inject 后 navigator.languages 仍是 happy-dom 默认 ['en-US']（不区分）
 *   - inject 后 navigator.platform 仍是默认值
 *
 * 实际 cloud-pod e2e 由 docker-compose.cloud.yml + LaunchAI 接入测试覆盖
 * （见 docs/LAUNCHAI-INTEGRATION.md）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Persona } from '@runova/persona-schema';

import { ManagedCloudSession } from './session.js';
import { MosaiqCloudClient } from './client.js';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../tests/fixtures/personas/win11-chrome-us.json',
);
const PERSONA = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Persona;

const baseOpts = {
  apiUrl: 'http://api.test',
  apiKey: 'k',
  projectId: 'proj_test',
  fetchImpl: ((async () => new Response(null, { status: 204 })) as unknown) as typeof fetch,
};

function makeSession(): ManagedCloudSession {
  return new ManagedCloudSession({
    client: new MosaiqCloudClient(baseOpts),
    created: {
      id: 'ses_smoke',
      projectId: 'proj_test',
      status: 'live',
      cdpUrl: 'ws://x/cdp',
      persona: PERSONA,
      stealth: { inject: true, humanize: true, rebrowserPatches: true },
      expiresAt: 'x',
      lastSeenAt: 'x',
      createdAt: 'x',
      liveViewUrl: null,
      clientLabel: null,
    },
  });
}

describe('injection-survives-cdp smoke', () => {
  it('addInitScript 出来的脚本在 happy-dom 全局 eval 后能改 navigator', async () => {
    const sess = makeSession();
    let captured: { content: string } | null = null;
    await sess.injectInto({
      addInitScript: (arg: { content: string }) => {
        captured = arg;
        return Promise.resolve();
      },
    } as unknown as Parameters<ManagedCloudSession['injectInto']>[0]);

    expect(captured).not.toBeNull();
    const script = captured!.content;
    expect(script.length).toBeGreaterThan(1000); // injectAll 函数体加上 config，至少几 KB
    expect(script).toContain('navigator');
    expect(script).toContain('hardwareConcurrency');
    expect(script).toContain('Intel'); // webglRenderer 关键字

    // Eval 脚本到 happy-dom 当前 window 全局 —— 模拟 Playwright addInitScript 行为
    // happy-dom 的 globalThis 就是默认 window
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(script).call(globalThis);

    // 校验 persona 字段已生效
    expect(navigator.hardwareConcurrency).toBe(PERSONA.hardware.cpu.cores);
    expect(Array.from(navigator.languages)).toEqual(PERSONA.system.languages);
    expect(navigator.platform).toBe(PERSONA.system.os.platformLabel);
    expect(navigator.userAgent).toContain(`Chrome/${PERSONA.browser.fullVersion}`);
  });

  it('inject=false 时 navigator 不变（控制实验）', async () => {
    // 重新构建 happy-dom 状态（vitest 默认每测试隔离）
    const baselineUA = navigator.userAgent;
    const baselineCores = navigator.hardwareConcurrency;
    const sess = new ManagedCloudSession({
      client: new MosaiqCloudClient(baseOpts),
      created: {
        id: 'ses_smoke_noop',
        projectId: 'proj_test',
        status: 'live',
        cdpUrl: 'x',
        persona: PERSONA,
        stealth: { inject: false, humanize: true, rebrowserPatches: true },
        expiresAt: 'x',
        lastSeenAt: 'x',
        createdAt: 'x',
        liveViewUrl: null,
        clientLabel: null,
      },
    });
    let calls = 0;
    await sess.injectInto({
      addInitScript: () => {
        calls++;
        return Promise.resolve();
      },
    } as unknown as Parameters<ManagedCloudSession['injectInto']>[0]);
    expect(calls).toBe(0);
    expect(navigator.userAgent).toBe(baselineUA);
    expect(navigator.hardwareConcurrency).toBe(baselineCores);
  });
});
