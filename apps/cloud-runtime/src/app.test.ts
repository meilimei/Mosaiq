/**
 * 控制平面端到端集成测试。
 *
 * 跑法：内存 sqlite + mock MachineManager。Hono `app.request()` 直接打路由。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';

import { createApp } from './app.js';
import { ensureDefaultPersonas, ensureSchema } from './db/bootstrap.js';
import { disposeDb, getDb } from './db/client.js';
import { apiKeys, projects } from './db/schema.js';
import { resetEnvCache } from './env.js';
import { setMachineManagerForTesting, shutdownMachineManager } from './machine/factory.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from './machine/types.js';
import { resetRateLimitStore } from './middleware/rate-limit.js';
import {
  resetStickyRegistryForTesting,
  stickyRegistrySizeForTesting,
} from './sticky/registry.js';
import { sha256Hex } from './utils/hash.js';
import { newId } from './utils/ids.js';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../tests/fixtures/personas/win11-chrome-us.json',
);
const PERSONA_FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;

const TEST_PROJECT_ID = 'proj_test';
const TEST_API_KEY = 'msq_sk_test_aaaaaaaaaaaaaaaaaaaaaa';
const OTHER_PROJECT_ID = 'proj_other';
const OTHER_API_KEY = 'msq_sk_test_bbbbbbbbbbbbbbbbbbbbbb';

class FakeMachineManager implements MachineManager {
  readonly kind = 'static' as const;
  acquired: AcquireSpec[] = [];
  released: string[] = [];
  capacityNow = { ready: 1, busy: 0, cap: 1 };
  shouldFailWith: string | null = null;

  async acquire(spec: AcquireSpec): Promise<AcquiredMachine> {
    if (this.shouldFailWith) {
      const e = new Error(this.shouldFailWith);
      throw e;
    }
    this.acquired.push(spec);
    this.capacityNow = { ready: 0, busy: 1, cap: 1 };
    return {
      id: 'mch_fake_001',
      podOrigin: 'http://fake-pod:9222',
      cdpInternalUrl: 'ws://fake-pod:9223/devtools/browser/uuid-stub',
    };
  }
  async release(machineId: string): Promise<void> {
    this.released.push(machineId);
    this.capacityNow = { ready: 1, busy: 0, cap: 1 };
  }
  async capacity() {
    return this.capacityNow;
  }
  async shutdown() {
    /* no-op */
  }
}

let fakeMm: FakeMachineManager;

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  process.env.PUBLIC_BASE_URL = 'http://localhost:8787';
  // 测试默认给宽松 rate-limit，避免无关 test 偶然 burst 越界。专门测限流的
  // 用例自己在 beforeEach 里 override。
  delete process.env.RATE_LIMIT_STRICT_CAPACITY;
  delete process.env.RATE_LIMIT_STRICT_REFILL_PER_SEC;
  delete process.env.RATE_LIMIT_WRITE_CAPACITY;
  delete process.env.RATE_LIMIT_WRITE_REFILL_PER_SEC;
  delete process.env.RATE_LIMIT_READ_CAPACITY;
  delete process.env.RATE_LIMIT_READ_REFILL_PER_SEC;
  resetEnvCache();
  resetRateLimitStore();
  resetStickyRegistryForTesting();
  await ensureSchema();

  // 预先 seed 两个 project + 两个 api key
  const handle = await getDb();
  const db = handle.drizzle;
  await db.insert(projects).values([
    { id: TEST_PROJECT_ID, name: 'test' },
    { id: OTHER_PROJECT_ID, name: 'other' },
  ]);
  await db.insert(apiKeys).values([
    {
      id: newId('apk'),
      projectId: TEST_PROJECT_ID,
      keyHash: sha256Hex(TEST_API_KEY),
      prefix: TEST_API_KEY.slice(0, 20),
    },
    {
      id: newId('apk'),
      projectId: OTHER_PROJECT_ID,
      keyHash: sha256Hex(OTHER_API_KEY),
      prefix: OTHER_API_KEY.slice(0, 20),
    },
  ]);

  fakeMm = new FakeMachineManager();
  setMachineManagerForTesting(fakeMm);
});

afterEach(async () => {
  await shutdownMachineManager();
  setMachineManagerForTesting(null);
  await disposeDb();
});

