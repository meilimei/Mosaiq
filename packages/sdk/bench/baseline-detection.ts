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
 *   RETRIES=2           单站最大重试次数（默认 2，即首次失败后再重试 2 次共 3 attempts）
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
const DEFAULT_RETRIES = 2;
const MAX_BODY_TEXT = 50_000; // 截断超大 page

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
    await page.goto(spec.url, {
      waitUntil: spec.waitUntil ?? 'domcontentloaded',
      timeout: timeoutMs,
    });
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
    // 截图失败不应该让整站 FAIL —— Cloudflare 拦阻的 SPA 字体永远不 ready，
    // 但 HTML / extracted 仍然有用。screenshot 超时设宽 + 失败时降级用 viewport 截图。
    try {
      await page.screenshot({
        path: join(resultsDir, screenshotPath),
        fullPage: true,
        timeout: 12_000,
      });
      result.screenshot = screenshotPath;
    } catch (err) {
      console.log(`[bench]   screenshot failed (${(err as Error).message}); falling back to viewport`);
      try {
        await page.screenshot({
          path: join(resultsDir, screenshotPath),
          fullPage: false,
          timeout: 5_000,
        });
        result.screenshot = screenshotPath;
      } catch {
        // 完全跳过截图，不阻断 extract
      }
    }

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

/**
 * Phase 3.2 — runOne 的 retry 包装。dbi-bot / pixelscan 等不稳定站点偶发
 * 60s timeout 是 site-side issue，重试一次大多能拿到结果。指数退避（1s, 2s, 4s…）
 * 避免对目标站点 hammer。最终结果（成功或所有重试用尽）填入 SiteResult.retries
 * 字段，让 report 可见 measurement reliability。
 */
async function runOneWithRetry(
  page: import('playwright-core').Page,
  spec: SiteSpec,
  resultsDir: string,
  timeoutMs: number,
  maxRetries: number,
): Promise<SiteResult> {
  let lastResult: SiteResult | null = null;
  const maxAttempts = Math.max(1, maxRetries + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const backoffMs = 1_000 * Math.pow(2, attempt - 2); // 1s, 2s, 4s, ...
      console.log(
        `[bench]   retry ${attempt - 1}/${maxRetries} after ${backoffMs}ms backoff`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    const r = await runOne(page, spec, resultsDir, timeoutMs);
    r.retries = attempt - 1;
    lastResult = r;
    if (r.ok) {
      if (attempt > 1) {
        console.log(`[bench]   succeeded on attempt ${attempt}`);
      }
      return r;
    }
  }
  return lastResult!;
}

async function main() {
  const { headed, only, skip, timeoutMs, retries, resultsDir } = parseEnv();
  const sites = pickSites(only, skip);
  if (sites.length === 0) {
    console.error('[bench] no sites selected');
    process.exit(1);
  }

  mkdirSync(resultsDir, { recursive: true });
  console.log(`[bench] results dir: ${resultsDir}`);
  console.log(`[bench] sites: ${sites.map((s) => s.id).join(', ')}`);
  console.log(`[bench] headless: ${!headed}`);
  console.log(`[bench] retries per site: ${retries}`);

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
    // ── 3. 顺序跑各站（带 retry） ─────────────────────────────────
    for (const spec of sites) {
      const r = await runOneWithRetry(page, spec, resultsDir, timeoutMs, retries);
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
  const totalRetries = results.reduce((sum, r) => sum + (r.retries ?? 0), 0);
  const sitesWithRetry = results.filter((r) => (r.retries ?? 0) > 0).length;
  const summary = {
    timestamp: new Date().toISOString(),
    overallMs,
    sitesAttempted: sites.length,
    sitesOk: results.filter((r) => r.ok).length,
    sitesFail: results.filter((r) => !r.ok).length,
    sitesWithRetry,
    totalRetries,
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
    `[bench] done in ${overallMs}ms — OK=${summary.sitesOk} FAIL=${summary.sitesFail}` +
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
