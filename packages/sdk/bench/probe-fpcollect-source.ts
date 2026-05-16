/**
 * probe-fpcollect-source — fetch incolumitas fpCollect.min.js + 提取 webDriver
 *   字段的检测逻辑，定位 Phase 3.1 Error.stack hook 未能 cover 的真实路径。
 *
 *   pnpm --filter @mosaiq/sdk exec tsx bench/probe-fpcollect-source.ts
 */
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';

import {
  deletePersona,
  getUserDataDir,
  launchPersona,
  personaExists,
  savePersona,
} from '../src/index.js';

async function main() {
  const id = `probe-fpcollect-${Date.now().toString(36)}`;
  if (personaExists(id)) deletePersona(id);
  savePersona(createWin11ChromeUsPersona({ id, displayName: 'fpcollect' }));
  const session = await launchPersona(
    createWin11ChromeUsPersona({ id, displayName: 'fpcollect' }),
    { headless: true },
  );

  try {
    const page = await session.firstPage();
    // 必须先 goto 同源才能 fetch（CORS）。incolumitas 把 fpCollect.min.js 放在
    // 自己域，所以先去主页。
    await page.goto('https://bot.incolumitas.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const src = await page.evaluate(async () => {
      try {
        const resp = await fetch('/fpCollect.min.js');
        return await resp.text();
      } catch (e) {
        return `<fetch failed: ${(e as Error).message}>`;
      }
    });

    mkdirSync('bench/results', { recursive: true });
    const dumpPath = `bench/results/_fpCollect.min.js`;
    writeFileSync(dumpPath, src, 'utf-8');
    console.log(`[probe] fpCollect.min.js (${src.length} bytes) → ${dumpPath}`);

    // 提取 webDriver 字段位置（pre-formatted minified search）
    const idx = src.indexOf('webDriver');
    if (idx >= 0) {
      console.log('\n=== webDriver context (±600 chars) ===');
      const start = Math.max(0, idx - 600);
      const end = Math.min(src.length, idx + 600);
      console.log(src.slice(start, end));
    } else {
      console.log('[probe] "webDriver" literal not found in minified source');
    }

    // 同步看 webdriver lowercase
    const idx2 = src.indexOf('webdriver');
    if (idx2 >= 0 && idx2 !== idx) {
      console.log('\n=== webdriver (lowercase) context (±400 chars) ===');
      const start = Math.max(0, idx2 - 400);
      const end = Math.min(src.length, idx2 + 400);
      console.log(src.slice(start, end));
    }
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
