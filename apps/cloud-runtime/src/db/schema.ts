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
  },
  (t) => ({
    projectIdx: index('sessions_project_idx').on(t.projectId, t.openedAt),
    statusIdx: index('sessions_status_idx').on(t.status),
    machineIdx: index('sessions_machine_idx').on(t.machineId),
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
