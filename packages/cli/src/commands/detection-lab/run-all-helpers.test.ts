import type { DetectionRun, Persona } from '@mosaiq/sdk';
import { describe, expect, it } from 'vitest';

import {
  type BatchAggregate,
  type BatchPolicy,
  type PersonaBatchResult,
  type RegressionInfo,
  aggregateBatch,
  decideBatchExitCode,
  findRegressionBaseline,
  selectPersonas,
} from './run-all-helpers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures — 手搓最小 Persona / DetectionRun stubs，用 `as` 通过类型擦
// （helpers 只读 metadata.id / metadata.displayName / status / startedAt）。
// ─────────────────────────────────────────────────────────────────────────────

function persona(id: string, displayName?: string): Persona {
  return {
    metadata: {
      id,
      displayName: displayName ?? id,
      tags: [],
      notes: '',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      lastLaunchedAt: null,
      launchCount: 0,
    },
  } as unknown as Persona;
}

function emptyResult(personaId: string): PersonaBatchResult {
  return {
    personaId,
    displayName: personaId,
    status: 'completed',
    runId: '2026-05-20T10-00-00-000Z',
    durationMs: 0,
    sitesAttempted: 0,
    sitesOk: 0,
    sitesFail: 0,
    totalHits: 0,
    weightedHits: 0,
    highHits: 0,
    mediumHits: 0,
    lowHits: 0,
    error: null,
    regression: null,
  };
}

