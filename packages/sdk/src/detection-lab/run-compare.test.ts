import { describe, expect, it } from 'vitest';

import { diffRuns } from './run-compare.js';
import type { DetectionRun, DetectionScore, HitsBySurface, SurfaceHit } from './types.js';
import { emptyHitsBySurface } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures — 与 run-format.test.ts 同结构，方便比对
// ─────────────────────────────────────────────────────────────────────────────

function makeScore(overrides: Partial<DetectionScore> = {}): DetectionScore {
  const hitsBySurface: HitsBySurface = {
    ...emptyHitsBySurface(),
    ...(overrides.hitsBySurface ?? {}),
  };
  return {
    sitesOk: 12,
    sitesFail: 0,
    creepjsLies: 0,
    creepjsBoldFail: 0,
    sannysoftPass: 24,
    sannysoftTotal: 24,
    dbiBotFlagsTriggered: 0,
    amiuniqueOutliers: 0,
    fpScannerInconsistent: 0,
    incolumitasBadFlags: 0,
    weightedHits: 0,
    hits: [],
    hitsBySurface,
    ...overrides,
  };
}

function makeHit(overrides: Partial<SurfaceHit> = {}): SurfaceHit {
  return {
    surface: 'canvas',
    site: 'browserleaks-canvas',
    detector: 'uniqueness',
    evidence: '100%',
    severity: 'medium',
    ...overrides,
  };
}

function makeRun(overrides: Partial<DetectionRun> = {}): DetectionRun {
  return {
    id: '2026-05-19T12-00-00-000Z',
    personaId: 'reddit-alice' as DetectionRun['personaId'],
    startedAt: '2026-05-19T12:00:00.000Z',
    finishedAt: '2026-05-19T12:01:23.000Z',
    status: 'completed',
    sitesAttempted: ['sannysoft', 'creepjs', 'browserleaks-canvas'],
    durationMs: 83000,
    score: makeScore(),
    error: null,
    meta: {
      sdkVersion: '0.8.0',
      chromiumVersion: '130.0.6723.117',
    },
    ...overrides,
  };
}