function authH(token = TEST_API_KEY): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('GET /v1/health', () => {
  it('200 ok 不需要 auth，回传 pool capacity + db.ok', async () => {
    const app = createApp();
    const resp = await app.request('/v1/health');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      version: string;
      machine_manager: string;
      db: { ok: boolean; error?: string };
      pool: { ready: number; busy: number; cap: number };
    };
    expect(body.ok).toBe(true);
    expect(body.machine_manager).toBe('static');
    expect(body.db).toEqual({ ok: true });
    expect(body.pool).toEqual({ ready: 1, busy: 0, cap: 1 });
  });

  it('mm.capacity 抛错 → 503 ok=false 带 mm_error', async () => {
    // 装一个会在 capacity 上抛的 mm
    const brokenMm: MachineManager = {
      kind: 'static',
      acquire: async () => {
        throw new Error('not used in this test');
      },
      release: async () => {
        /* */
      },
      capacity: async () => {
        throw new Error('fly api outage');
      },
      shutdown: async () => {
        /* */
      },
    };
    setMachineManagerForTesting(brokenMm);

    const app = createApp();
    const resp = await app.request('/v1/health');
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as {
      ok: boolean;
      db: { ok: boolean };
      pool: unknown;
      mm_error?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.db.ok).toBe(true); // DB 仍然 ok
    expect(body.pool).toBeNull();
    expect(body.mm_error).toContain('fly api outage');
  });

  it('sqlite 底层句柄已关（journal 损坏 / volume 掉线）→ 503 db.ok=false', async () => {
    // 模拟"DB 进程在但 IO 全报错"——拿到 cached handle 后直接 close 底层
    // sqlite，但不清 cached 缓存，让下次 getDb() 仍返回同一个（已 broken）
    // handle，drizzle.all 会抛 "The database connection is not open"。
    const handle = await getDb();
    await handle.close();

    const app = createApp();
    const resp = await app.request('/v1/health');
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as {
      ok: boolean;
      db: { ok: boolean; error?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.db.ok).toBe(false);
    expect(body.db.error).toBeTruthy();

    // afterEach 的 disposeDb 会再 close 一次 + 清缓存；better-sqlite3 close
    // 是幂等的（已关再 close 不抛）。
  });
});

describe('auth middleware', () => {
  it('无 Authorization → 401 missing_token', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', { method: 'POST', body: '{}' });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('auth.missing_token');
  });

  it('错误的 token → 401 invalid_key', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH('msq_sk_test_wrong_xxxxxxxxxxxxxx'),
      body: '{}',
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('auth.invalid_key');
  });

  // ── Phase 11.4 commit 1: Browserbase SDK 兼容（X-BB-API-Key header）──

  it('X-BB-API-Key 单 header → auth 通过（404 来自 handler 不是 401）', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions/ses_nonexistent', {
      headers: { 'X-BB-API-Key': TEST_API_KEY },
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session.not_found');
  });

  it('x-bb-api-key 大小写不敏感（小写 header 名）→ auth 通过', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions/ses_nonexistent', {
      headers: { 'x-bb-api-key': TEST_API_KEY },
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session.not_found');
  });

  it('两个 header 都传且值一致 → auth 通过（容忍重复）', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions/ses_nonexistent', {
      headers: {
        'X-BB-API-Key': TEST_API_KEY,
        authorization: `Bearer ${TEST_API_KEY}`,
      },
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session.not_found');
  });

  it('两个 header 都传但值不一致 → 400 auth.dual_header', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions/ses_nonexistent', {
      headers: {
        'X-BB-API-Key': TEST_API_KEY,
        authorization: `Bearer ${OTHER_API_KEY}`,
      },
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('auth.dual_header');
  });

  it('X-BB-API-Key 是未知 key → 401 invalid_key', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions/ses_nonexistent', {
      headers: { 'X-BB-API-Key': 'msq_sk_test_wrong_xxxxxxxxxxxxxx' },
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('auth.invalid_key');
  });
});

