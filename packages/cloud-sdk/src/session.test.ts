import { describe, expect, it, vi } from 'vitest';
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

function makeFakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return ((url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;
}

const baseOpts = {
  apiUrl: 'http://api.test',
  apiKey: 'k',
  projectId: 'proj_test',
};

function makeSession(stealthInject: boolean): ManagedCloudSession {
  return new ManagedCloudSession({
    client: new MosaiqCloudClient({
      ...baseOpts,
      fetchImpl: makeFakeFetch(async () => new Response(null, { status: 204 })),
    }),
    created: {
      id: 'ses_abc',
      projectId: 'proj_test',
      status: 'live',
      cdpUrl: 'ws://x/cdp',
      persona: PERSONA,
      stealth: { inject: stealthInject, humanize: true, rebrowserPatches: true },
      expiresAt: 'x',
      lastSeenAt: 'x',
      createdAt: 'x',
      liveViewUrl: null,
      clientLabel: null,
    },
  });
}

describe('ManagedCloudSession.injectInto', () => {
  it('stealth.inject=true → 调 context.addInitScript 一次，content 含 injectAll IIFE', async () => {
    const sess = makeSession(true);
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    // 模拟 BrowserContext duck-type
    const fakeContext = { addInitScript } as unknown as Parameters<
      ManagedCloudSession['injectInto']
    >[0];
    await sess.injectInto(fakeContext);
    expect(addInitScript).toHaveBeenCalledTimes(1);
    const arg = addInitScript.mock.calls[0]![0] as { content: string };
    expect(arg.content).toContain('globalThis.__name');
    // injectAll 是函数序列化进来的，所以脚本里应该看得到 navigator 这种关键词
    expect(arg.content).toContain('navigator');
  });

  it('stealth.inject=false → no-op', async () => {
    const sess = makeSession(false);
    const addInitScript = vi.fn();
    await sess.injectInto({ addInitScript } as unknown as Parameters<
      ManagedCloudSession['injectInto']
    >[0]);
    expect(addInitScript).not.toHaveBeenCalled();
  });
});

describe('ManagedCloudSession.close', () => {
  it('调 client.closeSession（DELETE）', async () => {
    const calls: string[] = [];
    const fetchImpl = makeFakeFetch(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(null, { status: 204 });
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    const sess = new ManagedCloudSession({
      client,
      created: {
        id: 'ses_abc',
        projectId: 'proj_test',
        status: 'live',
        cdpUrl: 'x',
        persona: PERSONA,
        stealth: { inject: true, humanize: true, rebrowserPatches: true },
        expiresAt: 'x',
        lastSeenAt: 'x',
        createdAt: 'x',
        liveViewUrl: null,
        clientLabel: null,
      },
    });
    await sess.close();
    expect(calls).toContain('DELETE http://api.test/v1/sessions/ses_abc');
    expect(sess.closed).toBe(true);
    // 第二次 close 幂等不再发请求
    await sess.close();
    expect(calls.filter((c) => c.startsWith('DELETE')).length).toBe(1);
  });

  it('disconnect() 不 DELETE session', async () => {
    const calls: string[] = [];
    const fetchImpl = makeFakeFetch(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(null, { status: 204 });
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    const sess = new ManagedCloudSession({
      client,
      created: {
        id: 'ses_keep',
        projectId: 'proj_test',
        status: 'live',
        cdpUrl: 'x',
        persona: PERSONA,
        stealth: { inject: true, humanize: true, rebrowserPatches: true },
        expiresAt: 'x',
        lastSeenAt: 'x',
        createdAt: 'x',
        liveViewUrl: null,
        clientLabel: null,
      },
      keepAlive: true,
    });
    sess.disconnect();
    expect(sess.closed).toBe(true);
    expect(calls.filter((c) => c.startsWith('DELETE')).length).toBe(0);
  });
});
