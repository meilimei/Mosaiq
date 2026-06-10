import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Logger } from 'pino';
import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { apiKeys, projects, trialSignups } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import {
  TRIAL_KEEPALIVE_CAP,
  TRIAL_MINUTES_CAP,
  TRIAL_SESSION_CAP,
} from '../trial.js';
import { reapExpiredTrials } from './trial-expiry.js';

const NOW = '2026-06-10T00:00:00.000Z';
const PAST = '2026-06-01T00:00:00.000Z';
const FUTURE = '2026-06-20T00:00:00.000Z';

function makeFakeLogger(): Logger {
  const noop = () => {
    /* */
  };
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => makeFakeLogger(),
    level: 'silent',
    silent: noop,
  } as unknown as Logger;
}

async function insertTrial(opts: {
  projectId: string;
  signupId: string;
  expiresAt: string;
  extraApiKeys?: number;
}) {
  const handle = await getDb();
  await handle.drizzle.insert(projects).values({
    id: opts.projectId,
    name: opts.projectId,
    plan: 'trial',
    trialExpiresAt: opts.expiresAt,
    trialSessionCap: TRIAL_SESSION_CAP,
    trialKeepAliveCap: TRIAL_KEEPALIVE_CAP,
    trialMinutesCap: TRIAL_MINUTES_CAP,
  });

  const keyRows = Array.from({ length: 1 + (opts.extraApiKeys ?? 0) }, (_, i) => ({
    id: `key_${opts.signupId}_${i}`,
    projectId: opts.projectId,
    keyHash: `hash_${opts.signupId}_${i}`,
    prefix: `msq_sk_live_${i}`,
  }));
  await handle.drizzle.insert(apiKeys).values(keyRows);

  await handle.drizzle.insert(trialSignups).values({
    id: opts.signupId,
    projectId: opts.projectId,
    apiKeyId: keyRows[0]!.id,
    fullName: 'Trial User',
    email: `${opts.signupId}@example.com`,
    useCase: 'Testing trial expiry behavior for public self-serve signup.',
    source: 'test',
    status: 'active',
    expiresAt: opts.expiresAt,
  });

  return { handle, keyRows };
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  resetEnvCache();
  await ensureSchema();
});

afterEach(async () => {
  await disposeDb();
});

describe('reapExpiredTrials', () => {
  it('marks expired trials and revokes their API keys', async () => {
    const { handle, keyRows } = await insertTrial({
      projectId: 'proj_trial_expired',
      signupId: 'trial_expired',
      expiresAt: PAST,
    });

    const result = await reapExpiredTrials({ db: handle, logger: makeFakeLogger(), nowIso: NOW });

    expect(result.scanned).toBe(1);
    expect(result.revokedSignups).toBe(1);
    expect(result.revokedApiKeys).toBe(1);
    expect(result.signupIds).toEqual(['trial_expired']);
    expect(result.apiKeyIds).toEqual([keyRows[0]!.id]);

    const key = (
      await handle.drizzle.select().from(apiKeys).where(eq(apiKeys.id, keyRows[0]!.id))
    )[0];
    expect(key?.revokedAt).toBe(NOW);

    const signup = (
      await handle.drizzle
        .select()
        .from(trialSignups)
        .where(eq(trialSignups.id, 'trial_expired'))
    )[0];
    expect(signup?.status).toBe('expired');
    expect(signup?.revokedAt).toBe(NOW);
  });

  it('leaves active future trials untouched', async () => {
    const { handle, keyRows } = await insertTrial({
      projectId: 'proj_trial_future',
      signupId: 'trial_future',
      expiresAt: FUTURE,
    });

    const result = await reapExpiredTrials({ db: handle, logger: makeFakeLogger(), nowIso: NOW });

    expect(result.scanned).toBe(0);
    const key = (
      await handle.drizzle.select().from(apiKeys).where(eq(apiKeys.id, keyRows[0]!.id))
    )[0];
    expect(key?.revokedAt).toBeNull();
  });

  it('revokes every API key on an expired trial project', async () => {
    const { handle } = await insertTrial({
      projectId: 'proj_trial_many_keys',
      signupId: 'trial_many_keys',
      expiresAt: PAST,
      extraApiKeys: 2,
    });

    const result = await reapExpiredTrials({ db: handle, logger: makeFakeLogger(), nowIso: NOW });

    expect(result.revokedApiKeys).toBe(3);
    const keys = await handle.drizzle
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.projectId, 'proj_trial_many_keys'));
    expect(keys).toHaveLength(3);
    expect(keys.every((key) => key.revokedAt === NOW)).toBe(true);
  });
});
