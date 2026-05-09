/**
 * Browser-level identity: brand, version, UA-CH client hints, Accept-* headers.
 *
 * 这一层在 v0.1 通过 CDP `Network.setUserAgentOverride` + `Emulation.setUserAgentOverride`
 * + 注入脚本覆盖 navigator.userAgentData 实现。
 *
 * 未来在 Chromium fork 中由 C++ 层在 Browser Process 直接产出（更高保真）。
 */

import { z } from 'zod';

export const BrowserBrandSchema = z.enum(['chrome', 'edge', 'brave', 'opera', 'firefox']);
export type BrowserBrand = z.infer<typeof BrowserBrandSchema>;

export const BrowserSchema = z.object({
  brand: BrowserBrandSchema,
  /** Major version, e.g., 130. Subversions handled internally. */
  majorVersion: z.number().int().min(90).max(200),
  /** Full version string for UA, e.g., '130.0.6723.117' */
  fullVersion: z.string().regex(/^\d+(\.\d+){2,3}$/, 'Invalid full browser version'),
  /**
   * The full User-Agent string. SDK auto-derives if not set;
   * 仅在你想完全锁定 UA 时显式提供（不推荐普通用户改）。
   */
  userAgent: z.string().min(20).max(512).optional(),
  /** UA Client Hints brand list. 自动生成。 */
  uaClientHints: z
    .object({
      brands: z.array(
        z.object({
          brand: z.string(),
          version: z.string(),
        }),
      ),
      mobile: z.boolean(),
      platform: z.string(),
      platformVersion: z.string(),
      architecture: z.string(),
      bitness: z.string(),
      model: z.string().default(''),
      wow64: z.boolean().default(false),
    })
    .optional(),
});
export type Browser = z.infer<typeof BrowserSchema>;
