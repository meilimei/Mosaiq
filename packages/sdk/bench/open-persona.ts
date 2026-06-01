/**
 * open-persona — 打开一个 persona 的真实 chromium 窗口，供**人工**实测登录/养号。
 *
 * 这是 `EVIDENCE-AND-VALIDATION.md` §4「硬目标 + 真账号实测协议」的趁手工具：
 * `mosaiq detection-lab run` 只做自动化体检（12 个检测站），**不能**替代真人
 * 在真实风控站点（Cloudflare / DataDome）+ 真账号（Reddit / X / Google）上手动
 * 跑一遍。这个脚本就是把指定 persona 用与 desktop / CLI 完全相同的注入栈拉起一个
 * **headed** 浏览器，然后**挂着不退出**，让你像平时用浏览器一样操作。
 *
 * 用法（repo 根目录）：
 *   pnpm open-persona <persona-id> [起始URL]
 *
 * 例：
 *   pnpm open-persona reddit-alice
 *   pnpm open-persona reddit-alice https://abrahamjuliot.github.io/creepjs/
 *   pnpm open-persona shopping-bob https://www.reddit.com/login
 *
 * 行为：
 *   - 复用 persona 的 user-data-dir（~/.mosaiq/profiles/<id>），所以 cookie /
 *     登录态会跨次保留 —— 这正是养号需要的。
 *   - 默认 headed（看得见窗口）。窗口关掉 或 在终端按 Ctrl-C 即退出。
 *   - 不传起始 URL 时打开内置「自检导航页」，列出本协议要测的站点，点一下即跳。
 *
 * ⚠️ 这个脚本**只负责把带全套深层注入的浏览器拉起来**。真账号登录、ToS 风险、
 *    被 challenge 时的判断，都由操作的人负责。被识破的 surface 用
 *    .github/ISSUE_TEMPLATE/detection-report.yml 回流成 issue。
 */

import { loadPersona } from '../src/persona-store.js';
import { launchPersona } from '../src/index.js';

// 协议要测的站点 —— 与 EVIDENCE-AND-VALIDATION.md §4 + detection-report.yml 对齐。
const PROTOCOL_SITES: ReadonlyArray<{ group: string; label: string; url: string }> = [
  { group: '自检', label: 'CreepJS（综合指纹 + lies）', url: 'https://abrahamjuliot.github.io/creepjs/' },
  { group: '自检', label: 'Sannysoft bot test', url: 'https://bot.sannysoft.com/' },
  { group: '自检', label: 'IPHey', url: 'https://iphey.com/' },
  { group: '自检', label: 'BrowserScan', url: 'https://www.browserscan.net/' },
  { group: '自检', label: 'Pixelscan', url: 'https://pixelscan.net/' },
  { group: '硬目标', label: 'Cloudflare 验证演示页', url: 'https://nopecha.com/demo/cloudflare' },
  { group: '硬目标', label: 'DataDome bot test', url: 'https://datadome.co/products/bot-protection/' },
  { group: '真账号', label: 'Reddit 登录', url: 'https://www.reddit.com/login/' },
  { group: '真账号', label: 'X / Twitter 登录', url: 'https://x.com/login' },
  { group: '真账号', label: 'Google 登录', url: 'https://accounts.google.com/' },
];

function buildNavPage(personaId: string): string {
  const rows = PROTOCOL_SITES.map(
    (s) =>
      `<tr><td class="g">${s.group}</td><td><a href="${s.url}">${s.label}</a></td><td class="u">${s.url}</td></tr>`,
  ).join('');
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Mosaiq 实测导航 — ${personaId}</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.3rem}.pid{font-family:ui-monospace,monospace;background:#f0f0f0;padding:.1em .4em;border-radius:4px}
table{border-collapse:collapse;width:100%;margin-top:1rem}td{border:1px solid #e2e2e2;padding:.45rem .6rem}
td.g{white-space:nowrap;color:#666;font-size:.85rem}td.u{font-family:ui-monospace,monospace;font-size:.78rem;color:#888}
a{color:#0a58ca;text-decoration:none}a:hover{text-decoration:underline}
.note{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:.6rem .9rem;font-size:.9rem;margin-top:1rem}</style>
</head><body>
<h1>Mosaiq 真账号实测导航</h1>
<p>当前 persona：<span class="pid">${personaId}</span>。这个窗口带与 desktop / CLI 完全相同的深层注入。点下面任意站点开始测；登录态会保留在该 persona 的 user-data-dir。</p>
<div class="note">被识破 / 被 challenge 时，记录<strong>具体哪个 surface</strong>（不要只写「被封了」），用 detection-report.yml 模板开 issue。每天填 docs/REAL-ACCOUNT-TESTING-LOG.md。</div>
<table><thead><tr><td class="g">类别</td><td>站点</td><td class="u">URL</td></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function main(): Promise<number> {
  const personaId = process.argv[2];
  const startUrl = process.argv[3];

  if (!personaId || personaId === '-h' || personaId === '--help') {
    process.stdout.write(
      'Usage: pnpm open-persona <persona-id> [start-url]\n\n' +
        '  Opens a headed Chromium for the given persona (full stealth injection),\n' +
        '  reusing its user-data-dir so logins persist. Close the window or press\n' +
        '  Ctrl-C to exit.\n\n' +
        'Examples:\n' +
        '  pnpm open-persona reddit-alice\n' +
        '  pnpm open-persona reddit-alice https://www.reddit.com/login/\n',
    );
    return personaId ? 0 : 2;
  }

  let persona: ReturnType<typeof loadPersona>;
  try {
    persona = loadPersona(personaId);
  } catch (err) {
    process.stderr.write(
      `[open-persona] ${(err as Error).message}\n` +
        `Hint: list personas with \`pnpm mosaiq personas list\`, or create one with\n` +
        `  pnpm mosaiq personas create ${personaId} --template win11-chrome-us --display-name "..."\n`,
    );
    return 2;
  }

  process.stdout.write(`[open-persona] launching headed chromium for "${personaId}"\n`);
  process.stdout.write(`[open-persona]   template : ${persona.metadata.tags.join(', ') || '(none)'}\n`);
  process.stdout.write(
    `[open-persona]   proxy    : ${persona.network.proxy ? `${persona.network.proxy.protocol}://${persona.network.proxy.host}:${persona.network.proxy.port}` : '(none — direct connection!)'}\n`,
  );
  if (!persona.network.proxy) {
    process.stdout.write(
      '[open-persona]   ⚠️  没有代理 = 用你本机真实 IP。真账号实测请先给 persona 配住宅代理\n' +
        '[open-persona]      (mosaiq personas update <id> --proxy ... 或 create 时带 --proxy)，否则\n' +
        '[open-persona]      IP 维度会污染实测结论。详见 docs/PROXY-GUIDE.md。\n',
    );
  }

  const session = await launchPersona(persona, { headless: false });
  const page = await session.firstPage();
  await page.goto(startUrl ?? buildNavPage(personaId), { waitUntil: 'domcontentloaded' });

  process.stdout.write('[open-persona] 浏览器已打开。操作完关掉窗口或按 Ctrl-C 退出。\n');

  // 挂住进程直到窗口被关 或 Ctrl-C。
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    session.context.on('close', finish);
    process.on('SIGINT', () => {
      process.stdout.write('\n[open-persona] SIGINT — closing session\n');
      finish();
    });
  });

  await session.close();
  process.stdout.write('[open-persona] closed.\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[open-persona] uncaught: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
