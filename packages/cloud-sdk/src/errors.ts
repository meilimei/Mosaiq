/**
 * Cloud SDK 抛错类型。镜像 cloud-runtime 的 ErrorCode，便于 LaunchAI 等
 * 调用方按 code 做差异化处理。
 */

export type CloudErrorCode =
  | 'auth.invalid_key'
  | 'auth.project_mismatch'
  | 'auth.missing_token'
  | 'request.invalid'
  | 'request.not_found'
  | 'pool.exhausted'
  | 'pool.keepalive_saturated'
  | 'pool.pod_unhealthy'
  | 'quota.sessions_exceeded'
  | 'quota.minutes_exceeded'
  | 'session.not_found'
  | 'session.closed'
  | 'session.sticky_conflict'
  | 'persona.not_found'
  | 'persona.duplicate'
  | 'machine.spawn_failed'
  | 'internal.unknown'
  | 'transport.network'
  | 'transport.timeout';

export class CloudApiError extends Error {
  readonly code: CloudErrorCode;
  readonly httpStatus: number;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: CloudErrorCode,
    message: string,
    httpStatus: number,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CloudApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface ServerErrorBody {
  error: { code: string; message: string; detail?: Record<string, unknown> };
}

export function fromServerErrorBody(status: number, body: unknown): CloudApiError {
  const e = (body as ServerErrorBody | null | undefined)?.error;
  if (e && typeof e.code === 'string' && typeof e.message === 'string') {
    return new CloudApiError(e.code as CloudErrorCode, e.message, status, e.detail);
  }
  return new CloudApiError(
    'internal.unknown',
    `Unexpected server response (status ${status})`,
    status,
  );
}
