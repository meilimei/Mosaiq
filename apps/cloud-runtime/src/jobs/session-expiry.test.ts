/**
 * session-expiry 单测。
 *
 * 测试策略：用真实 in-memory sqlite + ensureSchema（跟 app.test.ts 同款），
 * 这样 drizzle 的 where (and(inArray, lt)) 行为也跟 prod 一样验证；mm 是
 * 注入式 fake，不依赖 module-global factory。
 *
 * 不用 vi.useFakeTimers() 的原因：startSessionExpiryJob 内部用 setInterval +
 * 自定义 re-entrant guard，跟 fake timers 配合容易写出 false-pass 的测试
 * （fake timer 推进时 microtask 调度顺序跟真实 event loop 不一致）。改用真
 * setTimeout + 短 intervalMs（1000ms 是函数内部最小值），并且只验证 stop()
 * 的语义；周期触发已经在纯函数 reapExpiredSessions 测试里覆盖了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { projects, sessions as sessionsTable } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { reapExpiredSessions, startSessionExpiryJob } from './session-expiry.js';
import type { Logger } from 'pino';

// ─── fixtures ───────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj_test_expiry';

function makeFakeLogger(): Logger {
  // 测试不关心 log 内容，只要不抛错就行；也不污染 stdout。
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

interface FakeMm {
  release: (machineId: string) => Promise<void>;
  released: string[];
  failOn: Set<string>;
}

function makeFakeMm(failOn: string[] = []): FakeMm {
  const released: string[] = [];
  const failSet = new Set(failOn);
  return {
    released,
    failOn: failSet,
    async release(machineId: string) {
      if (failSet.has(machineId)) {
        throw new Error(`fake release failure for ${machineId}`);
      }
      released.push(machineId);
    },
  };
}

/**
 * 直接往 sessions 表插入一行；绕过 POST /v1/sessions 的全流程，用最小列。
 */
async function insertSession(opts: {
  id: string;
  machineId: string;
  status: 'live' | 'requested' | 'closed' | 'errored';
  expiresAt: string;
  openedAt?: string;
}) {
  const handle = await getDb();
  await handle.drizzle.insert(sessionsTable).values({
    id: opts.id,
    projectId: PROJECT_ID,
    personaId: null,
    machineId: opts.machineId,
    status: opts.status,
    cdpInternalUrl: 'ws://fake/devtools/u',
    cdpPublicUrl: 'ws://fake/v1/sessions/u/cdp',
    openedAt: opts.openedAt ?? new Date(Date.now() - 60_000).toISOString(),
    expiresAt: opts.expiresAt,
    lastSeenAt: new Date().toISOString(),
    metadataJson: '{}',
  });
}

// ─── shared setup ───────────────────────────────────────────────────────────

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  resetEnvCache();
  await ensureSchema();

  const handle = await getDb();
  await handle.drizzle.insert(projects).values({ id: PROJECT_ID, name: 'expiry-test' });
});

afterEach(async () => {
  await disposeDb();
});

// ─── reapExpiredSessions（纯函数）─────────────────────────────────────────

