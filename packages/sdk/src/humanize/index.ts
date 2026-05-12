/**
 * Humanize 引擎公共出口。
 *
 * 调用方推荐通过 `BrowserSession.humanize` 使用；这里导出底层类型与纯函数，
 * 方便后续 v0.3 替换 mouse trajectory 实现（minimum-jerk）或扩展 keyboard
 * 节律模型时不破坏 API。
 */

export {
  Humanize,
  type HumanizeDefaults,
  type HumanizeSpeed,
  type MoveOptions,
  type ClickOptions,
  type TypeOptions,
  type PageLike,
  type LocatorLike,
  type BoundingBox,
} from './humanize.js';

export {
  planMouseTrajectory,
  type PlanMouseInput,
  type MousePoint,
  type Point,
} from './mouse.js';

export {
  planTypingPlan,
  type PlanTypingInput,
  type KeyEvent,
} from './keyboard.js';

export { makeRng, clamp, type Rng } from './rng.js';
