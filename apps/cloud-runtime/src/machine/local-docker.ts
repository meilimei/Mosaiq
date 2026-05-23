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
 * 网络拓扑：docker user-defined network 内部 IP 直连（跟 Fly 6PN 拓扑对称）。
 *
 *   cloud-runtime 容器  ─┐
 *                        ├─ docker network `<DOCKER_NETWORK>` ──┐
 *   manager 动态拉的 pod ─┘                                       │
 *                                                                 │
 *     manager 调用 Docker Engine API 把 pod 容器 attach 到这个 network，
 *     inspect 后从 NetworkSettings.Networks[name].IPAddress 拿到容器 IP，
 *     podOrigin = 'http://<ip>:9222'。pod 之间不暴露到 host。
 *
 * 为什么不用 host port publishing：
 *   - cloud-runtime 容器化跑时，127.0.0.1 是它自己的 loopback，到不了 host 的
 *     publish port。
 *   - publish port 会污染 host port range，dev 多副本互相冲突。
 *   - 跟 Fly internal DNS 拓扑不对称，多一套心智模型。
 *
 * 配置约束：DOCKER_NETWORK 必须是 user-defined network（不是默认 'bridge'）。
 * 默认 'bridge' 不会做容器 DNS resolve，且我们要 cloud-runtime 跟 pod 在同一
 * network 内通信。docker compose v2 默认会建 user-defined network。
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
    Networks?: Record<string, { IPAddress?: string } | undefined>;
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
  /**
   * Docker user-defined network 名（必须 user-defined，不能是 'bridge'）。
   * docker compose v2 默认建的 network 即可用；裸跑 docker 时需要先
   * `docker network create <name>` 再把 cloud-runtime + pod 容器都 attach 进去。
   */
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

      // ─── 3) inspect 取容器在 user-defined network 上的 IP ─────────────
      const inspect = await this.#inspectContainer(created.Id);
      podOrigin = this.#derivePodOrigin(inspect, this.#opts.podControlPort);

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

      // ─── 6) rewriteCdpHost：chromium 自报的 0.0.0.0:9223 → containerIp:9223
      // pod 内 chromium 在 9223 上听 CDP，host 用容器 IP（同一 docker network 内
      // 直连）。rewriteCdpHost 保留 chromium 自报的端口 9223。
      const cdpOriginForRewrite = this.#derivePodOrigin(inspect, this.#opts.podCdpPort);
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
      // ExposedPorts 仅作文档/兼容意图；同 network 内 container-to-container
      // 不依赖 EXPOSE 也能通。保留以维持与 Dockerfile EXPOSE 一致。
      ExposedPorts: {
        [controlPortKey]: {},
        [cdpPortKey]: {},
      },
      HostConfig: {
        // 不 publish 到 host。手工创建容器时直接 attach 到 user-defined network；
        // 默认 'bridge' network 不支持容器 DNS resolve，env 校验时应避免使用。
        NetworkMode: this.#opts.network,
        ShmSize: this.#opts.shmBytes,
        // dev：release 时 manager 主动 force-remove；不依赖 AutoRemove，更可控。
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

  /**
   * 从 inspect 结果取出容器在配置的 docker network 上的 IP，组成
   * `http://<ip>:<port>`。如果容器没 attach 到该 network，或 network 没分配
   * IP，抛 machine.spawn_failed（一般是 DOCKER_NETWORK 配错了）。
   */
  #derivePodOrigin(inspect: DockerInspectResponse, containerPort: number): string {
    const networks = inspect.NetworkSettings?.Networks ?? {};
    const net = networks[this.#opts.network];
    const ip = net?.IPAddress;
    if (!ip) {
      throw new ApiError(
        'machine.spawn_failed',
        `docker container ${inspect.Id} has no IP on network '${this.#opts.network}'`,
        {
          containerId: inspect.Id,
          network: this.#opts.network,
          availableNetworks: Object.keys(networks),
        },
      );
    }
    return `http://${ip}:${containerPort}`;
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
