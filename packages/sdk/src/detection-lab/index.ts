/**
 * @mosaiq/sdk/detection-lab — Detection Lab 公共 barrel。
 *
 * v0.8 起把 bench-only 的检测站 specs / extractors / 类型契约提升到 SDK src/，
 * 让 desktop app 主进程（不能依赖 `bench/`，`bench/` 不在 dist 里）也能 import。
 *
 * 用法：
 * ```ts
 * import {
 *   SITES,
 *   extractCreepjsFromDocument,
 *   emptyHitsBySurface,
 *   type DetectionRun,
 *   type DetectionScore,
 *   type SiteResult,
 * } from '@mosaiq/sdk';
 * ```
 *
 * 设计选择（v0.8 演进）：
 *   - 8.1 / 8.2 — 类型 + sites + scorer 是 pure（无 side-effect / 无 IO），
 *     renderer 可以 import 这些子模块做卡片预览算分。
 *   - 8.3 — 加入 `runDetection` / `runOnePage`：依赖 `playwright-core` 与 fs，
 *     **Node-only**。renderer 不能直接 import 这层，必须走 main process IPC。
 *   - 8.4 — storage（`saveDetectionRun` / `loadDetectionRun` / `listDetectionRuns`
 *     / `deleteDetectionRun` / `getDetectionRunArtifactDir`）：也 Node-only，但
 *     8.5 main 进程的 IPC handler 直接 import；renderer 通过 preload bridge 拿
 *     `DetectionRunSummary[]` / `DetectionRun`（两者都是 POJO，IPC-safe）。
 *
 * 实操上 `@mosaiq/sdk` 整体已经是 Node-only 包（launcher 用 chromium），所以
 * renderer 永远走 preload bridge；这里的 pure / impure 区分主要影响 desktop
 * main process 的依赖图清晰度，以及未来若要把 scorer 单独打包给 web 用时的
 * 拆分点（`@mosaiq/sdk/detection-lab/scorer` 直接出 ESM）。
 */

export { SITES, extractCreepjsFromDocument } from './sites.js';

export {
  emptyHitsBySurface,
  type DetectionRun,
  type DetectionRunRaw,
  type DetectionScore,
  type HitSeverity,
  type HitsBySurface,
  type RunProgressEvent,
  type RunProgressPhase,
  type RunStatus,
  type SiteResult,
  type SiteSpec,
  type SurfaceHit,
  type SurfaceName,
} from './types.js';

export {
  runDetection,
  runOnePage,
  snapshotPersona,
  type RunDetectionOptions,
  type RunDetectionResult,
  type RunDetectionDeps,
} from './runner.js';

export {
  saveDetectionRun,
  loadDetectionRun,
  listDetectionRuns,
  deleteDetectionRun,
  getDetectionRunArtifactDir,
  type DetectionRunSummary,
} from './run-store.js';

export {
  // 主入口
  computeScore,
  // helpers（bench / desktop renderer 复用）
  attributeSurface,
  normalizeWebglString,
  parseUniquenessPct,
  weightHit,
  weightedHitsSum,
  scoreSiteResult,
  // 路由表
  SEVERITY_WEIGHT,
  SURFACE_PATTERNS,
  DBI_KEY_TO_SURFACE,
  FPSCANNER_TO_SURFACE,
  KNOWN_OUTDATED_FPSCANNER_RULES,
  // site scorers（极少需要单独调用，通常用 computeScore；但 desktop preview 卡片
  // 可能想"重算单站"——先 export 全部，未来按需收紧）
  scoreSannysoft,
  scoreCreepjs,
  scoreIphey,
  scoreBrowserleaksCanvas,
  scoreBrowserleaksWebgl,
  scoreBrowserleaksGeneric,
  scoreDbiBot,
  scoreAmIUnique,
  scoreAntoinevastel,
  scoreIncolumitas,
  scoreFingerprintScan,
  scorePixelscan,
  type SitePartialScore,
} from './scorer.js';
