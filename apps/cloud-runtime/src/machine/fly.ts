/**
 * FlyMachineManager —— v0.12 phase 11.2 prod 路径。
 *
 * 一次 acquire 的全流程：
 *   1) POST {FLY_API_BASE_URL}/apps/{FLY_APP_NAME}/machines
 *      body: { region, config: { image, env, services: [], guest: {cpus,mem} } }
 *      → response: { id, private_ip ('fdaa:0:...:5'), state: 'created' | 'starting' }
 *   2) 轮询 GET .../machines/{id} 直到 state === 'started'（max 30s）
 *   3) podOrigin = http://[private_ip]:{FLY_POD_CONTROL_PORT}
 *   4) waitForPodReady（pod 内部 HTTP 起来需要几百 ms）
 *   5) callPodStart（共享）—— 拿到 pod 的 cdpUrl
 *   6) rewriteCdpHost 把 0.0.0.0 替换成 [private_ip]，返给上层
 *
 * release：
 *   1) callPodStop（共享）—— best-effort 通知 pod 干净停 chromium
 *   2) DELETE .../machines/{id}?force=true（不等响应；force 让 Fly 立刻销毁）
 *
 * 设计要点：
 *   - 用 IPv6 6PN 私网地址（Fly 同 org 内 Machine 之间天然可达，不暴露公网）
 *   - 不使用 Fly Apps 的 [[services]] 段——pod app 完全是内部，控制平面是唯一调用方
 *   - 失败时尽量不留孤儿 machine：provision 出来后任何环节抛错都要 force-destroy
 *   - 单测全 mock fetch + 不依赖 timers（用 vi.useFakeTimers 控制 polling）
 */

