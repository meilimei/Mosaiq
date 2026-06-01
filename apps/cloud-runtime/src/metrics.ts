/**
 * Prometheus metrics 注册中心。
 *
 * # 设计原则
 *
 *   1) **单 process Registry**：模块级共享，所有 counter/gauge/histogram 都
 *      注册到同一个 Registry，/v1/metrics 拉一次性返回。
 *   2) **labels 控制 cardinality**：reason / tier / method 等限定枚举值，
 *      避免拿 sessionId / apiKeyId 当 label（会爆炸 series）。
 *   3) **拆 endpoint 维度时只用 route 模板**（'/v1/sessions/:id'）而非具体
 *      路径，否则每个 session 一组 series。
 *   4) **lazy init**：模块顶层 new Counter() —— 只 import 时执行一次，无副
 *      作用（不跑定时器、不监听）。
 *
 * # 暴露的指标列表
 *
 *   sessions_created_total            counter
 *   sessions_closed_total{reason}     counter (reason=client|expired|error)
 *   auth_failures_total{reason}       counter (reason=missing|invalid|revoked|dual_header)
 *   rate_limit_denied_total{tier}     counter (tier=strict|write|read)
 *   pool_state{state}                 gauge   (state=ready|busy|cap)
 *   http_request_duration_seconds{method,route,status_class} histogram
 *   mm_acquire_duration_seconds       histogram
 *
 *   ── Phase 11.3a Fly stopped-machine pool ──
 *   machine_pool_hits_total           counter (consume succeeded → fast path)
 *   machine_pool_misses_total{reason} counter (reason=starved|entry_failed)
 *   machine_pool_provisions_total{outcome} counter (outcome=success|failed)
 *   machine_pool_evictions_total{reason}   counter
 *     reason=max_age | bootstrap_stale | bootstrap_foreign | shutdown | consume_failed
 *   machine_pool_entries{state}       gauge (state=creating|stopped) — refreshed at scrape
 *
 * # 测试支持
 *
 *   `resetMetricsForTesting()` 清所有 series 让 test 之间不污染。
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// 单例 Registry —— 每个 process 一份。
export const metricsRegistry = new Registry();

// 默认 Node process metrics（CPU、event loop lag、heap、GC 等）
collectDefaultMetrics({ register: metricsRegistry, prefix: 'cloud_runtime_' });

// ─── counters ───────────────────────────────────────────────────────────────

export const sessionsCreatedTotal = new Counter({
  name: 'sessions_created_total',
  help: 'createSession 成功次数（计入 201 返回的）',
  registers: [metricsRegistry],
});

export const sessionsClosedTotal = new Counter({
  name: 'sessions_closed_total',
  help: 'session 关闭次数。reason=client(DELETE) | expired-ttl(reaper hit hard TTL) | expired-idle(reaper hit keepAlive idle timeout, phase 11.5) | error(创建后失败)',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

export const authFailuresTotal = new Counter({
  name: 'auth_failures_total',
  help: 'auth 拒绝次数。reason=missing|invalid|revoked|dual_header',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

export const rateLimitDeniedTotal = new Counter({
  name: 'rate_limit_denied_total',
  help: 'rate limit 拒绝次数。tier=strict|write|read',
  labelNames: ['tier'] as const,
  registers: [metricsRegistry],
});

// ─── gauges ─────────────────────────────────────────────────────────────────

export const poolStateGauge = new Gauge({
  name: 'pool_state',
  help: 'machine pool 当前状态。state=ready(空闲) | busy(被占) | cap(最大容量)',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
});

// ─── histograms ─────────────────────────────────────────────────────────────

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by method + route template + status_class.',
  // route 用模板路径（'/v1/sessions/:id'）防 cardinality 爆。
  // status_class 用 2xx/3xx/4xx/5xx 而非具体码，进一步压 series。
  labelNames: ['method', 'route', 'status_class'] as const,
  // bucket 选择：拨 fly machine 大概 3-15s（cold start），所以上界放到 30s。
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

export const mmAcquireDurationSeconds = new Histogram({
  name: 'mm_acquire_duration_seconds',
  help: 'MachineManager.acquire 耗时（拨 fly machine + 等 chromium 起来）。Phase 11.5: keepalive label 让 dashboard 分别画 keepAlive=true（一般 reconnect 不走 acquire）vs false（短会话）的延迟分布',
  // bucket 选择反映 phase 11.3a 灰度实测：
  //   - cold path (POOL_TARGET_SIZE=0): mean ~60s（首次部署 + image pull 后），上界
  //     必须放到 90s 才能让 P95 不挂在 +Inf。
  //   - warm path (pool consume): mean ~35s（Fly stopped→started + chrome boot），需
  //     要 40/50 这种细粒度 bucket 才能区分"warm 35s vs warm 45s"。
  //   - 120s 是 POOL_PROVISION_TIMEOUT_MS 的对照线——超过这线必定是 cold timeout，
  //     不应混进 warm 分布。
  labelNames: ['keepalive'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30, 40, 50, 60, 75, 90, 120],
  registers: [metricsRegistry],
});

// ─── Phase 11.5 keepAlive observability ─────────────────────────────────────

export const keepaliveSessionsActiveGauge = new Gauge({
  name: 'keepalive_sessions_active',
  help:
    'phase 11.5: 当前 status=live 且 keep_alive=true 的 session 数（按 project_id）。' +
    ' /v1/metrics scrape 时刷新。运维报警：长期接近 KEEPALIVE_SESSIONS_PER_PROJECT_MAX 说明该 customer 即将触限，' +
    '或 reaper / DELETE 路径有 leak。',
  labelNames: ['project_id'] as const,
  registers: [metricsRegistry],
});

// ─── Phase 11.6 Contexts (cookie/state persistence) observability ──────────
//
// 三个可被 cloud-runtime 真实观测的信号（pod-side tar/untar 耗时不在此——那需要
// pod→runtime metrics push，本期 out-of-scope）：
//   - contexts_active{project_id}：scrape 时从 contexts 表刷新，逼近 quota 报警
//   - contexts_total{op,outcome}：create/delete/download/snapshot 的成功/失败计数
//   - context_snapshot_bytes：snapshot 上传 blob 大小分布，size-limit 调参 + 容量规划

export const contextsActiveGauge = new Gauge({
  name: 'contexts_active',
  help:
    'phase 11.6: 当前未 soft-delete 的 context 数（按 project_id）。/v1/metrics scrape 时刷新。' +
    ' 长期逼近 MOSAIQ_CONTEXTS_PER_PROJECT_MAX 说明该 customer 即将触限。',
  labelNames: ['project_id'] as const,
  registers: [metricsRegistry],
});

export const contextsTotal = new Counter({
  name: 'contexts_total',
  help:
    'phase 11.6: context 操作计数。op=create|delete|download|snapshot，outcome=success|failed。' +
    ' download/snapshot 由 pod 经 internal endpoint 触发；create/delete 是客户 API。',
  labelNames: ['op', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const contextSnapshotBytes = new Histogram({
  name: 'context_snapshot_bytes',
  help:
    'phase 11.6: snapshot 上传 blob 大小（compressed + encrypted bytes）。' +
    ' 典型 chromium profile 5–20MB；上界对齐 MOSAIQ_CONTEXT_SIZE_MAX_MB(200MB default)。',
  // 64KB → 200MB 跨 4 个数量级，覆盖空 profile 到重 IndexedDB 站点。
  buckets: [
    64 * 1024,
    256 * 1024,
    1024 * 1024,
    5 * 1024 * 1024,
    20 * 1024 * 1024,
    50 * 1024 * 1024,
    100 * 1024 * 1024,
    200 * 1024 * 1024,
  ],
  registers: [metricsRegistry],
});

// ─── Phase 11.7 usage metering observability ────────────────────────────────
//
// 三个信号串起计费管道的健康度：
//   - usage_minutes_total{project_id}：emit 时累加的 billable 分钟数 counter，
//     dashboard 看每个 customer 的实时计费速率 / 营收曲线。project_id label 只在
//     有过用量的 customer 上增长（有界，同计费客户数），cardinality 安全。
//   - usage_events_unreported：scrape 时刷新的未上报积压数 gauge。长期 > 0 且增长 =
//     report job / Stripe push 卡住的报警信号（label-less，全局积压即健康信号）。
//   - usage_report_total{outcome}：report job push tick 的成功/失败计数，监控
//     pusher 健康度（outcome=success|failed）。

export const usageMinutesTotal = new Counter({
  name: 'usage_minutes_total',
  help:
    'phase 11.7: 累计 billable browser-minutes（按 project_id），session 关闭时 emit 累加。' +
    ' dashboard 看实时计费速率；× UNIT_PRICE_USD_PER_MINUTE ≈ 营收估算（真账单以 Stripe 为准）。',
  labelNames: ['project_id'] as const,
  registers: [metricsRegistry],
});

export const usageEventsUnreported = new Gauge({
  name: 'usage_events_unreported',
  help:
    'phase 11.7: 当前 reported_at IS NULL 的 usage_events 行数（待推送 Stripe 的积压）。' +
    ' /v1/metrics scrape 时刷新。长期 > 0 且持续增长 = report job 或 Stripe push 卡住，需报警。',
  registers: [metricsRegistry],
});

export const usageReportTotal = new Counter({
  name: 'usage_report_total',
  help: 'phase 11.7: usage-report job push tick 计数。outcome=success(本 tick 成功推送+回填) | failed(reporter 抛错，行保持未上报待重试)。',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

// ─── Phase 11.8 per-project quota enforcement ───────────────────────────────
//
// createSession 因 per-project 配额被拒的计数。reason=sessions(并发活跃 session 上限,
// SESSIONS_PER_PROJECT_MAX, 429) | minutes(月度 browser-minutes 上限,
// MINUTES_PER_PROJECT_PER_MONTH_MAX, 402)。持续高 = 该客户该升档 / 滥用 / cap 设太紧。
// 不加 project_id label（本期从简控 cardinality；需要分客户时 11.8b 加）。

export const quotaDeniedTotal = new Counter({
  name: 'quota_denied_total',
  help: 'phase 11.8: createSession 被 per-project 配额拒绝的次数。reason=sessions(并发上限) | minutes(月度用量上限)。',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

// ─── Phase 11.3a stopped-machine pool ──────────────────────────────────────
//
// 这些 counter/gauge 的目的：让 phased rollout（POOL_TARGET_SIZE 0 → 1 → 3）
// 能基于实测信号决策，而不是猜：
//   - pool_hits_total / pool_misses_total 比例 → 池实际命中率（要 > 80% 才值得调大）
//   - pool_provisions_total{outcome=failed} → Fly Machines API 健康度
//   - pool_evictions_total{max_age} → 池过期速率（调 POOL_MAX_AGE_SECONDS 依据）
//   - mm_acquire_duration_seconds 已有；通过 hits 比例反推 P50/P95 下降幅度
//
// 不加 sessionId / machineId / region 等 label —— series 爆炸；reason / outcome
// 等枚举字段值有限（≤6），cardinality 安全。

export const machinePoolHitsTotal = new Counter({
  name: 'machine_pool_hits_total',
  help: 'phase 11.3a: pool consume 成功次数（acquire 走快路径，命中预热 entry）',
  registers: [metricsRegistry],
});

export const machinePoolMissesTotal = new Counter({
  name: 'machine_pool_misses_total',
  help: 'phase 11.3a: pool consume 失败 → fallback cold path。reason=starved(池空) | entry_failed(entry 起不来)',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

export const machinePoolProvisionsTotal = new Counter({
  name: 'machine_pool_provisions_total',
  help: 'phase 11.3a: pool entry provision 次数。outcome=success | failed',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

export const machinePoolEvictionsTotal = new Counter({
  name: 'machine_pool_evictions_total',
  help: 'phase 11.3a: pool entry destroy 次数。reason=max_age | bootstrap_stale | bootstrap_foreign | shutdown | consume_failed',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

export const machinePoolEntriesGauge = new Gauge({
  name: 'machine_pool_entries',
  help: 'phase 11.3a: pool 当前 entry 数（按状态）。state=creating(provision 中) | stopped(ready to consume)',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
});

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * 把 HTTP 状态码归并到 2xx/3xx/4xx/5xx 标签，控制 cardinality。
 */
export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}

/**
 * 测试用：清掉所有 metric 当前值，但保留 series 注册。下次 inc/observe 仍正常。
 */
export function resetMetricsForTesting(): void {
  metricsRegistry.resetMetrics();
}
