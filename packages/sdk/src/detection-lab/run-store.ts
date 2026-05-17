/**
 * detection-lab/run-store — DetectionRun JSON 持久化。
 *
 * 路径：`<runtimeRoot>/detection-runs/<personaId>/<runId>.json`
 * Artifacts：`<runtimeRoot>/detection-runs/<personaId>/<runId>/`（screenshots /
 * html，由 `runDetection` 写；run-store 自身不创建，但 `deleteDetectionRun`
 * 会一并清理避免磁盘泄漏）。
 *
 * 设计选择：
 *   - 每个 run 一个 JSON 文件 + 同名 artifacts 子目录，按 prefix `<runId>` 整体可删
 *   - `listDetectionRuns` 读每个 .json 顶层字段构造 summary，丢弃完整 DetectionRun，
 *     避免 100+ 历史 run 一次性持有所有 `score.hits[]` 在内存里
 *   - 暂不做 zod 校验（DetectionRunSchema 还未写，v0.8 后续锤再补）；坏文件 list
 *     时 warn 跳过、load 时抛——形状校验用 `isDetectionRun` 浅检查兜底
 *   - paths.ts 三个 helper 是纯字符串拼接，mkdir 责任收敛到 `saveDetectionRun` 一处
 *
 * IPC 边界：renderer 不直接 import 此模块（Node-only：fs / path）。8.5 main.ts
 * 在 IPC handler 里调用，把 DetectionRun / DetectionRunSummary 序列化跨 IPC 给
 * preload bridge——这两个类型都是 POJO，可直接 structuredClone。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { PersonaId } from '@mosaiq/persona-schema';

import {
  getDetectionRunFile,
  getDetectionRunsDir,
  type PathConfig,
} from '../paths.js';
import type { DetectionRun } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Summary 类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * UI 列表 / 历史表项消费的轻量元信息。
 *
 * 故意**不嵌入** `DetectionScore.hits[]` 或 `SiteResult[]` —— `listDetectionRuns`
 * 把每个 run 文件 parse 后只 project 顶层数字字段，让 100 个历史 run 在内存里
 * 仅占数十 KB（每个 summary ~150 字节）。需要 drill-down 时调 `loadDetectionRun`。
 *
 * 字段映射自 `DetectionRun`：
 *   - timestamp    ← run.startedAt
 *   - durationMs   ← run.durationMs
 *   - sitesAttempted ← run.sitesAttempted.length
 *   - sitesOk / sitesFail ← run.score?.sitesOk/Fail（失败 run 无 score 时为 0）
 *   - totalHits    ← run.score?.hits.length
 *   - weightedHits ← run.score?.weightedHits
 *   - status       ← run.status（v0.8 决定加上：UI 列表要画 status badge）
 */
export interface DetectionRunSummary {
  runId: string;
  personaId: PersonaId;
  /** ISO timestamp（= `DetectionRun.startedAt`，命名上对齐 raw.timestamp） */
  timestamp: string;
  /** `DetectionRun.status` — UI 用来画 status badge（pending/running 显示进度，completed/failed/canceled 显示结果） */
  status: DetectionRun['status'];
  durationMs: number;
  sitesAttempted: number;
  sitesOk: number;
  sitesFail: number;
  /** = `score.hits.length`；failed / canceled 且无 score 时为 0 */
  totalHits: number;
  /** = `score.weightedHits`；同上 fallback 0 */
  weightedHits: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 DetectionRun 写到 `<runtimeRoot>/detection-runs/<personaId>/<run.id>.json`。
 *
 * 写盘前 mkdir -p 父目录；JSON.stringify with indent=2 便于人工 grep / diff。
 * **不做** zod 校验（DetectionRunSchema 待写）；调用方负责传符合 `DetectionRun`
 * shape 的对象——8.5 main.ts 在拿到 `runDetection` 返回的 `{ raw, score }` 后
 * 自构 DetectionRun 写盘。
 */
export function saveDetectionRun(
  personaId: PersonaId,
  run: DetectionRun,
  config?: PathConfig,
): void {
  const dir = getDetectionRunsDir(personaId, config);
  mkdirSync(dir, { recursive: true });
  const file = getDetectionRunFile(personaId, run.id, config);
  writeFileSync(file, JSON.stringify(run, null, 2), 'utf-8');
}

/**
 * 读取一次 run 的完整 DetectionRun。文件不存在或 shape 不符抛错。
 *
 * UI drill-down（点击列表项 → 进 run 详情页）走这条路径；列表本身用
 * `listDetectionRuns` 拿 summary。
 */
export function loadDetectionRun(
  personaId: PersonaId,
  runId: string,
  config?: PathConfig,
): DetectionRun {
  const file = getDetectionRunFile(personaId, runId, config);
  if (!existsSync(file)) {
    throw new Error(
      `DetectionRun not found: ${personaId}/${runId} (expected at ${file})`,
    );
  }
  const raw = readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isDetectionRun(parsed)) {
    throw new Error(`Corrupt DetectionRun JSON: ${file}`);
  }
  return parsed;
}