describe('POST /v1/sessions', () => {
  it('inline persona + 默认 stealth → 201，cdp_url 由 PUBLIC_BASE_URL 拼', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      id: string;
      project_id: string;
      cdp_url: string;
      persona: { metadata: { id: string } };
      stealth: { inject: boolean; humanize: boolean; rebrowserPatches: boolean };
      status: string;
    };
    expect(body.id).toMatch(/^ses_/);
    expect(body.project_id).toBe(TEST_PROJECT_ID);
    // Phase 11.4 commit 4c: cdp_url 现在带 ?token=<sks_...> 让 Playwright
    // chromium.connectOverCDP(url) 不传 header 也能 auth (Stagehand SDK 模式)。
    expect(body.cdp_url).toMatch(
      new RegExp(`^ws://localhost:8787/v1/sessions/${body.id}/cdp\\?token=sks_[A-Za-z0-9_-]{22}$`),
    );
    expect(body.persona.metadata.id).toBe('win11-chrome-us');
    expect(body.stealth).toEqual({ inject: true, humanize: true, rebrowserPatches: true });
    expect(body.status).toBe('live');
    expect(fakeMm.acquired).toHaveLength(1);
    expect(fakeMm.acquired[0]!.sessionId).toBe(body.id);
  });

  it('project_id 与 api key 不匹配 → 403 project_mismatch', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: OTHER_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    expect(resp.status).toBe(403);
  });

  it('inline persona schema 失败 → 422 request.invalid', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { inline: { not: 'a persona' } },
      }),
    });
    expect(resp.status).toBe(422);
  });

  it('persona.id 不存在 → 404 persona.not_found', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { id: 'pers_does_not_exist' },
      }),
    });
    expect(resp.status).toBe(404);
  });

  it('TTL 上限封顶到 SESSION_TTL_MAX_SECONDS', async () => {
    process.env.SESSION_TTL_MAX_SECONDS = '120';
    process.env.SESSION_TTL_DEFAULT_SECONDS = '60';
    resetEnvCache();
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        lifecycle: { ttl_seconds: 9999 },
      }),
    });
    expect(resp.status).toBe(201);
    expect(fakeMm.acquired[0]!.ttlSeconds).toBe(120);
  });
});

describe('GET / DELETE /v1/sessions/:id', () => {
  async function createOne(): Promise<string> {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    return ((await resp.json()) as { id: string }).id;
  }

  it('GET 拿到 session 详情', async () => {
    const id = await createOne();
    const app = createApp();
    const resp = await app.request(`/v1/sessions/${id}`, { headers: authH() });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id: string; status: string; cdp_url: string };
    expect(body.id).toBe(id);
    expect(body.status).toBe('live');
  });

  it('GET 跨 project 看 → 404', async () => {
    const id = await createOne();
    const app = createApp();
    const resp = await app.request(`/v1/sessions/${id}`, { headers: authH(OTHER_API_KEY) });
    expect(resp.status).toBe(404);
  });

  it('DELETE 幂等 + 调 release', async () => {
    const id = await createOne();
    const app = createApp();
    let resp = await app.request(`/v1/sessions/${id}`, { method: 'DELETE', headers: authH() });
    expect(resp.status).toBe(204);
    resp = await app.request(`/v1/sessions/${id}`, { method: 'DELETE', headers: authH() });
    expect(resp.status).toBe(204);
    expect(fakeMm.released).toEqual(['mch_fake_001']);
  });

  it('DELETE 不存在的 session → 204（幂等）', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions/ses_does_not_exist', {
      method: 'DELETE',
      headers: authH(),
    });
    expect(resp.status).toBe(204);
  });
});

describe('/v1/personas', () => {
  it('POST + GET 流程', async () => {
    const app = createApp();
    let resp = await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    expect(resp.status).toBe(201);

    resp = await app.request('/v1/personas', { headers: authH() });
    expect(resp.status).toBe(200);
    const list = (await resp.json()) as { items: Array<{ id: string; source: string }> };
    expect(list.items.find((i) => i.id === 'win11-chrome-us')?.source).toBe('user');

    resp = await app.request('/v1/personas/win11-chrome-us', { headers: authH() });
    expect(resp.status).toBe(200);
    const detail = (await resp.json()) as { persona: { metadata: { id: string } } };
    expect(detail.persona.metadata.id).toBe('win11-chrome-us');
  });

  it('POST 同 id 二次 → 409 duplicate', async () => {
    const app = createApp();
    let resp = await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    expect(resp.status).toBe(201);
    resp = await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    expect(resp.status).toBe(409);
  });

  it('persona ID 上传后可被 createSession 引用', async () => {
    const app = createApp();
    await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { id: 'win11-chrome-us' },
      }),
    });
    expect(resp.status).toBe(201);
  });
});

