/**
 * Mouse trajectory planner.
 *
 * 给定起止点与时长，输出一段类人鼠标轨迹（cubic Bezier + ease-in-out + 可选
 * overshoot）。纯函数，无 Playwright / DOM 依赖，便于单测与后续 fork 引擎复用。
 *
 * 与 humanize.ts 的契约：planner 输出 (x, y, tMs) 序列；调用方按 tMs 节奏调用
 * `page.mouse.move(x, y)`。tMs 单位 ms，从轨迹起点 = 0 算起。
 */

import { type Rng, clamp } from './rng.js';

export interface Point {
  x: number;
  y: number;
}

export interface MousePoint extends Point {
  /** 自轨迹起点的相对时间戳，毫秒。第一个点 tMs=0，最后一个 tMs=durationMs。 */
  tMs: number;
}

export interface PlanMouseInput {
  from: Point;
  to: Point;
  /**
   * 总移动时长 ms。未传 → 按距离推算 80 + d*0.6。
   * 极小值会被 clamp 到 30ms（事件采样下限）。
   */
  durationMs?: number;
  /** 采样频率 Hz。默认 60（与浏览器主流刷新率一致）。 */
  sampleHz?: number;
  /**
   * 是否在终点前过冲。默认 true，但距离 < 30px 时强制关闭（短距离过冲不真实）。
   */
  overshoot?: boolean;
}

const EPSILON_DIST = 1; // 同点判定阈值（像素）
const NO_OVERSHOOT_DIST = 30;
const SPLIT_DIST = 1500; // 超过此距离拆 2 段，避免控制点偏移过大产生回环
const MIN_DURATION_MS = 30;

/**
 * 主入口：规划从 from → to 的鼠标轨迹。
 *
 * **不变量**（被单测严格校验）：
 *   - 返回数组非空；同点（dist < 1px）情况下返回 1 个点
 *   - `points[0]` 严格等于 from，`points[last]` 严格等于 to
 *   - tMs 严格单调递增；首 tMs=0，末 tMs=durationMs
 *   - 所有坐标与时间戳为有限数（无 NaN/Infinity）
 *   - 给定相同 (input, rng-seed) 输出完全确定
 */
export function planMouseTrajectory(input: PlanMouseInput, rng: Rng): MousePoint[] {
  const { from, to } = input;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  // ── 同点 ─────────────────────────────────────────────────────────
  if (dist < EPSILON_DIST) {
    return [{ x: from.x, y: from.y, tMs: 0 }];
  }

  const durationMs = clamp(input.durationMs ?? autoDuration(dist), MIN_DURATION_MS, 60_000);
  const sampleHz = input.sampleHz ?? 60;
  const useOvershoot = (input.overshoot ?? true) && dist >= NO_OVERSHOOT_DIST;

  // ── 极长距离：拆 2 段 ─────────────────────────────────────────────
  // 拆点放在沿 from→to 的 60% ± rng 偏移处，并在垂直方向加少量抖动，模拟
  // 真人「先粗略对准，再精细修正」。
  if (dist > SPLIT_DIST) {
    const splitT = rng.uniform(0.55, 0.7);
    const perp = perpendicular(from, to);
    const offset = rng.uniform(-1, 1) * dist * 0.05;
    const mid: Point = {
      x: from.x + dx * splitT + perp.x * offset,
      y: from.y + dy * splitT + perp.y * offset,
    };
    const firstDuration = Math.round(durationMs * splitT);
    const seg1 = planSingleSegment({ from, to: mid }, firstDuration, sampleHz, false, rng);
    const seg2 = planSingleSegment(
      { from: mid, to },
      durationMs - firstDuration,
      sampleHz,
      useOvershoot,
      rng,
    );
    // 拼接：seg2 时间戳 += seg1 末尾；丢掉 seg2 的第一个点（与 seg1 末尾重复）
    const offsetMs = seg1[seg1.length - 1]?.tMs ?? 0;
    const tail = seg2.slice(1).map((p) => ({ ...p, tMs: p.tMs + offsetMs }));
    return [...seg1, ...tail];
  }

  return planSingleSegment({ from, to }, durationMs, sampleHz, useOvershoot, rng);
}

