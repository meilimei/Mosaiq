import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../utils/errors.js';
import {
  callPodStart,
  callPodStop,
  rewriteCdpHost,
  waitForPodReady,
  type FetchLike,
  type PodStartResponse,
} from './pod-control.js';
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
  it('replaces host, keeps chromium-reported port and path', () => {
    expect(rewriteCdpHost('ws://localhost:9223/devtools/browser/abc', 'http://browser-pod-1:9222')).toBe(
      'ws://browser-pod-1:9223/devtools/browser/abc',
    );
  });

  it('falls back to origin port when chromium did not report one', () => {
    expect(rewriteCdpHost('ws://localhost/devtools/browser/abc', 'http://browser-pod-1:9999')).toBe(
      'ws://browser-pod-1:9999/devtools/browser/abc',
    );
  });

  it('handles IPv6 fly 6PN pod address (brackets auto-added by URL)', () => {
    const rewritten = rewriteCdpHost(
      'ws://0.0.0.0:9223/devtools/browser/xyz',
      'http://[fdaa:0:1234::5]:9222',
    );
    expect(rewritten).toBe('ws://[fdaa:0:1234::5]:9223/devtools/browser/xyz');
  });
});

describe('callPodStart', () => {
  afterEach(() => vi.clearAllMocks());

  it('POSTs JSON with sessionId+stealth+ttl, returns the pod-reported cdpUrl', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toBe('http://pod-1:9222/control/start');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as { sessionId: string; ttlSeconds: number };
      expect(body.sessionId).toBe('ses_test');
      expect(body.ttlSeconds).toBe(60);
      const resp: PodStartResponse = {
        cdpUrl: 'ws://localhost:9223/devtools/browser/u',
        machineId: 'mch_xyz',
      };
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await callPodStart({
      podOrigin: 'http://pod-1:9222',
      spec: acquireSpec,
      fetchImpl,
    });
    expect(result.cdpUrl).toBe('ws://localhost:9223/devtools/browser/u');
    expect(result.machineId).toBe('mch_xyz');
  });

  it('forwards viewport when present', async () => {
    let captured: unknown;
    const fetchImpl = fakeFetch(async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ cdpUrl: 'ws://x:9223/d', machineId: 'm1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await callPodStart({
      podOrigin: 'http://pod-1:9222',
      spec: { ...acquireSpec, viewport: { width: 1920, height: 1080 } },
      fetchImpl,
    });
    expect(captured).toMatchObject({ viewport: { width: 1920, height: 1080 } });
  });

  it('5xx body → ApiError(machine.spawn_failed) with truncated body', async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response('boom-' + 'x'.repeat(500), { status: 500 }),
    );
    await expect(
      callPodStart({ podOrigin: 'http://p:9222', spec: acquireSpec, fetchImpl }),
    ).rejects.toMatchObject({
      code: 'machine.spawn_failed',
    } as Partial<ApiError>);
  });

  it('fetch rejection → ApiError(pool.pod_unhealthy)', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      callPodStart({ podOrigin: 'http://p:9222', spec: acquireSpec, fetchImpl }),
    ).rejects.toMatchObject({
      code: 'pool.pod_unhealthy',
    } as Partial<ApiError>);
  });

  it('200 but invalid payload → ApiError(machine.spawn_failed)', async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(JSON.stringify({ unexpected: 'shape' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      callPodStart({ podOrigin: 'http://p:9222', spec: acquireSpec, fetchImpl }),
    ).rejects.toMatchObject({
      code: 'machine.spawn_failed',
    } as Partial<ApiError>);
  });

  it('abort/timeout maps to pool.pod_unhealthy', async () => {
    const fetchImpl = fakeFetch(async (_url, init) => {
      // 模拟 pod hang：等到 abort 触发
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      // unreachable
      return new Response('', { status: 200 });
    });
    await expect(
      callPodStart({
        podOrigin: 'http://p:9222',
        spec: acquireSpec,
        fetchImpl,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: 'pool.pod_unhealthy' } as Partial<ApiError>);
  });
});

describe('callPodStop', () => {
  afterEach(() => vi.clearAllMocks());

  it('POSTs /control/stop with machineId in body', async () => {
    let captured: unknown;
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toBe('http://pod-1:9222/control/stop');
      captured = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    });
    await callPodStop({
      podOrigin: 'http://pod-1:9222',
      machineId: 'mch_x',
      fetchImpl,
    });
    expect(captured).toEqual({ machineId: 'mch_x' });
  });

  it('does NOT throw on fetch reject (release must be idempotent)', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      callPodStop({ podOrigin: 'http://x:9222', machineId: 'm', fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it('does NOT throw on abort/timeout', async () => {
    const fetchImpl = fakeFetch(async (_url, init) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
      return new Response('', { status: 200 });
    });
    await expect(
      callPodStop({
        podOrigin: 'http://x:9222',
        machineId: 'm',
        fetchImpl,
        timeoutMs: 30,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('waitForPodReady', () => {
  it('returns immediately when first probe succeeds', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async (url) => {
      calls++;
      expect(url).toBe('http://pod-1:9222/healthz');
      return new Response('{}', { status: 200 });
    });
    await waitForPodReady({ podOrigin: 'http://pod-1:9222', fetchImpl });
    expect(calls).toBe(1);
  });

  it('retries until success', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return new Response('{}', { status: 200 });
    });
    await waitForPodReady({
      podOrigin: 'http://pod-1:9222',
      fetchImpl,
      intervalMs: 5,
      timeoutMs: 1000,
    });
    expect(calls).toBe(3);
  });

  it('throws pool.pod_unhealthy on timeout with lastError detail', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('ECONNREFUSED-test');
    });
    const err = await waitForPodReady({
      podOrigin: 'http://pod-1:9222',
      fetchImpl,
      intervalMs: 5,
      timeoutMs: 30,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('pool.pod_unhealthy');
    expect((err as ApiError).detail).toMatchObject({
      podOrigin: 'http://pod-1:9222',
      lastError: expect.stringContaining('ECONNREFUSED-test'),
    });
  });

  it('treats non-2xx /healthz as not-ready and retries', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async () => {
      calls++;
      if (calls < 2) return new Response('', { status: 503 });
      return new Response('', { status: 200 });
    });
    await waitForPodReady({
      podOrigin: 'http://pod-1:9222',
      fetchImpl,
      intervalMs: 5,
      timeoutMs: 200,
    });
    expect(calls).toBe(2);
  });
});