describe('rate limit middleware', () => {
  // 配置极小 capacity 让 fire-fast 必中 429。refill 设很慢避免测试期间补齐。
  beforeEach(() => {
    process.env.RATE_LIMIT_STRICT_CAPACITY = '2';
    process.env.RATE_LIMIT_STRICT_REFILL_PER_SEC = '0.01'; // 1 token / 100s
    process.env.RATE_LIMIT_READ_CAPACITY = '2';
    process.env.RATE_LIMIT_READ_REFILL_PER_SEC = '0.01';
    resetEnvCache();
    resetRateLimitStore();
  });

  it('connectover read tier: 第 3 次 GET 同 key → 429 + Retry-After header', async () => {
    const app = createApp();
    // 先建一个 session 让 GET 能命中（也会消耗 strict bucket，无所谓）
    await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    const createResp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { id: 'win11-chrome-us' },
      }),
    });
    expect(createResp.status).toBe(201);
    const created = (await createResp.json()) as { id: string };

    // 现在打 read tier：capacity=2 → 第 3 次必 429
    const r1 = await app.request(`/v1/sessions/${created.id}`, { headers: authH() });
    const r2 = await app.request(`/v1/sessions/${created.id}`, { headers: authH() });
    const r3 = await app.request(`/v1/sessions/${created.id}`, { headers: authH() });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    // Retry-After header 应当在；refill=0.01/s ⇒ ~100s
    const retryAfter = r3.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    const body = (await r3.json()) as { error: { code: string; detail?: { tag?: string } } };
    expect(body.error.code).toBe('rate.limit_exceeded');
    expect(body.error.detail?.tag).toBe('read');
  });

  it('两个 api_key 各自独立桶，同 endpoint 不共享 limit', async () => {
    const app = createApp();
    // 先准备两个 session，各属于一个 project
    await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(OTHER_API_KEY),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    const c1 = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({ project_id: TEST_PROJECT_ID, persona: { id: 'win11-chrome-us' } }),
    });
    const c2 = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(OTHER_API_KEY),
      body: JSON.stringify({ project_id: OTHER_PROJECT_ID, persona: { id: 'win11-chrome-us' } }),
    });
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);

    // 把 TEST_API_KEY 的 read bucket 打爆
    const id1 = ((await c1.json()) as { id: string }).id;
    await app.request(`/v1/sessions/${id1}`, { headers: authH() });
    await app.request(`/v1/sessions/${id1}`, { headers: authH() });
    const denied = await app.request(`/v1/sessions/${id1}`, { headers: authH() });
    expect(denied.status).toBe(429);

    // OTHER_API_KEY 完全不受影响（独立 bucket）
    const id2 = ((await c2.json()) as { id: string }).id;
    const otherOk = await app.request(`/v1/sessions/${id2}`, { headers: authH(OTHER_API_KEY) });
    expect(otherOk.status).toBe(200);
  });

  it('正常请求带 X-RateLimit-Limit / X-RateLimit-Remaining 可观察 headers', async () => {
    const app = createApp();
    await app.request('/v1/personas', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(PERSONA_FIXTURE),
    });
    const createResp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { id: 'win11-chrome-us' },
      }),
    });
    const id = ((await createResp.json()) as { id: string }).id;
    const r = await app.request(`/v1/sessions/${id}`, { headers: authH() });
    expect(r.status).toBe(200);
    expect(r.headers.get('X-RateLimit-Limit')).toBe('2');
    // Remaining 应当 ≤ capacity-1
    const rem = Number(r.headers.get('X-RateLimit-Remaining'));
    expect(rem).toBeGreaterThanOrEqual(0);
    expect(rem).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11.4 commit 2: /v1/sessions response superset (Browserbase SDK 兼容)
// ─────────────────────────────────────────────────────────────────────────────

