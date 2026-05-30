/**
 * `mosaiq detection-lab run-all` 的纯逻辑 helpers — 没有 IO，没有 argv 处理，
 * 没有 console 写入。让 driver loop（`run-all.ts`）保持薄、聚合 / exit-code
 * 决策可单元测试。
 *
 * 设计原则（和 9.6 / 9.8 一致）：
 *   - 输入：已 load 好的 Persona[] / DetectionRun / Policy POJO
 *   - 输出：纯数据 POJO，可序列化、structured-clone-safe（未来 desktop 想做
 *     batch run 页面也能直接消费）
 *   - 不抛错：边界情况返回空数组 / 0 / null，让调用方决定渲染或 exit code
 */
import type { DetectionRun, Persona } from '@runova/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// Persona 选择
// ─────────────────────────────────────────────────────────────────────────────

export interface PersonaSelection {
  /** 命中 --only / --skip 过滤后实际要跑的 personas，按 input 顺序保留。 */
  selected: Persona[];
  /** 用户在 --only / --skip 里写但 listPersonas() 里不存在的 id（用来友好提示）。 */
  unknownIds: string[];
}

export interface SelectOptions {
  /** Comma-pre-split id 数组；undefined = 不过滤（跑全部）。 */
  only?: readonly string[];
  /** Comma-pre-split id 数组；undefined = 不排除。 */
  skip?: readonly string[];
}

/**
 * 给定全部 persona + --only / --skip，返回最终入选清单。
 *
 * 语义：
 *   - 没传 only / skip：全跑，顺序 = listPersonas() 的原顺序（kebab-case 字典序，CI 稳定）
 *   - only 传了：只保留 only 里的 id（保持 only 列表顺序，让用户可控行序）
 *   - skip 传了：把 skip 列表里的 id 从结果剔除
 *   - both 传了：先 only 后 skip（skip 优先 — "白名单减黑名单"）
 *   - only / skip 里写错的 id（不存在）→ 收集到 unknownIds，调用方决定 warn 或 abort
 *
 * 注意：only 顺序优先于 list 原顺序——用户写 `--only c,a,b` 期望按 c→a→b 跑；
 * skip 不重排，因为它只是减法。
 */
