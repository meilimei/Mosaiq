/**
 * FlyApiClient — Fly Machines API 的薄封装。
 *
 * 提取自 FlyMachineManager（phase 11.2 inline 私有方法），让多个 caller 共享：
 *   - FlyMachineManager        — 单 session = 一台 machine 的 cold path
 *   - FlyPooledMachineManager  — phase 11.3a 预热 stopped pool
 *
 * 设计原则：
 *   - 纯 IO + schema 校验，**无 lifecycle 状态**（所有 alive map / pool 状态在 caller）
 *   - 错误统一抛 ApiError('machine.spawn_failed', ...) 保持跟 phase 11.2 错误码对等
 *   - fetch 注入（fetchImpl）让单测 mock 简单
 *   - **不再吃 maxMachines / cap 检查**——cap 是 caller 的并发模型问题，不是 API 客户端问题
 *
 * 参考：
 *   - https://docs.machines.dev/
 *   - https://fly.io/docs/machines/working-with-machines/#machine-states
 */

import { ApiError } from '../utils/errors.js';
import type { FetchLike } from './pod-control.js';

/**
 * Fly Machine 全部状态。我们只关心 'started'（绿灯）+ 各种终态。
 * `created` 是刚 POST 完的瞬态；`stopped` 是 skip_launch=true 后的稳态。
 */
export type FlyMachineState =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'destroying'
  | 'destroyed'
  | 'replacing'
  | 'failed';

/**
 * Fly Machines API 响应里我们关心的字段子集。完整 schema 见 docs.machines.dev。
 * `metadata` 是 string→string map，由 create 时传入，list 返回（用于 reconcile）。
 */
export interface FlyMachineResponse {
  id: string;
  state: FlyMachineState;
  private_ip: string;
  region?: string;
  name?: string;
  config?: {
    metadata?: Record<string, string>;
    image?: string;
  };
}

/**
 * POST /machines 的 body.config 字段。caller 完整构造好传进来，
 * client 只负责包成 outer body + 发 HTTP。
 */
export interface FlyMachineConfig {
  image: string;
  env: Record<string, string>;
  /** 必传 []（空数组）：不分配 anycast IP / 不开公网端口。pod 是 6PN-only。 */
  services: unknown[];
  guest: {
    cpu_kind: 'shared' | 'performance';
    cpus: number;
    memory_mb: number;
  };
  /** SIGINT + grace period for chromium 干净退出。 */
  stop_config?: { signal: string; timeout: string };
  /** 留给 dashboard / reconcile 的标签。string→string map。 */
  metadata?: Record<string, string>;
}

export interface FlyApiClientOptions {
  apiToken: string;
  appName: string;
  /** Fly Machines API base URL，默认 https://api.machines.dev/v1。 */
  apiBaseUrl?: string;
  /** Fetch 注入。单测必填，prod 走 global fetch。 */
  fetchImpl?: FetchLike;
}

/**
 * Default terminal failure states —— 看到就直接抛错，不再 poll。
 *
 * 注意：'stopped' **不在**默认列表里。phase 11.3a pool 用 `target='stopped'`，
 * 那语境下 stopped 是成功；而 phase 11.2 cold path 期望 `target='started'`，
 * stopped 算异常——靠 caller 显式传 `abortOn` 包含 'stopped' 来表达。
 */
const DEFAULT_ABORT_STATES: ReadonlyArray<FlyMachineState> = ['destroying', 'destroyed', 'failed'];

/**
 * Fly Machines API 客户端。无状态 —— 多个 caller 可以共用一个实例（构造廉价，
 * 但语义上独立 = 每个 caller 自己 new 也可以）。
 */
export class FlyApiClient {
  readonly #apiToken: string;
  readonly #appName: string;
  readonly #apiBaseUrl: string;
  readonly #fetchImpl: FetchLike;

