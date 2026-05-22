/**
 * StaticPoolMachineManager —— 预先存在的 pod 池，按 round-robin 分配。
 *
 * 适用：
 *   - 本地 docker compose 起多个 browser-pod 容器
 *   - dev 单独跑 `pnpm --filter @mosaiq/browser-pod dev`，配 POD_ADDRS=http://localhost:9222
 *
 * 不适用：
 *   - prod。prod 走 Fly Machines（phase 11.2）。本类启动时只 console.warn，
 *     不强制阻塞 —— 因为也可以用 static 接 K8s Service IP（一组固定 endpoint）。
 *
 * 内部状态：
 *   - busy: Map<podOrigin, machineId>  — 哪些 pod 当前在用
 *   - 没占用的 pod 是 ready
 *
 * 并发：v0.11 是单进程 + 内存锁。phase 11.3 warm pool + 多控制平面 instance
 *   时换成 redis lock。
 */

import { ApiError } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { getLogger } from '../utils/logger.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from './types.js';

interface PodEntry {
  origin: string; // 'http://browser-pod-1:9222'
  busyMachineId: string | null; // null = ready
}

/** pod 与 control-plane 之间约定的 control API 形状。 */
export interface PodStartRequest {
  sessionId: string;
  /** 整个 Persona JSON，pod 自己解析需要的 cmdline flag */
  persona: unknown;
  stealth: {
    inject: boolean;
    humanize: boolean;
    rebrowserPatches: boolean;
  };
  viewport?: { width: number; height: number };
  ttlSeconds: number;
}

export interface PodStartResponse {
  /** chromium 暴露的 CDP base URL，pod 内部地址，例如 'ws://0.0.0.0:9223' */
  cdpUrl: string;
  /** pod 给的 machine id，控制平面会把它写进 sessions.machine_id */
  machineId: string;
}

/** fetch 包装为可注入，方便单元测试。 */
export type FetchLike = typeof fetch;

/**
 * 把 chromium 自报的 ws URL（host 部分是 0.0.0.0/localhost）改成 pod origin
 * 的可路由 host，端口保持 chromium 报的（一般是 POD_CDP_PORT，与 pod origin
 * 的端口不同）。
 *
 * 例：
 *   cdp = ws://localhost:9223/devtools/browser/abc
 *   podOrigin = http://browser-pod-1:9222
 *   ⇒ ws://browser-pod-1:9223/devtools/browser/abc
 */
export function rewriteCdpHost(cdpUrl: string, podOrigin: string): string {
  const cdp = new URL(cdpUrl);
  const pod = new URL(podOrigin);
  cdp.hostname = pod.hostname;
  // 保留 cdp 自己的 port（不是 pod origin 的 port）。如果 chromium 没自报 port，
  // 兜底沿用 origin 端口（不太可能发生，但保护一下）。
  if (!cdp.port) cdp.port = pod.port;
  return cdp.toString();
}

export interface StaticPoolOptions {
  podAddrs: string[];
  fetchImpl?: FetchLike;
  /**
   * Pod /control/start 的超时上限。
   *
   * pod 端 chromium spawn + waitForCdp 默认有 POD_CHROMIUM_BOOT_TIMEOUT_MS=30_000，
   * 这里至少要覆盖那个，否则 cloud-runtime 会先 abort，留下 pod 端孤儿 chromium。
   * 我们额外留 5s buffer 给 HTTP roundtrip + JSON 序列化。
   */
  startTimeoutMs?: number;
}

export class StaticPoolMachineManager implements MachineManager {
  readonly kind = 'static' as const;
  readonly #pods: PodEntry[];
  readonly #fetch: FetchLike;
  readonly #startTimeoutMs: number;
  /** machineId → podOrigin，便于 release 反查。 */
  readonly #machineToPod: Map<string, string> = new Map();

  constructor(opts: StaticPoolOptions) {
    if (opts.podAddrs.length === 0) {
      throw new Error('StaticPoolMachineManager: POD_ADDRS 至少要有 1 个 pod');
    }
    this.#pods = opts.podAddrs.map((origin) => ({ origin, busyMachineId: null }));
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#startTimeoutMs = opts.startTimeoutMs ?? 35_000;
  }

