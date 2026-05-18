/**
 * runner-core.test — Phase 8.3a 纯壳行为验证。
 *
 * 重点：
 *   1. filterSites — only / skip 组合 + 顺序保留
 *   2. backoffMs — 指数退避调度
 *   3. executeRun happy path — 顺序 / 进度事件 / ctx 透传
 *   4. retry — 成功路径 / 耗尽路径 / site-retry 事件 / sleep 间隔
 *   5. abort — 站间中断 / backoff 期间中断 / 预触发中断
 *   6. 聚合 — sitesOk / sitesFail / totalRetries / sitesWithRetry / persona snapshot
 *
 * 全部 mock SiteWorker，不起 Playwright，不真睡。
 */

import { describe, expect, it } from 'vitest';

import {
  BACKOFF_BASE_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type ExecuteRunOptions,
  type PersonaSnapshot,
  type SiteWorker,
  backoffMs,
  executeRun,
  filterSites,
} from './runner-core.js';
import type { RunProgressEvent, SiteResult, SiteSpec } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function spec(id: string, overrides: Partial<SiteSpec> = {}): SiteSpec {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    settleMs: 0,
    ...overrides,
  };
}

function okResult(id: string, durationMs = 100): SiteResult {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    ok: true,
    durationMs,
  };
}

function failResult(id: string, error = 'boom', durationMs = 50): SiteResult {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    ok: false,
    error,
    durationMs,
  };
}

const PERSONA_SNAPSHOT: PersonaSnapshot = {
  id: 'persona-test',
  template: 'win11-chrome-us',
  browser: { name: 'chromium' },
  system: { os: 'win11' },
};

