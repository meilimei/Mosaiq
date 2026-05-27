/**
 * FlyMachineManager —— v0.12 phase 11.2 prod 路径。
 *
 * 一次 acquire 的全流程：
 *   1) POST {FLY_API_BASE_URL}/apps/{FLY_POD_APP_NAME}/machines
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
 * Phase 11.3a 重构（commit 2 of phase 11.3a）：
 *   把 Fly Machines API 调用全部抽到 FlyApiClient（fly-api.ts），让 phase 11.3a
 *   的 FlyPooledMachineManager 能复用同一份 API 客户端而不继承 FlyMachineManager
 *   （组合优于继承——pool 是 cold path 的 *包装层*，不是 *变种*）。本文件**业务
 *   语义零改动**，所有原有单测应保持绿。
 *
 * 设计要点：
 *   - 用 IPv6 6PN 私网地址（Fly 同 org 内 Machine 之间天然可达，不暴露公网）
 *   - 不使用 Fly Apps 的 [[services]] 段——pod app 完全是内部，控制平面是唯一调用方
 *   - 失败时尽量不留孤儿 machine：provision 出来后任何环节抛错都要 force-destroy
 *   - 单测全 mock fetch + 不依赖 timers（用 vi.useFakeTimers 控制 polling）
 */

import { ApiError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { FlyApiClient } from './fly-api.js';
import type {
  FlyApiClientOptions,
  FlyMachineConfig,
  FlyMachineResponse,
  FlyMachineState,
} from './fly-api.js';
import { callPodStart, callPodStop, rewriteCdpHost, waitForPodReady } from './pod-control.js';
import type { FetchLike } from './pod-control.js';
import type { AcquireSpec, AcquiredMachine, MachineManager, ReleaseOptions } from './types.js';

// Re-export for callers that historically imported from fly.ts (e.g. factory.ts).
// New callers should import from './fly-api.js' directly.
export type { FlyMachineResponse, FlyMachineState } from './fly-api.js';

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

/**
 * Cold path 看到 'stopped' 视为 terminal-bad（机器不该在 acquire 路径上变成 stopped）。
 * Pool path（fly-pool.ts）走 default abortOn，因为 pool 把 'stopped' 当成功目标。
 */
const COLD_PATH_ABORT_STATES: ReadonlyArray<FlyMachineState> = [
  'stopped',
  'destroying',
  'destroyed',
  'failed',
];

export class FlyMachineManager implements MachineManager {
  readonly kind = 'fly' as const;

  /** Fly Machines API 客户端。复用给 fly-pool.ts。 */
  readonly #api: FlyApiClient;

  readonly #podImage: string;
  readonly #region: string;
  readonly #podControlPort: number;
  readonly #maxMachines: number;
  readonly #machineCpus: number;
  readonly #machineMemoryMb: number;
  readonly #podEnv: Record<string, string>;
  readonly #fetchImpl: FetchLike;
  readonly #waitForStartedTimeoutMs: number;
  readonly #waitForStartedIntervalMs: number;
  readonly #waitForPodReadyTimeoutMs: number;
  readonly #podStartTimeoutMs: number;

  /**
   * machineId → podOrigin。release(machineId) 反查用。
   * key 永远是 Fly 返的真实 machine id（24 hex）。
   */
  readonly #alive: Map<string, string> = new Map();

  constructor(opts: FlyMachineManagerOptions) {
    if (!opts.apiToken) throw new Error('FlyMachineManager: apiToken required');
    if (!opts.appName) throw new Error('FlyMachineManager: appName required');
    if (!opts.podImage) throw new Error('FlyMachineManager: podImage required');

    const apiClientOpts: FlyApiClientOptions = {
      apiToken: opts.apiToken,
      appName: opts.appName,
      ...(opts.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    };
    this.#api = new FlyApiClient(apiClientOpts);

    this.#podImage = opts.podImage;
    this.#region = opts.region;
    this.#podControlPort = opts.podControlPort;
    this.#maxMachines = opts.maxMachines;
    this.#machineCpus = opts.machineCpus;
    this.#machineMemoryMb = opts.machineMemoryMb;
    this.#podEnv = opts.podEnv ?? {};
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    // Fly machine 从 POST /machines （state: created） 到 state: started 的时间。
    // 含镜像 pull + firecracker boot + init exec。browser-pod 镜像 ~918MB，冷拉
    // 实测可达 30-60s（取决于 Fly registry CDN 命中和 region 同 host）。给 90s。
    this.#waitForStartedTimeoutMs = opts.waitForStartedTimeoutMs ?? 90_000;
    this.#waitForStartedIntervalMs = opts.waitForStartedIntervalMs ?? 500;
    // Fly firecracker microVM 上 pod 启动到 hono /healthz 就绪需要 ~5s（vsLocalDocker
    // 的 ~1s）—— 内核启动 + node 启动 + pnpm imports + hono 起来。30s 给够余量。
    this.#waitForPodReadyTimeoutMs = opts.waitForPodReadyTimeoutMs ?? 30_000;
    // Fly chromium 自身启动 ~18s（NetworkService init + 字体扫描 + dbus 探测累积），
    // pod 内部 POD_CHROMIUM_BOOT_TIMEOUT_MS 默认 60s。这边给 75s = 60s + 15s
    // HTTP roundtrip 余量，让 pod 内的 timeout 先 fire（拿到 chromium stderr）
    // 而不是 cloud-runtime 这边的 fetch 超时（只能拿到 abort 错误，没有诊断信息）。
    this.#podStartTimeoutMs = opts.podStartTimeoutMs ?? 75_000;
  }

  /** 暴露给 fly-pool.ts —— pool 复用同一个 FlyApiClient。仅 phase 11.3a internal use。 */
  get api(): FlyApiClient {
    return this.#api;
  }

  async acquire(spec: AcquireSpec): Promise<AcquiredMachine> {
    const log = getLogger();

    if (this.#alive.size >= this.#maxMachines) {
      throw new ApiError('pool.exhausted', 'Fly machine cap reached', {
        cap: this.#maxMachines,
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
      created = await this.#api.createMachine({
        region: this.#region,
        config: this.#buildSessionConfig(spec),
      });
    } catch (err) {
      this.#alive.delete(placeholder);
      throw err;
    }
    log.info(
      { machineId: created.id, region: created.region, ip: created.private_ip },
      'fly: machine created',
    );

    // 从这里开始任何失败都要 force-destroy 这台 machine。
    const podOrigin = `http://[${created.private_ip}]:${this.#podControlPort}`;

    try {
      // ─── 2) 等 fly state=started ──────────────────────────────────────
      // 'stopped' 在 cold path 也算 abortOn——acquire 不该看到机器停掉。
      await this.#api.waitForState(created.id, 'started', {
        timeoutMs: this.#waitForStartedTimeoutMs,
        intervalMs: this.#waitForStartedIntervalMs,
        abortOn: COLD_PATH_ABORT_STATES,
      });

      // ─── 3) 等 pod /healthz ───────────────────────────────────────────
      await waitForPodReady({
        podOrigin,
        fetchImpl: this.#fetchImpl,
        timeoutMs: this.#waitForPodReadyTimeoutMs,
      });

      // ─── 4) callPodStart 共享 ─────────────────────────────────────────
      const podResp = await callPodStart({
        podOrigin,
        spec,
        fetchImpl: this.#fetchImpl,
        timeoutMs: this.#podStartTimeoutMs,
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
      await this.#api.destroyMachine(created.id).catch((destroyErr) => {
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

  async release(machineId: string, opts?: ReleaseOptions): Promise<void> {
    const log = getLogger();
    const podOrigin = this.#alive.get(machineId);

    // Phase 11.5: hold=true 让 fly machine 保持 running，跳过 callPodStop +
    // destroyMachine。chromium 进程不动，volume / --user-data-dir 留存。
    // alive map 仍记账，maxMachines cap 维持占用，Fly 侧持续计费 running 状态。
    // 后续 release(id, {hold: false}) 才会真正 destroy。
    if (opts?.hold === true) {
      log.debug(
        { machineId, podOrigin: podOrigin ?? null },
        'release(hold=true): fly machine retained running, alive slot kept',
      );
      return;
    }

    if (podOrigin) {
      // best-effort 让 pod 干净停 chromium。pod-control 内部不抛错。
      await callPodStop({ podOrigin, machineId, fetchImpl: this.#fetchImpl });
      this.#alive.delete(machineId);
    } else {
      log.debug({ machineId }, 'release: machine unknown to fly manager, will still attempt destroy');
    }
    // 即使 alive 没记录，也尝试 force-destroy —— 应对控制平面重启后被丢失的孤儿。
    await this.#api.destroyMachine(machineId).catch((err) => {
      log.warn(
        { machineId, cause: err instanceof Error ? err.message : String(err) },
        'fly destroy failed during release (treat as best-effort)',
      );
    });
  }

  async capacity(): Promise<{ ready: number; busy: number; cap: number }> {
    const cap = this.#maxMachines;
    const busy = this.#alive.size;
    return { ready: cap - busy, busy, cap };
  }

  async shutdown(): Promise<void> {
    const log = getLogger();
    const ids = [...this.#alive.keys()];
    log.info({ count: ids.length }, 'fly pool shutdown: releasing all');
    await Promise.allSettled(ids.map((id) => this.release(id)));
  }

  /**
   * 构造 cold-path session machine 的 config block。
   *
   * Pool path（fly-pool.ts）会 build 一个 *generic* config（无 sessionId metadata），
   * 跟这个完全分开——pool entry 创建时还不知道未来会服务哪个 session。
   */
  #buildSessionConfig(spec: AcquireSpec): FlyMachineConfig {
    return {
      image: this.#podImage,
      env: {
        // 这些值传给 pod 容器内的 env.ts。pod 自己也有 default，但显式传更可控。
        PORT: String(this.#podControlPort),
        POD_HEADLESS: 'true',
        MOSAIQ_SESSION_ID: spec.sessionId,
        ...this.#podEnv,
      },
      // 关键：no [[services]] block → 不分配 anycast IP / 不开公网端口
      services: [],
      guest: {
        cpu_kind: 'shared',
        cpus: this.#machineCpus,
        memory_mb: this.#machineMemoryMb,
      },
      // 让 fly 在 start 后 SIGINT 才停（chromium 进程清理依赖 SIGTERM）
      stop_config: { signal: 'SIGINT', timeout: '15s' },
      // metadata 让 fly dashboard 上能看出来这台 machine 服务的 session
      metadata: {
        mosaiq_session_id: spec.sessionId,
        mosaiq_runtime: 'cloud-runtime',
      },
    };
  }
}
