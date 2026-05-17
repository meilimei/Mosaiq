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
 * 设计选择：所有运行时函数在这一层都 pure（无 side-effect、无 IO），便于 main / renderer
 * 双向 import 而不引入 Node-only 依赖。需要 IO 的 runner / storage 之后再
 * 增量加进来（v0.8 后续锤）；scorer 已落位，输出 `DetectionScore`。
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
