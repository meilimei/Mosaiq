/**
 * /v1/metrics endpoint + counter wiring 集成测试。
 *
 * 这里**不**测 prom-client 本身（社区库 + 30M weekly downloads，假设它对）。
 * 重点验证：
 *   1) METRICS_TOKEN 为空 → 整个 endpoint disabled（404）
 *   2) 错 / 缺 token → 401
 *   3) 正确 token → 200 + Prometheus exposition 格式
 *   4) 业务路径会增加对应 counter（sessions_created_total 等）
 *   5) pool_state gauge 在 scrape 时被刷新
 *
 * 走真实 in-memory sqlite + FakeMm，跟 app.test.ts 同款 setup（copy 而不是
 * extract —— test setup 复用通常带来比缓解更多的坑）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { createApp } from '../app.js';
import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys, projects } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { setMachineManagerForTesting, shutdownMachineManager } from '../machine/factory.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from '../machine/types.js';
import { resetMetricsForTesting } from '../metrics.js';
import { resetRateLimitStore } from '../middleware/rate-limit.js';
import { resetStickyRegistryForTesting } from '../sticky/registry.js';
import { sha256Hex } from '../utils/hash.js';
import { newId } from '../utils/ids.js';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../tests/fixtures/personas/win11-chrome-us.json',
);
const PERSONA_FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;

const PROJECT_ID = 'proj_metrics';
const API_KEY = 'msq_sk_metrics_cccccccccccccccccccccc';
const METRICS_TOKEN = 'super-secret-scraper-token-zzzzzzzz';

class FakeMm implements MachineManager {
  readonly kind = 'static' as const;
  capacityNow = { ready: 3, busy: 1, cap: 5 };
  async acquire(_spec: AcquireSpec): Promise<AcquiredMachine> {
    return {
      id: 'mch_fake_metrics',
      podOrigin: 'http://fake:9222',
      cdpInternalUrl: 'ws://fake:9223/x',
    };
  }
  async release(): Promise<void> {}
  async capacity() {
    return this.capacityNow;
  }
  async shutdown(): Promise<void> {}
}

/**
 * Phase 11.3a 用：mock pool-introspectable manager。routes/metrics.ts 用
 * duck-typing（hasInspectPool）判定，所以只要带这个方法就会刷 gauge。
 */
class FakePooledMm extends FakeMm {
  poolCounts = { creating: 1, stopped: 2, consumed: 0, evicting: 0 };
  inspectPool() {
    return this.poolCounts;
  }
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  process.env.METRICS_TOKEN = METRICS_TOKEN;
  delete process.env.RATE_LIMIT_STRICT_CAPACITY;
  delete process.env.RATE_LIMIT_STRICT_REFILL_PER_SEC;
  delete process.env.RATE_LIMIT_WRITE_CAPACITY;
  delete process.env.RATE_LIMIT_READ_CAPACITY;
  resetEnvCache();
  resetRateLimitStore();
  resetMetricsForTesting();
  resetStickyRegistryForTesting();
  await ensureSchema();

  const handle = await getDb();
  await handle.drizzle.insert(projects).values({ id: PROJECT_ID, name: 'metrics' });
  await handle.drizzle.insert(apiKeys).values({
    id: newId('apk'),
    projectId: PROJECT_ID,
    keyHash: sha256Hex(API_KEY),
    prefix: API_KEY.slice(0, 20),
  });
  setMachineManagerForTesting(new FakeMm());
});

afterEach(async () => {
  await shutdownMachineManager();
  setMachineManagerForTesting(null);
  await disposeDb();
});

const authH = (token = API_KEY): HeadersInit => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

const metricsH = (token = METRICS_TOKEN): HeadersInit => ({
  authorization: `Bearer ${token}`,
});

