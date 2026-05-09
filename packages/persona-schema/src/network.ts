/**
 * Network identity: proxy, DNS, future TLS profile.
 * v0.1 仅实现 proxy。DNS-over-HTTPS / TLS profile 留给 fork 阶段。
 */

import { z } from 'zod';

export const ProxyProtocolSchema = z.enum(['http', 'https', 'socks5']);
export type ProxyProtocol = z.infer<typeof ProxyProtocolSchema>;

export const ProxyConfigSchema = z.object({
  protocol: ProxyProtocolSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(),
  password: z.string().max(255).optional(),
  bypassList: z.array(z.string()).default([]),
  /** 标签：如 'iproyal-us-residential-sticky-30min' 便于识别归属 */
  label: z.string().max(128).optional(),
});
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

export const NetworkSchema = z.object({
  proxy: ProxyConfigSchema.optional(),
  /** WebRTC policy 已在 fingerprint.webrtc 定义，这里不重复 */
});
export type Network = z.infer<typeof NetworkSchema>;
