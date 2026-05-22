import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../utils/errors.js';
import {
  StaticPoolMachineManager,
  rewriteCdpHost,
  type FetchLike,
  type PodStartResponse,
} from './static.js';
import type { AcquireSpec } from './types.js';

const minimalPersona = {
  schemaVersion: 1,
  metadata: {
    id: 'test-persona',
    displayName: 'Test',
    tags: [],
    notes: '',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    lastLaunchedAt: null,
    launchCount: 0,
  },
  // 其他字段在 static-pool 单测里只是透传，pod 那侧才校验
} as unknown as AcquireSpec['persona'];

const acquireSpec: AcquireSpec = {
  sessionId: 'ses_test',
  persona: minimalPersona,
  stealth: { inject: true, humanize: true, rebrowserPatches: true },
  ttlSeconds: 60,
};

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): FetchLike {
  return ((url: string, init?: RequestInit) => handler(url, init)) as unknown as FetchLike;
}

describe('rewriteCdpHost', () => {
  it('替换 host，保留 chromium 自报的 port + path', () => {
    expect(
      rewriteCdpHost('ws://localhost:9223/devtools/browser/abc', 'http://browser-pod-1:9222'),
    ).toBe('ws://browser-pod-1:9223/devtools/browser/abc');
  });
  it('chromium 没自报 port 时兜底走 origin port', () => {
    expect(
      rewriteCdpHost('ws://localhost/devtools/browser/abc', 'http://browser-pod-1:9999'),
    ).toBe('ws://browser-pod-1:9999/devtools/browser/abc');
  });
});

describe('StaticPoolMachineManager', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('构造空 podAddrs 抛错', () => {
    expect(() => new StaticPoolMachineManager({ podAddrs: [] })).toThrow(/POD_ADDRS/);
  });

  it('acquire 成功：调 pod /control/start，返回 host swap 后的 cdp url', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toBe('http://pod-1:9222/control/start');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as { sessionId: string; ttlSeconds: number };
      expect(body.sessionId).toBe('ses_test');
      expect(body.ttlSeconds).toBe(60);
      const respBody: PodStartResponse = {
        cdpUrl: 'ws://localhost:9223/devtools/browser/uuid-123',
        machineId: 'mch_xyz',
      };
      return new Response(JSON.stringify(respBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const mm = new StaticPoolMachineManager({ podAddrs: ['http://pod-1:9222'], fetchImpl });
    const result = await mm.acquire(acquireSpec);
    expect(result.id).toBe('mch_xyz');
    expect(result.podOrigin).toBe('http://pod-1:9222');
    expect(result.cdpInternalUrl).toBe('ws://pod-1:9223/devtools/browser/uuid-123');

    expect((await mm.capacity()).busy).toBe(1);
  });

  it('pool 耗尽抛 pool.exhausted', async () => {
    const fetchImpl = fakeFetch(async () => {
      return new Response(JSON.stringify({ cdpUrl: 'ws://x:9223/d', machineId: 'mch_a' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const mm = new StaticPoolMachineManager({ podAddrs: ['http://p1:9222'], fetchImpl });
    await mm.acquire(acquireSpec);
    await expect(mm.acquire({ ...acquireSpec, sessionId: 'ses_2' })).rejects.toMatchObject({
      code: 'pool.exhausted',
    } as ApiError);
  });

  it('pod 5xx → machine.spawn_failed', async () => {
    const fetchImpl = fakeFetch(async () => new Response('boom', { status: 500 }));
    const mm = new StaticPoolMachineManager({ podAddrs: ['http://p1:9222'], fetchImpl });
    await expect(mm.acquire(acquireSpec)).rejects.toMatchObject({ code: 'machine.spawn_failed' });
    // 失败后 pod 应释放回池
    expect((await mm.capacity()).ready).toBe(1);
  });

  it('pod fetch reject → pool.pod_unhealthy', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const mm = new StaticPoolMachineManager({ podAddrs: ['http://p1:9222'], fetchImpl });
    await expect(mm.acquire(acquireSpec)).rejects.toMatchObject({ code: 'pool.pod_unhealthy' });
    expect((await mm.capacity()).busy).toBe(0);
  });

  it('release 后 pod 回 idle，再次 acquire 重用同一 pod', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch(async (url) => {
      calls.push(url);
      if (url.endsWith('/control/start')) {
        return new Response(
          JSON.stringify({
            cdpUrl: 'ws://localhost:9223/devtools/browser/u1',
            machineId: 'mch_a',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // /control/stop
      return new Response(null, { status: 204 });
    });
    const mm = new StaticPoolMachineManager({ podAddrs: ['http://p1:9222'], fetchImpl });
    const m = await mm.acquire(acquireSpec);
    await mm.release(m.id);
    expect(calls.at(-1)).toBe('http://p1:9222/control/stop');
    expect((await mm.capacity()).busy).toBe(0);
    // 再次 acquire 走同一 pod（只有 1 个）
    const m2 = await mm.acquire({ ...acquireSpec, sessionId: 'ses_2' });
    expect(m2.podOrigin).toBe('http://p1:9222');
  });

  it('release 未知 machineId 是幂等 no-op', async () => {
    const fetchImpl = fakeFetch(async () => new Response('', { status: 200 }));
    const mm = new StaticPoolMachineManager({ podAddrs: ['http://p1:9222'], fetchImpl });
    await expect(mm.release('mch_does_not_exist')).resolves.toBeUndefined();
  });
});
