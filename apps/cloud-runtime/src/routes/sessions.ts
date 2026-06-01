/**
 * /v1/sessions REST handlers。
 *
 * 设计稿 §5.1-5.4：
 *   POST   /v1/sessions          —— 创建 session（acquire machine + 入库）
 *   GET    /v1/sessions          —— 列表（Browserbase sessions.list() 兼容，phase 11.9）
 *   GET    /v1/sessions/:id      —— 取详情
 *   DELETE /v1/sessions/:id      —— 幂等关闭
 *
 * WebSocket /v1/sessions/:id/cdp 不在本文件，因为 Hono 不直接处理 ws upgrade，
 * 它在 src/index.ts 注册到 raw http server 上（用 ws 库），
 * 调用 cdp/proxy.ts 完成反向代理。
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { type Persona, parsePersona } from '@runova/persona-schema';
import {
  contextsEnabled,
  ensureContextsEnabled,
  signContextDownloadUrl,
  signContextSnapshotUrl,
} from '../contexts/feature.js';
import { getDb } from '../db/client.js';
import {
  contexts as contextsTable,
  personas as personasTable,
  sessions as sessionsTable,
} from '../db/schema.js';
import { loadEnv } from '../env.js';
import { getMachineManager } from '../machine/factory.js';
import {
  mmAcquireDurationSeconds,
  quotaDeniedTotal,
  sessionsClosedTotal,
  sessionsCreatedTotal,
} from '../metrics.js';
import { audit } from '../middleware/audit.js';
import { getAuth } from '../middleware/auth.js';
import { rateLimitTier } from '../middleware/rate-limit.js';
import { pickDefaultPersonaDbId } from '../seed/default-personas.js';
import { stickyRegistryDelete, stickyRegistryGet, stickyRegistrySet } from '../sticky/registry.js';
import { aggregateUsage, currentMonthWindowUtc } from '../usage/aggregate.js';
import { computeBillableMinutes, recordUsage } from '../usage/emitter.js';
import { ApiError } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { getLogger } from '../utils/logger.js';

export const sessionsRoute = new Hono();

const StealthInputSchema = z
  .object({
    inject: z.boolean().default(true),
    humanize: z.boolean().default(true),
    rebrowserPatches: z.boolean().default(true),
    // 默认 false：求解会引入第三方调用与延迟，必须显式开启。pod 侧未配置求解
    // 服务时退化为「仅观察 + 日志」。BB `browserSettings.solveCaptchas` 也会折叠进来。
    solveCaptchas: z.boolean().default(false),
  })
  .default({
    inject: true,
    humanize: true,
    rebrowserPatches: true,
    solveCaptchas: false,
  });

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
 * Phase 11.6: Browserbase `browserSettings.context` 子结构。
 *   - `id`：要 reuse 的 context（必填；缺失整个 context 对象就当没传）
 *   - `persist`：close 时是否 snapshot 回写。BB 默认 `true`（用户主动选 false 表
 *     "只读模式"，隐式 persist 才符合直觉，见 design §9 decision 7）。
 */
const ContextInputSchema = z.object({
  id: z.string().min(1),
  persist: z.boolean().default(true),
});

/**
 * Browserbase `browserSettings` 子结构 —— 我们挑出 `viewport`（与原生同形）、
 * `context`（phase 11.6 honored）与 `solveCaptchas`（honored：折叠进 stealth），
 * 其他字段（fingerprint / blockAds / ...）一律收集到 unsupportedFields 并 warn-log。
 * passthrough 让未知 key 不被 strip 掉，方便后续记录。
 */
