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
  resetEnvCache();
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
  it('200 ok 不需要 auth，回传 pool capacity', async () => {
    const app = createApp();
    const resp = await app.request('/v1/health');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      version: string;
      machine_manager: string;
      pool: { ready: number; busy: number; cap: number };
    };
    expect(body.ok).toBe(true);
    expect(body.machine_manager).toBe('static');
    expect(body.pool).toEqual({ ready: 1, busy: 0, cap: 1 });
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
