/**
 * Per-API-key rate limiting (token bucket，in-memory)。
 *
 * # 为啥要 per-API-key
 *
 * 防 runaway client：单个 client / SDK 写错 retry 循环可以一秒打几百次
 * createSession，把 pool / Fly Machine API quota / sqlite WAL 全打爆。
 * Per-IP 不行（fly proxy 前面是 CDN，全部 IP 长得一样）。
 *
 * # 算法选 token bucket
 *
 * 比固定窗口好：允许"短时间 burst（攒了 N 个 token）+ 长期受 refill rate 限"，
 * 这正好是 SDK 实际访问 pattern（一次性创 5 个 session 然后稳定使用）。
 *
 * # 为啥 in-memory（不用 Redis）
 *
 * v0.12 单 instance fly machine（min_machines_running=1，无水平扩展）。
 * 在控制平面拓扑变成多 instance 时，用 sqlite/postgres 做共享存储或上 redis。
 * Phase 11.4+ 的事。
 *
 * # 为啥按 api_key_id 而不是 project_id
 *
 * 同一个 project 下可能有 dev / staging / prod 三把 key，按 project 限会让
 * dev SDK 把 prod 一起拖死。按 key 是最小爆炸半径。
 *
 * # 为啥 middleware 而不是 per-route check
 *
 * Hono middleware 链能把 limit 配置跟 route 解耦：未来加新 route 不会忘记
 * 限流；不同的 limit 等级（strict / write / read）通过 factory 注入。
 */

import type { MiddlewareHandler } from 'hono';

import { loadEnv } from '../env.js';
import { rateLimitDeniedTotal } from '../metrics.js';
import { ApiError } from '../utils/errors.js';
import { getAuth } from './auth.js';

/**
 * 三档 rate-limit 配置，从 env 加载。
 *
 *   strict: createSession 级 endpoint
 *   write:  其他 mutate（DELETE / PATCH / persona create）
 *   read:   只读 GET
 *
 * 不缓存：env 改了重启才生效（loadEnv 自身有缓存），所以这里直接调即可。
 */
export interface RateLimitConfigs {
  strict: RateLimitConfig;
  write: RateLimitConfig;
  read: RateLimitConfig;
}

export function loadRateLimitConfigs(): RateLimitConfigs {
  const env = loadEnv();
  return {
    strict: {
      capacity: env.RATE_LIMIT_STRICT_CAPACITY,
      refillPerSec: env.RATE_LIMIT_STRICT_REFILL_PER_SEC,
    },
    write: {
      capacity: env.RATE_LIMIT_WRITE_CAPACITY,
      refillPerSec: env.RATE_LIMIT_WRITE_REFILL_PER_SEC,
    },
    read: {
      capacity: env.RATE_LIMIT_READ_CAPACITY,
      refillPerSec: env.RATE_LIMIT_READ_REFILL_PER_SEC,
    },
  };
}

/**
 * 一个 token bucket 的瞬时状态。
 *
 * tokens 是浮点：refill 按时间增量加，可以是 0.7 / 1.3 等中间值，等到 ≥ 1
 * 就允许放过一个请求。这样精度比"整数 bucket + 整秒 refill"高得多。
 */
interface BucketState {
  /** 当前可用 token（浮点）。 */
  tokens: number;
  /** 上次 refill 的时间戳（ms epoch）。 */
  lastRefillMs: number;
}

/**
 * Rate limiter 配置。
 *
 * - capacity: bucket 容量（最大 burst 大小）
 * - refillPerSec: 每秒 refill 多少个 token，决定稳态速率
 *
 * 关系：稳态 RPS = refillPerSec；最大 burst = capacity。例如 createSession
 * 想"每分钟 60 次稳态、允许 10 次 burst"：refillPerSec=1, capacity=10。
 */
export interface RateLimitConfig {
  capacity: number;
  refillPerSec: number;
}

/**
 * In-memory token bucket store。每个 (config-tag, api_key_id) 一个 bucket。
 *
 * 内部用 Map<string, BucketState>。key 形如 "create:apk_xyz" / "write:apk_xyz"。
 *
 * 不主动 GC：旧 key 的 bucket 占内存 O(N) where N = active api_key_id 数。
 * Prod 单 instance 估计几百到几千 key，每个 ~16 bytes，总 ~50 KB，可接受。
 * 真要大规模下挂 Redis 时再考虑过期。
 */
