/**
 * 控制平面端到端集成测试。
 *
 * 跑法：内存 sqlite + mock MachineManager。Hono `app.request()` 直接打路由。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createApp } from './app.js';
import { ensureSchema } from './db/bootstrap.js';
import { disposeDb, getDb } from './db/client.js';
import { apiKeys, projects } from './db/schema.js';
import { resetEnvCache } from './env.js';
import { setMachineManagerForTesting, shutdownMachineManager } from './machine/factory.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from './machine/types.js';
import { resetRateLimitStore } from './middleware/rate-limit.js';
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
    expect(body.cdp_url).toBe(`ws://localhost:8787/v1/sessions/${body.id}/cdp`);
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
