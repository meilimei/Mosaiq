/**
 * LocalDockerMachineManager 单测。
 *
 * 设计：fetchImpl 全部 mock，对 Docker Engine API（create / start / inspect /
 * remove）+ pod /healthz + pod /control/* 提供 deterministic 响应。所有 polling
 * interval 调到 1ms，保证测试 < 200ms。
 *
 * 重点验证：
 *   - acquire 走 docker network internal IP 拓扑（podOrigin = http://<ip>:port）
 *   - acquire 失败 mid-way 必须触发 force-remove cleanup
 *   - release 幂等（容器已被销毁也不报错）
 *   - pool exhausted 不调 Docker API
 *   - shutdown 释放所有 alive
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../utils/errors.js';
import { LocalDockerMachineManager } from './local-docker.js';
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

const DOCKER_BASE = 'http://localhost';
const NETWORK = 'mosaiq-net';
const POD_IP = '172.28.0.5';
const POD_ORIGIN = `http://${POD_IP}:9222`;

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
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
    });
    const route = routes.find((r) => r.match(url, init));
    if (!route) {
      return new Response(`unmocked: ${init?.method ?? 'GET'} ${url}`, { status: 599 });
    }
    return route.handler(url, init);
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

function manager(
  fetchImpl: FetchLike,
  overrides: Partial<ConstructorParameters<typeof LocalDockerMachineManager>[0]> = {},
) {
  return new LocalDockerMachineManager({
    socketPath: '/var/run/docker.sock',
    image: 'mosaiq/browser-pod:test',
    network: NETWORK,
    apiBaseUrl: DOCKER_BASE,
    maxContainers: 3,
    shmBytes: 1_073_741_824,
    podControlPort: 9222,
    podCdpPort: 9223,
    fetchImpl,
    waitForPodReadyTimeoutMs: 500,
    podStartTimeoutMs: 500,
    ...overrides,
  });
}

/** 便捷：构造一个 Docker inspect 响应。 */
function inspectResp(id: string, ip: string = POD_IP, network: string = NETWORK): Response {
  return new Response(
    JSON.stringify({
      Id: id,
      Name: `/mosaiq-pod-${id}`,
      State: { Status: 'running', Running: true },
      NetworkSettings: {
        Networks: {
          [network]: { IPAddress: ip },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('LocalDockerMachineManager — happy path', () => {
  afterEach(() => vi.clearAllMocks());

  it('acquire: create → start → inspect → /healthz → /control/start; returns cdp on container IP', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) =>
          init?.method === 'POST' && u.startsWith(`${DOCKER_BASE}/containers/create`),
        handler: () =>
          new Response(JSON.stringify({ Id: 'docker_abc' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      },
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${DOCKER_BASE}/containers/docker_abc/start`,
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) =>
          init?.method === 'GET' && u === `${DOCKER_BASE}/containers/docker_abc/json`,
        handler: () => inspectResp('docker_abc'),
      },
      {
        match: (u) => u === `${POD_ORIGIN}/healthz`,
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u === `${POD_ORIGIN}/control/start`,
        handler: () =>
          new Response(
            JSON.stringify({
              cdpUrl: 'ws://0.0.0.0:9223/devtools/browser/u',
              machineId: 'inner',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    ]);

    const mm = manager(fetchImpl);
    const m = await mm.acquire(acquireSpec);

    expect(m.id).toBe('docker_abc');
    expect(m.podOrigin).toBe(POD_ORIGIN);
    // CDP host 被换成容器 IP，保留 chromium 自报的 :9223 + path
    expect(m.cdpInternalUrl).toBe(`ws://${POD_IP}:9223/devtools/browser/u`);

    // create body 必须含 NetworkMode + ShmSize + image + ExposedPorts + Env
    const createCall = calls.find((c) => c.method === 'POST' && c.url.includes('/containers/create'));
    expect(createCall?.body).toMatchObject({
      Image: 'mosaiq/browser-pod:test',
      ExposedPorts: { '9222/tcp': {}, '9223/tcp': {} },
      HostConfig: {
        NetworkMode: NETWORK,
        ShmSize: 1_073_741_824,
        AutoRemove: false,
      },
      Labels: {
        'com.mosaiq.runtime': 'cloud-runtime',
        'com.mosaiq.session_id': 'ses_abc',
      },
    });
    // Env 包含 sessionId
    expect(createCall?.body).toMatchObject({
      Env: expect.arrayContaining([`MOSAIQ_SESSION_ID=ses_abc`, `PORT=9222`, `POD_HEADLESS=true`]),
    });
    // 关键：必须没有 PortBindings（已经从 host-port-publish 模式切走）
    const body = createCall?.body as { HostConfig?: { PortBindings?: unknown } };
    expect(body.HostConfig?.PortBindings).toBeUndefined();

    // 容器名含 sessionId 作为前缀
    expect(createCall?.url).toMatch(/name=mosaiq-pod-ses_abc-/);

    // capacity 反映 alive=1
    const cap = await mm.capacity();
    expect(cap).toEqual({ ready: 2, busy: 1, cap: 3 });
  });

  it('release: pod /control/stop + DELETE force=true; idempotent', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => new Response(JSON.stringify({ Id: 'docker_def' }), { status: 201 }),
      },
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${DOCKER_BASE}/containers/docker_def/start`,
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) =>
          init?.method === 'GET' && u === `${DOCKER_BASE}/containers/docker_def/json`,
        handler: () => inspectResp('docker_def'),
      },
      {
        match: (u) => u.endsWith('/healthz'),
        handler: () => new Response('{}', { status: 200 }),
      },
      {
        match: (u) => u.endsWith('/control/start'),
        handler: () =>
          new Response(JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/d/u', machineId: 'mid' }), {
            status: 200,
          }),
      },
      {
        match: (u) => u === `${POD_ORIGIN}/control/stop`,
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) =>
          init?.method === 'DELETE' &&
          u === `${DOCKER_BASE}/containers/docker_def?force=true&v=true`,
        handler: () => new Response(null, { status: 204 }),
      },
    ]);

    const mm = manager(fetchImpl);
    const m = await mm.acquire(acquireSpec);
    await mm.release(m.id);

    // /control/stop 应该只在第一次 release 调用
    expect(calls.filter((c) => c.url === `${POD_ORIGIN}/control/stop`).length).toBe(1);
    // DELETE 应该被调
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/containers/docker_def'),
      ),
    ).toBe(true);

    // 二次 release 同 id 必须幂等不抛
    await expect(mm.release(m.id)).resolves.toBeUndefined();
    // 二次 release 时 alive 已清，不应再调 /control/stop
    expect(calls.filter((c) => c.url === `${POD_ORIGIN}/control/stop`).length).toBe(1);
  });

  it('release(id, {hold: true}) 保留容器 —— 不调 /control/stop 也不 DELETE (phase 11.5)', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => new Response(JSON.stringify({ Id: 'cnt_keep_me' }), { status: 201 }),
      },
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/cnt_keep_me/start'),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) =>
          init?.method === 'GET' && u.includes('/containers/cnt_keep_me/json'),
        handler: () =>
          new Response(
            JSON.stringify({
              Id: 'cnt_keep_me',
              NetworkSettings: { Networks: { 'mosaiq-net': { IPAddress: '172.20.0.5' } } },
            }),
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
        handler: () => new Response(null, { status: 204 }),
      },
    ]);

    const mm = manager(fetchImpl);
    const m = await mm.acquire(acquireSpec);
    await mm.release(m.id, { hold: true });

    // /control/stop 与 DELETE 都不应被触发
    expect(calls.some((c) => c.url.endsWith('/control/stop'))).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    // capacity 维持 busy=1（容器仍存在 alive 表里）
    expect((await mm.capacity()).busy).toBe(1);

    // 后续 release(id) (hold=false default) 才真正销毁
    await mm.release(m.id);
    expect(calls.some((c) => c.url.endsWith('/control/stop'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect((await mm.capacity()).busy).toBe(0);
  });

  it('release: DELETE 404 视为成功（容器已不存在）', async () => {
    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => new Response(JSON.stringify({ Id: 'docker_x' }), { status: 201 }),
      },
      {
        match: (u, init) => init?.method === 'POST' && /\/containers\/[^/]+\/start$/.test(u),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.endsWith('/json'),
        handler: () => inspectResp('docker_x'),
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
        handler: () => new Response(null, { status: 404 }),
      },
    ]);
    const mm = manager(fetchImpl);
    const m = await mm.acquire(acquireSpec);
    await expect(mm.release(m.id)).resolves.toBeUndefined();
  });
});

describe('LocalDockerMachineManager — failure paths', () => {
  afterEach(() => vi.clearAllMocks());

  it('docker create 5xx → machine.spawn_failed（无容器留下，无需 DELETE）', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => new Response('boom', { status: 500 }),
      },
    ]);
    const mm = manager(fetchImpl);
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('machine.spawn_failed');
    expect((err as ApiError).detail).toMatchObject({ body: expect.stringContaining('boom') });
    // create 失败后不应有 DELETE 被调
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined();
  });

  it('docker start 失败 → ApiError + 触发容器 force-remove cleanup', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => new Response(JSON.stringify({ Id: 'docker_bad' }), { status: 201 }),
      },
      {
        match: (u, init) =>
          init?.method === 'POST' && u === `${DOCKER_BASE}/containers/docker_bad/start`,
        handler: () => new Response('start denied', { status: 409 }),
      },
      {
        match: (u, init) =>
          init?.method === 'DELETE' && u.includes('/containers/docker_bad'),
        handler: () => new Response(null, { status: 204 }),
      },
    ]);
    const mm = manager(fetchImpl);
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('machine.spawn_failed');
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/containers/docker_bad'),
      ),
    ).toBe(true);
  });

  it('inspect 返回容器没 attach 到指定 network → spawn_failed + force-remove', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => new Response(JSON.stringify({ Id: 'docker_no_net' }), { status: 201 }),
      },
      {
        match: (u, init) => init?.method === 'POST' && /\/containers\/[^/]+\/start$/.test(u),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.endsWith('/json'),
        handler: () =>
          new Response(
            JSON.stringify({
              Id: 'docker_no_net',
              NetworkSettings: { Networks: { 'unrelated-net': { IPAddress: '10.0.0.1' } } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: () => new Response(null, { status: 204 }),
      },
    ]);
    const mm = manager(fetchImpl);
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('machine.spawn_failed');
    expect((err as ApiError).detail).toMatchObject({
      network: NETWORK,
      availableNetworks: ['unrelated-net'],
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('pod /healthz 永远失败 → pool.pod_unhealthy + force-remove', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => new Response(JSON.stringify({ Id: 'docker_zz' }), { status: 201 }),
      },
      {
        match: (u, init) => init?.method === 'POST' && /\/containers\/[^/]+\/start$/.test(u),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.endsWith('/json'),
        handler: () => inspectResp('docker_zz'),
      },
      {
        match: (u) => u.endsWith('/healthz'),
        handler: () => {
          throw new Error('ECONNREFUSED');
        },
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: () => new Response(null, { status: 204 }),
      },
    ]);
    const mm = manager(fetchImpl, { waitForPodReadyTimeoutMs: 30 });
    const err = await mm.acquire(acquireSpec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('pool.pod_unhealthy');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('并发 acquire 超 cap 时只放过 cap 个，多余的 reject pool.exhausted（race condition 防御）', async () => {
    // 回归保护：phase 11.1 alpha 版本的 acquire() 在 cap 检查之后、`#alive.set`
    // 之前有个 `await this.#createContainer(spec)`。如果 N+M 个并发请求同时进入
    // acquire，所有 M 个超 cap 的请求都会通过 cap 检查（因为大家都看到旧的
    // `#alive.size`），最终在 docker 起 N+M 个容器，把 host 资源烧穿。修法是
    // 在 await 之前先在 #alive 里放 placeholder，详见 local-docker.ts 的并发占位
    // 注释。
    //
    // 测试策略：让 docker /containers/create stub 用一个 deferred Promise 永远
    // 不 resolve，强制所有进入第一个 await 的 acquire 都卡住。然后启动 5 个
    // 并发 acquire，cap=2。修了 race condition 之后：
    //   - 2 个 acquire 占了 placeholder + 卡在 createContainer await
    //   - 3 个 acquire 立刻 reject with pool.exhausted（同步看到 size=2）
    //   - createContainer 只被调 2 次（不是 5 次）
    let createCalls = 0;
    let resolveCreate: ((resp: Response) => void) | undefined;
    const createDeferred = new Promise<Response>((r) => {
      resolveCreate = r;
    });

    const { fetchImpl } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => {
          createCalls++;
          return createDeferred;
        },
      },
      {
        match: (u, init) => init?.method === 'DELETE',
        handler: () => new Response(null, { status: 204 }),
      },
    ]);

    const mm = manager(fetchImpl, { maxContainers: 2 });

    // 同步启动 5 个 acquire（cap=2）。立即把每个 promise 转成 settled-status
    // 对象 + 显式 .then，让 v8 不报 unhandled rejection（cleanup 阶段 hung promise
    // 走 reject 路径时会触发第二次 settle，如果没人监听就会 warn）。
    type AcquireStatus =
      | { kind: 'resolved' }
      | { kind: 'rejected'; reason: unknown };
    const statusPromises: Promise<AcquireStatus>[] = [1, 2, 3, 4, 5].map((i) =>
      mm.acquire({ ...acquireSpec, sessionId: `ses_race_${i}` }).then(
        (): AcquireStatus => ({ kind: 'resolved' }),
        (reason: unknown): AcquireStatus => ({ kind: 'rejected', reason }),
      ),
    );

    // 让 microtask queue 跑完，使同步 cap 拒绝路径都 surface 出来
    await new Promise((r) => setImmediate(r));

    // 用 Promise.race + setImmediate 把"还 pending"区分出来。Pending 的会被
    // setImmediate 注入的 'PENDING' 占位字符串先 resolve。
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
    // 关键回归断言：cap=2 时 docker create 只被调 2 次，不会被 race 重复触发
    expect(createCalls).toBe(2);

    // cleanup：解除 deferred，让所有 hung acquire 走 reject 路径，触发
    // placeholder cleanup 避免影响后续测试。statusPromises 已 attach handler，
    // 后续 settle 不会 unhandled。
    resolveCreate?.(new Response('cleanup', { status: 599 }));
    await Promise.all(statusPromises);
  });

  it('pool 满 → pool.exhausted 不调 Docker API', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => new Response(JSON.stringify({ Id: 'docker_p' }), { status: 201 }),
      },
      {
        match: (u, init) => init?.method === 'POST' && /\/containers\/[^/]+\/start$/.test(u),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.endsWith('/json'),
        handler: () => inspectResp('docker_p'),
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
    const mm = manager(fetchImpl, { maxContainers: 1 });
    await mm.acquire(acquireSpec); // 占满
    const callsBefore = calls.length;
    const err = await mm
      .acquire({ ...acquireSpec, sessionId: 'ses_2' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('pool.exhausted');
    // pool exhausted 之后不应调任何 Docker API
    expect(calls.length).toBe(callsBefore);
  });
});

describe('LocalDockerMachineManager — constructor + shutdown', () => {
  it('missing socketPath throws', () => {
    expect(
      () =>
        new LocalDockerMachineManager({
          socketPath: '',
          image: 'x',
          network: 'n',
          apiBaseUrl: DOCKER_BASE,
          maxContainers: 1,
          shmBytes: 67108864,
          podControlPort: 9222,
        }),
    ).toThrow(/socketPath/);
  });

  it('missing image throws', () => {
    expect(
      () =>
        new LocalDockerMachineManager({
          socketPath: '/var/run/docker.sock',
          image: '',
          network: 'n',
          apiBaseUrl: DOCKER_BASE,
          maxContainers: 1,
          shmBytes: 67108864,
          podControlPort: 9222,
        }),
    ).toThrow(/image/);
  });

  // ─── 回归：dockerFetchImpl vs podFetchImpl 分离 ──────────────────────────
  // 真实 prod 环境里 dockerFetchImpl 是 unix-socket fetch（把所有请求打到 docker.sock），
  // 如果错误地复用它去发 pod /healthz 请求，docker daemon 就会回 404 + JSON
  // `{"message":"page not found"}`，pod 探活永远失败。本测试用一对**只识各自 URL**
  // 的 stub 验证：docker stub 拒绝 pod URL，pod stub 拒绝 docker URL，acquire 仍要成功。
  it('uses podFetchImpl for pod calls and fetchImpl for docker calls (no crosstalk)', async () => {
    const podControlBase = `http://${POD_IP}:9222`;
    const dockerStubCalls: string[] = [];
    const podStubCalls: string[] = [];

    const dockerFetchImpl = (async (url: string, init?: RequestInit) => {
      dockerStubCalls.push(`${init?.method ?? 'GET'} ${url}`);
      // 模拟 unix socket fetch：如果不是 docker base 的 URL，就当作不认识的 path，
      // 仍照常返回 docker daemon 的 404 JSON（这就是真实环境里 pod URL 错走 docker
      // socket 时拿到的响应）。
      if (!url.startsWith(DOCKER_BASE)) {
        return new Response(JSON.stringify({ message: 'page not found' }) + '\n', {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (init?.method === 'POST' && url.includes('/containers/create')) {
        return new Response(JSON.stringify({ Id: 'docker_iso' }), { status: 201 });
      }
      if (init?.method === 'POST' && /\/containers\/[^/]+\/start$/.test(url)) {
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'GET' && url.endsWith('/json')) {
        return inspectResp('docker_iso');
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response('unmocked docker', { status: 599 });
    }) as unknown as FetchLike;

    const podFetchImpl = (async (url: string, init?: RequestInit) => {
      podStubCalls.push(`${init?.method ?? 'GET'} ${url}`);
      // 模拟真实 TCP fetch：只接 podOrigin 的 URL，docker URL 给 599 显式失败
      if (!url.startsWith(podControlBase)) {
        return new Response('unmocked pod', { status: 599 });
      }
      if (url === `${podControlBase}/healthz`) {
        return new Response('{}', { status: 200 });
      }
      if (url === `${podControlBase}/control/start`) {
        return new Response(
          JSON.stringify({ cdpUrl: 'ws://0.0.0.0:9223/devtools/browser/u', machineId: 'm' }),
          { status: 200 },
        );
      }
      if (url === `${podControlBase}/control/stop`) {
        return new Response(null, { status: 204 });
      }
      return new Response('unmocked pod path', { status: 599 });
    }) as unknown as FetchLike;

    const mm = new LocalDockerMachineManager({
      socketPath: '/var/run/docker.sock',
      image: 'mosaiq/browser-pod:test',
      network: NETWORK,
      apiBaseUrl: DOCKER_BASE,
      maxContainers: 3,
      shmBytes: 1_073_741_824,
      podControlPort: 9222,
      podCdpPort: 9223,
      fetchImpl: dockerFetchImpl,
      podFetchImpl,
      waitForPodReadyTimeoutMs: 500,
      podStartTimeoutMs: 500,
    });

    const acquired = await mm.acquire(acquireSpec);
    expect(acquired.podOrigin).toBe(podControlBase);

    // dockerFetchImpl 只能看到 docker base 的 URL，绝不能有 pod URL
    expect(dockerStubCalls.every((c) => c.includes(DOCKER_BASE))).toBe(true);
    expect(dockerStubCalls.some((c) => c.includes(podControlBase))).toBe(false);

    // podFetchImpl 只能看到 podOrigin 的 URL，绝不能有 docker URL
    expect(podStubCalls.every((c) => c.includes(podControlBase))).toBe(true);
    expect(podStubCalls.some((c) => c.includes('/containers/'))).toBe(false);

    // release 也必须走 podFetchImpl 去打 /control/stop
    await mm.release(acquired.id);
    expect(podStubCalls.some((c) => c.includes('/control/stop'))).toBe(true);
  });

  it('shutdown 释放所有 alive', async () => {
    let createIdx = 0;
    const ids = ['docker_s1', 'docker_s2'];
    const { fetchImpl, calls } = makeStubFetch([
      {
        match: (u, init) => init?.method === 'POST' && u.includes('/containers/create'),
        handler: () => {
          const id = ids[createIdx++ % ids.length]!;
          return new Response(JSON.stringify({ Id: id }), { status: 201 });
        },
      },
      {
        match: (u, init) => init?.method === 'POST' && /\/containers\/[^/]+\/start$/.test(u),
        handler: () => new Response(null, { status: 204 }),
      },
      {
        match: (u, init) => init?.method === 'GET' && u.endsWith('/json'),
        handler: (u) => {
          // u 形如 .../containers/<id>/json
          const match = u.match(/\/containers\/([^/]+)\/json/);
          const id = match?.[1] ?? 'unknown';
          return inspectResp(id);
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
        handler: () => new Response(null, { status: 204 }),
      },
    ]);
    const mm = manager(fetchImpl, { maxContainers: 5 });
    await mm.acquire({ ...acquireSpec, sessionId: 's1' });
    await mm.acquire({ ...acquireSpec, sessionId: 's2' });
    expect((await mm.capacity()).busy).toBe(2);
    await mm.shutdown();
    expect((await mm.capacity()).busy).toBe(0);
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBeGreaterThanOrEqual(2);
  });
});