/** 简单工厂：给一组 site id 生成 raw.results（用于 site-flip 测试）。 */
function makeRaw(
  results: Array<{ id: string; ok: boolean }>,
  meta: Partial<{
    timestamp: string;
    overallMs: number;
    persona: { id: string; template: string };
  }> = {},
): DetectionRun['raw'] {
  const okCount = results.filter((r) => r.ok).length;
  return {
    timestamp: meta.timestamp ?? '2026-05-19T12:00:00.000Z',
    overallMs: meta.overallMs ?? 83000,
    sitesAttempted: results.length,
    sitesOk: okCount,
    sitesFail: results.length - okCount,
    persona: {
      id: meta.persona?.id ?? 'reddit-alice',
      template: meta.persona?.template ?? 'win11-chrome-us',
      browser: {},
      system: {},
    },
    results: results.map((r) => ({
      id: r.id,
      name: r.id,
      url: `https://example.com/${r.id}`,
      ok: r.ok,
      durationMs: 1000,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot projection
// ─────────────────────────────────────────────────────────────────────────────

describe('diffRuns — RunSnapshot projection', () => {
  it('projects the seven snapshot fields from a completed run', () => {
    const a = makeRun({ id: 'A', durationMs: 1234, score: makeScore({ weightedHits: 5 }) });
    const b = makeRun({ id: 'B', durationMs: 9999, score: makeScore({ weightedHits: 3 }) });
    const out = diffRuns('p', a, b);
    expect(out.runA).toEqual({
      id: 'A',
      status: 'completed',
      durationMs: 1234,
      weightedHits: 5,
      totalHits: 0,
      sitesOk: 12,
      sitesFail: 0,
    });
    expect(out.runB.id).toBe('B');
    expect(out.runB.durationMs).toBe(9999);
    expect(out.runB.weightedHits).toBe(3);
  });

  it('uses zero for score-derived fields when run.score is null (failed run)', () => {
    const a = makeRun({ status: 'failed', score: null, error: 'launch failed' });
    const b = makeRun();
    const out = diffRuns('p', a, b);
    expect(out.runA.status).toBe('failed');
    expect(out.runA.weightedHits).toBe(0);
    expect(out.runA.totalHits).toBe(0);
    expect(out.runA.sitesOk).toBe(0);
    expect(out.runA.sitesFail).toBe(0);
  });

  it('preserves personaId verbatim', () => {
    const out = diffRuns('my-persona-id', makeRun(), makeRun());
    expect(out.personaId).toBe('my-persona-id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity matching: added / removed / changed
// ─────────────────────────────────────────────────────────────────────────────

describe('diffRuns — hit matching (added / removed / changed)', () => {
  it('returns empty diff when both runs have no hits', () => {
    const out = diffRuns('p', makeRun(), makeRun());
    expect(out.added).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.changed).toEqual([]);
    expect(out.hasRegression).toBe(false);
  });

  it('classifies a B-only hit as added (regression)', () => {
    const a = makeRun();
    const b = makeRun({
      score: makeScore({
        hits: [makeHit({ surface: 'webgl', detector: 'lower-entropy' })],
        weightedHits: 1.5,
      }),
    });
    const out = diffRuns('p', a, b);
    expect(out.added).toHaveLength(1);
    expect(out.added[0]?.detector).toBe('lower-entropy');
    expect(out.removed).toEqual([]);
    expect(out.changed).toEqual([]);
    expect(out.hasRegression).toBe(true);
  });

  it('classifies an A-only hit as removed (improvement)', () => {
    const a = makeRun({
      score: makeScore({
        hits: [makeHit({ surface: 'canvas', detector: 'fixed-issue' })],
        weightedHits: 1.5,
      }),
    });
    const b = makeRun();
    const out = diffRuns('p', a, b);
    expect(out.removed).toHaveLength(1);
    expect(out.removed[0]?.detector).toBe('fixed-issue');
    expect(out.added).toEqual([]);
    expect(out.hasRegression).toBe(false);
  });

  it('uses (surface, site, detector) as identity — same triple keeps identity', () => {
    const aHit = makeHit({
      surface: 'canvas',
      site: 'browserleaks-canvas',
      detector: 'uniqueness',
      evidence: 'A-evidence',
      severity: 'low',
    });
    const bHit = makeHit({
      surface: 'canvas',
      site: 'browserleaks-canvas',
      detector: 'uniqueness',
      evidence: 'B-evidence',
      severity: 'high',
    });
    const out = diffRuns(
      'p',
      makeRun({ score: makeScore({ hits: [aHit] }) }),
      makeRun({ score: makeScore({ hits: [bHit] }) }),
    );
    expect(out.added).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.changed).toHaveLength(1);
    expect(out.changed[0]?.before).toEqual(aHit);
    expect(out.changed[0]?.after).toEqual(bHit);
  });

  it('flags only severity in `diff` when only severity changed', () => {
    const aHit = makeHit({ severity: 'low' });
    const bHit = makeHit({ severity: 'high' });
    const out = diffRuns(
      'p',
      makeRun({ score: makeScore({ hits: [aHit] }) }),
      makeRun({ score: makeScore({ hits: [bHit] }) }),
    );
    expect(out.changed[0]?.diff).toEqual(['severity']);
  });

  it('flags only evidence in `diff` when only evidence changed', () => {
    const aHit = makeHit({ evidence: 'pre' });
    const bHit = makeHit({ evidence: 'post' });
    const out = diffRuns(
      'p',
      makeRun({ score: makeScore({ hits: [aHit] }) }),
      makeRun({ score: makeScore({ hits: [bHit] }) }),
    );
    expect(out.changed[0]?.diff).toEqual(['evidence']);
  });

  it('flags both severity + evidence when both changed', () => {
    const aHit = makeHit({ severity: 'low', evidence: 'pre' });
    const bHit = makeHit({ severity: 'high', evidence: 'post' });
    const out = diffRuns(
      'p',
      makeRun({ score: makeScore({ hits: [aHit] }) }),
      makeRun({ score: makeScore({ hits: [bHit] }) }),
    );
    expect(out.changed[0]?.diff).toEqual(['severity', 'evidence']);
  });

  it('does NOT add an entry to `changed` when severity and evidence are identical', () => {
    const hit = makeHit();
    const out = diffRuns(
      'p',
      makeRun({ score: makeScore({ hits: [hit] }) }),
      makeRun({ score: makeScore({ hits: [hit] }) }),
    );
    expect(out.changed).toEqual([]);
  });

  it('handles a mix of added / removed / changed in the same diff', () => {
    const stable = makeHit({ surface: 'canvas', site: 's', detector: 'stable' });
    const churn = {
      a: makeHit({ surface: 'webgl', site: 's', detector: 'churn', severity: 'low' }),
      b: makeHit({ surface: 'webgl', site: 's', detector: 'churn', severity: 'high' }),
    };
    const onlyInA = makeHit({ surface: 'audio', site: 's', detector: 'only-A' });
    const onlyInB = makeHit({ surface: 'font', site: 's', detector: 'only-B' });
    const out = diffRuns(
      'p',
      makeRun({ score: makeScore({ hits: [stable, churn.a, onlyInA] }) }),
      makeRun({ score: makeScore({ hits: [stable, churn.b, onlyInB] }) }),
    );
    expect(out.added.map((h) => h.detector)).toEqual(['only-B']);
    expect(out.removed.map((h) => h.detector)).toEqual(['only-A']);
    expect(out.changed).toHaveLength(1);
    expect(out.changed[0]?.after.detector).toBe('churn');
  });

  it('distinguishes hits that share two of three identity fields', () => {
    // Same surface + site, different detector → two separate identities.
    const aHit = makeHit({ surface: 'canvas', site: 'X', detector: 'd1' });
    const bHit = makeHit({ surface: 'canvas', site: 'X', detector: 'd2' });
    const out = diffRuns(
      'p',
      makeRun({ score: makeScore({ hits: [aHit] }) }),
      makeRun({ score: makeScore({ hits: [bHit] }) }),
    );
    expect(out.removed.map((h) => h.detector)).toEqual(['d1']);
    expect(out.added.map((h) => h.detector)).toEqual(['d2']);
    expect(out.changed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delta math
// ─────────────────────────────────────────────────────────────────────────────

describe('diffRuns — delta math', () => {
  it('computes weightedHits / totalHits / sitesOk / sitesFail as B - A', () => {
    const a = makeRun({
      score: makeScore({
        sitesOk: 10,
        sitesFail: 2,
        weightedHits: 6.0,
        hits: [makeHit(), makeHit({ detector: 'd2' })],
      }),
    });
    const b = makeRun({
      score: makeScore({
        sitesOk: 12,
        sitesFail: 0,
        weightedHits: 1.5,
        hits: [makeHit()],
      }),
    });
    const out = diffRuns('p', a, b);
    expect(out.delta.weightedHits).toBeCloseTo(-4.5, 5);
    expect(out.delta.totalHits).toBe(-1);
    expect(out.delta.sitesOk).toBe(2);
    expect(out.delta.sitesFail).toBe(-2);
  });

  it('returns zero deltas when both runs are identical', () => {
    const out = diffRuns('p', makeRun(), makeRun());
    expect(out.delta).toEqual({ weightedHits: 0, totalHits: 0, sitesOk: 0, sitesFail: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site flips
// ─────────────────────────────────────────────────────────────────────────────

describe('diffRuns — site flips', () => {
  it('detects ok → fail flips (regression)', () => {
    const a = makeRun({
      raw: makeRaw([
        { id: 'sannysoft', ok: true },
        { id: 'creepjs', ok: true },
      ]),
    });
    const b = makeRun({
      raw: makeRaw([
        { id: 'sannysoft', ok: true },
        { id: 'creepjs', ok: false },
      ]),
    });
    const out = diffRuns('p', a, b);
    expect(out.sitesFlipped.okToFail).toEqual(['creepjs']);
    expect(out.sitesFlipped.failToOk).toEqual([]);
    expect(out.hasRegression).toBe(true);
  });

  it('detects fail → ok flips (improvement, not a regression)', () => {
    const a = makeRun({
      raw: makeRaw([
        { id: 'sannysoft', ok: true },
        { id: 'creepjs', ok: false },
      ]),
    });
    const b = makeRun({
      raw: makeRaw([
        { id: 'sannysoft', ok: true },
        { id: 'creepjs', ok: true },
      ]),
    });
    const out = diffRuns('p', a, b);
    expect(out.sitesFlipped.okToFail).toEqual([]);
    expect(out.sitesFlipped.failToOk).toEqual(['creepjs']);
    expect(out.hasRegression).toBe(false);
  });

  it('detects both flip directions in one diff', () => {
    const a = makeRun({
      raw: makeRaw([
        { id: 'a-only-ok', ok: true },
        { id: 'a-only-fail', ok: false },
      ]),
    });
    const b = makeRun({
      raw: makeRaw([
        { id: 'a-only-ok', ok: false },
        { id: 'a-only-fail', ok: true },
      ]),
    });
    const out = diffRuns('p', a, b);
    expect(out.sitesFlipped.okToFail).toEqual(['a-only-ok']);
    expect(out.sitesFlipped.failToOk).toEqual(['a-only-fail']);
  });

  it('returns empty flips when no raw.results are present in either run', () => {
    const out = diffRuns('p', makeRun({ raw: undefined }), makeRun({ raw: undefined }));
    expect(out.sitesFlipped.okToFail).toEqual([]);
    expect(out.sitesFlipped.failToOk).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Site list discrepancies
// ─────────────────────────────────────────────────────────────────────────────

describe('diffRuns — sites only in A or B (e.g. different --only flags)', () => {
  it('lists sites in A but not B as sitesOnlyInA', () => {
    const a = makeRun({
      raw: makeRaw([
        { id: 'sannysoft', ok: true },
        { id: 'creepjs', ok: true },
      ]),
    });
    const b = makeRun({
      raw: makeRaw([{ id: 'sannysoft', ok: true }]),
    });
    const out = diffRuns('p', a, b);
    expect(out.sitesOnlyInA).toEqual(['creepjs']);
    expect(out.sitesOnlyInB).toEqual([]);
  });

  it('lists sites in B but not A as sitesOnlyInB', () => {
    const a = makeRun({
      raw: makeRaw([{ id: 'sannysoft', ok: true }]),
    });
    const b = makeRun({
      raw: makeRaw([
        { id: 'sannysoft', ok: true },
        { id: 'amiunique', ok: true },
      ]),
    });
    const out = diffRuns('p', a, b);
    expect(out.sitesOnlyInA).toEqual([]);
    expect(out.sitesOnlyInB).toEqual(['amiunique']);
  });

  it('A-only sites are excluded from flip detection (would be misleading)', () => {
    const a = makeRun({
      raw: makeRaw([
        { id: 'common', ok: true },
        { id: 'a-only', ok: false },
      ]),
    });
    const b = makeRun({
      raw: makeRaw([{ id: 'common', ok: true }]),
    });
    const out = diffRuns('p', a, b);
    expect(out.sitesFlipped.failToOk).toEqual([]);
    expect(out.sitesFlipped.okToFail).toEqual([]);
    expect(out.sitesOnlyInA).toEqual(['a-only']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hasRegression policy
// ─────────────────────────────────────────────────────────────────────────────

describe('diffRuns — hasRegression policy', () => {
  it('is false when runs are equivalent', () => {
    expect(diffRuns('p', makeRun(), makeRun()).hasRegression).toBe(false);
  });

  it('is true when there is any added hit', () => {
    const out = diffRuns('p', makeRun(), makeRun({ score: makeScore({ hits: [makeHit()] }) }));
    expect(out.hasRegression).toBe(true);
  });

  it('is true when delta.weightedHits > 0 (without any added hit)', () => {
    // Same identity, but B has higher severity → no added, but weightedHits up
    const aHit = makeHit({ severity: 'low' });
    const bHit = makeHit({ severity: 'high' });
    const out = diffRuns(
      'p',
      makeRun({ score: makeScore({ hits: [aHit], weightedHits: 0.5 }) }),
      makeRun({ score: makeScore({ hits: [bHit], weightedHits: 3.0 }) }),
    );
    expect(out.added).toEqual([]);
    expect(out.delta.weightedHits).toBeCloseTo(2.5, 5);
    expect(out.hasRegression).toBe(true);
  });

  it('is true when an ok → fail site flip happens (even without hit changes)', () => {
    const a = makeRun({
      raw: makeRaw([{ id: 'sannysoft', ok: true }]),
    });
    const b = makeRun({
      raw: makeRaw([{ id: 'sannysoft', ok: false }]),
    });
    const out = diffRuns('p', a, b);
    expect(out.hasRegression).toBe(true);
  });

  it('is false when B has improvements only (lower weightedHits, removed hits)', () => {
    const a = makeRun({
      score: makeScore({ hits: [makeHit(), makeHit({ detector: 'd2' })], weightedHits: 3.0 }),
    });
    const b = makeRun({ score: makeScore({ weightedHits: 0 }) });
    const out = diffRuns('p', a, b);
    expect(out.removed).toHaveLength(2);
    expect(out.delta.weightedHits).toBe(-3.0);
    expect(out.hasRegression).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failed / canceled runs (score == null)
// ─────────────────────────────────────────────────────────────────────────────

describe('diffRuns — failed / canceled runs', () => {
  it('treats a failed run as 0 weightedHits / empty hits without crashing', () => {
    const a = makeRun({ status: 'failed', score: null, error: 'boom' });
    const b = makeRun({ score: makeScore({ hits: [makeHit()], weightedHits: 1.5 }) });
    const out = diffRuns('p', a, b);
    expect(out.runA.weightedHits).toBe(0);
    expect(out.runA.totalHits).toBe(0);
    expect(out.added).toHaveLength(1);
    expect(out.hasRegression).toBe(true);
  });

  it('handles two failed runs symmetrically — no hits diff, deltas zero', () => {
    const a = makeRun({ status: 'failed', score: null, error: 'A boom' });
    const b = makeRun({ status: 'canceled', score: null });
    const out = diffRuns('p', a, b);
    expect(out.added).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.changed).toEqual([]);
    expect(out.delta).toEqual({ weightedHits: 0, totalHits: 0, sitesOk: 0, sitesFail: 0 });
    expect(out.hasRegression).toBe(false);
    // 状态差异仍然能从 snapshot 看到
    expect(out.runA.status).toBe('failed');
    expect(out.runB.status).toBe('canceled');
  });
});