  async acquire(spec: AcquireSpec): Promise<AcquiredMachine> {
    const log = getLogger();
    const candidate = this.#pods.find((p) => p.busyMachineId === null);
    if (!candidate) {
      throw new ApiError('pool.exhausted', 'No idle pod in static pool', {
        cap: this.#pods.length,
      });
    }

    // 提前占位，防止并发 acquire 撞同一 pod。
    const provisionalMachineId = newId('mch');
    candidate.busyMachineId = provisionalMachineId;

    const startReq: PodStartRequest = {
      sessionId: spec.sessionId,
      persona: spec.persona,
      stealth: spec.stealth,
      ttlSeconds: spec.ttlSeconds,
      ...(spec.viewport ? { viewport: spec.viewport } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#startTimeoutMs);
    let resp: Response;
    try {
      resp = await this.#fetch(`${candidate.origin}/control/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(startReq),
        signal: controller.signal,
      });
    } catch (err) {
      candidate.busyMachineId = null;
      const detail: Record<string, unknown> = { podOrigin: candidate.origin };
      if (err instanceof Error) detail.cause = err.message;
      log.error(detail, 'pod /control/start failed');
      throw new ApiError('pool.pod_unhealthy', 'pod /control/start failed', detail);
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      candidate.busyMachineId = null;
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `pod returned ${resp.status}`, {
        podOrigin: candidate.origin,
        body: text.slice(0, 256),
      });
    }

    const podJson = (await resp.json().catch(() => null)) as PodStartResponse | null;
    if (!podJson || typeof podJson.cdpUrl !== 'string' || typeof podJson.machineId !== 'string') {
      candidate.busyMachineId = null;
      throw new ApiError('machine.spawn_failed', 'pod returned invalid /control/start payload', {
        podOrigin: candidate.origin,
      });
    }

    // 用 pod 给的 machineId 覆盖（pod 知道更详细的 container/processId）。
    candidate.busyMachineId = podJson.machineId;
    this.#machineToPod.set(podJson.machineId, candidate.origin);

    // pod 的 cdpUrl 形如 ws://localhost:9223/devtools/browser/<uuid>，host 部分
    // 是 chromium 自报的 0.0.0.0/localhost，控制平面无法直接连。我们用 pod
    // origin 的 host 替换 ws URL 的 host，保留 port + path。
    const cdpRouted = rewriteCdpHost(podJson.cdpUrl, candidate.origin);

    return {
      id: podJson.machineId,
      podOrigin: candidate.origin,
      cdpInternalUrl: cdpRouted,
    };
  }

  async release(machineId: string): Promise<void> {
    const log = getLogger();
    const podOrigin = this.#machineToPod.get(machineId);
    if (!podOrigin) {
      log.debug({ machineId }, 'release: machine unknown, idempotent skip');
      return;
    }

    const pod = this.#pods.find((p) => p.origin === podOrigin);
    if (pod) pod.busyMachineId = null;
    this.#machineToPod.delete(machineId);

    // best-effort POST /control/stop. 失败不抛，只 warn —— release 必须幂等。
    try {
      await this.#fetch(`${podOrigin}/control/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ machineId }),
      });
    } catch (err) {
      log.warn(
        { machineId, podOrigin, cause: err instanceof Error ? err.message : String(err) },
        'pod /control/stop failed, marking idle anyway',
      );
    }
  }

  async capacity(): Promise<{ ready: number; busy: number; cap: number }> {
    const cap = this.#pods.length;
    const busy = this.#pods.filter((p) => p.busyMachineId !== null).length;
    return { ready: cap - busy, busy, cap };
  }

  async shutdown(): Promise<void> {
    const log = getLogger();
    const machineIds = [...this.#machineToPod.keys()];
    log.info({ count: machineIds.length }, 'static pool shutdown: releasing all');
    await Promise.allSettled(machineIds.map((id) => this.release(id)));
  }
}
