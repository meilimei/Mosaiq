// @vitest-environment happy-dom

/**
 * sites-creepjs.test.ts — v0.5.1 regression cover for `extractCreepjsFromDocument`.
 *
 * v0.5.0 在 12-站 bench 报告里 creepjs 卡片下挂着 23 条
 * `bold-fail: <unknown>` 单字符 hash（hash=2 / hash=5 / hash=. / ...），
 * 经核查全部来自 CreepJS 用作内联字符高亮的 `<span class="bold-fail">N</span>`
 * （AudioBuffer trap value debug 文本）。CHANGELOG 标为 "cosmetic, separately
 * tracked"。本文件是 v0.5.1 的修复回归测试 —— 锁住三道闸：
 *   1. selector 仅匹配 `span.lies.hash, span.bold-fail.hash`
 *   2. textContent 必须是 `^[0-9a-f]{6,12}$`
 *   3. previousElementSibling 必须是 `<strong>`
 *
 * 测试既覆盖 synthetic 最小用例，也加一个 fixture 测试基于 v0.5.0 真实保存的
 * `bench/results/<latest>/creepjs.html`（2099 行 / 23 条噪声），验证修复后只
 * 留下 2 条真实 surface marker（WebGL bold-fail + Audio lies）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { extractCreepjsFromDocument } from './sites.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  document.body.innerHTML = '';
});

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic DOM cases — fast, deterministic, no fixture I/O
// ─────────────────────────────────────────────────────────────────────────────

describe('extractCreepjsFromDocument — synthetic DOM', () => {
  it('keeps a real surface-level lie marker (bold-fail hash)', () => {
    document.body.innerHTML =
      '<div><strong>WebGL</strong><span class="bold-fail hash">3695ea1d</span></div>';
    const out = extractCreepjsFromDocument();
    const lies = out.liesSurfaces as Array<{ surface: string; severity: string; hash: string }>;
    expect(lies).toHaveLength(1);
    expect(lies[0]).toEqual({ surface: 'WebGL', severity: 'bold-fail', hash: '3695ea1d' });
    expect(out.boldFailCount).toBe(1);
    expect(out.liesCount).toBe(0);
  });

  it('keeps a real surface-level lie marker (lies hash)', () => {
    document.body.innerHTML =
      '<div><strong>Audio</strong><span class="lies hash">b726173b</span></div>';
    const out = extractCreepjsFromDocument();
    const lies = out.liesSurfaces as Array<{ surface: string; severity: string; hash: string }>;
    expect(lies).toEqual([{ surface: 'Audio', severity: 'lies', hash: 'b726173b' }]);
    expect(out.liesCount).toBe(1);
    expect(out.boldFailCount).toBe(0);
  });

  it('drops inline character highlights without `.hash` class (the v0.5.0 noise)', () => {
    // 这正是 v0.5.0 报告里 23 条 phantom 行的源头：sum/trap value 里的
    // 单字符 <span class="bold-fail">N</span>，没有 hash class，前面是文本节点
    document.body.innerHTML = `
      <div class="help" title="AudioBuffer.getChannelData()">
        sum: 124.043475<span class="bold-fail">2</span><span class="bold-fail">5</span><span class="bold-fail">0</span>
      </div>
    `;
    const out = extractCreepjsFromDocument();
    expect(out.liesSurfaces).toEqual([]);
    expect(out.liesCount).toBe(0);
    expect(out.boldFailCount).toBe(0);
  });

  it('drops `.hash` markers whose textContent is not a hex hashMini', () => {
    // 防御 CreepJS 未来给非 hash 内容也加 hash class 的边缘情况。
    document.body.innerHTML =
      '<div><strong>WebGL</strong><span class="bold-fail hash">N/A</span></div>';
    const out = extractCreepjsFromDocument();
    expect(out.liesSurfaces).toEqual([]);
  });

  it('drops `.hash` markers without a preceding <strong> sibling', () => {
    // 防御 surface 名识别失败 —— 没 surface 名的 marker 当作 parser 噪声丢弃，
    // 不再走 v0.2 的 `<unknown>` fallback。
    document.body.innerHTML = '<div><span class="bold-fail hash">3695ea1d</span></div>';
    const out = extractCreepjsFromDocument();
    expect(out.liesSurfaces).toEqual([]);
  });

  it('mixes real markers + noise correctly', () => {
    document.body.innerHTML = `
      <p><strong>WebGL</strong><span class="bold-fail hash">3695ea1d</span></p>
      <p><strong>Audio</strong><span class="lies hash">b726173b</span></p>
      <div class="help">trap: <span class="bold-fail">3</span><span class="bold-fail">9</span><span class="bold-fail">.</span>0</div>
    `;
    const out = extractCreepjsFromDocument();
    const lies = out.liesSurfaces as Array<{ surface: string; severity: string; hash: string }>;
    expect(lies).toEqual([
      { surface: 'WebGL', severity: 'bold-fail', hash: '3695ea1d' },
      { surface: 'Audio', severity: 'lies', hash: 'b726173b' },
    ]);
    expect(out.liesCount).toBe(1);
    expect(out.boldFailCount).toBe(1);
  });

  it('captures fingerprintId + sections + zero counters cleanly on empty page', () => {
    document.body.innerHTML = '<div>no creepjs results here</div>';
    const out = extractCreepjsFromDocument();
    expect(out.liesSurfaces).toEqual([]);
    expect(out.liesCount).toBe(0);
    expect(out.boldFailCount).toBe(0);
    expect(out.blockedCount).toBeNull();
    expect(out.errorsCount).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real fixture — the 2026-05-17 v0.5.0 bench creepjs.html
//
// This is the exact HTML that produced the 23 phantom `<unknown>` entries in
// the v0.5.0 report. After the v0.5.1 fix it must collapse to just the 2 real
// surface markers (WebGL bold-fail, Audio lies).
//
// The snapshot lives at `bench/fixtures/creepjs-v0.5.0-snapshot.html` (committed
// to the repo) — NOT under `bench/results/` which is gitignored. Without the
// committed snapshot CI cannot reproduce the regression check.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_PATH = resolve(
  __dirname,
  'fixtures',
  'creepjs-v0.5.0-snapshot.html',
);

describe('extractCreepjsFromDocument — v0.5.0 bench fixture', () => {
  it('collapses the 23 v0.5.0 phantom <unknown> entries to 2 real surface markers', () => {
    const html = readFileSync(FIXTURE_PATH, 'utf8');
    // 只 inject body 内容到 happy-dom，避免 head/script 触发不必要的执行
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    expect(bodyMatch, 'fixture must contain a <body>').not.toBeNull();
    document.body.innerHTML = bodyMatch![1];

    const out = extractCreepjsFromDocument();
    const lies = out.liesSurfaces as Array<{ surface: string; severity: string; hash: string }>;

    // 0 条 `<unknown>` parser 噪声（v0.5.0 这里是 23）
    const unknowns = lies.filter((l) => l.surface === '<unknown>');
    expect(unknowns).toEqual([]);

    // 2 条真实 surface marker
    expect(lies).toEqual(
      expect.arrayContaining([
        { surface: 'WebGL', severity: 'bold-fail', hash: '3695ea1d' },
        { surface: 'Audio', severity: 'lies', hash: 'b726173b' },
      ]),
    );
    expect(lies).toHaveLength(2);
    expect(out.liesCount).toBe(1); // Audio
    expect(out.boldFailCount).toBe(1); // WebGL
  });
});