function defaultOpts(overrides: Partial<ExecuteRunOptions> = {}): ExecuteRunOptions {
  return {
    runId: 'run-1',
    personaId: 'persona-test' as ExecuteRunOptions['personaId'],
    personaSnapshot: PERSONA_SNAPSHOT,
    sleep: async () => {
      /* no-op for tests */
    },
    now: () => 0,
    isoTimestamp: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * 创建按 spec.id 顺序消费 behaviors[id] 的 mock worker。每次调用返回数组下一项；
 * 数组耗尽后 fallback 到最后一项（方便描述"无限失败"）。
 */
function mockWorker(behaviors: Record<string, SiteResult[]>): {
  worker: SiteWorker;
  calls: string[];
} {
  const counts: Record<string, number> = {};
  const calls: string[] = [];
  const worker: SiteWorker = async (s) => {
    calls.push(s.id);
    const seq = behaviors[s.id] ?? [];
    const i = counts[s.id] ?? 0;
    counts[s.id] = i + 1;
    const r = seq[Math.min(i, seq.length - 1)];
    if (!r) throw new Error(`mockWorker: no behavior for ${s.id}`);
    return r;
  };
  return { worker, calls };
}

function captureProgress(): {
  events: RunProgressEvent[];
  onProgress: (e: RunProgressEvent) => void;
} {
  const events: RunProgressEvent[] = [];
  return { events, onProgress: (e) => events.push(e) };
}

// ─────────────────────────────────────────────────────────────────────────────
// filterSites
// ─────────────────────────────────────────────────────────────────────────────

describe('filterSites', () => {
  const all = [spec('a'), spec('b'), spec('c')];

  it('returns full set when no filters', () => {
    expect(filterSites(all).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('applies only filter', () => {
    expect(filterSites(all, ['b', 'c']).map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('applies skip filter', () => {
    expect(filterSites(all, undefined, ['b']).map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('applies only then skip', () => {
    expect(filterSites(all, ['a', 'b'], ['a']).map((s) => s.id)).toEqual(['b']);
  });

  it('preserves source order regardless of only order', () => {
    expect(filterSites(all, ['c', 'a']).map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('returns empty when only matches no sites', () => {
    expect(filterSites(all, ['nope'])).toEqual([]);
  });

  it('treats empty arrays as "no filter"', () => {
    expect(filterSites(all, [], []).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backoffMs schedule
// ─────────────────────────────────────────────────────────────────────────────

describe('backoffMs', () => {
  it('returns 0 for first attempt (no backoff)', () => {
    expect(backoffMs(1)).toBe(0);
  });

  it('returns 1s / 2s / 4s / 8s exponential', () => {
    expect(backoffMs(2)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(3)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffMs(4)).toBe(BACKOFF_BASE_MS * 4);
    expect(backoffMs(5)).toBe(BACKOFF_BASE_MS * 8);
  });

  it('clamps non-positive attempts to 0', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(-1)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeRun — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('executeRun: happy path', () => {
  it('runs all sites in order and aggregates raw fields', async () => {
    const sites = [spec('a'), spec('b'), spec('c')];
    const { worker, calls } = mockWorker({
      a: [okResult('a', 100)],
      b: [okResult('b', 200)],
      c: [okResult('c', 300)],
    });
    const raw = await executeRun(sites, worker, defaultOpts());

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(raw.sitesAttempted).toBe(3);
    expect(raw.sitesOk).toBe(3);
    expect(raw.sitesFail).toBe(0);
    expect(raw.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(raw.totalRetries).toBe(0);
    expect(raw.sitesWithRetry).toBe(0);
    expect(raw.persona).toBe(PERSONA_SNAPSHOT);
    expect(raw.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('emits init → (site-start, site-end) pairs in order', async () => {
    const sites = [spec('a'), spec('b')];
    const { worker } = mockWorker({
      a: [okResult('a')],
      b: [okResult('b')],
    });
    const { events, onProgress } = captureProgress();
    await executeRun(sites, worker, defaultOpts({ onProgress }));

    expect(events.map((e) => e.phase)).toEqual([
      'init',
      'site-start',
      'site-end',
      'site-start',
      'site-end',
    ]);
    expect(events[0]?.totalSites).toBe(2);
    expect(events[1]?.siteIndex).toBe(0);
    expect(events[1]?.siteId).toBe('a');
    expect(events[2]?.siteOk).toBe(true);
    expect(events[2]?.siteDurationMs).toBe(100);
    expect(events[3]?.siteIndex).toBe(1);
    expect(events[3]?.siteId).toBe('b');
  });

  it('every progress event carries runId and personaId', async () => {
    const sites = [spec('a')];
    const { worker } = mockWorker({ a: [okResult('a')] });
    const { events, onProgress } = captureProgress();
    await executeRun(
      sites,
      worker,
      defaultOpts({
        runId: 'run-zzz',
        personaId: 'persona-other' as ExecuteRunOptions['personaId'],
        onProgress,
      }),
    );

    for (const e of events) {
      expect(e.runId).toBe('run-zzz');
      expect(e.personaId).toBe('persona-other');
    }
  });

  it('honors only filter', async () => {
    const sites = [spec('a'), spec('b'), spec('c')];
    const { worker, calls } = mockWorker({
      a: [okResult('a')],
      c: [okResult('c')],
    });
    const raw = await executeRun(sites, worker, defaultOpts({ only: ['a', 'c'] }));

    expect(calls).toEqual(['a', 'c']);
    expect(raw.sitesAttempted).toBe(2);
    expect(raw.results.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('honors skip filter', async () => {
    const sites = [spec('a'), spec('b'), spec('c')];
    const { worker, calls } = mockWorker({
      a: [okResult('a')],
      c: [okResult('c')],
    });
    const raw = await executeRun(sites, worker, defaultOpts({ skip: ['b'] }));

    expect(calls).toEqual(['a', 'c']);
    expect(raw.results.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('passes timeoutMs / artifactDir / signal to worker via ctx', async () => {
    const observed: {
      timeoutMs?: number;
      artifactDir?: string;
      hasSignal?: boolean;
    } = {};
    const sites = [spec('a')];
    const ac = new AbortController();
    const worker: SiteWorker = async (s, ctx) => {
      observed.timeoutMs = ctx.timeoutMs;
      observed.artifactDir = ctx.artifactDir;
      observed.hasSignal = ctx.signal === ac.signal;
      return okResult(s.id);
    };

    await executeRun(
      sites,
      worker,
      defaultOpts({
        timeoutMs: 12345,
        artifactDir: '/tmp/run-xyz',
        signal: ac.signal,
      }),
    );

    expect(observed.timeoutMs).toBe(12345);
    expect(observed.artifactDir).toBe('/tmp/run-xyz');
    expect(observed.hasSignal).toBe(true);
  });

  it('uses DEFAULT_TIMEOUT_MS when omitted', async () => {
    let observedTimeout: number | undefined;
    const worker: SiteWorker = async (s, ctx) => {
      observedTimeout = ctx.timeoutMs;
      return okResult(s.id);
    };
    await executeRun([spec('a')], worker, defaultOpts());
    expect(observedTimeout).toBe(DEFAULT_TIMEOUT_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeRun — retry behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('executeRun: retry', () => {
  it('retries on failure, succeeds on 2nd attempt; retries=1', async () => {
    const sites = [spec('a')];
    const { worker, calls } = mockWorker({
      a: [failResult('a', 'flaky'), okResult('a', 100)],
    });
    const sleeps: number[] = [];
    const raw = await executeRun(
      sites,
      worker,
      defaultOpts({
        maxRetries: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );

    expect(calls).toEqual(['a', 'a']);
    expect(raw.results[0]?.ok).toBe(true);
    expect(raw.results[0]?.retries).toBe(1);
    expect(raw.totalRetries).toBe(1);
    expect(raw.sitesWithRetry).toBe(1);
    expect(sleeps).toEqual([BACKOFF_BASE_MS]);
  });

  it('exhausts retries and returns last failure', async () => {
    const sites = [spec('a')];
    const { worker, calls } = mockWorker({
      a: [failResult('a', 'e1'), failResult('a', 'e2'), failResult('a', 'e3')],
    });
    const sleeps: number[] = [];
    const raw = await executeRun(
      sites,
      worker,
      defaultOpts({
        maxRetries: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );

    expect(calls).toEqual(['a', 'a', 'a']);
    expect(raw.results[0]?.ok).toBe(false);
    expect(raw.results[0]?.retries).toBe(2);
    expect(raw.results[0]?.error).toBe('e3');
    expect(raw.totalRetries).toBe(2);
    expect(sleeps).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2]);
  });

  it('emits site-retry events with retryAttempt 1-based', async () => {
    const sites = [spec('a')];
    const { worker } = mockWorker({
      a: [failResult('a', 'e1'), failResult('a', 'e2'), okResult('a')],
    });
    const { events, onProgress } = captureProgress();
    await executeRun(sites, worker, defaultOpts({ maxRetries: 2, onProgress }));

    expect(events.map((e) => e.phase)).toEqual([
      'init',
      'site-start',
      'site-retry',
      'site-retry',
      'site-end',
    ]);
    const retries = events.filter((e) => e.phase === 'site-retry');
    expect(retries[0]?.retryAttempt).toBe(1);
    expect(retries[1]?.retryAttempt).toBe(2);
    for (const r of retries) {
      expect(r.siteIndex).toBe(0);
      expect(r.siteId).toBe('a');
    }
  });

  it('maxRetries=0 → single attempt, no retry on failure', async () => {
    const sites = [spec('a')];
    const { worker, calls } = mockWorker({ a: [failResult('a', 'oops')] });
    const raw = await executeRun(sites, worker, defaultOpts({ maxRetries: 0 }));

    expect(calls).toEqual(['a']);
    expect(raw.results[0]?.retries).toBe(0);
    expect(raw.results[0]?.ok).toBe(false);
  });

  it('uses DEFAULT_MAX_RETRIES when omitted', async () => {
    expect(DEFAULT_MAX_RETRIES).toBe(2);
    const sites = [spec('a')];
    const { worker, calls } = mockWorker({
      a: [
        failResult('a', 'e1'),
        failResult('a', 'e2'),
        failResult('a', 'e3'),
        failResult('a', 'e4'),
      ],
    });
    await executeRun(sites, worker, defaultOpts());
    // default maxRetries=2 → maxAttempts=3
    expect(calls.length).toBe(3);
  });

  it('worker throwing is converted to ok:false SiteResult', async () => {
    const sites = [spec('a')];
    const worker: SiteWorker = async () => {
      throw new Error('worker exploded');
    };
    const raw = await executeRun(sites, worker, defaultOpts({ maxRetries: 0 }));

    expect(raw.results[0]?.ok).toBe(false);
    expect(raw.results[0]?.error).toBe('worker exploded');
    expect(raw.sitesFail).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeRun — abort behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('executeRun: abort', () => {
  it('marks remaining sites aborted when signal fires mid-run', async () => {
    const sites = [spec('a'), spec('b'), spec('c')];
    const ac = new AbortController();
    const worker: SiteWorker = async (s) => {
      if (s.id === 'b') ac.abort();
      return okResult(s.id);
    };
    const raw = await executeRun(sites, worker, defaultOpts({ signal: ac.signal }));

    expect(raw.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(raw.results[0]?.ok).toBe(true);
    expect(raw.results[1]?.ok).toBe(true);
    expect(raw.results[2]?.ok).toBe(false);
    expect(raw.results[2]?.error).toBe('aborted');
    expect(raw.sitesOk).toBe(2);
    expect(raw.sitesFail).toBe(1);
  });

  it('does not emit site-start / site-end for aborted skipped sites', async () => {
    const sites = [spec('a'), spec('b'), spec('c')];
    const ac = new AbortController();
    const worker: SiteWorker = async (s) => {
      if (s.id === 'a') ac.abort();
      return okResult(s.id);
    };
    const { events, onProgress } = captureProgress();
    await executeRun(sites, worker, defaultOpts({ signal: ac.signal, onProgress }));

    const startSites = events.filter((e) => e.phase === 'site-start').map((e) => e.siteId);
    const endSites = events.filter((e) => e.phase === 'site-end').map((e) => e.siteId);
    expect(startSites).toEqual(['a']);
    expect(endSites).toEqual(['a']);
  });

  it('stops retrying when signal fires during backoff', async () => {
    const sites = [spec('a')];
    const ac = new AbortController();
    const { worker, calls } = mockWorker({
      a: [failResult('a', 'e1'), failResult('a', 'e2'), failResult('a', 'e3')],
    });
    const raw = await executeRun(
      sites,
      worker,
      defaultOpts({
        signal: ac.signal,
        maxRetries: 5,
        sleep: async () => {
          // 第一次 backoff 期间触发 abort
          ac.abort();
        },
      }),
    );

    expect(calls.length).toBe(1); // 只有第一次 attempt 真正调用了 worker
    expect(raw.results[0]?.error).toBe('aborted');
    expect(raw.results[0]?.retries).toBe(1);
  });

  it('aborts everything upfront when signal pre-fired', async () => {
    const sites = [spec('a'), spec('b')];
    const ac = new AbortController();
    ac.abort();
    const { worker, calls } = mockWorker({
      a: [okResult('a')],
      b: [okResult('b')],
    });
    const raw = await executeRun(sites, worker, defaultOpts({ signal: ac.signal }));

    expect(calls).toEqual([]);
    expect(raw.results.every((r) => r.error === 'aborted')).toBe(true);
    expect(raw.sitesOk).toBe(0);
    expect(raw.sitesFail).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeRun — DI + aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe('executeRun: DI + aggregation', () => {
  it('uses injected now() to compute overallMs', async () => {
    let t = 1000;
    const now = () => {
      const v = t;
      t += 250;
      return v;
    };
    const sites = [spec('a'), spec('b')];
    const { worker } = mockWorker({
      a: [okResult('a')],
      b: [okResult('b')],
    });
    const raw = await executeRun(sites, worker, defaultOpts({ now }));

    // now() 调用 2 次（开始 + 结束），每次 +250ms → 差 250ms
    expect(raw.overallMs).toBe(250);
  });

  it('aggregates sitesOk / sitesFail / totalRetries / sitesWithRetry', async () => {
    const sites = [spec('a'), spec('b'), spec('c'), spec('d')];
    const { worker } = mockWorker({
      a: [okResult('a')],
      b: [failResult('b'), okResult('b')], // 1 retry, 成功
      c: [failResult('c'), failResult('c'), failResult('c')], // 2 retries, 失败
      d: [okResult('d')],
    });
    const raw = await executeRun(sites, worker, defaultOpts({ maxRetries: 2 }));

    expect(raw.sitesOk).toBe(3); // a, b, d
    expect(raw.sitesFail).toBe(1); // c
    expect(raw.totalRetries).toBe(3); // b:1 + c:2
    expect(raw.sitesWithRetry).toBe(2); // b, c
  });

  it('preserves persona snapshot reference in raw.persona', async () => {
    const snap: PersonaSnapshot = {
      id: 'macos-tester',
      template: 'macos-sonoma',
      browser: { name: 'chromium' },
      system: { os: 'macos' },
      hardware: { gpu: { webglRenderer: 'Apple M1' } },
    };
    const sites = [spec('a')];
    const { worker } = mockWorker({ a: [okResult('a')] });
    const raw = await executeRun(sites, worker, defaultOpts({ personaSnapshot: snap }));

    expect(raw.persona).toBe(snap);
    expect(raw.persona.hardware?.gpu?.webglRenderer).toBe('Apple M1');
  });

  it('emits init even when filter eliminates all sites', async () => {
    const sites = [spec('a')];
    const { worker } = mockWorker({});
    const { events, onProgress } = captureProgress();
    const raw = await executeRun(sites, worker, defaultOpts({ only: ['nonexistent'], onProgress }));

    expect(events).toHaveLength(1);
    expect(events[0]?.phase).toBe('init');
    expect(events[0]?.totalSites).toBe(0);
    expect(raw.results).toEqual([]);
    expect(raw.sitesAttempted).toBe(0);
  });
});
