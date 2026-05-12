/**
 * Humanize 引擎主入口。
 *
 * 把纯函数 planner（mouse / keyboard）粘合到 Playwright Page 上：
 *   - moveTo / click：调用 mouse planner，按时间戳节奏 dispatch mousemove
 *   - type：调用 keyboard planner，按时间戳节奏 dispatch keydown/keyup
 *
 * 使用方式：
 * ```ts
 * const session = await launchPersona(persona);
 * await session.humanize.click('a.login');
 * await session.humanize.type('input[name=q]', 'mosaiq');
 * ```
 *
 * 设计要点：
 *   - 这一层是「薄壳」：所有数学行为都在 mouse.ts/keyboard.ts 里被单测覆盖；
 *     这一层只负责「把规划结果按时间戳播放给 page.mouse / page.keyboard」。
 *   - 不依赖具体 Playwright 实现，而是 duck-type 一个 PlaywrightPageLike 接口；
 *     单测可传 in-memory mock，避免拉真实浏览器。
 */

import { type KeyEvent, planTypingPlan } from './keyboard.js';
import { type MousePoint, type Point, planMouseTrajectory } from './mouse.js';
import { type Rng, makeRng } from './rng.js';

// ─────────────────────────────────────────────────────────────────────────────
// PlaywrightPageLike — humanize 真正用到的最小子集
// ─────────────────────────────────────────────────────────────────────────────

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocatorLike {
  boundingBox(opts?: { timeout?: number }): Promise<BoundingBox | null>;
  click?(opts?: { timeout?: number }): Promise<void>;
  focus?(opts?: { timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded?(opts?: { timeout?: number }): Promise<void>;
}

export interface PageLike {
  locator(selector: string): LocatorLike;
  mouse: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
    down(opts?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
    up(opts?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
  };
  keyboard: {
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 公共选项
// ─────────────────────────────────────────────────────────────────────────────

export type HumanizeSpeed = 'slow' | 'normal' | 'fast';

export interface HumanizeDefaults {
  /** 默认速度。'fast' / 'slow' 影响 typing flight 与 mouse duration 缩放。 */
  speed?: HumanizeSpeed;
  /**
   * 用于可复现性的 seed 字符串。未提供 → 用 'humanize-default' + 当前 ms。
   * 一旦构造，整个 Humanize 实例使用同一个 RNG（事件之间共享状态）。
   */
  seed?: string;
  /**
   * 测试钩子：替代 setTimeout 完成 sleep。生产环境无需提供。
   * 对纯函数的播放节奏没有副作用 — sleep 实际等待时间不会改变事件值（只影响真实播放）。
   */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface MoveOptions {
  durationMs?: number;
  overshoot?: boolean;
  sampleHz?: number;
  /** 'center' 选元素中心；'random' 在 bbox 内均匀随机一点。默认 'random'。 */
  pointStrategy?: 'center' | 'random';
}

export interface ClickOptions extends MoveOptions {
  /** 鼠标到达后悬停时长 ms。可传区间 → 区间内随机。默认 [30, 180]。 */
  hoverMs?: number | [number, number];
  /** mousedown → mouseup 间隔 ms。默认 [50, 130]。 */
  pressMs?: number | [number, number];
  button?: 'left' | 'right' | 'middle';
}

export interface TypeOptions {
  avgFlightMs?: number;
  avgDwellMs?: number;
  /** 0..1。默认 0（关闭 typo 模拟）。 */
  typoRate?: number;
  /** 输入前是否先 click 选择器获取 focus。默认 true。 */
  clickFirst?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────────────────────────────────────

const SPEED_SCALES: Record<HumanizeSpeed, { flight: number; dwell: number; mouse: number }> = {
  slow: { flight: 1.5, dwell: 1.2, mouse: 1.4 },
  normal: { flight: 1, dwell: 1, mouse: 1 },
  fast: { flight: 0.65, dwell: 0.85, mouse: 0.7 },
};

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms);
  });

export class Humanize {
  readonly #page: PageLike;
  readonly #rng: Rng;
  readonly #speed: HumanizeSpeed;
  readonly #sleep: (ms: number) => Promise<void>;
  /**
   * 缓存当前鼠标位置。Playwright 不暴露读 mouse 位置的 API，所以 humanize 自己
   * 跟踪：moveTo/click 之后更新。初始 null = 未知，第一次 move 时会先 jump 到目标
   * 附近（短距离即时 dispatch）。
   */
  #lastMouse: Point | null = null;

  constructor(page: PageLike, opts: HumanizeDefaults = {}) {
    this.#page = page;
    this.#speed = opts.speed ?? 'normal';
    const seed = opts.seed ?? `humanize-${Date.now()}-${Math.random()}`;
    this.#rng = makeRng(seed);
    this.#sleep = opts.sleepFn ?? DEFAULT_SLEEP;
  }

  /**
   * 移动鼠标到目标点（selector 中心/随机点 或绝对坐标）。
   */
  async moveTo(target: string | Point, opts: MoveOptions = {}): Promise<void> {
    const to = await this.#resolveTarget(target, opts.pointStrategy ?? 'random');
    const from = this.#lastMouse ?? { x: to.x - 100, y: to.y - 50 };
    const scale = SPEED_SCALES[this.#speed].mouse;
    const points = planMouseTrajectory(
      {
        from,
        to,
        durationMs: opts.durationMs !== undefined ? opts.durationMs * scale : undefined,
        overshoot: opts.overshoot,
        sampleHz: opts.sampleHz,
      },
      this.#rng,
    );
    await this.#playMouse(points);
    this.#lastMouse = { x: to.x, y: to.y };
  }

  /**
   * 移动到目标 → 短 hover → mousedown → press dwell → mouseup。
   */
  async click(selector: string, opts: ClickOptions = {}): Promise<void> {
    await this.moveTo(selector, opts);
    const hoverMs = pickRange(opts.hoverMs ?? [30, 180], this.#rng);
    await this.#sleep(hoverMs);
    const button = opts.button ?? 'left';
    await this.#page.mouse.down({ button });
    const pressMs = pickRange(opts.pressMs ?? [50, 130], this.#rng);
    await this.#sleep(pressMs);
    await this.#page.mouse.up({ button });
  }

  /**
   * focus selector 并按规划逐键输入。
   */
  async type(selector: string, text: string, opts: TypeOptions = {}): Promise<void> {
    if (opts.clickFirst ?? true) {
      await this.click(selector);
    }
    const speedScale = SPEED_SCALES[this.#speed];
    const events = planTypingPlan(
      {
        text,
        avgFlightMs: opts.avgFlightMs,
        avgDwellMs: opts.avgDwellMs,
        typoRate: opts.typoRate,
        speedScale: { flight: speedScale.flight, dwell: speedScale.dwell },
      },
      this.#rng,
    );
    await this.#playKeys(events);
  }

  // ── 内部 helpers ─────────────────────────────────────────────────

  async #resolveTarget(target: string | Point, strategy: 'center' | 'random'): Promise<Point> {
    if (typeof target !== 'string') {
      return target;
    }
    const locator = this.#page.locator(target);
    if (locator.scrollIntoViewIfNeeded) {
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
      } catch {
        // 元素可能不可见或已稳定；继续走 boundingBox 让它报具体错
      }
    }
    const bb = await locator.boundingBox({ timeout: 5000 });
    if (!bb) {
      throw new Error(`humanize: element not visible or not found: ${target}`);
    }
    if (strategy === 'center') {
      return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    }
    // random：在内边距 20% 范围内均匀（避免点到边界 / hover tooltip）
    const padX = bb.width * 0.2;
    const padY = bb.height * 0.2;
    return {
      x: this.#rng.uniform(bb.x + padX, bb.x + bb.width - padX),
      y: this.#rng.uniform(bb.y + padY, bb.y + bb.height - padY),
    };
  }

  async #playMouse(points: MousePoint[]): Promise<void> {
    let prevT = 0;
    for (const p of points) {
      const wait = p.tMs - prevT;
      if (wait > 0) await this.#sleep(wait);
      await this.#page.mouse.move(p.x, p.y);
      prevT = p.tMs;
    }
  }

  async #playKeys(events: KeyEvent[]): Promise<void> {
    let prevT = 0;
    for (const ev of events) {
      const wait = ev.tMs - prevT;
      if (wait > 0) await this.#sleep(wait);
      if (ev.type === 'down') await this.#page.keyboard.down(ev.key);
      else await this.#page.keyboard.up(ev.key);
      prevT = ev.tMs;
    }
  }
}

function pickRange(v: number | [number, number], rng: Rng): number {
  if (typeof v === 'number') return v;
  return rng.uniform(v[0], v[1]);
}
