/**
 * MosaiqCloudClient —— REST 客户端。
 *
 * v0.11 phase 11.1 surface：
 *   - createSession(input)        → ManagedCloudSession
 *   - listSessions(opts?)         → SessionInfo[]（phase 11.9）
 *   - getSession(id)              → SessionInfo
 *   - closeSession(id)            幂等
 *   - listPersonas()              当前 project + 全局 seed
 *   - getPersona(id)              详情含完整 Persona JSON
 *   - createPersona(persona)      上传一个 user persona
 *
 * 错误模型：所有非 2xx 响应抛 CloudApiError，code 镜像服务端 code。
 */

import type { Persona } from '@runova/persona-schema';

import { CloudApiError, fromServerErrorBody } from './errors.js';
import { ManagedCloudSession } from './session.js';

export interface MosaiqCloudClientOptions {
  /** 控制平面 base URL，例 'http://localhost:8787' / 'https://api.mosaiq.dev'。 */
  apiUrl: string;
  /** Bearer token，例 'msq_sk_live_xxxxxxxxxxxxxxxxxxxx'。 */
  apiKey: string;
  /** project_id，所有 createSession / persona 操作必填。 */
  projectId: string;
  /** 自定义 fetch（测试或代理用）。默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 请求超时（ms），默认 15_000。 */
  requestTimeoutMs?: number;
}

export interface StealthInput {
  /** 是否在 connectOverCDP 后注入 persona JS-level spoof。默认 true。 */
  inject?: boolean;
  /** 是否在 ManagedCloudSession.injectInto() 时绑定 Humanize。默认 true。 */
  humanize?: boolean;
  /** rebrowser-patches（pod 镜像默认带）。默认 true。 */
  rebrowserPatches?: boolean;
}

export type CreateSessionPersonaInput =
  | { id: string; inline?: never }
  | { inline: Persona; id?: never };

export interface CreateSessionInput {
  persona: CreateSessionPersonaInput;
  stealth?: StealthInput;
  /** TTL 秒数，max 7200。默认 1800。 */
  ttlSeconds?: number;
  viewport?: { width: number; height: number };
  clientLabel?: string;
}

export type SessionStatus = 'requested' | 'live' | 'closed' | 'errored';

/** Status filter values accepted by listSessions. Includes both Mosaiq native
 *  lowercase and Browserbase uppercase aliases (server normalizes). */
export type ListSessionsStatus =
  | SessionStatus
  | 'RUNNING'
  | 'COMPLETED'
  | 'ERROR'
  | 'TIMED_OUT';

export interface ListSessionsInput {
  /** Filter by session status. Accepts native lowercase or BB uppercase aliases. */
  status?: ListSessionsStatus;
  /** Filter by userMetadata. `key:value` matches userMetadata[key]; else substring. */
  q?: string;
  /** Max results (1–1000, default 100). */
  limit?: number;
}

export interface CreatedSession {
  id: string;
  projectId: string;
  status: SessionStatus;
  cdpUrl: string;
  persona: Persona;
  stealth: Required<StealthInput>;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
  liveViewUrl: string | null;
  clientLabel: string | null;
}

export interface SessionInfo {
  id: string;
  projectId: string;
  status: SessionStatus;
  cdpUrl: string;
  personaId: string | null;
  stealth: Required<StealthInput>;
  expiresAt: string;
  lastSeenAt: string;
  openedAt: string;
  closedAt: string | null;
  clientLabel: string | null;
}

interface CreateSessionApiResponse {
  id: string;
  project_id: string;
  status: SessionStatus;
  cdp_url: string;
  persona: Persona;
  stealth: Required<StealthInput>;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
  live_view_url: string | null;
  client_label: string | null;
}

interface GetSessionApiResponse {
  id: string;
  project_id: string;
  status: SessionStatus;
  cdp_url: string;
  persona_id: string | null;
  stealth: Required<StealthInput>;
  expires_at: string;
  last_seen_at: string;
  opened_at: string;
  closed_at: string | null;
  client_label: string | null;
}

export class MosaiqCloudClient {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly projectId: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: MosaiqCloudClientOptions) {
    if (!opts.apiUrl) throw new Error('MosaiqCloudClient: apiUrl required');
    if (!opts.apiKey) throw new Error('MosaiqCloudClient: apiKey required');
    if (!opts.projectId) throw new Error('MosaiqCloudClient: projectId required');
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.projectId = opts.projectId;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  async createSession(input: CreateSessionInput): Promise<ManagedCloudSession> {
    const stealth: Required<StealthInput> = {
      inject: input.stealth?.inject ?? true,
      humanize: input.stealth?.humanize ?? true,
      rebrowserPatches: input.stealth?.rebrowserPatches ?? true,
    };

    const body = {
      project_id: this.projectId,
      persona: input.persona.inline
        ? { inline: input.persona.inline }
        : { id: input.persona.id },
      stealth,
      lifecycle: { ttl_seconds: input.ttlSeconds ?? 1800 },
      ...(input.viewport ? { viewport: input.viewport } : {}),
      ...(input.clientLabel ? { client_label: input.clientLabel } : {}),
    };

    const resp = await this.#req<CreateSessionApiResponse>('POST', '/v1/sessions', body);
    const created: CreatedSession = {
      id: resp.id,
      projectId: resp.project_id,
      status: resp.status,
      cdpUrl: resp.cdp_url,
      persona: resp.persona,
      stealth: resp.stealth,
      expiresAt: resp.expires_at,
      lastSeenAt: resp.last_seen_at,
      createdAt: resp.created_at,
      liveViewUrl: resp.live_view_url,
      clientLabel: resp.client_label,
    };

    return new ManagedCloudSession({
      client: this,
      created,
    });
  }

