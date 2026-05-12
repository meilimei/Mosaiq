import { describe, expect, it } from 'vitest';

import { type MousePoint, planMouseTrajectory } from './mouse.js';
import { makeRng } from './rng.js';

function isFinitePoint(p: MousePoint) {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.tMs);
}

describe('planMouseTrajectory', () => {
  it('starts exactly at `from` and ends exactly at `to`', () => {
    const rng = makeRng('start-end');
    const pts = planMouseTrajectory(
      { from: { x: 100, y: 200 }, to: { x: 500, y: 400 }, durationMs: 400, overshoot: false },
      rng,
    );
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) throw new Error('empty');
    expect(first.x).toBe(100);
    expect(first.y).toBe(200);
    expect(last.x).toBe(500);
    expect(last.y).toBe(400);
  });

  it('first tMs is 0, last tMs equals durationMs', () => {
    const rng = makeRng('time');
    const pts = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 300, y: 0 }, durationMs: 250, overshoot: false },
      rng,
    );
    expect(pts[0]?.tMs).toBe(0);
    expect(pts[pts.length - 1]?.tMs).toBe(250);
  });

  it('time stamps are strictly monotonic', () => {
    const rng = makeRng('mono');
    const pts = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 600, y: 300 }, durationMs: 500 },
      rng,
    );
    for (let i = 1; i < pts.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by loop
      expect(pts[i]!.tMs).toBeGreaterThan(pts[i - 1]!.tMs);
    }
  });

  it('emits no NaN / Infinity coordinates', () => {
    const rng = makeRng('finite');
    const pts = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 800, y: 600 }, durationMs: 600 },
      rng,
    );
    expect(pts.every(isFinitePoint)).toBe(true);
  });

  it('approximate sample count = duration * sampleHz / 1000', () => {
    const rng = makeRng('count');
    const pts = planMouseTrajectory(
      {
        from: { x: 0, y: 0 },
        to: { x: 400, y: 0 },
        durationMs: 300,
        sampleHz: 60,
        overshoot: false,
      },
      rng,
    );
    // 300ms * 60Hz / 1000 = 18 → ~19 points (含起点)
    expect(pts.length).toBeGreaterThanOrEqual(15);
    expect(pts.length).toBeLessThanOrEqual(22);
  });

  it('is deterministic for the same seed and input', () => {
    const a = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 400, y: 200 }, durationMs: 350 },
      makeRng('det'),
    );
    const b = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 400, y: 200 }, durationMs: 350 },
      makeRng('det'),
    );
    expect(a).toEqual(b);
  });

  it('differs across seeds', () => {
    const a = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 400, y: 200 }, durationMs: 350 },
      makeRng('seed-A'),
    );
    const b = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 400, y: 200 }, durationMs: 350 },
      makeRng('seed-B'),
    );
    // 起点终点必相同，但中间路径不同
    const midA = a[Math.floor(a.length / 2)];
    const midB = b[Math.floor(b.length / 2)];
    if (!midA || !midB) throw new Error('empty');
    const dx = Math.abs(midA.x - midB.x);
    const dy = Math.abs(midA.y - midB.y);
    expect(dx + dy).toBeGreaterThan(0.1);
  });

  it('returns single point when from ≈ to', () => {
    const pts = planMouseTrajectory(
      { from: { x: 100, y: 100 }, to: { x: 100.3, y: 100.2 } },
      makeRng('zero'),
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual({ x: 100, y: 100, tMs: 0 });
  });

  it('with overshoot=true contains a point past the target along the move direction', () => {
    const rng = makeRng('overshoot');
    const from = { x: 0, y: 0 };
    const to = { x: 400, y: 0 };
    const pts = planMouseTrajectory({ from, to, durationMs: 500, overshoot: true }, rng);
    // 寻找超过 to.x 的中间点（沿正 x 方向过冲）
    const past = pts.find((p) => p.x > to.x + 1);
    expect(past).toBeDefined();
    // 终点必须严格回到 to（不能停在过冲点）
    const last = pts[pts.length - 1];
    if (!last) throw new Error('empty');
    expect(last.x).toBe(to.x);
    expect(last.y).toBe(to.y);
  });

  it('disables overshoot for short distances even when requested', () => {
    const rng = makeRng('short');
    const from = { x: 0, y: 0 };
    const to = { x: 20, y: 0 }; // < 30px threshold
    const pts = planMouseTrajectory({ from, to, durationMs: 200, overshoot: true }, rng);
    // 短距离不应过冲（任何中间点 x 不能 > to.x）
    const past = pts.find((p) => p.x > to.x + 0.5);
    expect(past).toBeUndefined();
  });

  it('handles very long distances by splitting without exploding', () => {
    const rng = makeRng('long');
    const pts = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 2400, y: 800 }, durationMs: 1200, overshoot: false },
      rng,
    );
    expect(pts.every(isFinitePoint)).toBe(true);
    // 仍要满足 first/last 不变量
    expect(pts[0]).toEqual({ x: 0, y: 0, tMs: 0 });
    const last = pts[pts.length - 1];
    if (!last) throw new Error('empty');
    expect(last.x).toBe(2400);
    expect(last.y).toBe(800);
    expect(last.tMs).toBe(1200);
    // monotonic
    for (let i = 1; i < pts.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by loop
      expect(pts[i]!.tMs).toBeGreaterThan(pts[i - 1]!.tMs);
    }
  });

  it('infers duration from distance when durationMs not provided', () => {
    const rng = makeRng('auto');
    const pts = planMouseTrajectory(
      { from: { x: 0, y: 0 }, to: { x: 300, y: 0 }, overshoot: false },
      rng,
    );
    // 自动时长 = 80 + 300*0.6 = 260ms
    expect(pts[pts.length - 1]?.tMs).toBeCloseTo(260, 0);
  });
});
