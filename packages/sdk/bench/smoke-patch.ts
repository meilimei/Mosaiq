/**
 * smoke-patch — 验证 rebrowser playwright-core patch 不破基本浏览器流程。
 *
 * 跑法（仓库根目录）：
 *   pnpm --filter @runova/sdk exec tsx bench/smoke-patch.ts
 *
 * 环境变量：
 *   HEADED=1     显示浏览器（默认 headless）
 *   MODE=0       关掉 rebrowser 行为（仅 import patch 但走原 Playwright 路径）
 *
 * 每一步打时间戳；若卡在某步，能直接看出卡点。
 */

import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';
import { deletePersona, launchPersona, savePersona } from '../src/index.js';

function t(label: string): void {
  // 简短时间戳 + 标签
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${label}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT @ ${label} (${ms}ms)`)), ms),
    ),
  ]);
}

async function main() {
  if (process.env.MODE === '0') {
    process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = '0';
    t('Mode: PATCH-OFF (REBROWSER_PATCHES_RUNTIME_FIX_MODE=0)');
  } else {
    t('Mode: PATCH-ON (default addBinding)');
  }
  if (process.env.DEBUG_PATCH === '1') {
    process.env.REBROWSER_PATCHES_DEBUG = '1';
    t('Debug: REBROWSER_PATCHES_DEBUG=1');
  }

  const personaId = `smoke-${Date.now().toString(36)}`;
  const persona = createWin11ChromeUsPersona({
    id: personaId,
    displayName: 'Smoke Patch Test',
    tags: ['bench', 'smoke'],
    notes: 'Ephemeral smoke test for playwright-core patch.',
  });
  await savePersona(persona);
  t(`persona saved: ${personaId}`);

  let session: Awaited<ReturnType<typeof launchPersona>> | null = null;
  try {
    t('launchPersona() begin');
    session = await withTimeout(
      launchPersona(persona, { headless: process.env.HEADED !== '1' }),
      30_000,
      'launchPersona',
    );
    t('launchPersona() done');

    const page = session.context.pages()[0]!;
    t('got page');

    t('page.goto example.com begin');
    await withTimeout(
      page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 }),
      25_000,
      'page.goto',
    );
    t('page.goto example.com done');

    t('page.title() begin');
    const title = await withTimeout(page.title(), 10_000, 'page.title');
    t(`page.title() done: "${title}"`);

    t('page.evaluate(1+1) begin');
    const evalRes = await withTimeout(
      page.evaluate(() => 1 + 1),
      10_000,
      'page.evaluate',
    );
    t(`page.evaluate(1+1) done: ${evalRes}`);

    t('page.innerText(body) begin');
    const bodyText = await withTimeout(page.locator('body').innerText(), 10_000, 'page.innerText');
    t(`page.innerText(body) done: "${bodyText.slice(0, 80).replace(/\s+/g, ' ')}..."`);

    t('SUCCESS — all 5 ops finished');
  } catch (err) {
    t(`FAILED: ${(err as Error).message}`);
    console.error((err as Error).stack);
    process.exitCode = 1;
  } finally {
    if (session) {
      t('closing browser');
      await session.context.close().catch(() => undefined);
      await session.context
        .browser()
        ?.close()
        .catch(() => undefined);
    }
    try {
      deletePersona(personaId);
    } catch {
      /* ignore */
    }
    t('cleanup done');
  }
}

main();
