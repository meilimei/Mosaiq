/**
 * 错误码与 API 错误响应统一。
 *
 * 每个抛错的地方应该 throw new ApiError(code, status, message, detail?)，
 * Hono onError middleware 会把它转成 JSON 响应。
 */

import type { Context } from 'hono';

export type ErrorCode =
  | 'auth.invalid_key'
  | 'auth.project_mismatch'
  | 'auth.missing_token'
  | 'auth.dual_header'
  | 'request.invalid'
  | 'request.not_found'
  | 'pool.exhausted'
  | 'pool.pod_unhealthy'
  | 'pool.keepalive_saturated'
  | 'pool.contexts_saturated'
  | 'quota.sessions_exceeded'
  | 'quota.minutes_exceeded'
  | 'rate.limit_exceeded'
  | 'session.not_found'
  | 'session.closed'
  | 'session.sticky_conflict'
  | 'persona.not_found'
  | 'persona.duplicate'
  | 'context.not_found'
  | 'context.in_use'
  | 'context.disabled'
  | 'machine.spawn_failed'
  | 'internal.unknown';

const statusByCode: Record<ErrorCode, number> = {
  'auth.invalid_key': 401,
  'auth.project_mismatch': 403,
  'auth.missing_token': 401,
  'auth.dual_header': 400,
  'request.invalid': 422,
  'request.not_found': 404,
  'pool.exhausted': 503,
  // Phase 11.6: per-project contexts quota hit (MOSAIQ_CONTEXTS_PER_PROJECT_MAX).
  // Client should DELETE an unused context before retrying. No Retry-After since
  // the resource is purely customer-managed (we don't reclaim contexts on a timer).
  'pool.contexts_saturated': 429,
  'pool.pod_unhealthy': 503,
  // Phase 11.5: per-project keepAlive quota hit; client should either close an
  // existing keepAlive session or wait (Retry-After header included in response).
  'pool.keepalive_saturated': 429,
  // Phase 11.8: per-project concurrent live-session cap (SESSIONS_PER_PROJECT_MAX)
  // hit -- applies to ALL sessions (the keepalive_saturated cap is a tighter
  // sub-limit checked additionally for keepAlive). Retryable after the client
  // closes a live session, so 429 + Retry-After (not 402 like the monthly usage
  // cap). detail = { activeCount, quota, retryAfterSeconds }.
  'quota.sessions_exceeded': 429,
  // Phase 11.8: per-project monthly browser-minute cap (MINUTES_PER_PROJECT_PER_MONTH_MAX)
  // hit -- applies to ALL sessions when configured (> 0). Returns 402 Payment Required
  // because releasing current resources doesn't solve it (user must wait for reset or upgrade).
  // detail = { usedMinutes, quotaMinutes, windowFrom, windowTo }.
  'quota.minutes_exceeded': 402,
  'rate.limit_exceeded': 429,
  // Phase 11.6: contextId not found / not owned by caller's project / soft-deleted.
  // Don't distinguish forbidden vs not-found here (avoid resource enumeration leak).
  'context.not_found': 404,
  // Phase 11.6: context is currently held by another live session
  // (contexts.active_session_id != NULL). detail contains { activeSessionId,
  // acquiredAt } so client can decide to wait, retry, or DELETE the holding session.
  'context.in_use': 409,
  // Phase 11.6: feature disabled (MOSAIQ_CONTEXT_MASTER_KEY not configured).
  // Same disable-by-default safety pattern as METRICS_TOKEN.
  'context.disabled': 503,
  'session.not_found': 404,
  'session.closed': 410,
  // Phase 11.5: same (projectId, stickyKey) already maps to a live session.
  // Detail contains { existingSessionId, expiresAt, connectUrl } so client can
  // one-step rejoin via chromium.connectOverCDP(detail.connectUrl).
  'session.sticky_conflict': 409,
  'persona.not_found': 404,
  'persona.duplicate': 409,
  'machine.spawn_failed': 500,
  'internal.unknown': 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = statusByCode[code];
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function apiErrorBody(err: ApiError): {
  error: {
    code: ErrorCode;
    message: string;
    detail?: Record<string, unknown>;
  };
} {
  const detail = err.detail;
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(detail !== undefined ? { detail } : {}),
    },
  };
}

/**
 * Hono onError handler。挂在 app.onError(handleApiError) 上。
 */
export function handleApiError(err: Error, c: Context): Response {
  if (isApiError(err)) {
    return c.json(
      apiErrorBody(err),
      err.status as 400 | 401 | 402 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503,
    );
  }
  // unexpected: 不泄漏 stack 给客户端，只在日志里留下
  console.error('[cloud-runtime] unexpected error:', err);
  return c.json(apiErrorBody(new ApiError('internal.unknown', 'Internal server error')), 500);
}
