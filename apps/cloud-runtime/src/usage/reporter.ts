/**
 * Phase 11.7: MeterReporter —— 把聚合后的用量推送给计费后端的可注入抽象。
 *
 * 为什么抽象掉 Stripe：真调用需要 Stripe 账号 + meter/price id + per-project
 * customer 映射（projects.stripe_customer_id，phase 11.7b 才加）。11.7a 先把
 * 接口与管道跑通：
 *   - NoopMeterReporter（默认，STRIPE_API_KEY 空）：只 log、不外呼。让
 *     "emit → aggregate → report(noop) → 标 reported" 全链路在没 Stripe 账号时
 *     也能端到端验证。
 *   - StripeMeterReporter（phase 11.7b，STRIPE_API_KEY 非空）：调 Stripe Billing
 *     Meter Events API，idempotency key = `${projectId}:${windowEnd}:${kind}`。
 *
 * 工厂 getMeterReporter() + setMeterReporterForTesting() 套 machine/factory.ts 同款
 * module-singleton 模式。
 */

import { loadEnv } from '../env.js';
import { getLogger } from '../utils/logger.js';
import type { UsageKind } from './emitter.js';

/** 单条待上报的聚合用量记录。 */
export interface UsageRecord {
  projectId: string;
  kind: UsageKind;
  /** 聚合值（如本批 browser-minutes 求和）。 */
  value: number;
  /**
   * 这批用量的窗口右界（ISO）。phase 11.7b 用作 Stripe idempotency key 的一部分
   * （`${projectId}:${windowEnd}:${kind}`）。11.7a noop 不消费它。
   */
  windowEnd: string;
}

export interface MeterReporter {
  readonly kind: 'noop' | 'stripe';
  /**
   * 推送一批记录。**失败抛错** —— job 据此不回填 reported_at、下个 tick 重试
   * （at-least-once；去重由 Stripe 侧 idempotency key 负责，phase 11.7b）。
   */
  report(records: UsageRecord[]): Promise<void>;
}

/**
 * 默认 reporter：不外呼、只 log。11.7a 用它把管道跑通（events 仍会被标 reported，
 * 验证 job 的回填逻辑）。
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
      'usage-report: noop reporter (set STRIPE_API_KEY + phase 11.7b to push Stripe Metered)',
    );
  }
}

let cached: MeterReporter | null = null;

/**
 * 按 env.STRIPE_API_KEY 选 reporter。
 *
 *   - 空（默认）→ NoopMeterReporter。
 *   - 非空 → 本该是 StripeMeterReporter，但 phase 11.7a 还没实现，所以 **fail-fast**：
 *     配了 key 却没真推送实现，宁可启动报错也绝不静默把 events 标 reported 而其实
 *     从没推过 Stripe（那等于无声丢营收）。phase 11.7b 在这里替换成真实现。
 */
export function getMeterReporter(): MeterReporter {
  if (cached) return cached;
  const env = loadEnv();
  if (env.STRIPE_API_KEY === '') {
    cached = new NoopMeterReporter();
    return cached;
  }
  throw new Error(
    'STRIPE_API_KEY is set but StripeMeterReporter is not implemented yet (phase 11.7b). ' +
      'Unset STRIPE_API_KEY to use the noop reporter for now.',
  );
}

/** 测试用：注入 fake reporter / 清缓存。 */
export function setMeterReporterForTesting(impl: MeterReporter | null): void {
  cached = impl;
}
