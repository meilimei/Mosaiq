import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Persona } from '@runova/persona-schema';

import { CloudApiError } from './errors.js';
import { MosaiqCloudClient } from './client.js';
import { ManagedCloudSession } from './session.js';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../tests/fixtures/personas/win11-chrome-us.json',
);
const PERSONA = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Persona;

function makeFakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return ((url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;
}

const baseOpts = {
  apiUrl: 'http://api.test',
  apiKey: 'msq_sk_test_xxxxxxxxxxxxxxxxxxxxxx',
  projectId: 'proj_test',
};

describe('MosaiqCloudClient — constructor', () => {
  it('校验必填', () => {
    expect(() => new MosaiqCloudClient({ ...baseOpts, apiUrl: '' })).toThrow(/apiUrl/);
    expect(() => new MosaiqCloudClient({ ...baseOpts, apiKey: '' })).toThrow(/apiKey/);
    expect(() => new MosaiqCloudClient({ ...baseOpts, projectId: '' })).toThrow(/projectId/);
  });
  it('剥末尾斜杠', () => {
    const c = new MosaiqCloudClient({ ...baseOpts, apiUrl: 'http://x.test///' });
    expect(c.apiUrl).toBe('http://x.test');
  });
});

describe('MosaiqCloudClient.createSession', () => {
  it('POST 带 Authorization + 返回 ManagedCloudSession', async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    const fetchImpl = makeFakeFetch(async (url, init) => {
      captured = { url, init };
      const body = {
        id: 'ses_abc',
        project_id: 'proj_test',
        status: 'live',
        cdp_url: 'ws://api.test/v1/sessions/ses_abc/cdp',
        persona: PERSONA,
        stealth: { inject: true, humanize: true, rebrowserPatches: true },
        expires_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        live_view_url: null,
        client_label: null,
      };
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    const sess = await client.createSession({
      persona: { inline: PERSONA },
    });
    expect(sess).toBeInstanceOf(ManagedCloudSession);
    expect(sess.id).toBe('ses_abc');
    expect(sess.cdpUrl).toContain('/v1/sessions/ses_abc/cdp');
    expect(captured!.url).toBe('http://api.test/v1/sessions');
    const headers = (captured!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${baseOpts.apiKey}`);
    const reqBody = JSON.parse(String(captured!.init?.body)) as {
      project_id: string;
      persona: { inline: unknown };
      stealth: { inject: boolean };
      lifecycle: { ttl_seconds: number };
    };
    expect(reqBody.project_id).toBe('proj_test');
    expect(reqBody.persona).toHaveProperty('inline');
    expect(reqBody.stealth).toEqual({ inject: true, humanize: true, rebrowserPatches: true });
    expect(reqBody.lifecycle.ttl_seconds).toBe(1800);
  });

  it('keepAlive + userMetadata → request body 含 BB-shape 字段', async () => {
    let body: Record<string, unknown> | null = null;
    const fetchImpl = makeFakeFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'ses_xyz',
          project_id: 'proj_test',
          status: 'live',
          cdp_url: 'ws://x',
          persona: PERSONA,
          stealth: { inject: true, humanize: true, rebrowserPatches: true },
          expires_at: 'x',
          last_seen_at: 'x',
          created_at: 'x',
          live_view_url: null,
          client_label: null,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    await client.createSession({
      persona: { id: 'pers_abc' },
      keepAlive: true,
      userMetadata: { stickyKey: 'reddit:user_1' },
      ttlSeconds: 86_400,
    });
    expect(body!.keepAlive).toBe(true);
    expect(body!.userMetadata).toEqual({ stickyKey: 'reddit:user_1' });
    expect((body!.lifecycle as { keep_alive: boolean }).keep_alive).toBe(true);
    expect((body!.lifecycle as { ttl_seconds: number }).ttl_seconds).toBe(86_400);
  });

  it('persona.id 形式 → request body { id }', async () => {
    let body: { persona: unknown } | null = null;
    const fetchImpl = makeFakeFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as { persona: unknown };
      return new Response(
        JSON.stringify({
          id: 'ses_xyz',
          project_id: 'proj_test',
          status: 'live',
          cdp_url: 'ws://x',
          persona: PERSONA,
          stealth: { inject: true, humanize: true, rebrowserPatches: true },
          expires_at: 'x',
          last_seen_at: 'x',
          created_at: 'x',
          live_view_url: null,
          client_label: null,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    await client.createSession({ persona: { id: 'pers_abc' } });
    expect(body!.persona).toEqual({ id: 'pers_abc' });
  });

  it('服务端 401 → CloudApiError(auth.invalid_key)', async () => {
    const fetchImpl = makeFakeFetch(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 'auth.invalid_key', message: 'unknown API key' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    await expect(client.createSession({ persona: { inline: PERSONA } })).rejects.toMatchObject({
      code: 'auth.invalid_key',
      httpStatus: 401,
    } as CloudApiError);
  });

  it('网络错误 → CloudApiError(transport.network)', async () => {
    const fetchImpl = makeFakeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    await expect(client.createSession({ persona: { inline: PERSONA } })).rejects.toMatchObject({
      code: 'transport.network',
    } as CloudApiError);
  });

  it('createSessionOrRejoin: sticky_conflict 409 → rejoin 已有 session', async () => {
    let postCount = 0;
    const fetchImpl = makeFakeFetch(async (url, init) => {
      if (init?.method === 'POST') {
        postCount++;
        return new Response(
          JSON.stringify({
            error: {
              code: 'session.sticky_conflict',
              message: 'sticky key in use',
              detail: {
                existingSessionId: 'ses_existing',
                connectUrl: 'ws://api.test/v1/sessions/ses_existing/cdp?token=t',
                expiresAt: '2026-06-02T00:00:00Z',
              },
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/v1/sessions/ses_existing') && init?.method !== 'DELETE') {
        return new Response(
          JSON.stringify({
            id: 'ses_existing',
            project_id: 'proj_test',
            status: 'live',
            cdp_url: 'ws://api.test/v1/sessions/ses_existing/cdp',
            persona_id: 'pers_abc',
            stealth: { inject: true, humanize: true, rebrowserPatches: true },
            expires_at: '2026-06-02T00:00:00Z',
            last_seen_at: '2026-06-01T00:00:00Z',
            opened_at: '2026-05-30T00:00:00Z',
            closed_at: null,
            client_label: 'launchai:u:reddit',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/v1/personas/pers_abc')) {
        return new Response(
          JSON.stringify({
            id: 'pers_abc',
            source: 'seed',
            project_id: 'proj_test',
            persona: PERSONA,
            created_at: 'x',
            updated_at: 'x',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(null, { status: 404 });
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    const sess = await client.createSessionOrRejoin({
      persona: { id: 'pers_abc' },
      keepAlive: true,
      userMetadata: { stickyKey: 'launchai:u:reddit' },
    });
    expect(postCount).toBe(1);
    expect(sess.id).toBe('ses_existing');
    expect(sess.cdpUrl).toContain('ses_existing');
    expect(sess.keepAlive).toBe(true);
  });
});

describe('MosaiqCloudClient.listSessions', () => {
  const SESSION_RESPONSE = {
    id: 'ses_001',
    project_id: 'proj_test',
    status: 'live' as const,
    cdp_url: 'ws://api.test/v1/sessions/ses_001/cdp',
    persona_id: 'pers_x',
    stealth: { inject: true, humanize: true, rebrowserPatches: true },
    expires_at: '2026-06-01T00:00:00Z',
    last_seen_at: '2026-06-01T00:00:00Z',
    opened_at: '2026-05-30T00:00:00Z',
    closed_at: null,
    client_label: 'test-runner',
  };

  it('GET /v1/sessions（无参数）→ SessionInfo[]', async () => {
    let capturedUrl = '';
    const fetchImpl = makeFakeFetch(async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify([SESSION_RESPONSE]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    const sessions = await client.listSessions();
    expect(capturedUrl).toBe('http://api.test/v1/sessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('ses_001');
    expect(sessions[0]!.projectId).toBe('proj_test');
    expect(sessions[0]!.status).toBe('live');
    expect(sessions[0]!.cdpUrl).toBe(SESSION_RESPONSE.cdp_url);
    expect(sessions[0]!.personaId).toBe('pers_x');
    expect(sessions[0]!.openedAt).toBe(SESSION_RESPONSE.opened_at);
    expect(sessions[0]!.closedAt).toBeNull();
    expect(sessions[0]!.clientLabel).toBe('test-runner');
  });

  it('query params 正确拼接（status + q + limit）', async () => {
    let capturedUrl = '';
    const fetchImpl = makeFakeFetch(async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    await client.listSessions({ status: 'RUNNING', q: 'env:prod', limit: 10 });
    const u = new URL(capturedUrl);
    expect(u.searchParams.get('status')).toBe('RUNNING');
    expect(u.searchParams.get('q')).toBe('env:prod');
    expect(u.searchParams.get('limit')).toBe('10');
  });

  it('空数组正常返回', async () => {
    const fetchImpl = makeFakeFetch(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    const sessions = await client.listSessions();
    expect(sessions).toEqual([]);
  });

  it('服务端 422 → CloudApiError', async () => {
    const fetchImpl = makeFakeFetch(async () => {
      return new Response(
        JSON.stringify({ error: { code: 'request.invalid', message: 'bad status' } }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    await expect(client.listSessions({ status: 'garbage' as 'live' })).rejects.toMatchObject({
      code: 'request.invalid',
      httpStatus: 422,
    } as CloudApiError);
  });
});

describe('MosaiqCloudClient.health', () => {
  it('不带 Authorization', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = makeFakeFetch(async (_url, init) => {
      captured = init;
      return new Response(
        JSON.stringify({
          ok: true,
          version: '0.11.0',
          machine_manager: 'static',
          pool: { ready: 1, busy: 0, cap: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new MosaiqCloudClient({ ...baseOpts, fetchImpl });
    const h = await client.health();
    expect(h.machineManager).toBe('static');
    const headers = (captured?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });
});
