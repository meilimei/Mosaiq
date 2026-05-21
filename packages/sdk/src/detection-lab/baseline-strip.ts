/**
 * Pure DetectionRun → "stable baseline" projection.
 *
 * 用途（v0.10 CI Detection Lab regression gate）：
 *   1. CI 上 nightly 跑出 candidate run（含全部 dynamic 字段：runId、时间戳、
 *      durationMs、artifact 路径、page bodyText 时间戳…）
 *   2. `stripRunForBaseline(candidate)` 投影出稳定快照
 *   3. 与磁盘上 `tests/fixtures/baseline-runs/<persona>/baseline.json` 里同样
 *      经过 strip 的 baseline 比对
 *   4. `diffRuns(personaId, baseline, candidate_stripped)` → 真正的"行为差异"
 *      （hits + per-site ok 状态）；不带 strip 时整个 git diff 永远红。
 *
 * 设计原则：
 *   - 输入 const-ref，不修改原 run；输出新 POJO，结构-clone-safe
 *   - 不删字段、只替换值 —— 保持 DetectionRun schema 完整，下游 `diffRuns` /
 *     `formatDetectionRunMarkdown` 照常工作；git diff 上 "duration: 0" 也比
 *     "field missing" 更可读
 *   - 替换占位值用导出常量，方便调用方做 "is-stripped?" 判定 / mock
 *
 * 替换的字段（每次跑都不同 → 影响 git diff 噪声）：
 *   - DetectionRun.id, startedAt, finishedAt, durationMs
 *   - DetectionRun.meta.chromiumVersion
 *   - raw.timestamp, raw.overallMs
 *   - raw.results[i].durationMs / screenshot / html / retries / bodyText
 *     / title / error
 *
 * 不动的字段（CI gate 关心的"行为信号"）：
 *   - personaId, status, sitesAttempted
 *   - score（hits / weightedHits / hitsBySurface / ...）
 *   - meta.sdkVersion（SDK 升级触发 baseline 刷新是预期，不抹）
 *   - raw.persona（persona snapshot，对同一 fixture persona 是稳定的）
 *   - raw.results[i].id / name / url / ok / extracted（baseline identity +
 *     真正的行为信号 — 比如 sannysoft extracted 的测试 pass/fail map）
 *
 * 不在本模块做的事：
 *   - 文件 I/O（调用方 `JSON.stringify` + `writeFile`）
 *   - schema 校验（输出仍是合法 DetectionRun，调用方按需 `parse...` 再校验）
 */

import type { DetectionRun, DetectionRunRaw, SiteResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 稳定占位常量（避免 magic string 散落各处；调用方做 `is-stripped` 判定时
// 可以直接 import 比对）
// ─────────────────────────────────────────────────────────────────────────────

/** Unix epoch — 替换 startedAt / finishedAt / raw.timestamp 用。 */
export const BASELINE_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** 替换 DetectionRun.id（原 = ISO 时间戳折叠，每次都不同）用。 */
export const BASELINE_RUN_ID = 'baseline';

/** 替换 meta.chromiumVersion（host 依赖：Linux runner / 开发者 Mac / Win 各异）用。 */
export const BASELINE_CHROMIUM_VERSION = 'baseline';

// ─────────────────────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 DetectionRun 投影成 git-trackable 稳定快照。返回新对象，不修改入参。
 *
 * 接受任何 status 的 run，但 baseline 的语义只在 `status === 'completed'`
 * 时有意义；非 completed 输入会被原样保留 status，并按字段可能性 strip。
 * 调用方若想强制只在 completed 才接受，自己在外面校验。
 */
export function stripRunForBaseline(run: DetectionRun): DetectionRun {
  return {
    ...run,
    id: BASELINE_RUN_ID,
    startedAt: BASELINE_TIMESTAMP,
    finishedAt: run.finishedAt === null ? null : BASELINE_TIMESTAMP,
    durationMs: 0,
    meta: {
      sdkVersion: run.meta.sdkVersion,
      chromiumVersion: BASELINE_CHROMIUM_VERSION,
    },
    raw: run.raw ? stripRaw(run.raw) : run.raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 私有 helpers
// ─────────────────────────────────────────────────────────────────────────────

function stripRaw(raw: DetectionRunRaw): DetectionRunRaw {
  return {
    ...raw,
    timestamp: BASELINE_TIMESTAMP,
    overallMs: 0,
    results: raw.results.map(stripSiteResult),
  };
}

/**
 * SiteResult 中只保留 baseline-stable 的子集字段，其它（durationMs / screenshot
 * / html / retries / bodyText / title / error）直接 omit。`ok=false` 已经把
 * "站点失败"这件事编码了，错误消息文本是 host / network 依赖的噪声。
 */
function stripSiteResult(r: SiteResult): SiteResult {
  const stripped: SiteResult = {
    id: r.id,
    name: r.name,
    url: r.url,
    ok: r.ok,
    durationMs: 0,
  };
  // extracted 是站点特异的结构化结果（如 sannysoft 的 pass/fail map），是真正
  // 的行为信号，必须保留 —— 它和 score.hits 是双向 cross-check 的来源。
  if (r.extracted !== undefined) stripped.extracted = r.extracted;
  return stripped;
}
