/**
 * chromium-version.ts 单元测试。
 *
 * 不锁定具体版本号（playwright-core 升级时会变），只保证：
 *   - 返回值形如 `\d+.\d+.\d+.\d+`
 *   - major 为正整数且和 full version 第一段一致
 *   - cache 一致性（多次调用返回同一值）
 *
 * 当 playwright-core 没装或 browsers.json 读不到时，会回落到 FALLBACK_CHROME_VERSION，
 * 形状仍然合法，所以测试在所有环境下都跑得过。
 */

import { describe, expect, it } from 'vitest';

import { getInstalledChromeMajor, getInstalledChromeVersion } from './chromium-version.js';

const FULL_VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;

describe('getInstalledChromeVersion', () => {
  it('returns a string in major.minor.build.patch shape', () => {
    expect(getInstalledChromeVersion()).toMatch(FULL_VERSION_RE);
  });

  it('is cached: repeated calls return the exact same string', () => {
    const a = getInstalledChromeVersion();
    const b = getInstalledChromeVersion();
    expect(a).toBe(b);
  });
});

describe('getInstalledChromeMajor', () => {
  it('returns a positive integer', () => {
    const major = getInstalledChromeMajor();
    expect(Number.isInteger(major)).toBe(true);
    expect(major).toBeGreaterThan(0);
  });

  it('matches the first segment of getInstalledChromeVersion', () => {
    const full = getInstalledChromeVersion();
    const expected = Number.parseInt(full.split('.')[0] ?? '', 10);
    expect(getInstalledChromeMajor()).toBe(expected);
  });

  it('is realistic for Chromium (>= 100, no real Chrome dropped to single digits since 2008)', () => {
    expect(getInstalledChromeMajor()).toBeGreaterThanOrEqual(100);
  });
});