describe('reapExpiredSessions', () => {
  it('表里没过期 session → scanned=0，不调 mm.release', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await insertSession({
      id: 'ses_future',
      machineId: 'mch_future',
      status: 'live',
      expiresAt: future,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(result).toEqual({ scanned: 0, released: 0, releaseFailed: 0, sessionIds: [] });
    expect(mm.released).toEqual([]);
  });

  it('单个过期 live session → release + 标 closed + error_message=expired', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_expired_1',
      machineId: 'mch_expired_1',
      status: 'live',
      expiresAt: past,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(result.scanned).toBe(1);
    expect(result.released).toBe(1);
    expect(result.releaseFailed).toBe(0);
    expect(result.sessionIds).toEqual(['ses_expired_1']);
    expect(mm.released).toEqual(['mch_expired_1']);

    const [row] = await db.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_expired_1'));
    expect(row?.status).toBe('closed');
    expect(row?.closedAt).toBeTruthy();
    expect(row?.errorMessage).toBe('expired');
  });

  it('混合：live 未过期 + live 过期 + closed 过期 → 只处理 live 过期那条', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    await insertSession({
      id: 'ses_live_future',
      machineId: 'mch_live_future',
      status: 'live',
      expiresAt: future,
    });
    await insertSession({
      id: 'ses_live_past',
      machineId: 'mch_live_past',
      status: 'live',
      expiresAt: past,
    });
    await insertSession({
      id: 'ses_closed_past',
      machineId: 'mch_closed_past',
      status: 'closed',
      expiresAt: past,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(result.scanned).toBe(1);
    expect(result.sessionIds).toEqual(['ses_live_past']);
    expect(mm.released).toEqual(['mch_live_past']);

    // 未过期 live 不动
    const [futureRow] = await db.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_live_future'));
    expect(futureRow?.status).toBe('live');

    // 已 closed 过期不动（不重抓）
    const [closedRow] = await db.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_closed_past'));
    expect(closedRow?.status).toBe('closed');
    expect(closedRow?.errorMessage).toBeNull();
  });

  it('mm.release 抛错 → row 仍标 closed，releaseFailed 计数', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_release_fails',
      machineId: 'mch_release_fails',
      status: 'live',
      expiresAt: past,
    });

    const db = await getDb();
    const mm = makeFakeMm(['mch_release_fails']);
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(result.scanned).toBe(1);
    expect(result.released).toBe(0);
    expect(result.releaseFailed).toBe(1);
    expect(mm.released).toEqual([]);

    const [row] = await db.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_release_fails'));
    expect(row?.status).toBe('closed');
    expect(row?.errorMessage).toBe('expired');
  });

  it("status='requested' 也参与 reap（schema 预留状态）", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_requested_past',
      machineId: 'mch_requested_past',
      status: 'requested',
      expiresAt: past,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(result.scanned).toBe(1);
    expect(mm.released).toEqual(['mch_requested_past']);
  });

  it("status='errored' 不被 reap（已经 terminal state）", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_errored_past',
      machineId: 'mch_errored_past',
      status: 'errored',
      expiresAt: past,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(result.scanned).toBe(0);
    expect(mm.released).toEqual([]);
  });

  it('多个过期 session 一次 tick 全部处理', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 5; i++) {
      await insertSession({
        id: `ses_batch_${i}`,
        machineId: `mch_batch_${i}`,
        status: 'live',
        expiresAt: past,
      });
    }

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(result.scanned).toBe(5);
    expect(result.released).toBe(5);
    expect(mm.released.sort()).toEqual([
      'mch_batch_0',
      'mch_batch_1',
      'mch_batch_2',
      'mch_batch_3',
      'mch_batch_4',
    ]);
  });

  it('注入 nowIso 控制 "now" 用于 boundary 测试', async () => {
    // 在 t=1000 创建 session 5 秒后过期；用 nowIso=t+10s 触发，应该过期
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const expires = new Date(t0.getTime() + 5_000).toISOString();
    const nowIso = new Date(t0.getTime() + 10_000).toISOString();
    await insertSession({
      id: 'ses_boundary',
      machineId: 'mch_boundary',
      status: 'live',
      expiresAt: expires,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger(), nowIso });
    expect(result.scanned).toBe(1);

    // 反向：nowIso 早于 expires_at，不该 reap
    await insertSession({
      id: 'ses_not_yet',
      machineId: 'mch_not_yet',
      status: 'live',
      expiresAt: new Date(t0.getTime() + 60_000).toISOString(),
    });
    const earlyNow = new Date(t0.getTime() + 30_000).toISOString();
    const result2 = await reapExpiredSessions({
      db,
      mm,
      logger: makeFakeLogger(),
      nowIso: earlyNow,
    });
    // result2 应该只 scan 已 closed 的 ses_boundary 之外的还活着的，但 ses_boundary
    // 已经在第一次跑里被 mark closed 了，所以 result2.scanned 应该是 0。
    expect(result2.scanned).toBe(0);
  });
});

