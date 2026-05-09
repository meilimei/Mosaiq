/**
 * Top-level Persona schema — Mosaiq 生态系统的核心数据结构。
 *
 * 一个 Persona 代表「一个完整的浏览器身份」：OS + 浏览器 + 硬件 + 指纹 + 网络 + 元数据。
 * Desktop / SDK / CLI / 未来 Cloud Runtime / Chromium fork 都消费这同一份定义。
 *
 * 演化规则：
 *   - 字段只增不删，保证老 persona 文件永远可读
 *   - 新增字段必须 optional 或提供默认值
 *   - Breaking change 必须升 schemaVersion
 */

import { z } from 'zod';

import { BrowserSchema } from './browser.js';
import { FingerprintSchema } from './fingerprint.js';
import { HardwareSchema } from './hardware.js';
import { NetworkSchema } from './network.js';
import { SystemSchema } from './system.js';

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persona ID: kebab-case, 3-64 chars, 便于文件系统与日志
 * 例: 'reddit-alice', 'us-shopping-alt-02'
 */
export const PersonaIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,63}$/, 'Persona ID must be kebab-case, 3-64 chars, start with letter');
export type PersonaId = z.infer<typeof PersonaIdSchema>;

export const PersonaMetadataSchema = z.object({
  id: PersonaIdSchema,
  /** 人类可读名称，UI 显示用 */
  displayName: z.string().min(1).max(128),
  /** 分组标签：'reddit', 'twitter-us', 'warming' */
  tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  /** 备注 */
  notes: z.string().max(2048).default(''),
  /** ISO 8601 timestamps */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** 上次启动时间 */
  lastLaunchedAt: z.string().datetime().nullable().default(null),
  /** 累计启动次数 */
  launchCount: z.number().int().min(0).default(0),
});
export type PersonaMetadata = z.infer<typeof PersonaMetadataSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Persona
// ─────────────────────────────────────────────────────────────────────────────

export const PERSONA_SCHEMA_VERSION = 1 as const;

export const PersonaSchema = z.object({
  /** Schema 版本，breaking change 时递增 */
  schemaVersion: z.literal(PERSONA_SCHEMA_VERSION),
  metadata: PersonaMetadataSchema,
  system: SystemSchema,
  browser: BrowserSchema,
  hardware: HardwareSchema,
  fingerprint: FingerprintSchema,
  network: NetworkSchema,
});
export type Persona = z.infer<typeof PersonaSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Draft: 创建流程中使用的「半成品 persona」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 创建 persona 的入参。允许只填核心信息，其他由 SDK 基于模板派生。
 * SDK 的 PersonaBuilder.build(draft) 会输出完整 Persona。
 */
export const PersonaDraftSchema = z.object({
  id: PersonaIdSchema,
  displayName: z.string().min(1).max(128),
  tags: z.array(z.string()).max(16).optional(),
  notes: z.string().max(2048).optional(),
  /** 模板名，例 'win11-chrome-us-residential' */
  template: z.string().min(1).max(64),
  /** 对模板的自定义覆盖（部分字段） */
  overrides: z
    .object({
      timezone: z.string().optional(),
      locale: z.string().optional(),
      screen: z
        .object({
          width: z.number().int().optional(),
          height: z.number().int().optional(),
        })
        .optional(),
      proxy: z
        .object({
          protocol: z.enum(['http', 'https', 'socks5']).optional(),
          host: z.string().optional(),
          port: z.number().int().optional(),
          username: z.string().optional(),
          password: z.string().optional(),
          label: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type PersonaDraft = z.infer<typeof PersonaDraftSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析并严格校验 Persona JSON。校验失败抛 Zod ZodError。
 */
export function parsePersona(input: unknown): Persona {
  return PersonaSchema.parse(input);
}

/**
 * 安全解析 Persona，返回 result union。
 */
export function safeParsePersona(input: unknown) {
  return PersonaSchema.safeParse(input);
}