describe('Browserbase compat — response shape (phase 11.4)', () => {
  async function createOne(): Promise<Record<string, unknown>> {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    expect(resp.status).toBe(201);
    return (await resp.json()) as Record<string, unknown>;
  }

  it('POST response 同时含 native 和 BB 字段；connectUrl 与 cdp_url 同值', async () => {
    const body = await createOne();
    // native (snake_case) 字段保留
    expect(body['id']).toMatch(/^ses_/);
    // Phase 11.4 commit 4c: cdp_url 内嵌 session signing key (?token=sks_...)
    expect(body['cdp_url']).toMatch(/\/v1\/sessions\/ses_.+\/cdp\?token=sks_[A-Za-z0-9_-]{22}$/);
    expect(body['project_id']).toBe(TEST_PROJECT_ID);
    expect(body['created_at']).toBeTypeOf('string');
    // BB (camelCase) 字段同时输出
    expect(body['connectUrl']).toBe(body['cdp_url']);
    expect(body['projectId']).toBe(body['project_id']);
    expect(body['createdAt']).toBe(body['created_at']);
    expect(body['expiresAt']).toBe(body['expires_at']);
  });

  it('POST response 时间字段为 ISO 8601 字符串', async () => {
    const body = await createOne();
    const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    expect(body['createdAt']).toMatch(isoLike);
    expect(body['updatedAt']).toMatch(isoLike);
    expect(body['startedAt']).toMatch(isoLike);
    expect(body['expiresAt']).toMatch(isoLike);
    expect(new Date(body['createdAt'] as string).toString()).not.toBe('Invalid Date');
  });

  it('POST response BB stub 字段值正确（11.4a 不实现的字段）', async () => {
    const body = await createOne();
    expect(body['seleniumRemoteUrl']).toBeNull();
    expect(body['contextId']).toBeNull();
    expect(body['endedAt']).toBeNull();
    expect(body['proxyBytes']).toBe(0);
    expect(body['keepAlive']).toBe(false);
  });

  it('POST response signingKey 是 sks_... 且与 connectUrl 中的 ?token= 完全一致 (phase 11.4 commit 4c)', async () => {
    const body = await createOne();
    const signingKey = body['signingKey'];
    expect(signingKey).toMatch(/^sks_[A-Za-z0-9_-]{22}$/);
    const connectUrl = body['connectUrl'] as string;
    const url = new URL(connectUrl);
    expect(url.searchParams.get('token')).toBe(signingKey);
  });

  it('POST response userMetadata 默认为 {}（请求未传时）', async () => {
    const body = await createOne();
    expect(body['userMetadata']).toEqual({});
  });

  it('GET /v1/sessions/:id 也返回 BB-compat 字段（refactor 通过 shapeSession 单一来源）', async () => {
    const created = await createOne();
    const id = created['id'] as string;
    const app = createApp();
    const r = await app.request(`/v1/sessions/${id}`, { headers: authH() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body['connectUrl']).toBe(created['cdp_url']);
    expect(body['createdAt']).toBe(created['createdAt']);
    expect(body['projectId']).toBe(TEST_PROJECT_ID);
    expect(body['proxyBytes']).toBe(0);
    expect(body['keepAlive']).toBe(false);
    // signing key 在 GET 路径与 POST 一致 (commit 4c)
    expect(body['signingKey']).toBe(created['signingKey']);
    // GET 路径下 persona 是 null（v0.11 phase 11.1 简化决定保留）
    expect(body['persona']).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11.4 commit 3: /v1/sessions 接受 Browserbase-shape 请求体
// ─────────────────────────────────────────────────────────────────────────────

describe('Browserbase compat — request body (phase 11.4)', () => {
  it('接受 BB camelCase projectId（无 snake_case project_id）', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body['project_id']).toBe(TEST_PROJECT_ID);
    expect(body['projectId']).toBe(TEST_PROJECT_ID);
  });

  it('完全省略 project id（BB SDK 默认）→ 用 auth.projectId', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body['project_id']).toBe(TEST_PROJECT_ID);
  });

  it('project_id 与 projectId 同存且不一致 → 422 request.invalid', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        projectId: OTHER_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    expect(resp.status).toBe(422);
    const err = (await resp.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('request.invalid');
    expect(err.error.message).toMatch(/both supplied with different values/i);
  });

  it('userMetadata 落库并在 POST + GET 响应中回显', async () => {
    const app = createApp();
    const meta = { run: 'unit', n: 42, tags: ['a', 'b'] };
    const createResp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        userMetadata: meta,
      }),
    });
    expect(createResp.status).toBe(201);
    const created = (await createResp.json()) as { id: string; userMetadata: unknown };
    expect(created.userMetadata).toEqual(meta);

    const getResp = await app.request(`/v1/sessions/${created.id}`, { headers: authH() });
    expect(getResp.status).toBe(200);
    const fetched = (await getResp.json()) as { userMetadata: unknown };
    expect(fetched.userMetadata).toEqual(meta);
  });

  it('browserSettings.viewport 被 honor（无 native viewport 时）', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        browserSettings: { viewport: { width: 1366, height: 768 } },
      }),
    });
    expect(resp.status).toBe(201);
    expect(fakeMm.acquired).toHaveLength(1);
    expect(fakeMm.acquired[0]!.viewport).toEqual({ width: 1366, height: 768 });
  });

  it('native viewport 优先级高于 browserSettings.viewport（同时给时）', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        viewport: { width: 1920, height: 1080 },
        browserSettings: { viewport: { width: 1366, height: 768 } },
      }),
    });
    expect(resp.status).toBe(201);
    expect(fakeMm.acquired[0]!.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it('暂不实现的 BB 字段 → 200 + response.unsupportedFields[]', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        // 注：phase 11.5 起 keepAlive 已 honor，本测试只覆盖仍 warn-ignore 的字段。
        recording: { enabled: true },
        proxies: [{ type: 'browserbase' }],
        extensionId: 'ext_xxx',
        region: 'us-east-1',
        timezone: 'America/New_York',
        browserSettings: {
          viewport: { width: 1366, height: 768 },
          fingerprint: { devices: ['desktop'] },
          blockAds: true,
        },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { unsupportedFields: string[] };
    // 至少包含我们枚举出的几个；顺序以收集顺序为准。
    expect(body.unsupportedFields).toEqual(
      expect.arrayContaining([
        'recording',
        'proxies',
        'extensionId',
        'region',
        'timezone',
        'browserSettings.fingerprint',
        'browserSettings.blockAds',
      ]),
    );
    // viewport + keepAlive 都不应出现（前者 honor、后者 phase 11.5 起 honor）
    expect(body.unsupportedFields).not.toContain('browserSettings.viewport');
    expect(body.unsupportedFields).not.toContain('keepAlive');
  });

  it('persona 完全省略 + 默认 seed 未植入 → 404 persona.not_found（命中清晰 default id）', async () => {
    // 没调 ensureDefaultPersonas，所以 personas 表里没有 seed 行。
    // 处理器仍然会随机挑一个 default id 走 DB lookup，应当得到 404 + 该 id。
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
      }),
    });
    expect(resp.status).toBe(404);
    const err = (await resp.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('persona.not_found');
    expect(err.error.message).toMatch(/pers_default_/);
  });

  it('无 BB 字段时响应不带 unsupportedFields key（cleanliness check）', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'unsupportedFields')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 11.5 commit 3: POST /v1/sessions honors keepAlive + sticky registry + quota
