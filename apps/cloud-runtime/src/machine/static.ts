/**
 * StaticPoolMachineManager —— 预先存在的 pod 池，按 round-robin 分配。
 *
 * 适用：
 *   - 本地 docker compose 起多个 browser-pod 容器
 *   - dev 单独跑 `pnpm --filter @mosaiq/browser-pod dev`，配 POD_ADDRS=http://localhost:9222
 *   - prod 接 K8s Service ClusterIP（一组固定 endpoint）—— phase 11.2 暂不推荐，
 *     prod 优先走 Fly（per-session microVM）以获得真隔离
 *
 * 内部状态：
 *   - busy: Map<podOrigin, machineId>  — 哪些 pod 当前在用
 *   - 没占用的 pod 是 ready
 *
 * 并发：v0.11 是单进程 + 内存锁。phase 11.3 warm pool + 多控制平面 instance
 *   时换成 redis lock。
 */

import { ApiError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { callPodStart, callPodStop, rewriteCdpHost, POD_START_DEFAULT_TIMEOUT_MS } from './pod-control.js';
import type { AcquireSpec, AcquiredMachine, MachineManager, ReleaseOptions } from './types.js';

// 维持 phase 11.1 已发布的公共 API 形状（既有单测 import 这几个 type）。
export {
  rewriteCdpHost,
  type FetchLike,
  type PodStartRequest,
  type PodStartResponse,
} from './pod-control.js';

interface PodEntry {
  origin: string; // 'http://browser-pod-1:9222'
  busyMachineId: string | null; // null = ready
}

export interface StaticPoolOptions {
  podAddrs: string[];
  fetchImpl?: typeof fetch;
  /**
   * Pod /control/start 的超时上限。详见 pod-control.POD_START_DEFAULT_TIMEOUT_MS。
   */
  startTimeoutMs?: number;
}

export class StaticPoolMachineManager implements MachineManager {
  readonly kind = 'static' as const;
  readonly #pods: PodEntry[];
  readonly #fetch: typeof fetch;
  readonly #startTimeoutMs: number;
  /** machineId → podOrigin，便于 release 反查。 */
  readonly #machineToPod: Map<string, string> = new Map();

  constructor(opts: StaticPoolOptions) {
    if (opts.podAddrs.length === 0) {
      throw new Error('StaticPoolMachineManager: POD_ADDRS 至少要有 1 个 pod');
    }
    this.#pods = opts.podAddrs.map((origin) => ({ origin, busyMachineId: null }));
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#startTimeoutMs = opts.startTimeoutMs ?? POD_START_DEFAULT_TIMEOUT_MS;
  }

  async acquire(spec: AcquireSpec): Promise<AcquiredMachine> {
    const candidate = this.#pods.find((p) => p.busyMachineId === null);
    if (!candidate) {
      throw new ApiError('pool.exhausted', 'No idle pod in static pool', {
        cap: this.#pods.length,
      });
    }

    // 提前占位，防止并发 acquire 撞同一 pod。
    const provisionalMachineId = `mch_static_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    candidate.busyMachineId = provisionalMachineId;

    let podJson;
    try {
      podJson = await callPodStart({
        podOrigin: candidate.origin,
        spec,
        fetchImpl: this.#fetch,
        timeoutMs: this.#startTimeoutMs,
      });
    } catch (err) {
      candidate.busyMachineId = null;
      throw err;
    }

    candidate.busyMachineId = podJson.machineId;
    this.#machineToPod.set(podJson.machineId, candidate.origin);

    const cdpRouted = rewriteCdpHost(podJson.cdpUrl, candidate.origin);

    return {
      id: podJson.machineId,
      podOrigin: candidate.origin,
      cdpInternalUrl: cdpRouted,
    };
  }

  async release(machineId: string, opts?: ReleaseOptions): Promise<void> {
    const log = getLogger();
    const podOrigin = this.#machineToPod.get(machineId);
    if (!podOrigin) {
      log.debug({ machineId }, 'release: machine unknown, idempotent skip');
      return;
    }

    // Phase 11.5: hold=true 保留 pod —— 不调 /control/stop，不把 slot 释放回池。
    // pod 内 chromium 进程继续跑，--user-data-dir 不动；下一次 reconnect 直接拨号
    // 同 podOrigin。容量计数维持 busy，反映 pod 仍被该 session 占用。
    if (opts?.hold === true) {
      log.debug(
        { machineId, podOrigin },
        'release(hold=true): static pod retained, slot stays busy',
      );
      return;
    }

    const pod = this.#pods.find((p) => p.origin === podOrigin);
    if (pod) pod.busyMachineId = null;
    this.#machineToPod.delete(machineId);

    // Phase 11.6: 传递 snapshotUrl 让 pod 在 stop 时先 snapshot context（若有）。
    await callPodStop({
      podOrigin,
      machineId,
      fetchImpl: this.#fetch,
      ...(opts?.snapshotUrl ? { snapshotUrl: opts.snapshotUrl } : {}),
    });
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
