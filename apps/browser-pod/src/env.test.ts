/**
 * env.test.ts — browser-pod env schema 回归。
 *
 * 关键 invariant：POD_CONTROL_HOST 和 POD_CDP_HOST 默认是 '::'（IPv6 wildcard，
 * Linux 上默认 dual-stack）。如果有人无意改回 '0.0.0.0'，Fly 6PN（IPv6-only）
 * 上的 cloud-runtime 就会调不通 pod，表现为 `pool.pod_unhealthy / fetch failed`。
 * 这条回归 2026-05-24 prod 首部署踩过的坑（详见 PHASE-11.2-FLY-DEPLOY.md §10）。
 */

import { describe, expect, it } from 'vitest';

import { loadEnv, resetEnvCache } from './env.js';

function loadWith(overrides: NodeJS.ProcessEnv) {
  resetEnvCache();
  return loadEnv(overrides);
}

describe('browser-pod env defaults — IPv6 dual-stack (regression)', () => {
  it('POD_CONTROL_HOST defaults to "::" (NOT "0.0.0.0")', () => {
    const env = loadWith({});
    expect(env.POD_CONTROL_HOST).toBe('::');
  });

  it('POD_CDP_HOST defaults to "::" (NOT "0.0.0.0")', () => {
    const env = loadWith({});
    expect(env.POD_CDP_HOST).toBe('::');
  });

  it('POD_CONTROL_PORT default 9222, POD_CDP_PORT default 9223, internal 9224', () => {
    const env = loadWith({});
    expect(env.POD_CONTROL_PORT).toBe(9222);
    expect(env.POD_CDP_PORT).toBe(9223);
    expect(env.POD_CDP_INTERNAL_PORT).toBe(9224);
  });

  it('allows override (e.g., Windows local dev needing single-stack IPv4)', () => {
    const env = loadWith({
      POD_CONTROL_HOST: '0.0.0.0',
      POD_CDP_HOST: '0.0.0.0',
    });
    expect(env.POD_CONTROL_HOST).toBe('0.0.0.0');
    expect(env.POD_CDP_HOST).toBe('0.0.0.0');
  });
});
