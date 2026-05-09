/**
 * Noise seed 生成与派生：基于单个 master seed 派生出多个子 seed，
 * 保证同一 persona 的 canvas/webgl/audio 噪声有确定关联但互不相关。
 */

import { createHash, randomBytes } from 'node:crypto';

import type { NoiseSeed } from '../fingerprint.js';

/**
 * 生成一个随机 32-bit noise seed（hex 8 位）。
 */
export function randomNoiseSeed(): NoiseSeed {
  return randomBytes(4).toString('hex') as NoiseSeed;
}

/**
 * 基于 master seed 和 domain 派生子 seed。
 * 相同 (master, domain) 总产出相同结果；不同 domain 产出不相关的 seed。
 *
 * 用法：
 *   const master = 'a1b2c3d4';
 *   const canvas = deriveSeed(master, 'canvas');
 *   const webgl  = deriveSeed(master, 'webgl');
 *   const audio  = deriveSeed(master, 'audio');
 */
export function deriveSeed(master: NoiseSeed, domain: string): NoiseSeed {
  const hash = createHash('sha256').update(master).update('|').update(domain).digest();
  return hash.subarray(0, 4).toString('hex') as NoiseSeed;
}

/**
 * 稳定 PRNG：基于 seed 产出 [0, 1) 的伪随机数流。
 * 使用 mulberry32，在 persona-schema 和注入脚本两端行为一致。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把 hex seed 转成 uint32，供 mulberry32 使用。
 */
export function seedToUint32(seed: NoiseSeed): number {
  return Number.parseInt(seed, 16) >>> 0;
}
