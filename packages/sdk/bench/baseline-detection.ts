/**
 * baseline-detection — 用 SDK `runDetection` 跑反指纹基线检测的 CLI 包装。
 *
 * 用法（仓库根目录）：
 *   pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts
 *
 * 选项（环境变量）：
 *   HEADED=1            显示浏览器（默认 headless）
 *   ONLY=sannysoft      只跑指定站点（id，多个用逗号分隔）
 *   SKIP=creepjs        跳过指定站点
 *   TIMEOUT_MS=60000    单站超时（默认 60s）
 *   RETRIES=2           单站最大重试次数（默认 2，即首次失败后再重试 2 次共 3 attempts）
 *   RESULTS_DIR=...     输出目录（默认 bench/results/<timestamp>）
 *
 * 流程（v0.8 起）：
 *   1. 创建临时 persona（win11-chrome-us 模板）
 *   2. 调用 SDK `runDetection`：launch / 顺序 12 站 / retry / 截图 / extract / aggregate
 *   3. 把 raw 写到 bench/results/<timestamp>/raw.json
 *   4. 删 persona / 清 userDataDir
 *
 * 配套：跑完后跑 `tsx bench/report.ts <results-dir>` 生成 report.md。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import {
  deletePersona,
  getUserDataDir,
  personaExists,
  runDetection,
  savePersona,
  type DetectionRunRaw,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PERSONA_ID = `baseline-bench-${Date.now().toString(36)}`;
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_RETRIES = 2;

function parseEnv() {
  const headed = process.env.HEADED === '1';
  const only = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const skip = process.env.SKIP?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? DEFAULT_TIMEOUT);
  const retries = Number(process.env.RETRIES ?? DEFAULT_RETRIES);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir =
    process.env.RESULTS_DIR ?? resolve(__dirname, 'results', ts);
  return { headed, only, skip, timeoutMs, retries, resultsDir };
}

async function main() {
  const { headed, only, skip, timeoutMs, retries, resultsDir } = parseEnv();

  mkdirSync(resultsDir, { recursive: true });
  console.log(`[bench] results dir: ${resultsDir}`);
  console.log(
    `[bench] only: ${only.join(',') || '(all)'} skip: ${skip.join(',') || '(none)'}`,
  );
  console.log(`[bench] headless: ${!headed}`);
  console.log(`[bench] retries per site: ${retries}`);

  // ── 1. ephemeral persona ──────────────────────────────────────────
  if (personaExists(PERSONA_ID)) {
    console.log(`[bench] cleaning up stale persona ${PERSONA_ID}`);
    deletePersona(PERSONA_ID);
  }
  const persona = createWin11ChromeUsPersona({
    id: PERSONA_ID,
    displayName: 'Baseline Detection Bench',
    tags: ['bench', 'baseline'],
    notes: 'Ephemeral persona used by bench/baseline-detection.ts. Auto-deleted.',
  });
  savePersona(persona);

  // ── 2. SDK runDetection ───────────────────────────────────────────
  let raw: DetectionRunRaw | undefined;
  try {
    const result = await runDetection(persona, {
      personaTemplate: 'win11-chrome-us',
      only: only.length > 0 ? only : undefined,
      skip: skip.length > 0 ? skip : undefined,
      timeoutMs,
      maxRetries: retries,
      artifactDir: resultsDir,
      launchOptions: { headless: !headed },
      onProgress: (evt) => {
        if (evt.phase === 'init') {
          console.log(`[bench] init: ${evt.totalSites} sites`);
        } else if (evt.phase === 'site-start') {
          console.log(`[bench] → ${evt.siteId}`);
        } else if (evt.phase === 'site-retry') {
          console.log(
            `[bench]   retry ${evt.retryAttempt}/${retries} for ${evt.siteId}`,
          );
        } else if (evt.phase === 'site-end') {
          const tag = evt.siteOk ? 'OK' : 'FAIL';
          console.log(
            `[bench]   ${tag} ${evt.siteId} in ${evt.siteDurationMs}ms`,
          );
        } else if (evt.phase === 'done') {
          console.log('[bench] done');
        } else if (evt.phase === 'canceled') {
          console.log('[bench] canceled');
        } else if (evt.phase === 'error') {
          console.log(`[bench] error: ${evt.error}`);
        }
      },
    });
    raw = result.raw;
  } finally {
    deletePersona(PERSONA_ID);
    console.log(`[bench] cleaned up persona ${PERSONA_ID}`);
    try {
      rmSync(getUserDataDir(PERSONA_ID), { recursive: true, force: true });
      console.log(`[bench] cleaned up profile ${PERSONA_ID}`);
    } catch {
      // noop
    }
  }

  if (!raw) {
    // runDetection 抛了异常，已经在 finally 之前 throw 出去到 main().catch；
    // 实际不会走到这里——但为类型收窄保留兜底。
    throw new Error('runDetection returned no raw');
  }

  // ── 3. 写 raw.json ────────────────────────────────────────────────
  const rawPath = join(resultsDir, 'raw.json');
  writeFileSync(rawPath, JSON.stringify(raw, null, 2), 'utf8');
  console.log(`[bench] wrote ${rawPath}`);
  const totalRetries = raw.totalRetries ?? 0;
  const sitesWithRetry = raw.sitesWithRetry ?? 0;
  console.log(
    `[bench] done in ${raw.overallMs}ms — OK=${raw.sitesOk} FAIL=${raw.sitesFail}` +
      (totalRetries > 0
        ? ` (${sitesWithRetry} sites needed retries, ${totalRetries} total retries)`
        : ''),
  );
  console.log(`[bench] next: tsx bench/report.ts ${resultsDir}`);
}

main().catch((err) => {
  console.error('[bench] fatal:', err);
  process.exit(1);
});
