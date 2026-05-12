import { describe, expect, it } from 'vitest';

import { type BoundingBox, Humanize, type LocatorLike, type PageLike } from './humanize.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory PageLike mock。记录所有 mouse / keyboard 事件以供断言。
// 不实际等待，sleepFn 替换为 instant resolve。
// ─────────────────────────────────────────────────────────────────────────────

interface MouseEvent {
  kind: 'move' | 'down' | 'up';
  x?: number;
  y?: number;
  button?: string;
}
interface KbdEvent {
  kind: 'down' | 'up';
  key: string;
}

function makeMockPage(boxes: Record<string, BoundingBox | null> = {}): {
  page: PageLike;
  mouseEvents: MouseEvent[];
  keyEvents: KbdEvent[];
} {
  const mouseEvents: MouseEvent[] = [];
  const keyEvents: KbdEvent[] = [];
  const page: PageLike = {
    locator(selector: string): LocatorLike {
      return {
        async boundingBox(): Promise<BoundingBox | null> {
          if (selector in boxes) return boxes[selector] ?? null;
          // 默认返回一个 100×30 的元素在 (200,200)
          return { x: 200, y: 200, width: 100, height: 30 };
        },
        async scrollIntoViewIfNeeded() {},
      };
    },
    mouse: {
      async move(x, y) {
        mouseEvents.push({ kind: 'move', x, y });
      },
      async down(opts) {
        mouseEvents.push({ kind: 'down', button: opts?.button ?? 'left' });
      },
      async up(opts) {
        mouseEvents.push({ kind: 'up', button: opts?.button ?? 'left' });
      },
    },
    keyboard: {
      async down(key) {
        keyEvents.push({ kind: 'down', key });
      },
      async up(key) {
        keyEvents.push({ kind: 'up', key });
      },
    },
  };
  return { page, mouseEvents, keyEvents };
}

const instantSleep = async () => {
  /* no wait */
};

describe('Humanize.moveTo', () => {
  it('emits a sequence of mouse.move calls ending exactly at target center when strategy=center', async () => {
    const { page, mouseEvents } = makeMockPage({
      'a.target': { x: 100, y: 100, width: 80, height: 40 },
    });
    const h = new Humanize(page, { seed: 'move-center', sleepFn: instantSleep });
    await h.moveTo('a.target', { pointStrategy: 'center', overshoot: false });
    expect(mouseEvents.length).toBeGreaterThan(2);
    const last = mouseEvents[mouseEvents.length - 1];
    if (!last || last.kind !== 'move') throw new Error('last event not move');
    expect(last.x).toBe(140); // 100 + 80/2
    expect(last.y).toBe(120); // 100 + 40/2
  });

  it('throws when element has no bounding box', async () => {
    const { page } = makeMockPage({ 'a.missing': null });
    const h = new Humanize(page, { seed: 'missing', sleepFn: instantSleep });
    await expect(h.moveTo('a.missing')).rejects.toThrow(/not visible|not found/);
  });

  it('accepts absolute coordinates', async () => {
    const { page, mouseEvents } = makeMockPage();
    const h = new Humanize(page, { seed: 'abs', sleepFn: instantSleep });
    await h.moveTo({ x: 500, y: 300 }, { overshoot: false });
    const last = mouseEvents[mouseEvents.length - 1];
    if (!last || last.kind !== 'move') throw new Error('last event not move');
    expect(last.x).toBe(500);
    expect(last.y).toBe(300);
  });

  it('caches last mouse position so consecutive moves chain from where we left', async () => {
    const { page, mouseEvents } = makeMockPage();
    const h = new Humanize(page, { seed: 'chain', sleepFn: instantSleep });
    await h.moveTo({ x: 100, y: 100 }, { overshoot: false });
    const firstMoveCount = mouseEvents.length;
    await h.moveTo({ x: 600, y: 500 }, { overshoot: false });
    const secondLast = mouseEvents[mouseEvents.length - 1];
    if (!secondLast || secondLast.kind !== 'move') throw new Error('not move');
    expect(secondLast.x).toBe(600);
    expect(secondLast.y).toBe(500);
    // 第二段比第一段步数应类似（相近距离），不会爆炸
    expect(mouseEvents.length - firstMoveCount).toBeGreaterThan(0);
  });
});

describe('Humanize.click', () => {
  it('emits move(s) → mousedown → mouseup in order', async () => {
    const { page, mouseEvents } = makeMockPage();
    const h = new Humanize(page, { seed: 'click', sleepFn: instantSleep });
    await h.click('button.go');
    const downIdx = mouseEvents.findIndex((e) => e.kind === 'down');
    const upIdx = mouseEvents.findIndex((e) => e.kind === 'up');
    expect(downIdx).toBeGreaterThan(0); // 至少有一次 move 在前面
    expect(upIdx).toBeGreaterThan(downIdx);
    // down/up 之后再没有 move
    const moveAfterDown = mouseEvents.slice(downIdx + 1, upIdx).find((e) => e.kind === 'move');
    expect(moveAfterDown).toBeUndefined();
  });

  it('passes the requested button through to mouse.down/up', async () => {
    const { page, mouseEvents } = makeMockPage();
    const h = new Humanize(page, { seed: 'btn', sleepFn: instantSleep });
    await h.click('button.go', { button: 'right' });
    const down = mouseEvents.find((e) => e.kind === 'down');
    const up = mouseEvents.find((e) => e.kind === 'up');
    expect(down?.button).toBe('right');
    expect(up?.button).toBe('right');
  });
});

describe('Humanize.type', () => {
  it('emits keydown/keyup pairs for each character of the input', async () => {
    const { page, keyEvents } = makeMockPage();
    const h = new Humanize(page, { seed: 'type', sleepFn: instantSleep });
    await h.type('input.q', 'abc');
    // 之前会先 click → 不影响 key events。每字符 2 个事件
    const keys = keyEvents.map((e) => `${e.key}:${e.kind}`);
    expect(keys).toEqual(['a:down', 'a:up', 'b:down', 'b:up', 'c:down', 'c:up']);
  });

  it('emits Shift wrapper for uppercase letters', async () => {
    const { page, keyEvents } = makeMockPage();
    const h = new Humanize(page, { seed: 'caps', sleepFn: instantSleep });
    await h.type('input.q', 'Hi', { clickFirst: false });
    const keys = keyEvents.map((e) => `${e.key}:${e.kind}`);
    expect(keys).toEqual(['Shift:down', 'H:down', 'H:up', 'Shift:up', 'i:down', 'i:up']);
  });

  it('respects clickFirst=false (no preceding mouse click)', async () => {
    const { page, mouseEvents, keyEvents } = makeMockPage();
    const h = new Humanize(page, { seed: 'no-click', sleepFn: instantSleep });
    await h.type('input.q', 'x', { clickFirst: false });
    expect(mouseEvents).toHaveLength(0);
    expect(keyEvents).toHaveLength(2);
  });
});

describe('Humanize determinism', () => {
  it('same seed + same inputs produce identical event streams', async () => {
    const run = async () => {
      const { page, mouseEvents, keyEvents } = makeMockPage();
      const h = new Humanize(page, { seed: 'det-stream', sleepFn: instantSleep });
      await h.moveTo({ x: 400, y: 300 }, { overshoot: false });
      await h.type('input.q', 'hello', { clickFirst: false });
      return { mouseEvents, keyEvents };
    };
    const a = await run();
    const b = await run();
    expect(a.mouseEvents).toEqual(b.mouseEvents);
    expect(a.keyEvents).toEqual(b.keyEvents);
  });
});