// ─── startSessionExpiryJob（长跑 wrapper）─────────────────────────────────

describe('startSessionExpiryJob', () => {
  it('intervalMs < 1000 → 抛错（防误用）', () => {
    expect(() =>
      startSessionExpiryJob({
        intervalMs: 100,
        getDb: async () => (await getDb()) as never,
        getMachineManager: () => ({ release: async () => {} }) as never,
        logger: makeFakeLogger(),
      }),
    ).toThrow(/intervalMs/);
  });

  it('start → 等一个 tick 周期 → 看到一次 reap', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_tick_1',
      machineId: 'mch_tick_1',
      status: 'live',
      expiresAt: past,
    });

    const mm = makeFakeMm();
    const job = startSessionExpiryJob({
      intervalMs: 1000,
      getDb,
      getMachineManager: () => mm as never,
      logger: makeFakeLogger(),
    });

    try {
      // 等首个 tick 触发（1s 后）+ 一点 buffer 让 reap 跑完
      await new Promise((r) => setTimeout(r, 1300));
      expect(mm.released).toEqual(['mch_tick_1']);
    } finally {
      await job.stop();
    }
  }, 5000);

  it('stop() 等当前 in-flight tick 跑完才返回', async () => {
    // release handler 故意慢一点，制造 in-flight tick
    let releaseStarted = false;
    let releaseFinished = false;
    const slowMm = {
      release: async (_machineId: string) => {
        releaseStarted = true;
        await new Promise((r) => setTimeout(r, 200));
        releaseFinished = true;
      },
    };

    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_slow_release',
      machineId: 'mch_slow_release',
      status: 'live',
      expiresAt: past,
    });

    const job = startSessionExpiryJob({
      intervalMs: 1000,
      getDb,
      getMachineManager: () => slowMm as never,
      logger: makeFakeLogger(),
    });

    // 等 tick 真的开始（首 tick 1s + release 内部 200ms）
    await new Promise((r) => setTimeout(r, 1100));
    expect(releaseStarted).toBe(true);
    expect(releaseFinished).toBe(false); // 还在 200ms sleep 里

    // stop() 应该 await 那个 in-flight tick
    await job.stop();
    expect(releaseFinished).toBe(true);
  }, 5000);

  it('stop() 之后不再触发新 tick', async () => {
    const mm = makeFakeMm();
    const job = startSessionExpiryJob({
      intervalMs: 1000,
      getDb,
      getMachineManager: () => mm as never,
      logger: makeFakeLogger(),
    });

    await job.stop();

    // 插一条过期 session，等 2s 看是否被 reap（不应该）
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_after_stop',
      machineId: 'mch_after_stop',
      status: 'live',
      expiresAt: past,
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(mm.released).toEqual([]);
  }, 5000);

  it('tick 内部抛错 → setInterval 仍继续（单次失败不停 reaper）', async () => {
    let getMmCallCount = 0;
    const mm = makeFakeMm();
    const job = startSessionExpiryJob({
      intervalMs: 1000,
      getDb,
      getMachineManager: () => {
        getMmCallCount++;
        // 第一次 tick 故意抛错，第二次 tick 返回正常 mm
        if (getMmCallCount === 1) throw new Error('mm not initialized');
        return mm as never;
      },
      logger: makeFakeLogger(),
    });

    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      await insertSession({
        id: 'ses_recovery',
        machineId: 'mch_recovery',
        status: 'live',
        expiresAt: past,
      });

      // 等两个 tick 周期：第一个 tick getMachineManager 抛错；第二个 tick 正常
      await new Promise((r) => setTimeout(r, 2300));
      expect(getMmCallCount).toBeGreaterThanOrEqual(2);
      expect(mm.released).toEqual(['mch_recovery']);
    } finally {
      await job.stop();
    }
  }, 6000);
});

// silence unused vi import warning if vi ends up not referenced in some refactor
void vi;