// ───────────────────────────────────────────────────────────────────────────

describe('Phase 11.5 — keepAlive honor + sticky routing + quota', () => {
  it('POST keepAlive=true → 201, response.keepAlive=true, 提升 TTL ceiling 到 KEEPALIVE 配置', async () => {
    // 显式传 10800s (3h) > 默认非-keepAlive ceiling SESSION_TTL_MAX_SECONDS=7200s。
    // keepAlive=true 时 ceiling 应为 SESSION_TTL_MAX_KEEPALIVE_SECONDS (86400s 默认)，
    // 因此 10800 应该原样被采纳，而非被 7200 截断。同时避免依赖 24h 的精确数值
    // —— 上面 "TTL 上限封顶" 测试会污染 SESSION_TTL_DEFAULT_SECONDS=60 到本测试。
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        lifecycle: { ttl_seconds: 10800 },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body['keepAlive']).toBe(true);
    // expiresAt - now ≈ 10800s ± clock skew + insert latency；放宽到 10700~10900
    const secondsAhead = (new Date(body['expiresAt'] as string).getTime() - Date.now()) / 1000;
    expect(secondsAhead).toBeGreaterThan(10700);
    expect(secondsAhead).toBeLessThan(10900);
  });

  it('POST native lifecycle.keep_alive=true → 等价 BB keepAlive=true 入口', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        lifecycle: { keep_alive: true },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body['keepAlive']).toBe(true);
  });

  it('POST 同 (projectId, stickyKey) 两次 → 第二次 409 session.sticky_conflict 含 existingSessionId+expiresAt+connectUrl', async () => {
    const app = createApp();
    const first = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        userMetadata: { stickyKey: 'reddit:user_42' },
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as Record<string, unknown>;
    const firstId = firstBody['id'] as string;

    const second = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        userMetadata: { stickyKey: 'reddit:user_42' },
      }),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as {
      error: { code: string; detail: { existingSessionId: string; expiresAt: string; connectUrl: string } };
    };
    expect(secondBody.error.code).toBe('session.sticky_conflict');
    expect(secondBody.error.detail.existingSessionId).toBe(firstId);
    expect(secondBody.error.detail.expiresAt).toBe(firstBody['expiresAt']);
    // connectUrl 必须可被客户端直接用做 chromium.connectOverCDP(...) 的入参，
    // 含 ?token= 内嵌 signing key (phase 11.4 commit 4c 行为)。
    expect(secondBody.error.detail.connectUrl).toMatch(/\?token=sks_/);
    expect(secondBody.error.detail.connectUrl).toBe(firstBody['connectUrl']);
  });

  it('POST 同 stickyKey 但第一个已 DELETE → 第二次 201（stale evict 后新建）', async () => {
    const app = createApp();
    const first = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        userMetadata: { stickyKey: 'session_to_close' },
      }),
    });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;

    // DELETE 第一个（commit 4 之前 DELETE handler 不会 evict sticky map，
    // 但 POST 路径的双检会看到 row.status='closed' → 走 evict 路径）
    const del = await app.request(`/v1/sessions/${firstId}`, {
      method: 'DELETE',
      headers: authH(),
    });
    expect(del.status).toBe(204);

    const second = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        userMetadata: { stickyKey: 'session_to_close' },
      }),
    });
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { id: string }).id;
    expect(secondId).not.toBe(firstId);
  });

  it('POST keepAlive=true 配额满 → 429 pool.keepalive_saturated + Retry-After header', async () => {
    process.env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX = '2';
    resetEnvCache();
    const app = createApp();

    for (let i = 0; i < 2; i++) {
      const resp = await app.request('/v1/sessions', {
        method: 'POST',
        headers: authH(),
        body: JSON.stringify({
          projectId: TEST_PROJECT_ID,
          persona: { inline: PERSONA_FIXTURE },
          keepAlive: true,
        }),
      });
      expect(resp.status).toBe(201);
    }

    const overflow = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
      }),
    });
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get('Retry-After')).toBe('60');
    const body = (await overflow.json()) as {
      error: { code: string; detail: { activeCount: number; quota: number } };
    };
    expect(body.error.code).toBe('pool.keepalive_saturated');
    expect(body.error.detail.activeCount).toBe(2);
    expect(body.error.detail.quota).toBe(2);

    delete process.env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX;
  });

  it('KEEPALIVE_SESSIONS_PER_PROJECT_MAX=0 → 所有 keepAlive 请求即时 429（kill switch）', async () => {
    process.env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX = '0';
    resetEnvCache();
    const app = createApp();

    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
      }),
    });
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('pool.keepalive_saturated');

    // keepAlive=false 路径不受 kill switch 影响
    const normal = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
      }),
    });
    expect(normal.status).toBe(201);

    delete process.env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX;
  });

  it('POST keepAlive=true 不传 stickyKey → 201，sticky registry 仍为空', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
      }),
    });
    expect(resp.status).toBe(201);
    expect(stickyRegistrySizeForTesting()).toBe(0);
  });

  it('POST keepAlive=false + userMetadata.stickyKey → 201，sticky 不生效（只 round-trip）', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        // 故意不传 keepAlive
        userMetadata: { stickyKey: 'ignored_when_keepalive_false' },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { keepAlive: boolean; userMetadata: Record<string, unknown> };
    expect(body.keepAlive).toBe(false);
    // stickyKey 仍 round-trip 在 userMetadata 里（客户端 GET 能取回）
    expect(body.userMetadata['stickyKey']).toBe('ignored_when_keepalive_false');
    // 但 registry 完全不记账
    expect(stickyRegistrySizeForTesting()).toBe(0);

    // 同一 stickyKey 再来一次（仍 keepAlive=false）→ 也 201，不命中 409
    const second = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        userMetadata: { stickyKey: 'ignored_when_keepalive_false' },
      }),
    });
    expect(second.status).toBe(201);
  });

  it('GET keepAlive session 返回 keepAlive=true', async () => {
    const app = createApp();
    const created = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
      }),
    });
    const id = ((await created.json()) as { id: string }).id;

    const got = await app.request(`/v1/sessions/${id}`, { headers: authH() });
    expect(got.status).toBe(200);
    const body = (await got.json()) as { keepAlive: boolean };
    expect(body.keepAlive).toBe(true);
  });

  it('Phase 11.5 commit 4: DELETE keepAlive session 从 sticky registry evict entry', async () => {
    const app = createApp();
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        userMetadata: { stickyKey: 'will_be_evicted_by_delete' },
      }),
    });
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { id: string }).id;
    expect(stickyRegistrySizeForTesting()).toBe(1);

    const del = await app.request(`/v1/sessions/${id}`, {
      method: 'DELETE',
      headers: authH(),
    });
    expect(del.status).toBe(204);
    // sticky entry 应已 evict（commit 4 行为：DELETE 在 release + status 更新后扫 userMetadata）
    expect(stickyRegistrySizeForTesting()).toBe(0);

    // 同 stickyKey 立即再 POST 应直接 201（registry 空 + DB session closed）
    const recreate = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        userMetadata: { stickyKey: 'will_be_evicted_by_delete' },
      }),
    });
    expect(recreate.status).toBe(201);
    expect(stickyRegistrySizeForTesting()).toBe(1);
  });

  it('Sticky 范围限定 (projectId, stickyKey) — 不同 project 同 stickyKey 互不冲突', async () => {
    const app = createApp();
    const a = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(TEST_API_KEY),
      body: JSON.stringify({
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        userMetadata: { stickyKey: 'shared:reddit:main' },
      }),
    });
    expect(a.status).toBe(201);

    // 同 stickyKey 但 OTHER_API_KEY → OTHER_PROJECT_ID 命名空间，不冲突
    const b = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(OTHER_API_KEY),
      body: JSON.stringify({
        persona: { inline: PERSONA_FIXTURE },
        keepAlive: true,
        userMetadata: { stickyKey: 'shared:reddit:main' },
      }),
    });
    expect(b.status).toBe(201);
    expect(stickyRegistrySizeForTesting()).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 11.4 commit 4a: 默认 persona seed 池（让 Stagehand bb.sessions.create({}) 绿）
