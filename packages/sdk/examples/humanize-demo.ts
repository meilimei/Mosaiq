/**
 * humanize-demo — 跑通 BrowserSession.humanize 的最小可执行示例。
 *
 * 用法（仓库根目录执行）：
 *   pnpm --filter @runova/sdk exec tsx examples/humanize-demo.ts
 *
 * 流程：
 *   1. 用 win11-chrome-us 模板创建一个 ephemeral persona（持久化到 ~/.mosaiq）
 *   2. launchPersona 启动带反检测注入的 Chromium（headed，可见）
 *   3. 跳转 https://bot.sannysoft.com（公开 bot detection 演示页）
 *   4. 用 humanize.moveTo / type 模拟类人输入
 *   5. 等 10s 让用户观察检测结果，关闭并清理 persona
 *
 * 这个示例**不**断言任何 BotScore；它仅用来肉眼验证：
 *   - mousemove 序列在 DevTools 中是曲线而非直线
 *   - keyboard event 时间间隔类似真人节律
 *
 * 自动化的检测分回归测试是 v0.2.x 后续工作（详见 docs/HUMANIZE-DESIGN.md §6.2）。
 */

import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';
import { deletePersona, launchPersona, personaExists, savePersona } from '../src/index.js';

const DEMO_ID = 'humanize-demo' as const;
const TARGET_URL = 'https://bot.sannysoft.com/';
const HOLD_MS = 10_000;

async function main() {
  // ── 1. 创建 ephemeral persona ─────────────────────────────────────
  if (personaExists(DEMO_ID)) {
    console.log(`[demo] cleaning up stale persona ${DEMO_ID}`);
    deletePersona(DEMO_ID);
  }

  const persona = createWin11ChromeUsPersona({
    id: DEMO_ID,
    displayName: 'Humanize Demo',
    tags: ['demo'],
    notes: 'Ephemeral persona used by examples/humanize-demo.ts. Safe to delete.',
  });
  savePersona(persona);
  console.log(`[demo] created ${DEMO_ID}`);

  // ── 2. 启动 Chromium ──────────────────────────────────────────────
  const session = await launchPersona(persona, { headless: false });
  console.log('[demo] launched Chromium');

  try {
    // ── 3. 打开检测页 ───────────────────────────────────────────────
    const page = await session.open(TARGET_URL);
    console.log(`[demo] navigated to ${TARGET_URL}`);
    await page.waitForLoadState('domcontentloaded');

    // ── 4. humanize 演示 ───────────────────────────────────────────
    const h = await session.humanize({ speed: 'normal' });

    // 移动到页面右上角再到中心（仅展示曲线轨迹）
    await h.moveTo({ x: 1100, y: 200 });
    await h.moveTo({ x: 600, y: 400 });

    // 在第一个可输入控件里打字（sannysoft 页有一个 search input；如果没有
    // 也无伤大雅 — humanize.type 会因为找不到元素抛错，被 catch 静默掉）
    try {
      await h.type('input[type=text]', 'mosaiq humanize test', {
        avgFlightMs: 110,
        avgDwellMs: 70,
      });
      console.log('[demo] typed into input[type=text]');
    } catch (err) {
      console.log(`[demo] no text input found, skipped typing (${(err as Error).message})`);
    }

    // ── 5. hold + 退出 ─────────────────────────────────────────────
    console.log(`[demo] holding ${HOLD_MS / 1000}s for visual inspection ...`);
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  } finally {
    await session.close();
    console.log('[demo] closed session');
    deletePersona(DEMO_ID);
    console.log(`[demo] cleaned up ${DEMO_ID}`);
  }
}

main().catch((err) => {
  console.error('[demo] failed:', err);
  process.exit(1);
});