describe('/v1/metrics', () => {
  it('METRICS_TOKEN 空 → 404（disabled）', async () => {
    process.env.METRICS_TOKEN = '';
    resetEnvCache();
    const app = createApp();
    const r = await app.request('/v1/metrics', { headers: metricsH() });
    expect(r.status).toBe(404);
  });

  it('缺 Authorization → 401', async () => {
    const app = createApp();
    const r = await app.request('/v1/metrics');
    expect(r.status).toBe(401);
  });

  it('错 token → 401', async () => {
    const app = createApp();
    const r = await app.request('/v1/metrics', { headers: metricsH('wrong-token') });
    expect(r.status).toBe(401);
  });

  it('正确 token → 200 + Prometheus 文本格式', async () => {
    const app = createApp();
    const r = await app.request('/v1/metrics', { headers: metricsH() });
    expect(r.status).toBe(200);
    const text = await r.text();
    // Prometheus exposition 必有 HELP/TYPE 行 + counter 名
    expect(text).toContain('# HELP cloud_runtime_process_cpu_user_seconds_total');
    expect(text).toContain('# TYPE sessions_created_total counter');
    expect(text).toContain('sessions_created_total 0');
  });

  it('scrape 时刷新 pool_state gauge（ready/busy/cap）', async () => {
    const app = createApp();
    const r = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await r.text();
    // FakeMm capacity = { ready: 3, busy: 1, cap: 5 }
    expect(text).toMatch(/pool_state\{state="ready"\}\s+3/);
    expect(text).toMatch(/pool_state\{state="busy"\}\s+1/);
    expect(text).toMatch(/pool_state\{state="cap"\}\s+5/);
  });

  it('Phase 11.3a: pool-introspectable manager → 刷新 machine_pool_entries gauge', async () => {
    // 替换 FakeMm 成带 inspectPool 的版本
    setMachineManagerForTesting(new FakePooledMm());

    const app = createApp();
    const r = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await r.text();
    // FakePooledMm.inspectPool = { creating: 1, stopped: 2, ... }
    expect(text).toMatch(/machine_pool_entries\{state="creating"\}\s+1/);
    expect(text).toMatch(/machine_pool_entries\{state="stopped"\}\s+2/);
  });

  it('non-pool manager → machine_pool_entries 不被刷（duck-typing 跳过）', async () => {
    // FakeMm 没有 inspectPool，scrape 时 hasInspectPool() → false，不刷
    const app = createApp();
    const r = await app.request('/v1/metrics', { headers: metricsH() });
    expect(r.status).toBe(200);
    const text = await r.text();
    // gauge 没初始化过任何 series → 文本里不应有 machine_pool_entries{...} N
    expect(text).not.toMatch(/^machine_pool_entries\{/m);
  });
});

describe('counter wiring', () => {
  it('createSession 成功 → sessions_created_total 自增 1', async () => {
    const app = createApp();
    // 先建 persona（用真实 fixture，不自己拼）
    await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    const r1 = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: PROJECT_ID,
        persona: { id: 'win11-chrome-us' },
      }),
    });
    expect(r1.status).toBe(201);

    const m = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await m.text();
    expect(text).toMatch(/^sessions_created_total\s+1/m);
  });

  it('auth 失败 → auth_failures_total{reason} 自增', async () => {
    const app = createApp();
    // 缺 header → reason=missing
    await app.request('/v1/sessions/whatever');
    // 错 token → reason=invalid（unknown API key）
    await app.request('/v1/sessions/whatever', {
      headers: { authorization: 'Bearer msq_sk_wrong_yyyyyyyyyyyy' },
    });

    const m = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await m.text();
    expect(text).toMatch(/auth_failures_total\{reason="missing"\}\s+1/);
    expect(text).toMatch(/auth_failures_total\{reason="invalid"\}\s+1/);
  });

  it('rate limit 触发 → rate_limit_denied_total{tier} 自增', async () => {
    process.env.RATE_LIMIT_READ_CAPACITY = '1';
    process.env.RATE_LIMIT_READ_REFILL_PER_SEC = '0.01';
    resetEnvCache();
    resetRateLimitStore();

    const app = createApp();
    // 触发 read tier 限流：第 2 次 GET 必 429
    await app.request('/v1/sessions/nonexistent', { headers: authH() });
    const r2 = await app.request('/v1/sessions/nonexistent', { headers: authH() });
    expect(r2.status).toBe(429);

    const m = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await m.text();
    expect(text).toMatch(/rate_limit_denied_total\{tier="read"\}\s+1/);
  });

  it('http_request_duration_seconds 在每次请求后写入 bucket', async () => {
    const app = createApp();
    await app.request('/v1/health');
    const m = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await m.text();
    // 至少应该有 GET /v1/health 的 histogram count > 0
    expect(text).toContain('http_request_duration_seconds_count');
    // 拿到那一行验证 method=GET, status_class=2xx
    const matched = text.match(
      /http_request_duration_seconds_count\{[^}]*method="GET"[^}]*status_class="2xx"[^}]*\}\s+(\d+)/,
    );
    expect(matched).not.toBeNull();
    expect(Number(matched?.[1])).toBeGreaterThanOrEqual(1);
  });

  // ─── Phase 11.5 commit 5: keepAlive metrics ──────────────────────────────

  it('Phase 11.5: POST keepAlive=true → mm_acquire_duration_seconds_count{keepalive="true"} 自增', async () => {
    const app = createApp();
    await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    // 一次 keepAlive=true + 一次默认（false），样本数应分两 label
    await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: PROJECT_ID,
        persona: { id: 'win11-chrome-us' },
        keepAlive: true,
      }),
    });
    await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: PROJECT_ID,
        persona: { id: 'win11-chrome-us' },
      }),
    });

    const m = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await m.text();
    expect(text).toMatch(/mm_acquire_duration_seconds_count\{keepalive="true"\}\s+1/);
    expect(text).toMatch(/mm_acquire_duration_seconds_count\{keepalive="false"\}\s+1/);
  });

  it('Phase 11.5: keepalive_sessions_active{project_id} gauge 反映当前 live keepAlive 数', async () => {
    const app = createApp();
    await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    // 创建 2 个 keepAlive=true + 1 个普通 session
    for (let i = 0; i < 2; i++) {
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: authH(),
        body: JSON.stringify({
          project_id: PROJECT_ID,
          persona: { id: 'win11-chrome-us' },
          keepAlive: true,
        }),
      });
    }
    await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: PROJECT_ID,
        persona: { id: 'win11-chrome-us' },
      }),
    });

    const m = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await m.text();
    expect(text).toMatch(
      new RegExp(`keepalive_sessions_active\\{project_id="${PROJECT_ID}"\\}\\s+2`),
    );
    // 0 keepAlive 的 project 不应在 gauge 里（SQL GROUP BY 不返）
    expect(text).not.toMatch(/keepalive_sessions_active\{project_id="proj_other"\}/);
  });

  // ─── Phase 11.6 commit 6: contexts metrics ───────────────────────────────

  it('Phase 11.6: POST /v1/contexts → contexts_total{op="create",outcome="success"} + contexts_active gauge', async () => {
    process.env.MOSAIQ_CONTEXT_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.MOSAIQ_INTERNAL_HMAC_SECRET = randomBytes(48).toString('base64');
    resetEnvCache();
    const app = createApp();
    const create = await app.request('/v1/contexts', {
      method: 'POST',
      headers: authH(),
      body: '{}',
    });
    expect(create.status).toBe(201);

    const m = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await m.text();
    expect(text).toMatch(/contexts_total\{op="create",outcome="success"\}\s+1/);
    expect(text).toMatch(
      new RegExp(`contexts_active\\{project_id="${PROJECT_ID}"\\}\\s+1`),
    );

    process.env.MOSAIQ_CONTEXT_MASTER_KEY = '';
    process.env.MOSAIQ_INTERNAL_HMAC_SECRET = '';
    resetEnvCache();
  });

  it('Phase 11.6: DELETE context → contexts_total{op="delete",outcome="success"}, gauge drops', async () => {
    process.env.MOSAIQ_CONTEXT_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.MOSAIQ_INTERNAL_HMAC_SECRET = randomBytes(48).toString('base64');
    resetEnvCache();
    const app = createApp();
    const ctxId = ((await (
      await app.request('/v1/contexts', { method: 'POST', headers: authH(), body: '{}' })
    ).json()) as { id: string }).id;

    const del = await app.request(`/v1/contexts/${ctxId}`, {
      method: 'DELETE',
      headers: authH(),
    });
    expect(del.status).toBe(204);

    const m = await app.request('/v1/metrics', { headers: metricsH() });
    const text = await m.text();
    expect(text).toMatch(/contexts_total\{op="delete",outcome="success"\}\s+1/);
    // soft-deleted → not counted as active → gauge drops the project label (reset+GROUP BY)
    expect(text).not.toMatch(
      new RegExp(`contexts_active\\{project_id="${PROJECT_ID}"\\}`),
    );

    process.env.MOSAIQ_CONTEXT_MASTER_KEY = '';
    process.env.MOSAIQ_INTERNAL_HMAC_SECRET = '';
    resetEnvCache();
  });
});