/**
 * 列出某 persona 全部历史 detection runs（按 startedAt 降序，最新在前）。
 *
 * 内部对每个 .json 文件 read + parse + project to summary + discard parsed run —
 * 不在内存里保留完整 DetectionRun，避免 OOM 风险。
 *
 * 容错：
 *   - 目录不存在（persona 从未跑过 detection） → 返回 `[]`
 *   - 单个文件 JSON 坏 / shape 不符 → `console.warn` 跳过，不阻断其它文件
 */
export function listDetectionRuns(
  personaId: PersonaId,
  config?: PathConfig,
): DetectionRunSummary[] {
  const dir = getDetectionRunsDir(personaId, config);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const summaries: DetectionRunSummary[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isDetectionRun(parsed)) {
        console.warn(
          `[mosaiq] skipping invalid DetectionRun file ${personaId}/${f}: shape mismatch`,
        );
        continue;
      }
      summaries.push(toSummary(parsed));
    } catch (err) {
      console.warn(
        `[mosaiq] skipping unreadable DetectionRun file ${personaId}/${f}:`,
        (err as Error).message,
      );
    }
  }

  // 默认按 startedAt 降序（最新在前），UI 列表直接渲染不用再 sort
  summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return summaries;
}

/**
 * 删除一次 run（含 .json 文件 + 同名 artifacts 子目录）。
 *
 * 返回值：
 *   - `true`  — .json 文件存在并被删除（artifacts 子目录有则一并 rmSync）
 *   - `false` — .json 文件本来就不存在；视作 idempotent no-op
 *
 * artifacts rmSync 失败不阻断也不冒泡（残留只是磁盘占用，逻辑上 run 已经删了）。
 */
export function deleteDetectionRun(
  personaId: PersonaId,
  runId: string,
  config?: PathConfig,
): boolean {
  const file = getDetectionRunFile(personaId, runId, config);
  if (!existsSync(file)) return false;
  unlinkSync(file);

  const artifactDir = getDetectionRunArtifactDir(personaId, runId, config);
  if (existsSync(artifactDir)) {
    try {
      rmSync(artifactDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[mosaiq] failed to remove DetectionRun artifacts ${artifactDir}:`,
        (err as Error).message,
      );
    }
  }
  return true;
}

/**
 * 单次 run 的 artifacts 子目录：`<...>/<personaId>/<runId>/`。
 *
 * `runDetection({ artifactDir })` 写 HTML / 截图到这里。**不副作用 mkdir** —
 * 8.5 main.ts 调用 `runDetection` 时传给它，由 runDetection 内部按需 mkdir。
 *
 * 这层不属于 paths.ts 的原因：artifact 目录命名规则（与 .json 文件同名 prefix）
 * 是 run-store 的私有约定，paths.ts 暂不暴露此细节。
 */
export function getDetectionRunArtifactDir(
  personaId: PersonaId,
  runId: string,
  config?: PathConfig,
): string {
  return join(getDetectionRunsDir(personaId, config), runId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部 helpers
// ─────────────────────────────────────────────────────────────────────────────

function toSummary(run: DetectionRun): DetectionRunSummary {
  return {
    runId: run.id,
    personaId: run.personaId,
    timestamp: run.startedAt,
    status: run.status,
    durationMs: run.durationMs,
    sitesAttempted: run.sitesAttempted.length,
    sitesOk: run.score?.sitesOk ?? 0,
    sitesFail: run.score?.sitesFail ?? 0,
    totalHits: run.score?.hits.length ?? 0,
    weightedHits: run.score?.weightedHits ?? 0,
  };
}

/**
 * 浅结构校验：检查 DetectionRun 顶层必填字段。
 *
 * 不做 zod 全验证（DetectionRunSchema 还未写——v0.8 后续锤再补），但拦下完全
 * 不符的 JSON（比如错把 persona 文件丢进 detection-runs/ 目录）。当前要求：
 *   - id / personaId / startedAt / status 都是 string
 *   - sitesAttempted 是数组（即使空）
 *   - durationMs 是 number
 *
 * 不验 score / error / meta 是因为 failed/canceled 时 score=null 是合法状态。
 */
function isDetectionRun(value: unknown): value is DetectionRun {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.personaId === 'string' &&
    typeof v.startedAt === 'string' &&
    typeof v.status === 'string' &&
    Array.isArray(v.sitesAttempted) &&
    typeof v.durationMs === 'number'
  );
}