import { ApiError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { callPodStart, callPodStop, rewriteCdpHost, waitForPodReady } from './pod-control.js';
import type { FetchLike } from './pod-control.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from './types.js';

/**
 * Fly Machines API 部分 schema —— 只取我们用到的字段。完整 schema 见
 * https://docs.machines.dev/。
 */
interface FlyMachineResponse {
  id: string;
  state: FlyMachineState;
  private_ip: string;
  region?: string;
  name?: string;
}

/**
 * Fly Machine 全部状态。我们只关心 'started'（绿灯）+ 各种终态。
 * 参考：https://fly.io/docs/machines/working-with-machines/#machine-states
 */
type FlyMachineState =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'destroying'
  | 'destroyed'
  | 'replacing'
  | 'failed';

export interface FlyMachineManagerOptions {
  apiToken: string;
  appName: string;
  /** Fly Machines API base URL，默认 https://api.machines.dev/v1。 */
  apiBaseUrl?: string;
  /** pod 镜像 ref，例如 'registry.fly.io/mosaiq-browser-pod:v0.11.0' 或 ':latest'。 */
  podImage: string;
  region: string;
  podControlPort: number;
  /** 软上限（仅用于 /v1/health 报告，Fly 侧不强制）。 */
  maxMachines: number;
  /** guest cpus。 */
  machineCpus: number;
  /** guest memory，MB。 */
  machineMemoryMb: number;
  /** 透传给 pod 容器的环境变量。pod 镜像内 env.ts 会读。 */
  podEnv?: Record<string, string>;
  /** Fetch 注入，单测必填。 */
  fetchImpl?: FetchLike;
  /** Machine state 轮询参数。 */
  waitForStartedTimeoutMs?: number;
  waitForStartedIntervalMs?: number;
  waitForPodReadyTimeoutMs?: number;
  podStartTimeoutMs?: number;
}

const TERMINAL_BAD_STATES: ReadonlyArray<FlyMachineState> = [
  'stopped',
  'destroying',
  'destroyed',
  'failed',
];

export class FlyMachineManager implements MachineManager {
  readonly kind = 'fly' as const;
  readonly #opts: Required<
    Pick<
      FlyMachineManagerOptions,
      | 'apiToken'
      | 'appName'
      | 'apiBaseUrl'
      | 'podImage'
      | 'region'
      | 'podControlPort'
      | 'maxMachines'
      | 'machineCpus'
      | 'machineMemoryMb'
      | 'waitForStartedTimeoutMs'
      | 'waitForStartedIntervalMs'
      | 'waitForPodReadyTimeoutMs'
      | 'podStartTimeoutMs'
    >
  > & { podEnv: Record<string, string>; fetchImpl: FetchLike };

  /**
   * machineId → podOrigin。release(machineId) 反查用。
   * key 永远是 Fly 返的真实 machine id（24 hex）。
   */
  readonly #alive: Map<string, string> = new Map();

  constructor(opts: FlyMachineManagerOptions) {
    if (!opts.apiToken) throw new Error('FlyMachineManager: apiToken required');
    if (!opts.appName) throw new Error('FlyMachineManager: appName required');
    if (!opts.podImage) throw new Error('FlyMachineManager: podImage required');
    this.#opts = {
      apiToken: opts.apiToken,
      appName: opts.appName,
      apiBaseUrl: (opts.apiBaseUrl ?? 'https://api.machines.dev/v1').replace(/\/+$/, ''),
      podImage: opts.podImage,
      region: opts.region,
      podControlPort: opts.podControlPort,
      maxMachines: opts.maxMachines,
      machineCpus: opts.machineCpus,
      machineMemoryMb: opts.machineMemoryMb,
      podEnv: opts.podEnv ?? {},
      fetchImpl: opts.fetchImpl ?? fetch,
      waitForStartedTimeoutMs: opts.waitForStartedTimeoutMs ?? 30_000,
      waitForStartedIntervalMs: opts.waitForStartedIntervalMs ?? 500,
      waitForPodReadyTimeoutMs: opts.waitForPodReadyTimeoutMs ?? 15_000,
      podStartTimeoutMs: opts.podStartTimeoutMs ?? 35_000,
    };
  }

  async acquire(spec: AcquireSpec): Promise<AcquiredMachine> {
    const log = getLogger();

    if (this.#alive.size >= this.#opts.maxMachines) {
      throw new ApiError('pool.exhausted', 'Fly machine cap reached', {
        cap: this.#opts.maxMachines,
        alive: this.#alive.size,
      });
    }

    // ─── 并发占位 ─────────────────────────────────────────────────────
    // cap 检查与 #alive.set 之间有 await createMachine + waitForState +
    // healthz + callPodStart 一系列网络往返（可能几秒）。如果不占位，N+M
    // 个并发 POST /v1/sessions 都会通过这里的 cap 检查，最终在 Fly 起 N+M
    // 台 machine，超 cap 烧账单 + 拖垮 region quota。
    //
    // placeholder key 前缀 `pending_`，与 Fly 真实 machine id（24 hex）
    // 无碰撞。createMachine 成功后被真 id 替换；任何失败路径都要清掉。
    // 详见 static.ts 同款 provisionalMachineId + local-docker.ts 同款修复。
    const placeholder = `pending_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    this.#alive.set(placeholder, '');

    // ─── 1) provision machine ────────────────────────────────────────────
    let created: FlyMachineResponse;
    try {
      created = await this.#createMachine(spec);
    } catch (err) {
      this.#alive.delete(placeholder);
      throw err;
    }
    log.info(
      { machineId: created.id, region: created.region, ip: created.private_ip },
      'fly: machine created',
    );

    // 从这里开始任何失败都要 force-destroy 这台 machine。
    const podOrigin = `http://[${created.private_ip}]:${this.#opts.podControlPort}`;

    try {
      // ─── 2) 等 fly state=started ──────────────────────────────────────
      await this.#waitForState(created.id, 'started');

      // ─── 3) 等 pod /healthz ───────────────────────────────────────────
      await waitForPodReady({
        podOrigin,
        fetchImpl: this.#opts.fetchImpl,
        timeoutMs: this.#opts.waitForPodReadyTimeoutMs,
      });

      // ─── 4) callPodStart 共享 ─────────────────────────────────────────
      const podResp = await callPodStart({
        podOrigin,
        spec,
        fetchImpl: this.#opts.fetchImpl,
        timeoutMs: this.#opts.podStartTimeoutMs,
      });

      // placeholder → 真 id，整个生命周期 size 不掉到 0
      this.#alive.delete(placeholder);
      this.#alive.set(created.id, podOrigin);

      return {
        id: created.id,
        podOrigin,
        cdpInternalUrl: rewriteCdpHost(podResp.cdpUrl, podOrigin),
      };
    } catch (err) {
      this.#alive.delete(placeholder);
      // 把 fly machine 销毁，避免孤儿。failure 不阻塞主错误抛出。
      log.warn(
        { machineId: created.id, cause: err instanceof Error ? err.message : String(err) },
        'fly acquire failed mid-way; force-destroying machine',
      );
      await this.#destroyMachine(created.id).catch((destroyErr) => {
        log.error(
          {
            machineId: created.id,
            cause: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
          },
          'fly force-destroy after failure ALSO failed; manual cleanup may be needed',
        );
      });
      throw err;
    }
  }

  async release(machineId: string): Promise<void> {
    const log = getLogger();
    const podOrigin = this.#alive.get(machineId);
    if (podOrigin) {
      // best-effort 让 pod 干净停 chromium。pod-control 内部不抛错。
      await callPodStop({ podOrigin, machineId, fetchImpl: this.#opts.fetchImpl });
      this.#alive.delete(machineId);
    } else {
      log.debug({ machineId }, 'release: machine unknown to fly manager, will still attempt destroy');
    }
    // 即使 alive 没记录，也尝试 force-destroy —— 应对控制平面重启后被丢失的孤儿。
    await this.#destroyMachine(machineId).catch((err) => {
      log.warn(
        { machineId, cause: err instanceof Error ? err.message : String(err) },
        'fly destroy failed during release (treat as best-effort)',
      );
    });
  }

  async capacity(): Promise<{ ready: number; busy: number; cap: number }> {
    const cap = this.#opts.maxMachines;
    const busy = this.#alive.size;
    return { ready: cap - busy, busy, cap };
  }

  async shutdown(): Promise<void> {
    const log = getLogger();
    const ids = [...this.#alive.keys()];
    log.info({ count: ids.length }, 'fly pool shutdown: releasing all');
    await Promise.allSettled(ids.map((id) => this.release(id)));
  }

  // ─── Fly Machines API wrappers ───────────────────────────────────────────

  async #createMachine(spec: AcquireSpec): Promise<FlyMachineResponse> {
    const url = `${this.#opts.apiBaseUrl}/apps/${this.#opts.appName}/machines`;
    const body = {
      region: this.#opts.region,
      config: {
        image: this.#opts.podImage,
        env: {
          // 这些值传给 pod 容器内的 env.ts。pod 自己也有 default，但显式传更可控。
          PORT: String(this.#opts.podControlPort),
          POD_HEADLESS: 'true',
          MOSAIQ_SESSION_ID: spec.sessionId,
          ...this.#opts.podEnv,
        },
        // 关键：no [[services]] block → 不分配 anycast IP / 不开公网端口
        services: [],
        guest: {
          cpu_kind: 'shared',
          cpus: this.#opts.machineCpus,
          memory_mb: this.#opts.machineMemoryMb,
        },
        // 让 fly 在 start 后 SIGINT 才停（chromium 进程清理依赖 SIGTERM）
        stop_config: { signal: 'SIGINT', timeout: '15s' },
        // metadata 让 fly dashboard 上能看出来这台 machine 服务的 session
        metadata: {
          mosaiq_session_id: spec.sessionId,
          mosaiq_runtime: 'cloud-runtime',
        },
      },
    };
    const resp = await this.#opts.fetchImpl(url, {
      method: 'POST',
      headers: this.#authHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `fly machines API ${resp.status}`, {
        url,
        body: text.slice(0, 512),
      });
    }
    const json = (await resp.json().catch(() => null)) as FlyMachineResponse | null;
    if (!json || typeof json.id !== 'string' || typeof json.private_ip !== 'string') {
      throw new ApiError('machine.spawn_failed', 'fly machines API returned invalid payload', {
        url,
      });
    }
    return json;
  }

  async #getMachine(id: string): Promise<FlyMachineResponse> {
    const url = `${this.#opts.apiBaseUrl}/apps/${this.#opts.appName}/machines/${id}`;
    const resp = await this.#opts.fetchImpl(url, {
      method: 'GET',
      headers: this.#authHeaders(),
    });
    if (!resp.ok) {
      throw new ApiError('machine.spawn_failed', `fly get-machine ${resp.status}`, {
        machineId: id,
      });
    }
    const json = (await resp.json().catch(() => null)) as FlyMachineResponse | null;
    if (!json || typeof json.id !== 'string') {
      throw new ApiError('machine.spawn_failed', 'fly get-machine invalid payload', {
        machineId: id,
      });
    }
    return json;
  }

  async #waitForState(id: string, target: FlyMachineState): Promise<void> {
    const deadline = Date.now() + this.#opts.waitForStartedTimeoutMs;
    let lastState: FlyMachineState | null = null;
    while (Date.now() < deadline) {
      const m = await this.#getMachine(id);
      lastState = m.state;
      if (m.state === target) return;
      if (TERMINAL_BAD_STATES.includes(m.state)) {
        throw new ApiError('machine.spawn_failed', `fly machine ${id} entered ${m.state}`, {
          machineId: id,
          state: m.state,
        });
      }
      if (Date.now() + this.#opts.waitForStartedIntervalMs >= deadline) break;
      await new Promise((r) => setTimeout(r, this.#opts.waitForStartedIntervalMs));
    }
    throw new ApiError(
      'machine.spawn_failed',
      `fly machine ${id} did not reach state ${target} in time`,
      { machineId: id, lastState },
    );
  }

  async #destroyMachine(id: string): Promise<void> {
    const url = `${this.#opts.apiBaseUrl}/apps/${this.#opts.appName}/machines/${id}?force=true`;
    const resp = await this.#opts.fetchImpl(url, {
      method: 'DELETE',
      headers: this.#authHeaders(),
    });
    // 200 + 404 都视为成功（幂等 destroy；404 = 已经销毁）
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `fly destroy ${resp.status}`, {
        machineId: id,
        body: text.slice(0, 256),
      });
    }
  }

  #authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#opts.apiToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }
}
