/**
 * FlyPooledMachineManager 单测。
 *
 * 设计：
 *   - fetchImpl 全部 mock，对 Fly Machines API + pod /healthz + /control/* 提供
 *     deterministic 响应（同 fly.test.ts 风格）。
 *   - poolAutoStart=false → 测试手动调 tickReplenish() 控制补充时机。
 *   - 所有 timeout 调成 1ms / 0ms 让测试 < 100ms 跑完。
 *   - vi.useRealTimers (默认) —— pool 的 setInterval 不在测试里跑（auto-start=false），
 *     所以无需 fake timers 控制 wall clock。
 */

import type { Counter } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  machinePoolEvictionsTotal,
  machinePoolHitsTotal,
  machinePoolMissesTotal,
  machinePoolProvisionsTotal,
  resetMetricsForTesting,
} from '../metrics.js';
import { ApiError } from '../utils/errors.js';
import {
  FlyPooledMachineManager,
  POOL_IMAGE_TAG_METADATA_KEY,
  POOL_METADATA_KEY,
  POOL_METADATA_VALUE,
} from './fly-pool.js';
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
const POD_IP_1 = 'fdaa:0:1234::1';
const POD_IP_2 = 'fdaa:0:1234::2';
const POD_IP_3 = 'fdaa:0:1234::3';

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

type Route = {
  match: (url: string, init?: RequestInit) => boolean;
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response;
};

function makeStubFetch(routes: Route[]): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? safeJson(String(init.body)) : undefined;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(body !== undefined ? { body } : {}),
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
  overrides: Partial<ConstructorParameters<typeof FlyPooledMachineManager>[0]> = {},
) {
  return new FlyPooledMachineManager({
    apiToken: 'fly_tok_test',
    appName: 'mosaiq-browser-pod-test',
    apiBaseUrl: FLY_BASE,
    podImage: 'registry.fly.io/mosaiq-browser-pod:test',
    region: 'iad',
    podControlPort: 9222,
    maxMachines: 10,
    machineCpus: 2,
    machineMemoryMb: 2048,
    fetchImpl,
    waitForStartedTimeoutMs: 500,
    waitForStartedIntervalMs: 1,
    waitForPodReadyTimeoutMs: 500,
    podStartTimeoutMs: 500,
    poolTargetSize: 2,
    poolReplenishIntervalMs: 100,
    poolReplenishConcurrency: 2,
    poolMaxAgeMs: 60_000,
    poolProvisionTimeoutMs: 500,
    poolAutoStart: false, // tests drive tickReplenish manually
    ...overrides,
  });
}

