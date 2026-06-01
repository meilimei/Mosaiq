/**
 * probe-error-stack — 探测我们 spoof 后的 chromium 里 Error.stack 字符串
 *   是否仍含 puppeteer / playwright / automation / cdp / blob: 等敏感字样。
 *
 *   pnpm --filter @runova/sdk exec tsx bench/probe-error-stack.ts
 *
 * 背景（Phase 2.5 bench 真实数据驱动）：incolumitas 的 modified fp-collect 抓到
 * `webDriver: true`，raw JSON 含 `errorsGenerated: ["azeaze is not defined", ...]`，
 * 暗示 detector 故意 throw ReferenceError 然后 inspect err.stack 字符串内容反查
 * 自动化框架 signature。Phase 1.6 现有的 Error.stack hook 只挡了
 * `Object.defineProperty(err, 'stack', {get})` 路径，**没**清洗字符串。
 *
 * 本 probe 列出 4 种典型读 stack 路径下 chromium 真实输出，确认我们要在哪里下手：
 *   1. throw + catch 读 err.stack
 *   2. new Error().stack
 *   3. Error.captureStackTrace(o); o.stack
 *   4. Worker 内同样跑一次（看 worker realm stack 与 main 是否一致）
 */
import { rmSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';

import {
  deletePersona,
  getUserDataDir,
  launchPersona,
  personaExists,
  savePersona,
} from '../src/index.js';

const SUSPICIOUS = [
  'puppeteer',
  'playwright',
  'automation',
  'webdriver',
  'cdp',
  'devtools',
  '__pwInitScripts',
  '__playwright__',
  'blob:',
  'PuppeteerExtra',
  'evaluationScript',
  'UtilityScript',
];

function scan(stack: string | undefined): string[] {
  if (!stack) return [];
  const lower = stack.toLowerCase();
  return SUSPICIOUS.filter((s) => lower.includes(s.toLowerCase()));
}

async function main() {
  const id = `probe-error-stack-${Date.now().toString(36)}`;
  if (personaExists(id)) deletePersona(id);
  savePersona(createWin11ChromeUsPersona({ id, displayName: 'error-stack' }));
  const session = await launchPersona(
    createWin11ChromeUsPersona({ id, displayName: 'error-stack' }),
    { headless: true },
  );

  try {
    const page = await session.firstPage();
    await page.goto('about:blank');

    // 注意：page.evaluate(() => ...) 通过 Playwright UtilityScript 桥跑，stack 会含
    // `UtilityScript.evaluate (<anonymous>:N:N)` Playwright 内部 frame —— 那是 probe
    // 自身的 artifact，不代表真实站点检测路径。真实站点 JS 跑在 main world，用
    // inline `<script>` 注入测试更贴近现实。下面把 throw + read .stack 装在
    // inline script 里，结果存 window.__mainStacks，再 evaluate 读出。
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = `
        // 关键：用 setTimeout(0) 把整个测试 async-unwind 出 UtilityScript caller chain。
        // 真实站点 detector 不会跨 page.evaluate caller stack 同步跑 —— 它在自己页面的
        // DOMContentLoaded / setTimeout / fetch.then 等 async callback 内跑，stack 不
        // 包含外层 Playwright 桥的 caller frames。这样测试更贴近真实站点路径。
        setTimeout(function(){
          var out = {};
          try {
            azeaze;
          } catch (e) {
            out.refError = e.stack;
          }
          var e1 = new Error('test-1');
          out.newError = e1.stack;
          try {
            var o = {};
            if (Error.captureStackTrace) Error.captureStackTrace(o);
            out.captured = o.stack;
          } catch (err) {
            out.captured = '<failed: ' + err.message + '>';
          }
          (async function(){
            try { await Promise.resolve(); throw new Error('async-test'); }
            catch (e) { out.asyncStack = e.stack; }
            window.__mainStacks = out;
          })();
        }, 0);
      `;
      document.head.appendChild(script);
    });
    // 等 setTimeout(0) + async chain 完成
    await new Promise((r) => setTimeout(r, 500));
    const result = await page.evaluate(
      () => (window as unknown as { __mainStacks: Record<string, unknown> }).__mainStacks,
    );

    // Worker realm 同样跑一次
    const workerResult = await page.evaluate(() => {
      const workerSrc = `
        self.onmessage = function () {
          var out = {};
          try {
            azeaze;
          } catch (e) {
            out.refError = e.stack;
          }
          var e1 = new Error('test-1');
          out.newError = e1.stack;
          try {
            var o = {};
            if (Error.captureStackTrace) Error.captureStackTrace(o);
            out.captured = o.stack;
          } catch (err) {
            out.captured = '<failed: ' + err.message + '>';
          }
          self.postMessage(out);
        };
      `;
      const blobUrl = URL.createObjectURL(
        new Blob([workerSrc], { type: 'application/javascript' }),
      );
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const worker = new Worker(blobUrl);
        const t = setTimeout(() => {
          worker.terminate();
          reject(new Error('worker timeout'));
        }, 5000);
        worker.onmessage = (ev) => {
          clearTimeout(t);
          worker.terminate();
          resolve(ev.data as Record<string, unknown>);
        };
        worker.onerror = (ev) => {
          clearTimeout(t);
          worker.terminate();
          reject(new Error(`worker error: ${(ev as ErrorEvent).message}`));
        };
        worker.postMessage('go');
      });
    });

    const all = { main: result, worker: workerResult };
    const sections: Array<[string, Record<string, unknown>]> = [
      ['MAIN scope', result as Record<string, unknown>],
      ['WORKER scope', workerResult],
    ];
    let totalHits = 0;
    for (const [label, src] of sections) {
      console.log(`\n=== ${label} ===`);
      for (const k of ['refError', 'newError', 'captured', 'asyncStack']) {
        const stack = (src[k] as string | undefined) ?? '';
        const hits = scan(stack);
        if (hits.length) totalHits += hits.length;
        console.log(`\n[${k}] hits=${hits.length === 0 ? '✅ none' : `❌ ${hits.join(',')}`}`);
        // 截 800 字够看
        console.log((stack ?? '').slice(0, 800));
      }
    }
    console.log(`\n${'='.repeat(60)}`);
    console.log(
      totalHits === 0
        ? '✅ NO suspicious frames found in any stack — Error.stack clean'
        : `❌ ${totalHits} suspicious matches across stacks — needs Phase 3.1 hardening`,
    );

    // 把完整 dump 也写一份给后续 diff 用
    const dumpPath = `bench/results/_probe-error-stack-${Date.now()}.json`;
    const fs = await import('node:fs');
    fs.mkdirSync('bench/results', { recursive: true });
    fs.writeFileSync(dumpPath, JSON.stringify(all, null, 2), 'utf-8');
    console.log(`\n[probe] full dump → ${dumpPath}`);
  } finally {
    await session.close();
    deletePersona(id);
    await wait(500);
    try {
      rmSync(getUserDataDir(id), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
