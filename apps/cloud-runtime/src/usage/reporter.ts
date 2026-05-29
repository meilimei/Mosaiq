/**
 * Phase 11.7: MeterReporter —— 把聚合后的用量推送给计费后端的可注入抽象。
 *
 * 两个实现：
 *   - NoopMeterReporter（默认，STRIPE_API_KEY 空）：只 log、不外呼。让
 *     "emit → aggregate → report(noop) → 标 reported" 全链路在没 Stripe 账号时
 *     也能端到端验证。
 *   - StripeMeterReporter（phase 11.7b，STRIPE_API_KEY 非空）：调 Stripe Billing
 *     Meter Events API（`POST /v1/billing/meter_events`），按 project → stripe
 *     customer 映射归属用量，idempotency key = `${projectId}:${windowEnd}:${kind}`
 *     （同时作为 meter event 的 `identifier` 与 HTTP `Idempotency-Key` header）。
 *
 * 工厂 getMeterReporter() + setMeterReporterForTesting() 套 machine/factory.ts 同款
 * module-singleton 模式。
 */

import { eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { projects } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { getLogger } from '../utils/logger.js';
import type { UsageKind } from './emitter.js';

/** fetch 注入点（单测 mock）。与 machine 层 FetchLike 同型。 */
export type FetchLike = typeof fetch;

/** 单条待上报的聚合用量记录。 */
export interface UsageRecord {
  projectId: string;
  kind: UsageKind;
  /** 聚合值（如本批 browser-minutes 求和）。 */
  value: number;
  /**
   * 这批用量的窗口右界（ISO）。用作 Stripe idempotency key 的一部分
   * （`${projectId}:${windowEnd}:${kind}`）。noop reporter 不消费它。
   */
  windowEnd: string;
}

export interface MeterReporter {
  readonly kind: 'noop' | 'stripe';
  /**
   * 推送一批记录。**失败抛错** —— job 据此不回填 reported_at、下个 tick 重试
   * （at-least-once；去重由 Stripe 侧 idempotency key 负责）。
   */
  report(records: UsageRecord[]): Promise<void>;
}

/**
 * 默认 reporter：不外呼、只 log。在没 Stripe 账号时把管道跑通（events 仍会被标
 * reported，验证 job 的回填逻辑）。
 */
export class NoopMeterReporter implements MeterReporter {
  readonly kind = 'noop' as const;

  async report(records: UsageRecord[]): Promise<void> {
    if (records.length === 0) return;
    getLogger().info(
      {
        count: records.length,
        totalValue: records.reduce((sum, r) => sum + r.value, 0),
      },
      'usage-report: noop reporter (set STRIPE_API_KEY to push Stripe Metered)',
    );
  }
}

/**
 * kind → Stripe meter `event_name`。11.7b 只有一种 kind。未知 kind 抛错，绝不
 * 把无法归属的用量静默丢给一个错的 meter。
 */
function meterEventNameFor(kind: UsageKind, sessionMinuteEventName: string): string {
  switch (kind) {
    case 'session.minute':
      return sessionMinuteEventName;
    default: {
      const exhaustive: never = kind;
      throw new Error(
        `StripeMeterReporter: no meter event_name mapping for kind=${String(exhaustive)}`,
      );
    }
  }
}

export interface StripeMeterReporterOptions {
  apiKey: string;
  /** Stripe API base URL（默认 https://api.stripe.com，单测覆盖到 mock）。 */
  baseUrl?: string;
  /** session.minute kind 的 Stripe meter event_name。 */
  sessionMinuteEventName: string;
  /**
   * project → stripe customer id 解析。返回 null = 该 project 还没接计费 →
   * report() 抛错（绝不静默丢账单）。
   */
  resolveStripeCustomerId: (projectId: string) => Promise<string | null>;
  /** fetch 注入。prod 走 global fetch。 */
  fetchImpl?: FetchLike;
  /** 注入 now（unix ms），单测固定 timestamp 用。 */
  nowMs?: () => number;
}

/**
 * Phase 11.7b: 真 Stripe Billing Meter Events 推送。
 *
 * 每条 UsageRecord 发一个 meter event：
 *   POST {baseUrl}/v1/billing/meter_events
 *   Authorization: Bearer {apiKey}
 *   Idempotency-Key: {projectId}:{windowEnd}:{kind}
 *   body(form): event_name, identifier, timestamp, payload[stripe_customer_id], payload[value]
 *
 * **至少一次 + Stripe 侧去重**：job 失败不回填 reported_at、下 tick 重抓重发；
 * 相同 `identifier` 的 meter event 被 Stripe 在聚合窗口内去重。任一条失败即抛错，
 * 整批本 tick 不回填、下 tick 重试（已成功的条目靠 identifier 去重不会重复计费）。
 *
 * **未映射 project**：resolveStripeCustomerId 返 null → 抛错（行保持 unreported，
 * `usage_events_unreported` gauge 会涨成可见报警），运维补 stripe_customer_id 后
 * 下 tick 自动恢复。绝不把无法归属的 billable minutes 静默标 reported。
 */
export class StripeMeterReporter implements MeterReporter {
  readonly kind = 'stripe' as const;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #sessionMinuteEventName: string;
  readonly #resolveStripeCustomerId: (projectId: string) => Promise<string | null>;
  readonly #fetchImpl: FetchLike;
  readonly #nowMs: () => number;

  constructor(opts: StripeMeterReporterOptions) {
    if (!opts.apiKey) throw new Error('StripeMeterReporter: apiKey required');
    if (!opts.sessionMinuteEventName) {
      throw new Error('StripeMeterReporter: sessionMinuteEventName required');
    }
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '');
    this.#sessionMinuteEventName = opts.sessionMinuteEventName;
    this.#resolveStripeCustomerId = opts.resolveStripeCustomerId;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#nowMs = opts.nowMs ?? (() => Date.now());
  }

  async report(records: UsageRecord[]): Promise<void> {
    if (records.length === 0) return;
    // 顺序推送：批量小（一个 (project,kind) 一条 / tick），且任一失败要整批重试，
    // 顺序让失败点确定、日志清晰。
    for (const record of records) {
      await this.#reportOne(record);
    }
  }

  async #reportOne(record: UsageRecord): Promise<void> {
    const customerId = await this.#resolveStripeCustomerId(record.projectId);
    if (!customerId) {
      throw new Error(
        `StripeMeterReporter: project ${record.projectId} has no stripe_customer_id; ` +
          'set it (admin setProjectStripeCustomer) before its usage can be billed',
      );
    }

    const eventName = meterEventNameFor(record.kind, this.#sessionMinuteEventName);
    const idempotencyKey = `${record.projectId}:${record.windowEnd}:${record.kind}`;
    const url = `${this.#baseUrl}/v1/billing/meter_events`;

    const form = new URLSearchParams();
    form.set('event_name', eventName);
    form.set('identifier', idempotencyKey);
    form.set('timestamp', String(Math.floor(this.#nowMs() / 1000)));
    form.set('payload[stripe_customer_id]', customerId);
    form.set('payload[value]', String(record.value));

    const resp = await this.#fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: form.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `StripeMeterReporter: meter_events ${resp.status} for project ${record.projectId} ` +
          `(${record.value} ${record.kind}): ${text.slice(0, 256)}`,
      );
    }
  }
}

let cached: MeterReporter | null = null;

/**
 * 按 env.STRIPE_API_KEY 选 reporter。
 *
 *   - 空（默认）→ NoopMeterReporter。
 *   - 非空 → StripeMeterReporter，customer 解析走 DB（projects.stripe_customer_id）。
 */
export function getMeterReporter(): MeterReporter {
  if (cached) return cached;
  const env = loadEnv();
  if (env.STRIPE_API_KEY === '') {
    cached = new NoopMeterReporter();
    return cached;
  }
  cached = new StripeMeterReporter({
    apiKey: env.STRIPE_API_KEY,
    baseUrl: env.STRIPE_API_BASE_URL,
    sessionMinuteEventName: env.STRIPE_METER_EVENT_NAME,
    resolveStripeCustomerId: resolveStripeCustomerIdFromDb,
  });
  return cached;
}

/**
 * 默认 customer 解析：查 projects.stripe_customer_id。空字符串视为未映射（→ null）。
 */
export async function resolveStripeCustomerIdFromDb(projectId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.drizzle
    .select({ stripeCustomerId: projects.stripeCustomerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const value = rows[0]?.stripeCustomerId ?? null;
  return value && value.length > 0 ? value : null;
}

/** 测试用：注入 fake reporter / 清缓存。 */
export function setMeterReporterForTesting(impl: MeterReporter | null): void {
  cached = impl;
}
