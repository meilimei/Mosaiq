import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

describe('browser-pod createApp() — route smoke', () => {
  it('GET /healthz → 200 with ok=true', async () => {
    const app = createApp();
    const resp = await app.fetch(new Request('http://pod.local/healthz'));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      service: 'browser-pod',
      busy: false,
    });
    expect(body.version).toBe('0.11.0');
    // captcha 计数字段恒存在；空闲 pod 为 null。
    expect(body.captcha).toBeNull();
  });

  it('GET / → 200 with service marker', async () => {
    const app = createApp();
    const resp = await app.fetch(new Request('http://pod.local/'));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.service).toBe('mosaiq-browser-pod');
  });

  it('GET /unknown → 404', async () => {
    const app = createApp();
    const resp = await app.fetch(new Request('http://pod.local/unknown'));
    expect(resp.status).toBe(404);
  });

  it('POST /control/start with empty body → 422 (Zod validation)', async () => {
    const app = createApp();
    const resp = await app.fetch(
      new Request('http://pod.local/control/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(resp.status).toBe(422);
  });
});
