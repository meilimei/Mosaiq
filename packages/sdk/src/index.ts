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
  serializePersona,
  exportPersonaJson,
  parsePersonaJson,
  importPersonaJson,
  type ExportOptions,
  type ImportOptions,
  type ImportConflictOptions,
} from './persona-portability.js';
export {
  getRuntimeRoot,
  getUserDataDir,
  getPersonaDir,
  getPersonaFile,
  type PathConfig,
} from './paths.js';
export { buildUserAgent, buildAcceptLanguage } from './ua.js';
export {
  Humanize,
  type HumanizeDefaults,
  type HumanizeSpeed,
  type MoveOptions,
  type ClickOptions,
  type TypeOptions,
  type PageLike as HumanizePageLike,
  type LocatorLike as HumanizeLocatorLike,
  type BoundingBox as HumanizeBoundingBox,
  planMouseTrajectory,
  type PlanMouseInput,
  type MousePoint,
  type Point as MousePointXY,
  planTypingPlan,
  type PlanTypingInput,
  type KeyEvent as HumanizeKeyEvent,
  makeRng as makeHumanizeRng,
  type Rng as HumanizeRng,
} from './humanize/index.js';
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
