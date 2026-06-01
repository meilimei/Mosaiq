/**
 * FlyMachineManager 单测。
 *
 * 设计：fetchImpl 全部 mock，对 Fly Machines API + pod /healthz + pod /control/*
 * 提供 deterministic 响应。不依赖 fake timers —— 把所有 polling interval 都调成
 * 0/1ms，保证测试 < 100ms。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../utils/errors.js';
import { FlyMachineManager } from './fly.js';
import type { FetchLike } from './pod-control.js';
import type { AcquireSpec } from './types.js';

const minimalPersona = {
  schemaVersion: 1,
  metadata: {
    id: 'test',
    displayName: 'T',
    tags: [],
    notes: '',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    lastLaunchedAt: null,
    launchCount: 0,
  },
} as unknown as AcquireSpec['persona'];

const acquireSpec: AcquireSpec = {
  sessionId: 'ses_abc',
  persona: minimalPersona,
  stealth: { inject: true, humanize: true, rebrowserPatches: true },
  ttlSeconds: 120,
};

const FLY_BASE = 'https://api.fly.test/v1';
const POD_IP = 'fdaa:0:1234::5';
const POD_ORIGIN = `http://[${POD_IP}]:9222`;

/** 收集 fetch 调用历史，便于断言调用了哪些 URL + 什么 body。 */
interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeStubFetch(
  routes: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    handler: (url: string, init?: RequestInit) => Promise<Response> | Response;
  }>,
): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? safeJson(String(init.body)) : undefined;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(body !== undefined ? { body } : {}),
      ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
    });
    const route = routes.find((r) => r.match(url, init));
    if (!route) {
      return new Response(`unmocked: ${init?.method ?? 'GET'} ${url}`, { status: 599 });
    }
    return route.handler(url, init);
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function manager(
  fetchImpl: FetchLike,
  overrides: Partial<ConstructorParameters<typeof FlyMachineManager>[0]> = {},
) {
  return new FlyMachineManager({
    apiToken: 'fly_tok_test',
    appName: 'mosaiq-browser-pod-test',
    apiBaseUrl: FLY_BASE,
    podImage: 'registry.fly.io/mosaiq-browser-pod:test',
    region: 'iad',
    podControlPort: 9222,
    maxMachines: 3,
    machineCpus: 2,
    machineMemoryMb: 2048,
    fetchImpl,
    waitForStartedTimeoutMs: 500,
    waitForStartedIntervalMs: 1,
    waitForPodReadyTimeoutMs: 500,
    podStartTimeoutMs: 500,
    ...overrides,
  });
}

