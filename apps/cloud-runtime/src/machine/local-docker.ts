/**
 * LocalDockerMachineManager —— dev/CI 用本机 Docker socket 即时拉起 pod 容器。
 *
 * 触发场景：
 *   - 想完整跑 cloud-runtime 而又不想手工 `docker compose up` 预跑 pod
 *   - CI 上对真实 chromium 跑 e2e（无需 Fly account）
 *
 * 与 FlyMachineManager 的设计对称：
 *   - acquire = provision 一台机器 → 等就绪 → callPodStart（共享）
 *   - release = callPodStop（共享）→ destroy 机器
 *
 * 网络拓扑选择：动态 host port binding（兼容 Linux/macOS/Windows Docker Desktop）。
 * pod 容器把 9222（control）和 9223（CDP）publish 到 host 随机端口；控制平面
 * 通过 host:127.0.0.1:<assignedPort> 访问。inspect 容器后从
 * NetworkSettings.Ports['9222/tcp'][0].HostPort 取真实分配的 host port。
 *
 * 为什么不用 bridge IP 直连：
 *   - Docker Desktop（Mac/Win）的 bridge IP 在 host 上不可路由
 *   - 用 published port 在所有 OS 上都能跑，是最小公分母
 *
 * Unix socket HTTP：用 undici Agent({ connect: { socketPath } })，把它绑到一个
 * 自定义的 fetch 包装上，所有路径都伪装成 'http://localhost/...'，让 fetch
 * 知道走的是 unix domain socket。单测里 fetchImpl 直接替换。
 */

import { Agent, fetch as undiciFetch } from 'undici';