  constructor(opts: FlyApiClientOptions) {
    if (!opts.apiToken) throw new Error('FlyApiClient: apiToken required');
    if (!opts.appName) throw new Error('FlyApiClient: appName required');
    this.#apiToken = opts.apiToken;
    this.#appName = opts.appName;
    this.#apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.machines.dev/v1').replace(/\/+$/, '');
    this.#fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 暴露给 pool 用的 readonly 视图（仅 debug / 拼 URL）。 */
  get appName(): string {
    return this.#appName;
  }

  /**
   * POST /v1/apps/$app/machines —— 创建一台 machine。
   *
   * @param input.region        Fly region 代码（'iad' / 'fra' / ...）
   * @param input.skipLaunch    true = 创建后保持 stopped 状态，不自动 start；
   *                            phase 11.3a pool 用 true，普通 cold path 用 false。
   * @param input.config        machine config —— 见 FlyMachineConfig。
   *
   * @throws ApiError('machine.spawn_failed') 5xx / 4xx / payload 缺字段
   */
  async createMachine(input: {
    region: string;
    skipLaunch?: boolean;
    config: FlyMachineConfig;
  }): Promise<FlyMachineResponse> {
    const url = `${this.#apiBaseUrl}/apps/${this.#appName}/machines`;
    const body: Record<string, unknown> = {
      region: input.region,
      config: input.config,
    };
    if (input.skipLaunch) body.skip_launch = true;

    const resp = await this.#fetchImpl(url, {
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

  /**
   * GET /v1/apps/$app/machines/:id
   * @throws ApiError('machine.spawn_failed') 上层用同一个错误码以便沿用 audit / metric label。
   */
  async getMachine(id: string): Promise<FlyMachineResponse> {
    const url = `${this.#apiBaseUrl}/apps/${this.#appName}/machines/${id}`;
    const resp = await this.#fetchImpl(url, {
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

  /**
   * GET /v1/apps/$app/machines —— 列表所有 machine。
   *
   * Phase 11.3a bootstrap reconcile 用：cloud-runtime 重启后从 Fly 实际状态
   * 重建 in-memory pool 视图。
   *
   * Filter 是客户端侧 filter（Fly API 不支持服务端 metadata filter），
   * 但 list 体积一般 < 50 台，filter 廉价。
   */
  async listMachines(filter?: {
    state?: FlyMachineState;
    /** 同时匹配 metadata.<key> === value */
    metadata?: Record<string, string>;
  }): Promise<FlyMachineResponse[]> {
    const url = `${this.#apiBaseUrl}/apps/${this.#appName}/machines`;
    const resp = await this.#fetchImpl(url, {
      method: 'GET',
      headers: this.#authHeaders(),
    });
    if (!resp.ok) {
      throw new ApiError('machine.spawn_failed', `fly list-machines ${resp.status}`, { url });
    }
    const json = (await resp.json().catch(() => null)) as unknown;
    if (!Array.isArray(json)) {
      throw new ApiError('machine.spawn_failed', 'fly list-machines returned non-array', { url });
    }
    const all = json as FlyMachineResponse[];
    return all.filter((m) => {
      if (filter?.state && m.state !== filter.state) return false;
      if (filter?.metadata) {
        const md = m.config?.metadata ?? {};
        for (const [k, v] of Object.entries(filter.metadata)) {
          if (md[k] !== v) return false;
        }
      }
      return true;
    });
  }

  /**
   * POST /v1/apps/$app/machines/:id/start —— 把 stopped machine 启动。
   *
   * Phase 11.3a pool consume 路径核心：从池里拿 stopped entry → start → started。
   * 比 createMachine 快很多（无 image pull、无 firecracker 冷启）。
   */
  async startMachine(id: string): Promise<void> {
    const url = `${this.#apiBaseUrl}/apps/${this.#appName}/machines/${id}/start`;
    const resp = await this.#fetchImpl(url, {
      method: 'POST',
      headers: this.#authHeaders(),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `fly start-machine ${resp.status}`, {
        machineId: id,
        body: text.slice(0, 256),
      });
    }
  }

  /**
   * POST /v1/apps/$app/machines/:id/stop —— 优雅停 machine。
   *
   * Phase 11.3a 不直接用（pool entry 用 skip_launch=true 创建，从未 started 过）；
   * 留作未来 phase 11.3b running-pool 用。
   */
  async stopMachine(id: string): Promise<void> {
    const url = `${this.#apiBaseUrl}/apps/${this.#appName}/machines/${id}/stop`;
    const resp = await this.#fetchImpl(url, {
      method: 'POST',
      headers: this.#authHeaders(),
    });
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `fly stop-machine ${resp.status}`, {
        machineId: id,
        body: text.slice(0, 256),
      });
    }
  }

  /**
   * DELETE /v1/apps/$app/machines/:id?force=true —— 强制销毁。
   *
   * 200 + 404 都视为成功（幂等 destroy；404 = 已经销毁）。
   */
  async destroyMachine(id: string): Promise<void> {
    const url = `${this.#apiBaseUrl}/apps/${this.#appName}/machines/${id}?force=true`;
    const resp = await this.#fetchImpl(url, {
      method: 'DELETE',
      headers: this.#authHeaders(),
    });
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text().catch(() => '');
      throw new ApiError('machine.spawn_failed', `fly destroy ${resp.status}`, {
        machineId: id,
        body: text.slice(0, 256),
      });
    }
  }

  /**
   * 轮询 GET /machines/:id 直到 state === target，或超时，或进入终态。
   *
   * - target='started' 用于 cold path（spec=AcquireSpec 的语义）
   * - target='stopped' 用于 phase 11.3a pool（skipLaunch 后等到 stopped）
   *
   * 终态（destroyed/destroying/failed）= 立即抛错。`stopped` 不在终态里——它
   * 既是 pool entry 的目标状态，也可能是 cold path 中的中间瞬态。
   */
  async waitForState(
    id: string,
    target: FlyMachineState,
    opts: {
      timeoutMs: number;
      intervalMs: number;
      /**
       * 看到这些 state 立即抛错（不再 poll）。
       * 默认 ['destroying','destroyed','failed']。
       *
       * Cold path（target='started'）需要传 ['stopped',...defaults]，
       * 因为 stopped 不应是 acquire 路径上的有效中间态。
       * Pool path（target='stopped'）用默认值即可——stopped 是终点。
       */
      abortOn?: ReadonlyArray<FlyMachineState>;
    },
  ): Promise<void> {
    const abortOn = opts.abortOn ?? DEFAULT_ABORT_STATES;
    const deadline = Date.now() + opts.timeoutMs;
    let lastState: FlyMachineState | null = null;
    while (Date.now() < deadline) {
      const m = await this.getMachine(id);
      lastState = m.state;
      if (m.state === target) return;
      if (abortOn.includes(m.state)) {
        throw new ApiError('machine.spawn_failed', `fly machine ${id} entered ${m.state}`, {
          machineId: id,
          state: m.state,
        });
      }
      if (Date.now() + opts.intervalMs >= deadline) break;
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
    throw new ApiError(
      'machine.spawn_failed',
      `fly machine ${id} did not reach state ${target} in time`,
      { machineId: id, lastState },
    );
  }

  #authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#apiToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }
}
