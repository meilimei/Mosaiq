/**
 * pod 控制平面（HTTP）。
 *
 * 端点：
 *   GET  /healthz                  liveness + busy 状态
 *   POST /control/start            启动 chromium
 *   POST /control/stop             停 chromium
 *
 * 认证：v0.11 phase 11.1 不做 —— pod 在 docker 内部网络，仅控制平面可达。
 *   pod 暴露给公网将在 phase 11.2 (Fly.io) 时加 mTLS。
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { parsePersona } from '@mosaiq/persona-schema';

import { getRunning, killChromium, spawnChromium } from './chromium.js';
import { getLogger } from './logger.js';
import { newId } from './ids.js';

const StartSchema = z.object({
  sessionId: z.string().min(1),
  persona: z.unknown(),
  stealth: z
    .object({
      inject: z.boolean(),
      humanize: z.boolean(),
      rebrowserPatches: z.boolean(),
    })
    .optional(),
  viewport: z
    .object({
      width: z.number().int().min(320).max(7680),
      height: z.number().int().min(240).max(4320),
    })
    .optional(),
  ttlSeconds: z.number().int().min(60).max(86400),
  // Phase 11.6: 若提供，chromium 启动前 GET context.loadUrl 装载 user-data-dir。
  context: z
    .object({
      loadUrl: z.string().url(),
      projectId: z.string().min(1),
    })
    .optional(),
});

const StopSchema = z.object({
  machineId: z.string().min(1),
  // Phase 11.6: 若提供，kill 后、rm user-data-dir 前 tar+encrypt+PUT 回写 context。
  snapshotUrl: z.string().url().optional(),
});

export function createApp(): Hono {
  const app = new Hono();
  const log = getLogger();

  app.get('/healthz', (c) => {
    const running = getRunning();
    return c.json({
      ok: true,
      service: 'browser-pod',
      version: '0.11.0',
      busy: running !== null,
      machineId: running?.machineId ?? null,
      pid: running?.pid ?? null,
    });
  });

  app.post('/control/start', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = StartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 422);
    }
    const req = parsed.data;

    let persona: ReturnType<typeof parsePersona>;
    try {
      persona = parsePersona(req.persona);
    } catch (err) {
      return c.json(
        {
          error: 'persona schema validation failed',
          message: err instanceof Error ? err.message : String(err),
        },
        422,
      );
    }

    if (getRunning()) {
      return c.json({ error: 'pod busy', machineId: getRunning()?.machineId }, 409);
    }

    const machineId = newId();

    let info: Awaited<ReturnType<typeof spawnChromium>>;
    try {
      info = await spawnChromium({
        machineId,
        persona,
        ttlSeconds: req.ttlSeconds,
        ...(req.viewport ? { viewport: req.viewport } : {}),
        ...(req.context ? { context: req.context } : {}),
      });
    } catch (err) {
      log.error({ err, sessionId: req.sessionId }, 'spawnChromium failed');
      return c.json(
        {
          error: 'spawn failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    return c.json(
      {
        machineId: info.machineId,
        cdpUrl: info.cdpUrl, // path-only, 控制平面拼 host
      },
      200,
    );
  });

  app.post('/control/stop', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = StopSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 422);
    }
    await killChromium(parsed.data.machineId, {
      ...(parsed.data.snapshotUrl ? { snapshotUrl: parsed.data.snapshotUrl } : {}),
    });
    return c.body(null, 204);
  });

  app.get('/', (c) =>
    c.json({
      service: 'mosaiq-browser-pod',
      version: '0.11.0',
      docs: 'https://github.com/meilimei/Mosaiq/blob/main/docs/CLOUD-V0-IMPLEMENTATION.md',
    }),
  );

  return app;
}
