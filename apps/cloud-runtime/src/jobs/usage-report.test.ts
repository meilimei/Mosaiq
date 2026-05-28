/**
 * Phase 11.7 commit 3: usage-report job 单测。
 *
 * 真 in-memory sqlite + ensureSchema（同 session-expiry.test.ts 套路），reporter
 * 是注入式 fake。覆盖：聚合、成功回填、失败重试、"只标本次捞到的 id" 不变量、
 * batchSize 限制、startUsageReportJob 参数校验。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { projects, usageEvents } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import type { MeterReporter, UsageRecord } from '../usage/reporter.js';
import { reportUsage, startUsageReportJob } from './usage-report.js';
import type { Logger } from 'pino';

const PROJECT_A = 'proj_report_a';
const PROJECT_B = 'proj_report_b';

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

/** 记录每次 report 调用的 fake reporter。 */
function makeFakeReporter(opts: { failOnce?: boolean } = {}): MeterReporter & {
  calls: UsageRecord[][];
} {
  let failsLeft = opts.failOnce ? 1 : 0;
  const calls: UsageRecord[][] = [];
  return {
    kind: 'noop',
    calls,
    async report(records: UsageRecord[]) {
      calls.push(records);
      if (failsLeft > 0) {
        failsLeft--;
        throw new Error('fake reporter failure');
      }
    },
  };
}

async function insertUsage(opts: {
  id: string;
  projectId: string;
  kind?: string;
  value: number;
  ts: string;
}): Promise<void> {
  const handle = await getDb();
  await handle.drizzle.insert(usageEvents).values({
    id: opts.id,
    projectId: opts.projectId,
    sessionId: null,
    kind: opts.kind ?? 'session.minute',
    value: opts.value,
    ts: opts.ts,
  });
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'sqlite::memory:';
  process.env.SEED_API_KEY = '';
  resetEnvCache();
  await ensureSchema();
  const handle = await getDb();
  await handle.drizzle.insert(projects).values([
    { id: PROJECT_A, name: 'a' },
    { id: PROJECT_B, name: 'b' },
  ]);
});

afterEach(async () => {
  await disposeDb();
});

