/**
 * FlyPooledMachineManager —— Phase 11.3a 预热 stopped pool。
 *
 * 见 docs/PHASE-11.3-MACHINE-POOL.md 详细设计。
 *
 * 结构上是 FlyMachineManager 的 *opt-in 优化层*（组合，不是继承）：
 *   - acquire() 优先 try pool consume；pool 空则 fallback 走 FlyMachineManager.acquire()
 *   - release() 知道 machineId 来自 pool（在 #poolAlive 里）还是 cold（在 cold.#alive 里）
 *   - capacity() / shutdown() 合并两边
 *
 * 失败模式：pool 任意环节挂掉都不会传播到 acquire()——总能 fallback 到 cold path。
 * 这就是 POOL_TARGET_SIZE=0 能在 prod 即时回退到 phase 11.2 行为的根本保证：
 * 出问题时 ops 把 env 设回 0，factory 重新挑 FlyMachineManager（不带 pool 包装）。
 *
 * Pool entry single-use 语义：一旦 consume 被绑定到 session，就**不再回池**。
 * Session 结束 release 时直接 destroy。Pool 后台 loop 异步补一台新的。这样保证：
 *   - 每个 session 都跑在全新 microVM 上（无 cookies / DOM storage / 字体缓存
 *     残留——chromium fingerprint 不会跨 session 串扰）
 *   - 实现极简：pool 是一个生产者-消费者队列，不是复杂的对象池
 */

