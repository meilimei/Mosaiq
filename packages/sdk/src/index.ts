/**
 * @mosaiq/sdk — Mosaiq SDK 公共 API。
 *
 * 使用示例：
 * ```ts
 * import { launchPersona, loadPersona } from '@mosaiq/sdk';
 *
 * const alice = loadPersona('reddit-alice');
 * const session = await launchPersona(alice);
 * const page = await session.open('https://www.reddit.com');
 * // ... 手动或 Stagehand 驱动操作
 * await session.close();
 * ```
 */

export { launchPersona, type LaunchPersonaOptions } from './launcher.js';
export { BrowserSession } from './browser-session.js';
export {
  savePersona,
  loadPersona,
  listPersonas,
  deletePersona,
  personaExists,
  recordLaunch,
  updatePersona,
  clonePersona,
  type PersonaPatch,
  type CloneOptions,
} from './persona-store.js';
export {
  getRuntimeRoot,
  getUserDataDir,
  getPersonaDir,
  getPersonaFile,
  type PathConfig,
} from './paths.js';
export { buildUserAgent, buildAcceptLanguage } from './ua.js';
export {
  buildProxyServerArg,
  toPlaywrightProxy,
  verifyProxy,
  type PlaywrightProxy,
  type ProxyVerifyResult,
  type ProxyVerifyOptions,
} from './proxy.js';

// Re-export persona-schema for convenience
export type {
  Persona,
  PersonaId,
  PersonaDraft,
  PersonaMetadata,
} from '@mosaiq/persona-schema';
export { parsePersona, safeParsePersona } from '@mosaiq/persona-schema';
