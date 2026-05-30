/**
 * @runova/sdk — Mosaiq SDK 公共 API。
 *
 * 使用示例：
 * ```ts
 * import { launchPersona, loadPersona } from '@runova/sdk';
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
export { SDK_VERSION } from './version.js';
export {
  getInstalledChromeVersion,
  getInstalledChromeMajor,
} from './chromium-version.js';
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
  getDetectionRunsRoot,
  getDetectionRunsDir,
  getDetectionRunFile,
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
export {
  SITES,
  extractCreepjsFromDocument,
  emptyHitsBySurface,
  computeScore,
  attributeSurface,
  weightHit,
  weightedHitsSum,
  SEVERITY_WEIGHT,
  runDetection,
  runOnePage,
  snapshotPersona,
  saveDetectionRun,
  loadDetectionRun,
  listDetectionRuns,
  deleteDetectionRun,
  getDetectionRunArtifactDir,
  formatDetectionRunMarkdown,
  type FormatMarkdownOptions,
  diffRuns,
  type RunDiff,
  type RunSnapshot,
  type ChangedHit,
  stripRunForBaseline,
  BASELINE_RUN_ID,
  BASELINE_TIMESTAMP,
  BASELINE_CHROMIUM_VERSION,
  type DetectionRun,
  type DetectionRunRaw,
  type DetectionRunSummary,
  type DetectionScore,
  type HitSeverity,
  type HitsBySurface,
  type RunDetectionOptions,
  type RunDetectionResult,
  type RunDetectionDeps,
  type RunProgressEvent,
  type RunProgressPhase,
  type RunStatus,
  type SiteResult,
  type SiteSpec,
  type SitePartialScore,
  type SurfaceHit,
  type SurfaceName,
} from './detection-lab/index.js';

// Re-export persona-schema for convenience
export type {
  Persona,
  PersonaId,
  PersonaDraft,
  PersonaMetadata,
} from '@runova/persona-schema';
export { parsePersona, safeParsePersona } from '@runova/persona-schema';
