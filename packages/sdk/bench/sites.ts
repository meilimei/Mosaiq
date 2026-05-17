/**
 * bench/sites — thin re-export shim.
 *
 * v0.8 起检测站点 specs + extractors 已搬到 `src/detection-lab/sites.ts`，让
 * desktop app 主进程也能 import（不能依赖 `bench/`，bench 不在 dist 里）。
 *
 * 本文件保留旧 import 路径（`./sites.js`）。新代码请直接 import:
 *   - 从源码：`@/d:/projects/Mosaiq/packages/sdk/src/detection-lab/sites.ts`
 *   - 通过 SDK 公共 API：`import { SITES } from '@mosaiq/sdk'`
 */

export {
  SITES,
  extractCreepjsFromDocument,
} from '../src/detection-lab/sites.js';

export type {
  SiteResult,
  SiteSpec,
} from '../src/detection-lab/types.js';
