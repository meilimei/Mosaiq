/**
 * Rate-limit 测试两层：
 *
 *   1) `TokenBucketStore` 纯函数单测：注入 fake clock 验证 token 数学
 *   2) 集成（端到端）：通过 createApp + app.request() 验证 middleware 真的
 *      挂上、429 + Retry-After header、不同 api_key 各自独立 bucket
 *
 * 集成层只放在 app.test.ts 里维护。本文件只覆盖 TokenBucketStore 算法。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { TokenBucketStore } from './rate-limit.js';

describe('TokenBucketStore', () => {
  let now: number;
  let store: TokenBucketStore;
  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new TokenBucketStore(() => now);
  });

  it('首次 consume → 用满 capacity-1 个 token，allowed=true', () => {
    const r = store.consume('k', { capacity: 5, refillPerSec: 1 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(r.retryAfterMs).toBe(0);
  });

  it('连续 consume 到 0 → 下一次 deny，retryAfterMs 接近 1/refill * 1000', () => {
    const cfg = { capacity: 3, refillPerSec: 2 };
    expect(store.consume('k', cfg).allowed).toBe(true);
    expect(store.consume('k', cfg).allowed).toBe(true);
    expect(store.consume('k', cfg).allowed).toBe(true);
    const denied = store.consume('k', cfg);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // refill = 2/s ⇒ 等 0.5s 才有 1 token
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(490);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(510);
  });

  it('时间推进 → refill 按线性比例补充，但不超过 capacity', () => {
    const cfg = { capacity: 5, refillPerSec: 10 };
    // 用满
    for (let i = 0; i < 5; i++) {
      expect(store.consume('k', cfg).allowed).toBe(true);
    }
    expect(store.consume('k', cfg).allowed).toBe(false);

    // 推进 100ms = 10/s * 0.1s = 1 个 token
    now += 100;
    const r1 = store.consume('k', cfg);
    expect(r1.allowed).toBe(true);
    expect(store.consume('k', cfg).allowed).toBe(false);

    // 推进 1s = 10 个 token，但 capacity=5 上限封顶
    now += 1000;
    for (let i = 0; i < 5; i++) {
      expect(store.consume('k', cfg).allowed).toBe(true);
    }
    expect(store.consume('k', cfg).allowed).toBe(false);
  });

  it('不同 bucket key 各自独立计数', () => {
    const cfg = { capacity: 2, refillPerSec: 1 };
    expect(store.consume('a', cfg).allowed).toBe(true);
    expect(store.consume('a', cfg).allowed).toBe(true);
    expect(store.consume('a', cfg).allowed).toBe(false);

    // b 完全独立
    expect(store.consume('b', cfg).allowed).toBe(true);
    expect(store.consume('b', cfg).allowed).toBe(true);
  });

  it('capacity=1, refill=0.01 → 退化成"每 100s 才一次"，工作正确', () => {
    const cfg = { capacity: 1, refillPerSec: 0.01 };
    expect(store.consume('k', cfg).allowed).toBe(true);
    const denied = store.consume('k', cfg);
    expect(denied.allowed).toBe(false);
    // 1 / 0.01 = 100s = 100000ms
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(99_000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(101_000);
  });

  it('peek() 返回 bucket 状态副本（不暴露内部引用）', () => {
    store.consume('k', { capacity: 5, refillPerSec: 1 });
    const a = store.peek('k');
    expect(a).toBeDefined();
    expect(a?.tokens).toBe(4);
    // 修改副本不影响内部
    if (a) a.tokens = 999;
    const b = store.peek('k');
    expect(b?.tokens).toBe(4);
  });

  it('clear() 清掉所有 bucket，下次 consume 重新满桶', () => {
    const cfg = { capacity: 3, refillPerSec: 1 };
    store.consume('k', cfg);
    store.consume('k', cfg);
    store.clear();
    const r = store.consume('k', cfg);
    expect(r.remaining).toBe(2); // 满桶 3 - 1
  });

  it('回拨时钟 → elapsedSec 钳到 0，不会借未来的 token', () => {
    const cfg = { capacity: 5, refillPerSec: 1 };
    store.consume('k', cfg);
    now -= 60_000; // 回拨 60s
    const r = store.consume('k', cfg);
    expect(r.allowed).toBe(true);
    // 不应该把 tokens 加到 capacity 以上 / 也不能借负 elapsedSec 让未来欠债
    expect(r.remaining).toBe(3); // 4 - 1 = 3
  });
});
