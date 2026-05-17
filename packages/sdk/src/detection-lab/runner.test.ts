/**
 * runner.test — Phase 8.3b 公共 API 行为验证。
 *
 * 重点（不起 Playwright，全 DI）：
 *   1. snapshotPersona — 形状 / template default / 子对象保留
 *   2. runDetection 编排 — runId 生成 / artifactDir mkdir / 终态事件
 *   3. error 路径 — launchPersona 抛 → emit error + rethrow
 *   4. canceled 路径 — signal.aborted → emit canceled（不抛）
 *   5. happy path — emit done + score 出来
 *
 * 真 Playwright 集成由 `bench/baseline-detection.ts` 手工跑覆盖（doc §4.4）。
 */

import { describe, expect, it } from 'vitest';

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import type { Page } from 'playwright-core';

import type { BrowserSession } from '../browser-session.js';
import {
  runDetection,
  snapshotPersona,
  type RunDetectionDeps,
} from './runner.js';
import type { SiteWorkerContext } from './runner-core.js';
import type { RunProgressEvent, SiteResult, SiteSpec } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePersona() {
  return createWin11ChromeUsPersona({
    id: 'runner-test',
    displayName: 'Runner Test',
  });
}

function fakePage(): Page {
  // 仅 used as opaque pointer — 默认 worker 已被 DI 替换，永远不会真调 Page 方法。
  return {} as unknown as Page;
}

function fakeSession(): BrowserSession {
  let closed = false;
  return {
    persona: makePersona(),
    context: {} as never,
    firstPage: async () => fakePage(),
    open: async () => fakePage(),
    humanize: async () => {
      throw new Error('not used');
    },
    close: async () => {
      closed = true;
    },
    get closed() {
      return closed;
    },
  } as unknown as BrowserSession;
}

function captureProgress(): {
  events: RunProgressEvent[];
  onProgress: (e: RunProgressEvent) => void;
} {
  const events: RunProgressEvent[] = [];
  return { events, onProgress: (e) => events.push(e) };
}