function emptyAggregate(): BatchAggregate {
  return {
    personasAttempted: 0,
    personasCompleted: 0,
    personasCanceled: 0,
    personasFailed: 0,
    sitesAttempted: 0,
    sitesOk: 0,
    sitesFail: 0,
    totalHits: 0,
    weightedHits: 0,
    highHits: 0,
    mediumHits: 0,
    lowHits: 0,
    personasWithRegression: [],
    worstPersona: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// selectPersonas
// ─────────────────────────────────────────────────────────────────────────────

describe('selectPersonas', () => {
  const all = [persona('alice'), persona('bob'), persona('carol')];

  it('returns everything when no filters', () => {
    const r = selectPersonas(all);
    expect(r.selected.map((p) => p.metadata.id)).toEqual(['alice', 'bob', 'carol']);
    expect(r.unknownIds).toEqual([]);
  });

  it('respects --only with user-specified order', () => {
    // user typed `--only carol,alice` — output should match that order
    const r = selectPersonas(all, { only: ['carol', 'alice'] });
    expect(r.selected.map((p) => p.metadata.id)).toEqual(['carol', 'alice']);
    expect(r.unknownIds).toEqual([]);
  });

  it('reports unknown ids in --only without aborting', () => {
    const r = selectPersonas(all, { only: ['alice', 'ghost', 'bob'] });
    expect(r.selected.map((p) => p.metadata.id)).toEqual(['alice', 'bob']);
    expect(r.unknownIds).toEqual(['ghost']);
  });

  it('removes ids in --skip from the full list', () => {
    const r = selectPersonas(all, { skip: ['bob'] });
    expect(r.selected.map((p) => p.metadata.id)).toEqual(['alice', 'carol']);
    expect(r.unknownIds).toEqual([]);
  });

  it('reports unknown ids in --skip too (typo detection)', () => {
    const r = selectPersonas(all, { skip: ['bob', 'phantom'] });
    expect(r.selected.map((p) => p.metadata.id)).toEqual(['alice', 'carol']);
    expect(r.unknownIds).toEqual(['phantom']);
  });

  it('applies skip after only (skip wins on overlap)', () => {
    const r = selectPersonas(all, { only: ['alice', 'bob', 'carol'], skip: ['bob'] });
    expect(r.selected.map((p) => p.metadata.id)).toEqual(['alice', 'carol']);
  });

  it('returns empty selection when only=[] is passed (treated as no filter)', () => {
    // Empty arrays come from CSV split of empty string; treat as "no filter"
    const r = selectPersonas(all, { only: [] });
    expect(r.selected.map((p) => p.metadata.id)).toEqual(['alice', 'bob', 'carol']);
  });

  it('returns empty when --only refers to only unknown ids', () => {
    const r = selectPersonas(all, { only: ['ghost', 'phantom'] });
    expect(r.selected).toEqual([]);
    expect(r.unknownIds).toEqual(['ghost', 'phantom']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregateBatch
// ─────────────────────────────────────────────────────────────────────────────

describe('aggregateBatch', () => {
  it('returns zeroed aggregate for empty input', () => {
    expect(aggregateBatch([])).toEqual(emptyAggregate());
  });

  it('counts statuses (completed / canceled / failed / skipped)', () => {
    const results: PersonaBatchResult[] = [
      { ...emptyResult('a'), status: 'completed' },
      { ...emptyResult('b'), status: 'canceled' },
      { ...emptyResult('c'), status: 'failed' },
      { ...emptyResult('d'), status: 'skipped' },
    ];
    const agg = aggregateBatch(results);
    // skipped does NOT count as attempted
    expect(agg.personasAttempted).toBe(3);
    expect(agg.personasCompleted).toBe(1);
    expect(agg.personasCanceled).toBe(1);
    expect(agg.personasFailed).toBe(1);
  });

  it('sums sites and hits across personas', () => {
    const results: PersonaBatchResult[] = [
      {
        ...emptyResult('a'),
        sitesAttempted: 12,
        sitesOk: 10,
        sitesFail: 2,
        totalHits: 3,
        weightedHits: 4.5,
        highHits: 1,
        mediumHits: 1,
        lowHits: 1,
      },
      {
        ...emptyResult('b'),
        sitesAttempted: 12,
        sitesOk: 12,
        sitesFail: 0,
        totalHits: 0,
        weightedHits: 0,
        highHits: 0,
        mediumHits: 0,
        lowHits: 0,
      },
    ];
    const agg = aggregateBatch(results);
    expect(agg.sitesAttempted).toBe(24);
    expect(agg.sitesOk).toBe(22);
    expect(agg.sitesFail).toBe(2);
    expect(agg.totalHits).toBe(3);
    expect(agg.weightedHits).toBe(4.5);
    expect(agg.highHits).toBe(1);
    expect(agg.mediumHits).toBe(1);
    expect(agg.lowHits).toBe(1);
  });

  it('rounds weightedHits to 2 decimals (avoids floating-point cruft in --json)', () => {
    const results: PersonaBatchResult[] = [
      { ...emptyResult('a'), weightedHits: 1.1 },
      { ...emptyResult('b'), weightedHits: 2.2 },
    ];
    expect(aggregateBatch(results).weightedHits).toBeCloseTo(3.3, 5);
    // Crucially, no '3.3000000000000003'
    expect(aggregateBatch(results).weightedHits).toBe(3.3);
  });

  it('collects personas-with-regression list in input order', () => {
    const reg: RegressionInfo = {
      previousRunId: 'prev',
      addedHits: 1,
      deltaWeightedHits: 1.5,
      okToFail: [],
    };
    const results: PersonaBatchResult[] = [
      { ...emptyResult('alice'), regression: reg },
      { ...emptyResult('bob') }, // no regression
      { ...emptyResult('carol'), regression: reg },
    ];
    expect(aggregateBatch(results).personasWithRegression).toEqual(['alice', 'carol']);
  });

  it('worstPersona is null when nobody has hits', () => {
    const results: PersonaBatchResult[] = [emptyResult('a'), emptyResult('b')];
    expect(aggregateBatch(results).worstPersona).toBeNull();
  });

  it('worstPersona ranks by weightedHits desc', () => {
    const results: PersonaBatchResult[] = [
      { ...emptyResult('a'), totalHits: 1, weightedHits: 0.5 },
      { ...emptyResult('b'), totalHits: 3, weightedHits: 4.5 },
      { ...emptyResult('c'), totalHits: 2, weightedHits: 3.0 },
    ];
    expect(aggregateBatch(results).worstPersona).toEqual({
      personaId: 'b',
      weightedHits: 4.5,
      totalHits: 3,
    });
  });

  it('worstPersona tiebreaker: weightedHits eq → totalHits desc → personaId asc', () => {
    const results: PersonaBatchResult[] = [
      { ...emptyResult('zulu'), totalHits: 2, weightedHits: 3.0 },
      { ...emptyResult('alpha'), totalHits: 2, weightedHits: 3.0 },
    ];
    // Same weighted, same totalHits → personaId asc → alpha wins
    expect(aggregateBatch(results).worstPersona?.personaId).toBe('alpha');
  });

  it('skipped personas never affect numbers', () => {
    const results: PersonaBatchResult[] = [
      {
        ...emptyResult('a'),
        status: 'skipped',
        sitesAttempted: 12, // these should be ignored
        totalHits: 99,
        weightedHits: 99,
      },
      { ...emptyResult('b'), status: 'completed', sitesAttempted: 12, totalHits: 0 },
    ];
    const agg = aggregateBatch(results);
    expect(agg.personasAttempted).toBe(1);
    expect(agg.sitesAttempted).toBe(12);
    expect(agg.totalHits).toBe(0);
    expect(agg.weightedHits).toBe(0);
    expect(agg.worstPersona).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideBatchExitCode
// ─────────────────────────────────────────────────────────────────────────────

describe('decideBatchExitCode', () => {
  const defaultPolicy: BatchPolicy = { failOnHits: 'none', failOnRegression: false };

  it('returns 0 for clean batch under default policy', () => {
    const agg = { ...emptyAggregate(), personasAttempted: 3, personasCompleted: 3 };
    expect(decideBatchExitCode(agg, defaultPolicy)).toBe(0);
  });

  it('returns 1 when any persona has runtime failure (even under failOnHits=none)', () => {
    // CI-friendly: a browser launch failure should NEVER be masked by the
    // default policy. Otherwise green-light CI = "no real signal lost".
    const agg = { ...emptyAggregate(), personasAttempted: 3, personasFailed: 1 };
    expect(decideBatchExitCode(agg, defaultPolicy)).toBe(1);
  });

  it('returns 0 with hits but failOnHits=none (default lenient)', () => {
    const agg = { ...emptyAggregate(), totalHits: 5, weightedHits: 7.5, highHits: 1 };
    expect(decideBatchExitCode(agg, defaultPolicy)).toBe(0);
  });

  it('returns 1 when failOnHits=any and totalHits>0', () => {
    const agg = { ...emptyAggregate(), totalHits: 1, lowHits: 1 };
    expect(decideBatchExitCode(agg, { failOnHits: 'any', failOnRegression: false })).toBe(1);
  });

  it('returns 0 when failOnHits=any but no hits', () => {
    expect(
      decideBatchExitCode(emptyAggregate(), { failOnHits: 'any', failOnRegression: false }),
    ).toBe(0);
  });

  it('failOnHits=medium triggers on medium AND high', () => {
    const policy: BatchPolicy = { failOnHits: 'medium', failOnRegression: false };
    expect(decideBatchExitCode({ ...emptyAggregate(), totalHits: 1, lowHits: 1 }, policy)).toBe(0); // low only
    expect(decideBatchExitCode({ ...emptyAggregate(), totalHits: 1, mediumHits: 1 }, policy)).toBe(
      1,
    );
    expect(decideBatchExitCode({ ...emptyAggregate(), totalHits: 1, highHits: 1 }, policy)).toBe(1);
  });

  it('failOnHits=high triggers only on high', () => {
    const policy: BatchPolicy = { failOnHits: 'high', failOnRegression: false };
    expect(decideBatchExitCode({ ...emptyAggregate(), totalHits: 5, mediumHits: 5 }, policy)).toBe(
      0,
    ); // many medium, no high
    expect(decideBatchExitCode({ ...emptyAggregate(), totalHits: 1, highHits: 1 }, policy)).toBe(1);
  });

  it('failOnRegression=true exits 1 when any persona regressed', () => {
    const agg = { ...emptyAggregate(), personasWithRegression: ['alice'] };
    expect(decideBatchExitCode(agg, { failOnHits: 'none', failOnRegression: true })).toBe(1);
  });

  it('failOnRegression=false ignores regressions even when present', () => {
    const agg = { ...emptyAggregate(), personasWithRegression: ['alice'] };
    expect(decideBatchExitCode(agg, { failOnHits: 'none', failOnRegression: false })).toBe(0);
  });

  it('failure dominates other signals (no double-count, just 1)', () => {
    const agg = {
      ...emptyAggregate(),
      personasFailed: 1,
      totalHits: 5,
      highHits: 1,
      personasWithRegression: ['x'],
    };
    expect(decideBatchExitCode(agg, { failOnHits: 'high', failOnRegression: true })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findRegressionBaseline
// ─────────────────────────────────────────────────────────────────────────────

describe('findRegressionBaseline', () => {
  function run(args: {
    id: string;
    startedAt: string;
    status?: DetectionRun['status'];
  }): DetectionRun {
    return {
      id: args.id,
      startedAt: args.startedAt,
      status: args.status ?? 'completed',
    } as unknown as DetectionRun;
  }

  it('returns null when history is empty', () => {
    const cur = run({ id: 'B', startedAt: '2026-05-20T10:00:00.000Z' });
    expect(findRegressionBaseline(cur, [])).toBeNull();
  });

  it('returns null when only the current run is in history', () => {
    const cur = run({ id: 'B', startedAt: '2026-05-20T10:00:00.000Z' });
    expect(findRegressionBaseline(cur, [cur])).toBeNull();
  });

  it('picks the most recent completed predecessor', () => {
    const cur = run({ id: 'C', startedAt: '2026-05-20T12:00:00.000Z' });
    const old = run({ id: 'A', startedAt: '2026-05-19T08:00:00.000Z' });
    const recent = run({ id: 'B', startedAt: '2026-05-20T11:00:00.000Z' });
    expect(findRegressionBaseline(cur, [cur, recent, old])?.id).toBe('B');
  });

  it('skips failed and canceled predecessors', () => {
    const cur = run({ id: 'C', startedAt: '2026-05-20T12:00:00.000Z' });
    // most recent predecessor is failed → skip; fall back to older completed
    const failed = run({ id: 'B', startedAt: '2026-05-20T11:00:00.000Z', status: 'failed' });
    const olderOk = run({ id: 'A', startedAt: '2026-05-19T08:00:00.000Z', status: 'completed' });
    expect(findRegressionBaseline(cur, [cur, failed, olderOk])?.id).toBe('A');
  });

  it('skips canceled too', () => {
    const cur = run({ id: 'C', startedAt: '2026-05-20T12:00:00.000Z' });
    const canceled = run({
      id: 'B',
      startedAt: '2026-05-20T11:00:00.000Z',
      status: 'canceled',
    });
    expect(findRegressionBaseline(cur, [cur, canceled])).toBeNull();
  });

  it('does not pick predecessors after the current run (clock skew defense)', () => {
    const cur = run({ id: 'A', startedAt: '2026-05-20T10:00:00.000Z' });
    const future = run({ id: 'B', startedAt: '2026-05-21T10:00:00.000Z' });
    expect(findRegressionBaseline(cur, [cur, future])).toBeNull();
  });

  it('handles invalid startedAt strings gracefully (returns null)', () => {
    const cur = run({ id: 'B', startedAt: 'not-a-date' });
    const old = run({ id: 'A', startedAt: '2026-05-19T08:00:00.000Z' });
    expect(findRegressionBaseline(cur, [cur, old])).toBeNull();
  });

  it('skips history entries with invalid startedAt strings', () => {
    const cur = run({ id: 'C', startedAt: '2026-05-20T12:00:00.000Z' });
    const bad = run({ id: 'B', startedAt: 'invalid' });
    const old = run({ id: 'A', startedAt: '2026-05-19T08:00:00.000Z' });
    expect(findRegressionBaseline(cur, [cur, bad, old])?.id).toBe('A');
  });
});
