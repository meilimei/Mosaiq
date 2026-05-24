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
  | 'request.invalid'
  | 'request.not_found'
  | 'pool.exhausted'
  | 'pool.pod_unhealthy'
  | 'rate.limit_exceeded'
  | 'session.not_found'
  | 'session.closed'
  | 'persona.not_found'
  | 'persona.duplicate'
  | 'machine.spawn_failed'
  | 'internal.unknown';

const statusByCode: Record<ErrorCode, number> = {
  'auth.invalid_key': 401,
  'auth.project_mismatch': 403,
  'auth.missing_token': 401,
  'request.invalid': 422,
  'request.not_found': 404,
  'pool.exhausted': 503,
  'pool.pod_unhealthy': 503,
  'rate.limit_exceeded': 429,
  'session.not_found': 404,
  'session.closed': 410,
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
    return c.json(apiErrorBody(err), err.status as 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503);
  }
  // unexpected: 不泄漏 stack 给客户端，只在日志里留下
  console.error('[cloud-runtime] unexpected error:', err);
  return c.json(
    apiErrorBody(new ApiError('internal.unknown', 'Internal server error')),
    500,
  );
}
