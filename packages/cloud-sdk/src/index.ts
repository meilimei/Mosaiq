/**
 * @runova/cloud-sdk —— Mosaiq Cloud 控制平面客户端。
 *
 * 使用：
 * ```ts
 * import { MosaiqCloudClient } from '@runova/cloud-sdk';
 * import { chromium } from 'playwright-core';
 *
 * const client = new MosaiqCloudClient({
 *   apiUrl: process.env.MOSAIQ_API_URL!,
 *   apiKey: process.env.MOSAIQ_API_KEY!,
 *   projectId: process.env.MOSAIQ_PROJECT_ID!,
 * });
 *
 * const sess = await client.createSession({
 *   persona: { inline: alicePersona },
 *   stealth: { inject: true, humanize: true, rebrowserPatches: true },
 *   ttlSeconds: 1800,
 * });
 *
 * const browser = await chromium.connectOverCDP(sess.cdpUrl, {
 *   headers: { Authorization: `Bearer ${client.apiKey}` },
 * });
 * const ctx = browser.contexts()[0] ?? await browser.newContext();
 * await sess.injectInto(ctx);    // persona JS-level 注入
 * const page = ctx.pages()[0] ?? await ctx.newPage();
 * await page.goto('https://example.com');
 * await sess.close();
 * ```
 */

export {
  MosaiqCloudClient,
  type MosaiqCloudClientOptions,
  type CreateSessionInput,
  type CreateSessionPersonaInput,
  type StealthInput,
  type CreatedSession,
  type SessionInfo,
  type SessionStatus,
  type ListSessionsInput,
  type ListSessionsStatus,
} from './client.js';

export { ManagedCloudSession, type ManagedCloudSessionOptions } from './session.js';

export {
  CloudApiError,
  type CloudErrorCode,
} from './errors.js';

// Re-export Persona type for convenience（让 cloud-sdk 用户不必再装 persona-schema）
export type { Persona } from '@runova/persona-schema';
