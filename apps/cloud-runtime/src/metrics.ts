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
 *   auth_failures_total{reason}       counter (reason=missing|invalid|revoked)
 *   rate_limit_denied_total{tier}     counter (tier=strict|write|read)
 *   pool_state{state}                 gauge   (state=ready|busy|cap)
 *   http_request_duration_seconds{method,route,status_class} histogram
 *   mm_acquire_duration_seconds       histogram
 *
 * # 测试支持
 *
 *   `resetMetricsForTesting()` 清所有 series 让 test 之间不污染。
 */

import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

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
  help: 'session 关闭次数。reason=client(DELETE) | expired(reaper) | error(创建后失败)',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

export const authFailuresTotal = new Counter({
  name: 'auth_failures_total',
  help: 'auth 拒绝次数。reason=missing|invalid|revoked',
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
  help: 'MachineManager.acquire 耗时（拨 fly machine + 等 chromium 起来）',
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30, 60],
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