export class TokenBucketStore {
  readonly #buckets = new Map<string, BucketState>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /**
   * 尝试从 bucket 取一个 token。返回 { allowed, retryAfterMs }。
   *
   * 算法：
   *   1) 按 (now - lastRefillMs) * refillPerSec 计算应当 refill 的 token 数
   *   2) tokens = min(capacity, tokens + refill)
   *   3) 如果 tokens >= 1：扣 1 个 token，allowed=true
   *      否则 allowed=false，retryAfterMs = ceil((1 - tokens) / refillPerSec * 1000)
   */
  consume(
    bucketKey: string,
    config: RateLimitConfig,
  ): { allowed: boolean; retryAfterMs: number; remaining: number } {
    const now = this.#now();
    let state = this.#buckets.get(bucketKey);
    if (!state) {
      state = { tokens: config.capacity, lastRefillMs: now };
      this.#buckets.set(bucketKey, state);
    }
    // refill
    const elapsedSec = Math.max(0, (now - state.lastRefillMs) / 1000);
    state.tokens = Math.min(config.capacity, state.tokens + elapsedSec * config.refillPerSec);
    state.lastRefillMs = now;

    if (state.tokens >= 1) {
      state.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(state.tokens) };
    }
    const retryAfterMs = Math.ceil(((1 - state.tokens) / config.refillPerSec) * 1000);
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  /** 测试用：清空所有 bucket。 */
  clear(): void {
    this.#buckets.clear();
  }

  /** 测试用：直接读 bucket（断言 tokens / lastRefillMs）。 */
  peek(bucketKey: string): BucketState | undefined {
    const s = this.#buckets.get(bucketKey);
    return s ? { ...s } : undefined;
  }
}

/**
 * 模块级单例 store。Hono createApp() 在每个 test 里 new 一次 app，但 store
 * 是模块级的 —— 这正是 prod 想要的（同 process 的所有 request 共享 store）。
 *
 * 测试想隔离时调 `resetRateLimitStore()`。
 */
let store = new TokenBucketStore();

/** 测试用 helper：在 beforeEach 里调，避免 test 之间共享 bucket 状态。 */
export function resetRateLimitStore(): void {
  store = new TokenBucketStore();
}

/** 测试用 helper：注入定制时间源（fake timers 不友好，自己注入更可控）。 */
export function setRateLimitStoreForTesting(s: TokenBucketStore): void {
  store = s;
}

/**
 * 工厂：根据 explicit config 生成一个 hono middleware。
 *
 * 用法（很少直接用，一般通过 rateLimitTier）：
 *   sessionsRoute.post('/', rateLimit('custom', { capacity: 5, refillPerSec: 0.5 }), handler);
 *
 * 限流后抛 ApiError('rate.limit_exceeded')，Hono 全局 onError 转 429 响应；
 * 并通过 c.header('Retry-After', ...) 设响应头（标准做法）。
 */
export function rateLimit(tag: string, config: RateLimitConfig): MiddlewareHandler {
  return async (c, next) => {
    const auth = getAuth(c);
    const bucketKey = `${tag}:${auth.apiKeyId}`;
    const result = store.consume(bucketKey, config);

    // 给 client 一些可观察性 headers（即使 allowed 也带）
    c.header('X-RateLimit-Limit', String(config.capacity));
    c.header('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      c.header('Retry-After', String(retryAfterSec));
      // 仅当 tag 是已知 tier 时把它当 label 值；自定义 tag（rateLimit() 直接调）
      // 也归到 label，但通过 tier 限定枚举防 cardinality 爆炸（自定义 tag 想观测
      // 自己另起 counter 即可，不过 v0.12 没有这种用例）
      rateLimitDeniedTotal.inc({ tier: tag });
      throw new ApiError(
        'rate.limit_exceeded',
        `rate limit exceeded for ${tag} (capacity=${config.capacity}, refill=${config.refillPerSec}/s); retry after ${retryAfterSec}s`,
        { tag, retryAfterMs: result.retryAfterMs },
      );
    }
    await next();
  };
}

/**
 * 推荐入口：按 tier ('strict' | 'write' | 'read') 取 env 配置 + 生成 middleware。
 *
 * **每次请求都重读 env**（通过 loadEnv 的 module-level 缓存），让测试能在
 * beforeEach 里 mutate process.env + resetEnvCache() 然后立刻生效，无需重新
 * 构造 app。
 *
 * 三个 tier 共享同一个 store，所以同一 api_key 在 strict 和 write 上各有
 * 独立 bucket（key 前缀区分）。
 */
export type RateLimitTier = 'strict' | 'write' | 'read';

export function rateLimitTier(tier: RateLimitTier): MiddlewareHandler {
  return async (c, next) => {
    const config = loadRateLimitConfigs()[tier];
    // 复用 rateLimit 主逻辑：构造一次性 middleware 然后立刻调用
    return rateLimit(tier, config)(c, next);
  };
}
