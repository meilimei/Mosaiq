/**
 * /v1/sessions REST handlers。
 *
 * 设计稿 §5.1-5.4：
 *   POST   /v1/sessions          —— 创建 session（acquire machine + 入库）
 *   GET    /v1/sessions/:id      —— 取详情
 *   DELETE /v1/sessions/:id      —— 幂等关闭
 *
 * WebSocket /v1/sessions/:id/cdp 不在本文件，因为 Hono 不直接处理 ws upgrade，
 * 它在 src/index.ts 注册到 raw http server 上（用 ws 库），
 * 调用 cdp/proxy.ts 完成反向代理。
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../db/client.js';
import { personas as personasTable, sessions as sessionsTable } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { getMachineManager } from '../machine/factory.js';
import { audit } from '../middleware/audit.js';
import { getAuth } from '../middleware/auth.js';
import { rateLimitTier } from '../middleware/rate-limit.js';
import {
  mmAcquireDurationSeconds,
  sessionsClosedTotal,
  sessionsCreatedTotal,
} from '../metrics.js';
import { ApiError } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { getLogger } from '../utils/logger.js';
import { parsePersona, type Persona } from '@mosaiq/persona-schema';

export const sessionsRoute = new Hono();

const StealthInputSchema = z
  .object({
    inject: z.boolean().default(true),
    humanize: z.boolean().default(true),
    rebrowserPatches: z.boolean().default(true),
  })
  .default({ inject: true, humanize: true, rebrowserPatches: true });

const ViewportSchema = z.object({
  width: z.number().int().min(320).max(7680),
  height: z.number().int().min(240).max(4320),
});

const LifecycleSchema = z
  .object({
    ttl_seconds: z.number().int().min(60).optional(),
    keep_alive: z.boolean().optional(),
  })
  .default({});

const PersonaInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    inline: z.unknown().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.id && v.inline === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'persona.id or persona.inline is required',
      });
    }
    if (v.id && v.inline !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'persona.id and persona.inline are mutually exclusive',
      });
    }
  });

/**
 * Browserbase `browserSettings` 子结构 —— 我们只挑出 `viewport`（与原生同形），
 * 其他字段（fingerprint / blockAds / solveCaptchas / ...）一律收集到 unsupportedFields
 * 并 warn-log。passthrough 让未知 key 不被 strip 掉，方便后续记录。
 */
const BrowserSettingsSchema = z
  .object({
    viewport: ViewportSchema.optional(),
  })
  .passthrough();

/**
 * Phase 11.4 commit 3：CreateSessionSchema 升级为 native(snake_case) ∪ BB(camelCase) 超集。
 *
 * - `project_id` / `projectId` 任一可选；handler 校验「两者同存且不一致」时 400。
 *   两者都缺 → 默认使用 auth.projectId（BB SDK 不带 project_id 走 X-BB-API-Key 路径）。
 * - `persona` 变成 schema 层 optional —— 缺失时 handler 抛 `request.invalid`，commit 4
 *   会接上默认 seeded persona 让此路径不再报错。
 * - BB-only 字段：用 `.optional()` 接住，handler 把出现的字段名 push 进 unsupportedFields[]。
 */
const CreateSessionSchema = z.object({
  // ── Mosaiq native (snake_case) ──
  project_id: z.string().min(1).optional(),
  persona: PersonaInputSchema.optional(),
  stealth: StealthInputSchema,
  lifecycle: LifecycleSchema,
  viewport: ViewportSchema.optional(),
  client_label: z.string().max(128).optional(),

  // ── Browserbase compat (camelCase) ──
  /** 与 project_id 同义；两者同时给且不一致 → 400 */
  projectId: z.string().min(1).optional(),
  /** 用户自定义元数据，原样落库 row.userMetadata 列；shapeSession 回显 */
  userMetadata: z.record(z.unknown()).optional(),
  /** browserSettings.viewport → 等价 native viewport；其他子字段忽略并 warn */
  browserSettings: BrowserSettingsSchema.optional(),

  // ── Browserbase 字段，我们暂不实现，收到就 warn-and-ignore ──
  /** TTL 我们已通过 SESSION_TTL_MAX_SECONDS 强制封顶，keepAlive=true 不改变这个语义 */
  keepAlive: z.boolean().optional(),
  /** 录像（M9 milestone） */
  recording: z.unknown().optional(),
  /** 远端 logging（M9 milestone） */
  logging: z.unknown().optional(),
  /** BYOP 代理（独立 phase） */
  proxies: z.unknown().optional(),
  /** Browserbase Chrome extension 安装（不在 v0.11 范围） */
  extensionId: z.string().optional(),
  /** 区域路由，单 region 部署不需要 */
  region: z.string().optional(),
  /** 时区 —— Mosaiq 把时区放在 persona.metadata 里，与 BB 模型不同 */
  timezone: z.string().optional(),
});