/** 完整的 cold-path acquire 路由（POST /machines, GET poll → started, /healthz, /control/start）。 */
function coldHappyPathRoutes(machineId: string, ip: string): Route[] {
  return [
    {
      match: (u, init) =>
        init?.method === 'POST' &&
        u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines` &&
        !(init.body && String(init.body).includes('skip_launch')),
      handler: () =>
        new Response(
          JSON.stringify({ id: machineId, state: 'created', private_ip: ip, region: 'iad' }),
          { status: 200 },
        ),
    },
    {
      match: (u, init) =>
        init?.method === 'GET' && u.includes(`/machines/${machineId}`),
      handler: () =>
        new Response(
          JSON.stringify({ id: machineId, state: 'started', private_ip: ip }),
          { status: 200 },
        ),
    },
    {
      match: (u) => u === `http://[${ip}]:9222/healthz`,
      handler: () => new Response('{"ok":true}', { status: 200 }),
    },
    {
      match: (u) => u === `http://[${ip}]:9222/control/start`,
      handler: () =>
        new Response(
          JSON.stringify({
            cdpUrl: 'ws://0.0.0.0:9223/devtools/browser/test-uuid',
            machineId,
          }),
          { status: 200 },
        ),
    },
    {
      match: (u, init) => init?.method === 'DELETE' && u.includes(`/machines/${machineId}`),
      handler: () => new Response(null, { status: 200 }),
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — constructor validation', () => {
  it('poolTargetSize < 1 throws', () => {
    const { fetchImpl } = makeStubFetch([]);
    expect(() => manager(fetchImpl, { poolTargetSize: 0 })).toThrow(/poolTargetSize must be >= 1/);
  });

  it('poolTargetSize > 50 throws', () => {
    const { fetchImpl } = makeStubFetch([]);
    expect(() => manager(fetchImpl, { poolTargetSize: 51 })).toThrow(/capped at 50/);
  });

  it('valid poolTargetSize constructs without error', () => {
    const { fetchImpl } = makeStubFetch([]);
    expect(() => manager(fetchImpl, { poolTargetSize: 3 })).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — acquire: pool empty falls back to cold', () => {
  afterEach(() => vi.clearAllMocks());

  it('pool empty → cold acquire creates new machine end-to-end', async () => {
    const { fetchImpl, calls } = makeStubFetch(coldHappyPathRoutes('mch_cold', POD_IP_1));
    const mm = manager(fetchImpl);

    const m = await mm.acquire(acquireSpec);
    expect(m.id).toBe('mch_cold');
    expect(m.podOrigin).toBe(`http://[${POD_IP_1}]:9222`);

    // POST /machines without skip_launch (it's the cold path)
    const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/machines'));
    expect(createCall).toBeDefined();
    expect(createCall?.body as Record<string, unknown>).not.toHaveProperty('skip_launch');

    // pool itself empty (we never tickReplenish'd)
    expect(mm.inspectPool()).toEqual({ creating: 0, stopped: 0, consumed: 0, evicting: 0 });
    // cold delegate has the alive entry
    const cap = await mm.capacity();
    expect(cap.busy).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — tickReplenish provisions stopped entries', () => {
  afterEach(() => vi.clearAllMocks());

  it('empty pool, target=2 → provisions 2 with skip_launch=true', async () => {
    let createCount = 0;
    const ips: Record<string, string> = {};
    const { fetchImpl, calls } = makeStubFetch([
      // POST /machines with skip_launch
      {
        match: (u, init) =>
          init?.method === 'POST' && u.endsWith('/machines'),
        handler: (_u, init) => {
          createCount++;
          const id = `mch_pool_${createCount}`;
          const ip = createCount === 1 ? POD_IP_1 : POD_IP_2;
          ips[id] = ip;
          // verify skip_launch: true in body
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          if (body.skip_launch !== true) {
            return new Response('skip_launch missing', { status: 400 });
          }
          return new Response(
            JSON.stringify({ id, state: 'created', private_ip: ip, region: 'iad' }),
            { status: 200 },
          );
        },
      },
      // GET poll → returns 'stopped' (skip_launch lands there)
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_pool_'),
        handler: (u) => {
          const id = u.split('/').at(-1)!;
          return new Response(
            JSON.stringify({ id, state: 'stopped', private_ip: ips[id] ?? '' }),
            { status: 200 },
          );
        },
      },
    ]);

    const mm = manager(fetchImpl);
    await mm.tickReplenish();
    // tickReplenish kicks off provisions but doesn't await them.
    // Drain pending microtasks until pool stabilizes.
    await waitForCondition(() => mm.inspectPool().stopped >= 2, 1000);

    expect(mm.inspectPool().stopped).toBe(2);
    expect(createCount).toBe(2);

    // metadata 必须带 mosaiq_pool=true + image_tag
    const createBody = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/machines'),
    )?.body as Record<string, unknown>;
    const config = (createBody as { config: Record<string, unknown> })?.config;
    const metadata = config?.metadata as Record<string, string>;
    expect(metadata[POOL_METADATA_KEY]).toBe(POOL_METADATA_VALUE);
    expect(metadata[POOL_IMAGE_TAG_METADATA_KEY]).toBe('registry.fly.io/mosaiq-browser-pod:test');
    // **不**带 MOSAIQ_SESSION_ID（pool entry 不绑 session）
    const env = config?.env as Record<string, string>;
    expect(env.MOSAIQ_SESSION_ID).toBeUndefined();
  });

  it('target=3 with 2 stopped + 1 creating in flight → no new provisions', async () => {
    // Build a fetch that provisions 1 and then we pre-seed pool state via consecutive ticks
    let createCount = 0;
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () => {
          createCount++;
          const id = `mch_${createCount}`;
          return new Response(
            JSON.stringify({ id, state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          );
        },
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_'),
        handler: (u) => {
          const id = u.split('/').at(-1)!;
          return new Response(
            JSON.stringify({ id, state: 'stopped', private_ip: POD_IP_1 }),
            { status: 200 },
          );
        },
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 3, poolReplenishConcurrency: 3 });

    // First tick: should fire 3 provisions
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 3, 1000);
    expect(createCount).toBe(3);

    // Subsequent tick: pool full, no new provisions
    await mm.tickReplenish();
    await new Promise((r) => setImmediate(r));
    expect(createCount).toBe(3);
  });

  it('provision failed (POST 500) → no entry added; placeholder cleared', async () => {
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () => new Response('fly down', { status: 500 }),
      },
    ]);
    const mm = manager(fetchImpl, { poolTargetSize: 1 });

    await mm.tickReplenish();
    await new Promise((r) => setTimeout(r, 50));
    // Provision failed → pool empty (placeholder cleaned up)
    expect(mm.inspectPool()).toEqual({ creating: 0, stopped: 0, consumed: 0, evicting: 0 });
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — acquire: warm path consumes pool entry', () => {
  afterEach(() => vi.clearAllMocks());

  it('pool has 1 stopped → acquire consumes (start + healthz + control/start), no POST /machines', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      // Provision routes
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_warm', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_warm'),
        handler: () => {
          // Toggle: first GET (during provision) returns stopped, after start returns started.
          return new Response(
            JSON.stringify({
              id: 'mch_warm',
              state: machineStates.get('mch_warm') ?? 'stopped',
              private_ip: POD_IP_1,
            }),
            { status: 200 },
          );
        },
      },
      // POST /start
      {
        match: (u, init) =>
          init?.method === 'POST' && u.endsWith('/machines/mch_warm/start'),
        handler: () => {
          machineStates.set('mch_warm', 'started');
          return new Response(null, { status: 200 });
        },
      },
      // pod /healthz
      {
        match: (u) => u === `http://[${POD_IP_1}]:9222/healthz`,
        handler: () => new Response('{}', { status: 200 }),
      },
      // pod /control/start
      {
        match: (u) => u === `http://[${POD_IP_1}]:9222/control/start`,
        handler: () =>
          new Response(
            JSON.stringify({
              cdpUrl: 'ws://0.0.0.0:9223/devtools/browser/warm-uuid',
              machineId: 'mch_warm',
            }),
            { status: 200 },
          ),
      },
    ]);
    const machineStates = new Map<string, string>([['mch_warm', 'stopped']]);

    const mm = manager(fetchImpl, { poolTargetSize: 1 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 1, 1000);

    const initialCalls = calls.length;

    // Acquire — should consume from pool, NOT POST /machines
    const m = await mm.acquire(acquireSpec);
    expect(m.id).toBe('mch_warm');
    expect(m.cdpInternalUrl).toBe(`ws://[${POD_IP_1}]:9223/devtools/browser/warm-uuid`);

    // Pool is now empty (entry consumed)
    expect(mm.inspectPool().stopped).toBe(0);
    expect(mm.inspectPoolAlive()).toEqual(['mch_warm']);

    // Acquire path should have called: POST /start, GET poll, /healthz, /control/start
    const acquireCalls = calls.slice(initialCalls);
    expect(acquireCalls.some((c) => c.method === 'POST' && c.url.endsWith('/start'))).toBe(true);
    expect(acquireCalls.some((c) => c.url.endsWith('/healthz'))).toBe(true);
    expect(acquireCalls.some((c) => c.url.endsWith('/control/start'))).toBe(true);
    // NO new POST /machines (= no fresh provision in this acquire)
    expect(
      acquireCalls.filter(
        (c) => c.method === 'POST' && c.url === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
      ).length,
    ).toBe(0);
  });

  it('pool entry consume fails on startMachine → fallback cold + entry destroyed', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      // Pool provision: success
      {
        match: (u, init) => {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          return (
            init?.method === 'POST' &&
            u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines` &&
            body.skip_launch === true
          );
        },
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_bad', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_bad'),
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_bad', state: 'stopped', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      // POST /start fails
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/mch_bad/start'),
        handler: () => new Response('fly broke', { status: 500 }),
      },
      // DELETE /machines/mch_bad — destroyMachine
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/mch_bad'),
        handler: () => new Response(null, { status: 200 }),
      },
      // Cold fallback path
      ...coldHappyPathRoutes('mch_cold_fallback', POD_IP_2),
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 1 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 1, 1000);

    const m = await mm.acquire(acquireSpec);
    // 应当走 cold fallback
    expect(m.id).toBe('mch_cold_fallback');
    expect(mm.inspectPool().stopped).toBe(0); // pool 也清掉了
    expect(mm.inspectPoolAlive()).toEqual([]); // 没有 pool-acquired alive

    // mch_bad 被 destroy 调用过
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('mch_bad'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — release routing', () => {
  afterEach(() => vi.clearAllMocks());

  it('release(machineId) of pool-acquired session: callPodStop + destroy', async () => {
    const states = new Map<string, string>([['mch_pool_acq', 'stopped']]);
    const { fetchImpl, calls } = makeStubFetch([
      // Pool provision (skip_launch=true)
      {
        match: (u, init) => {
          if (init?.method !== 'POST') return false;
          if (u !== `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`) return false;
          const body = init.body ? JSON.parse(String(init.body)) : {};
          return body.skip_launch === true;
        },
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_pool_acq', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      // poll 同时服务 stopped → started
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_pool_acq'),
        handler: () =>
          new Response(
            JSON.stringify({
              id: 'mch_pool_acq',
              state: states.get('mch_pool_acq') ?? 'stopped',
              private_ip: POD_IP_1,
            }),
            { status: 200 },
          ),
      },
      // Fly API /machines/:id/start — 注意必须 includes('/machines/') 排除 pod 的 /control/start
      {
        match: (u, init) =>
          init?.method === 'POST' &&
          u.startsWith(FLY_BASE) &&
          u.endsWith('/start') &&
          u.includes('/machines/'),
        handler: () => {
          states.set('mch_pool_acq', 'started');
          return new Response(null, { status: 200 });
        },
      },
      {
        match: (u) => u.endsWith('/healthz'),
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u.endsWith('/control/start'),
        handler: () =>
          new Response(
            JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/d/u', machineId: 'mch_pool_acq' }),
            { status: 200 },
          ),
      },
      {
        match: (u) => u.endsWith('/control/stop'),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/mch_pool_acq'),
        handler: () => new Response(null, { status: 200 }),
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 1 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 1, 1000);

    const m = await mm.acquire(acquireSpec);
    expect(m.id).toBe('mch_pool_acq');

    await mm.release(m.id);

    // /control/stop + DELETE /machines/mch_pool_acq must have been called
    expect(calls.some((c) => c.url.endsWith('/control/stop'))).toBe(true);
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/machines/mch_pool_acq'),
      ),
    ).toBe(true);
    expect(mm.inspectPoolAlive()).toEqual([]);
  });

  it('release(machineId) of cold-acquired session: delegates to cold manager', async () => {
    const { fetchImpl, calls } = makeStubFetch(coldHappyPathRoutes('mch_cold', POD_IP_1));
    const mm = manager(fetchImpl);

    const m = await mm.acquire(acquireSpec); // cold path
    expect(m.id).toBe('mch_cold');
    expect(mm.inspectPoolAlive()).toEqual([]);

    await mm.release(m.id);

    expect(
      calls.some((c) => c.method === 'DELETE' && c.url.includes('mch_cold')),
    ).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — capacity and cap exhaustion', () => {
  afterEach(() => vi.clearAllMocks());

  it('capacity() combines poolAlive + pool + cold.busy', async () => {
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_cap_1', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_cap_'),
        handler: (u) => {
          const id = u.split('/').at(-1)!;
          return new Response(
            JSON.stringify({ id, state: 'stopped', private_ip: POD_IP_1 }),
            { status: 200 },
          );
        },
      },
    ]);

    const mm = manager(fetchImpl, { maxMachines: 5, poolTargetSize: 2 });

    let cap = await mm.capacity();
    expect(cap).toEqual({ ready: 5, busy: 0, cap: 5 });

    // Replenish to 1
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped >= 1, 1000);

    cap = await mm.capacity();
    // 1 pool stopped 占 1 cap
    expect(cap.busy).toBeGreaterThanOrEqual(1);
    expect(cap.cap).toBe(5);
  });

  it('combined busy = maxMachines → throws pool.exhausted before consuming', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      // Pool provision 跑 1 个就超 cap
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_full_1', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_full_'),
        handler: (u) => {
          const id = u.split('/').at(-1)!;
          return new Response(
            JSON.stringify({ id, state: 'stopped', private_ip: POD_IP_1 }),
            { status: 200 },
          );
        },
      },
    ]);

    const mm = manager(fetchImpl, { maxMachines: 1, poolTargetSize: 1 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 1, 1000);

    // 现在 pool 1 stopped + nothing else = busy=1, cap=1 → 满
    const callsBefore = calls.length;
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('pool.exhausted');
    // 不应消耗 pool entry，也不应调任何 Fly API
    expect(calls.length).toBe(callsBefore);
    expect(mm.inspectPool().stopped).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — bootstrap reconcile', () => {
  afterEach(() => vi.clearAllMocks());

  it('keeps pool-marked + image-matching, evicts mismatching + foreign', async () => {
    const machines = [
      // Keep: pool-marked, image-match, stopped
      {
        id: 'mch_keep_1',
        state: 'stopped',
        private_ip: POD_IP_1,
        config: {
          metadata: {
            [POOL_METADATA_KEY]: POOL_METADATA_VALUE,
            [POOL_IMAGE_TAG_METADATA_KEY]: 'registry.fly.io/mosaiq-browser-pod:test',
          },
        },
      },
      // Evict: pool-marked but image mismatch (old deploy)
      {
        id: 'mch_evict_old',
        state: 'stopped',
        private_ip: POD_IP_2,
        config: {
          metadata: {
            [POOL_METADATA_KEY]: POOL_METADATA_VALUE,
            [POOL_IMAGE_TAG_METADATA_KEY]: 'registry.fly.io/mosaiq-browser-pod:OLD',
          },
        },
      },
      // Evict: foreign stopped (no metadata)
      { id: 'mch_evict_foreign', state: 'stopped', private_ip: POD_IP_3, config: {} },
      // Skip: 'started' (not pool's concern)
      { id: 'mch_running', state: 'started', private_ip: POD_IP_3, config: {} },
    ];

    const destroyed = new Set<string>();
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) =>
          init?.method === 'GET' && u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
        handler: () => new Response(JSON.stringify(machines), { status: 200 }),
      },
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/'),
        handler: (u) => {
          const id = u.split('/').at(-1)!.split('?')[0]!;
          destroyed.add(id);
          return new Response(null, { status: 200 });
        },
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 5 });
    const result = await mm.bootstrap();

    expect(result.kept).toBe(1);
    expect(result.evicted).toBe(2);
    expect(destroyed.has('mch_evict_old')).toBe(true);
    expect(destroyed.has('mch_evict_foreign')).toBe(true);
    expect(destroyed.has('mch_keep_1')).toBe(false);
    expect(destroyed.has('mch_running')).toBe(false);

    expect(mm.inspectPool().stopped).toBe(1);
  });

  it('poolBootstrapEvictForeign=false → keeps foreign stopped machines (skips them entirely)', async () => {
    const machines = [
      { id: 'mch_foreign', state: 'stopped', private_ip: POD_IP_1, config: {} },
    ];
    const destroyed = new Set<string>();
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'GET' && u.endsWith('/machines'),
        handler: () => new Response(JSON.stringify(machines), { status: 200 }),
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: (u) => {
          const id = u.split('/').at(-1)!.split('?')[0]!;
          destroyed.add(id);
          return new Response(null, { status: 200 });
        },
      },
    ]);

    const mm = manager(fetchImpl, { poolBootstrapEvictForeign: false });
    const result = await mm.bootstrap();
    expect(result.kept).toBe(0);
    expect(result.evicted).toBe(0);
    expect(destroyed.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — concurrent consume safety', () => {
  afterEach(() => vi.clearAllMocks());

  it('两个并发 acquire 不会拿到同一个 pool entry', async () => {
    const machineStates = new Map<string, string>([['mch_only', 'stopped']]);
    const { fetchImpl } = makeStubFetch([
      // Pool provision (skip_launch=true) — 必须 *先于* cold fallback POST 路由
      {
        match: (u, init) => {
          if (init?.method !== 'POST') return false;
          if (u !== `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`) return false;
          const body = init.body ? JSON.parse(String(init.body)) : {};
          return body.skip_launch === true;
        },
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_only', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      // Cold fallback POST /machines (no skip_launch) — 由 coldHappyPathRoutes 提供
      ...coldHappyPathRoutes('mch_fallback', POD_IP_2),
      // Fly API /machines/mch_only/start
      {
        match: (u, init) =>
          init?.method === 'POST' &&
          u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines/mch_only/start`,
        handler: () => {
          machineStates.set('mch_only', 'started');
          return new Response(null, { status: 200 });
        },
      },
      // Fly API GET /machines/mch_only
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_only'),
        handler: () =>
          new Response(
            JSON.stringify({
              id: 'mch_only',
              state: machineStates.get('mch_only')!,
              private_ip: POD_IP_1,
            }),
            { status: 200 },
          ),
      },
      // pod /healthz fallback (POD_IP_1)
      {
        match: (u) => u === `http://[${POD_IP_1}]:9222/healthz`,
        handler: () => new Response('{}', { status: 200 }),
      },
      // pod /control/start for mch_only (POD_IP_1)
      {
        match: (u) => u === `http://[${POD_IP_1}]:9222/control/start`,
        handler: () =>
          new Response(
            JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/d/u', machineId: 'mch_only' }),
            { status: 200 },
          ),
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 1, maxMachines: 5 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 1, 1000);

    // Two concurrent acquires
    const [a, b] = await Promise.all([
      mm.acquire({ ...acquireSpec, sessionId: 'ses_a' }),
      mm.acquire({ ...acquireSpec, sessionId: 'ses_b' }),
    ]);

    // 一个拿到 pool entry (mch_only)，另一个走 cold fallback (mch_fallback)
    const ids = new Set([a.id, b.id]);
    expect(ids.size).toBe(2);
    expect(ids.has('mch_only')).toBe(true);
    expect(ids.has('mch_fallback')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — stale eviction', () => {
  afterEach(() => vi.clearAllMocks());

  it('tickReplenish evicts entries past poolMaxAgeMs and replenishes', async () => {
    let createCount = 0;
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
        handler: () => {
          createCount++;
          return new Response(
            JSON.stringify({
              id: `mch_fresh_${createCount}`,
              state: 'created',
              private_ip: POD_IP_1,
            }),
            { status: 200 },
          );
        },
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/'),
        handler: (u) => {
          const id = u.split('/').at(-1)!;
          return new Response(
            JSON.stringify({ id, state: 'stopped', private_ip: POD_IP_1 }),
            { status: 200 },
          );
        },
      },
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/'),
        handler: () => new Response(null, { status: 200 }),
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 1, poolMaxAgeMs: 5 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 1, 1000);
    expect(createCount).toBe(1);

    // Wait past maxAgeMs
    await new Promise((r) => setTimeout(r, 20));

    // Next tick: should evict + replenish
    await mm.tickReplenish();
    await waitForCondition(() => createCount >= 2, 1000);

    // The original entry destroyed
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('mch_fresh_1'))).toBe(true);
    // New entry provisioned
    expect(createCount).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('FlyPooledMachineManager — shutdown', () => {
  afterEach(() => vi.clearAllMocks());

  it('destroys pool entries + releases poolAlive + stops replenish loop', async () => {
    const destroyed = new Set<string>();
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_pool_a', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/'),
        handler: (u) => {
          const id = u.split('/').at(-1)!;
          return new Response(
            JSON.stringify({ id, state: 'stopped', private_ip: POD_IP_1 }),
            { status: 200 },
          );
        },
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: (u) => {
          const id = u.split('/').at(-1)!.split('?')[0]!;
          destroyed.add(id);
          return new Response(null, { status: 200 });
        },
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 2 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped >= 1, 1000);

    await mm.shutdown();
    expect(destroyed.size).toBeGreaterThanOrEqual(1);
    expect(mm.inspectPool().stopped).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 11.3a: pool metrics 断言。
//
// 不重复完整的端到端测试 —— 复用上面已经验证好的 fixture 模式，只在关键
// transition 后断言 counter +1。`resetMetricsForTesting()` 让每个 test 从
// 0 起，避免 series 污染。
//
// 读 counter 值用 prom-client 的 `.get()` API（异步返回 snapshot）。
// 对 unlabeled counter，values[0].value 即总数；labeled counter 按 label 过滤。
describe('FlyPooledMachineManager — metrics', () => {
  beforeEach(() => resetMetricsForTesting());
  afterEach(() => vi.clearAllMocks());

  /** 读 unlabeled counter 当前值。 */
  async function counterValue(c: Counter<string>): Promise<number> {
    const snap = await c.get();
    return snap.values.reduce((sum, v) => sum + v.value, 0);
  }

  /** 读 labeled counter 在指定 label set 下的值（找不到 → 0）。 */
  async function labeledValue(
    c: Counter<string>,
    labels: Record<string, string>,
  ): Promise<number> {
    const snap = await c.get();
    const match = snap.values.find((v) =>
      Object.entries(labels).every(
        ([k, val]) => (v.labels as Record<string, string | number>)[k] === val,
      ),
    );
    return match?.value ?? 0;
  }

  it('pool starve → cold fallback increments machine_pool_misses_total{reason=starved}', async () => {
    const { fetchImpl } = makeStubFetch(coldHappyPathRoutes('mch_cold', POD_IP_1));
    const mm = manager(fetchImpl);

    expect(await labeledValue(machinePoolMissesTotal, { reason: 'starved' })).toBe(0);
    await mm.acquire(acquireSpec);

    expect(await labeledValue(machinePoolMissesTotal, { reason: 'starved' })).toBe(1);
    expect(await counterValue(machinePoolHitsTotal)).toBe(0);
  });

  it('warm path consume → increments machine_pool_hits_total', async () => {
    const machineStates = new Map<string, string>([['mch_warm', 'stopped']]);
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${FLY_BASE}/apps/mosaiq-browser-pod-test/machines`,
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_warm', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_warm'),
        handler: () =>
          new Response(
            JSON.stringify({
              id: 'mch_warm',
              state: machineStates.get('mch_warm') ?? 'stopped',
              private_ip: POD_IP_1,
            }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) =>
          init?.method === 'POST' && u.endsWith('/machines/mch_warm/start'),
        handler: () => {
          machineStates.set('mch_warm', 'started');
          return new Response(null, { status: 200 });
        },
      },
      {
        match: (u) => u === `http://[${POD_IP_1}]:9222/healthz`,
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u === `http://[${POD_IP_1}]:9222/control/start`,
        handler: () =>
          new Response(
            JSON.stringify({
              cdpUrl: 'ws://0.0.0.0:9223/devtools/browser/warm-uuid',
              machineId: 'mch_warm',
            }),
            { status: 200 },
          ),
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 1 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 1, 1000);

    expect(await counterValue(machinePoolHitsTotal)).toBe(0);
    await mm.acquire(acquireSpec);

    expect(await counterValue(machinePoolHitsTotal)).toBe(1);
    // starved 不该被加（pool 命中）
    expect(await labeledValue(machinePoolMissesTotal, { reason: 'starved' })).toBe(0);
  });

  it('successful provision → increments machine_pool_provisions_total{outcome=success}', async () => {
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_p1', state: 'created', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_p1'),
        handler: () =>
          new Response(
            JSON.stringify({ id: 'mch_p1', state: 'stopped', private_ip: POD_IP_1 }),
            { status: 200 },
          ),
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 1 });
    expect(await labeledValue(machinePoolProvisionsTotal, { outcome: 'success' })).toBe(0);

    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped === 1, 1000);

    expect(await labeledValue(machinePoolProvisionsTotal, { outcome: 'success' })).toBe(1);
    expect(await labeledValue(machinePoolProvisionsTotal, { outcome: 'failed' })).toBe(0);
  });

  it('failed provision → increments machine_pool_provisions_total{outcome=failed}', async () => {
    const { fetchImpl } = makeStubFetch([
      // POST /machines fails fast
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () => new Response('fly broke', { status: 500 }),
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 1 });
    await mm.tickReplenish();
    // tickReplenish kicks fire-and-forget; poll until provision settles
    await waitForCondition(
      async () =>
        (await labeledValue(machinePoolProvisionsTotal, { outcome: 'failed' })) >= 1,
      1000,
    );

    expect(await labeledValue(machinePoolProvisionsTotal, { outcome: 'failed' })).toBe(1);
    expect(await labeledValue(machinePoolProvisionsTotal, { outcome: 'success' })).toBe(0);
  });

  it('bootstrap reconcile → increments evictions{bootstrap_stale} and {bootstrap_foreign}', async () => {
    const machines = [
      // pool-marked + image mismatch → bootstrap_stale
      {
        id: 'mch_old',
        state: 'stopped',
        private_ip: POD_IP_1,
        config: {
          metadata: {
            [POOL_METADATA_KEY]: POOL_METADATA_VALUE,
            [POOL_IMAGE_TAG_METADATA_KEY]: 'registry.fly.io/mosaiq-browser-pod:OLD',
          },
        },
      },
      // foreign stopped → bootstrap_foreign
      { id: 'mch_foreign', state: 'stopped', private_ip: POD_IP_2, config: {} },
    ];
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'GET' && u.endsWith('/machines'),
        handler: () => new Response(JSON.stringify(machines), { status: 200 }),
      },
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/'),
        handler: () => new Response(null, { status: 200 }),
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 5 });
    await mm.bootstrap();

    expect(await labeledValue(machinePoolEvictionsTotal, { reason: 'bootstrap_stale' })).toBe(1);
    expect(await labeledValue(machinePoolEvictionsTotal, { reason: 'bootstrap_foreign' })).toBe(1);
  });

  it('shutdown with N pool entries → evictions{shutdown} += N', async () => {
    let createCount = 0;
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.endsWith('/machines'),
        handler: () => {
          createCount++;
          return new Response(
            JSON.stringify({
              id: `mch_s_${createCount}`,
              state: 'created',
              private_ip: POD_IP_1,
            }),
            { status: 200 },
          );
        },
      },
      {
        match: (u, init) => init?.method === 'GET' && u.includes('/machines/mch_s_'),
        handler: (u) => {
          const id = u.split('/').at(-1)!;
          return new Response(
            JSON.stringify({ id, state: 'stopped', private_ip: POD_IP_1 }),
            { status: 200 },
          );
        },
      },
      {
        match: (u, init) => init?.method === 'DELETE' && u.includes('/machines/mch_s_'),
        handler: () => new Response(null, { status: 200 }),
      },
    ]);

    const mm = manager(fetchImpl, { poolTargetSize: 2 });
    await mm.tickReplenish();
    await waitForCondition(() => mm.inspectPool().stopped >= 2, 1000);

    expect(await labeledValue(machinePoolEvictionsTotal, { reason: 'shutdown' })).toBe(0);
    await mm.shutdown();

    // shutdown counter +N where N = pool size at shutdown time
    expect(await labeledValue(machinePoolEvictionsTotal, { reason: 'shutdown' })).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────

/** Poll a condition predicate until true or timeout. Used to await async fire-and-forget. */
async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForCondition: predicate never became true within ${timeoutMs}ms`);
}
