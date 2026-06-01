#!/usr/bin/env node
// =============================================================================
// scripts/refresh-baseline.test.mts
//
// Pure-logic unit tests for `computeConsensus` (the multi-run consensus
// algorithm in scripts/refresh-baseline.mts). No Chromium, no live
// detection sites — just synthetic DetectionRun objects to verify the
// vote / merge / weighted-recompute rules.
//
// Why a hand-rolled runner instead of vitest?
//   scripts/ is not a workspace package — adding a root vitest config
//   would pull a much wider set of test files into the same runner.
//   This file uses node:assert and exits 0/1, runnable via
//     pnpm test:refresh-baseline
//   which the root CI step invokes alongside the other drift-checks.
//
// Run locally:
//   pnpm tsx scripts/refresh-baseline.test.mts
//   pnpm test:refresh-baseline
// =============================================================================

import assert from 'node:assert/strict';

import {
  type DetectionRun,
  type DetectionRunRaw,
  SDK_VERSION,
  SEVERITY_WEIGHT,
  type SurfaceHit,
  emptyHitsBySurface,
} from '../packages/sdk/src/index.js';

import { compareHitForSort, computeConsensus, pickWorstSeverity } from './refresh-baseline.mts';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal tiny runner — no deps, just a list of [name, fn] and an exit.
// ─────────────────────────────────────────────────────────────────────────────

