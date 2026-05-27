/**
 * Cloud Runtime DB schema（sqlite via Drizzle）。
 *
 * 表设计原则：
 *   - 一切 ID 都是 text 带前缀（'ses_xxx' 等），方便日志检索
 *   - 时间戳统一用 ISO 8601 string（sqlite 无 timestamp 类型，避免数值精度坑）
 *   - JSON 列存 jsonb-shaped 数据时也用 text，应用层 JSON.parse
 *   - 索引最小化：只为高频查询（按 project_id / 按 session_id 时序）建
 *
 * 演化规则：
 *   - 字段只增不删
 *   - 新增字段必须 NOT NULL DEFAULT 或 NULLABLE
 *   - 真正的迁移在 phase 11.5 引入 drizzle-kit
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ─────────────────────────────────────────────────────────────────────────────
// projects — 一个调用方（LaunchAI 等）一行
// ─────────────────────────────────────────────────────────────────────────────

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// ─────────────────────────────────────────────────────────────────────────────
// api_keys — 一个 project 可有多个 key（rotation）
// ─────────────────────────────────────────────────────────────────────────────

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** sha256(plaintext)，hex */
    keyHash: text('key_hash').notNull(),
    /** UI 显示用前缀，如 'msq_sk_live_xxxxxxxx' */
    prefix: text('prefix').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text('revoked_at'),
    lastUsedAt: text('last_used_at'),
  },
  (t) => ({
    keyHashIdx: uniqueIndex('api_keys_key_hash_uq').on(t.keyHash),
    projectIdx: index('api_keys_project_idx').on(t.projectId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// sessions — 一次浏览器 session 一行
// ─────────────────────────────────────────────────────────────────────────────

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    personaId: text('persona_id'),
    /** 'mch_xxx' / fly machine id / docker container id */
    machineId: text('machine_id').notNull(),
    /** 'requested' | 'live' | 'closed' | 'errored' */
    status: text('status').notNull(),
    /** 控制平面用：ws://pod-7:9223/devtools/... */
    cdpInternalUrl: text('cdp_internal_url').notNull(),
    /** 控制平面对外暴露的 URL，cached 在 session 创建时算好以便重发 */
    cdpPublicUrl: text('cdp_public_url').notNull(),
    openedAt: text('opened_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    closedAt: text('closed_at'),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    clientAddr: text('client_addr'),
    clientLabel: text('client_label'),
    errorMessage: text('error_message'),
    /** JSON: { stealth: {...}, viewport: {...}, persona: {...} } */
    metadataJson: text('metadata_json').notNull().default('{}'),
    /**
     * Phase 11.4: 客户透传的 metadata（Browserbase compat 的 `userMetadata`）。
     * JSON 文本，应用层 JSON.parse；DEFAULT '{}' 让旧行迁移时不破。
     */
    userMetadata: text('user_metadata').notNull().default('{}'),
    /**
     * Phase 11.4 commit 4c: per-session signing key (`sks_<22 chars>`)。
     *
     * Browserbase SDK 的 Stagehand 调用模式是 `chromium.connectOverCDP(session.connectUrl)`
     * 不带任何 header。Playwright 的 connectOverCDP 默认不携带 auth，因此 connectUrl
     * 必须**自己**带凭据。我们模仿 BB 的方案：每个 session 在 create 时生成一次
     * 高熵 signing key，存这一列；session 创建响应里既作为 BB 兼容字段
     * `signingKey` 暴露，又内嵌进 connectUrl 的 `?token=` 查询串。
     *
     * cdp WS 代理（src/cdp/proxy.ts）认证时，先按 `?token=` 匹配该列；命中则
     * **仅**授权访问该 session（与 API key 的全 project 范围互斥），符合
     * "凭据最小作用域"原则。session 关闭后 signing key 随之失效。
     *
     * Nullable：让 11.4 之前已存在的 prod 行迁移时不破；那些行的 connectUrl
     * 仍然只能通过 Bearer header 接入。新建的 session 一律必须有该字段。
     */
    signingKey: text('signing_key'),
    /**
     * Phase 11.5: keepAlive flag. When true, the session opts into long-session
     * lifecycle (docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md):
     *  - extended TTL ceiling via SESSION_TTL_MAX_KEEPALIVE_SECONDS (default 24h)
     *  - pod stays running across WS disconnects (mm.release(id, {hold:true}))
     *  - idle-timeout termination via SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS
     *  - subject to per-project quota KEEPALIVE_SESSIONS_PER_PROJECT_MAX
     *
     * NOT NULL with default false preserves phase 11.3a single-use invariant:
     * any session row predating phase 11.5 (migrated via COLUMN_ADDITIONS in
     * bootstrap.ts) defaults to keepAlive=false → unchanged destroy-on-close
     * behavior. Only sessions explicitly created with keepAlive=true get the
     * new lifecycle. See §5 of the phase doc for the safety carve-out matrix.
     */
    keepAlive: integer('keep_alive', { mode: 'boolean' }).notNull().default(false),
    /**
     * Phase 11.6: which `contexts` row this session is bound to (BB compat
     * `browserSettings.context.id`). Null = no context (the phase 11.4 default).
     *
     * FK with `ON DELETE SET NULL`: if a context row is deleted while a session
     * is still actively using it, we drop the link rather than cascade the
     * session — the running pod still has its own user-data-dir and can finish
     * its work, just without snapshotting back. The lock on `contexts.active_session_id`
     * is what prevents stealing the context out from under the live session;
     * deletion of an in-use context is rejected at the DELETE handler with 409.
     *
     * Nullable preserves phase 11.5 behavior for sessions created before 11.6
     * and the phase 11.4a "no context" default path. See PHASE-11.6 §5 for
     * the full lifecycle.
     */
    contextId: text('context_id'),
    /**
     * Phase 11.6: BB compat `browserSettings.context.persist` (default true).
     * When true, on graceful DELETE the pod tar+encrypts the user-data-dir
     * and uploads it back to the context's storage blob. `false` = read-only
     * mode: we still load the context on session start, but skip the snapshot
     * on close (the context stays at its previous snapshot point).
     *
     * NOT NULL with default `false` is the safe migration default — a row
     * predating phase 11.6 has no context anyway, so the value of this column
     * is meaningless. Honor only kicks in when contextId is set.
     */
    contextPersist: integer('context_persist', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    projectIdx: index('sessions_project_idx').on(t.projectId, t.openedAt),
    statusIdx: index('sessions_status_idx').on(t.status),
    machineIdx: index('sessions_machine_idx').on(t.machineId),
    /**
     * Phase 11.5: composite index for the reaper's keepAlive-idle scan
     * (`WHERE status IN (...) AND keep_alive = 1 AND last_seen_at < ?`).
     * Prefix is `(status, keep_alive)` so non-keepAlive scans (the vast majority)
     * still get index-only access; the trailing `last_seen_at` keeps the
     * range predicate sargable.
     */
    keepAliveIdleIdx: index('sessions_keepalive_idle_idx').on(
      t.status,
      t.keepAlive,
      t.lastSeenAt,
    ),
    /**
     * Phase 11.6: locate sessions by their bound context (used at session
     * close to clear `contexts.active_session_id`, and on context delete to
     * find any in-flight sessions). Most session rows will have NULL contextId,
     * so the index is small. We do NOT make it partial WHERE contextId IS NOT NULL
     * because sqlite partial indexes don't help nullable column lookups in our
     * planner; the full index is fine and tiny.
     */
    contextIdx: index('sessions_context_idx').on(t.contextId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// contexts — Phase 11.6 Browserbase Contexts API（跨 session 持久化 user-data-dir）
//
// 一个 context = 一份命名的 chromium profile blob（cookies + localStorage +
// IndexedDB + ServiceWorker + sessionStorage + form autofill + browser prefs）。
// 见 docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md §2 for the full data inventory.
// ─────────────────────────────────────────────────────────────────────────────

export const contexts = sqliteTable(
  'contexts',
  {
    /** 'ctx_<22 chars base58>' */
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    /**
     * Storage backend identifier. Phase 11.6a 仅 `'fs'`（FsContextStorage写到
     * fly volume `/data/contexts/`）；phase 11.6b 加 `'s3'` / `'r2'`。把 backend
     * 存表里让单 deploy 期间从 fs 迁到 s3 不需要 schema 改动 —— 老 row 继续走 fs，
     * 新 row 走 s3，逐步迁移。
     */
    storageBackend: text('storage_backend').notNull().default('fs'),
    /**
     * Backend-specific path / object key. For `fs`, relative to MOSAIQ_CONTEXT_STORAGE_PATH
     * (e.g. `ctx_abc.tar.zst.enc`). For S3, the full object key.
     */
    storageKey: text('storage_key').notNull(),

    /**
     * AES-GCM ciphertext authentication. We don't store the encryption key
     * itself — it's HKDF-derived from MOSAIQ_CONTEXT_MASTER_KEY (fly secret) and
     * projectId at runtime. We DO store the algorithm name so phase 11.6c key
     * rotation can lazily migrate; storing 'aes-256-gcm-v1' lets a v2 spec
     * coexist on different rows.
     *
     * `enc_nonce` is the 12-byte GCM IV. Stored as BLOB so we can use random
     * bytes (not utf8). Phase 11.6a writes this on each snapshot; the nonce
     * lives in the encrypted blob's header (first 12 bytes, see
     * `apps/cloud-runtime/src/utils/crypto.ts`) so we technically don't need
     * the column — but having it duplicated lets ops verify integrity without
     * downloading the blob. NULL on empty contexts (never snapshotted).
     */
    encAlgo: text('enc_algo').notNull().default('aes-256-gcm-v1'),
    encNonce: text('enc_nonce'), // hex, 24 chars (12 bytes); NULL = empty/never snapshotted

    /** Compressed+encrypted blob size in bytes. NULL = empty. */
    bytes: integer('bytes'),

    /**
export type ContextRow = typeof contexts.$inferSelect;
     * Lock: at most one session can hold a context at a time (BB semantics).
     * NULL = available. Set on POST /v1/sessions browserSettings.context.id atomic
     * OCC; cleared on session close (DELETE handler) or by `ON DELETE SET NULL`
     * if the session row is removed.
     *
     * `active_session_acquired_at` is informational — lets ops/dashboards
     * show "context X locked since Y ago" without joining sessions.
     */
    activeSessionId: text('active_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    activeSessionAcquiredAt: text('active_session_acquired_at'),

    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    /** ISO timestamp of last successful snapshot. NULL = never snapshotted (empty). */
    lastSnapshotAt: text('last_snapshot_at'),
    /**
     * Soft delete: DELETE /v1/contexts/{id} sets this. Blob is not unlinked
     * synchronously — that's deferred to a phase 11.6b GC job. Soft-deleted
     * rows are excluded from quota count and from POST /v1/sessions resolution
     * (404 not_found path).
     */
    deletedAt: text('deleted_at'),
  },
  (t) => ({
    projectIdx: index('contexts_project_idx').on(t.projectId),
    /**
     * Partial index limited to currently-locked rows. Sqlite supports partial
     * indexes (CREATE INDEX ... WHERE ...) and the planner will use them when
     * the query has a matching WHERE. Drizzle's partial index syntax via
     * `.where()` lands a `CREATE INDEX ... WHERE active_session_id IS NOT NULL`
     * — we ALWAYS query this column with `IS NOT NULL` (release on close,
     * find leaks for ops), so the partial index keeps disk usage minimal and
     * lookups O(locked-set) instead of O(all-contexts).
     */
    activeSessionIdx: index('contexts_active_session_idx').on(t.activeSessionId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// personas — cloud-side persona pool
// ─────────────────────────────────────────────────────────────────────────────

export const personas = sqliteTable(
  'personas',
  {
    id: text('id').primaryKey(),
    /** NULL = 全局可用（seed pool） */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** 'user' | 'seed' | 'capture' */
    source: text('source').notNull(),
    /** 整个 Persona JSON，schema 由 @mosaiq/persona-schema parse 校验 */
    personaJson: text('persona_json').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    projectIdx: index('personas_project_idx').on(t.projectId),
    sourceIdx: index('personas_source_idx').on(t.source),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// usage_events — 计费埋点
// ─────────────────────────────────────────────────────────────────────────────

export const usageEvents = sqliteTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    /** 'session.minute' | 'persona.checkout' | 'proxy.gb' | ... */
    kind: text('kind').notNull(),
    /** 数值，比如 minute 数；sqlite 没有 numeric，用 real */
    value: integer('value', { mode: 'number' }).notNull(),
    ts: text('ts')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    projectTsIdx: index('usage_events_project_ts_idx').on(t.projectId, t.ts),
    sessionIdx: index('usage_events_session_idx').on(t.sessionId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// audit_events — 审计日志
// ─────────────────────────────────────────────────────────────────────────────

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id'),
    apiKeyId: text('api_key_id'),
    /** 'session.create' | 'session.close' | 'auth.fail' | ... */
    action: text('action').notNull(),
    /** 'session:ses_xxx' / 'persona:pers_xxx' */
    resource: text('resource').notNull(),
    /** 'ok' | 'denied' | 'errored' */
    result: text('result').notNull(),
    ip: text('ip'),
    ts: text('ts')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    /** JSON */
    detailJson: text('detail_json'),
  },
  (t) => ({
    projectTsIdx: index('audit_events_project_ts_idx').on(t.projectId, t.ts),
    actionIdx: index('audit_events_action_idx').on(t.action),
  }),
);

export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type PersonaRow = typeof personas.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