import {
  machinePoolEvictionsTotal,
  machinePoolHitsTotal,
  machinePoolMissesTotal,
  machinePoolProvisionsTotal,
} from '../metrics.js';
import { ApiError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { FlyApiClient } from './fly-api.js';
import type { FlyMachineConfig } from './fly-api.js';
import { FlyMachineManager } from './fly.js';
import type { FlyMachineManagerOptions } from './fly.js';
import { callPodStart, callPodStop, rewriteCdpHost, waitForPodReady } from './pod-control.js';
import type { FetchLike } from './pod-control.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from './types.js';

/** Pool entry 在 fly metadata 上的 marker —— bootstrap reconcile 用。 */
export const POOL_METADATA_KEY = 'mosaiq_pool';
export const POOL_METADATA_VALUE = 'true';
/** 记录 provision 时用的 podImage tag —— deploy 换镜像后旧 pool 应被 evict。 */
export const POOL_IMAGE_TAG_METADATA_KEY = 'mosaiq_pool_image_tag';

export interface FlyPooledMachineManagerOptions extends FlyMachineManagerOptions {
  /** 期望的 stopped 池大小。1-50。0 应该由 factory 直接挑 FlyMachineManager，不走这里。 */
  poolTargetSize: number;
  /** 后台补充 loop 间隔，默认 10s。 */
  poolReplenishIntervalMs?: number;
  /** 单 tick 最多并发起几个 provision，默认 2（保护 Fly API rate limit）。 */
  poolReplenishConcurrency?: number;
  /** Pool entry 最大年龄，超过则 evict + 补新，默认 24h。 */
  poolMaxAgeMs?: number;
  /** 单次 provision 硬超时（含 create + waitForState=stopped），默认 120s。 */
  poolProvisionTimeoutMs?: number;
  /** Bootstrap 时是否 destroy 看似孤儿的 stopped machine（非 pool-marked），默认 true。 */
  poolBootstrapEvictForeign?: boolean;
  /** 测试用：false → 不自动起 setInterval 补充 loop（手动调 tickReplenish）。 */
  poolAutoStart?: boolean;
}

type PoolEntryState = 'creating' | 'stopped' | 'consumed' | 'evicting';

interface PoolEntry {
  machineId: string;
  privateIp: string;
  /** ms epoch，进 pool（state=stopped）的时刻——用于 max-age eviction。 */
  createdAt: number;
  state: PoolEntryState;
}

/**
 * 默认值集中在这里，方便测试快速覆盖。Production 跑 prod 默认值即可。
 */
const POOL_DEFAULTS = {
  replenishIntervalMs: 10_000,
  replenishConcurrency: 2,
  maxAgeMs: 24 * 60 * 60 * 1000,
  provisionTimeoutMs: 120_000,
  provisionPollIntervalMs: 1000,
  bootstrapEvictForeign: true,
} as const;

export class FlyPooledMachineManager implements MachineManager {
  readonly kind = 'fly' as const;

  readonly #api: FlyApiClient;
  /** Cold fallback delegate. Pool 空时 acquire 转给它；它有自己独立的 #alive。 */
  readonly #cold: FlyMachineManager;

  // Pool knobs
  readonly #targetSize: number;
  readonly #replenishIntervalMs: number;
  readonly #replenishConcurrency: number;
  readonly #maxAgeMs: number;
  readonly #provisionTimeoutMs: number;
  readonly #bootstrapEvictForeign: boolean;

  // Pod machine config (重复存一份以便 pool 自己 provision 不依赖 cold delegate 的私有字段)
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

  /** 池里所有 entry —— state 字段区分 creating / stopped / consumed / evicting。 */
  readonly #pool = new Map<string, PoolEntry>();
  /** Pool 出去的 session：machineId → podOrigin。release() 路由用。 */
  readonly #poolAlive = new Map<string, string>();

  #replenishTimer: ReturnType<typeof setInterval> | null = null;
  #shuttingDown = false;

  constructor(opts: FlyPooledMachineManagerOptions) {
    if (opts.poolTargetSize < 1) {
      throw new Error(
        'FlyPooledMachineManager: poolTargetSize must be >= 1 (factory should pick FlyMachineManager when pool disabled)',
      );
    }
    if (opts.poolTargetSize > 50) {
      throw new Error('FlyPooledMachineManager: poolTargetSize capped at 50 (safety, see PHASE-11.3 §10)');
    }

    // 内部 cold 复用同一组 opts。它会自己 new FlyApiClient——我们用它的 api getter
    // 而不另起一个，省一份 fetch impl + auth headers 的内存，更重要的是单测里
    // mock 一份 fetchImpl 就能拦截 cold path + pool path 全部 HTTP。
    this.#cold = new FlyMachineManager(opts);
    this.#api = this.#cold.api;

    this.#targetSize = opts.poolTargetSize;
    this.#replenishIntervalMs = opts.poolReplenishIntervalMs ?? POOL_DEFAULTS.replenishIntervalMs;
    this.#replenishConcurrency = opts.poolReplenishConcurrency ?? POOL_DEFAULTS.replenishConcurrency;
    this.#maxAgeMs = opts.poolMaxAgeMs ?? POOL_DEFAULTS.maxAgeMs;
    this.#provisionTimeoutMs = opts.poolProvisionTimeoutMs ?? POOL_DEFAULTS.provisionTimeoutMs;
    this.#bootstrapEvictForeign = opts.poolBootstrapEvictForeign ?? POOL_DEFAULTS.bootstrapEvictForeign;

    this.#podImage = opts.podImage;
    this.#region = opts.region;
    this.#podControlPort = opts.podControlPort;
    this.#maxMachines = opts.maxMachines;
    this.#machineCpus = opts.machineCpus;
    this.#machineMemoryMb = opts.machineMemoryMb;
    this.#podEnv = opts.podEnv ?? {};
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#waitForStartedTimeoutMs = opts.waitForStartedTimeoutMs ?? 90_000;
    this.#waitForStartedIntervalMs = opts.waitForStartedIntervalMs ?? 500;
    this.#waitForPodReadyTimeoutMs = opts.waitForPodReadyTimeoutMs ?? 30_000;
    this.#podStartTimeoutMs = opts.podStartTimeoutMs ?? 75_000;

    if (opts.poolAutoStart !== false) {
      this.#startReplenishLoop();
    }
  }

  // ─── MachineManager interface ──────────────────────────────────────────

  async acquire(spec: AcquireSpec): Promise<AcquiredMachine> {
    const log = getLogger();

    // ─── 合并 cap 检查 ─────────────────────────────────────────────────
    // poolAlive + pool.size + cold.busy 是当前所有正在 / 即将占用 machine 的计数。
    // 超 cap 立即拒，不消耗 pool entry 也不调 cold（cold 自己也会再查一次，但提前
    // 拒能避免 cold 抓 placeholder 之后才 fail——更省 Fly API 调用 + 更快的错误反馈）。
    const coldCap = await this.#cold.capacity();
    const totalAccounted = this.#poolAlive.size + this.#pool.size + coldCap.busy;
    if (totalAccounted >= this.#maxMachines) {
      throw new ApiError('pool.exhausted', 'Fly machine cap reached', {
        cap: this.#maxMachines,
        alive: totalAccounted,
        breakdown: {
          poolAlive: this.#poolAlive.size,
          pool: this.#pool.size,
          coldAlive: coldCap.busy,
        },
      });
    }

    // ─── Try pool ─────────────────────────────────────────────────────
    const entry = this.#tryConsumePoolEntry();
    if (!entry) {
      machinePoolMissesTotal.inc({ reason: 'starved' });
      log.debug({ poolSize: this.#pool.size }, 'pool: starved, falling back to cold');
      return this.#cold.acquire(spec);
    }

    const ageMs = Date.now() - entry.createdAt;
    log.info({ machineId: entry.machineId, ageMs }, 'pool: consume');

    const podOrigin = `http://[${entry.privateIp}]:${this.#podControlPort}`;
    try {
      await this.#api.startMachine(entry.machineId);
      await this.#api.waitForState(entry.machineId, 'started', {
        timeoutMs: this.#waitForStartedTimeoutMs,
        intervalMs: this.#waitForStartedIntervalMs,
      });
      await waitForPodReady({
        podOrigin,
        fetchImpl: this.#fetchImpl,
        timeoutMs: this.#waitForPodReadyTimeoutMs,
      });
      const podResp = await callPodStart({
        podOrigin,
        spec,
        fetchImpl: this.#fetchImpl,
        timeoutMs: this.#podStartTimeoutMs,
      });

      this.#poolAlive.set(entry.machineId, podOrigin);
      machinePoolHitsTotal.inc();
      return {
        id: entry.machineId,
        podOrigin,
        cdpInternalUrl: rewriteCdpHost(podResp.cdpUrl, podOrigin),
      };
    } catch (err) {
      machinePoolMissesTotal.inc({ reason: 'entry_failed' });
      machinePoolEvictionsTotal.inc({ reason: 'consume_failed' });
      log.warn(
        { machineId: entry.machineId, cause: err instanceof Error ? err.message : String(err) },
        'pool: entry consume failed; destroying + fallback to cold',
      );
      // 销毁这台坏 entry，不阻塞 fallback。注意：**不递归 try pool**——
      // 如果 pool 全是坏 entry，递归会 thundering herd 把所有都炸掉，反而
      // 比 cold path 还慢。一次性走 cold 反而稳。
      await this.#api.destroyMachine(entry.machineId).catch(() => {
        /* swallow — pool entry destroy 失败不能让 acquire 中断 */
      });
      return this.#cold.acquire(spec);
    }
  }

  async release(machineId: string): Promise<void> {
    if (this.#poolAlive.has(machineId)) {
      const podOrigin = this.#poolAlive.get(machineId)!;
      // best-effort 让 pod 干净停 chromium
      await callPodStop({ podOrigin, machineId, fetchImpl: this.#fetchImpl });
      this.#poolAlive.delete(machineId);
      await this.#api.destroyMachine(machineId).catch((err) => {
        getLogger().warn(
          { machineId, cause: err instanceof Error ? err.message : String(err) },
          'pool: destroy on release failed (best-effort)',
        );
      });
      return;
    }
    // 不在 poolAlive 里 → cold delegate 负责
    await this.#cold.release(machineId);
  }

  async capacity(): Promise<{ ready: number; busy: number; cap: number }> {
    const cold = await this.#cold.capacity();
    // busy = 真正绑了 session 的 + pool 里预热的（占用 cap 配额）+ cold delegate 自己的
    const busy = this.#poolAlive.size + this.#pool.size + cold.busy;
    return { ready: Math.max(0, this.#maxMachines - busy), busy, cap: this.#maxMachines };
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#stopReplenishLoop();

    const log = getLogger();
    const poolIds = [...this.#pool.keys()];
    const aliveIds = [...this.#poolAlive.keys()];
    log.info(
      { pool: poolIds.length, poolAlive: aliveIds.length },
      'pool shutdown: destroying pool entries + releasing alive',
    );

    // 销毁所有 pool entry（state 不管，都不再需要）
    if (poolIds.length > 0) {
      machinePoolEvictionsTotal.inc({ reason: 'shutdown' }, poolIds.length);
    }
    await Promise.allSettled(poolIds.map((id) => this.#api.destroyMachine(id).catch(() => {})));
    this.#pool.clear();

    // 释放 pool-acquired 的 session
    await Promise.allSettled(aliveIds.map((id) => this.release(id)));

    // 让 cold delegate 释放它名下的 alive
    await this.#cold.shutdown();
  }

  // ─── Bootstrap reconcile ───────────────────────────────────────────────

  /**
   * Cloud-runtime 启动时调一次：从 Fly 实际状态重建 in-memory pool 视图。
   *
   * 行为：
   *   1) GET /v1/apps/$app/machines —— 拿全量
   *   2) 对每台 stopped 的 machine：
   *      - metadata.mosaiq_pool=true AND image_tag 匹配当前 podImage → kept，加入 #pool
   *      - metadata.mosaiq_pool=true AND image_tag 不匹配 → evict（旧 deploy 的 pool 残留）
   *      - 没 metadata.mosaiq_pool（且 poolBootstrapEvictForeign=true）→ evict（孤儿）
   *
   * 注意：非 stopped 的 machine 不动——它们要么是别人正在用的 session、要么
   * 是别的 stopped/destroying 中间态，不属于 pool 管辖。
   */
  async bootstrap(): Promise<{ kept: number; evicted: number }> {
    const log = getLogger();
    let kept = 0;
    let evicted = 0;

    const all = await this.#api.listMachines();
    for (const m of all) {
      if (m.state !== 'stopped') continue;
      const md = m.config?.metadata ?? {};
      const isPoolMarked = md[POOL_METADATA_KEY] === POOL_METADATA_VALUE;
      const imageTag = md[POOL_IMAGE_TAG_METADATA_KEY];
      const imageMatches = imageTag === this.#podImage;

      if (isPoolMarked && imageMatches) {
        this.#pool.set(m.id, {
          machineId: m.id,
          privateIp: m.private_ip,
          // 真实年龄未知（Fly 不直接返 created_at 在我们 schema 里），
          // 当成"刚进池"处理——大不了 max-age eviction 晚一个周期。
          createdAt: Date.now(),
          state: 'stopped',
        });
        kept++;
      } else if (isPoolMarked && !imageMatches) {
        // 旧 deploy 的 pool entry，必 evict
        await this.#api.destroyMachine(m.id).catch((err) => {
          log.warn(
            { machineId: m.id, oldImage: imageTag, cause: String(err) },
            'pool bootstrap: destroy stale pool entry failed',
          );
        });
        machinePoolEvictionsTotal.inc({ reason: 'bootstrap_stale' });
        evicted++;
      } else if (this.#bootstrapEvictForeign) {
        // 不是 pool entry，但 stopped 状态 → 孤儿（可能是上次 deploy 失败的残留）
        await this.#api.destroyMachine(m.id).catch((err) => {
          log.warn(
            { machineId: m.id, cause: String(err) },
            'pool bootstrap: destroy foreign stopped machine failed',
          );
        });
        machinePoolEvictionsTotal.inc({ reason: 'bootstrap_foreign' });
        evicted++;
      }
    }
    log.info({ kept, evicted, totalListed: all.length }, 'pool bootstrap reconcile done');
    return { kept, evicted };
  }

  // ─── Replenish loop ───────────────────────────────────────────────────

  #startReplenishLoop(): void {
    if (this.#replenishTimer || this.#shuttingDown) return;
    this.#replenishTimer = setInterval(() => {
      this.tickReplenish().catch((err) => {
        getLogger().warn(
          { cause: err instanceof Error ? err.message : String(err) },
          'pool replenish tick threw (will retry next interval)',
        );
      });
    }, this.#replenishIntervalMs);
    // 后台 loop 不应阻止 node 退出
    if (typeof this.#replenishTimer.unref === 'function') {
      this.#replenishTimer.unref();
    }
  }

  #stopReplenishLoop(): void {
    if (this.#replenishTimer) {
      clearInterval(this.#replenishTimer);
      this.#replenishTimer = null;
    }
  }

  /**
   * 一次补充 tick 的逻辑：
   *   1) Evict 超龄的 stopped entry
   *   2) 算需要多少新 entry，按 replenishConcurrency 上限并发起 provision
   *
   * 暴露为 public 方法 + @internal：单测可以手动调一次代替 setInterval 等待。
   * @internal
   */
  async tickReplenish(): Promise<void> {
    if (this.#shuttingDown) return;
    const log = getLogger();

    // ─── 1) Evict stale ───────────────────────────────────────────────
    const now = Date.now();
    const stale: string[] = [];
    for (const entry of this.#pool.values()) {
      if (entry.state === 'stopped' && now - entry.createdAt > this.#maxAgeMs) {
        stale.push(entry.machineId);
      }
    }
    for (const id of stale) {
      const e = this.#pool.get(id);
      if (e) e.state = 'evicting';
      this.#pool.delete(id);
      this.#api.destroyMachine(id).catch((err) => {
        log.warn(
          { machineId: id, cause: err instanceof Error ? err.message : String(err) },
          'pool: stale entry destroy failed (will retry on its own tick)',
        );
      });
      machinePoolEvictionsTotal.inc({ reason: 'max_age' });
      log.info({ machineId: id, ageMs: this.#maxAgeMs }, 'pool: evict stale entry');
    }

    // ─── 2) Replenish ─────────────────────────────────────────────────
    let stopped = 0;
    let creating = 0;
    for (const e of this.#pool.values()) {
      if (e.state === 'stopped') stopped++;
      else if (e.state === 'creating') creating++;
    }
    const need = this.#targetSize - stopped - creating;
    if (need <= 0) return;

    const concurrency = Math.min(need, Math.max(0, this.#replenishConcurrency - creating));
    if (concurrency <= 0) return;

    // Fire-and-forget；每个 provision 自己管 placeholder + state 变迁
    for (let i = 0; i < concurrency; i++) {
      void this.#provisionStoppedEntry();
    }
  }

  async #provisionStoppedEntry(): Promise<void> {
    const log = getLogger();
    // 占位 entry：tickReplenish 下一次跑能看到这个 creating slot 占着，不重复发起
    const placeholderId = `pool_pending_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const placeholder: PoolEntry = {
      machineId: placeholderId,
      privateIp: '',
      createdAt: Date.now(),
      state: 'creating',
    };
    this.#pool.set(placeholderId, placeholder);

    try {
      const created = await this.#api.createMachine({
        region: this.#region,
        skipLaunch: true,
        config: this.#buildPoolConfig(),
      });

      // skip_launch=true 后 fly 应该把 machine 留在 'stopped' 状态。但有时
      // 实际行为是 'created' 然后立刻 → 'stopped'。等到 stopped 才算真正入池。
      await this.#api.waitForState(created.id, 'stopped', {
        timeoutMs: this.#provisionTimeoutMs,
        intervalMs: POOL_DEFAULTS.provisionPollIntervalMs,
      });

      // 替换 placeholder
      this.#pool.delete(placeholderId);
      this.#pool.set(created.id, {
        machineId: created.id,
        privateIp: created.private_ip,
        createdAt: Date.now(),
        state: 'stopped',
      });
      machinePoolProvisionsTotal.inc({ outcome: 'success' });
      log.info(
        { machineId: created.id, ip: created.private_ip },
        'pool: entry stopped + ready to consume',
      );
    } catch (err) {
      this.#pool.delete(placeholderId);
      machinePoolProvisionsTotal.inc({ outcome: 'failed' });
      log.warn(
        { cause: err instanceof Error ? err.message : String(err) },
        'pool: provision failed (next tick will retry)',
      );
    }
  }

  #buildPoolConfig(): FlyMachineConfig {
    return {
      image: this.#podImage,
      env: {
        PORT: String(this.#podControlPort),
        POD_HEADLESS: 'true',
        // 注意：**不**带 MOSAIQ_SESSION_ID——pool entry 还不知道未来服务哪个 session。
        // session_id 在 consume 时通过 callPodStart 的 body 注入到 pod。
        ...this.#podEnv,
      },
      services: [],
      guest: {
        cpu_kind: 'shared',
        cpus: this.#machineCpus,
        memory_mb: this.#machineMemoryMb,
      },
      stop_config: { signal: 'SIGINT', timeout: '15s' },
      metadata: {
        [POOL_METADATA_KEY]: POOL_METADATA_VALUE,
        [POOL_IMAGE_TAG_METADATA_KEY]: this.#podImage,
        mosaiq_runtime: 'cloud-runtime',
      },
    };
  }

  /** Pool 里挑一个 state='stopped' 的 entry，原子 mark consumed + 从 #pool 移除。 */
  #tryConsumePoolEntry(): PoolEntry | null {
    for (const [id, entry] of this.#pool) {
      if (entry.state === 'stopped') {
        entry.state = 'consumed';
        this.#pool.delete(id);
        return entry;
      }
    }
    return null;
  }

  // ─── Test introspection (not part of MachineManager interface) ─────────

  /** @internal Test only. 返回当前 pool entries 按 state 分组的数量。 */
  inspectPool(): { creating: number; stopped: number; consumed: number; evicting: number } {
    const out = { creating: 0, stopped: 0, consumed: 0, evicting: 0 };
    for (const e of this.#pool.values()) {
      out[e.state]++;
    }
    return out;
  }

  /** @internal Test only. 当前 poolAlive 的 machineId 列表。 */
  inspectPoolAlive(): string[] {
    return [...this.#poolAlive.keys()];
  }
}
