/**
 * Detection-lab `run` / `run-all` 共享的非渲染 helpers。
 *
 * 抽自 `run.ts`（v0.9 phase 9.10）：`runDetectionLabCommand` 和
 * `runDetectionLabRunAll` 都需要把一次 `runDetection(...)` 的结果包装成可
 * 持久化的 `DetectionRun` POJO。逻辑相同，渲染 / argv / exit-code 决策不同；
 * 因此把"包装 + 取 chromium 版本 + 取 template tag"这三段 pure logic 抽出。
 *
 * 这层文件**不**负责：
 *   - argv 解析（每个命令 self-host）
 *   - 进度打印（`run.ts` 一份；`run-all.ts` 一份带 `[i/N]` 前缀）
 *   - exit-code 决策（按命令的语义不同）
 *   - 渲染（继续走 `format.ts`）
 */

import {
  type DetectionRun,
  type DetectionRunRaw,
  type DetectionScore,
  SDK_VERSION,
  getInstalledChromeVersion,
} from '@mosaiq/sdk';

/**
 * 把 `runDetection(...)` 成功 / 取消的产出包装成可保存的 `DetectionRun`。
 *
 * - `status: 'completed'` 写入 score / raw / sdk+chrome 版本，是默认快乐路径。
 * - `status: 'canceled'` 同样保留 score / raw（部分结果有用），但 finishedAt
 *   仍然写当前时间——与 desktop main process 一致。
 */
export function buildCompletedRun(args: {
  runId: string;
  personaId: string;
  startedAtIso: string;
  startedAtMs: number;
  status: 'completed' | 'canceled';
  raw: DetectionRunRaw;
  score: DetectionScore;
}): DetectionRun {
  return {
    id: args.runId,
    personaId: args.personaId,
    startedAt: args.startedAtIso,
    finishedAt: new Date().toISOString(),
    status: args.status,
    sitesAttempted: args.raw.results.map((r) => r.id),
    durationMs: Date.now() - args.startedAtMs,
    score: args.score,
    raw: args.raw,
    error: null,
    meta: {
      sdkVersion: SDK_VERSION,
      chromiumVersion: safeChromiumVersion(),
    },
  };
}

/**
 * 把 `runDetection(...)` 抛错的情形包装成 `DetectionRun(status='failed')`。
 *
 * 失败的 run 仍然落盘——历史列表能看见红条，比"消失了"更易诊断。score / raw
 * 故意置 null：runDetection 抛错前通常没拿到完整 raw，写一半反而误导。
 */
export function buildFailedRun(args: {
  runId: string;
  personaId: string;
  startedAtIso: string;
  startedAtMs: number;
  error: string;
}): DetectionRun {
  return {
    id: args.runId,
    personaId: args.personaId,
    startedAt: args.startedAtIso,
    finishedAt: new Date().toISOString(),
    status: 'failed',
    sitesAttempted: [],
    durationMs: Date.now() - args.startedAtMs,
    score: null,
    error: args.error,
    meta: {
      sdkVersion: SDK_VERSION,
      chromiumVersion: safeChromiumVersion(),
    },
  };
}

/**
 * 安全地拿系统 Chromium 版本——拿不到（无 chrome / 解析失败）兜成 'unknown'，
 * 不让 detection 跑因为元信息收集失败而崩。
 */
export function safeChromiumVersion(): string {
  try {
    return getInstalledChromeVersion();
  } catch {
    return 'unknown';
  }
}

/**
 * 从 persona.metadata.tags 里抠 `template:<id>` 前缀 tag。
 *
 * 注：与 `commands/personas/template-tag.ts:extractTemplateTag` 区分——那一个
 * 还会在没有前缀 tag 时回退到 bare tag（兼容 desktop 老 persona）；这个窄版
 * 只读 CLI 自己写入的前缀形态，给 `run` 走 `--template` 透传时的 fallback 用。
 *
 * 调用方拿到 `undefined` 时通常打印 `'unknown'`。
 */
export function extractTemplateTag(p: {
  metadata: { tags?: readonly string[] };
}): string | undefined {
  const tags = p.metadata.tags ?? [];
  for (const tag of tags) {
    if (tag.startsWith('template:')) return tag.slice('template:'.length);
  }
  return undefined;
}