/** 默认 mock deps — launch 返回 fakeSession，runOnePage 永远 ok。 */
function defaultDeps(
  overrides: Partial<RunDetectionDeps> = {},
): RunDetectionDeps {
  return {
    launch: async () => fakeSession(),
    runOnePage: async (_page, spec) => ({
      id: spec.id,
      name: spec.name,
      url: spec.url,
      ok: true,
      durationMs: 50,
    }),
    mkdir: () => {
      /* no-op */
    },
    isoTimestamp: () => '2026-01-01T00:00:00.000Z',
    executeRunDeps: {
      sleep: async () => {
        /* no-op */
      },
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// snapshotPersona
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshotPersona', () => {
  it('builds DetectionRunRaw.persona shape', () => {
    const p = makePersona();
    const snap = snapshotPersona(p, 'win11-chrome-us');

    expect(snap.id).toBe(p.metadata.id);
    expect(snap.template).toBe('win11-chrome-us');
    expect(snap.browser).toBe(p.browser);
    expect(snap.system).toBe(p.system);
    expect(snap.hardware).toBe(p.hardware);
    expect(snap.fingerprint).toBe(p.fingerprint);
  });

  it('defaults template to "unknown" when omitted', () => {
    const snap = snapshotPersona(makePersona());
    expect(snap.template).toBe('unknown');
  });

  it('preserves nested gpu fields for scorer cross-check', () => {
    const p = makePersona();
    const snap = snapshotPersona(p);
    // scorer 用 persona.hardware?.gpu?.webglRenderer 走 cross-check
    expect((snap.hardware as typeof p.hardware).gpu.webglRenderer).toBe(
      p.hardware.gpu.webglRenderer,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDetection — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('runDetection: happy path', () => {
  it('returns { raw, score, runId } and emits done', async () => {
    const persona = makePersona();
    const { events, onProgress } = captureProgress();
    const deps = defaultDeps();
    const result = await runDetection(
      persona,
      { only: ['sannysoft'], onProgress, runId: 'fixed-run' },
      deps,
    );

    expect(result.runId).toBe('fixed-run');
    expect(result.raw.results).toHaveLength(1);
    expect(result.raw.results[0]?.id).toBe('sannysoft');
    expect(result.raw.results[0]?.ok).toBe(true);
    expect(result.score).toBeDefined();
    expect(result.score.weightedHits).toBeGreaterThanOrEqual(0);

    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe('init');
    expect(phases[phases.length - 1]).toBe('done');
    expect(phases).toContain('site-start');
    expect(phases).toContain('site-end');
  });

  it('generates ISO-like runId when omitted', async () => {
    const result = await runDetection(
      makePersona(),
      { only: ['sannysoft'] },
      defaultDeps(),
    );
    // runId 形如 "2026-01-01T00:00:00.000Z" → replace `:`/`.` 后是 "2026-01-01T00-00-00-000Z"
    expect(result.runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it('writes raw.persona snapshot with personaTemplate', async () => {
    const result = await runDetection(
      makePersona(),
      { only: ['sannysoft'], personaTemplate: 'win11-chrome-us' },
      defaultDeps(),
    );
    expect(result.raw.persona.template).toBe('win11-chrome-us');
    expect(result.raw.persona.id).toBe('runner-test');
  });

  it('mkdir(artifactDir) called when artifactDir provided', async () => {
    const mkdirCalls: string[] = [];
    await runDetection(
      makePersona(),
      { only: ['sannysoft'], artifactDir: '/tmp/runner-test' },
      defaultDeps({ mkdir: (d) => mkdirCalls.push(d) }),
    );
    expect(mkdirCalls).toEqual(['/tmp/runner-test']);
  });

  it('mkdir not called when artifactDir omitted', async () => {
    let mkdirCalls = 0;
    await runDetection(
      makePersona(),
      { only: ['sannysoft'] },
      defaultDeps({ mkdir: () => mkdirCalls++ }),
    );
    expect(mkdirCalls).toBe(0);
  });

  it('forwards artifactDir to worker via ctx', async () => {
    let observedDir: string | undefined;
    await runDetection(
      makePersona(),
      { only: ['sannysoft'], artifactDir: '/tmp/abc' },
      defaultDeps({
        runOnePage: async (_page, spec, ctx: SiteWorkerContext) => {
          observedDir = ctx.artifactDir;
          return {
            id: spec.id,
            name: spec.name,
            url: spec.url,
            ok: true,
            durationMs: 1,
          };
        },
      }),
    );
    expect(observedDir).toBe('/tmp/abc');
  });

  it('closes session in finally (after happy run)', async () => {
    let closeCalls = 0;
    const session = {
      persona: makePersona(),
      context: {} as never,
      firstPage: async () => fakePage(),
      open: async () => fakePage(),
      humanize: async () => {
        throw new Error('not used');
      },
      close: async () => {
        closeCalls++;
      },
      get closed() {
        return false;
      },
    } as unknown as BrowserSession;

    await runDetection(
      makePersona(),
      { only: ['sannysoft'] },
      defaultDeps({ launch: async () => session }),
    );
    expect(closeCalls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDetection — error path
// ─────────────────────────────────────────────────────────────────────────────

describe('runDetection: error', () => {
  it('emits error + rethrows when launchPersona throws', async () => {
    const { events, onProgress } = captureProgress();
    await expect(
      runDetection(
        makePersona(),
        { only: ['sannysoft'], onProgress },
        defaultDeps({
          launch: async () => {
            throw new Error('chromium not found');
          },
        }),
      ),
    ).rejects.toThrow('chromium not found');

    const errorEvt = events.find((e) => e.phase === 'error');
    expect(errorEvt).toBeDefined();
    expect(errorEvt?.error).toBe('chromium not found');
  });

  it('emits error + rethrows when firstPage throws', async () => {
    const { events, onProgress } = captureProgress();
    const badSession = {
      persona: makePersona(),
      context: {} as never,
      firstPage: async () => {
        throw new Error('no page');
      },
      open: async () => fakePage(),
      humanize: async () => {
        throw new Error('not used');
      },
      close: async () => {
        /* no-op */
      },
      get closed() {
        return false;
      },
    } as unknown as BrowserSession;

    await expect(
      runDetection(
        makePersona(),
        { only: ['sannysoft'], onProgress },
        defaultDeps({ launch: async () => badSession }),
      ),
    ).rejects.toThrow('no page');

    expect(events.find((e) => e.phase === 'error')?.error).toBe('no page');
  });

  it('still closes session when firstPage throws', async () => {
    let closed = false;
    const badSession = {
      persona: makePersona(),
      context: {} as never,
      firstPage: async () => {
        throw new Error('boom');
      },
      open: async () => fakePage(),
      humanize: async () => {
        throw new Error('not used');
      },
      close: async () => {
        closed = true;
      },
      get closed() {
        return false;
      },
    } as unknown as BrowserSession;

    await expect(
      runDetection(
        makePersona(),
        { only: ['sannysoft'] },
        defaultDeps({ launch: async () => badSession }),
      ),
    ).rejects.toThrow('boom');
    expect(closed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDetection — canceled path
// ─────────────────────────────────────────────────────────────────────────────

describe('runDetection: canceled', () => {
  it('emits canceled (not done) when signal aborted', async () => {
    const ac = new AbortController();
    const { events, onProgress } = captureProgress();

    // worker 第一次跑就 abort
    const deps = defaultDeps({
      runOnePage: async (_page, spec) => {
        ac.abort();
        return {
          id: spec.id,
          name: spec.name,
          url: spec.url,
          ok: true,
          durationMs: 1,
        };
      },
    });

    const result = await runDetection(
      makePersona(),
      { only: ['sannysoft', 'creepjs'], signal: ac.signal, onProgress },
      deps,
    );

    const phases = events.map((e) => e.phase);
    expect(phases[phases.length - 1]).toBe('canceled');
    expect(phases).not.toContain('done');
    // 第二个站应该被标 aborted
    expect(result.raw.results[1]?.error).toBe('aborted');
  });

  it('does not throw on canceled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runDetection(
        makePersona(),
        { only: ['sannysoft'], signal: ac.signal },
        defaultDeps(),
      ),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDetection — only / skip passthrough（spot check；executeRun 已覆盖）
// ─────────────────────────────────────────────────────────────────────────────

describe('runDetection: filter passthrough', () => {
  it('only filter restricts which sites worker sees', async () => {
    const seen: string[] = [];
    await runDetection(
      makePersona(),
      { only: ['sannysoft', 'creepjs'] },
      defaultDeps({
        runOnePage: async (_p, spec: SiteSpec) => {
          seen.push(spec.id);
          return {
            id: spec.id,
            name: spec.name,
            url: spec.url,
            ok: true,
            durationMs: 1,
          } as SiteResult;
        },
      }),
    );
    expect(seen).toEqual(['sannysoft', 'creepjs']);
  });
});
