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
import { auditEvents, projects, sessions as sessionsTable } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import type { ReleaseOptions } from '../machine/types.js';
import {
  resetStickyRegistryForTesting,
  stickyRegistryGet,
  stickyRegistrySet,
} from '../sticky/registry.js';
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
  release: (machineId: string, opts?: ReleaseOptions) => Promise<void>;
  released: string[];
  /** Phase 11.5: 记录每次 release 的 opts，让测试断言 reaper 传 {hold: false}。 */
  releaseOpts: Array<{ machineId: string; opts: ReleaseOptions | undefined }>;
  failOn: Set<string>;
}

function makeFakeMm(failOn: string[] = []): FakeMm {
  const released: string[] = [];
  const releaseOpts: Array<{ machineId: string; opts: ReleaseOptions | undefined }> = [];
  const failSet = new Set(failOn);
  return {
    released,
    releaseOpts,
    failOn: failSet,
    async release(machineId: string, opts?: ReleaseOptions) {
      releaseOpts.push({ machineId, opts });
      if (failSet.has(machineId)) {
        throw new Error(`fake release failure for ${machineId}`);
      }
      released.push(machineId);
    },
  };
}

/**
 * 直接往 sessions 表插入一行；绕过 POST /v1/sessions 的全流程，用最小列。
 *
 * Phase 11.5: 增加 keepAlive / lastSeenAt / userMetadata 参数让 idle-timeout 与
 * sticky evict 路径可单测。
 */
async function insertSession(opts: {
  id: string;
  machineId: string;
  status: 'live' | 'requested' | 'closed' | 'errored';
  expiresAt: string;
  openedAt?: string;
  lastSeenAt?: string;
  keepAlive?: boolean;
  userMetadata?: string;
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
    lastSeenAt: opts.lastSeenAt ?? new Date().toISOString(),
    metadataJson: '{}',
    userMetadata: opts.userMetadata ?? '{}',
    keepAlive: opts.keepAlive ?? false,
  });
}

