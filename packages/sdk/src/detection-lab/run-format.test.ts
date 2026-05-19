import { describe, expect, it } from 'vitest';

import { formatDetectionRunMarkdown } from './run-format.js';
import type { DetectionRun, DetectionScore, HitsBySurface, SurfaceHit } from './types.js';
import { emptyHitsBySurface } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('formatDetectionRunMarkdown — happy path', () => {
  it('renders a clean run with no hits', () => {
    const md = formatDetectionRunMarkdown(makeRun());
    expect(md).toContain('# Detection Run Report');
    expect(md).toContain('**Run ID:** `2026-05-19T12-00-00-000Z`');
    expect(md).toContain('**Persona:** `reddit-alice`');
    expect(md).toContain('**Status:** ✅ completed');
    expect(md).toContain('**Started at:** 2026-05-19T12:00:00.000Z');
    expect(md).toContain('**Finished at:** 2026-05-19T12:01:23.000Z');
    expect(md).toContain('**Duration:** 1m 23s');
    expect(md).toContain('## Summary');
    expect(md).toContain('| Sites attempted | 12 |');
    expect(md).toContain('| Sites OK | 12 |');
    expect(md).toContain('| Sites failed | 0 |');
    expect(md).toContain('| Total hits | 0 |');
    expect(md).toContain('| Weighted hits | 0.00 |');
    // Empty hits state
    expect(md).toContain('_No hits — all 12 surfaces clean._');
    // Footer
    expect(md).toContain('Mosaiq SDK 0.8.0');
  });

  it('renders environment line with SDK + chromium + template', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({
        raw: {
          timestamp: '2026-05-19T12:00:00.000Z',
          overallMs: 83000,
          sitesAttempted: 12,
          sitesOk: 12,
          sitesFail: 0,
          persona: { id: 'reddit-alice', template: 'win11-chrome-us', browser: {}, system: {} },
          results: [],
        },
      }),
    );
    expect(md).toContain(
      '**Environment:** SDK 0.8.0 · Chromium 130.0.6723.117 · template win11-chrome-us',
    );
  });

  it('omits chromium + template when missing', () => {
    const md = formatDetectionRunMarkdown(makeRun({ meta: { sdkVersion: '0.8.0' } }));
    expect(md).toContain('**Environment:** SDK 0.8.0');
    expect(md).not.toContain('Chromium');
    expect(md).not.toContain('template');
  });

  it('omits Environment line entirely when includeMeta=false', () => {
    const md = formatDetectionRunMarkdown(makeRun(), { includeMeta: false });
    expect(md).not.toContain('**Environment:**');
  });
});

describe('formatDetectionRunMarkdown — hit rendering', () => {
  it('groups hits by severity (high → medium → low)', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({
        score: makeScore({
          hits: [
            makeHit({
              severity: 'low',
              surface: 'audio',
              site: 'creepjs',
              detector: 'low-detector',
            }),
            makeHit({
              severity: 'high',
              surface: 'webgl',
              site: 'creepjs',
              detector: 'high-detector',
            }),
            makeHit({
              severity: 'medium',
              surface: 'canvas',
              site: 'browserleaks-canvas',
              detector: 'med-detector',
            }),
          ],
          hitsBySurface: { ...emptyHitsBySurface(), webgl: 1, canvas: 1, audio: 1 },
          weightedHits: 5.0,
        }),
      }),
    );
    expect(md).toContain('## Hits');
    const highIdx = md.indexOf('### high');
    const medIdx = md.indexOf('### medium');
    const lowIdx = md.indexOf('### low');
    expect(highIdx).toBeGreaterThan(0);
    expect(medIdx).toBeGreaterThan(highIdx);
    expect(lowIdx).toBeGreaterThan(medIdx);
    expect(md).toMatch(/### high \(1\)/);
    expect(md).toMatch(/### medium \(1\)/);
    expect(md).toMatch(/### low \(1\)/);
  });

  it('escapes markdown special chars in detector + evidence', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({
        score: makeScore({
          hits: [
            makeHit({
              detector: 'name *with* `markdown`',
              evidence: 'value | with pipe',
            }),
          ],
          hitsBySurface: { ...emptyHitsBySurface(), canvas: 1 },
        }),
      }),
    );
    // detector goes through escapeMd; * and ` are escaped
    expect(md).toContain('name \\*with\\* \\`markdown\\`');
    // evidence goes through escapeMdInline; pipe escaped
    expect(md).toContain('value \\| with pipe');
  });

  it('renders surface matrix when there are hits', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({
        score: makeScore({
          hits: [makeHit({ surface: 'webgl', severity: 'high' })],
          hitsBySurface: { ...emptyHitsBySurface(), webgl: 1 },
          weightedHits: 3.0,
        }),
      }),
    );
    expect(md).toContain('## Hits by surface');
    expect(md).toContain('| webgl | 1 | 0 | 0 | 1 |');
  });

  it('hides drill-down list when includeHits=false (matrix still rendered)', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({
        score: makeScore({
          hits: [makeHit({ surface: 'canvas', severity: 'medium' })],
          hitsBySurface: { ...emptyHitsBySurface(), canvas: 1 },
          weightedHits: 1.5,
        }),
      }),
      { includeHits: false },
    );
    // matrix lives in score section, kept
    expect(md).toContain('## Hits by surface');
    // drill-down list removed
    expect(md).not.toContain('### medium');
    expect(md).not.toContain('## Hits\n');
  });
});

