/**
 * scorer.test — 覆盖 detection-lab/scorer.ts 的纯计算路径。
 *
 * 重点：
 *   1. severity 权重公约（high*3 / medium*1.5 / low*0.5）— 与 types.ts:166 一致
 *   2. 12 个站点 scorer 的归因 + metric 提取
 *   3. KNOWN_OUTDATED_FPSCANNER_RULES（WEBDRIVER）跳过逻辑
 *   4. computeScore 主入口：metrics 合并 / weightedHits 累加 / hitsBySurface 计数
 */

import { describe, expect, it } from 'vitest';

import {
  KNOWN_OUTDATED_FPSCANNER_RULES,
  SEVERITY_WEIGHT,
  attributeSurface,
  computeScore,
  normalizeWebglString,
  parseUniquenessPct,
  scoreAmIUnique,
  scoreAntoinevastel,
  scoreBrowserleaksCanvas,
  scoreBrowserleaksGeneric,
  scoreBrowserleaksWebgl,
  scoreCreepjs,
  scoreDbiBot,
  scoreFingerprintScan,
  scoreIncolumitas,
  scoreIphey,
  scorePixelscan,
  scoreSannysoft,
  weightHit,
  weightedHitsSum,
} from './scorer.js';
import type { DetectionRunRaw, SiteResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSiteResult(
  id: string,
  extracted: Record<string, unknown>,
  opts: { ok?: boolean; name?: string } = {},
): SiteResult {
  return {
    id,
    name: opts.name ?? id,
    url: `https://${id}.example.com`,
    ok: opts.ok ?? true,
    durationMs: 100,
    extracted,
  };
}

function makeRaw(
  results: SiteResult[],
  personaOverrides: Partial<DetectionRunRaw['persona']> = {},
): DetectionRunRaw {
  return {
    timestamp: '2026-05-17T00:00:00Z',
    overallMs: results.reduce((s, r) => s + r.durationMs, 0),
    sitesAttempted: results.length,
    sitesOk: results.filter((r) => r.ok).length,
    sitesFail: results.filter((r) => !r.ok).length,
    persona: {
      id: 'test-persona',
      template: 'reddit-alice',
      browser: {},
      system: {},
      hardware: { gpu: { webglVendor: 'Intel Inc.', webglRenderer: 'Intel Iris Plus' } },
      ...personaOverrides,
    },
    results,
  };
}

const NO_PERSONA_GPU: DetectionRunRaw['persona'] = {
  id: 'test',
  template: 't',
  browser: {},
  system: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// 公约 / 权重
// ─────────────────────────────────────────────────────────────────────────────

describe('SEVERITY_WEIGHT 公约', () => {
  it('与 types.ts:166 公约一致：high*3 / medium*1.5 / low*0.5', () => {
    expect(SEVERITY_WEIGHT.high).toBe(3);
    expect(SEVERITY_WEIGHT.medium).toBe(1.5);
    expect(SEVERITY_WEIGHT.low).toBe(0.5);
  });

  it('weightHit 返回对应权重', () => {
    expect(weightHit('high')).toBe(3);
    expect(weightHit('medium')).toBe(1.5);
    expect(weightHit('low')).toBe(0.5);
  });

  it('weightedHitsSum 对空数组返回 0', () => {
    expect(weightedHitsSum([])).toBe(0);
  });

  it('weightedHitsSum 累加正确：2 high + 1 medium + 1 low = 8.0', () => {
    const sum = weightedHitsSum([
      { surface: 'canvas', site: 's', detector: 'd', evidence: 'e', severity: 'high' },
      { surface: 'webgl', site: 's', detector: 'd', evidence: 'e', severity: 'high' },
      { surface: 'audio', site: 's', detector: 'd', evidence: 'e', severity: 'medium' },
      { surface: 'font', site: 's', detector: 'd', evidence: 'e', severity: 'low' },
    ]);
    expect(sum).toBe(3 + 3 + 1.5 + 0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 字符串 helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('attributeSurface', () => {
  it('webdriver 关键词归因到 webdriver surface + high', () => {
    expect(attributeSurface('navigator.webdriver', 'true')).toEqual({
      surface: 'webdriver',
      severity: 'high',
    });
  });

  it('canvas hash 文本归因到 canvas + high', () => {
    expect(attributeSurface('canvas hash mismatch', 'unique signature')).toEqual({
      surface: 'canvas',
      severity: 'high',
    });
  });

  it('unmasked vendor 归因到 webgl + high', () => {
    expect(attributeSurface('unmasked vendor', 'NVIDIA')).toEqual({
      surface: 'webgl',
      severity: 'high',
    });
  });

  it('未知文本 fallback 到 other + low', () => {
    expect(attributeSurface('totally', 'unknown garbage')).toEqual({
      surface: 'other',
      severity: 'low',
    });
  });
});

describe('normalizeWebglString', () => {
  it('小写 + trim + 多空格折叠', () => {
    expect(normalizeWebglString('  NVIDIA   Corporation  ')).toBe('nvidia corporation');
  });
  it('undefined → 空串', () => {
    expect(normalizeWebglString(undefined)).toBe('');
  });
});

describe('parseUniquenessPct', () => {
  it('解析 "0.01% (1 in 12000)" → 0.01', () => {
    expect(parseUniquenessPct('0.01% (1 in 12000)')).toBe(0.01);
  });
  it('解析 "75.3%" → 75.3', () => {
    expect(parseUniquenessPct('75.3%')).toBe(75.3);
  });
  it('无 % → null', () => {
    expect(parseUniquenessPct('no percent here')).toBeNull();
  });
  it('undefined → null', () => {
    expect(parseUniquenessPct(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12 个站点 scorer
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreSannysoft', () => {
  it('passes/total metric 提取 + 失败行入 hits', () => {
    const partial = scoreSannysoft({
      passes: 2,
      total: 3,
      rows: [
        { name: 'WebDriver advanced', result: 'failed', status: 'fail' },
        { name: 'Chrome (New)', result: 'present', status: 'pass' },
        { name: 'Plugins length', result: '0', status: 'pass' },
      ],
    });
    expect(partial.metrics.sannysoftPass).toBe(2);
    expect(partial.metrics.sannysoftTotal).toBe(3);
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.surface).toBe('webdriver');
    expect(partial.hits[0]?.severity).toBe('high');
  });

  it('全 pass 时不入 hits', () => {
    const partial = scoreSannysoft({
      passes: 1,
      total: 1,
      rows: [{ name: 'X', result: 'ok', status: 'pass' }],
    });
    expect(partial.hits).toHaveLength(0);
  });
});

describe('scoreCreepjs', () => {
  it('liesSurfaces 转 hits；bold-fail 强制为 high', () => {
    const partial = scoreCreepjs({
      liesCount: 2,
      boldFailCount: 1,
      liesSurfaces: [
        { surface: 'canvas hash', severity: 'lies', hash: 'abc' },
        { surface: 'webgl unmasked', severity: 'bold-fail', hash: 'def' },
      ],
    });
    expect(partial.metrics.creepjsLies).toBe(2);
    expect(partial.metrics.creepjsBoldFail).toBe(1);
    expect(partial.hits).toHaveLength(2);
    const boldFailHit = partial.hits.find((h) => h.evidence.includes('def'));
    expect(boldFailHit?.severity).toBe('high');
  });

  it('空 liesSurfaces 不 hit', () => {
    const partial = scoreCreepjs({ liesCount: 0, boldFailCount: 0, liesSurfaces: [] });
    expect(partial.hits).toHaveLength(0);
    expect(partial.metrics.creepjsLies).toBe(0);
  });

  it('WebGL bold-fail + liesCount=0 → low（CreepJS GPU 白名单数据缺口，非伪装失败）', () => {
    const partial = scoreCreepjs({
      liesCount: 0,
      boldFailCount: 1,
      liesSurfaces: [{ surface: 'WebGL', severity: 'bold-fail', hash: '6108b922' }],
    });
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.severity).toBe('low');
    expect(partial.hits[0]?.evidence).toMatch(/白名单/);
  });

  it('WebGL bold-fail 但 liesCount>0 → 仍 high（有真实撒谎，从严）', () => {
    const partial = scoreCreepjs({
      liesCount: 1,
      boldFailCount: 1,
      liesSurfaces: [{ surface: 'WebGL', severity: 'bold-fail', hash: 'def' }],
    });
    const webglHit = partial.hits.find((h) => h.detector.includes('WebGL'));
    expect(webglHit?.severity).toBe('high');
  });
});

describe('scoreIphey', () => {
  it('failed items 入 hits；统计正常项', () => {
    const partial = scoreIphey({
      passes: 1,
      total: 2,
      items: [
        { name: 'webdriver presence', status: 'fail' },
        { name: 'plugins length', status: 'pass' },
      ],
    });
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.surface).toBe('webdriver');
  });
});

describe('scoreBrowserleaksGeneric', () => {
  it('总是返回空 partial', () => {
    expect(scoreBrowserleaksGeneric({ pairs: [{ name: 'a', value: 'b' }] })).toEqual({
      hits: [],
      metrics: {},
    });
  });
});

describe('scoreBrowserleaksCanvas', () => {
  it('hash 缺失 → high hit (signature missing)', () => {
    const partial = scoreBrowserleaksCanvas({ uniqueness: '0.01%' });
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.severity).toBe('high');
    expect(partial.hits[0]?.detector).toMatch(/missing/i);
  });

  it('hash 存在 + 高 uniqueness → 不 hit（v0.11: 唯一 canvas 非 bot 信号，uniqueness 不再计 hit）', () => {
    const partial = scoreBrowserleaksCanvas({
      canvasHash: 'abc123',
      uniqueness: '100% (The signature is unique to our database)',
    });
    expect(partial.hits).toHaveLength(0);
  });

  it('hash 存在 + uniqueness 低 → 不 hit', () => {
    const partial = scoreBrowserleaksCanvas({
      canvasHash: 'abc123',
      uniqueness: '0.01% (1 in 12000)',
    });
    expect(partial.hits).toHaveLength(0);
  });

  it('hash 存在 + uniqueness 缺失 → 不 hit（无法判定）', () => {
    const partial = scoreBrowserleaksCanvas({ canvasHash: 'abc123' });
    expect(partial.hits).toHaveLength(0);
  });
});

describe('scoreBrowserleaksWebgl', () => {
  const makePersona = (gpu?: { webglVendor?: string; webglRenderer?: string }) => ({
    id: 't',
    template: 't',
    browser: {},
    system: {},
    hardware: gpu ? { gpu } : undefined,
  });

  it('persona 无 expected + unmasked 存在 → high hit (no baseline)', () => {
    const partial = scoreBrowserleaksWebgl(
      { unmaskedVendor: 'NVIDIA', unmaskedRenderer: 'GTX 1080' },
      NO_PERSONA_GPU,
    );
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.severity).toBe('high');
    expect(partial.hits[0]?.detector).toMatch(/no persona baseline/);
  });

  it('persona expected 与 actual 一致 → 不 hit', () => {
    const partial = scoreBrowserleaksWebgl(
      { unmaskedVendor: 'Intel Inc.', unmaskedRenderer: 'Intel Iris Plus' },
      makePersona({ webglVendor: 'Intel Inc.', webglRenderer: 'Intel Iris Plus' }),
    );
    expect(partial.hits).toHaveLength(0);
  });

  it('vendor mismatch → high hit per 不一致字段', () => {
    const partial = scoreBrowserleaksWebgl(
      { unmaskedVendor: 'NVIDIA', unmaskedRenderer: 'GTX 1080' },
      makePersona({ webglVendor: 'Intel Inc.', webglRenderer: 'Intel Iris Plus' }),
    );
    // 两个字段都不一致 → 2 个 hit
    expect(partial.hits).toHaveLength(2);
    expect(partial.hits.every((h) => h.severity === 'high')).toBe(true);
  });

  it('vendor 一致 / renderer 不一致 → 1 个 hit', () => {
    const partial = scoreBrowserleaksWebgl(
      { unmaskedVendor: 'Intel Inc.', unmaskedRenderer: 'NVIDIA GTX' },
      makePersona({ webglVendor: 'Intel Inc.', webglRenderer: 'Intel Iris' }),
    );
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.detector).toMatch(/renderer/);
  });

  it('persona 无 baseline + unmasked 也无 → 不 hit', () => {
    const partial = scoreBrowserleaksWebgl({}, NO_PERSONA_GPU);
    expect(partial.hits).toHaveLength(0);
  });
});

describe('scoreDbiBot', () => {
  it('每个 triggered flag 路由到 surface + severity（DBI_KEY_TO_SURFACE）', () => {
    const partial = scoreDbiBot({
      flags: { hasWebdriverTrue: true, hasBotUserAgent: true, isHeadlessChrome: false },
      flagsTriggered: ['hasWebdriverTrue', 'hasBotUserAgent'],
      flagsTrue: 2,
    });
    expect(partial.metrics.dbiBotFlagsTriggered).toBe(2);
    expect(partial.hits).toHaveLength(2);
    const wd = partial.hits.find((h) => h.detector === 'hasWebdriverTrue');
    expect(wd?.surface).toBe('webdriver');
    expect(wd?.severity).toBe('high');
  });

  it('trueCount=0 时不 hit', () => {
    const partial = scoreDbiBot({
      flags: { hasWebdriverTrue: false },
      flagsTriggered: [],
      flagsTrue: 0,
    });
    expect(partial.hits).toHaveLength(0);
    expect(partial.metrics.dbiBotFlagsTriggered).toBe(0);
  });

  it('total=0（DOM 解析失败）时不 hit，避免假阳性', () => {
    const partial = scoreDbiBot({ flags: {}, flagsTriggered: [], flagsTrue: 0 });
    expect(partial.hits).toHaveLength(0);
  });

  it('未知 key fallback 到 other/medium', () => {
    const partial = scoreDbiBot({
      flags: { weirdNewSignal: true },
      flagsTriggered: ['weirdNewSignal'],
      flagsTrue: 1,
    });
    expect(partial.hits[0]?.surface).toBe('other');
    expect(partial.hits[0]?.severity).toBe('medium');
  });
});

describe('scoreAmIUnique', () => {
  it('outliers 转 medium hits + amiuniqueOutliers metric', () => {
    const partial = scoreAmIUnique({
      outliers: [
        { name: 'WebGL Vendor', similarityPct: 0.1, similarityRaw: '0.1%', value: 'NVIDIA' },
        { name: 'Plugins', similarityPct: 0.05, similarityRaw: '0.05%', value: 'odd-plugin' },
      ],
    });
    expect(partial.metrics.amiuniqueOutliers).toBe(2);
    expect(partial.hits).toHaveLength(2);
    expect(partial.hits.every((h) => h.severity === 'medium')).toBe(true);
  });
});

describe('scoreAntoinevastel', () => {
  it('Inconsistent → high hit + fpScannerInconsistent metric', () => {
    const partial = scoreAntoinevastel({
      inconsistentTests: ['HEADCHR_UA', 'HEADCHR_PLUGINS'],
      unsureTests: [],
    });
    expect(partial.metrics.fpScannerInconsistent).toBe(2);
    expect(partial.hits).toHaveLength(2);
    expect(partial.hits.every((h) => h.severity === 'high')).toBe(true);
  });

  it('Unsure → medium hit', () => {
    const partial = scoreAntoinevastel({
      inconsistentTests: [],
      unsureTests: ['CHR_BATTERY'],
    });
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.severity).toBe('medium');
  });

  it('KNOWN_OUTDATED_FPSCANNER_RULES.WEBDRIVER 跳过 hit + 不计 metric', () => {
    expect(KNOWN_OUTDATED_FPSCANNER_RULES.has('WEBDRIVER')).toBe(true);
    const partial = scoreAntoinevastel({
      inconsistentTests: ['WEBDRIVER', 'HEADCHR_UA'],
      unsureTests: [],
    });
    // WEBDRIVER 跳过；只剩 HEADCHR_UA 入 hit
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.detector).toMatch(/HEADCHR_UA/);
    expect(partial.metrics.fpScannerInconsistent).toBe(1);
  });

  it('未知规则名 fallback 到 other/medium 路由', () => {
    const partial = scoreAntoinevastel({
      inconsistentTests: ['SOME_UNKNOWN_FUTURE_RULE'],
      unsureTests: [],
    });
    expect(partial.hits[0]?.surface).toBe('other');
    expect(partial.hits[0]?.severity).toBe('high'); // Inconsistent 总是 high，不论 surface
  });
});

describe('scoreIncolumitas', () => {
  it('section heading → surface 启发式路由（canvas / webgl / browser → navigator）', () => {
    const partial = scoreIncolumitas({
      triggeredBadFlags: [
        { section: 'Canvas Fingerprinting', key: 'noiseLevel', value: 0 },
        { section: 'WebGL Tests', key: 'unmaskedVendor', value: 'NVIDIA' },
        { section: 'Browser Fingerprint', key: 'webdriver', value: true },
        { section: 'Worker Scope', key: 'inconsistent', value: true },
        { section: null, key: 'noSection', value: 'oops' },
      ],
    });
    expect(partial.hits).toHaveLength(5);
    expect(partial.metrics.incolumitasBadFlags).toBe(5);
    expect(partial.hits[0]?.surface).toBe('canvas');
    expect(partial.hits[1]?.surface).toBe('webgl');
    expect(partial.hits[2]?.surface).toBe('navigator');
    expect(partial.hits[3]?.surface).toBe('other');
    expect(partial.hits[4]?.surface).toBe('other');
    expect(partial.hits.every((h) => h.severity === 'high')).toBe(true);
  });
});

describe('scoreFingerprintScan', () => {
  it('score >= 50 → 不 hit (Castle.io known limit)', () => {
    expect(scoreFingerprintScan({ botRiskScore: 75, scoreVerdict: 'bot' })).toEqual({
      hits: [],
      metrics: {},
    });
  });

  it('verdict=bot → 不 hit 即使 score < 50', () => {
    expect(scoreFingerprintScan({ botRiskScore: 30, scoreVerdict: 'bot' })).toEqual({
      hits: [],
      metrics: {},
    });
  });

  it('score 25-49 (suspicious) → medium hit', () => {
    const partial = scoreFingerprintScan({ botRiskScore: 35, scoreVerdict: 'suspicious' });
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.severity).toBe('medium');
  });

  it('highRisk 关键字 + score < 50 → high hit', () => {
    const partial = scoreFingerprintScan({
      botRiskScore: 30,
      scoreVerdict: 'suspicious',
      highRiskHit: true,
    });
    expect(partial.hits).toHaveLength(1);
    expect(partial.hits[0]?.severity).toBe('high');
  });

  it('score < 25 + 无关键字 → 不 hit (human)', () => {
    expect(scoreFingerprintScan({ botRiskScore: 10, scoreVerdict: 'human' })).toEqual({
      hits: [],
      metrics: {},
    });
  });

  it('score 缺失 → empty', () => {
    expect(scoreFingerprintScan({ botRiskScore: null })).toEqual({ hits: [], metrics: {} });
  });
});

describe('scorePixelscan', () => {
  it('challengeDetected → 跳过 hits（结果不可信）', () => {
    expect(
      scorePixelscan({
        challengeDetected: true,
        cards: [{ title: 'WebGL', status: 'danger', summary: 'leak' }],
      }),
    ).toEqual({ hits: [], metrics: {} });
  });

  it('stillLoading → 跳过 hits', () => {
    expect(
      scorePixelscan({
        stillLoading: true,
        cards: [{ title: 'X', status: 'danger', summary: 'y' }],
      }),
    ).toEqual({ hits: [], metrics: {} });
  });

  it('danger 卡 → high hit；warning → medium；其他状态忽略', () => {
    const partial = scorePixelscan({
      cards: [
        { title: 'WebGL Renderer', status: 'danger', summary: 'unmasked NVIDIA' },
        { title: 'Plugins', status: 'warning', summary: 'mismatch' },
        { title: 'TLS', status: 'success', summary: 'ok' },
      ],
    });
    expect(partial.hits).toHaveLength(2);
    expect(partial.hits[0]?.severity).toBe('high');
    expect(partial.hits[1]?.severity).toBe('medium');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeScore 主入口
// ─────────────────────────────────────────────────────────────────────────────

describe('computeScore', () => {
  it('空 results → DetectionScore 全 0', () => {
    const score = computeScore(makeRaw([]));
    expect(score.weightedHits).toBe(0);
    expect(score.hits).toEqual([]);
    expect(score.creepjsLies).toBe(0);
    expect(score.sannysoftPass).toBe(0);
    expect(score.hitsBySurface.canvas).toBe(0);
  });

  it('result.ok=false 时整站 skip', () => {
    const score = computeScore(
      makeRaw([
        {
          id: 'sannysoft',
          name: 'sannysoft',
          url: 'https://x',
          ok: false,
          error: 'timeout',
          durationMs: 100,
        },
      ]),
    );
    expect(score.hits).toHaveLength(0);
  });

  it('多站合并 metrics + weightedHits 累加', () => {
    const score = computeScore(
      makeRaw([
        makeSiteResult('sannysoft', {
          passes: 5,
          total: 6,
          rows: [{ name: 'WebDriver advanced', result: 'failed', status: 'fail' }],
        }),
        makeSiteResult('creepjs', {
          liesCount: 3,
          boldFailCount: 1,
          liesSurfaces: [{ surface: 'canvas hash', severity: 'bold-fail', hash: 'abc' }],
        }),
        makeSiteResult('amiunique', {
          outliers: [{ name: 'X', similarityPct: 0.1, similarityRaw: '0.1%', value: 'v' }],
        }),
      ]),
    );
    expect(score.sannysoftPass).toBe(5);
    expect(score.sannysoftTotal).toBe(6);
    expect(score.creepjsLies).toBe(3);
    expect(score.creepjsBoldFail).toBe(1);
    expect(score.amiuniqueOutliers).toBe(1);
    // hits: 1 sannysoft (high=3) + 1 creepjs bold-fail (high=3) + 1 amiunique (medium=1.5) = 7.5
    expect(score.hits).toHaveLength(3);
    expect(score.weightedHits).toBe(3 + 3 + 1.5);
  });

  it('hitsBySurface 按 surface 计数；未命中 surface 保留 0', () => {
    const score = computeScore(
      makeRaw([
        makeSiteResult('sannysoft', {
          passes: 0,
          total: 2,
          rows: [
            { name: 'WebDriver advanced', result: 'fail', status: 'fail' },
            { name: 'Canvas Fingerprint', result: 'unique', status: 'fail' },
          ],
        }),
      ]),
    );
    expect(score.hitsBySurface.webdriver).toBe(1);
    expect(score.hitsBySurface.canvas).toBe(1);
    expect(score.hitsBySurface.webgl).toBe(0);
    expect(score.hitsBySurface.audio).toBe(0);
  });

  it('sitesOk / sitesFail 透传自 raw', () => {
    const score = computeScore(
      makeRaw([
        makeSiteResult('a', { rows: [], passes: 0, total: 0 }, { ok: true }),
        makeSiteResult('b', {}, { ok: false }),
      ]),
    );
    expect(score.sitesOk).toBe(1);
    expect(score.sitesFail).toBe(1);
  });

  it('未识别的 site id fallback 到 generic（无 hit、无 metric）', () => {
    const score = computeScore(
      makeRaw([makeSiteResult('totally-new-site', { pairs: [{ name: 'a', value: 'b' }] })]),
    );
    expect(score.hits).toHaveLength(0);
    expect(score.weightedHits).toBe(0);
  });
});