export function selectPersonas(
  all: readonly Persona[],
  options: SelectOptions = {},
): PersonaSelection {
  const byId = new Map<string, Persona>();
  for (const p of all) byId.set(p.metadata.id, p);

  const unknownIds: string[] = [];

  let candidates: Persona[];
  if (options.only && options.only.length > 0) {
    candidates = [];
    for (const id of options.only) {
      const p = byId.get(id);
      if (p) {
        candidates.push(p);
      } else {
        unknownIds.push(id);
      }
    }
  } else {
    candidates = [...all];
  }

  if (options.skip && options.skip.length > 0) {
    const skipSet = new Set(options.skip);
    // unknown skip ids 也收集（让用户知道 typo）
    for (const id of options.skip) {
      if (!byId.has(id)) unknownIds.push(id);
    }
    candidates = candidates.filter((p) => !skipSet.has(p.metadata.id));
  }

  return { selected: candidates, unknownIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-persona run result + batch 聚合
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regression 判定结果（如果该 persona 上还有过往 saved run，且本次 run 退化）。
 *
 * 逻辑借用 9.8 SDK 的 `diffRuns(...).hasRegression` 语义：A 是 saved 里上一次
 * （startedAt 第二新的）run，B 是本次刚跑的 run；hasRegression = added.length > 0
 * 或 deltaWeighted > 0 或 sitesFlipped.okToFail.length > 0。
 */
export interface RegressionInfo {
  /** 用作基线的上一次 run 的 id（`runA`）。 */
  previousRunId: string;
  /** B - A 的 added hits 数（identity 维度 — 同 surface/site/detector）。 */
  addedHits: number;
  /** B - A 的 weightedHits 差值（>0 = 退化）。 */
  deltaWeightedHits: number;
  /** A 通过、B 失败的站点 id 列表（`sitesFlipped.okToFail`）。 */
  okToFail: string[];
}

/** 一个 persona 在 batch 里跑完 detection 的结果。 */
export interface PersonaBatchResult {
  personaId: string;
  displayName?: string | undefined;
  /** 'completed' / 'canceled' / 'failed' — 与 DetectionRun.status 对齐；
   *  'skipped' 用来标记被 unknown id / loadPersona 失败前置剔除的 entry。 */
  status: 'completed' | 'canceled' | 'failed' | 'skipped';
  runId: string | null;
  durationMs: number;
  sitesAttempted: number;
  sitesOk: number;
  sitesFail: number;
  totalHits: number;
  weightedHits: number;
  highHits: number;
  mediumHits: number;
  lowHits: number;
  /** runtime / setup error message（status='failed' 时通常非 null）。 */
  error: string | null;
  regression: RegressionInfo | null;
}

/** 整个 batch 的聚合数字 + 衍生指标（worst / regressions list）。 */
export interface BatchAggregate {
  personasAttempted: number;
  personasCompleted: number;
  personasCanceled: number;
  personasFailed: number;
  sitesAttempted: number;
  sitesOk: number;
  sitesFail: number;
  totalHits: number;
  weightedHits: number;
  highHits: number;
  mediumHits: number;
  lowHits: number;
  /** 触发了 regression 判定（status='completed' 且有 saved 历史 + 退化）的 persona id 列表。 */
  personasWithRegression: string[];
  /** 加权 hits 最多的那个 persona（最脏）；全 0 / 空时 null。 */
  worstPersona: { personaId: string; weightedHits: number; totalHits: number } | null;
}

/**
 * 把 per-persona 结果数组聚合成 batch 数字。
 *
 * 'skipped' 不计入 attempted（因为根本没跑）；'completed' / 'canceled' /
 * 'failed' 都计入 attempted。failed run 的 sites/hits 用 0（buildFailedRun
 * 写 `score: null`），不会污染加和。
 */
export function aggregateBatch(results: readonly PersonaBatchResult[]): BatchAggregate {
  const aggregate: BatchAggregate = {
    personasAttempted: 0,
    personasCompleted: 0,
    personasCanceled: 0,
    personasFailed: 0,
    sitesAttempted: 0,
    sitesOk: 0,
    sitesFail: 0,
    totalHits: 0,
    weightedHits: 0,
    highHits: 0,
    mediumHits: 0,
    lowHits: 0,
    personasWithRegression: [],
    worstPersona: null,
  };

  let worst: BatchAggregate['worstPersona'] = null;

  for (const r of results) {
    if (r.status === 'skipped') continue;
    aggregate.personasAttempted += 1;
    if (r.status === 'completed') aggregate.personasCompleted += 1;
    if (r.status === 'canceled') aggregate.personasCanceled += 1;
    if (r.status === 'failed') aggregate.personasFailed += 1;

    aggregate.sitesAttempted += r.sitesAttempted;
    aggregate.sitesOk += r.sitesOk;
    aggregate.sitesFail += r.sitesFail;
    aggregate.totalHits += r.totalHits;
    aggregate.weightedHits += r.weightedHits;
    aggregate.highHits += r.highHits;
    aggregate.mediumHits += r.mediumHits;
    aggregate.lowHits += r.lowHits;

    if (r.regression) aggregate.personasWithRegression.push(r.personaId);

    // worst tiebreaker: weightedHits desc, then totalHits desc, then personaId asc
    if (r.weightedHits > 0 || r.totalHits > 0) {
      if (
        worst === null ||
        r.weightedHits > worst.weightedHits ||
        (r.weightedHits === worst.weightedHits && r.totalHits > worst.totalHits) ||
        (r.weightedHits === worst.weightedHits &&
          r.totalHits === worst.totalHits &&
          r.personaId < worst.personaId)
      ) {
        worst = {
          personaId: r.personaId,
          weightedHits: r.weightedHits,
          totalHits: r.totalHits,
        };
      }
    }
  }

  // round weightedHits to 2 decimals (matches DetectionScore display convention)
  aggregate.weightedHits = Math.round(aggregate.weightedHits * 100) / 100;

  aggregate.worstPersona = worst;
  return aggregate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit-code 决策
// ─────────────────────────────────────────────────────────────────────────────

export type FailOnHitsLevel = 'none' | 'any' | 'medium' | 'high';

export interface BatchPolicy {
  failOnHits: FailOnHitsLevel;
  failOnRegression: boolean;
}

/**
 * 决定 batch 命令最终 exit code（不含 SIGINT=130 / arg-error=2 的短路；
 * 那些由命令本体直接 `return`）。
 *
 * 决策表：
 *   - personasFailed > 0 → 1（runtime 错误：browser 启动失败 / persona 不存在
 *                            / network 中断等。永远不被 fail-on-hits=none mask；
 *                            mask 它会让 CI 误判"绿灯"）
 *   - failOnRegression + 任一 persona 退化 → 1
 *   - failOnHits 触发（按 level 判断累积 hits）→ 1
 *   - 其它 → 0
 *
 * 注：我们故意把 `personasFailed > 0` 放在最优先 — runtime error 是 hard
 * signal，应永远 surfaceable，与 single-persona `run` 的语义一致（run 在
 * detection 抛错时也 return 2，不被 --fail-on-hits=none 救回）。在 batch 用 1
 * 而不是 2 是因为：2 是 setup 错（参数不对 / 一个 persona 都选不出），1 是
 * "跑完了但有问题"——batch 跑完了部分 persona、有数据可看，更接近 1。
 */
export function decideBatchExitCode(aggregate: BatchAggregate, policy: BatchPolicy): number {
  if (aggregate.personasFailed > 0) return 1;
  if (policy.failOnRegression && aggregate.personasWithRegression.length > 0) return 1;
  if (shouldFailOnHits(aggregate, policy.failOnHits)) return 1;
  return 0;
}

function shouldFailOnHits(aggregate: BatchAggregate, level: FailOnHitsLevel): boolean {
  switch (level) {
    case 'none':
      return false;
    case 'any':
      return aggregate.totalHits > 0;
    case 'medium':
      return aggregate.mediumHits + aggregate.highHits > 0;
    case 'high':
      return aggregate.highHits > 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression 提取（从 listDetectionRuns 历史 + diffRuns 构造 RegressionInfo）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 saved DetectionRun 历史里挑选用作 baseline 的"上一次"run。
 *
 * 输入：本次 run 的 id + 该 persona 所有 saved runs（含本次刚 save 的、SDK
 * `listDetectionRuns` 返回 startedAt desc 顺序）。
 *
 * 输出：startedAt 严格小于 currentRun.startedAt 且 status==='completed' 的最近
 * 一次；找不到 → null（首次跑、之前都 failed/canceled 等）。
 *
 * 选 'completed' 是因为只有 completed run 才有可信 score 给 diffRuns 用——
 * failed run 没 score、canceled run 部分 hits 不稳定，作为 baseline 会引入误差。
 */
export function findRegressionBaseline(
  current: DetectionRun,
  history: readonly DetectionRun[],
): DetectionRun | null {
  const currentMs = Date.parse(current.startedAt);
  if (!Number.isFinite(currentMs)) return null;

  let best: DetectionRun | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const r of history) {
    if (r.id === current.id) continue;
    if (r.status !== 'completed') continue;
    const t = Date.parse(r.startedAt);
    if (!Number.isFinite(t)) continue;
    if (t < currentMs && t > bestMs) {
      best = r;
      bestMs = t;
    }
  }
  return best;
}