type StealthOpts = z.infer<typeof StealthInputSchema>;

function publicCdpUrl(sessionId: string): string {
  const base = loadEnv().PUBLIC_BASE_URL;
  // http→ws、https→wss
  const wsBase = base.replace(/^http/, 'ws');
  return `${wsBase}/v1/sessions/${sessionId}/cdp`;
}

/**
 * 把 DB 行 + persona JSON 拼成 API 响应形状。
 *
 * **Phase 11.4 native superset**：返回同时含
 *   - Mosaiq native 字段（snake_case，现有 caller：prod-smoke-cloud.mjs、CLI、桌面端）
 *   - Browserbase SDK 兼容字段（camelCase，供 @browserbasehq/sdk 以及 Stagehand 读取）
 *
 * `persona` 在 GET 路径会是 null（v0.11 phase 11.1 简化：不在 GET 重拉
 * 完整 Persona）。POST 创建路径传完整 Persona。
 *
 * 详细字段映射见 `docs/PHASE-11.4-STAGEHAND-COMPAT.md` §4。
 */
function shapeSession(
  row: typeof sessionsTable.$inferSelect,
  personaJson: Persona | null,
  stealth: StealthOpts,
) {
  let userMetadataParsed: Record<string, unknown> = {};
  try {
    if (row.userMetadata) {
      const parsed = JSON.parse(row.userMetadata) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        userMetadataParsed = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 解析失败 → 空对象，不报错 响应。
  }
  const updatedAt = row.lastSeenAt ?? row.openedAt;

  return {
    // ── Mosaiq native shape (snake_case) ──
    id: row.id,
    project_id: row.projectId,
    persona_id: row.personaId,
    status: row.status,
    cdp_url: row.cdpPublicUrl,
    persona: personaJson,
    stealth,
    expires_at: row.expiresAt,
    last_seen_at: row.lastSeenAt,
    opened_at: row.openedAt,
    closed_at: row.closedAt,
    live_view_url: null,
    created_at: row.openedAt,
    client_label: row.clientLabel ?? null,

    // ── Browserbase SDK compat (camelCase, phase 11.4) ──
    createdAt: row.openedAt,
    updatedAt,
    projectId: row.projectId,
    startedAt: row.openedAt,
    expiresAt: row.expiresAt,
    endedAt: row.closedAt,
    proxyBytes: 0,
    keepAlive: false,
    connectUrl: row.cdpPublicUrl,
    seleniumRemoteUrl: null as string | null,
    signingKey: null as string | null,
    contextId: null as string | null,
    userMetadata: userMetadataParsed,
  };
}

// ─── POST /v1/sessions ──────────────────────────────────────────────────────

sessionsRoute.post('/', rateLimitTier('strict'), async (c) => {
  const env = loadEnv();
  const auth = getAuth(c);
  const log = getLogger();

  const body = await c.req.json().catch(() => null);
  const parsed = CreateSessionSchema.safeParse(body);
  if (!parsed.success) {
    audit(c, 'session.create', 'session:?', 'errored', { issues: parsed.error.issues });
    throw new ApiError('request.invalid', 'invalid create-session payload', {
      issues: parsed.error.issues,
    });
  }
  const req = parsed.data;

  // ── Phase 11.4 commit 3: BB-shape 兼容。先 reconcile project id ──
  // 接受 native(project_id) 或 BB(projectId)；两者同时给且不一致 → 400。
  if (req.project_id && req.projectId && req.project_id !== req.projectId) {
    audit(c, 'session.create', 'project:?', 'denied');
    throw new ApiError(
      'request.invalid',
      'project_id (snake_case) and projectId (camelCase) were both supplied with different values',
    );
  }
  const requestedProjectId = req.project_id ?? req.projectId;
  if (requestedProjectId && requestedProjectId !== auth.projectId) {
    audit(c, 'session.create', `project:${requestedProjectId}`, 'denied');
    throw new ApiError('auth.project_mismatch', 'API key does not belong to this project');
  }
  // 没给 project id 时，从 auth 推断（BB SDK 默认行为）。

  // 收集所有「我们暂不实现」的 BB 字段，落到 response.unsupportedFields[] 与 warn 日志。
  const unsupportedFields: string[] = [];
  if (req.keepAlive !== undefined) unsupportedFields.push('keepAlive');
  if (req.recording !== undefined) unsupportedFields.push('recording');
  if (req.logging !== undefined) unsupportedFields.push('logging');
  if (req.proxies !== undefined) unsupportedFields.push('proxies');
  if (req.extensionId !== undefined) unsupportedFields.push('extensionId');
  if (req.region !== undefined) unsupportedFields.push('region');
  if (req.timezone !== undefined) unsupportedFields.push('timezone');
  if (req.browserSettings) {
    // browserSettings.viewport 会被 honor，其他子字段全归到 unsupported。
    for (const key of Object.keys(req.browserSettings)) {
      if (key !== 'viewport') unsupportedFields.push(`browserSettings.${key}`);
    }
  }
  if (unsupportedFields.length > 0) {
    log.warn(
      { projectId: auth.projectId, unsupportedFields },
      'BB-compat: ignoring unsupported request fields',
    );
  }

  // 解析 persona —— 从 inline JSON 或 DB 加载。BB-shape 通常不带 persona；
  // commit 4 会引入默认 seeded persona 兜底，此处先报 422 引导调用方升级或显式传 persona。
  if (!req.persona) {
    audit(c, 'session.create', 'persona:?', 'errored');
    throw new ApiError(
      'request.invalid',
      'persona is required (Browserbase-style empty body will use a default seeded persona once phase 11.4 commit 4 lands; for now pass persona: {id} or persona: {inline})',
      { field: 'persona' },
    );
  }
  let persona: Persona;
  let personaIdForRow: string | null = null;
  if (req.persona.inline !== undefined) {
    try {
      persona = parsePersona(req.persona.inline);
    } catch (err) {
      audit(c, 'session.create', 'persona:inline', 'errored');
      throw new ApiError(
        'request.invalid',
        `inline persona failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    const personaId = req.persona.id as string;
    const handle = await getDb();
    const rows = await handle.drizzle
      .select({ personaJson: personasTable.personaJson })
      .from(personasTable)
      .where(eq(personasTable.id, personaId))
      .limit(1);
    const found = rows[0];
    if (!found) {
      audit(c, 'session.create', `persona:${personaId}`, 'errored');
      throw new ApiError('persona.not_found', `persona ${personaId} not found`);
    }
    try {
      persona = parsePersona(JSON.parse(found.personaJson));
      personaIdForRow = personaId;
    } catch (err) {
      audit(c, 'session.create', `persona:${personaId}`, 'errored');
      throw new ApiError(
        'request.invalid',
        `stored persona ${personaId} failed re-parse: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const ttl = Math.min(
    req.lifecycle.ttl_seconds ?? env.SESSION_TTL_DEFAULT_SECONDS,
    env.SESSION_TTL_MAX_SECONDS,
  );

  const sessionId = newId('ses');
  const stealth: StealthOpts = req.stealth;
  // viewport 优先级：native viewport > BB browserSettings.viewport（同形）。
  const viewport = req.viewport ?? req.browserSettings?.viewport;

  const mm = getMachineManager();
  let machine: Awaited<ReturnType<typeof mm.acquire>>;
  const acquireStart = process.hrtime.bigint();
  try {
    machine = await mm.acquire({
      sessionId,
      persona,
      stealth,
      ttlSeconds: ttl,
      ...(viewport ? { viewport } : {}),
    });
    mmAcquireDurationSeconds.observe(Number(process.hrtime.bigint() - acquireStart) / 1e9);
  } catch (err) {
    // 失败也记 latency（同样的 series），让 ops 区分快速 fail vs 慢速 fail
    mmAcquireDurationSeconds.observe(Number(process.hrtime.bigint() - acquireStart) / 1e9);
    audit(c, 'session.create', `session:${sessionId}`, 'errored', {
      cause: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  const handle = await getDb();
  await handle.drizzle.insert(sessionsTable).values({
    id: sessionId,
    projectId: auth.projectId,
    personaId: personaIdForRow,
    machineId: machine.id,
    status: 'live',
    cdpInternalUrl: machine.cdpInternalUrl,
    cdpPublicUrl: publicCdpUrl(sessionId),
    openedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastSeenAt: now.toISOString(),
    clientAddr:
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null,
    clientLabel: req.client_label ?? null,
    metadataJson: JSON.stringify({ stealth, viewport }),
    userMetadata: req.userMetadata ? JSON.stringify(req.userMetadata) : '{}',
  });

  log.info(
    { sessionId, projectId: auth.projectId, machineId: machine.id, ttl },
    'session created',
  );
  audit(c, 'session.create', `session:${sessionId}`, 'ok', {
    machineId: machine.id,
  });

  const row = (await handle.drizzle
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId))
    .limit(1))[0];
  if (!row) {
    throw new ApiError('internal.unknown', 'session row missing post-insert');
  }

  sessionsCreatedTotal.inc();
  const responseBody = shapeSession(row, persona, stealth);
  // BB-compat 标记：仅当本请求确实带了暂不实现字段时附 unsupportedFields[]
  return c.json(
    unsupportedFields.length > 0 ? { ...responseBody, unsupportedFields } : responseBody,
    201,
  );
});

// ─── GET /v1/sessions/:id ───────────────────────────────────────────────────

sessionsRoute.get('/:id', rateLimitTier('read'), async (c) => {
  const auth = getAuth(c);
  const id = c.req.param('id');
  const handle = await getDb();
  const rows = await handle.drizzle
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.projectId, auth.projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiError('session.not_found', `session ${id} not found`);

  const meta = (() => {
    try {
      return JSON.parse(row.metadataJson) as { stealth: StealthOpts; viewport?: { width: number; height: number } };
    } catch {
      return { stealth: { inject: true, humanize: true, rebrowserPatches: true } as StealthOpts };
    }
  })();

  // persona JSON 不存在 sessions 表里，从 personas 取或 metadata 不返回完整 persona
  // —— 这是 v0.11 phase 11.1 的简化：GET 时只返回 stealth + ids。完整 persona 仅在
  // POST 创建时一次返回（client 自己缓存）。Phase 11.4 后 GET 也走 shapeSession，
  // BB-compat 字段同步输出，persona=null。
  return c.json(shapeSession(row, null, meta.stealth));
});

// ─── DELETE /v1/sessions/:id ────────────────────────────────────────────────

sessionsRoute.delete('/:id', rateLimitTier('write'), async (c) => {
  const auth = getAuth(c);
  const id = c.req.param('id');
  const handle = await getDb();

  const rows = await handle.drizzle
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.projectId, auth.projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // 幂等：不存在也返回 204
    audit(c, 'session.close', `session:${id}`, 'ok', { idempotent: true });
    return c.body(null, 204);
  }

  if (row.status !== 'closed') {
    const mm = getMachineManager();
    await mm.release(row.machineId).catch((err) => {
      getLogger().warn({ err, sessionId: id }, 'machine release failed (ignored)');
    });
    await handle.drizzle
      .update(sessionsTable)
      .set({ status: 'closed', closedAt: new Date().toISOString() })
      .where(eq(sessionsTable.id, id));
    sessionsClosedTotal.inc({ reason: 'client' });
  }

  audit(c, 'session.close', `session:${id}`, 'ok');
  return c.body(null, 204);
});

// 注：phase 11.4 之后，Browserbase 兼容直接由 /v1/sessions 自身承载（dual-shape
// request body + native superset response）。原占位 /browserbase-compat 501 stub 已删除。
