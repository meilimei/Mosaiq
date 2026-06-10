import { and, eq, isNull, lte } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { DbHandle } from '../db/client.js';
import { apiKeys, trialSignups } from '../db/schema.js';

export interface TrialExpiryResult {
  scanned: number;
  revokedSignups: number;
  revokedApiKeys: number;
  signupIds: string[];
  apiKeyIds: string[];
}

export async function reapExpiredTrials(deps: {
  db: DbHandle;
  logger: Logger;
  nowIso?: string;
}): Promise<TrialExpiryResult> {
  const { db, logger } = deps;
  const nowIso = deps.nowIso ?? new Date().toISOString();

  const expired = await db.drizzle
    .select({
      id: trialSignups.id,
      projectId: trialSignups.projectId,
      apiKeyId: trialSignups.apiKeyId,
      expiresAt: trialSignups.expiresAt,
    })
    .from(trialSignups)
    .where(and(eq(trialSignups.status, 'active'), lte(trialSignups.expiresAt, nowIso)));

  if (expired.length === 0) {
    return {
      scanned: 0,
      revokedSignups: 0,
      revokedApiKeys: 0,
      signupIds: [],
      apiKeyIds: [],
    };
  }

  let revokedSignups = 0;
  let revokedApiKeys = 0;
  const signupIds: string[] = [];
  const apiKeyIds: string[] = [];

  for (const row of expired) {
    signupIds.push(row.id);

    const revokedKeys = await db.drizzle
      .update(apiKeys)
      .set({ revokedAt: nowIso })
      .where(and(eq(apiKeys.projectId, row.projectId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    revokedApiKeys += revokedKeys.length;
    apiKeyIds.push(...revokedKeys.map((key) => key.id));

    const updated = await db.drizzle
      .update(trialSignups)
      .set({ status: 'expired', revokedAt: nowIso })
      .where(and(eq(trialSignups.id, row.id), eq(trialSignups.status, 'active')))
      .returning({ id: trialSignups.id });
    if (updated.length > 0) {
      revokedSignups++;
    }
  }

  logger.info(
    {
      scanned: expired.length,
      revokedSignups,
      revokedApiKeys,
      signupIds,
      apiKeyIds,
    },
    'trial-expiry: revoked expired trials',
  );

  return {
    scanned: expired.length,
    revokedSignups,
    revokedApiKeys,
    signupIds,
    apiKeyIds,
  };
}

export function startTrialExpiryJob(opts: {
  intervalMs: number;
  getDb: () => Promise<DbHandle>;
  logger: Logger;
}): { stop: () => Promise<void> } {
  const { intervalMs, getDb, logger } = opts;

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error(`startTrialExpiryJob: intervalMs must be >= 1000 (got ${intervalMs})`);
  }

  let stopped = false;
  let tickInFlight: Promise<void> | null = null;

  const runOneTick = async (): Promise<void> => {
    if (stopped) return;
    if (tickInFlight) {
      logger.debug({}, 'trial-expiry: previous tick still running, skipping');
      return;
    }
    tickInFlight = (async () => {
      try {
        const db = await getDb();
        await reapExpiredTrials({ db, logger });
      } catch (err) {
        logger.error(
          { cause: err instanceof Error ? err.message : String(err) },
          'trial-expiry: tick failed (will retry next interval)',
        );
      } finally {
        tickInFlight = null;
      }
    })();
    await tickInFlight;
  };

  const handle = setInterval(() => {
    void runOneTick();
  }, intervalMs);

  logger.info({ intervalMs }, 'trial-expiry job started');

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      if (tickInFlight) {
        try {
          await tickInFlight;
        } catch {
          /* ignore */
        }
      }
      logger.info({}, 'trial-expiry job stopped');
    },
  };
}
