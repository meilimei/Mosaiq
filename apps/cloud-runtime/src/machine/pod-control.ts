/**
 * pod 控制平面通信 —— 三个 MachineManager 实现的共享行为。
 *
 * 抽出来的原因：v0.11 phase 11.1 时只有 StaticPoolMachineManager，对 pod 的
 * /control/start 与 /control/stop 调用就直接写在 static.ts 里。phase 11.2 引入
 * FlyMachineManager + LocalDockerMachineManager 后，三方的「provision 一台
 * machine → 拿到 podOrigin → 调 pod /control/start」流程末段是 100% 相同的。
 *
 * 把它独立成纯函数，单测覆盖一次，三方调用即可复用，避免行为漂移（例如某天
 * 调整 startTimeoutMs 的语义时漏改其中一个 manager）。
 *
 * 同时把 host rewrite + 类型契约一并搬过来，static.ts 仅 re-export 维持向后
 * 兼容（既有单测 import `from './static.js'`）。
 */

import { ApiError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import type { AcquireSpec } from './types.js';

/** Fetch 可注入，方便单测。 */
export type FetchLike = typeof fetch;

/** Pod /control/start 请求体（POST JSON）。 */
export interface PodStartRequest {
  sessionId: string;
  /** 整个 Persona JSON，pod 自己解析需要的 cmdline flag。 */
  persona: unknown;
  stealth: {
    inject: boolean;
    humanize: boolean;
    rebrowserPatches: boolean;
  };
  viewport?: { width: number; height: number };
  ttlSeconds: number;
}

/** Pod /control/start 成功响应。 */
export interface PodStartResponse {
  /**
   * chromium 暴露的 CDP base URL。Pod 自报，host 部分一般是 0.0.0.0/localhost，
   * 调用方需用 rewriteCdpHost() 替换成 pod-internal 可路由地址再返给上层。
   */
  cdpUrl: string;
  /** pod 给的 machine id（pod 自己生成的 process-level id，不是 provider 的 machine id）。 */
  machineId: string;
}

/**
 * Pod /control/start 默认超时上限。
 *
 * pod 端 chromium spawn + waitForCdp 默认 POD_CHROMIUM_BOOT_TIMEOUT_MS=30_000，
 * 控制平面这边必须覆盖那个，否则我们 abort 后会留下孤儿 chromium。额外 5s
 * buffer 给 HTTP RTT + JSON 序列化。
 */
export const POD_START_DEFAULT_TIMEOUT_MS = 35_000;

/**
 * 把 chromium 自报的 ws URL（host 部分是 0.0.0.0/localhost）改成 pod origin
 * 的可路由 host，端口保持 chromium 报的（一般是 POD_CDP_PORT，与 pod origin
 * 的端口不同）。
 *
 * 例：
 *   cdp = ws://localhost:9223/devtools/browser/abc
 *   podOrigin = http://browser-pod-1:9222
 *   ⇒ ws://browser-pod-1:9223/devtools/browser/abc
 *
 * IPv6 host（Fly 6PN：`[fdaa:...]`）也支持 —— URL 类自动加方括号。
 */
export function rewriteCdpHost(cdpUrl: string, podOrigin: string): string {
  const cdp = new URL(cdpUrl);
  const pod = new URL(podOrigin);
  cdp.hostname = pod.hostname;
  if (!cdp.port) cdp.port = pod.port;
  return cdp.toString();
}

/**
 * 调 pod /control/start 让 chromium 起来。
 *
 * 错误映射：
 *   - fetch reject / abort         → ApiError('pool.pod_unhealthy', cause)
 *   - 4xx/5xx                     → ApiError('machine.spawn_failed', body excerpt)
 *   - 200 但 payload schema 错    → ApiError('machine.spawn_failed', 'invalid payload')
 */
export async function callPodStart(opts: {
  podOrigin: string;
  spec: AcquireSpec;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<PodStartResponse> {
  const log = getLogger();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? POD_START_DEFAULT_TIMEOUT_MS;

  const body: PodStartRequest = {
    sessionId: opts.spec.sessionId,
    persona: opts.spec.persona,
    stealth: opts.spec.stealth,
    ttlSeconds: opts.spec.ttlSeconds,
    ...(opts.spec.viewport ? { viewport: opts.spec.viewport } : {}),
    ...(opts.spec.context ? { context: opts.spec.context } : {}),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(`${opts.podOrigin}/control/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    const detail: Record<string, unknown> = { podOrigin: opts.podOrigin };
    if (err instanceof Error) detail.cause = err.message;
    log.error(detail, 'pod /control/start failed');
    throw new ApiError('pool.pod_unhealthy', 'pod /control/start failed', detail);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ApiError('machine.spawn_failed', `pod returned ${resp.status}`, {
      podOrigin: opts.podOrigin,
      body: text.slice(0, 256),
    });
  }

  const json = (await resp.json().catch(() => null)) as PodStartResponse | null;
  if (!json || typeof json.cdpUrl !== 'string' || typeof json.machineId !== 'string') {
    throw new ApiError('machine.spawn_failed', 'pod returned invalid /control/start payload', {
      podOrigin: opts.podOrigin,
    });
  }
  return json;
}

/**
 * 调 pod /control/stop —— best-effort 通知 pod 干净停止 chromium。
 *
 * 调用方一般在 release(machineId) 流程里调；失败不能抛错，因为 release 必须
 * 幂等（无论 pod 是否健康，控制平面侧的「machine 已释放」事实必须成立）。
 */
export async function callPodStop(opts: {
  podOrigin: string;
  machineId: string;
  fetchImpl?: FetchLike;
  /** 默认 5s，比 /control/start 短得多 —— stop 不需要等 chromium boot。 */
  timeoutMs?: number;
  /**
   * Phase 11.6: 若提供，pod 在 SIGKILL chromium 之后 + 删除 user-data-dir 之
   * 前，把 user-data-dir tar + AES-GCM 加密 + PUT 到此 URL。失败 log warn 但
   * 不阻止 pod 返回 200 给 /control/stop —— snapshot 与 lock 释放解耦。
   */
  snapshotUrl?: string;
}): Promise<void> {
  const log = getLogger();
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Phase 11.6: 带 snapshot 路径要给 pod 多 ~3s 完成 tar + encrypt + PUT
  // （typical 5–20MB context）。无 snapshot 维持原 5s 上限。
  const timeoutMs = opts.timeoutMs ?? (opts.snapshotUrl ? 15_000 : 5_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchImpl(`${opts.podOrigin}/control/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        machineId: opts.machineId,
        ...(opts.snapshotUrl ? { snapshotUrl: opts.snapshotUrl } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    log.warn(
      {
        machineId: opts.machineId,
        podOrigin: opts.podOrigin,
        cause: err instanceof Error ? err.message : String(err),
      },
      'pod /control/stop failed, ignoring (release must be idempotent)',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 轮询 pod /healthz 直到返回 200，或超时。
 *
 * 仅 dynamic provider（Fly / Docker）需要：新机器起来后 pod HTTP 还没监听，
 * 必须等到 /healthz OK 再调 /control/start，否则 fetch 立刻 ECONNREFUSED。
 *
 * StaticPool 不需要 —— pod 是预跑的，永远 ready。
 */
export async function waitForPodReady(opts: {
  podOrigin: string;
  fetchImpl?: FetchLike;
  /** 总超时上限 ms，默认 30s。 */
  timeoutMs?: number;
  /** 轮询间隔 ms，默认 250。 */
  intervalMs?: number;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const interval = opts.intervalMs ?? 250;
  let lastError: string | null = null;
  // 最近一次非 200 响应的 body 摘要——404 的内容是 hono 默认 "404 Not Found"
  // 还是别的服务器（chromium、nginx default page、HTML），直接决定后续诊断路径。
  let lastBody: string | null = null;
  let lastContentType: string | null = null;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const probeTimeout = Math.min(remaining, 2_000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), probeTimeout);
    try {
      const resp = await fetchImpl(`${opts.podOrigin}/healthz`, {
        method: 'GET',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (resp.ok) return;
      lastError = `pod /healthz returned ${resp.status}`;
      lastContentType = resp.headers.get('content-type');
      lastBody = (await resp.text().catch(() => '')).slice(0, 512);
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() + interval >= deadline) break;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new ApiError('pool.pod_unhealthy', 'pod did not become ready in time', {
    podOrigin: opts.podOrigin,
    lastError,
    ...(lastBody !== null ? { lastBody } : {}),
    ...(lastContentType !== null ? { lastContentType } : {}),
  });
}
