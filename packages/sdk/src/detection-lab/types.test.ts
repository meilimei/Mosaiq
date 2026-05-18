/**
 * detection-lab/types.test.ts — Detection Lab 公共契约的小型 smoke + 不变量测试。
 *
 * 这一层只覆盖 v0.8 第一锤可见的、纯 POJO 的契约：
 *   - `emptyHitsBySurface()` 形状 + 不变量（每个 SurfaceName key 都要有，初值 0）
 *   - 公共 barrel (`@mosaiq/sdk` 顶层 + `./index.js`) 真的 re-export 了它们
 *
 * scorer / runner / storage 等 IO-aware 模块还没落地（v0.8 后续锤），那些自己附测试。
 * 这里的目的是：**让 `SurfaceName` union 的修改强制走单测**，未来加新 surface 不会
 * 漏 patch `emptyHitsBySurface`。
 */

import { describe, expect, it } from 'vitest';

import {
  type DetectionRun,
  type DetectionRunRaw,
  type DetectionScore,
  type HitSeverity,
  type HitsBySurface,
  type RunProgressEvent,
  type RunStatus,
  SITES,
  type SiteResult,
  type SiteSpec,
  type SurfaceHit,
  type SurfaceName,
  emptyHitsBySurface,
  extractCreepjsFromDocument,
} from '../index.js';

/**
 * 编译时检查：每个 SurfaceName 字面量都必须出现在这个常量里。
 *
 * 工作原理：把字面量数组用 `as const` 收紧成 readonly tuple；然后
 * `EXHAUSTIVENESS_CHECK` 断言 tuple 的 element union 等于 `SurfaceName`。如果
 * 未来给 `SurfaceName` 加新 surface 但漏改这里，`EXHAUSTIVENESS_CHECK` 会
 * 编译失败，强制更新 `emptyHitsBySurface` + 这个数组。
 */
const ALL_SURFACES = [
  'canvas',
  'webgl',
  'audio',
  'font',
  'webrtc',
  'navigator',
  'screen',
  'permissions',
  'timezone',
  'plugins',
  'webdriver',
  'other',
] as const satisfies readonly SurfaceName[];

type _AssertCoversAllSurfaces = SurfaceName extends (typeof ALL_SURFACES)[number]
  ? (typeof ALL_SURFACES)[number] extends SurfaceName
    ? true
    : never
  : never;
// 触发 type usage（vitest 不会优化掉 type alias，但 ESLint 可能；保留显式 ref）
const EXHAUSTIVENESS_CHECK: _AssertCoversAllSurfaces = true;

describe('emptyHitsBySurface', () => {
  it('returns 0 for every SurfaceName', () => {
    const empty = emptyHitsBySurface();
    for (const surface of ALL_SURFACES) {
      expect(empty[surface]).toBe(0);
    }
  });

  it('keys are exactly the SurfaceName union (no extras, no missing)', () => {
    const empty = emptyHitsBySurface();
    const keys = Object.keys(empty).sort();
    const expected = [...ALL_SURFACES].sort();
    expect(keys).toEqual(expected);
  });

  it('returns a fresh object on each call (no shared mutable state)', () => {
    const a = emptyHitsBySurface();
    const b = emptyHitsBySurface();
    expect(a).not.toBe(b);
    a.canvas = 7;
    expect(b.canvas).toBe(0);
  });

  it('result conforms to HitsBySurface (no never assertion needed)', () => {
    const empty: HitsBySurface = emptyHitsBySurface();
    // 全 number — 没有 undefined / null 漏字段
    for (const v of Object.values(empty)) {
      expect(typeof v).toBe('number');
    }
  });

  // EXHAUSTIVENESS_CHECK 在文件顶层运行，这里只是把它"消费"以阻止 unused 警告
  it('SurfaceName union exhaustiveness compile-time guard is satisfied', () => {
    expect(EXHAUSTIVENESS_CHECK).toBe(true);
  });
});

