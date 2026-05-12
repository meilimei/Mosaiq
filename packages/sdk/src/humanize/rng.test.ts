import { describe, expect, it } from 'vitest';

import { clamp, makeRng } from './rng.js';

describe('makeRng', () => {
  it('produces deterministic sequence for same seed', () => {
    const a = makeRng('seed-1');
    const b = makeRng('seed-1');
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = makeRng('seed-A');
    const b = makeRng('seed-B');
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('next returns values in [0, 1)', () => {
    const r = makeRng('range-test');
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('uniform stays within [min, max)', () => {
    const r = makeRng('uniform');
    for (let i = 0; i < 1000; i++) {
      const v = r.uniform(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
    }
  });

  it('intBetween includes both endpoints over enough samples', () => {
    const r = makeRng('int');
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = r.intBetween(1, 5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
    }
    // 1000 抽样 5 选 1，应覆盖全部
    expect(seen.size).toBe(5);
  });

  it('gauss approaches the requested mean and stddev over many samples', () => {
    const r = makeRng('gauss');
    const N = 20000;
    const samples = Array.from({ length: N }, () => r.gauss(100, 15));
    const mean = samples.reduce((a, b) => a + b, 0) / N;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / N;
    const stddev = Math.sqrt(variance);
    // 20k 样本足够，5% 容差
    expect(mean).toBeCloseTo(100, 0);
    expect(stddev).toBeGreaterThan(15 * 0.95);
    expect(stddev).toBeLessThan(15 * 1.05);
  });

  it('lognormal samples are strictly positive and median ≈ exp(meanLog)', () => {
    const r = makeRng('lognormal');
    const meanLog = Math.log(110);
    const samples = Array.from({ length: 20000 }, () => r.lognormal(meanLog, 0.35));
    expect(samples.every((s) => s > 0)).toBe(true);
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    if (median === undefined) throw new Error('unreachable');
    // lognormal 中位数 = exp(meanLog) = 110；±10% 容差
    expect(median).toBeGreaterThan(99);
    expect(median).toBeLessThan(121);
  });

  it('pick spreads roughly uniformly across the array', () => {
    const r = makeRng('pick');
    const arr = ['a', 'b', 'c', 'd'] as const;
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let i = 0; i < 4000; i++) {
      counts[r.pick(arr)] += 1;
    }
    // 每桶 ~1000，±20% 容差
    for (const k of Object.keys(counts)) {
      // biome-ignore lint/style/noNonNullAssertion: keys come from initialization
      expect(counts[k]!).toBeGreaterThan(800);
      // biome-ignore lint/style/noNonNullAssertion: keys come from initialization
      expect(counts[k]!).toBeLessThan(1200);
    }
  });

  it('pick on empty array throws', () => {
    const r = makeRng('empty');
    expect(() => r.pick([])).toThrow();
  });
});

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it('clamps below lower bound', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });
  it('clamps above upper bound', () => {
    expect(clamp(50, 0, 10)).toBe(10);
  });
  it('handles equal bounds', () => {
    expect(clamp(5, 7, 7)).toBe(7);
  });
});
