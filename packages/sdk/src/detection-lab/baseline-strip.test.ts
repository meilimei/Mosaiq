import { describe, expect, it } from 'vitest';

import {
  BASELINE_CHROMIUM_VERSION,
  BASELINE_RUN_ID,
  BASELINE_TIMESTAMP,
  stripRunForBaseline,
} from './baseline-strip.js';
import type { DetectionRun, DetectionScore, HitsBySurface, SurfaceHit } from './types.js';
import { emptyHitsBySurface } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures — 与 run-compare.test.ts 同结构
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
    personaId: 'win11-chrome-us' as DetectionRun['personaId'],
    startedAt: '2026-05-19T12:00:00.000Z',
    finishedAt: '2026-05-19T12:01:23.000Z',
    status: 'completed',
    sitesAttempted: ['sannysoft', 'creepjs', 'browserleaks-canvas'],
    durationMs: 83000,
    score: makeScore(),
    error: null,
    meta: {
      sdkVersion: '0.10.0',
      chromiumVersion: '130.0.6723.117',
    },
    ...overrides,
  };
}

function makeRaw(
  results: Array<{
    id: string;
    ok: boolean;
    durationMs?: number;
    screenshot?: string;
    html?: string;
    retries?: number;
    bodyText?: string;
    title?: string;
    error?: string;
    extracted?: Record<string, unknown>;
  }>,
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
      id: meta.persona?.id ?? 'win11-chrome-us',
      template: meta.persona?.template ?? 'win11-chrome-us',
      browser: { userAgent: 'Mozilla/5.0' },
      system: { locale: 'en-US' },
      hardware: { gpu: { webglVendor: 'NVIDIA', webglRenderer: 'GeForce RTX 3070' } },
    },
    results: results.map((r) => ({
      id: r.id,
      name: r.id,
      url: `https://example.com/${r.id}`,
      ok: r.ok,
      durationMs: r.durationMs ?? 1234,
      ...(r.screenshot !== undefined ? { screenshot: r.screenshot } : {}),
      ...(r.html !== undefined ? { html: r.html } : {}),
      ...(r.retries !== undefined ? { retries: r.retries } : {}),
      ...(r.bodyText !== undefined ? { bodyText: r.bodyText } : {}),
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.extracted !== undefined ? { extracted: r.extracted } : {}),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level field projection
// ─────────────────────────────────────────────────────────────────────────────

describe('stripRunForBaseline — top-level fields', () => {
  it('replaces id with BASELINE_RUN_ID', () => {
    const out = stripRunForBaseline(makeRun({ id: 'real-runid-2026-05-19T12-00' }));
    expect(out.id).toBe(BASELINE_RUN_ID);
    expect(BASELINE_RUN_ID).toBe('baseline');
  });

  it('replaces startedAt with BASELINE_TIMESTAMP', () => {
    const out = stripRunForBaseline(makeRun({ startedAt: '2026-09-15T18:23:42.991Z' }));
    expect(out.startedAt).toBe(BASELINE_TIMESTAMP);
    expect(BASELINE_TIMESTAMP).toBe('1970-01-01T00:00:00.000Z');
  });

  it('replaces finishedAt with BASELINE_TIMESTAMP when it is a real ISO string', () => {
    const out = stripRunForBaseline(makeRun({ finishedAt: '2026-09-15T18:25:01.000Z' }));
    expect(out.finishedAt).toBe(BASELINE_TIMESTAMP);
  });

  it('preserves finishedAt = null (failed / running runs)', () => {
    const out = stripRunForBaseline(makeRun({ finishedAt: null, status: 'failed' }));
    expect(out.finishedAt).toBeNull();
  });

  it('zeros durationMs', () => {
    const out = stripRunForBaseline(makeRun({ durationMs: 87654 }));
    expect(out.durationMs).toBe(0);
  });

  it('preserves status verbatim', () => {
    const completed = stripRunForBaseline(makeRun({ status: 'completed' }));
    expect(completed.status).toBe('completed');
    const failed = stripRunForBaseline(makeRun({ status: 'failed', score: null }));
    expect(failed.status).toBe('failed');
    const canceled = stripRunForBaseline(makeRun({ status: 'canceled' }));
    expect(canceled.status).toBe('canceled');
  });

  it('preserves personaId verbatim', () => {
    const out = stripRunForBaseline(
      makeRun({ personaId: 'win11-chrome-us' as DetectionRun['personaId'] }),
    );
    expect(out.personaId).toBe('win11-chrome-us');
  });

  it('preserves sitesAttempted (run identity, not noise)', () => {
    const out = stripRunForBaseline(
      makeRun({ sitesAttempted: ['sannysoft', 'creepjs', 'amiunique'] }),
    );
    expect(out.sitesAttempted).toEqual(['sannysoft', 'creepjs', 'amiunique']);
  });

  it('preserves error verbatim (failure cause is a behavior signal, not noise)', () => {
    const out = stripRunForBaseline(
      makeRun({ status: 'failed', score: null, error: 'launch failed: timeout' }),
    );
    expect(out.error).toBe('launch failed: timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Score preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('stripRunForBaseline — score', () => {
  it('preserves score verbatim — hits, weightedHits, hitsBySurface, all metrics', () => {
    const score = makeScore({
      sitesOk: 11,
      sitesFail: 1,
      creepjsLies: 2,
      weightedHits: 4.5,
      hits: [makeHit({ severity: 'high' }), makeHit({ detector: 'fp-blob', severity: 'low' })],
    });
    const out = stripRunForBaseline(makeRun({ score }));
    expect(out.score).toEqual(score);
  });

  it('preserves score = null (failed / canceled run with no score)', () => {
    const out = stripRunForBaseline(makeRun({ status: 'failed', score: null, error: 'boom' }));
    expect(out.score).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Meta projection
// ─────────────────────────────────────────────────────────────────────────────

describe('stripRunForBaseline — meta', () => {
  it('preserves meta.sdkVersion (SDK upgrade is an intentional baseline change)', () => {
    const out = stripRunForBaseline(
      makeRun({ meta: { sdkVersion: '0.10.0', chromiumVersion: '130.0.6723.117' } }),
    );
    expect(out.meta.sdkVersion).toBe('0.10.0');
  });

  it('replaces meta.chromiumVersion with BASELINE_CHROMIUM_VERSION (host noise)', () => {
    const out = stripRunForBaseline(
      makeRun({ meta: { sdkVersion: '0.10.0', chromiumVersion: '141.0.7390.123' } }),
    );
    expect(out.meta.chromiumVersion).toBe(BASELINE_CHROMIUM_VERSION);
    expect(BASELINE_CHROMIUM_VERSION).toBe('baseline');
  });

  it('preserves meta.sdkVersion even when chromiumVersion is undefined on input', () => {
    const out = stripRunForBaseline(makeRun({ meta: { sdkVersion: '0.10.0' } }));
    expect(out.meta.sdkVersion).toBe('0.10.0');
    expect(out.meta.chromiumVersion).toBe(BASELINE_CHROMIUM_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Raw projection
// ─────────────────────────────────────────────────────────────────────────────

describe('stripRunForBaseline — raw', () => {
  it('preserves raw = undefined (failed runs may have no raw)', () => {
    const out = stripRunForBaseline(makeRun({ raw: undefined }));
    expect(out.raw).toBeUndefined();
  });

  it('replaces raw.timestamp with BASELINE_TIMESTAMP', () => {
    const out = stripRunForBaseline(
      makeRun({ raw: makeRaw([{ id: 'sannysoft', ok: true }], { timestamp: '2026-09-15T18:00:00.000Z' }) }),
    );
    expect(out.raw?.timestamp).toBe(BASELINE_TIMESTAMP);
  });

  it('zeros raw.overallMs', () => {
    const out = stripRunForBaseline(
      makeRun({ raw: makeRaw([{ id: 'sannysoft', ok: true }], { overallMs: 87654 }) }),
    );
    expect(out.raw?.overallMs).toBe(0);
  });

  it('preserves raw.persona snapshot verbatim (behavior signal, not noise)', () => {
    const persona = {
      id: 'win11-chrome-us',
      template: 'win11-chrome-us',
    };
    const out = stripRunForBaseline(
      makeRun({ raw: makeRaw([{ id: 'sannysoft', ok: true }], { persona }) }),
    );
    expect(out.raw?.persona.id).toBe('win11-chrome-us');
    expect(out.raw?.persona.template).toBe('win11-chrome-us');
    expect(out.raw?.persona.hardware?.gpu?.webglRenderer).toBe('GeForce RTX 3070');
  });

  it('preserves raw.sitesAttempted / sitesOk / sitesFail counts', () => {
    const out = stripRunForBaseline(
      makeRun({
        raw: makeRaw([
          { id: 'sannysoft', ok: true },
          { id: 'creepjs', ok: false },
          { id: 'amiunique', ok: true },
        ]),
      }),
    );
    expect(out.raw?.sitesAttempted).toBe(3);
    expect(out.raw?.sitesOk).toBe(2);
    expect(out.raw?.sitesFail).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SiteResult projection
// ─────────────────────────────────────────────────────────────────────────────

describe('stripRunForBaseline — site results', () => {
  it('preserves SiteResult identity (id, name, url, ok)', () => {
    const out = stripRunForBaseline(
      makeRun({
        raw: makeRaw([
          { id: 'sannysoft', ok: true },
          { id: 'creepjs', ok: false },
        ]),
      }),
    );
    expect(out.raw?.results).toHaveLength(2);
    expect(out.raw?.results[0]).toMatchObject({
      id: 'sannysoft',
      name: 'sannysoft',
      url: 'https://example.com/sannysoft',
      ok: true,
    });
    expect(out.raw?.results[1]).toMatchObject({
      id: 'creepjs',
      name: 'creepjs',
      ok: false,
    });
  });

  it('zeros SiteResult.durationMs (host-perf noise)', () => {
    const out = stripRunForBaseline(
      makeRun({ raw: makeRaw([{ id: 'sannysoft', ok: true, durationMs: 4321 }]) }),
    );
    expect(out.raw?.results[0]?.durationMs).toBe(0);
  });

  it('omits SiteResult.screenshot / html / retries / bodyText / title / error from output', () => {
    const out = stripRunForBaseline(
      makeRun({
        raw: makeRaw([
          {
            id: 'sannysoft',
            ok: true,
            screenshot: 'sannysoft.png',
            html: 'sannysoft.html',
            retries: 2,
            bodyText: '... long body ...',
            title: 'Sannysoft Bot Detection',
            error: 'transient timeout',
          },
        ]),
      }),
    );
    const r = out.raw?.results[0];
    expect(r).toBeDefined();
    expect(r).not.toHaveProperty('screenshot');
    expect(r).not.toHaveProperty('html');
    expect(r).not.toHaveProperty('retries');
    expect(r).not.toHaveProperty('bodyText');
    expect(r).not.toHaveProperty('title');
    expect(r).not.toHaveProperty('error');
  });

  it('preserves SiteResult.extracted (sannysoft pass/fail map etc — real behavior signal)', () => {
    const extracted = {
      tests: { webdriver: 'pass', plugins: 'pass', userAgent: 'pass' },
      total: 24,
      passed: 24,
    };
    const out = stripRunForBaseline(
      makeRun({ raw: makeRaw([{ id: 'sannysoft', ok: true, extracted }]) }),
    );
    expect(out.raw?.results[0]?.extracted).toEqual(extracted);
  });

  it('omits extracted when input had it undefined', () => {
    const out = stripRunForBaseline(
      makeRun({ raw: makeRaw([{ id: 'sannysoft', ok: true }]) }),
    );
    expect(out.raw?.results[0]).not.toHaveProperty('extracted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-mutation + idempotency invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('stripRunForBaseline — invariants', () => {
  it('does not mutate the input run', () => {
    const input = makeRun({
      id: 'original-id',
      durationMs: 5555,
      raw: makeRaw([{ id: 'sannysoft', ok: true, durationMs: 1234, screenshot: 'a.png' }]),
    });
    const snapshot = JSON.stringify(input);
    stripRunForBaseline(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('is idempotent — strip(strip(run)) === strip(run) byte-for-byte', () => {
    const input = makeRun({
      raw: makeRaw([
        { id: 'sannysoft', ok: true, screenshot: 's.png', html: 's.html' },
        { id: 'creepjs', ok: false, error: 'timeout' },
      ]),
    });
    const once = stripRunForBaseline(input);
    const twice = stripRunForBaseline(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('output is a structured-clone-safe POJO (JSON round-trip equal)', () => {
    const input = makeRun({
      raw: makeRaw([{ id: 'sannysoft', ok: true, extracted: { passed: 24 } }]),
    });
    const stripped = stripRunForBaseline(input);
    const roundTripped = JSON.parse(JSON.stringify(stripped));
    expect(roundTripped).toEqual(stripped);
  });

  it('produces a structurally identical strip for two runs that differ only in noise fields', () => {
    // 两个跑除 id / startedAt / finishedAt / durationMs / chromiumVersion /
    // raw.timestamp / raw.overallMs / 单站 durationMs / screenshot / html 不同外，
    // 行为一致 → strip 之后 byte-equal（diff 噪声为 0）
    const noisyA = makeRun({
      id: 'A',
      startedAt: '2026-05-19T12:00:00.000Z',
      finishedAt: '2026-05-19T12:01:00.000Z',
      durationMs: 60000,
      meta: { sdkVersion: '0.10.0', chromiumVersion: '141.0.7390.1' },
      raw: makeRaw(
        [{ id: 'sannysoft', ok: true, durationMs: 1111, screenshot: 'A.png', html: 'A.html' }],
        { timestamp: '2026-05-19T12:00:00.000Z', overallMs: 60000 },
      ),
    });
    const noisyB = makeRun({
      id: 'B',
      startedAt: '2027-01-02T03:04:05.678Z',
      finishedAt: '2027-01-02T03:05:08.910Z',
      durationMs: 63232,
      meta: { sdkVersion: '0.10.0', chromiumVersion: '142.0.0.0' },
      raw: makeRaw(
        [{ id: 'sannysoft', ok: true, durationMs: 9999, screenshot: 'B.png', html: 'B.html' }],
        { timestamp: '2027-01-02T03:04:05.678Z', overallMs: 63232 },
      ),
    });
    const stripA = stripRunForBaseline(noisyA);
    const stripB = stripRunForBaseline(noisyB);
    expect(JSON.stringify(stripB)).toBe(JSON.stringify(stripA));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip invariant: stripped run is still a valid input to diffRuns
// ─────────────────────────────────────────────────────────────────────────────

describe('stripRunForBaseline — diffRuns round-trip', () => {
  it('a stripped run vs itself yields no regression', async () => {
    const { diffRuns } = await import('./run-compare.js');
    const input = makeRun({
      score: makeScore({ hits: [makeHit()], weightedHits: 1.5 }),
      raw: makeRaw([{ id: 'sannysoft', ok: true }]),
    });
    const stripped = stripRunForBaseline(input);
    const diff = diffRuns('p', stripped, stripped);
    expect(diff.hasRegression).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('diff between stripped baseline and unstripped candidate detects new hits as regression', async () => {
    const { diffRuns } = await import('./run-compare.js');
    const baseline = stripRunForBaseline(
      makeRun({ score: makeScore(), raw: makeRaw([{ id: 'sannysoft', ok: true }]) }),
    );
    const candidate = makeRun({
      score: makeScore({
        hits: [makeHit({ surface: 'webdriver', site: 'sannysoft', detector: 'navigator.webdriver' })],
        weightedHits: 3.0,
      }),
      raw: makeRaw([{ id: 'sannysoft', ok: true }]),
    });
    const diff = diffRuns('p', baseline, candidate);
    expect(diff.hasRegression).toBe(true);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.detector).toBe('navigator.webdriver');
  });
});