describe('FlyMachineManager — happy path', () => {
  afterEach(() => vi.clearAllMocks());

  it('acquire: create → poll started → /healthz → /control/start; returns rewritten cdpUrl', async () => {
    let getMachineCalls = 0;
    const { fetchImpl, calls } = makeStubFetch([
      // POST create
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
        handler: () =>
          new Response(
            JSON.stringify({
              id: 'mch_fly_001',
              state: 'created',
              private_ip: POD_IP,
              region: 'iad',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
      // GET poll — first 2 calls "starting", 3rd "started"
      {
        match: (u, init) =>
          init?.method === 'GET' &&
          u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines/mch_fly_001`,
        handler: () => {
          getMachineCalls++;
          const state = getMachineCalls >= 3 ? 'started' : 'starting';
          return new Response(JSON.stringify({ id: 'mch_fly_001', state, private_ip: POD_IP }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
      // pod /healthz
      {
        match: (u) => u === `${POD_ORIGIN}/healthz`,
        handler: () => new Response('{"ok":true}', { status: 200 }),
      },
      // pod /control/start
      {
        match: (u) => u === `${POD_ORIGIN}/control/start`,
        handler: () =>
          new Response(
            JSON.stringify({
              cdpUrl: 'ws://0.0.0.0:9223/devtools/browser/uuid-xyz',
              machineId: 'mch_pod_internal',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    ]);

    const mm = manager(fetchImpl);
    const m = await mm.acquire(acquireSpec);

    // 返回的 id 用 Fly 的真实 machine id（用于 release 调 DELETE）
    expect(m.id).toBe('mch_fly_001');
    expect(m.podOrigin).toBe(POD_ORIGIN);
    // CDP 的 host 被换成 [private_ip]，保留 chromium 自报的 :9223 + path
    expect(m.cdpInternalUrl).toBe(`ws://[${POD_IP}]:9223/devtools/browser/uuid-xyz`);

    // 调用顺序断言
    const urls = calls.map((c) => `${c.method} ${c.url}`);
    expect(urls[0]).toBe(`POST ${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`);
    expect(urls.filter((u) => u.startsWith('GET'))).toContain(
      `GET ${FLY_BASE}/apps/mosaiq-browser-pod-test/machines/mch_fly_001`,
    );
    expect(urls).toContain(`GET ${POD_ORIGIN}/healthz`);
    expect(urls).toContain(`POST ${POD_ORIGIN}/control/start`);

    // create body 包含 services:[] + guest + metadata
    const createBody = calls[0]?.body as Record<string, unknown>;
    expect(createBody).toMatchObject({
      region: 'iad',
      config: {
        image: 'registry.fly.io/mosaiq-browser-pod:test',
        services: [],
        guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
      },
    });

    // auth header 一定在
    expect(calls[0]?.headers?.authorization).toBe('Bearer fly_tok_test');

    // capacity 反映 alive=1
    const cap = await mm.capacity();
    expect(cap).toEqual({ ready: 2, busy: 1, cap: 3 });
  });

  it('release: stops pod + DELETE force=true; idempotent', async () => {
    const seen = new Set<string>();
    const { fetchImpl, calls } = makeStubFetch([
      // 完整 acquire 流程
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_fly_002', state: 'started', private_ip: POD_IP }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_fly_002'),
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_fly_002', state: 'started', private_ip: POD_IP }),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === `${POD_ORIGIN}/healthz`,
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u === `${POD_ORIGIN}/control/start`,
        handler: () =>
          new Response(JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/dev/u', machineId: 'mid' }), {
            status: 200,
          }),
      },
      // /control/stop
      {
        match: (u) => u === `${POD_ORIGIN}/control/stop`,
        handler: () => new Response(null, { status: 204 }),
      },
      // DELETE force=true
      {
        match: (u, init) =>
          init?.method === 'DELETE' &&
          u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines/mch_fly_002?force=true`,
        handler: (u) => {
          seen.add(u);
          return new Response(null, { status: 200 });
        },
      },
    ]);

    const mm = manager(fetchImpl);
    const m = await mm.acquire(acquireSpec);
    await mm.release(m.id);

    expect([...seen]).toContain(
      `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines/mch_fly_002?force=true`,
    );

    // 幂等：再次 release 同 id 不抛错，且不要求 DELETE 必须 200（mock 已注册）
    await expect(mm.release(m.id)).resolves.toBeUndefined();

    // /control/stop 应该只在第一次 release 调用（第二次 release alive 已被清掉）
    const stopCount = calls.filter((c) => c.url === `${POD_ORIGIN}/control/stop`).length;
    expect(stopCount).toBe(1);
  });

  it('release(id, {hold: true}) 保留 machine —— 不调 /control/stop 也不 DELETE (phase 11.5)', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_keep_me', state: 'started', private_ip: POD_IP }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_keep_me'),
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_keep_me', state: 'started', private_ip: POD_IP }),
            { status: 200 },
          ),
      },
      {
        match: (u) => u.endsWith('/healthz'),
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u.endsWith('/control/start'),
        handler: () =>
          new Response(
            JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/d/u', machineId: 'mch_keep_me' }),
            { status: 200 },
          ),
      },
      {
        match: (u) => u.endsWith('/control/stop'),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/'),
        handler: () => new Response(null, { status: 200 }),
      },
    ]);

    const mm = manager(fetchImpl);
    const m = await mm.acquire(acquireSpec);
    await mm.release(m.id, { hold: true });

    expect(calls.some((c) => c.url.endsWith('/control/stop'))).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect((await mm.capacity()).busy).toBe(1);

    // 后续 release(id) 真正 destroy
    await mm.release(m.id);
    expect(calls.some((c) => c.url.endsWith('/control/stop'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('mch_keep_me'))).toBe(true);
    expect((await mm.capacity()).busy).toBe(0);
  });

  it('release: DELETE 404 视为成功（machine 已被销毁）', async () => {
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_x', state: 'started', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_x'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_x', state: 'started', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u) => u.endsWith('/healthz'),
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u.endsWith('/control/start'),
        handler: () =>
          new Response(JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/d/u', machineId: 'm' }), {
            status: 200,
          }),
      },
      {
        match: (u) => u.endsWith('/control/stop'),
        handler: () => new Response(null, { status: 204 }),
      },
      // DELETE 返 404
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/mch_x'),
        handler: () => new Response(null, { status: 404 }),
      },
    ]);
    const mm = manager(fetchImpl);
    const m = await mm.acquire(acquireSpec);
    await expect(mm.release(m.id)).resolves.toBeUndefined();
  });
});

describe('FlyMachineManager — failure paths', () => {
  afterEach(() => vi.clearAllMocks());

  it('Fly create 5xx → machine.spawn_failed（无 machine 留下，无需销毁）', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () => new Response('flying-pig', { status: 500 }),
      },
    ]);
    const mm = manager(fetchImpl);
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('machine.spawn_failed');
    expect((err as ApiError).detail).toMatchObject({
      body: expect.stringContaining('flying-pig'),
    });
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined();
  });

  it('machine 进入 failed → machine.spawn_failed 且触发 force-destroy', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_bad', state: 'created', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_bad'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_bad', state: 'failed', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/mch_bad'),
        handler: () => new Response(null, { status: 200 }),
      },
    ]);
    const mm = manager(fetchImpl);
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('machine.spawn_failed');
    expect((err as ApiError).detail).toMatchObject({ state: 'failed' });
    // 必须调过 DELETE force-destroy
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('Fly 一直 starting 不进 started → 超时抛错 + force-destroy', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_slow', state: 'created', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_slow'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_slow', state: 'starting', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: () => new Response(null, { status: 200 }),
      },
    ]);
    const mm = manager(fetchImpl, {
      waitForStartedTimeoutMs: 30,
      waitForStartedIntervalMs: 1,
    });
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/did not reach state started/);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('pod /healthz 永远 ECONNREFUSED → pool.pod_unhealthy + force-destroy', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_zz', state: 'started', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_zz'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_zz', state: 'started', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u) => u.endsWith('/healthz'),
        handler: () => {
          throw new Error('ECONNREFUSED');
        },
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: () => new Response(null, { status: 200 }),
      },
    ]);
    const mm = manager(fetchImpl, {
      waitForPodReadyTimeoutMs: 30,
    });
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('pool.pod_unhealthy');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('并发 acquire 超 cap 时只放过 cap 个，多余的 reject pool.exhausted（race condition 防御）', async () => {
    // 回归保护：见 local-docker.test.ts 同款测试 + fly.ts 并发占位注释。
    // Fly 路径下 race 后果尤其严重：超 cap 起 machine 会烧 Fly 账单 + 拖垮
    // region quota，比 host docker 资源烧穿更难恢复。
    //
    // 测试策略同 local-docker：让 POST /machines stub 用一个 deferred Promise
    // 永远不 resolve，强制所有 acquire 卡在 createMachine 第一个 await。
    let createCalls = 0;
    let resolveCreate: ((resp: Response) => void) | undefined;
    const createDeferred = new Promise<Response>((r) => {
      resolveCreate = r;
    });

    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () => {
          createCalls++;
          return createDeferred;
        },
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: () => new Response(null, { status: 200 }),
      },
    ]);

    const mm = manager(fetchImpl, { maxMachines: 2 });

    // 同步启动 5 个 acquire（cap=2）。详见 local-docker.test.ts 同款测试里
    // unhandled-rejection 动机的注释。
    type AcquireStatus = { kind: 'resolved' } | { kind: 'rejected'; reason: unknown };
    const statusPromises: Promise<AcquireStatus>[] = [1, 2, 3, 4, 5].map((i) =>
      mm.acquire({ ...acquireSpec, sessionId: `ses_race_${i}` }).then(
        (): AcquireStatus => ({ kind: 'resolved' }),
        (reason: unknown): AcquireStatus => ({ kind: 'rejected', reason }),
      ),
    );

    await new Promise((r) => setImmediate(r));

    const settled = await Promise.all(
      statusPromises.map((sp) =>
        Promise.race<AcquireStatus | 'PENDING'>([
          sp,
          new Promise((r) => setImmediate(() => r('PENDING'))),
        ]),
      ),
    );

    const exhausted = settled.filter(
      (s) =>
        typeof s === 'object' &&
        s.kind === 'rejected' &&
        s.reason instanceof ApiError &&
        (s.reason as ApiError).code === 'pool.exhausted',
    );
    const stillPending = settled.filter((s) => s === 'PENDING');

    expect(exhausted.length).toBe(3);
    expect(stillPending.length).toBe(2);
    // 关键回归断言：cap=2 时 Fly POST /machines 只被调 2 次，不会被 race 重复触发
    expect(createCalls).toBe(2);

    // cleanup：解除 deferred，让 hung acquire 走 reject 路径。statusPromises 已 attach
    // handler，后续 settle 不会 unhandled。
    resolveCreate?.(new Response('cleanup', { status: 599 }));
    await Promise.all(statusPromises);
  });

  it('pool 满 → pool.exhausted 不调 Fly API', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_p', state: 'started', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_p'),
        handler: () =>
          new Response(JSON.stringify({ id: 'mch_p', state: 'started', private_ip: POD_IP }), {
            status: 200,
          }),
      },
      {
        match: (u) => u.endsWith('/healthz'),
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u.endsWith('/control/start'),
        handler: () =>
          new Response(JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/d/u', machineId: 'm' }), {
            status: 200,
          }),
      },
    ]);
    const mm = manager(fetchImpl, { maxMachines: 1 });
    await mm.acquire(acquireSpec); // 占满
    const callsBefore = calls.length;
    const err = await mm.acquire({ ...acquireSpec, sessionId: 'ses_2' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('pool.exhausted');
    // pool exhausted 之后不应调任何 Fly API
    expect(calls.length).toBe(callsBefore);
  });
});

describe('FlyMachineManager — constructor + shutdown', () => {
  it('missing apiToken throws', () => {
    expect(
      () =>
        new FlyMachineManager({
          apiToken: '',
          appName: 'x',
          podImage: 'y',
          region: 'iad',
          podControlPort: 9222,
          maxMachines: 1,
          machineCpus: 1,
          machineMemoryMb: 512,
        }),
    ).toThrow(/apiToken/);
  });

  it('missing appName throws', () => {
    expect(
      () =>
        new FlyMachineManager({
          apiToken: 't',
          appName: '',
          podImage: 'y',
          region: 'iad',
          podControlPort: 9222,
          maxMachines: 1,
          machineCpus: 1,
          machineMemoryMb: 512,
        }),
    ).toThrow(/appName/);
  });

  it('shutdown 调 release 释放所有 alive', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(
            JSON.stringify({ id: `mch_${Math.random()}`, state: 'started', private_ip: POD_IP }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/'),
        handler: (u) => {
          const id = u.split('/').at(-1)!;
          return new Response(JSON.stringify({ id, state: 'started', private_ip: POD_IP }), {
            status: 200,
          });
        },
      },
      {
        match: (u) => u.endsWith('/healthz'),
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u.endsWith('/control/start'),
        handler: () =>
          new Response(JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/d/u', machineId: 'm' }), {
            status: 200,
          }),
      },
      {
        match: (u) => u.endsWith('/control/stop'),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: () => new Response(null, { status: 200 }),
      },
    ]);
    const mm = manager(fetchImpl, { maxMachines: 5 });
    await mm.acquire({ ...acquireSpec, sessionId: 's1' });
    await mm.acquire({ ...acquireSpec, sessionId: 's2' });
    expect((await mm.capacity()).busy).toBe(2);
    await mm.shutdown();
    expect((await mm.capacity()).busy).toBe(0);
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBeGreaterThanOrEqual(2);
  });
});