describe('SDK barrel re-exports detection-lab surface', () => {
  it('SITES is the runtime spec array (non-empty, well-formed)', () => {
    expect(Array.isArray(SITES)).toBe(true);
    expect(SITES.length).toBeGreaterThanOrEqual(12);
    // Spec 字段在 IPC / dashboard 里都需要稳定；smoke check 防回归。
    for (const site of SITES) {
      expect(typeof site.id).toBe('string');
      expect(typeof site.name).toBe('string');
      expect(site.url).toMatch(/^https?:\/\//);
      expect(typeof site.settleMs).toBe('number');
    }
  });

  it('SITES ids are unique (raw.json 用作 file/dir 名前缀，必须 unique)', () => {
    const ids = SITES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('extractCreepjsFromDocument is callable (pure DOM fn, smoke only)', () => {
    expect(typeof extractCreepjsFromDocument).toBe('function');
  });
});

describe('DetectionRunRaw / DetectionRun / DetectionScore — type-shape smoke', () => {
  // 这些 test 不做行为断言，仅做"能写出一个完整、合法的字面量"——这把契约的所有
  // required 字段固定下来。如果 types.ts 改名/删字段，本测试会立刻编译失败。
  it('DetectionRunRaw literal compiles', () => {
    const raw: DetectionRunRaw = {
      timestamp: '2026-05-17T00:00:00.000Z',
      overallMs: 12345,
      sitesAttempted: 1,
      sitesOk: 1,
      sitesFail: 0,
      persona: {
        id: 'p',
        template: 'reddit-alice',
        browser: {},
        system: {},
      },
      results: [],
    };
    expect(raw.sitesAttempted).toBe(1);
  });

  it('SiteResult literal compiles with both required and optional fields', () => {
    const r: SiteResult = {
      id: 'creepjs',
      name: 'CreepJS',
      url: 'https://abrahamjuliot.github.io/creepjs/',
      ok: true,
      durationMs: 5_000,
      title: 'CreepJS',
      retries: 0,
    };
    expect(r.ok).toBe(true);
  });

  it('DetectionScore literal compiles with HitsBySurface = empty', () => {
    const score: DetectionScore = {
      sitesOk: 12,
      sitesFail: 0,
      creepjsLies: 0,
      creepjsBoldFail: 0,
      sannysoftPass: 30,
      sannysoftTotal: 30,
      dbiBotFlagsTriggered: 0,
      amiuniqueOutliers: 0,
      fpScannerInconsistent: 0,
      incolumitasBadFlags: 0,
      weightedHits: 0,
      hits: [],
      hitsBySurface: emptyHitsBySurface(),
    };
    expect(score.weightedHits).toBe(0);
  });

  it('DetectionRun literal compiles', () => {
    const run: DetectionRun = {
      id: '2026-05-17T18-30-00-000Z',
      personaId: 'p' as DetectionRun['personaId'],
      startedAt: '2026-05-17T18:30:00.000Z',
      finishedAt: null,
      status: 'running' satisfies RunStatus,
      sitesAttempted: ['creepjs'],
      durationMs: 0,
      score: null,
      error: null,
      meta: { sdkVersion: '0.7.1' },
    };
    expect(run.status).toBe('running');
  });

  it('SurfaceHit literal compiles', () => {
    const hit: SurfaceHit = {
      surface: 'webgl',
      site: 'creepjs',
      detector: 'unmasked vendor mismatch',
      evidence: 'expected="Intel" actual="NVIDIA"',
      severity: 'high' satisfies HitSeverity,
    };
    expect(hit.surface).toBe('webgl');
  });

  it('RunProgressEvent literal compiles (init phase)', () => {
    const ev: RunProgressEvent = {
      runId: '2026-05-17T18-30-00-000Z',
      personaId: 'p' as RunProgressEvent['personaId'],
      phase: 'init',
      totalSites: 12,
    };
    expect(ev.phase).toBe('init');
  });

  // SiteSpec 是 IO-aware（extract callback 接 Playwright Page），这里只 smoke
  it('SiteSpec from SITES has the expected discriminator fields', () => {
    const first = SITES[0] as SiteSpec | undefined;
    expect(first).toBeDefined();
    expect(typeof first?.id).toBe('string');
  });
});
