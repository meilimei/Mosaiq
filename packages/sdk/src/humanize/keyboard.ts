/**
 * Keyboard typing planner.
 *
 * 给定文本，输出一段类人击键事件序列（每键 keydown / keyup，dwell + flight
 * 服从经验分布）。纯函数，无 Playwright 依赖。
 *
 * 与 humanize.ts 的契约：planner 输出 (key, type, tMs) 序列；调用方按 tMs
 * 节奏调用 `page.keyboard.down(key)` / `page.keyboard.up(key)`。
 *
 * 数学模型见 docs/HUMANIZE-DESIGN.md §4。
 */

import { type Rng, clamp } from './rng.js';

export interface KeyEvent {
  /**
   * Playwright `keyboard.down/up` 接受的 key 名。
   * 字面字符（'a' / 'A' / ' ' / ',' 等）原样传入即可；special key 用命名形式
   * （'Shift' / 'Backspace'）。
   */
  key: string;
  type: 'down' | 'up';
  /** 自此次 type() 开始的相对时间戳，毫秒。第一个事件 tMs ≥ 0。 */
  tMs: number;
}

export interface PlanTypingInput {
  text: string;
  /** 平均键间 flight ms（前一 keyup 到下一 keydown）。默认 110。 */
  avgFlightMs?: number;
  /** 平均按键 dwell ms（keydown 到 keyup）。默认 70。 */
  avgDwellMs?: number;
  /**
   * 0..1，注入 typo 的概率。每个目标字符独立判定，命中后插入「错键 + flight +
   * Backspace + flight + 正确键」。默认 0。
   */
  typoRate?: number;
  /** 速度缩放（flight × scale.flight，dwell × scale.dwell）。 */
  speedScale?: { flight: number; dwell: number };
}

const DEFAULT_AVG_FLIGHT = 110;
const DEFAULT_AVG_DWELL = 70;
const FLIGHT_LOG_SIGMA = 0.35;
const DWELL_GAUSS_SIGMA = 20;
const FLIGHT_MIN = 25;
const FLIGHT_MAX = 1000;
const DWELL_MIN = 25;
const DWELL_MAX = 250;

/**
 * 规划文本的击键事件序列。
 *
 * **不变量**（被单测严格校验）：
 *   - 空字符串 → 空数组
 *   - 每个字符产出至少一对 down/up（典字符）或四个事件（带 Shift 的大写）
 *   - 时间戳非负且单调非递减（同一字符 down/up 严格递增）
 *   - 大写字母被分解为 Shift down → letter down → letter up → Shift up
 *   - 给定相同 (input, rng-seed) 输出完全确定
 */
export function planTypingPlan(input: PlanTypingInput, rng: Rng): KeyEvent[] {
  const text = input.text;
  if (text.length === 0) return [];

  const speedScale = input.speedScale ?? { flight: 1, dwell: 1 };
  const avgFlight = (input.avgFlightMs ?? DEFAULT_AVG_FLIGHT) * speedScale.flight;
  const avgDwell = (input.avgDwellMs ?? DEFAULT_AVG_DWELL) * speedScale.dwell;
  const typoRate = clamp(input.typoRate ?? 0, 0, 1);

  // lognormal 的 underlying μ 取 ln(avgFlight) 的偏移使中位数 ≈ avgFlight；
  // 同时 lognormal 均值 = exp(μ + σ²/2)，要 ≈ avgFlight 需 μ = ln(avgFlight) - σ²/2
  const flightLogMean = Math.log(avgFlight) - FLIGHT_LOG_SIGMA ** 2 / 2;

  const events: KeyEvent[] = [];
  let t = 0;
  let prevChar: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) continue;

    // 第一个字符前不加 flight；之后每个字符前加上下一个 flight
    if (i > 0) {
      t += sampleFlight(prevChar, ch, flightLogMean, FLIGHT_LOG_SIGMA, rng);
    }

    // typo 注入：以 typoRate 概率先按错键，再 backspace 修正
    // （首字符不注入：常见做法是「打错就重打」，第一个字符就错会让回放看起来很怪）
    if (i > 0 && rng.next() < typoRate) {
      const wrong = neighborKey(ch, rng);
      if (wrong !== null) {
        const wrongDwell = sampleDwell(avgDwell, rng);
        events.push({ key: wrong, type: 'down', tMs: t });
        t += wrongDwell;
        events.push({ key: wrong, type: 'up', tMs: t });
        // typo 后的反应时（120–400ms）
        t += rng.uniform(120, 400);
        const bsDwell = sampleDwell(avgDwell, rng);
        events.push({ key: 'Backspace', type: 'down', tMs: t });
        t += bsDwell;
        events.push({ key: 'Backspace', type: 'up', tMs: t });
        // 修正后再短暂停顿
        t += rng.uniform(50, 200);
      }
    }

    const dwell = sampleDwell(avgDwell, rng);
    const needsShift = isUppercase(ch);

    if (needsShift) {
      // Shift 先按下，30ms preload 后字母 keydown，字母 up 后 Shift up
      events.push({ key: 'Shift', type: 'down', tMs: t });
      t += rng.uniform(20, 45);
      events.push({ key: ch, type: 'down', tMs: t });
      t += dwell;
      events.push({ key: ch, type: 'up', tMs: t });
      t += rng.uniform(15, 40);
      events.push({ key: 'Shift', type: 'up', tMs: t });
    } else {
      events.push({ key: ch, type: 'down', tMs: t });
      t += dwell;
      events.push({ key: ch, type: 'up', tMs: t });
    }

    prevChar = ch;
  }

  return events;
}