// ─── shared setup ───────────────────────────────────────────────────────────

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  process.env.MACHINE_MANAGER = 'static';
  resetEnvCache();
  resetStickyRegistryForTesting();
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

  it('单个过期 live session → release + 标 closed + error_message=expired + audit row', async () => {
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
    // Phase 11.5: reason 区分 'expired-ttl'（硬 TTL 到期）与 'expired-idle'（keepAlive 闲置超时）
    expect(row?.errorMessage).toBe('expired-ttl');

    // audit_events 行应该写入（result=ok，api_key_id=null 表明是 background job）
    const audits = await db.drizzle
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resource, 'session:ses_expired_1'));
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit?.action).toBe('session.expire');
    expect(audit?.result).toBe('ok');
    expect(audit?.projectId).toBe(PROJECT_ID);
    expect(audit?.apiKeyId).toBeNull();
    expect(audit?.ip).toBeNull();
    const detail = JSON.parse(audit?.detailJson ?? '{}');
    expect(detail.machineId).toBe('mch_expired_1');
    expect(detail.releaseFailed).toBeUndefined();
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

  it('mm.release 抛错 → row 仍标 closed，releaseFailed 计数，audit result=errored', async () => {
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
    expect(row?.errorMessage).toBe('expired-ttl');

    // audit row 必须 result=errored，detail 含 releaseFailed=true 让 ops 能 grep
    const [audit] = await db.drizzle
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resource, 'session:ses_release_fails'));
    expect(audit?.result).toBe('errored');
    const detail = JSON.parse(audit?.detailJson ?? '{}');
    expect(detail.releaseFailed).toBe(true);
  });

  it('混合 release 成功+失败 → 各自独立 audit result', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_mix_ok',
      machineId: 'mch_mix_ok',
      status: 'live',
      expiresAt: past,
    });
    await insertSession({
      id: 'ses_mix_err',
      machineId: 'mch_mix_err',
      status: 'live',
      expiresAt: past,
    });

    const db = await getDb();
    const mm = makeFakeMm(['mch_mix_err']); // 只有 mch_mix_err 失败
    const result = await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(result.scanned).toBe(2);
    expect(result.released).toBe(1);
    expect(result.releaseFailed).toBe(1);

    const [okAudit] = await db.drizzle
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resource, 'session:ses_mix_ok'));
    const [errAudit] = await db.drizzle
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resource, 'session:ses_mix_err'));
    // 关键回归：result 必须按 row 各自正确，不能是聚合状态
    expect(okAudit?.result).toBe('ok');
    expect(errAudit?.result).toBe('errored');
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

  // ─── Phase 11.5: keepAlive idle-timeout + sticky evict + hold=false 显式 opts ────

  it('Phase 11.5: keepAlive=true + lastSeenAt 早于 idleThreshold + expiresAt 未到 → reaped, reason=expired-idle', async () => {
    const now = new Date('2026-05-28T10:00:00.000Z');
    const ttlFuture = new Date(now.getTime() + 3600_000).toISOString(); // expiresAt 1h 后
    const idleLastSeen = new Date(now.getTime() - 2 * 3600_000).toISOString(); // lastSeenAt 2h 前
    const idleThreshold = new Date(now.getTime() - 3600_000).toISOString(); // 1h 前

    await insertSession({
      id: 'ses_idle_long',
      machineId: 'mch_idle_long',
      status: 'live',
      expiresAt: ttlFuture,
      lastSeenAt: idleLastSeen,
      keepAlive: true,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({
      db,
      mm,
      logger: makeFakeLogger(),
      nowIso: now.toISOString(),
      idleThresholdIso: idleThreshold,
    });

    expect(result.scanned).toBe(1);
    expect(result.sessionIds).toEqual(['ses_idle_long']);
    expect(mm.released).toEqual(['mch_idle_long']);

    const [row] = await db.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_idle_long'));
    expect(row?.status).toBe('closed');
    expect(row?.errorMessage).toBe('expired-idle');

    const [audit] = await db.drizzle
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resource, 'session:ses_idle_long'));
    const detail = JSON.parse(audit?.detailJson ?? '{}');
    expect(detail.reason).toBe('expired-idle');
    expect(detail.keepAlive).toBe(true);
  });

  it('Phase 11.5: keepAlive=true + lastSeenAt 最近 + expiresAt 未到 → 不动', async () => {
    const now = new Date('2026-05-28T10:00:00.000Z');
    const recent = new Date(now.getTime() - 5 * 60_000).toISOString(); // 5min 前
    const idleThreshold = new Date(now.getTime() - 3600_000).toISOString(); // 1h 前

    await insertSession({
      id: 'ses_idle_short',
      machineId: 'mch_idle_short',
      status: 'live',
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
      lastSeenAt: recent,
      keepAlive: true,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({
      db,
      mm,
      logger: makeFakeLogger(),
      nowIso: now.toISOString(),
      idleThresholdIso: idleThreshold,
    });

    expect(result.scanned).toBe(0);
    expect(mm.released).toEqual([]);

    const [row] = await db.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_idle_short'));
    expect(row?.status).toBe('live');
  });

  it('Phase 11.5: keepAlive=true + 同时 TTL+idle 都过期 → reason=expired-ttl (TTL 优先)', async () => {
    const now = new Date('2026-05-28T10:00:00.000Z');
    const past = new Date(now.getTime() - 60_000).toISOString();
    const idleThreshold = new Date(now.getTime() - 3600_000).toISOString();
    const idleLastSeen = new Date(now.getTime() - 2 * 3600_000).toISOString();

    await insertSession({
      id: 'ses_both_expired',
      machineId: 'mch_both_expired',
      status: 'live',
      expiresAt: past,            // TTL 已过
      lastSeenAt: idleLastSeen,   // idle 也过
      keepAlive: true,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({
      db,
      mm,
      logger: makeFakeLogger(),
      nowIso: now.toISOString(),
      idleThresholdIso: idleThreshold,
    });

    expect(result.scanned).toBe(1);
    const [row] = await db.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, 'ses_both_expired'));
    expect(row?.errorMessage).toBe('expired-ttl');
  });

  it('Phase 11.5: keepAlive=false + lastSeenAt 早于 idleThreshold → 不动（idle 仅对 keepAlive=true 生效）', async () => {
    const now = new Date('2026-05-28T10:00:00.000Z');
    const idleLastSeen = new Date(now.getTime() - 2 * 3600_000).toISOString();
    const idleThreshold = new Date(now.getTime() - 3600_000).toISOString();

    await insertSession({
      id: 'ses_nonkeep_idle',
      machineId: 'mch_nonkeep_idle',
      status: 'live',
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
      lastSeenAt: idleLastSeen,
      keepAlive: false,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({
      db,
      mm,
      logger: makeFakeLogger(),
      nowIso: now.toISOString(),
      idleThresholdIso: idleThreshold,
    });

    expect(result.scanned).toBe(0);
    expect(mm.released).toEqual([]);
  });

  it('Phase 11.5: reaper 显式传 {hold: false} 给 mm.release', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSession({
      id: 'ses_hold_check',
      machineId: 'mch_hold_check',
      status: 'live',
      expiresAt: past,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    expect(mm.releaseOpts).toHaveLength(1);
    expect(mm.releaseOpts[0]?.machineId).toBe('mch_hold_check');
    expect(mm.releaseOpts[0]?.opts).toEqual({ hold: false });
  });

  it('Phase 11.5: reap keepAlive session → 从 sticky registry evict 对应 stickyKey', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const stickyKey = 'reddit:user_99';
    await insertSession({
      id: 'ses_with_sticky',
      machineId: 'mch_with_sticky',
      status: 'live',
      expiresAt: past, // TTL 已过 → 一定被 reap
      keepAlive: true,
      userMetadata: JSON.stringify({ stickyKey, other: 'val' }),
    });
    // 模拟 POST 路径之前注册过的 sticky entry
    stickyRegistrySet(PROJECT_ID, stickyKey, {
      sessionId: 'ses_with_sticky',
      expiresAt: past,
    });
    expect(stickyRegistryGet(PROJECT_ID, stickyKey)).toBeDefined();

    const db = await getDb();
    const mm = makeFakeMm();
    await reapExpiredSessions({ db, mm, logger: makeFakeLogger() });

    // Reaper 应已 evict
    expect(stickyRegistryGet(PROJECT_ID, stickyKey)).toBeUndefined();
  });

  it('Phase 11.5: idleThresholdIso=null → idle 检查关闭，等价 phase 11.4 行为（TTL only）', async () => {
    const now = new Date('2026-05-28T10:00:00.000Z');
    const idleLastSeen = new Date(now.getTime() - 24 * 3600_000).toISOString();
    await insertSession({
      id: 'ses_idle_disabled',
      machineId: 'mch_idle_disabled',
      status: 'live',
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
      lastSeenAt: idleLastSeen,
      keepAlive: true,
    });

    const db = await getDb();
    const mm = makeFakeMm();
    const result = await reapExpiredSessions({
      db,
      mm,
      logger: makeFakeLogger(),
      nowIso: now.toISOString(),
      idleThresholdIso: null,
    });

    // 即使 idle 大到 24h，因为 idle 检查被关闭、TTL 也未到 → 不动
    expect(result.scanned).toBe(0);
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