// ───────────────────────────────────────────────────────────────────────────

describe('Browserbase compat — default persona seed (phase 11.4 commit 4a)', () => {
  beforeEach(async () => {
    // 这个 describe 下的所有用例都需要预先植入默认 persona；其他 describe 不用。
    await ensureDefaultPersonas();
  });

  it('empty body (BB-shape `{}`) → 201，赋予默认 seed persona', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      persona_id: string;
      persona: { metadata: { id: string; tags: string[] } };
      project_id: string;
    };
    expect(body.persona_id).toMatch(/^pers_default_/);
    expect(body.project_id).toBe(TEST_PROJECT_ID);
    expect(body.persona.metadata.tags).toEqual(
      expect.arrayContaining(['default', 'seed']),
    );
  });

  it('BB-shape 仅带 projectId（无 persona） → 201，默认 seed persona', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({ projectId: TEST_PROJECT_ID }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { persona_id: string };
    expect(body.persona_id).toMatch(/^pers_default_/);
  });

  it('默认 persona pool 包含 4 条 seed-source 行（与 DEFAULT_PERSONAS 等长）', async () => {
    const handle = await getDb();
    const rows = handle.drizzle.all(
      sql`SELECT id FROM personas WHERE source = 'seed' AND project_id IS NULL ORDER BY id`,
    ) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([
      'pers_default_macos_sonoma_chrome_us',
      'pers_default_ubuntu_2204_chrome_us',
      'pers_default_win10_chrome_us',
      'pers_default_win11_chrome_us',
    ]);
  });

  it('ensureDefaultPersonas 幂等：调两次仍然是 4 行（不重复插）', async () => {
    // beforeEach 已结束一次，再手动调一次。
    await ensureDefaultPersonas();
    const handle = await getDb();
    const rows = handle.drizzle.all(
      sql`SELECT COUNT(*) AS n FROM personas WHERE source = 'seed' AND project_id IS NULL`,
    ) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(4);
  });

  it('连跑 8 次 empty body：persona_id 始终在 4 个 default id 范围内', async () => {
    const app = createApp();
    const seen = new Set<string>();
    const allowed = new Set([
      'pers_default_win11_chrome_us',
      'pers_default_win10_chrome_us',
      'pers_default_macos_sonoma_chrome_us',
      'pers_default_ubuntu_2204_chrome_us',
    ]);
    for (let i = 0; i < 8; i++) {
      const r = await app.request('/v1/sessions', {
        method: 'POST',
        headers: authH(),
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(201);
      const body = (await r.json()) as { persona_id: string };
      expect(allowed.has(body.persona_id)).toBe(true);
      seen.add(body.persona_id);
    }
    // 不断言「一定见到多个」避免 Math.random 物极必反带来的偏发 flake；
    // 只需验证「没出允许集」。
    expect(seen.size).toBeGreaterThan(0);
  });

  it('default persona 同时能被 native `persona: {id}` 显式引用', async () => {
    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({
        project_id: TEST_PROJECT_ID,
        persona: { id: 'pers_default_win11_chrome_us' },
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      persona_id: string;
      persona: { metadata: { id: string } };
    };
    expect(body.persona_id).toBe('pers_default_win11_chrome_us');
    expect(body.persona.metadata.id).toBe('win11-chrome-us-default');
  });
});
