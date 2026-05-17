/**
 * run-store.test — Phase 8.4 DetectionRun JSON 持久化 round-trip 验证。
 *
 * 风格 mirror `persona-store.test.ts`：tmp dir 注入 + before/after rmSync 隔离。
 * 重点覆盖：
 *   1. save → load round-trip 字段不丢
 *   2. list 返回 summary（不嵌完整 hits）
 *   3. list 按 startedAt 降序
 *   4. delete 同时删 .json + artifacts 子目录
 *   5. persona id 隔离（A 的 run 不会渗入 B 的列表）
 *   6. 损坏文件 list 时 skip 不阻断
 *   7. 缺目录 list 返回 []
 *   8. delete 不存在的 run → false（idempotent）
 *   9. failed/canceled 的 score: null run 在 summary 里 hits=0
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaId } from '@mosaiq/persona-schema';

import {
  getDetectionRunArtifactDir,
  saveDetectionRun,
  loadDetectionRun,
  listDetectionRuns,
  deleteDetectionRun,
} from './run-store.js';
import {
  getDetectionRunFile,
  getDetectionRunsDir,
  type PathConfig,
} from '../paths.js';
import {
  emptyHitsBySurface,
  type DetectionRun,
  type DetectionScore,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 测试 fixtures
// ─────────────────────────────────────────────────────────────────────────────

let tmpRoot: string;
let cfg: PathConfig;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mosaiq-run-store-test-'));
  cfg = { runtimeRoot: tmpRoot };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeScore(overrides: Partial<DetectionScore> = {}): DetectionScore {
  return {
    sitesOk: 10,
    sitesFail: 2,
    creepjsLies: 3,
    creepjsBoldFail: 0,
    sannysoftPass: 6,
    sannysoftTotal: 7,
    dbiBotFlagsTriggered: 1,
    amiuniqueOutliers: 5,
    fpScannerInconsistent: 0,
    incolumitasBadFlags: 0,
    weightedHits: 12.5,
    hits: [
      {
        surface: 'canvas',
        site: 'browserleaks-canvas',
        detector: 'noise variance',
        evidence: 'sigma=0.001',
        severity: 'medium',
      },
      {
        surface: 'webdriver',
        site: 'sannysoft',
        detector: 'navigator.webdriver',
        evidence: 'true',
        severity: 'high',
      },
    ],
    hitsBySurface: { ...emptyHitsBySurface(), canvas: 1, webdriver: 1 },
    ...overrides,
  };
}

function makeRun(overrides: Partial<DetectionRun> = {}): DetectionRun {
  return {
    id: '2026-05-17T10-00-00-000Z',
    personaId: 'alice' as PersonaId,
    startedAt: '2026-05-17T10:00:00.000Z',
    finishedAt: '2026-05-17T10:03:21.000Z',
    status: 'completed',
    sitesAttempted: [
      'sannysoft',
      'creepjs',
      'browserleaks-canvas',
      'iphey',
      'amiunique',
      'browserleaks-webgl',
    ],
    durationMs: 201_000,
    score: makeScore(),
    error: null,
    meta: {
      sdkVersion: '0.7.1',
      chromiumVersion: '130.0.6723.59',
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// save / load round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('saveDetectionRun + loadDetectionRun', () => {
  it('writes JSON to <root>/detection-runs/<personaId>/<runId>.json and round-trips', () => {
    const run = makeRun();
    saveDetectionRun('alice' as PersonaId, run, cfg);

    const file = getDetectionRunFile(
      'alice' as PersonaId,
      run.id,
      cfg,
    );
    expect(existsSync(file)).toBe(true);

    const loaded = loadDetectionRun('alice' as PersonaId, run.id, cfg);
    expect(loaded).toEqual(run);
  });

  it('mkdir -p the persona subdirectory on first save', () => {
    const personaDir = getDetectionRunsDir('newbie' as PersonaId, cfg);
    expect(existsSync(personaDir)).toBe(false);

    saveDetectionRun(
      'newbie' as PersonaId,
      makeRun({ id: 'r1', personaId: 'newbie' as PersonaId }),
      cfg,
    );
    expect(existsSync(personaDir)).toBe(true);
  });

  it('saves multiple runs to the same persona without conflict', () => {
    const a = makeRun({ id: 'r1', startedAt: '2026-05-17T10:00:00.000Z' });
    const b = makeRun({ id: 'r2', startedAt: '2026-05-17T11:00:00.000Z' });
    saveDetectionRun('alice' as PersonaId, a, cfg);
    saveDetectionRun('alice' as PersonaId, b, cfg);

    expect(loadDetectionRun('alice' as PersonaId, 'r1', cfg).id).toBe('r1');
    expect(loadDetectionRun('alice' as PersonaId, 'r2', cfg).id).toBe('r2');
  });

  it('throws on load of missing run', () => {
    expect(() =>
      loadDetectionRun('alice' as PersonaId, 'nope', cfg),
    ).toThrow(/DetectionRun not found/);
  });

  it('throws on load of corrupt JSON', () => {
    const dir = getDetectionRunsDir('alice' as PersonaId, cfg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), 'not json {', 'utf-8');
    expect(() =>
      loadDetectionRun('alice' as PersonaId, 'bad', cfg),
    ).toThrow();
  });

  it('throws on load of shape-mismatch JSON', () => {
    const dir = getDetectionRunsDir('alice' as PersonaId, cfg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'wrong-shape.json'),
      JSON.stringify({ hello: 'world' }),
      'utf-8',
    );
    expect(() =>
      loadDetectionRun('alice' as PersonaId, 'wrong-shape', cfg),
    ).toThrow(/Corrupt DetectionRun JSON/);
  });

  it('preserves failed run with score=null and error', () => {
    const failed = makeRun({
      id: 'failed-r',
      status: 'failed',
      score: null,
      error: 'chromium crashed',
      finishedAt: null,
    });
    saveDetectionRun('alice' as PersonaId, failed, cfg);
    const loaded = loadDetectionRun('alice' as PersonaId, 'failed-r', cfg);
    expect(loaded.score).toBeNull();
    expect(loaded.error).toBe('chromium crashed');
    expect(loaded.finishedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listDetectionRuns
// ─────────────────────────────────────────────────────────────────────────────

describe('listDetectionRuns', () => {
  it('returns [] when persona dir does not exist', () => {
    expect(listDetectionRuns('ghost' as PersonaId, cfg)).toEqual([]);
  });

  it('returns summaries sorted by startedAt descending (newest first)', () => {
    saveDetectionRun(
      'alice' as PersonaId,
      makeRun({ id: 'old', startedAt: '2026-01-01T00:00:00.000Z' }),
      cfg,
    );
    saveDetectionRun(
      'alice' as PersonaId,
      makeRun({ id: 'mid', startedAt: '2026-03-15T00:00:00.000Z' }),
      cfg,
    );
    saveDetectionRun(
      'alice' as PersonaId,
      makeRun({ id: 'new', startedAt: '2026-05-17T00:00:00.000Z' }),
      cfg,
    );

    const list = listDetectionRuns('alice' as PersonaId, cfg);
    expect(list.map((s) => s.runId)).toEqual(['new', 'mid', 'old']);
  });

  it('projects DetectionRun → DetectionRunSummary correctly', () => {
    saveDetectionRun('alice' as PersonaId, makeRun(), cfg);
    const [summary] = listDetectionRuns('alice' as PersonaId, cfg);

    expect(summary).toEqual({
      runId: '2026-05-17T10-00-00-000Z',
      personaId: 'alice',
      timestamp: '2026-05-17T10:00:00.000Z',
      status: 'completed',
      durationMs: 201_000,
      sitesAttempted: 6,
      sitesOk: 10,
      sitesFail: 2,
      totalHits: 2,
      weightedHits: 12.5,
    });
  });

  it('summary uses 0 for hits / weightedHits when score is null (failed run)', () => {
    saveDetectionRun(
      'alice' as PersonaId,
      makeRun({ id: 'failed-r', status: 'failed', score: null, error: 'boom' }),
      cfg,
    );
    const [summary] = listDetectionRuns('alice' as PersonaId, cfg);
    expect(summary?.totalHits).toBe(0);
    expect(summary?.weightedHits).toBe(0);
    expect(summary?.status).toBe('failed');
  });

  it('skips corrupt files with warn instead of throwing', () => {
    saveDetectionRun('alice' as PersonaId, makeRun({ id: 'good' }), cfg);
    const dir = getDetectionRunsDir('alice' as PersonaId, cfg);
    writeFileSync(join(dir, 'broken.json'), '{ not parseable', 'utf-8');
    writeFileSync(
      join(dir, 'wrong-shape.json'),
      JSON.stringify({ hello: 'world' }),
      'utf-8',
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = listDetectionRuns('alice' as PersonaId, cfg);

    expect(list).toHaveLength(1);
    expect(list[0]?.runId).toBe('good');
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('isolates runs per persona (alice does not see bob\u2019s runs)', () => {
    saveDetectionRun(
      'alice' as PersonaId,
      makeRun({ id: 'a1', personaId: 'alice' as PersonaId }),
      cfg,
    );
    saveDetectionRun(
      'bob' as PersonaId,
      makeRun({ id: 'b1', personaId: 'bob' as PersonaId }),
      cfg,
    );

    const aliceList = listDetectionRuns('alice' as PersonaId, cfg);
    const bobList = listDetectionRuns('bob' as PersonaId, cfg);
    expect(aliceList.map((s) => s.runId)).toEqual(['a1']);
    expect(bobList.map((s) => s.runId)).toEqual(['b1']);
  });

  it('ignores non-.json files in the persona dir (artifact subdirs etc)', () => {
    saveDetectionRun('alice' as PersonaId, makeRun({ id: 'r1' }), cfg);
    const dir = getDetectionRunsDir('alice' as PersonaId, cfg);
    // 模拟 runDetection 写下的 artifact 子目录 + 一些杂项
    mkdirSync(join(dir, 'r1'), { recursive: true });
    writeFileSync(join(dir, 'r1', 'sannysoft.png'), 'fake png', 'utf-8');
    writeFileSync(join(dir, 'readme.txt'), 'noise', 'utf-8');

    const list = listDetectionRuns('alice' as PersonaId, cfg);
    expect(list.map((s) => s.runId)).toEqual(['r1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteDetectionRun
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteDetectionRun', () => {
  it('returns true and removes the .json file', () => {
    saveDetectionRun('alice' as PersonaId, makeRun({ id: 'r1' }), cfg);
    const file = getDetectionRunFile('alice' as PersonaId, 'r1', cfg);
    expect(existsSync(file)).toBe(true);

    expect(deleteDetectionRun('alice' as PersonaId, 'r1', cfg)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('also removes the artifacts subdirectory when present', () => {
    saveDetectionRun('alice' as PersonaId, makeRun({ id: 'r1' }), cfg);
    const artifactDir = getDetectionRunArtifactDir(
      'alice' as PersonaId,
      'r1',
      cfg,
    );
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'sannysoft.png'), 'fake', 'utf-8');
    writeFileSync(join(artifactDir, 'creepjs.html'), '<html/>', 'utf-8');
    expect(existsSync(artifactDir)).toBe(true);

    expect(deleteDetectionRun('alice' as PersonaId, 'r1', cfg)).toBe(true);
    expect(existsSync(artifactDir)).toBe(false);
  });

  it('returns false on idempotent delete of nonexistent run', () => {
    expect(deleteDetectionRun('alice' as PersonaId, 'never-existed', cfg)).toBe(
      false,
    );
  });

  it('leaves sibling runs intact', () => {
    saveDetectionRun('alice' as PersonaId, makeRun({ id: 'keep' }), cfg);
    saveDetectionRun('alice' as PersonaId, makeRun({ id: 'kill' }), cfg);

    deleteDetectionRun('alice' as PersonaId, 'kill', cfg);
    const list = listDetectionRuns('alice' as PersonaId, cfg);
    expect(list.map((s) => s.runId)).toEqual(['keep']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDetectionRunArtifactDir
// ─────────────────────────────────────────────────────────────────────────────

describe('getDetectionRunArtifactDir', () => {
  it('is a pure path computation (no mkdir)', () => {
    const dir = getDetectionRunArtifactDir(
      'alice' as PersonaId,
      'r1',
      cfg,
    );
    expect(dir).toBe(join(tmpRoot, 'detection-runs', 'alice', 'r1'));
    expect(existsSync(dir)).toBe(false);
  });

  it('is sibling to the <runId>.json file (same prefix)', () => {
    const file = getDetectionRunFile('alice' as PersonaId, 'r1', cfg);
    const dir = getDetectionRunArtifactDir(
      'alice' as PersonaId,
      'r1',
      cfg,
    );
    // file = .../alice/r1.json, dir = .../alice/r1
    expect(file).toBe(`${dir}.json`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 综合：复杂工作流 smoke
// ─────────────────────────────────────────────────────────────────────────────

describe('full lifecycle smoke', () => {
  it('save → list → delete → list reflects state correctly', () => {
    const persona = 'alice' as PersonaId;
    expect(listDetectionRuns(persona, cfg)).toEqual([]);

    saveDetectionRun(
      persona,
      makeRun({ id: 'r1', startedAt: '2026-01-01T00:00:00.000Z' }),
      cfg,
    );
    saveDetectionRun(
      persona,
      makeRun({ id: 'r2', startedAt: '2026-02-01T00:00:00.000Z' }),
      cfg,
    );
    expect(listDetectionRuns(persona, cfg).map((s) => s.runId)).toEqual([
      'r2',
      'r1',
    ]);

    deleteDetectionRun(persona, 'r1', cfg);
    expect(listDetectionRuns(persona, cfg).map((s) => s.runId)).toEqual(['r2']);

    // 删除后磁盘上只剩 r2.json
    const dir = getDetectionRunsDir(persona, cfg);
    const filesOnDisk = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(filesOnDisk).toEqual(['r2.json']);
  });
});
