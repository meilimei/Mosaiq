import { describe, expect, it } from 'vitest';

import { type KeyEvent, planTypingPlan } from './keyboard.js';
import { makeRng } from './rng.js';

function expectMonotonicNonDecreasing(events: KeyEvent[]) {
  for (let i = 1; i < events.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by loop
    expect(events[i]!.tMs).toBeGreaterThanOrEqual(events[i - 1]!.tMs);
  }
}

describe('planTypingPlan', () => {
  it('returns empty array for empty text', () => {
    expect(planTypingPlan({ text: '' }, makeRng('x'))).toEqual([]);
  });

  it('emits down/up pair for each lowercase char', () => {
    const events = planTypingPlan({ text: 'abc' }, makeRng('abc'));
    // 6 events: down a, up a, down b, up b, down c, up c
    expect(events).toHaveLength(6);
    expect(events.map((e) => `${e.key}:${e.type}`)).toEqual([
      'a:down',
      'a:up',
      'b:down',
      'b:up',
      'c:down',
      'c:up',
    ]);
  });

  it('emits Shift down → letter down → letter up → Shift up for uppercase', () => {
    const events = planTypingPlan({ text: 'A' }, makeRng('A'));
    expect(events).toHaveLength(4);
    expect(events.map((e) => `${e.key}:${e.type}`)).toEqual([
      'Shift:down',
      'A:down',
      'A:up',
      'Shift:up',
    ]);
  });

  it('time stamps are monotonically non-decreasing', () => {
    const events = planTypingPlan({ text: 'Hello, World!' }, makeRng('mono'));
    expectMonotonicNonDecreasing(events);
  });

  it('down → up for the same character is strictly increasing in time', () => {
    const events = planTypingPlan({ text: 'abcdef' }, makeRng('strict'));
    for (let i = 0; i < events.length; i += 2) {
      const down = events[i];
      const up = events[i + 1];
      if (!down || !up) throw new Error('mismatched pair');
      expect(down.type).toBe('down');
      expect(up.type).toBe('up');
      expect(down.key).toBe(up.key);
      expect(up.tMs).toBeGreaterThan(down.tMs);
    }
  });

  it('first event tMs is 0', () => {
    const events = planTypingPlan({ text: 'abc' }, makeRng('zero'));
    expect(events[0]?.tMs).toBe(0);
  });

  it('produces no NaN / Infinity timestamps', () => {
    const events = planTypingPlan(
      { text: 'The quick brown fox jumps over the lazy dog' },
      makeRng('finite'),
    );
    expect(events.every((e) => Number.isFinite(e.tMs))).toBe(true);
  });

  it('is deterministic for same seed and input', () => {
    const a = planTypingPlan({ text: 'reproducible' }, makeRng('det'));
    const b = planTypingPlan({ text: 'reproducible' }, makeRng('det'));
    expect(a).toEqual(b);
  });

  it('differs across seeds', () => {
    const a = planTypingPlan({ text: 'hello' }, makeRng('seed-A'));
    const b = planTypingPlan({ text: 'hello' }, makeRng('seed-B'));
    // 事件键序列必相同（因为输入相同）；但时间戳不同
    const tA = a.map((e) => e.tMs);
    const tB = b.map((e) => e.tMs);
    expect(tA).not.toEqual(tB);
  });

  it('average dwell over a long text is near avgDwellMs (±20%)', () => {
    const events = planTypingPlan(
      {
        text: 'a'.repeat(500),
        avgDwellMs: 80,
        avgFlightMs: 100,
      },
      makeRng('dwell-stat'),
    );
    const dwells: number[] = [];
    for (let i = 0; i < events.length - 1; i += 2) {
      const down = events[i];
      const up = events[i + 1];
      if (down && up && down.type === 'down' && up.type === 'up') {
        dwells.push(up.tMs - down.tMs);
      }
    }
    const mean = dwells.reduce((a, b) => a + b, 0) / dwells.length;
    expect(mean).toBeGreaterThan(80 * 0.8);
    expect(mean).toBeLessThan(80 * 1.2);
  });

  it('average flight over a long text approximates avgFlightMs (±25%)', () => {
    const events = planTypingPlan(
      {
        // 用不重复字符 + 无空格，避免节律乘数（×1.4 / ×0.8 等）影响均值
        text: 'qwertyuioplkjhgfdsamnbvcxzqwerty'.repeat(15),
        avgDwellMs: 70,
        avgFlightMs: 120,
      },
      makeRng('flight-stat'),
    );
    const flights: number[] = [];
    // flight = next 字符 down.tMs - prev 字符 up.tMs
    for (let i = 1; i + 1 < events.length; i += 2) {
      const prevUp = events[i];
      const nextDown = events[i + 1];
      if (prevUp && nextDown && prevUp.type === 'up' && nextDown.type === 'down') {
        flights.push(nextDown.tMs - prevUp.tMs);
      }
    }
    const mean = flights.reduce((a, b) => a + b, 0) / flights.length;
    expect(mean).toBeGreaterThan(120 * 0.75);
    expect(mean).toBeLessThan(120 * 1.25);
  });

  it('typoRate=0 emits no Backspace events', () => {
    const events = planTypingPlan({ text: 'no typos here' }, makeRng('no-typo'));
    expect(events.find((e) => e.key === 'Backspace')).toBeUndefined();
  });

  it('typoRate>0 over long text emits at least one Backspace', () => {
    const events = planTypingPlan(
      {
        text: 'this is a long enough sentence to almost certainly trigger a typo',
        typoRate: 0.3,
      },
      makeRng('with-typo'),
    );
    const backspaces = events.filter((e) => e.key === 'Backspace');
    expect(backspaces.length).toBeGreaterThan(0);
    // 每个 Backspace 也是 down/up 配对
    expect(backspaces.length % 2).toBe(0);
  });

  it('speedScale.flight=0.5 cuts flight roughly in half', () => {
    const fast = planTypingPlan(
      {
        text: 'qwertyuioplkjhgfdsamnbvcxz'.repeat(8),
        avgFlightMs: 120,
        speedScale: { flight: 0.5, dwell: 1 },
      },
      makeRng('fast'),
    );
    const slow = planTypingPlan(
      {
        text: 'qwertyuioplkjhgfdsamnbvcxz'.repeat(8),
        avgFlightMs: 120,
        speedScale: { flight: 1, dwell: 1 },
      },
      makeRng('fast'),
    );
    const lastFast = fast[fast.length - 1];
    const lastSlow = slow[slow.length - 1];
    if (!lastFast || !lastSlow) throw new Error('empty');
    // fast 总时长应明显短于 slow（不必正好 0.5×，因为 dwell 不缩 + 节律乘数）
    expect(lastFast.tMs).toBeLessThan(lastSlow.tMs * 0.85);
  });
});
