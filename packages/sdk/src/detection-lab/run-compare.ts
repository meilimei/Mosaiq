/**
 * Pure DetectionRun diff — `diffRuns(personaId, a, b): RunDiff`.
 *
 * 用途：CLI `detection-lab compare` 命令、桌面端「Compare Runs」页面（9.9+
 * 计划）共用同一份差异计算。严格无 I/O；纯 `(personaId, DetectionRun, DetectionRun)
 * → RunDiff` 投影 —— 输入 const-ref，不修改；输出是 structured-clone-safe POJO。
 *
 * 设计原则（与 `formatDetectionRunMarkdown` / `computeScore` 等 pure 模块对齐）：
 *   - 输入：A = baseline（older / 参考基线），B = candidate（newer / 待评估）
 *   - 输出：delta = B - A；负 = B 更好，正 = B 更差
 *   - Hit identity = `(surface, site, detector)`；同 identity 内 severity / evidence
 *     变化记为 `changed`，不计 added / removed
 *   - 失败 / 取消的 run（score == null）按 0 weightedHits + 空 hits 处理；调用方
 *     仍可从 `runA.status` / `runB.status` 看到状态差异
 *
 * 不在本模块做的事（明确 out-of-scope）：
 *   - I/O：调用方负责 `loadDetectionRun`，传 in-memory 对象进来
 *   - 着色 / 渲染：CLI 自己的 `printDiff` + 桌面自己的 React 组件分别消费
 *   - 阈值策略：`hasRegression` 是一个固定布尔（added.length > 0 ‖
 *     delta.weightedHits > 0 ‖ okToFail.length > 0），不接受配置；
 *     调用方想要别的 policy 可以自己组合 `RunDiff` 字段
 *
 * 9.8 重构：原始实现 v0.9 phase 9.2b 落在 `packages/cli/src/commands/
 * detection-lab/compare.ts`；9.8 把纯逻辑 + 类型上抬到 SDK，CLI 改为 import；
 * 行为 byte-identical（CLI baseline-vs-after smoke 已校验）。
 */

import type { DetectionRun, SurfaceHit } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 公共类型
// ─────────────────────────────────────────────────────────────────────────────

/** 一个 hit 的「identity 三元组」—— 在两个 run 之间匹配同一个概念上的命中。 */
interface HitIdentity {
  surface: string;
  site: string;
  detector: string;
}

/**
 * Hit identity 相同、但 severity / evidence 在 A 和 B 之间有变化的命中。
 * 调用方可以用 `diff` 字段精确定位哪些字段动了。
 */
export interface ChangedHit {
  before: SurfaceHit;
  after: SurfaceHit;
  /** 在同 identity 内变化的字段集合（必非空，否则不会进 changed 数组）。 */
  diff: Array<'severity' | 'evidence'>;
}

/**
 * 单个 run 的紧凑快照 —— diff 上下文里展示用的最小字段集合。
 * 不嵌完整 DetectionRun 是为了让 RunDiff 序列化体积可控（CI / IPC 消息友好）。
 */
export interface RunSnapshot {
  id: string;
  status: DetectionRun['status'];
  durationMs: number;
  weightedHits: number;
  totalHits: number;
  sitesOk: number;
  sitesFail: number;
}

/**
 * Run 对 Run 差异结果。结构稳定、structured-clone-safe，可直接 JSON 序列化
 * 或 Electron IPC 传输。
 *
 * delta = B - A：
 *   - `delta.weightedHits < 0` → B 比 A 更干净
 *   - `delta.weightedHits > 0` → B 比 A 更脏
 */