function planSingleSegment(
  pts: { from: Point; to: Point },
  durationMs: number,
  sampleHz: number,
  overshoot: boolean,
  rng: Rng,
): MousePoint[] {
  const { from, to } = pts;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);

  // 控制点：中点 + 沿垂直方向的随机偏移。jitter 幅度 ±15% 距离，短距离减半。
  const m: Point = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const perp = perpendicular(from, to);
  const jitterScale = dist < 80 ? 0.075 : 0.15;
  const j1 = rng.uniform(-1, 1) * dist * jitterScale;
  const j2 = rng.uniform(-1, 1) * dist * jitterScale;
  const c1: Point = { x: m.x + perp.x * j1, y: m.y + perp.y * j1 };
  const c2: Point = { x: m.x + perp.x * j2, y: m.y + perp.y * j2 };

  // overshoot：把贝塞尔终点替换成 over_point，再追加一段短回拉
  if (overshoot) {
    const overDist = rng.uniform(8, 18);
    const dirX = (to.x - from.x) / dist;
    const dirY = (to.y - from.y) / dist;
    const overPoint: Point = {
      x: to.x + dirX * overDist,
      y: to.y + dirY * overDist,
    };
    const mainDuration = Math.round(durationMs * 0.7);
    const main = sampleBezier(from, c1, c2, overPoint, mainDuration, sampleHz);
    // 校正：finite 浮点累积可能让最后一个点不严格 = overPoint，强制覆盖
    const lastMain = main[main.length - 1];
    if (lastMain) {
      lastMain.x = overPoint.x;
      lastMain.y = overPoint.y;
      lastMain.tMs = mainDuration;
    }
    // 回拉段：从 overPoint 到 to，直线 ease，时长 = 剩余
    const pullDuration = durationMs - mainDuration;
    const pull = sampleEase(overPoint, to, pullDuration, sampleHz);
    const tail = pull.slice(1).map((p) => ({ ...p, tMs: p.tMs + mainDuration }));
    const last = tail[tail.length - 1];
    if (last) {
      last.x = to.x;
      last.y = to.y;
      last.tMs = durationMs;
    }
    return [...main, ...tail];
  }

  const points = sampleBezier(from, c1, c2, to, durationMs, sampleHz);
  // 强制第一个 = from，最后一个 = to（消除浮点误差）
  const first = points[0];
  const last = points[points.length - 1];
  if (first) {
    first.x = from.x;
    first.y = from.y;
    first.tMs = 0;
  }
  if (last) {
    last.x = to.x;
    last.y = to.y;
    last.tMs = durationMs;
  }
  return points;
}

/**
 * 沿三阶贝塞尔曲线采样 N+1 个点，时间映射用 ease-in-out（中间快两端慢）。
 */
function sampleBezier(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  durationMs: number,
  sampleHz: number,
): MousePoint[] {
  const N = Math.max(2, Math.round((durationMs * sampleHz) / 1000));
  const out: MousePoint[] = [];
  for (let i = 0; i <= N; i++) {
    const tau = i / N;
    const t = easeInOutCubic(tau);
    const oneMinusT = 1 - t;
    const x =
      oneMinusT ** 3 * p0.x +
      3 * oneMinusT ** 2 * t * c1.x +
      3 * oneMinusT * t ** 2 * c2.x +
      t ** 3 * p3.x;
    const y =
      oneMinusT ** 3 * p0.y +
      3 * oneMinusT ** 2 * t * c1.y +
      3 * oneMinusT * t ** 2 * c2.y +
      t ** 3 * p3.y;
    out.push({ x, y, tMs: tau * durationMs });
  }
  return out;
}

/**
 * 直线 + ease-in-out 采样，仅用于 overshoot 的短回拉段。
 */
function sampleEase(p0: Point, p1: Point, durationMs: number, sampleHz: number): MousePoint[] {
  const N = Math.max(2, Math.round((durationMs * sampleHz) / 1000));
  const out: MousePoint[] = [];
  for (let i = 0; i <= N; i++) {
    const tau = i / N;
    const t = easeInOutCubic(tau);
    out.push({
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
      tMs: tau * durationMs,
    });
  }
  return out;
}

function easeInOutCubic(tau: number): number {
  if (tau < 0.5) return 4 * tau ** 3;
  return 1 - (-2 * tau + 2) ** 3 / 2;
}

/**
 * 单位法向量（顺时针 90° 旋转）。如果两点重合返回 (0, 0)（caller 会先排除此情况）。
 */
function perpendicular(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  return { x: -dy / len, y: dx / len };
}

/**
 * Fitts's-law-inspired 时长估算：80ms 起步 + 0.6ms/像素。
 * 对 300px 距离 ≈ 260ms，对 1000px 距离 ≈ 680ms，与真人观察一致。
 */
function autoDuration(dist: number): number {
  return 80 + dist * 0.6;
}
