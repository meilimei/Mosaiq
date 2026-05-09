/**
 * System-level identity: OS, locale, timezone, screen geometry.
 *
 * 这一层决定 navigator.platform / navigator.userAgentData.platform /
 * Intl.DateTimeFormat().resolvedOptions().timeZone / screen.* 等基础值，
 * 必须严格自洽（如 timezone=America/New_York 时 locale 应为 en-US）。
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// OS
// ─────────────────────────────────────────────────────────────────────────────

export const OsFamilySchema = z.enum(['windows', 'macos', 'linux', 'android', 'ios']);
export type OsFamily = z.infer<typeof OsFamilySchema>;

export const OsArchSchema = z.enum(['x86_64', 'arm64', 'x86']);
export type OsArch = z.infer<typeof OsArchSchema>;

export const OsSchema = z.object({
  family: OsFamilySchema,
  /**
   * 例：'10.0.22631' (Win11 23H2), '14.6.1' (macOS Sonoma),
   *     '6.8.0-45-generic' (Ubuntu 24.04 kernel)
   */
  version: z.string().min(1).max(64),
  arch: OsArchSchema,
  /**
   * 浏览器 UA 中暴露的 platform string，
   * 如 'Win32' (即使 64 位 Win 也常报 Win32) / 'MacIntel' / 'Linux x86_64'
   */
  platformLabel: z.string().min(1).max(64),
});
export type Os = z.infer<typeof OsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Locale & Timezone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BCP 47 language tag (e.g., 'en-US', 'zh-CN', 'pt-BR').
 * 用于 navigator.language / Accept-Language 的首项。
 */
export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/, 'Invalid BCP 47 locale tag');
export type Locale = z.infer<typeof LocaleSchema>;

/**
 * IANA timezone identifier (e.g., 'America/New_York', 'Asia/Shanghai').
 * 不接受缩写如 'EST'，必须是 IANA 长格式。
 */
export const TimezoneSchema = z
  .string()
  .regex(/^[A-Z][a-z]+(\/[A-Z][A-Za-z_-]+)+$/, 'Invalid IANA timezone identifier');
export type Timezone = z.infer<typeof TimezoneSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Screen geometry
// ─────────────────────────────────────────────────────────────────────────────

export const ScreenSchema = z
  .object({
    width: z.number().int().min(640).max(7680),
    height: z.number().int().min(480).max(4320),
    /**
     * 操作系统任务栏 / dock 占用后的可视区域。一般略小于 width/height。
     */
    availWidth: z.number().int().min(640).max(7680),
    availHeight: z.number().int().min(480).max(4320),
    /** 16 / 24 / 30 / 48 */
    colorDepth: z.union([z.literal(24), z.literal(30), z.literal(48)]).default(24),
    pixelDepth: z.union([z.literal(24), z.literal(30), z.literal(48)]).default(24),
    /** 1.0 / 1.25 / 1.5 / 2.0 / 3.0 — Windows scaling, macOS Retina */
    devicePixelRatio: z.number().min(1).max(4).default(1),
  })
  .refine((s) => s.availWidth <= s.width && s.availHeight <= s.height, {
    message: 'availWidth/Height must be <= width/height',
  });
export type Screen = z.infer<typeof ScreenSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Combined system block
// ─────────────────────────────────────────────────────────────────────────────

export const SystemSchema = z.object({
  os: OsSchema,
  locale: LocaleSchema,
  /**
   * 完整 Accept-Language 列表，权重从高到低。
   * 例：['en-US', 'en;q=0.9', 'zh-CN;q=0.8']
   */
  languages: z.array(z.string()).min(1).max(8),
  timezone: TimezoneSchema,
  screen: ScreenSchema,
});
export type System = z.infer<typeof SystemSchema>;
