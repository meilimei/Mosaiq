import { describe, expect, it } from 'vitest';

import { buildLeaderboard, type LeaderboardEntry, renderLeaderboardHtml } from './leaderboard.js';
import type { DetectionRun, DetectionScore, HitsBySurface } from './types.js';
import { emptyHitsBySurface } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
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

function makeRun(overrides: Partial<DetectionRun> = {}): DetectionRun {
  return {
    id: 'baseline',
    personaId: 'win11-chrome-us' as DetectionRun['personaId'],
    startedAt: '1970-01-01T00:00:00.000Z',
    finishedAt: '1970-01-01T00:00:00.000Z',
    status: 'completed',
    sitesAttempted: [],
    durationMs: 0,
    score: makeScore(),
    error: null,
    meta: { sdkVersion: '0.11.0', chromiumVersion: '130.0.6723.117' },
    ...overrides,
  };
}

function entry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    engine: 'Mosaiq',
    personaLabel: 'Windows 11 · Chrome 130 (US)',
    run: makeRun(),
    ...overrides,
  };
}

const NOW = '2026-05-29T12:00:00.000Z';

// ─────────────────────────────────────────────────────────────────────────────
// buildLeaderboard
// ─────────────────────────────────────────────────────────────────────────────

describe('buildLeaderboard — ranking', () => {
  it('ranks by weightedHits ascending (lower = better), then sitesFail, then label', () => {
    const model = buildLeaderboard(
      [
        entry({
          personaLabel: 'B-high-hits',
          run: makeRun({
            personaId: 'b' as DetectionRun['personaId'],
            score: makeScore({ weightedHits: 5 }),
          }),
        }),
        entry({
          personaLabel: 'A-clean',
          run: makeRun({
            personaId: 'a' as DetectionRun['personaId'],
            score: makeScore({ weightedHits: 0 }),
          }),
        }),
        entry({
          personaLabel: 'C-tie-more-fails',
          run: makeRun({
            personaId: 'c' as DetectionRun['personaId'],
            score: makeScore({ weightedHits: 5, sitesFail: 3, sitesOk: 9 }),
          }),
        }),
      ],
      { nowIso: NOW },
    );

    expect(model.rows.map((r) => r.personaLabel)).toEqual([
      'A-clean', // weightedHits 0
      'B-high-hits', // weightedHits 5, fewer fails
      'C-tie-more-fails', // weightedHits 5, more fails
    ]);
    expect(model.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('breaks weightedHits+sitesFail ties by personaLabel localeCompare', () => {
    const model = buildLeaderboard(
      [
        entry({
          personaLabel: 'Zeta',
          run: makeRun({ personaId: 'z' as DetectionRun['personaId'] }),
        }),
        entry({
          personaLabel: 'Alpha',
          run: makeRun({ personaId: 'a' as DetectionRun['personaId'] }),
        }),
      ],
      { nowIso: NOW },
    );
    expect(model.rows.map((r) => r.personaLabel)).toEqual(['Alpha', 'Zeta']);
  });

  it('sinks score-less runs (failed/canceled) to the bottom regardless of zeros', () => {
    const model = buildLeaderboard(
      [
        entry({
          personaLabel: 'failed',
          run: makeRun({
            personaId: 'f' as DetectionRun['personaId'],
            status: 'failed',
            score: null,
            error: 'boom',
          }),
        }),
        entry({
          personaLabel: 'ok',
          run: makeRun({
            personaId: 'o' as DetectionRun['personaId'],
            score: makeScore({ weightedHits: 9 }),
          }),
        }),
      ],
      { nowIso: NOW },
    );
    expect(model.rows.map((r) => r.personaLabel)).toEqual(['ok', 'failed']);
    expect(model.rows[1].hasScore).toBe(false);
    // score-less row defaults to an all-zero surface map, not a crash
    expect(model.rows[1].hitsBySurface.canvas).toBe(0);
  });

  it('counts distinct engines and personas', () => {
    const model = buildLeaderboard(
      [
        entry({
          engine: 'Mosaiq',
          run: makeRun({ personaId: 'win11' as DetectionRun['personaId'] }),
        }),
        entry({
          engine: 'Mosaiq',
          run: makeRun({ personaId: 'win10' as DetectionRun['personaId'] }),
        }),
        entry({
          engine: 'Competitor X',
          run: makeRun({ personaId: 'win11' as DetectionRun['personaId'] }),
        }),
      ],
      { nowIso: NOW },
    );
    expect(model.totalEngines).toBe(2);
    expect(model.totalPersonas).toBe(2);
  });

  it('picks first non-empty sdkVersion and ignores the "baseline" chromium placeholder', () => {
    const model = buildLeaderboard(
      [
        entry({ run: makeRun({ meta: { sdkVersion: '', chromiumVersion: 'baseline' } }) }),
        entry({ run: makeRun({ meta: { sdkVersion: '0.11.0', chromiumVersion: 'baseline' } }) }),
        entry({ run: makeRun({ meta: { sdkVersion: '0.12.0', chromiumVersion: '131.0.1' } }) }),
      ],
      { nowIso: NOW },
    );
    expect(model.sdkVersion).toBe('0.11.0');
    expect(model.chromiumVersion).toBe('131.0.1');
  });

  it('defaults generatedAt to now when nowIso not given', () => {
    const before = Date.now();
    const model = buildLeaderboard([entry()]);
    const ts = Date.parse(model.generatedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderLeaderboardHtml
// ─────────────────────────────────────────────────────────────────────────────

describe('renderLeaderboardHtml', () => {
  it('renders a self-contained HTML doc with ranking + surface matrix', () => {
    const model = buildLeaderboard(
      [
        entry({
          personaLabel: 'Windows 11 · Chrome 130 (US)',
          run: makeRun({
            personaId: 'win11-chrome-us' as DetectionRun['personaId'],
            score: makeScore({
              weightedHits: 1.5,
              creepjsLies: 2,
              hitsBySurface: { ...emptyHitsBySurface(), canvas: 1 },
            }),
          }),
        }),
      ],
      { nowIso: NOW },
    );
    const html = renderLeaderboardHtml(model);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Mosaiq Detection Lab Leaderboard</title>');
    expect(html).toContain('<style>'); // inline CSS, no external deps
    expect(html).not.toContain('<script'); // no JS
    expect(html).toContain(`Generated ${NOW}`);
    expect(html).toContain('SDK 0.11.0');
    expect(html).toContain('<h2>Ranking</h2>');
    expect(html).toContain('<h2>Hits by surface</h2>');
    expect(html).toContain('Windows 11 · Chrome 130 (US)');
    expect(html).toContain('win11-chrome-us');
    expect(html).toContain('1.5'); // fractional weightedHits formatted
    // a non-zero surface cell gets the "hit" class
    expect(html).toContain('class="num hit"');
  });

  it('escapes HTML in engine / persona labels (no injection)', () => {
    const model = buildLeaderboard(
      [entry({ engine: '<script>x</script>', personaLabel: 'a&b "c"' })],
      { nowIso: NOW },
    );
    const html = renderLeaderboardHtml(model);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a&amp;b &quot;c&quot;');
  });

  it('renders score-less rows as em dashes', () => {
    const model = buildLeaderboard(
      [
        entry({
          personaLabel: 'broken',
          run: makeRun({ status: 'failed', score: null, error: 'x' }),
        }),
      ],
      { nowIso: NOW },
    );
    const html = renderLeaderboardHtml(model);
    expect(html).toContain('class="no-score"');
    expect(html).toContain('—');
  });

  it('renders an empty-state message when there are no entries', () => {
    const model = buildLeaderboard([], { nowIso: NOW });
    const html = renderLeaderboardHtml(model);
    expect(html).toContain('No runs yet');
    expect(html).not.toContain('<table');
  });

  it('honors a custom title', () => {
    const model = buildLeaderboard([entry()], { nowIso: NOW });
    const html = renderLeaderboardHtml(model, { title: 'Custom Board' });
    expect(html).toContain('<title>Custom Board</title>');
    expect(html).toContain('<h1>Custom Board</h1>');
  });
});