import { ApiError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { callPodStart, callPodStop, rewriteCdpHost, waitForPodReady } from './pod-control.js';
import type { FetchLike } from './pod-control.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from './types.js';

/** Docker /containers/{id}/json 部分 schema —— 只取我们用到的字段。 */
interface DockerInspectResponse {
  Id: string;
  Name?: string;
  State?: { Status?: string; Running?: boolean };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}

/** Docker /containers/create 响应。 */
interface DockerCreateResponse {
  Id: string;
  Warnings?: string[];
}

export interface LocalDockerMachineManagerOptions {
  /** Unix socket 路径，例 '/var/run/docker.sock'。Windows Docker Desktop 是 '//./pipe/docker_engine'，但通常通过 TCP 代理走。 */
  socketPath: string;
  image: string;
  /** Docker network mode；默认 'bridge'。我们仍然用 port publishing，network 仅用于命名。 */
  network: string;
  /** Docker API base URL —— 配合 unix socket 时 host 部分被忽略，单测可指向真实 mock server。 */
  apiBaseUrl: string;
  /** 软上限（保护 host 资源；超过抛 pool.exhausted）。 */
  maxContainers: number;
  /** /dev/shm 分配字节数。chromium 在低 shm 下 tab 频繁 crash，给 1GB 是常见配置。 */
  shmBytes: number;
  /** pod 容器内部的 control HTTP 端口（容器内 expose）。默认 9222。 */
  podControlPort: number;
  /** pod 容器内部的 CDP 端口。默认 9223。 */
  podCdpPort?: number;
  /** 透传给 pod 容器的 env。 */
  podEnv?: Record<string, string>;
  /** Fetch 注入（单测必填）。生产路径自动用 undici + socketPath。 */
  fetchImpl?: FetchLike;
  /** 等 /healthz 就绪超时。 */
  waitForPodReadyTimeoutMs?: number;
  podStartTimeoutMs?: number;
}

export class LocalDockerMachineManager implements MachineManager {
  readonly kind = 'local-docker' as const;
  readonly #opts: Required<
    Pick<
      LocalDockerMachineManagerOptions,
      | 'socketPath'
      | 'image'
      | 'network'
      | 'apiBaseUrl'
      | 'maxContainers'
      | 'shmBytes'
      | 'podControlPort'
      | 'podCdpPort'
      | 'waitForPodReadyTimeoutMs'
      | 'podStartTimeoutMs'
    >
  > & { podEnv: Record<string, string>; fetchImpl: FetchLike };

  /** containerId → podOrigin（含动态分配的 host port）。 */
  readonly #alive: Map<string, string> = new Map();

  constructor(opts: LocalDockerMachineManagerOptions) {
    if (!opts.socketPath) throw new Error('LocalDockerMachineManager: socketPath required');
    if (!opts.image) throw new Error('LocalDockerMachineManager: image required');
    this.#opts = {
      socketPath: opts.socketPath,
      image: opts.image,
      network: opts.network,
      apiBaseUrl: (opts.apiBaseUrl ?? 'http://localhost').replace(/\/+$/, ''),
      maxContainers: opts.maxContainers,
      shmBytes: opts.shmBytes,
      podControlPort: opts.podControlPort,
      podCdpPort: opts.podCdpPort ?? 9223,
      podEnv: opts.podEnv ?? {},
      fetchImpl: opts.fetchImpl ?? makeUnixSocketFetch(opts.socketPath),
      waitForPodReadyTimeoutMs: opts.waitForPodReadyTimeoutMs ?? 15_000,
      podStartTimeoutMs: opts.podStartTimeoutMs ?? 35_000,
    };
  }

  async acquire(spec: AcquireSpec): Promise<AcquiredMachine> {
    const log = getLogger();

    if (this.#alive.size >= this.#opts.maxContainers) {
      throw new ApiError('pool.exhausted', 'docker container cap reached', {
        cap: this.#opts.maxContainers,
        alive: this.#alive.size,
      });
    }

    // ─── 1) create container ────────────────────────────────────────────
    const created = await this.#createContainer(spec);
    log.info({ containerId: created.Id }, 'docker: container created');

    let podOrigin: string | null = null;

    try {
      // ─── 2) start ─────────────────────────────────────────────────────
      await this.#startContainer(created.Id);

      // ─── 3) inspect 取动态分配的 host port ─────────────────────────────
      const inspect = await this.#inspectContainer(created.Id);
      podOrigin = this.#deriveHostOrigin(inspect, this.#opts.podControlPort);

      // ─── 4) 等 /healthz ───────────────────────────────────────────────
      await waitForPodReady({
        podOrigin,
        fetchImpl: this.#opts.fetchImpl,
        timeoutMs: this.#opts.waitForPodReadyTimeoutMs,
      });

      // ─── 5) callPodStart 共享 ─────────────────────────────────────────
      const podResp = await callPodStart({
        podOrigin,
        spec,
        fetchImpl: this.#opts.fetchImpl,
        timeoutMs: this.#opts.podStartTimeoutMs,
      });

      // ─── 6) CDP 也用 host published port，从 inspect 取 ────────────────
      const cdpOriginForRewrite = this.#deriveHostOrigin(inspect, this.#opts.podCdpPort);
      // rewriteCdpHost 用 cdpOriginForRewrite 的 host:port 替换 chromium 自报的
      // 0.0.0.0:9223。pod 内部说自己是 9223，但 host 上是动态端口，所以这里换
      // 成 cdpOriginForRewrite。
      const cdpRouted = rewriteCdpHost(podResp.cdpUrl, cdpOriginForRewrite);

      this.#alive.set(created.Id, podOrigin);

      return {
        id: created.Id,
        podOrigin,
        cdpInternalUrl: cdpRouted,
      };
    } catch (err) {
      log.warn(
        {
          containerId: created.Id,
          cause: err instanceof Error ? err.message : String(err),
        },
        'docker acquire failed mid-way; removing container',
      );
      await this.#removeContainer(created.Id).catch((removeErr) => {
        log.error(
          {
            containerId: created.Id,
            cause: removeErr instanceof Error ? removeErr.message : String(removeErr),
          },
          'docker remove after failure ALSO failed; manual cleanup may be needed',
        );
      });
      throw err;
    }
  }

  async release(containerId: string): Promise<void> {
    const log = getLogger();
    const podOrigin = this.#alive.get(containerId);
    if (podOrigin) {
      await callPodStop({ podOrigin, machineId: containerId, fetchImpl: this.#opts.fetchImpl });
      this.#alive.delete(containerId);
    }
    await this.#removeContainer(containerId).catch((err) => {
      log.warn(
        { containerId, cause: err instanceof Error ? err.message : String(err) },
        'docker remove failed during release (treat as best-effort)',
      );
    });
  }

  async capacity(): Promise<{ ready: number; busy: number; cap: number }> {
    const cap = this.#opts.maxContainers;
    const busy = this.#alive.size;
    return { ready: cap - busy, busy, cap };
  }

  async shutdown(): Promise<void> {
    const log = getLogger();
    const ids = [...this.#alive.keys()];
    log.info({ count: ids.length }, 'docker pool shutdown: releasing all');
    await Promise.allSettled(ids.map((id) => this.release(id)));
  }

  // ─── Docker Engine API wrappers ──────────────────────────────────────────

  async #createContainer(spec: AcquireSpec): Promise<DockerCreateResponse> {
    const controlPortKey = `${this.#opts.podControlPort}/tcp`;
    const cdpPortKey = `${this.#opts.podCdpPort}/tcp`;
    const body = {
      Image: this.#opts.image,
      Env: Object.entries({
        PORT: String(this.#opts.podControlPort),
        POD_HEADLESS: 'true',
        MOSAIQ_SESSION_ID: spec.sessionId,
        ...this.#opts.podEnv,
      }).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: {
        [controlPortKey]: {},
        [cdpPortKey]: {},
      },
      HostConfig: {
        // dynamic host port: 空字符串让 Docker 分配
        PortBindings: {
          [controlPortKey]: [{ HostIp: '127.0.0.1', HostPort: '' }],
          [cdpPortKey]: [{ HostIp: '127.0.0.1', HostPort: '' }],
        },
        NetworkMode: this.#opts.network,
        ShmSize: this.#opts.shmBytes,
        // dev：容器停就删，避免堆积。prod 用 fly 不走这里。
        AutoRemove: false,
        // chromium 需要 SYS_ADMIN 才能用 sandbox，但 v0.11 pod 镜像默认 --no-sandbox，
        // 因此不开 CapAdd，最小权限原则。
      },
      Labels: {
        'com.mosaiq.runtime': 'cloud-runtime',
        'com.mosaiq.session_id': spec.sessionId,
      },
    };
    const containerName = `mosaiq-pod-${spec.sessionId}-${Date.now()}`;
    const url = `${this.#opts.apiBaseUrl}/containers/create?name=${encodeURIComponent(containerName)}`;
    const resp = await this.#opts.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `docker create ${resp.status}`, {
        body: text.slice(0, 512),
      });
    }
    const json = (await resp.json().catch(() => null)) as DockerCreateResponse | null;
    if (!json || typeof json.Id !== 'string') {
      throw new ApiError('machine.spawn_failed', 'docker create returned invalid payload');
    }
    return json;
  }

  async #startContainer(id: string): Promise<void> {
    const url = `${this.#opts.apiBaseUrl}/containers/${id}/start`;
    const resp = await this.#opts.fetchImpl(url, { method: 'POST' });
    // 204 = success, 304 = already started (both OK)
    if (resp.status !== 204 && resp.status !== 304) {
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `docker start ${resp.status}`, {
        containerId: id,
        body: text.slice(0, 256),
      });
    }
  }

  async #inspectContainer(id: string): Promise<DockerInspectResponse> {
    const url = `${this.#opts.apiBaseUrl}/containers/${id}/json`;
    const resp = await this.#opts.fetchImpl(url, { method: 'GET' });
    if (!resp.ok) {
      throw new ApiError('machine.spawn_failed', `docker inspect ${resp.status}`, {
        containerId: id,
      });
    }
    const json = (await resp.json().catch(() => null)) as DockerInspectResponse | null;
    if (!json || !json.Id) {
      throw new ApiError('machine.spawn_failed', 'docker inspect returned invalid payload', {
        containerId: id,
      });
    }
    return json;
  }

  #deriveHostOrigin(inspect: DockerInspectResponse, containerPort: number): string {
    const portsMap = inspect.NetworkSettings?.Ports ?? {};
    const key = `${containerPort}/tcp`;
    const bindings = portsMap[key];
    if (!bindings || bindings.length === 0 || !bindings[0]?.HostPort) {
      throw new ApiError(
        'machine.spawn_failed',
        `docker container ${inspect.Id} did not publish ${key} to host`,
        { containerId: inspect.Id },
      );
    }
    const hostIp = bindings[0]?.HostIp || '127.0.0.1';
    return `http://${hostIp}:${bindings[0]?.HostPort}`;
  }

  async #removeContainer(id: string): Promise<void> {
    const url = `${this.#opts.apiBaseUrl}/containers/${id}?force=true&v=true`;
    const resp = await this.#opts.fetchImpl(url, { method: 'DELETE' });
    // 204 = removed, 404 = already gone（幂等）
    if (resp.status !== 204 && resp.status !== 404) {
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `docker remove ${resp.status}`, {
        containerId: id,
        body: text.slice(0, 256),
      });
    }
  }
}

/**
 * 把 node:fetch 包装成走 unix domain socket 的版本。所有 URL 的 host:port 部分
 * 被忽略，实际连接走 socketPath。
 *
 * 实现细节：undici Agent 的 connect 选项接 socketPath；fetch 的第二参 `dispatcher`
 * 接 Agent。我们把它包成 typeof fetch 兼容签名。
 */
function makeUnixSocketFetch(socketPath: string): FetchLike {
  const agent = new Agent({ connect: { socketPath } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    // undici fetch 的 init 多一个 dispatcher 字段，TS 类型上 standard RequestInit
    // 没有这个 key，cast 过去。
    return (await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    })) as unknown as Response;
  }) as unknown as FetchLike;
}