describe('reportUsage', () => {
  it('无未上报行 → scanned 0，不调 reporter', async () => {
    const db = await getDb();
    const reporter = makeFakeReporter();
    const result = await reportUsage({ db, reporter, logger: makeFakeLogger() });
    expect(result).toEqual({ scanned: 0, reported: 0, records: 0, failed: false });
    expect(reporter.calls).toHaveLength(0);
  });

  it('按 (project, kind) 聚合并回填 reported_at', async () => {
    await insertUsage({ id: 'use_a1', projectId: PROJECT_A, value: 1, ts: '2026-05-01T00:00:00.000Z' });
    await insertUsage({ id: 'use_a2', projectId: PROJECT_A, value: 2, ts: '2026-05-01T00:01:00.000Z' });
    await insertUsage({ id: 'use_a3', projectId: PROJECT_A, value: 3, ts: '2026-05-01T00:02:00.000Z' });
    await insertUsage({ id: 'use_b1', projectId: PROJECT_B, value: 10, ts: '2026-05-01T00:03:00.000Z' });

    const db = await getDb();
    const reporter = makeFakeReporter();
    const result = await reportUsage({ db, reporter, logger: makeFakeLogger(), nowIso: '2026-05-02T00:00:00.000Z' });

    expect(result.scanned).toBe(4);
    expect(result.reported).toBe(4);
    expect(result.records).toBe(2);
    expect(result.failed).toBe(false);

    // reporter 收到 2 条聚合记录：A=6, B=10
    expect(reporter.calls).toHaveLength(1);
    const byProject = Object.fromEntries(reporter.calls[0]!.map((r) => [r.projectId, r.value]));
    expect(byProject[PROJECT_A]).toBe(6);
    expect(byProject[PROJECT_B]).toBe(10);
    // windowEnd = nowIso
    expect(reporter.calls[0]!.every((r) => r.windowEnd === '2026-05-02T00:00:00.000Z')).toBe(true);

    // 所有行 reported_at 已回填
    const stillNull = await db.drizzle.select().from(usageEvents).where(isNull(usageEvents.reportedAt));
    expect(stillNull).toHaveLength(0);
  });

  it('reporter 抛错 → 行保持 NULL，failed=true，下 tick 重试成功', async () => {
    await insertUsage({ id: 'use_x', projectId: PROJECT_A, value: 5, ts: '2026-05-01T00:00:00.000Z' });

    const db = await getDb();
    const reporter = makeFakeReporter({ failOnce: true });

    // tick 1：reporter 抛错
    const r1 = await reportUsage({ db, reporter, logger: makeFakeLogger() });
    expect(r1.failed).toBe(true);
    expect(r1.reported).toBe(0);
    const afterFail = await db.drizzle.select().from(usageEvents).where(eq(usageEvents.id, 'use_x'));
    expect(afterFail[0]?.reportedAt).toBeNull();

    // tick 2：reporter 恢复，重抓同一行并上报
    const r2 = await reportUsage({ db, reporter, logger: makeFakeLogger(), nowIso: '2026-05-02T00:00:00.000Z' });
    expect(r2.failed).toBe(false);
    expect(r2.reported).toBe(1);
    const afterRetry = await db.drizzle.select().from(usageEvents).where(eq(usageEvents.id, 'use_x'));
    expect(afterRetry[0]?.reportedAt).toBe('2026-05-02T00:00:00.000Z');
    // reporter 被调了两次（fail + success）
    expect(reporter.calls).toHaveLength(2);
  });

  it('不变量：只回填本次捞到的 id —— report() 期间并发插入的新行不被误标', async () => {
    await insertUsage({ id: 'use_old', projectId: PROJECT_A, value: 1, ts: '2026-05-01T00:00:00.000Z' });

    const db = await getDb();
    // reporter 在 report() 执行中插入一条新的 unreported event（模拟并发 session close）。
    const sneakyReporter: MeterReporter = {
      kind: 'noop',
      async report() {
        await insertUsage({ id: 'use_new', projectId: PROJECT_A, value: 99, ts: '2026-05-01T00:05:00.000Z' });
      },
    };

    const result = await reportUsage({ db, reporter: sneakyReporter, logger: makeFakeLogger(), nowIso: '2026-05-02T00:00:00.000Z' });
    expect(result.scanned).toBe(1);
    expect(result.reported).toBe(1);

    // 老行被标 reported
    const oldRow = await db.drizzle.select().from(usageEvents).where(eq(usageEvents.id, 'use_old'));
    expect(oldRow[0]?.reportedAt).toBe('2026-05-02T00:00:00.000Z');
    // 并发插入的新行仍 NULL（下 tick 才会被处理），绝不被误标
    const newRow = await db.drizzle.select().from(usageEvents).where(eq(usageEvents.id, 'use_new'));
    expect(newRow[0]?.reportedAt).toBeNull();
  });

  it('batchSize 限制单 tick 处理量；剩余下 tick 处理', async () => {
    for (let i = 0; i < 5; i++) {
      await insertUsage({
        id: `use_batch_${i}`,
        projectId: PROJECT_A,
        value: 1,
        ts: `2026-05-01T00:0${i}:00.000Z`,
      });
    }

    const db = await getDb();
    const reporter = makeFakeReporter();
    const r1 = await reportUsage({ db, reporter, logger: makeFakeLogger(), batchSize: 2 });
    expect(r1.scanned).toBe(2);
    expect(r1.reported).toBe(2);

    const stillNull = await db.drizzle.select().from(usageEvents).where(isNull(usageEvents.reportedAt));
    expect(stillNull).toHaveLength(3);
  });
});

describe('startUsageReportJob', () => {
  it('intervalMs < 1000 → 抛错', () => {
    expect(() =>
      startUsageReportJob({
        intervalMs: 500,
        getDb,
        getMeterReporter: () => makeFakeReporter(),
        logger: makeFakeLogger(),
      }),
    ).toThrow(/intervalMs must be >= 1000/);
  });

  it('start + stop 不抛错', async () => {
    const job = startUsageReportJob({
      intervalMs: 1000,
      getDb,
      getMeterReporter: () => makeFakeReporter(),
      logger: makeFakeLogger(),
    });
    await job.stop();
    // 幂等：再 stop 一次也安全
    await job.stop();
  });
});
