import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys, projects, trialSignups } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import {
  TRIAL_KEEPALIVE_CAP,
  TRIAL_MINUTES_CAP,
  TRIAL_SESSION_CAP,
} from '../trial.js';
import { resetPublicTrialLimiterForTesting } from './public.js';

const VALID_USE_CASE =
  'We want to evaluate browser sessions for agent workflows that need durable login state and anti-detection evidence.';

function trialPayload(email = 'Ada@Example.com') {
  return {
    full_name: 'Ada Lovelace',
    email,
    company_name: 'Analytical Engines',
    use_case: VALID_USE_CASE,
    agree_to_terms: true,
  };
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  process.env.PUBLIC_BASE_URL = 'https://runtime.example.test';
  process.env.PUBLIC_SITE_BASE_URL = 'https://site.example.test/mosaiq';
  resetEnvCache();
  resetPublicTrialLimiterForTesting();
  await ensureSchema();
});

afterEach(async () => {
  await disposeDb();
});

describe('POST /v1/public/trials', () => {
  it('creates a trial project, API key, and signup record', async () => {
    const app = createApp();
    const resp = await app.request('/v1/public/trials', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.10',
      },
      body: JSON.stringify(trialPayload()),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      trial_id: string;
      project_id: string;
      api_key_id: string;
      api_key_plaintext: string;
      api_base_url: string;
      billing_url: string;
      onboarding_url: string;
      pricing_url: string;
      trial_minutes_cap: number;
      trial_session_cap: number;
      trial_keepalive_cap: number;
      usage_url: string;
    };
    expect(body.api_key_plaintext).toMatch(/^msq_sk_live_/);
    expect(body.api_base_url).toBe('https://runtime.example.test');
    expect(body.onboarding_url).toBe('https://site.example.test/mosaiq/onboarding/');
    expect(body.pricing_url).toBe('https://site.example.test/mosaiq/pricing/');
    expect(body.billing_url).toBe('https://site.example.test/mosaiq/pricing/#billing');
    expect(body.usage_url).toBe('https://runtime.example.test/v1/usage');
    expect(body.trial_minutes_cap).toBe(TRIAL_MINUTES_CAP);
    expect(body.trial_session_cap).toBe(TRIAL_SESSION_CAP);
    expect(body.trial_keepalive_cap).toBe(TRIAL_KEEPALIVE_CAP);

    const handle = await getDb();
    const project = (
      await handle.drizzle.select().from(projects).where(eq(projects.id, body.project_id))
    )[0];
    expect(project?.plan).toBe('trial');
    expect(project?.trialSessionCap).toBe(TRIAL_SESSION_CAP);
    expect(project?.trialKeepAliveCap).toBe(TRIAL_KEEPALIVE_CAP);
    expect(project?.trialMinutesCap).toBe(TRIAL_MINUTES_CAP);

    const signup = (
      await handle.drizzle
        .select()
        .from(trialSignups)
        .where(eq(trialSignups.id, body.trial_id))
    )[0];
    expect(signup?.email).toBe('ada@example.com');
    expect(signup?.status).toBe('active');
    expect(signup?.apiKeyId).toBe(body.api_key_id);

    const key = (
      await handle.drizzle.select().from(apiKeys).where(eq(apiKeys.id, body.api_key_id))
    )[0];
    expect(key?.projectId).toBe(body.project_id);
    expect(key?.revokedAt).toBeNull();
  });

  it('rejects a duplicate active trial for the same email', async () => {
    const app = createApp();
    const first = await app.request('/v1/public/trials', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.20' },
      body: JSON.stringify(trialPayload('dup@example.com')),
    });
    expect(first.status).toBe(201);

    const second = await app.request('/v1/public/trials', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.20' },
      body: JSON.stringify(trialPayload('DUP@example.com')),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('request.conflict');
  });

  it('answers CORS preflight without consuming signup quota', async () => {
    const app = createApp();
    const resp = await app.request('/v1/public/trials', { method: 'OPTIONS' });

    expect(resp.status).toBe(204);
    expect(resp.headers.get('access-control-allow-origin')).toBe('*');
    expect(resp.headers.get('access-control-allow-methods')).toContain('POST');
  });
});
