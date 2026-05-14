/**
 * baseline-detection — 用现有 SDK 注入栈跑反指纹基线检测。
 *
 * 用法（仓库根目录）：
 *   pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts
 *
 * 选项（环境变量）：
 *   HEADED=1            显示浏览器（默认 headless）
 *   ONLY=sannysoft      只跑指定站点（id，多个用逗号分隔）
 *   SKIP=creepjs        跳过指定站点
 *   TIMEOUT_MS=60000    单站超时（默认 60s）
 *   RESULTS_DIR=...     输出目录（默认 bench/results/<timestamp>）
 *
 * 流程：
 *   1. 创建临时 persona（win11-chrome-us 模板）
 *   2. launchPersona 启动注入版 chromium
 *   3. 顺序访问 6 个目标站，每站抓截图 + HTML + bodyText + 站点特异提取
 *   4. 输出 raw.json 到 bench/results/<timestamp>/
 *   5. 关闭 + 清理 persona
 *
 * 配套：跑完后跑 `tsx bench/report.ts <results-dir>` 生成 report.md。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import { deletePersona, getUserDataDir, launchPersona, personaExists, savePersona } from '../src/index.js';
import { SITES, type SiteResult, type SiteSpec } from './sites.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PERSONA_ID = `baseline-bench-${Date.now().toString(36)}`;
const DEFAULT_TIMEOUT = 60_000;
const MAX_BODY_TEXT = 50_000; // 截断超大 page

function parseEnv() {
  const headed = process.env.HEADED === '1';
  const only = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const skip = process.env.SKIP?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? DEFAULT_TIMEOUT);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir =
    process.env.RESULTS_DIR ?? resolve(__dirname, 'results', ts);
  return { headed, only, skip, timeoutMs, resultsDir };
}

function pickSites(only: string[], skip: string[]): SiteSpec[] {
  let sites = SITES;
  if (only.length > 0) sites = sites.filter((s) => only.includes(s.id));
  if (skip.length > 0) sites = sites.filter((s) => !skip.includes(s.id));
  return sites;
}

async function runOne(
  page: import('playwright-core').Page,
  spec: SiteSpec,
  resultsDir: string,
  timeoutMs: number,
): Promise<SiteResult> {
  const start = Date.now();
  const result: SiteResult = {
    id: spec.id,
    name: spec.name,
    url: spec.url,
    ok: false,
    durationMs: 0,
  };

  try {
    console.log(`[bench] → ${spec.id}: ${spec.url}`);
    await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // 等额外 settle 时间，让 JS 计算（如 CreepJS）有时间出 trust score
    await page.waitForTimeout(spec.settleMs);
    // 尝试 networkidle，最多等 5s
    try {
      await page.waitForLoadState('networkidle', { timeout: 5_000 });
    } catch {
      // 有些站永远不 networkidle，吃掉超时
    }

    result.title = await page.title();

    const bodyText = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    result.bodyText = bodyText.slice(0, MAX_BODY_TEXT);

    const html = await page.content();
    const htmlPath = `${spec.id}.html`;
    writeFileSync(join(resultsDir, htmlPath), html, 'utf8');
    result.html = htmlPath;

    const screenshotPath = `${spec.id}.png`;
    await page.screenshot({
      path: join(resultsDir, screenshotPath),
      fullPage: true,
      timeout: 10_000,
    });
    result.screenshot = screenshotPath;

    if (spec.extract) {
      try {
        result.extracted = await spec.extract(page);
      } catch (err) {
        result.extracted = { error: (err as Error).message };
      }
    }

    result.ok = true;
    console.log(`[bench]   OK in ${Date.now() - start}ms`);
  } catch (err) {
    result.error = (err as Error).message;
    console.log(`[bench]   FAIL: ${result.error}`);
  } finally {
    result.durationMs = Date.now() - start;
  }
  return result;
}

async function main() {
  const { headed, only, skip, timeoutMs, resultsDir } = parseEnv();
  const sites = pickSites(only, skip);
  if (sites.length === 0) {
    console.error('[bench] no sites selected');
    process.exit(1);
  }

  mkdirSync(resultsDir, { recursive: true });
  console.log(`[bench] results dir: ${resultsDir}`);
  console.log(`[bench] sites: ${sites.map((s) => s.id).join(', ')}`);
  console.log(`[bench] headless: ${!headed}`);

  // ── 1. 创建 ephemeral persona ─────────────────────────────────────
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

  // ── 2. 启动 ───────────────────────────────────────────────────────
  const session = await launchPersona(persona, { headless: !headed });
  const page = await session.firstPage();
  console.log('[bench] launched chromium');

  const results: SiteResult[] = [];
  const overallStart = Date.now();

  try {
    // ── 3. 顺序跑各站 ──────────────────────────────────────────────
    for (const spec of sites) {
      const r = await runOne(page, spec, resultsDir, timeoutMs);
      results.push(r);
    }
  } finally {
    await session.close();
    console.log('[bench] closed session');
    deletePersona(PERSONA_ID);
    console.log(`[bench] cleaned up persona ${PERSONA_ID}`);
    try {
      rmSync(getUserDataDir(PERSONA_ID), { recursive: true, force: true });
      console.log(`[bench] cleaned up profile ${PERSONA_ID}`);
    } catch {
      // noop
    }
  }

  // ── 4. 写 raw.json ────────────────────────────────────────────────
  const overallMs = Date.now() - overallStart;
  const summary = {
    timestamp: new Date().toISOString(),
    overallMs,
    sitesAttempted: sites.length,
    sitesOk: results.filter((r) => r.ok).length,
    sitesFail: results.filter((r) => !r.ok).length,
    persona: {
      id: persona.metadata.id,
      template: 'win11-chrome-us',
      browser: persona.browser,
      system: persona.system,
      hardware: persona.hardware,
      // 反指纹敏感字段：fingerprint.canvas/webgl/audio noise seed 等。
      // 暴露给 reporter 用来 cross-check spoof 是否真的让浏览器返回了 persona 声称的值。
      fingerprint: persona.fingerprint,
    },
    results,
  };
  const rawPath = join(resultsDir, 'raw.json');
  writeFileSync(rawPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[bench] wrote ${rawPath}`);
  console.log(
    `[bench] done in ${overallMs}ms — OK=${summary.sitesOk} FAIL=${summary.sitesFail}`,
  );
  console.log(`[bench] next: tsx bench/report.ts ${resultsDir}`);
}

main().catch((err) => {
  console.error('[bench] fatal:', err);
  process.exit(1);
});