type TestFn = () => void;
const tests: Array<[string, TestFn]> = [];
function test(name: string, fn: TestFn): void {
  tests.push([name, fn]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers — build minimal-but-valid DetectionRun objects.
// ─────────────────────────────────────────────────────────────────────────────

interface RunOverrides {
  siteOks?: Record<string, boolean>; // siteId → ok
  hits?: SurfaceHit[];
  personaId?: string;
}

const SITE_IDS = ['sannysoft', 'creepjs', 'browserscan'] as const;

function makeRun(o: RunOverrides = {}): DetectionRun {
  const personaId = o.personaId ?? 'test-persona';
  const siteOks = o.siteOks ?? Object.fromEntries(SITE_IDS.map((id) => [id, true]));
  const hits = o.hits ?? [];

  const okCountForRaw = SITE_IDS.filter((id) => siteOks[id] !== false).length;
  const raw: DetectionRunRaw = {
    timestamp: '1970-01-01T00:00:00.000Z',
    overallMs: 0,
    sitesAttempted: SITE_IDS.length,
    sitesOk: okCountForRaw,
    sitesFail: SITE_IDS.length - okCountForRaw,
    persona: {
      id: personaId,
      template: 'test',
      browser: {},
      system: {},
    },
    results: SITE_IDS.map((id) => ({
      id,
      name: id,
      url: `https://${id}.example.com`,
      ok: siteOks[id] ?? true,
      durationMs: 0,
    })),
  };

  const okCount = SITE_IDS.filter((id) => siteOks[id]).length;
  const hitsBySurface = emptyHitsBySurface();
  for (const h of hits) hitsBySurface[h.surface] = (hitsBySurface[h.surface] ?? 0) + 1;
  const weighted = hits.reduce((acc, h) => acc + SEVERITY_WEIGHT[h.severity], 0);

  return {
    id: 'baseline',
    personaId,
    startedAt: '1970-01-01T00:00:00.000Z',
    finishedAt: '1970-01-01T00:00:00.000Z',
    status: 'completed',
    sitesAttempted: [...SITE_IDS],
    durationMs: 0,
    score: {
      sitesOk: okCount,
      sitesFail: SITE_IDS.length - okCount,
      creepjsLies: 0,
      creepjsBoldFail: 0,
      sannysoftPass: 0,
      sannysoftTotal: 0,
      dbiBotFlagsTriggered: 0,
      amiuniqueOutliers: 0,
      fpScannerInconsistent: 0,
      incolumitasBadFlags: 0,
      weightedHits: weighted,
      hits: [...hits],
      hitsBySurface,
    },
    raw,
    error: null,
    meta: { sdkVersion: SDK_VERSION, chromiumVersion: 'baseline' },
  };
}

function mkHit(
  surface: SurfaceHit['surface'],
  site: string,
  detector: string,
  severity: SurfaceHit['severity'] = 'medium',
  evidence = '',
): SurfaceHit {
  return { surface, site, detector, severity, evidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('single run returns identity', () => {
  const r = makeRun({ hits: [mkHit('canvas', 'browserleaks', 'hash unique', 'medium')] });
  const consensus = computeConsensus([r]);
  assert.equal(consensus, r, 'n=1 should short-circuit and return the input run');
});

test('3 identical runs yield identical consensus (score-wise)', () => {
  const hits = [mkHit('canvas', 'browserleaks', 'hash unique')];
  const r1 = makeRun({ hits });
  const r2 = makeRun({ hits });
  const r3 = makeRun({ hits });
  const consensus = computeConsensus([r1, r2, r3]);
  assert.equal(consensus.score?.hits.length, 1, 'should keep the 3/3-vote hit');
  assert.equal(consensus.score?.weightedHits, SEVERITY_WEIGHT.medium);
  assert.deepEqual(consensus.sitesAttempted, [...SITE_IDS]);
});

test('hit appearing in only 1 of 3 runs is dropped', () => {
  const baseHits = [mkHit('canvas', 'browserleaks', 'hash unique')];
  const noisyExtra = mkHit('webgl', 'browserscan', 'glsl noise');
  const r1 = makeRun({ hits: [...baseHits, noisyExtra] });
  const r2 = makeRun({ hits: baseHits });
  const r3 = makeRun({ hits: baseHits });
  const consensus = computeConsensus([r1, r2, r3]);
  assert.equal(consensus.score?.hits.length, 1, '1/3-vote noisy hit should be dropped');
  assert.equal(consensus.score?.hits[0]?.surface, 'canvas');
  assert.equal(consensus.score?.hitsBySurface.webgl, 0, 'hitsBySurface should reflect dropped hit');
});

test('hit appearing in 2 of 3 runs is kept', () => {
  const sharedHit = mkHit('webdriver', 'sannysoft', 'navigator.webdriver leak', 'high');
  const r1 = makeRun({ hits: [sharedHit] });
  const r2 = makeRun({ hits: [sharedHit] });
  const r3 = makeRun({ hits: [] });
  const consensus = computeConsensus([r1, r2, r3]);
  assert.equal(consensus.score?.hits.length, 1);
  assert.equal(consensus.score?.hits[0]?.severity, 'high');
  assert.equal(consensus.score?.weightedHits, SEVERITY_WEIGHT.high);
});

test('site ok-vote: 2 of 3 ok → consensus ok; 1 of 3 ok → consensus fail', () => {
  // creepjs: ok in 2/3 → consensus ok
  // sannysoft: ok in 1/3 → consensus fail
  // browserscan: ok in 3/3 → consensus ok
  const r1 = makeRun({ siteOks: { sannysoft: true, creepjs: true, browserscan: true } });
  const r2 = makeRun({ siteOks: { sannysoft: false, creepjs: true, browserscan: true } });
  const r3 = makeRun({ siteOks: { sannysoft: false, creepjs: false, browserscan: true } });
  const consensus = computeConsensus([r1, r2, r3]);
  const oks = Object.fromEntries((consensus.raw?.results ?? []).map((s) => [s.id, s.ok]));
  assert.equal(oks.creepjs, true, 'creepjs 2/3 ok → consensus ok');
  assert.equal(oks.sannysoft, false, 'sannysoft 1/3 ok → consensus fail');
  assert.equal(oks.browserscan, true, 'browserscan 3/3 ok → consensus ok');
  assert.equal(consensus.score?.sitesOk, 2);
  assert.equal(consensus.score?.sitesFail, 1);
});

test('severity tie-break: same hit identity with mixed severities picks worst', () => {
  // Same surface+site+detector but different severities across runs.
  // 2/3-vote → keep; severity from pickWorstSeverity = 'high'.
  const h_low = mkHit('canvas', 'browserleaks', 'hash unique', 'low');
  const h_high = mkHit('canvas', 'browserleaks', 'hash unique', 'high');
  const r1 = makeRun({ hits: [h_low] });
  const r2 = makeRun({ hits: [h_high] });
  const r3 = makeRun({ hits: [] });
  const consensus = computeConsensus([r1, r2, r3]);
  assert.equal(consensus.score?.hits.length, 1);
  assert.equal(consensus.score?.hits[0]?.severity, 'high', 'should pick worst severity');
  assert.equal(consensus.score?.weightedHits, SEVERITY_WEIGHT.high);
});

test('weightedHits recomputed from consensus hits only (not summed across input runs)', () => {
  // r1 has 2 hits, r2 has 0 hits, r3 has 2 hits (one shared with r1).
  // Consensus: only the shared hit survives (2/3 vote).
  // Wrong impl would sum 2+0+2 / 3 = 1.33; correct = 1.5 (one medium hit).
  const shared = mkHit('canvas', 'browserleaks', 'hash unique');
  const r1 = makeRun({ hits: [shared, mkHit('webgl', 'a', 'b')] });
  const r2 = makeRun({ hits: [] });
  const r3 = makeRun({ hits: [shared, mkHit('audio', 'c', 'd')] });
  const consensus = computeConsensus([r1, r2, r3]);
  assert.equal(consensus.score?.hits.length, 1);
  assert.equal(consensus.score?.weightedHits, SEVERITY_WEIGHT.medium);
});

test('structural disagreement (personaId mismatch) fails loud', () => {
  const r1 = makeRun({ personaId: 'a' });
  const r2 = makeRun({ personaId: 'b' }); // different persona — should bail
  const r3 = makeRun({ personaId: 'a' });
  // The script calls process.exit(2) via bail() — wrap with try/catch on
  // the process.exit override. Simpler: stub process.exit and assert it
  // was called with 2.
  const origExit = process.exit;
  let exitedWith: number | undefined;
  process.exit = ((code?: number) => {
    exitedWith = code ?? 0;
    throw new Error('PROCESS_EXIT_STUB');
  }) as typeof process.exit;
  try {
    assert.throws(() => computeConsensus([r1, r2, r3]), /PROCESS_EXIT_STUB/);
    assert.equal(exitedWith, 2, 'should exit with code 2 on structural mismatch');
  } finally {
    process.exit = origExit;
  }
});

test('pickWorstSeverity orders high > medium > low', () => {
  assert.equal(pickWorstSeverity(['low', 'medium', 'high']), 'high');
  assert.equal(pickWorstSeverity(['low', 'low']), 'low');
  assert.equal(pickWorstSeverity(['medium']), 'medium');
  assert.equal(pickWorstSeverity(['low', 'medium']), 'medium');
});

test('compareHitForSort orders by severity asc, then surface, site, detector', () => {
  const hits: SurfaceHit[] = [
    mkHit('webgl', 'z', 'z', 'low'),
    mkHit('canvas', 'a', 'a', 'high'),
    mkHit('canvas', 'a', 'b', 'high'),
    mkHit('canvas', 'b', 'a', 'high'),
  ];
  const sorted = [...hits].sort(compareHitForSort);
  // High severity first
  assert.equal(sorted[0]?.severity, 'high');
  assert.equal(sorted[1]?.severity, 'high');
  assert.equal(sorted[2]?.severity, 'high');
  assert.equal(sorted[3]?.severity, 'low');
  // Within high severity: same surface (canvas) sorted by site then detector
  assert.deepEqual(
    sorted.slice(0, 3).map((h) => `${h.site}/${h.detector}`),
    ['a/a', 'a/b', 'b/a'],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    pass += 1;
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}`);
    // eslint-disable-next-line no-console
    console.error(`    ${(err as Error).message}`);
    if (process.env.VERBOSE) {
      // eslint-disable-next-line no-console
      console.error((err as Error).stack);
    }
  }
}

// eslint-disable-next-line no-console
console.log(`\n${pass} passed, ${fail} failed (out of ${tests.length})`);
process.exit(fail > 0 ? 1 : 0);