const BrowserSettingsSchema = z
  .object({
    viewport: ViewportSchema.optional(),
    context: ContextInputSchema.optional(),
    solveCaptchas: z.boolean().optional(),
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

  // ── Browserbase 字段 ──
  /**
   * Phase 11.5: 现在 honored —— true 触发长会话路径（WS 断 pod 不销毁、
   * TTL ceiling 提升到 SESSION_TTL_MAX_KEEPALIVE_SECONDS、受 KEEPALIVE_SESSIONS_PER_PROJECT_MAX
   * 配额）。与 native lifecycle.keep_alive 等价（任一为 true 即生效）。
   * 见 docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md §2-3。
   */
  keepAlive: z.boolean().optional(),

  // ── 以下 Browserbase 字段仍暂不实现，收到就 warn-and-ignore ──
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
 * Phase 11.4 commit 4c: 把 session 的 signing key 内嵌进 cdp URL 的 `?token=`
 * 查询串。Stagehand 调 `chromium.connectOverCDP(session.connectUrl)` 不传
 * header，所以 URL 必须自己带凭据；signing key 是 session 范围的最小凭据，
 * 比 API key 安全。row.signingKey 为 null（11.4 之前的旧 prod 行）时退回
 * 不带 token，调用方仍可用 Bearer header。
 */
function cdpUrlWithToken(baseCdpUrl: string, signingKey: string | null): string {
  if (!signingKey) return baseCdpUrl;
  return `${baseCdpUrl}?token=${encodeURIComponent(signingKey)}`;
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
  const cdpUrl = cdpUrlWithToken(row.cdpPublicUrl, row.signingKey);

  return {
    // ── Mosaiq native shape (snake_case) ──
    id: row.id,
    project_id: row.projectId,
    persona_id: row.personaId,
    status: row.status,
    cdp_url: cdpUrl,
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
    // Phase 11.5: 反映 row.keepAlive（之前 phase 11.4 stub 是固定 false）。
    keepAlive: row.keepAlive,
    connectUrl: cdpUrl,
    seleniumRemoteUrl: null as string | null,
    signingKey: row.signingKey,
    // Phase 11.6: 回真值（phase 11.4/11.5 是 stub null）。GET 与 POST 都走此函数。
    contextId: row.contextId,
    userMetadata: userMetadataParsed,
  };
}

/**
 * 从 session row 的 `metadataJson` 解析出 stealth 选项。解析失败 / 缺字段 →
 * 回退到默认（全开）。GET /:id 与 GET /（list）共用，保证两条路径 stealth
 * 输出一致。
 */
function stealthFromRow(row: typeof sessionsTable.$inferSelect): StealthOpts {
  const fallback: StealthOpts = {
    inject: true,
    humanize: true,
    rebrowserPatches: true,
    solveCaptchas: false,
  };
  try {
    const meta = JSON.parse(row.metadataJson) as { stealth?: Partial<StealthOpts> };
    // 旧行（11.x 之前落库）的 stealth 没有 solveCaptchas，用 fallback 补齐，保证
    // 响应形状对 Required<StealthInput> 客户端始终完整。
    return meta.stealth ? { ...fallback, ...meta.stealth } : fallback;
  } catch {
    return fallback;
  }
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
  // 注：phase 11.5 起 keepAlive 已 honored，不再列入此名单。
  const unsupportedFields: string[] = [];
  if (req.recording !== undefined) unsupportedFields.push('recording');
  if (req.logging !== undefined) unsupportedFields.push('logging');
  if (req.proxies !== undefined) unsupportedFields.push('proxies');
  if (req.extensionId !== undefined) unsupportedFields.push('extensionId');
  if (req.region !== undefined) unsupportedFields.push('region');
  if (req.timezone !== undefined) unsupportedFields.push('timezone');
  if (req.browserSettings) {
    // browserSettings.viewport + context + solveCaptchas 会被 honor，其他子字段全归到 unsupported。
    const honoredBrowserSettings = new Set(['viewport', 'context', 'solveCaptchas']);
    for (const key of Object.keys(req.browserSettings)) {
      if (!honoredBrowserSettings.has(key)) {
        unsupportedFields.push(`browserSettings.${key}`);
      }
    }
  }
  if (unsupportedFields.length > 0) {
    log.warn(
      { projectId: auth.projectId, unsupportedFields },
      'BB-compat: ignoring unsupported request fields',
    );
  }

  // 解析 persona —— 三个分支：inline JSON / 指定 DB id / 完全省略（commit 4a：默认 seed 池）。
  // BB-shape `bb.sessions.create({})` 走第三分支：随机抽一个 default seeded persona，
  // 然后跌进 id-lookup 通道。若 seed 被 operator 误删，下面 404 会用清晰的 default id
  // 提示需要重 seed。
  const personaInput = req.persona ?? { id: pickDefaultPersonaDbId() };
  let persona: Persona;
  let personaIdForRow: string | null = null;
  if (personaInput.inline !== undefined) {
    try {
      persona = parsePersona(personaInput.inline);
    } catch (err) {
      audit(c, 'session.create', 'persona:inline', 'errored');
      throw new ApiError(
        'request.invalid',
        `inline persona failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    const personaId = personaInput.id as string;
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

  // ── Phase 11.5: effective keepAlive + quota + sticky ──────────────────
  // 接受 native(lifecycle.keep_alive) 与 BB(keepAlive) 两种入口；任一 true 即生效。
  const effectiveKeepAlive = req.lifecycle.keep_alive === true || req.keepAlive === true;
  // stickyKey 仅 keepAlive=true 时启用路由；keepAlive=false 即使传 stickyKey 也忽略，
  // 但 round-trip 进 userMetadata（GET 能取回），保留客户端语义。
  const stickyKey =
    effectiveKeepAlive && typeof req.userMetadata?.stickyKey === 'string'
      ? (req.userMetadata.stickyKey as string)
      : null;

  const handle = await getDb();

  // ── Phase 11.8: per-project concurrent live-session cap ───────────────
  // 适用于**所有** session（keepAlive 与否）。补 11.5 只 cap keepAlive 的缺口——
  // 否则单租户能开到全局 pool 上限、饿死其他客户 + 跑爆 Fly 成本。在 acquire 之前
  // 拒绝 → 不拨 pod / 不计费 / 不占 slot。keepAlive 子 cap（下方）是更紧的附加限。
  // 计数 WHERE project_id AND status='live'：sessions_project_idx 前缀命中 project_id，
  // cap ≤ 1000 行扫描成本可忽略（同 keepAlive cap 论证）。
  const liveSessions = await handle.drizzle
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(and(eq(sessionsTable.projectId, auth.projectId), eq(sessionsTable.status, 'live')));
  const liveSessionCount = liveSessions.length;
  if (liveSessionCount >= env.SESSIONS_PER_PROJECT_MAX) {
    // c.header 必须在 throw 之前 set 才会被 Hono onError 路径保留（同 keepAlive cap）
    c.header('Retry-After', '60');
    audit(c, 'session.create', `project:${auth.projectId}`, 'denied', {
      reason: 'sessions_exceeded',
      activeCount: liveSessionCount,
      quota: env.SESSIONS_PER_PROJECT_MAX,
    });
    quotaDeniedTotal.inc({ reason: 'sessions' });
    throw new ApiError(
      'quota.sessions_exceeded',
      `project ${auth.projectId} has ${liveSessionCount} live sessions (quota ${env.SESSIONS_PER_PROJECT_MAX})`,
      {
        activeCount: liveSessionCount,
        quota: env.SESSIONS_PER_PROJECT_MAX,
        retryAfterSeconds: 60,
      },
    );
  }

  // ── Phase 11.8: per-project monthly browser-minute cap ────────────────
  // 仅在 MINUTES_PER_PROJECT_PER_MONTH_MAX 配置且 > 0 时启用检查。
  // 通过 aggregateUsage 捞本自然月 (UTC) 历史已产生用量并比对。
  if (env.MINUTES_PER_PROJECT_PER_MONTH_MAX > 0) {
    const { fromIso, toIso } = currentMonthWindowUtc();
    const totals = await aggregateUsage(handle, auth.projectId, fromIso, toIso);
    const usedMinutes = totals['session.minute'] ?? 0;

    if (usedMinutes >= env.MINUTES_PER_PROJECT_PER_MONTH_MAX) {
      audit(c, 'session.create', `project:${auth.projectId}`, 'denied', {
        reason: 'minutes_exceeded',
        usedMinutes,
        quotaMinutes: env.MINUTES_PER_PROJECT_PER_MONTH_MAX,
      });
      quotaDeniedTotal.inc({ reason: 'minutes' });
      throw new ApiError(
        'quota.minutes_exceeded',
        `project ${auth.projectId} used ${usedMinutes} min this month (quota ${env.MINUTES_PER_PROJECT_PER_MONTH_MAX})`,
        {
          usedMinutes,
          quotaMinutes: env.MINUTES_PER_PROJECT_PER_MONTH_MAX,
          windowFrom: fromIso,
          windowTo: toIso,
        },
      );
    }
  }

  if (effectiveKeepAlive) {
    // ── quota check ────────────────────────────────────────────
    // KEEPALIVE_SESSIONS_PER_PROJECT_MAX=0 → kill switch，所有 keepAlive 请求立刻 429。
    // 用 SELECT id 数 length，不引入 sql<number>`COUNT(*)` 复杂度；configured cap ≤ 50
    // 让 row scan 成本可忽略，索引 sessions_keepalive_idle_idx (status, keep_alive, last_seen_at)
    // 也让前缀 (status='live', keep_alive=1) 命中 covering scan。
    const liveKeepAlive = await handle.drizzle
      .select({ id: sessionsTable.id })
      .from(sessionsTable)
      .where(
        and(
          eq(sessionsTable.projectId, auth.projectId),
          eq(sessionsTable.keepAlive, true),
          eq(sessionsTable.status, 'live'),
        ),
      );
    const activeCount = liveKeepAlive.length;
    if (activeCount >= env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX) {
      // c.header 必须在 throw 之前 set 才会被 Hono onError 路径保留
      c.header('Retry-After', '60');
      audit(c, 'session.create', `project:${auth.projectId}`, 'denied', {
        reason: 'keepalive_saturated',
        activeCount,
        quota: env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX,
      });
      throw new ApiError(
        'pool.keepalive_saturated',
        `project ${auth.projectId} has ${activeCount} live keepAlive sessions (quota ${env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX})`,
        {
          activeCount,
          quota: env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX,
          retryAfterSeconds: 60,
        },
      );
    }

    // ── sticky lookup ───────────────────────────────────────────
    if (stickyKey) {
      const hit = stickyRegistryGet(auth.projectId, stickyKey);
      if (hit) {
        // double-check 防 reaper / DELETE 已 evict 但 map 漏清的 stale entry
        const hitRow = (
          await handle.drizzle
            .select()
            .from(sessionsTable)
            .where(eq(sessionsTable.id, hit.sessionId))
            .limit(1)
        )[0];
        const nowIso = new Date().toISOString();
        if (hitRow && hitRow.status === 'live' && hitRow.expiresAt > nowIso) {
          audit(c, 'session.create', `session:${hit.sessionId}`, 'denied', {
            reason: 'sticky_conflict',
            stickyKey,
          });
          throw new ApiError(
            'session.sticky_conflict',
            `sticky key '${stickyKey}' already in use by session ${hit.sessionId}`,
            {
              existingSessionId: hit.sessionId,
              expiresAt: hitRow.expiresAt,
              // 让客户端直接 chromium.connectOverCDP(detail.connectUrl) 一步 rejoin —
              // 避免还要先 GET /v1/sessions/{id} 再读 connectUrl（详见 design doc §9 decision 8）。
              connectUrl: cdpUrlWithToken(hitRow.cdpPublicUrl, hitRow.signingKey),
            },
          );
        }
        // entry stale（DB 看到 closed / expired）→ evict 后继续走新建
        stickyRegistryDelete(auth.projectId, stickyKey);
      }
    }
  }

  // TTL ceiling depends on keepAlive：normal session 受 SESSION_TTL_MAX_SECONDS，
  // keepAlive=true 受更高的 SESSION_TTL_MAX_KEEPALIVE_SECONDS（env superRefine 保证后者 >= 前者）。
  const ttlCeiling = effectiveKeepAlive
    ? env.SESSION_TTL_MAX_KEEPALIVE_SECONDS
    : env.SESSION_TTL_MAX_SECONDS;
  const ttl = Math.min(req.lifecycle.ttl_seconds ?? env.SESSION_TTL_DEFAULT_SECONDS, ttlCeiling);

  const sessionId = newId('ses');
  const signingKey = newId('sks');
  // 折叠 BB `browserSettings.solveCaptchas` 进 native stealth：任一为 true 即生效。
  const stealth: StealthOpts = {
    ...req.stealth,
    solveCaptchas: req.stealth.solveCaptchas || req.browserSettings?.solveCaptchas === true,
  };
  // viewport 优先级：native viewport > BB browserSettings.viewport（同形）。
  const viewport = req.viewport ?? req.browserSettings?.viewport;

  // ── Phase 11.6: resolve browserSettings.context (validate + lock pre-check) ──
  // 必须在 acquire 之前 fast-fail（404/409），避免无谓占用 pod。真正的并发安全锁
  // 在 session row 落库之后用 OCC update 上（见下方）—— FK contexts.active_session_id
  // → sessions.id 要求 session 行先存在（foreign_keys=ON），所以不能在此就锁。
  const contextReq = req.browserSettings?.context;
  let acquireContext: { loadUrl: string; projectId: string } | null = null;
  if (contextReq) {
    ensureContextsEnabled();
    const ctxRow = (
      await handle.drizzle
        .select()
        .from(contextsTable)
        .where(
          and(
            eq(contextsTable.id, contextReq.id),
            eq(contextsTable.projectId, auth.projectId),
            isNull(contextsTable.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!ctxRow) {
      // 不存在 / 不属于本 project / 已 soft-deleted 一律 404（不区分防资源枚举）。
      audit(c, 'session.create', `context:${contextReq.id}`, 'errored', { reason: 'not_found' });
      throw new ApiError('context.not_found', `context ${contextReq.id} not found`);
    }
    if (ctxRow.activeSessionId) {
      audit(c, 'session.create', `context:${contextReq.id}`, 'denied', {
        reason: 'in_use',
        activeSessionId: ctxRow.activeSessionId,
      });
      throw new ApiError(
        'context.in_use',
        `context ${contextReq.id} is currently held by session ${ctxRow.activeSessionId}`,
        { activeSessionId: ctxRow.activeSessionId, acquiredAt: ctxRow.activeSessionAcquiredAt },
      );
    }
    acquireContext = {
      loadUrl: signContextDownloadUrl(contextReq.id),
      projectId: auth.projectId,
    };
  }

  const mm = getMachineManager();
  let machine: Awaited<ReturnType<typeof mm.acquire>>;
  const acquireStart = process.hrtime.bigint();
  // Phase 11.5: keepalive label 让 dashboard 拆开 keepAlive=true / false 的 acquire 分布。
  // keepAlive=true 第一次仍走完整 acquire（拨 machine + boot chromium）；后续 reconnect
  // 不走这条 hot path（proxy 直接拨原 podOrigin），所以 keepAlive=true 的样本数 ≪ false。
  const keepaliveLabel = effectiveKeepAlive ? 'true' : 'false';
  try {
    machine = await mm.acquire({
      sessionId,
      persona,
      stealth,
      ttlSeconds: ttl,
      ...(viewport ? { viewport } : {}),
      ...(acquireContext ? { context: acquireContext } : {}),
    });
    mmAcquireDurationSeconds.observe(
      { keepalive: keepaliveLabel },
      Number(process.hrtime.bigint() - acquireStart) / 1e9,
    );
  } catch (err) {
    // 失败也记 latency（同样的 series），让 ops 区分快速 fail vs 慢速 fail
    mmAcquireDurationSeconds.observe(
      { keepalive: keepaliveLabel },
      Number(process.hrtime.bigint() - acquireStart) / 1e9,
    );
    audit(c, 'session.create', `session:${sessionId}`, 'errored', {
      cause: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);

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
    signingKey,
    // Phase 11.5: 持久化 keepAlive flag。reaper + release(hold) 都按它分支。
    keepAlive: effectiveKeepAlive,
    // Phase 11.6: 绑定 context（若有）。contextId 落库后下方再 OCC 锁 contexts 行。
    contextId: contextReq ? contextReq.id : null,
    contextPersist: contextReq ? contextReq.persist : false,
  });

  // ── Phase 11.6: atomic OCC lock on the context row ──────────────────────
  // Pod 已 acquire + session 行已落库。现在原子地认领 context：rows-affected=0
  // 说明 pre-check 之后、这里之前有并发 session 抢先锁了（TOCTOU race），需要
  // 回滚本 session（release pod + 标 closed）并回 409。
  if (contextReq) {
    const locked = await handle.drizzle
      .update(contextsTable)
      .set({ activeSessionId: sessionId, activeSessionAcquiredAt: now.toISOString() })
      .where(and(eq(contextsTable.id, contextReq.id), isNull(contextsTable.activeSessionId)))
      .returning({ id: contextsTable.id });
    if (locked.length === 0) {
      await mm.release(machine.id, { hold: false }).catch((err) => {
        log.warn({ err, sessionId }, 'release after lost context race failed (ignored)');
      });
      await handle.drizzle
        .update(sessionsTable)
        .set({ status: 'closed', closedAt: new Date().toISOString() })
        .where(eq(sessionsTable.id, sessionId));
      const holder = (
        await handle.drizzle
          .select({
            activeSessionId: contextsTable.activeSessionId,
            acquiredAt: contextsTable.activeSessionAcquiredAt,
          })
          .from(contextsTable)
          .where(eq(contextsTable.id, contextReq.id))
          .limit(1)
      )[0];
      audit(c, 'session.create', `context:${contextReq.id}`, 'denied', { reason: 'in_use_race' });
      throw new ApiError(
        'context.in_use',
        `context ${contextReq.id} was claimed by another session concurrently`,
        {
          activeSessionId: holder?.activeSessionId ?? null,
          acquiredAt: holder?.acquiredAt ?? null,
        },
      );
    }
  }

  // Phase 11.5: 注册 sticky entry。失败（同 key 已注册）会被 stickyRegistrySet
  // 覆盖 —— 设计上不应发生，因为上面 sticky lookup 已 evict 任何 stale entry。
  if (effectiveKeepAlive && stickyKey) {
    stickyRegistrySet(auth.projectId, stickyKey, {
      sessionId,
      expiresAt: expiresAt.toISOString(),
    });
  }

  log.info({ sessionId, projectId: auth.projectId, machineId: machine.id, ttl }, 'session created');
  audit(c, 'session.create', `session:${sessionId}`, 'ok', {
    machineId: machine.id,
  });

  const row = (
    await handle.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .limit(1)
  )[0];
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

// ─── GET /v1/sessions ───────────────────────────────────────────────────────
// Phase 11.9: Browserbase `sessions.list()` 兼容。project 隔离的 session 列表，
// 支持 status / q / limit 过滤。详见 docs/PHASE-11.9-SESSIONS-LIST.md。

const ListSessionsQuerySchema = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Browserbase 大写 status 枚举 → Mosaiq 原生 status 的映射。 */
const BB_STATUS_ALIASES: Record<string, string> = {
  RUNNING: 'live',
  COMPLETED: 'closed',
  ERROR: 'errored',
  TIMED_OUT: 'closed',
};
/** Mosaiq 原生 status（schema.ts sessions.status 注释）。 */
const NATIVE_STATUSES = new Set(['requested', 'live', 'closed', 'errored']);

/**
 * 把客户传的 `status` query 归一到原生 status 值。
 * 先试 BB 大写别名，再试原生小写；都不命中 → 抛 400。
 */
function resolveStatusFilter(status: string): string {
  const alias = BB_STATUS_ALIASES[status.toUpperCase()];
  if (alias) return alias;
  const lower = status.toLowerCase();
  if (NATIVE_STATUSES.has(lower)) return lower;
  throw new ApiError('request.invalid', `unknown status filter "${status}"`);
}

/**
 * `q` 过滤：`key:value` → 匹配 userMetadata[key] === value（字符串相等）；
 * 无冒号 → 对 userMetadata 原始 JSON 文本做子串匹配。解析失败一律不匹配。
 */
function matchUserMetadata(rawUserMetadata: string, q: string): boolean {
  const colon = q.indexOf(':');
  if (colon === -1) return rawUserMetadata.includes(q);
  const key = q.slice(0, colon);
  const value = q.slice(colon + 1);
  try {
    const parsed = JSON.parse(rawUserMetadata) as Record<string, unknown>;
    return parsed[key] === value;
  } catch {
    return false;
  }
}

sessionsRoute.get('/', rateLimitTier('read'), async (c) => {
  const auth = getAuth(c);
  const parsed = ListSessionsQuerySchema.safeParse({
    status: c.req.query('status'),
    q: c.req.query('q'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    throw new ApiError('request.invalid', 'invalid list-sessions query', {
      issues: parsed.error.issues,
    });
  }
  const { status, q, limit } = parsed.data;
  const nativeStatus = status !== undefined ? resolveStatusFilter(status) : undefined;

  const handle = await getDb();
  // project 隔离硬编码在 WHERE 里 —— list 绝不跨租户泄漏。
  const where = nativeStatus
    ? and(eq(sessionsTable.projectId, auth.projectId), eq(sessionsTable.status, nativeStatus))
    : eq(sessionsTable.projectId, auth.projectId);

  const rows = await handle.drizzle
    .select()
    .from(sessionsTable)
    .where(where)
    .orderBy(desc(sessionsTable.openedAt));

  // q 过滤在应用层（避免 sqlite JSON 函数移植性问题），limit 在 q 之后 slice。
  const filtered = q ? rows.filter((r) => matchUserMetadata(r.userMetadata, q)) : rows;
  const limited = filtered.slice(0, limit ?? 100);

  // 裸数组 —— Browserbase SDK sessions.list() 期望 array，不是 { items } 信封。
  // 这是与原生列表约定的有意分歧（本端点仅为 BB 兼容，无原生消费者）。详见
  // docs/PHASE-11.9-SESSIONS-LIST.md §4。
  return c.json(limited.map((row) => shapeSession(row, null, stealthFromRow(row))));
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

  // persona JSON 不存在 sessions 表里，从 personas 取或 metadata 不返回完整 persona
  // —— 这是 v0.11 phase 11.1 的简化：GET 时只返回 stealth + ids。完整 persona 仅在
  // POST 创建时一次返回（client 自己缓存）。Phase 11.4 后 GET 也走 shapeSession，
  // BB-compat 字段同步输出，persona=null。
  return c.json(shapeSession(row, null, stealthFromRow(row)));
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
    // ── Phase 11.6: snapshot trigger ────────────────────────────────────
    // 仅 graceful DELETE w/ contextPersist=true 触发回写（design §5.5 decision 5：
    // reaper/idle/crash 路径不 snapshot，因为 chromium 已 SIGKILL，user-data-dir
    // 状态不一致）。snapshotUrl 透传给 pod /control/stop，pod 内部"先 snapshot 再
    // kill"。snapshot 失败不阻止 lock 释放（见下方 finally 语义）。
    const wantSnapshot = Boolean(row.contextId) && row.contextPersist && contextsEnabled();
    const snapshotUrl = wantSnapshot ? signContextSnapshotUrl(row.contextId!) : undefined;

    // Phase 11.5: 显式 hold=false —— DELETE 是客户端"我要彻底关掉"的语义，
    // 与 keepAlive=true session 的 WS 断开 (proxy 处不调 release) 形成对比。
    // 即使 row.keepAlive=true，DELETE 也要 destroy；后者是 reaper / idle 的事。
    await mm
      .release(row.machineId, { hold: false, ...(snapshotUrl ? { snapshotUrl } : {}) })
      .catch((err) => {
        getLogger().warn({ err, sessionId: id }, 'machine release failed (ignored)');
      });
    // 单个 closedAtIso 同时用于 row 更新与计费时长，保证账单时长 = 记录的 closedAt。
    const closedAtIso = new Date().toISOString();
    await handle.drizzle
      .update(sessionsTable)
      .set({ status: 'closed', closedAt: closedAtIso })
      .where(eq(sessionsTable.id, id));
    sessionsClosedTotal.inc({ reason: 'client' });

    // Phase 11.7: 记 browser-minutes 计费埋点。await 不丢账单；失败只 warn
    // （session 已 closed，可事后补）。注意只在真实 live→closed 转换路径记账——
    // POST 里 context-race rollback 也会把 status 改 closed，但走的是另一段代码、
    // 不经过这里，所以那条内部失败不会被计费（design §1 决策）。
    try {
      await recordUsage(handle, {
        projectId: row.projectId,
        sessionId: id,
        kind: 'session.minute',
        value: computeBillableMinutes(row.openedAt, closedAtIso),
      });
    } catch (err) {
      getLogger().warn(
        { err, sessionId: id, projectId: row.projectId },
        'usage emit failed on DELETE (billing event lost for this session)',
      );
    }

    // ── Phase 11.6: release the context lock ────────────────────────────
    // 无条件清锁 —— 即使 snapshot 失败 / pod release 失败，lock 也必须释放，否则
    // 该 context 永久卡在 in_use（design §5.4 invariant：lock 释放与 snapshot 解耦）。
    // WHERE active_session_id=id 保证只清本 session 持有的锁（防误清并发新锁）。
    if (row.contextId) {
      await handle.drizzle
        .update(contextsTable)
        .set({ activeSessionId: null, activeSessionAcquiredAt: null })
        .where(and(eq(contextsTable.id, row.contextId), eq(contextsTable.activeSessionId, id)))
        .catch((err: unknown) => {
          getLogger().warn(
            { err, sessionId: id, contextId: row.contextId },
            'context lock release failed (ignored; reaper backstop will retry)',
          );
        });
    }

    // Phase 11.5: evict sticky registry entry（如果有）。读 row.userMetadata 取 stickyKey，
    // 失败 / 缺字段都 no-op。注意：keepAlive=false session 即使其 userMetadata 含 stickyKey
    // 也不会注入 registry，所以这里 evict 是空操作，不需要额外的 row.keepAlive 判定。
    try {
      const meta = JSON.parse(row.userMetadata ?? '{}') as Record<string, unknown>;
      if (typeof meta.stickyKey === 'string') {
        stickyRegistryDelete(row.projectId, meta.stickyKey as string);
      }
    } catch {
      /* invalid JSON; ignore */
    }
  }

  audit(c, 'session.close', `session:${id}`, 'ok');
  return c.body(null, 204);
});

// 注：phase 11.4 之后，Browserbase 兼容直接由 /v1/sessions 自身承载（dual-shape
// request body + native superset response）。原占位 /browserbase-compat 501 stub 已删除。
