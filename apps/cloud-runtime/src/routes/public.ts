import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import { createApiKey } from '../admin/create-api-key.js';
import { getDb } from '../db/client.js';
import { projects, trialSignups } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { ApiError } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import {
  TRIAL_DAYS,
  TRIAL_KEEPALIVE_CAP,
  TRIAL_MINUTES_CAP,
  TRIAL_SESSION_CAP,
  TRIAL_SIGNUP_SOURCE,
  trialExpiresAtFromNow,
} from '../trial.js';

const TrialSignupSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  company_name: z.string().trim().max(120).optional(),
  use_case: z.string().trim().min(20).max(2000),
  source: z.string().trim().max(120).optional(),
  agree_to_terms: z.literal(true),
});

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

class TokenBucketStore {
  readonly buckets = new Map<string, BucketState>();

  consume(
    key: string,
    config: { capacity: number; refillPerSec: number },
  ): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const state = this.buckets.get(key) ?? { tokens: config.capacity, lastRefillMs: now };
    const elapsedSec = Math.max(0, (now - state.lastRefillMs) / 1000);
    state.tokens = Math.min(config.capacity, state.tokens + elapsedSec * config.refillPerSec);
    state.lastRefillMs = now;

    if (state.tokens >= 1) {
      state.tokens -= 1;
      this.buckets.set(key, state);
      return { allowed: true, retryAfterMs: 0 };
    }

    this.buckets.set(key, state);
    const retryAfterMs = Math.ceil(((1 - state.tokens) / config.refillPerSec) * 1000);
    return { allowed: false, retryAfterMs };
  }
}

const trialSignupLimiter = new TokenBucketStore();

export function resetPublicTrialLimiterForTesting(): void {
  trialSignupLimiter.buckets.clear();
}

function getClientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

async function publicTrialMiddleware(c: Context, next: () => Promise<void>) {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'content-type');
  c.header('Access-Control-Max-Age', '86400');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  const ip = getClientIp(c);
  const result = trialSignupLimiter.consume(ip, { capacity: 5, refillPerSec: 1 / 600 });
  if (!result.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    c.header('Retry-After', String(retryAfterSec));
    throw new ApiError(
      'rate.limit_exceeded',
      `trial signup rate limit exceeded; retry after ${retryAfterSec}s`,
      { retryAfterMs: result.retryAfterMs },
    );
  }

  await next();
}

export const publicTrialRoute = new Hono();

publicTrialRoute.use('*', publicTrialMiddleware);

publicTrialRoute.options('/trials', (c) => c.body(null, 204));

publicTrialRoute.post('/trials', async (c) => {
  const env = loadEnv();
  const body = await c.req.json().catch(() => null);
  const parsed = TrialSignupSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('request.invalid', 'invalid trial signup payload', {
      issues: parsed.error.issues,
    });
  }
  const req = parsed.data;
  const email = req.email.trim().toLowerCase();
  const expiresAt = trialExpiresAtFromNow();

  const handle = await getDb();
  const db = handle.drizzle;

  const existing = await db
    .select({ id: trialSignups.id, expiresAt: trialSignups.expiresAt })
    .from(trialSignups)
    .where(and(eq(trialSignups.email, email), eq(trialSignups.status, 'active')))
    .limit(1);
  if (existing[0]) {
    throw new ApiError('request.conflict', 'an active trial already exists for this email', {
      email,
    });
  }

  const projectSlug = req.company_name?.trim() ? req.company_name.trim() : req.full_name.trim();
  const projectId = newId('proj');
  const created = await createApiKey({
    projectId,
    projectName: `${projectSlug} Trial`,
  });

  await db
    .update(projects)
    .set({
      plan: 'trial',
      trialExpiresAt: expiresAt,
      trialSessionCap: TRIAL_SESSION_CAP,
      trialKeepAliveCap: TRIAL_KEEPALIVE_CAP,
      trialMinutesCap: TRIAL_MINUTES_CAP,
    })
    .where(eq(projects.id, projectId));

  const trialId = newId('evt');
  await db.insert(trialSignups).values({
    id: trialId,
    projectId,
    apiKeyId: created.apiKeyId,
    fullName: req.full_name.trim(),
    email,
    companyName: req.company_name?.trim() || null,
    useCase: req.use_case.trim(),
    source: req.source?.trim() || TRIAL_SIGNUP_SOURCE,
    status: 'active',
    expiresAt,
  });

  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      trial_id: trialId,
      project_id: projectId,
      api_key_id: created.apiKeyId,
      api_key_prefix: created.prefix,
      api_key_plaintext: created.plaintext,
      plan: 'trial',
      trial_days: TRIAL_DAYS,
      trial_expires_at: expiresAt,
      trial_minutes_cap: TRIAL_MINUTES_CAP,
      trial_session_cap: TRIAL_SESSION_CAP,
      trial_keepalive_cap: TRIAL_KEEPALIVE_CAP,
      api_base_url: env.PUBLIC_BASE_URL,
      quickstart_url: 'https://github.com/meilimei/Mosaiq/blob/main/QUICKSTART.md',
      docs_url: 'https://github.com/meilimei/Mosaiq/tree/main/docs',
    },
    201,
  );
});