export interface RunDiff {
  personaId: string;
  runA: RunSnapshot;
  runB: RunSnapshot;
  delta: {
    weightedHits: number;
    totalHits: number;
    sitesOk: number;
    sitesFail: number;
  };
  /** A 有、B 没有的 hits（identity 维度）—— B 改进的证据。 */
  removed: SurfaceHit[];
  /** A 没有、B 有的 hits —— B 退化的证据。 */
  added: SurfaceHit[];
  /** identity 相同但字段（severity / evidence）变了的 hits。 */
  changed: ChangedHit[];
  /** 站点 ok ↔ fail 翻转。okToFail = 在 A ok 在 B fail；failToOk 反之。 */
  sitesFlipped: {
    okToFail: string[];
    failToOk: string[];
  };
  /** A 跑了、B 没跑的 site id（例如两次 run 用了不同的 `--only` flag）。 */
  sitesOnlyInA: string[];
  /** B 跑了、A 没跑的 site id。 */
  sitesOnlyInB: string[];
  /**
   * 固定 regression policy：
   *   - 有任何 added hit  → true
   *   - delta.weightedHits > 0 → true
   *   - 有任何 okToFail 翻转 → true
   * 否则 false。CI 工具（CLI `--fail-on-regression`）直接读这个布尔。
   */
  hasRegression: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算两个 DetectionRun 之间的差异。纯函数 —— 没有 I/O，输入不修改。
 *
 * Failed / canceled 的 run（`score == null`）按 0 weightedHits + 空 hits
 * 处理；状态差异仍通过 `runA.status` / `runB.status` 可见。
 */
export function diffRuns(personaId: string, a: DetectionRun, b: DetectionRun): RunDiff {
  const snapA = toSnapshot(a);
  const snapB = toSnapshot(b);

  const hitsA = a.score?.hits ?? [];
  const hitsB = b.score?.hits ?? [];

  const indexA = indexHits(hitsA);
  const indexB = indexHits(hitsB);

  const removed: SurfaceHit[] = [];
  const added: SurfaceHit[] = [];
  const changed: ChangedHit[] = [];

  for (const [key, hit] of indexA) {
    const counterpart = indexB.get(key);
    if (!counterpart) {
      removed.push(hit);
      continue;
    }
    const fields = diffHitFields(hit, counterpart);
    if (fields.length > 0) {
      changed.push({ before: hit, after: counterpart, diff: fields });
    }
  }
  for (const [key, hit] of indexB) {
    if (!indexA.has(key)) added.push(hit);
  }

  // Site flip 检测 —— 需要 raw.results
  const resultsA = a.raw?.results ?? [];
  const resultsB = b.raw?.results ?? [];
  const okMapA = new Map(resultsA.map((r) => [r.id, r.ok]));
  const okMapB = new Map(resultsB.map((r) => [r.id, r.ok]));

  const okToFail: string[] = [];
  const failToOk: string[] = [];
  const sitesOnlyInA: string[] = [];
  const sitesOnlyInB: string[] = [];

  for (const [siteId, okA] of okMapA) {
    const okB = okMapB.get(siteId);
    if (okB === undefined) {
      sitesOnlyInA.push(siteId);
      continue;
    }
    if (okA && !okB) okToFail.push(siteId);
    else if (!okA && okB) failToOk.push(siteId);
  }
  for (const siteId of okMapB.keys()) {
    if (!okMapA.has(siteId)) sitesOnlyInB.push(siteId);
  }

  const delta = {
    weightedHits: snapB.weightedHits - snapA.weightedHits,
    totalHits: snapB.totalHits - snapA.totalHits,
    sitesOk: snapB.sitesOk - snapA.sitesOk,
    sitesFail: snapB.sitesFail - snapA.sitesFail,
  };

  const hasRegression = added.length > 0 || delta.weightedHits > 0 || okToFail.length > 0;

  return {
    personaId,
    runA: snapA,
    runB: snapB,
    delta,
    removed,
    added,
    changed,
    sitesFlipped: { okToFail, failToOk },
    sitesOnlyInA,
    sitesOnlyInB,
    hasRegression,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 私有 helpers
// ─────────────────────────────────────────────────────────────────────────────

function toSnapshot(run: DetectionRun): RunSnapshot {
  const score = run.score;
  return {
    id: run.id,
    status: run.status,
    durationMs: run.durationMs,
    weightedHits: score?.weightedHits ?? 0,
    totalHits: score?.hits.length ?? 0,
    sitesOk: score?.sitesOk ?? 0,
    sitesFail: score?.sitesFail ?? 0,
  };
}

/**
 * Hit identity 的 key 编码。用 `\x00` 当分隔符（不可见 + 几乎不会出现在 surface
 * / site / detector 文本里），避免字段值里有 `:` / `|` 撞键。
 */
function hitKey(h: HitIdentity): string {
  return `${h.surface}\x00${h.site}\x00${h.detector}`;
}

function indexHits(hits: readonly SurfaceHit[]): Map<string, SurfaceHit> {
  const m = new Map<string, SurfaceHit>();
  for (const h of hits) m.set(hitKey(h), h);
  return m;
}

function diffHitFields(a: SurfaceHit, b: SurfaceHit): Array<'severity' | 'evidence'> {
  const out: Array<'severity' | 'evidence'> = [];
  if (a.severity !== b.severity) out.push('severity');
  if (a.evidence !== b.evidence) out.push('evidence');
  return out;
}
