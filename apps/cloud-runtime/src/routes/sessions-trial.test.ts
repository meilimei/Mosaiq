import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ensureDefaultPersonas, ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys, projects } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { resetRateLimitStore } from '../middleware/rate-limit.js';
import {
  TRIAL_KEEPALIVE_CAP,
  TRIAL_MINUTES_CAP,
  TRIAL_SESSION_CAP,
} from '../trial.js';
import { sha256Hex } from '../utils/hash.js';

const TRIAL_PROJECT_ID = 'proj_route_trial';
const TRIAL_KEY = 'msq_sk_test_trial_aaaaaaaaaaaaaaaaaaaa';

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TRIAL_KEY}`,
    'content-type': 'application/json',
  };
}

async function insertTrialProject(opts: {
  expiresAt: string;
  sessionCap?: number;
  keepAliveCap?: number;
  minutesCap?: number;
}) {
  const handle = await getDb();
  await handle.drizzle.insert(projects).values({
    id: TRIAL_PROJECT_ID,
    name: 'route trial',
    plan: 'trial',
    trialExpiresAt: opts.expiresAt,
    trialSessionCap: opts.sessionCap ?? TRIAL_SESSION_CAP,
    trialKeepAliveCap: opts.keepAliveCap ?? TRIAL_KEEPALIVE_CAP,
    trialMinutesCap: opts.minutesCap ?? TRIAL_MINUTES_CAP,
  });
  await handle.drizzle.insert(apiKeys).values({
    id: 'key_route_trial',
    projectId: TRIAL_PROJECT_ID,
    keyHash: sha256Hex(TRIAL_KEY),
    prefix: TRIAL_KEY.slice(0, 20),
  });
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  process.env.PUBLIC_BASE_URL = 'http://localhost:8787';
  process.env.SESSIONS_PER_PROJECT_MAX = '50';
  process.env.MINUTES_PER_PROJECT_PER_MONTH_MAX = '0';
  resetEnvCache();
  resetRateLimitStore();
  await ensureSchema();
  await ensureDefaultPersonas();
});

afterEach(async () => {
  await disposeDb();
});

describe('trial project session enforcement', () => {
  it('blocks expired trial projects before acquiring a browser', async () => {
    await insertTrialProject({
      expiresAt: '2000-01-01T00:00:00.000Z',
    });

    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });

    expect(resp.status).toBe(402);
    const body = (await resp.json()) as {
      error: { code: string; detail: { trialExpiresAt: string } };
    };
    expect(body.error.code).toBe('quota.trial_expired');
    expect(body.error.detail.trialExpiresAt).toBe('2000-01-01T00:00:00.000Z');
  });

  it('uses trial session cap instead of the global session cap', async () => {
    await insertTrialProject({
      expiresAt: '2999-12-31T00:00:00.000Z',
      sessionCap: 0,
    });

    const app = createApp();
    const resp = await app.request('/v1/sessions', {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });

    expect(resp.status).toBe(429);
    const body = (await resp.json()) as { error: { code: string; detail: { quota: number } } };
    expect(body.error.code).toBe('quota.sessions_exceeded');
    expect(body.error.detail.quota).toBe(0);
  });
});