describe('formatDetectionRunMarkdown — site details', () => {
  it('renders per-site grid when raw.results is present', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({
        raw: {
          timestamp: '2026-05-19T12:00:00.000Z',
          overallMs: 83000,
          sitesAttempted: 2,
          sitesOk: 1,
          sitesFail: 1,
          persona: { id: 'reddit-alice', template: 'win11-chrome-us', browser: {}, system: {} },
          results: [
            {
              id: 'sannysoft',
              name: 'sannysoft',
              url: 'https://bot.sannysoft.com/',
              ok: true,
              durationMs: 12300,
            },
            {
              id: 'creepjs',
              name: 'creepjs',
              url: 'https://abrahamjuliot.github.io/creepjs/',
              ok: false,
              durationMs: 8200,
              error: 'TimeoutError: page.goto: navigation timeout',
              retries: 2,
            },
          ],
        },
      }),
    );
    expect(md).toContain('## Per-site results');
    expect(md).toContain('| sannysoft | sannysoft | ✅ | 12.3s | 0 |  |');
    expect(md).toContain('| creepjs | creepjs | ❌ | 8.2s | 2 | TimeoutError');
  });

  it('omits per-site grid when includeSiteDetails=false', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({
        raw: {
          timestamp: '2026-05-19T12:00:00.000Z',
          overallMs: 83000,
          sitesAttempted: 1,
          sitesOk: 1,
          sitesFail: 0,
          persona: { id: 'reddit-alice', template: 'win11-chrome-us', browser: {}, system: {} },
          results: [{ id: 'sannysoft', name: 'sannysoft', url: 'x', ok: true, durationMs: 1000 }],
        },
      }),
      { includeSiteDetails: false },
    );
    expect(md).not.toContain('## Per-site results');
  });

  it('omits per-site grid when raw is missing (failed runs)', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({ raw: undefined, score: null, status: 'failed', error: 'boom' }),
    );
    expect(md).not.toContain('## Per-site results');
  });
});

describe('formatDetectionRunMarkdown — failed / canceled runs', () => {
  it('renders error block when run.error is set', () => {
    const md = formatDetectionRunMarkdown(
      makeRun({
        status: 'failed',
        score: null,
        error: 'launchPersona failed: ENOENT',
      }),
    );
    expect(md).toContain('**Status:** ❌ failed');
    expect(md).toContain('## Error\n\n```\nlaunchPersona failed: ENOENT\n```');
    expect(md).toContain('_No score available (run did not complete)._');
  });

  it('uses the canceled badge', () => {
    const md = formatDetectionRunMarkdown(makeRun({ status: 'canceled', score: null }));
    expect(md).toContain('**Status:** ⚠️ canceled');
  });
});

describe('formatDetectionRunMarkdown — heading level offset', () => {
  it('uses # at level 1 (default)', () => {
    const md = formatDetectionRunMarkdown(makeRun());
    expect(md).toMatch(/^# Detection Run Report/);
    expect(md).toContain('## Summary');
  });

  it('uses ## at level 2 (embedded into a larger doc)', () => {
    const md = formatDetectionRunMarkdown(makeRun(), { headingLevel: 2 });
    expect(md).toMatch(/^## Detection Run Report/);
    expect(md).toContain('### Summary');
  });

  it('uses ### at level 3', () => {
    const md = formatDetectionRunMarkdown(makeRun(), { headingLevel: 3 });
    expect(md).toMatch(/^### Detection Run Report/);
    expect(md).toContain('#### Summary');
  });
});

describe('formatDetectionRunMarkdown — duration formatting', () => {
  it('renders milliseconds for < 1s', () => {
    expect(formatDetectionRunMarkdown(makeRun({ durationMs: 350 }))).toContain(
      '**Duration:** 350ms',
    );
  });

  it('renders seconds with one decimal for 1s..60s', () => {
    expect(formatDetectionRunMarkdown(makeRun({ durationMs: 12300 }))).toContain(
      '**Duration:** 12.3s',
    );
  });

  it('renders Xm Ys for >= 1min', () => {
    expect(formatDetectionRunMarkdown(makeRun({ durationMs: 83000 }))).toContain(
      '**Duration:** 1m 23s',
    );
  });

  it('renders ? for negative / NaN', () => {
    expect(formatDetectionRunMarkdown(makeRun({ durationMs: -1 }))).toContain('**Duration:** ?');
  });
});