  async getSession(id: string): Promise<SessionInfo> {
    const resp = await this.#req<GetSessionApiResponse>('GET', `/v1/sessions/${encodeURIComponent(id)}`);
    return {
      id: resp.id,
      projectId: resp.project_id,
      status: resp.status,
      cdpUrl: resp.cdp_url,
      personaId: resp.persona_id,
      stealth: resp.stealth,
      expiresAt: resp.expires_at,
      lastSeenAt: resp.last_seen_at,
      openedAt: resp.opened_at,
      closedAt: resp.closed_at,
      clientLabel: resp.client_label,
    };
  }

  async listSessions(input?: ListSessionsInput): Promise<SessionInfo[]> {
    const params = new URLSearchParams();
    if (input?.status !== undefined) params.set('status', input.status);
    if (input?.q !== undefined) params.set('q', input.q);
    if (input?.limit !== undefined) params.set('limit', String(input.limit));
    const qs = params.toString();
    const path = qs ? `/v1/sessions?${qs}` : '/v1/sessions';

    const resp = await this.#req<GetSessionApiResponse[]>('GET', path);
    return resp.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      status: r.status,
      cdpUrl: r.cdp_url,
      personaId: r.persona_id,
      stealth: r.stealth,
      expiresAt: r.expires_at,
      lastSeenAt: r.last_seen_at,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      clientLabel: r.client_label,
    }));
  }

  async closeSession(id: string): Promise<void> {
    await this.#req('DELETE', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  async listPersonas(): Promise<Array<{ id: string; source: string; projectId: string | null; createdAt: string; updatedAt: string }>> {
    const resp = await this.#req<{
      items: Array<{ id: string; source: string; project_id: string | null; created_at: string; updated_at: string }>;
    }>('GET', '/v1/personas');
    return resp.items.map((it) => ({
      id: it.id,
      source: it.source,
      projectId: it.project_id,
      createdAt: it.created_at,
      updatedAt: it.updated_at,
    }));
  }

  async getPersona(id: string): Promise<{ id: string; source: string; projectId: string | null; persona: Persona; createdAt: string; updatedAt: string }> {
    const resp = await this.#req<{
      id: string;
      source: string;
      project_id: string | null;
      persona: Persona;
      created_at: string;
      updated_at: string;
    }>('GET', `/v1/personas/${encodeURIComponent(id)}`);
    return {
      id: resp.id,
      source: resp.source,
      projectId: resp.project_id,
      persona: resp.persona,
      createdAt: resp.created_at,
      updatedAt: resp.updated_at,
    };
  }

  async createPersona(persona: Persona): Promise<{ id: string; source: string; projectId: string }> {
    const resp = await this.#req<{ id: string; source: string; project_id: string }>(
      'POST',
      '/v1/personas',
      persona,
    );
    return { id: resp.id, source: resp.source, projectId: resp.project_id };
  }

  async health(): Promise<{
    ok: boolean;
    version: string;
    machineManager: string;
    pool: { ready: number; busy: number; cap: number };
  }> {
    const resp = await this.#req<{
      ok: boolean;
      version: string;
      machine_manager: string;
      pool: { ready: number; busy: number; cap: number };
    }>('GET', '/v1/health', undefined, /* skipAuth */ true);
    return {
      ok: resp.ok,
      version: resp.version,
      machineManager: resp.machine_manager,
      pool: resp.pool,
    };
  }

  // ─── HTTP helper ─────────────────────────────────────────────────────────

  async #req<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    skipAuth?: boolean,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (!skipAuth) headers['authorization'] = `Bearer ${this.apiKey}`;

      let resp: Response;
      try {
        resp = await this.#fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new CloudApiError('transport.timeout', `request to ${url} timed out`, 0);
        }
        throw new CloudApiError(
          'transport.network',
          `network error to ${url}: ${err instanceof Error ? err.message : String(err)}`,
          0,
        );
      }

      if (resp.status === 204) return undefined as unknown as T;

      const ct = resp.headers.get('content-type') ?? '';
      const isJson = ct.includes('application/json');
      const payload: unknown = isJson ? await resp.json().catch(() => null) : await resp.text();

      if (!resp.ok) {
        throw fromServerErrorBody(resp.status, payload);
      }

      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