function sampleDwell(avgDwell: number, rng: Rng): number {
  return clamp(rng.gauss(avgDwell, DWELL_GAUSS_SIGMA), DWELL_MIN, DWELL_MAX);
}

/**
 * 采样 flight 时长，并按上下文做经验性调整：
 *   - 空格之后：flight × 1.4（word boundary）
 *   - 标点之后：flight × 1.6
 *   - 重复字符（aa）：flight × 0.8
 */
function sampleFlight(
  prevChar: string | null,
  curChar: string,
  flightLogMean: number,
  flightLogSigma: number,
  rng: Rng,
): number {
  let f = rng.lognormal(flightLogMean, flightLogSigma);
  if (prevChar === ' ') f *= 1.4;
  else if (prevChar !== null && /[.,!?;:]/.test(prevChar)) f *= 1.6;
  else if (prevChar !== null && prevChar.toLowerCase() === curChar.toLowerCase()) f *= 0.8;
  return clamp(f, FLIGHT_MIN, FLIGHT_MAX);
}

function isUppercase(ch: string): boolean {
  // 仅处理拉丁大写。其他写法（CJK / Emoji）走默认路径不加 Shift。
  return ch.length === 1 && ch >= 'A' && ch <= 'Z';
}

/**
 * 返回 QWERTY 布局上 ch 的相邻按键（用于 typo）。返回 null 表示找不到（跳过 typo）。
 */
function neighborKey(ch: string, rng: Rng): string | null {
  const lower = ch.toLowerCase();
  const neighbors = QWERTY_NEIGHBORS[lower];
  if (!neighbors || neighbors.length === 0) return null;
  return rng.pick(neighbors);
}

// QWERTY 相邻键映射（仅小写字母 + 部分常用标点；空格、数字略去）
const QWERTY_NEIGHBORS: Record<string, readonly string[]> = {
  q: ['w', 'a'],
  w: ['q', 'e', 'a', 's'],
  e: ['w', 'r', 's', 'd'],
  r: ['e', 't', 'd', 'f'],
  t: ['r', 'y', 'f', 'g'],
  y: ['t', 'u', 'g', 'h'],
  u: ['y', 'i', 'h', 'j'],
  i: ['u', 'o', 'j', 'k'],
  o: ['i', 'p', 'k', 'l'],
  p: ['o', 'l'],
  a: ['q', 'w', 's', 'z'],
  s: ['a', 'w', 'e', 'd', 'z', 'x'],
  d: ['s', 'e', 'r', 'f', 'x', 'c'],
  f: ['d', 'r', 't', 'g', 'c', 'v'],
  g: ['f', 't', 'y', 'h', 'v', 'b'],
  h: ['g', 'y', 'u', 'j', 'b', 'n'],
  j: ['h', 'u', 'i', 'k', 'n', 'm'],
  k: ['j', 'i', 'o', 'l', 'm'],
  l: ['k', 'o', 'p'],
  z: ['a', 's', 'x'],
  x: ['z', 's', 'd', 'c'],
  c: ['x', 'd', 'f', 'v'],
  v: ['c', 'f', 'g', 'b'],
  b: ['v', 'g', 'h', 'n'],
  n: ['b', 'h', 'j', 'm'],
  m: ['n', 'j', 'k'],
};
