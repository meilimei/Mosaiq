/**
 * Seeded PRNG + 统计分布采样工具，供 humanize 引擎使用。
 *
 * 设计要点：
 *   - mulberry32：32-bit 状态、单参数、确定性、足够「随机看起来」给 UI 行为模拟
 *     （不要用于密码学）。与 persona-schema/utils/seed.ts 同算法，保证整个仓库
 *     PRNG 行为一致。
 *   - gauss：Box-Muller，每次返回一个新值（缓存第二个值）
 *   - lognormal：基于 gauss
 *
 * 不依赖 Node API / DOM API，可在 SDK 任意环境运行（含 happy-dom 单测）。
 */

export interface Rng {
  /** [min, max) 均匀分布。max 边界不取到，与 Math.random 习惯一致。 */
  uniform(min: number, max: number): number;
  /** [min, max] 整数均匀（含两端）。 */
  intBetween(min: number, max: number): number;
  /** 正态分布，参数为均值与标准差。 */
  gauss(mean: number, stddev: number): number;
  /**
   * 对数正态。`meanLog` / `stddevLog` 是 underlying normal 的均值与标准差，
   * 不是结果分布的均值/标准差（注意区分）。
   */
  lognormal(meanLog: number, stddevLog: number): number;
  /** 数组均匀挑一个。空数组抛错。 */
  pick<T>(arr: readonly T[]): T;
  /** 暴露原始 [0,1) 用于自定义采样。 */
  next(): number;
}

/**
 * 把任意字符串映射为 32-bit 无符号整数 seed。
 *
 * xfnv1a 哈希（Jenkins 变种），输出确定且良好分布。
 * 与 persona-schema/utils/seed.ts 一致以避免行为漂移。
 */
function hashString(str: string): number {
  let h = 2166136261 >>> 0; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

/**
 * mulberry32：单状态 32-bit PRNG，period 2^32，分布质量足够 UI 模拟。
 * 经典实现，参考 https://gist.github.com/tommyettinger/46a3a48d4c20bcc7e5a9cbe4ddc31fcd
 */
function mulberry32(seedInt: number): () => number {
  let s = seedInt >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 创建一个由 seed 决定行为的 RNG。同 seed 同输入序列保证产出完全相同的随机
 * 结果（重要：humanize 测试与「确定性回放」依赖此性质）。
 *
 * @param seed 任意字符串。建议从 persona seed / 用户提供的字符串派生。
 */
export function makeRng(seed: string): Rng {
  const next = mulberry32(hashString(seed));

  // Box-Muller 一次产生 2 个 N(0,1)，缓存第二个
  let cachedGauss: number | null = null;

  function gaussStd(): number {
    if (cachedGauss !== null) {
      const v = cachedGauss;
      cachedGauss = null;
      return v;
    }
    // u1 必须严格 > 0，否则 log(0) = -Infinity
    let u1 = next();
    while (u1 === 0) u1 = next();
    const u2 = next();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    const z1 = mag * Math.sin(2 * Math.PI * u2);
    cachedGauss = z1;
    return z0;
  }

  return {
    next,
    uniform(min, max) {
      return min + (max - min) * next();
    },
    intBetween(min, max) {
      return Math.floor(min + (max - min + 1) * next());
    },
    gauss(mean, stddev) {
      return mean + stddev * gaussStd();
    },
    lognormal(meanLog, stddevLog) {
      return Math.exp(meanLog + stddevLog * gaussStd());
    },
    pick(arr) {
      if (arr.length === 0) throw new Error('Rng.pick: empty array');
      const idx = Math.floor(next() * arr.length);
      const v = arr[idx];
      // TS 觉得 arr[idx] 可能是 undefined（noUncheckedIndexedAccess），
      // 但我们已 clamp idx 在 [0, len)
      if (v === undefined) throw new Error('Rng.pick: unreachable');
      return v;
    },
  };
}

/**
 * 把数值 clamp 到 [lo, hi]。便利函数，humanize 内部多处用到。
 */
export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
