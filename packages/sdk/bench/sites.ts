/**
 * baseline 检测站点配置 + 每站特异提取器。
 *
 * 添加新站点：在 SITES 数组里加一条；如果需要特异 DOM 提取，写一个 extract 函数。
 */

import type { Page } from 'playwright-core';

/** 单站结果。 */
export interface SiteResult {
  /** 站点 id（用作文件名 + 报告 key） */
  id: string;
  /** 显示名 */
  name: string;
  /** url */
  url: string;
  /** 是否成功跑完（false 则 error 字段有值） */
  ok: boolean;
  /** 失败时填写 */
  error?: string;
  /** 跑完耗时（ms） */
  durationMs: number;
  /** 页面标题 */
  title?: string;
  /** 完整 body innerText（可能被截断） */
  bodyText?: string;
  /** 截图相对路径（相对 results dir） */
  screenshot?: string;
  /** 完整 HTML 相对路径（相对 results dir） */
  html?: string;
  /** 站点特异提取的结构化字段（每站不同） */
  extracted?: Record<string, unknown>;
}

export interface SiteSpec {
  id: string;
  name: string;
  url: string;
  /** 等页面 settle 的额外秒数（CreepJS 计算 trust score 要 5-10s） */
  settleMs: number;
  /**
   * page.goto 的 waitUntil 策略。默认 'domcontentloaded'。Cloudflare/Turnstile 拦阻
   * 的站（pixelscan）需要 'commit'：只要导航请求被服务器接受（headers 已收）就继续，
   * 不再等 DOM 解析完毕；否则会被反 bot 系统挂在 60s 后超时。
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  /** 站点特异提取器，可选 */
  extract?: (page: Page) => Promise<Record<string, unknown>>;
}

/**
 * 12 个目标站。按反指纹检测严苛程度从低到高排序。
 *
 * Phase 1 加 3 站动机（扩展防御面）：
 *   - **dbi-bot** (deviceandbrowserinfo) ：暴露**最直接的布尔信号**（`isPlaywright`、
 *     `hasInconsistentClientHints`、`hasInconsistentWorkerValues`、`isWebGLInconsistent` 等），
 *     这些恰好对应我们 v0.1 已实施的 spoof 面，是最快的 sanity check。
 *   - **amiunique** ：给出每个属性的**全球独特性百分比**——能识别"我们 spoof 出的某个值
 *     在其数据库中过于罕见"的 outlier，提示需要再贴近常见 persona。
 *   - **pixelscan** ：商业反检测圈最常用的 mask check 站之一，给出整体 mask/bot
 *     verdict + 分类指标。SPA 加载较慢，settle 给足。
 *
 * Phase 2.5 再加 3 站动机（v0.3 扩 baseline）：
 *   - **arh.antoinevastel** (`arh.antoinevastel.com/bots/`)：research-grade Fp-Scanner，
 *     每项给 Consistent / Unsure / Inconsistent 三态结果，颗粒度极细。Antoine Vastel
 *     是 Datadome 研究员，scanner 是 Datadome 商用 detector 的开源版本，命中等价
 *     于 Datadome 检测命中。
 *   - **incolumitas** (`bot.incolumitas.com`)：Nikolai Tschacher 自维护的综合 detector，
 *     覆盖 TLS / TCP/IP / 行为 / 浏览器全栈，含 v0.6+ 新规则（headless / cdp /
 *     proxy 行为）。开源 + 持续更新，是 community 推崇的"硬试金石"。
 *   - **fingerprint-scan** (`fingerprint-scan.com`)：商业 detector 风格的 bot risk
 *     score（0-100）+ 各 surface breakdown。补充了"商业 detector 总评分"维度，
 *     既能对照其他站的细项判断，又能给一个商用化的可读分。
 */
export const SITES: SiteSpec[] = [
  {
    id: 'sannysoft',
    name: 'bot.sannysoft.com',
    url: 'https://bot.sannysoft.com/',
    settleMs: 3_000,
    extract: extractSannysoft,
  },
  {
    id: 'browserleaks-js',
    name: 'BrowserLeaks JavaScript',
    url: 'https://browserleaks.com/javascript',
    settleMs: 4_000,
    extract: extractBrowserleaksGeneric,
  },
  {
    id: 'browserleaks-canvas',
    name: 'BrowserLeaks Canvas',
    url: 'https://browserleaks.com/canvas',
    settleMs: 5_000,
    extract: extractBrowserleaksCanvas,
  },
  {
    id: 'browserleaks-webgl',
    name: 'BrowserLeaks WebGL',
    url: 'https://browserleaks.com/webgl',
    settleMs: 5_000,
    extract: extractBrowserleaksWebgl,
  },
  {
    id: 'iphey',
    name: 'iphey.com',
    url: 'https://iphey.com/',
    settleMs: 6_000,
    extract: extractIphey,
  },
  {
    id: 'dbi-bot',
    name: 'deviceandbrowserinfo Bot Check',
    url: 'https://deviceandbrowserinfo.com/are_you_a_bot',
    // 客户端跑完 BotD-style 检测 + 上送回服务器渲染结果；首屏要 6-10s settle。
    settleMs: 9_000,
    extract: extractDbiBot,
  },
  {
    id: 'amiunique',
    name: 'amiunique.org/fingerprint',
    url: 'https://amiunique.org/fingerprint',
    // amiunique 要回服务器查每属性 uniqueness，渲染表格异步；给足 settle。
    settleMs: 8_000,
    extract: extractAmIUnique,
  },
  {
    id: 'pixelscan',
    name: 'pixelscan.net/fingerprint-check',
    url: 'https://pixelscan.net/fingerprint-check',
    // SPA + Cloudflare gating —— 'commit' 让我们绕过 domcontentloaded 永不到达的卡死，
    // 然后 settleMs (15s) 内 Cloudflare 处理完 challenge 后 SPA 才有机会渲染。
    settleMs: 15_000,
    waitUntil: 'commit',
    extract: extractPixelscan,
  },
  {
    id: 'creepjs',
    name: 'CreepJS',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    settleMs: 12_000,
    extract: extractCreepjs,
  },
  {
    id: 'arh-antoinevastel',
    name: 'arh.antoinevastel.com/bots',
    url: 'https://arh.antoinevastel.com/bots/',
    // Fp-Scanner 跑完所有规则要 8-12s（部分规则触发 setTimeout 异步检测）
    settleMs: 10_000,
    extract: extractAntoinevastel,
  },
  {
    id: 'incolumitas',
    name: 'bot.incolumitas.com',
    url: 'https://bot.incolumitas.com/',
    // 多个 detection section 异步上报；behavioral 检测要等鼠标/键盘事件超时；
    // 给足 settle 让 "New Detection Tests" + "Browser Fingerprint" 全部收敛。
    settleMs: 12_000,
    extract: extractIncolumitas,
  },
  {
    id: 'fingerprint-scan',
    name: 'fingerprint-scan.com',
    url: 'https://fingerprint-scan.com/',
    // 商业风格 bot risk score 站，前端跑 fingerprint 收集 + 服务器算分，要 5-8s。
    settleMs: 8_000,
    extract: extractFingerprintScan,
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 站点特异提取器
// ═══════════════════════════════════════════════════════════════════════════

/**
 * bot.sannysoft.com 用一个表格列出每个检测项，passed=绿色单元格，failed=红色。
 * 我们抓所有行，把 cell 文本和颜色 class 提出来。
 */
async function extractSannysoft(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const rows: Array<{ name: string; result: string; status: 'pass' | 'fail' | 'unknown' }> = [];
    document.querySelectorAll('table tr').forEach((tr) => {
      const tds = Array.from(tr.querySelectorAll('td')) as HTMLTableCellElement[];
      if (tds.length < 2) return;
      const nameCell = tds[0];
      const resultCell = tds[1];
      if (!nameCell || !resultCell) return;
      const name = (nameCell.textContent ?? '').trim();
      const result = (resultCell.textContent ?? '').trim();
      const cls = resultCell.className.toLowerCase();
      // sannysoft 用 .passed (绿) / .failed (红) 类名
      let status: 'pass' | 'fail' | 'unknown' = 'unknown';
      if (cls.includes('passed') || cls.includes('result-pass')) status = 'pass';
      else if (cls.includes('failed') || cls.includes('result-fail')) status = 'fail';
      // 颜色 fallback
      const bg = window.getComputedStyle(resultCell).backgroundColor;
      if (status === 'unknown') {
        if (bg.includes('255, 0') || bg.includes('rgb(255,')) status = 'fail';
        else if (bg.includes('0, 255') || bg.includes('rgb(0,')) status = 'pass';
      }
      if (name) rows.push({ name, result, status });
    });
    const passes = rows.filter((r) => r.status === 'pass').length;
    const fails = rows.filter((r) => r.status === 'fail').length;
    const unknown = rows.filter((r) => r.status === 'unknown').length;
    return { rows, passes, fails, unknown, total: rows.length };
  });
}

/**
 * BrowserLeaks 通用：抓表格里所有 [name, value] 对。
 */
async function extractBrowserleaksGeneric(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const pairs: Array<{ name: string; value: string }> = [];
    document.querySelectorAll('table.table tr, table tr').forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('th, td')) as HTMLTableCellElement[];
      if (cells.length === 2) {
        const [nameCell, valueCell] = cells;
        if (!nameCell || !valueCell) return;
        const name = (nameCell.textContent ?? '').trim();
        const value = (valueCell.textContent ?? '').trim();
        if (name && value && name !== 'Property') pairs.push({ name, value });
      }
    });
    return { pairs, total: pairs.length };
  });
}

/**
 * BrowserLeaks Canvas：抓 Canvas Hash + Uniqueness。
 */
async function extractBrowserleaksCanvas(page: Page): Promise<Record<string, unknown>> {
  const generic = await extractBrowserleaksGeneric(page);
  const pairs = (generic.pairs as Array<{ name: string; value: string }>) ?? [];
  const findValue = (key: string): string | undefined =>
    pairs.find((p) => p.name.toLowerCase().includes(key.toLowerCase()))?.value;
  return {
    ...generic,
    canvasHash: findValue('signature') ?? findValue('hash'),
    uniqueness: findValue('uniqueness') ?? findValue('rare'),
    pixelData: findValue('pixel'),
  };
}

/**
 * BrowserLeaks WebGL：抓 vendor / renderer / 关键参数。
 */
async function extractBrowserleaksWebgl(page: Page): Promise<Record<string, unknown>> {
  const generic = await extractBrowserleaksGeneric(page);
  const pairs = (generic.pairs as Array<{ name: string; value: string }>) ?? [];
  const findValue = (key: string): string | undefined =>
    pairs.find((p) => p.name.toLowerCase().includes(key.toLowerCase()))?.value;
  return {
    ...generic,
    webglVendor: findValue('webgl vendor') ?? findValue('vendor'),
    webglRenderer: findValue('webgl renderer') ?? findValue('renderer'),
    unmaskedVendor: findValue('unmasked vendor'),
    unmaskedRenderer: findValue('unmasked renderer'),
  };
}

/**
 * iphey.com 用一个左侧检测列表，每项前有 ✓ 或 ✗ 图标。
 */
async function extractIphey(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const items: Array<{ name: string; status: 'pass' | 'fail' | 'unknown' }> = [];
    // iphey 用 .check-list-item 或类似类名标识每项
    document.querySelectorAll('[class*="check"], [class*="result"], li').forEach((el) => {
      const text = (el.textContent ?? '').trim();
      if (text.length < 3 || text.length > 200) return;
      const cls = el.className.toLowerCase();
      let status: 'pass' | 'fail' | 'unknown' = 'unknown';
      if (cls.includes('success') || cls.includes('pass') || cls.includes('valid'))
        status = 'pass';
      else if (cls.includes('fail') || cls.includes('error') || cls.includes('invalid'))
        status = 'fail';
      // 用图标 fallback
      const html = el.innerHTML;
      if (status === 'unknown') {
        if (html.includes('✓') || html.includes('check-circle')) status = 'pass';
        else if (html.includes('✗') || html.includes('x-circle') || html.includes('warning'))
          status = 'fail';
      }
      if (status !== 'unknown') items.push({ name: text.slice(0, 100), status });
    });
    // 去重
    const seen = new Set<string>();
    const unique = items.filter((i) => {
      if (seen.has(i.name)) return false;
      seen.add(i.name);
      return true;
    });
    return {
      items: unique,
      passes: unique.filter((i) => i.status === 'pass').length,
      fails: unique.filter((i) => i.status === 'fail').length,
      total: unique.length,
    };
  });
}

/**
 * CreepJS — 最复杂的反指纹站。
 *
 * CreepJS 用 `<span class="lies hash">XXXXXX</span>` 给检测到撒谎的 surface 加 hash 标记，
 * `<span class="bold-fail hash">` 表示更严重（值与 chrome 默认 / 已知白名单不一致）。
 * 撒谎 surface 越少越好；理想状态：lies 数 = 0。
 *
 * 兼容：旧版本 CreepJS 可能用 `.trust-score` 或文本 `N lies` — 都尝试一遍 fallback。
 */
async function extractCreepjs(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};

    // ── 撒谎 surface 列表（核心反检测指标） ──
    // 每条形如 `<strong>WebGL</strong><span class="lies hash">e58ad7c4</span>`
    // 或 `<strong>Intl</strong><span class="bold-fail hash">23d22f8d</span>`
    const liesSurfaces: Array<{ surface: string; severity: 'lies' | 'bold-fail'; hash: string }> = [];
    document.querySelectorAll('span.lies, span.bold-fail').forEach((span) => {
      const cls = span.className.toLowerCase();
      const severity: 'lies' | 'bold-fail' = cls.includes('bold-fail') ? 'bold-fail' : 'lies';
      const hash = (span.textContent ?? '').trim();
      // surface 名在前面紧邻的 <strong>
      const prevStrong = span.previousElementSibling;
      const surface =
        prevStrong && prevStrong.tagName === 'STRONG'
          ? (prevStrong.textContent ?? '').trim()
          : '<unknown>';
      if (hash) liesSurfaces.push({ surface, severity, hash });
    });
    result.liesSurfaces = liesSurfaces;
    result.liesCount = liesSurfaces.filter((l) => l.severity === 'lies').length;
    result.boldFailCount = liesSurfaces.filter((l) => l.severity === 'bold-fail').length;

    // ── Trust score（旧版本 selector，可能 N/A） ──
    const trustEl = document.querySelector('.trust-score, [class*="trust"]');
    result.trustScore = trustEl?.textContent?.trim() ?? null;

    // ── FP id (主指纹 hash) ──
    const fpEl = document.querySelector('[class*="fingerprint"] strong, .fingerprint .id');
    result.fingerprintId = fpEl?.textContent?.trim() ?? null;

    // ── 全文 fallback：旧版 CreepJS 可能用 `N lies / N blocked / N errors` 文本 ──
    const allText = document.body.textContent ?? '';
    const blockedMatch = allText.match(/(\d+)\s*blocked/i);
    const errorsMatch = allText.match(/(\d+)\s*errors?/i);
    result.blockedCount = blockedMatch ? Number(blockedMatch[1]) : null;
    result.errorsCount = errorsMatch ? Number(errorsMatch[1]) : null;

    // ── 收集所有 sub-card 标题 + 截断文本（人工查阅用） ──
    const sections: Array<{ title: string; subtitle: string }> = [];
    document.querySelectorAll('.col-six, .visitor-info, [class*="card"]').forEach((card) => {
      const title = card.querySelector('strong, h2, h3, .strong')?.textContent?.trim() ?? '';
      const subtitle = (card.textContent ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
      if (title) sections.push({ title, subtitle });
    });
    result.sections = sections;

    return result;
  });
}

/**
 * deviceandbrowserinfo.com/are_you_a_bot — 暴露布尔信号最多的站。
 *
 * 页面渲染一组形如 `hasInconsistentClientHints: true|false` 的键值对（在 .raw-detection-details
 * 或 `<pre>`/`<code>` 块里输出 JSON / 表格）。我们做两件事：
 *   1. 优先抓 JSON-style block —— 服务器会先把 detection result JSON 嵌入到 `<pre>` / `<code>`
 *      / `<script type="application/json">` 节点里。
 *   2. fallback：解析正文里所有 `\bkey:\s*(true|false)\b` 模式的对，构造布尔 map。
 *
 * 关心的 16 个 key 已在站点 doc 里列出，命中任何 true 都意味着 spoof 失败。
 */
async function extractDbiBot(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};
    const knownKeys = [
      'hasBotUserAgent',
      'hasWebdriverTrue',
      'hasWebdriverInFrameTrue',
      'isPlaywright',
      'hasInconsistentChromeObject',
      'isPhantom',
      'isNightmare',
      'isSequentum',
      'isSeleniumChromeDefault',
      'isHeadlessChrome',
      'isWebGLInconsistent',
      'isAutomatedWithCDP',
      'isAutomatedWithCDPInWebWorker',
      'hasInconsistentClientHints',
      'hasInconsistentGPUFeatures',
      'isIframeOverridden',
      'hasInconsistentWorkerValues',
      'hasHighHardwareConcurrency',
      'hasHeadlessChromeDefaultScreenResolution',
      'hasSuspiciousWeakSignals',
    ] as const;

    // ── 1) 优先解析嵌入的 JSON ──
    let parsedFromJson: Record<string, unknown> | null = null;
    const jsonNodes = Array.from(
      document.querySelectorAll('pre, code, script[type="application/json"]'),
    );
    for (const node of jsonNodes) {
      const text = (node.textContent ?? '').trim();
      if (!text || text.length > 50_000) continue;
      // 一个 quick heuristic：含有 `hasWebdriverTrue` 或 `isPlaywright` 关键字
      if (!/\bisPlaywright\b|\bhasWebdriverTrue\b|\bhasInconsistentClientHints\b/.test(text)) continue;
      try {
        parsedFromJson = JSON.parse(text);
        break;
      } catch {
        // 非纯 JSON，继续 fallback
      }
    }

    // ── 2) 文本 fallback：扫描 body 全文里 `\bkey: true|false\b` 对 ──
    const flags: Record<string, boolean> = {};
    if (parsedFromJson && typeof parsedFromJson === 'object') {
      for (const k of knownKeys) {
        const v = (parsedFromJson as Record<string, unknown>)[k];
        if (typeof v === 'boolean') flags[k] = v;
      }
    }
    if (Object.keys(flags).length === 0) {
      const body = document.body?.textContent ?? '';
      for (const k of knownKeys) {
        // tolerate "key": true 或 key: true 或 key = true
        const re = new RegExp(`["']?${k}["']?\\s*[:=]\\s*(true|false)\\b`, 'i');
        const m = body.match(re);
        if (m && m[1]) flags[k] = m[1].toLowerCase() === 'true';
      }
    }

    result.flags = flags;
    result.flagsTotal = Object.keys(flags).length;
    result.flagsTrue = Object.values(flags).filter((v) => v === true).length;
    result.flagsTriggered = Object.entries(flags)
      .filter(([, v]) => v === true)
      .map(([k]) => k);

    // 抓页面底部的 verdict / summary（如果有）
    const verdictEl = document.querySelector('[class*="verdict"], [class*="result"], h1, h2');
    result.verdict = verdictEl?.textContent?.trim().slice(0, 200) ?? null;

    return result;
  });
}

/**
 * amiunique.org/fingerprint — 给每个属性的全球独特性百分比。
 *
 * 页面结构：两个表（HTTP headers + JavaScript attributes），每行 `[Attribute, Similarity, Value]`。
 * Similarity 列形如 `0.04 %` 或 `12.3 %` —— 越大越普通，越小越独特。我们抓所有属性 → 标记
 * "outlier"（< 0.5%，即仅极少访客有此值，强烈提示 spoof 出了陌生组合）。
 *
 * 顶部 verdict 形如 `Yes! You are unique among the 4,081,246 fingerprints` 或
 * `Almost! Only 50 browsers ... have exactly the same fingerprint as yours`。
 */
async function extractAmIUnique(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};

    // ── verdict ──
    const verdictTexts: string[] = [];
    document.querySelectorAll('h1, h2, h3, .uniquenessText, [class*="unique"]').forEach((el) => {
      const t = (el.textContent ?? '').trim();
      if (t.length > 0 && t.length < 400) verdictTexts.push(t);
    });
    const verdict =
      verdictTexts.find((t) => /unique|fingerprint|same fingerprint/i.test(t)) ??
      verdictTexts[0] ??
      null;
    result.verdict = verdict;

    // ── 属性表 ──
    interface AmIUniqueAttr {
      name: string;
      similarityPct: number | null;
      similarityRaw: string;
      value: string;
    }
    const attrs: AmIUniqueAttr[] = [];
    document.querySelectorAll('table tr').forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('th, td')) as HTMLTableCellElement[];
      // amiunique 的属性表通常是 3 列：name / similarity / value
      if (cells.length < 3) return;
      const nameCell = cells[0];
      const simCell = cells[1];
      const valCell = cells[2];
      if (!nameCell || !simCell || !valCell) return;
      const name = (nameCell.textContent ?? '').trim();
      const simRaw = (simCell.textContent ?? '').trim();
      // 跳过表头
      if (!name || /attribute/i.test(name)) return;
      // 解析百分比
      const m = simRaw.match(/([\d.]+)\s*%/);
      const pct = m && m[1] ? Number.parseFloat(m[1]) : null;
      const value = (valCell.textContent ?? '').trim().slice(0, 300);
      attrs.push({ name, similarityPct: pct, similarityRaw: simRaw, value });
    });

    result.attrs = attrs;
    result.attrsTotal = attrs.length;
    // outlier = similarity 小于 0.5%（极罕见，提示 spoof 值组合脱离主流）
    const outliers = attrs.filter(
      (a) => a.similarityPct !== null && a.similarityPct < 0.5,
    );
    result.outliers = outliers;
    result.outlierCount = outliers.length;
    return result;
  });
}

/**
 * pixelscan.net/fingerprint-check — SPA，所有结果通过 React 客户端渲染。
 *
 * 页面有 5 个主分类卡片：Browser / Location / Proxy / Fingerprint / Bot check。
 * 每卡片渲染时会从 "Collecting Data…" 切到具体值；DOM class 通常含 status (`.success`,
 * `.warning`, `.danger`)。
 *
 * 实战教训（2026-05-15）：headless + Cloudflare gating 下 SPA 永远卡在 "Collecting Data…"，
 * 因此我们重点抓三件事：
 *   1. **stillLoading** —— 看正文是否还在 "Collecting Data…" 状态（这本身就说明 site
 *      被 Cloudflare 拦住了，结果不可信）。
 *   2. **challengeDetected** —— Turnstile / "Just a moment" 文本。
 *   3. **白名单 card titles** —— 只信任 5 个核心模块名（Browser/Location/Proxy/
 *      Fingerprint/Bot check），跳过 FAQ / 营销文案，避免误把 FAQ 里的 "detect" 当成
 *      danger 信号。
 *
 * 真要拿到可信结果需要 HEADED=1 + 干净 IP；headless 下默认输出 "still loading" 警告。
 */
async function extractPixelscan(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};

    // ── 全文信号 ──
    const allText = document.body?.textContent ?? '';
    const maskMatch = allText.match(/mask\s+(?:is\s+)?(detected|not detected|consistent|inconsistent)/i);
    result.maskVerdict = maskMatch ? maskMatch[0] : null;
    result.challengeDetected = /just a moment|verify you are human|cf-mitigated|turnstile/i.test(
      allText.slice(0, 5_000),
    );
    // 还在收集数据 = SPA 被 Cloudflare/反爬卡住，没拿到真正结果。
    result.stillLoading = /collecting\s+data/i.test(allText.slice(0, 5_000));

    // ── 只关心 5 个核心检测模块（白名单），其他文案直接跳过避免 FAQ 误判 ──
    const TRUSTED_TITLES = [
      'Browser',
      'Location',
      'Proxy',
      'Fingerprint',
      'Bot check',
      'Bot Verification',
    ];
    const isTrustedTitle = (title: string): boolean =>
      TRUSTED_TITLES.some((t) => new RegExp(`^${t}\\s*$`, 'i').test(title));

    interface PsCard {
      title: string;
      status: 'success' | 'warning' | 'danger' | 'unknown';
      summary: string;
    }
    const cards: PsCard[] = [];
    const seen = new Set<string>();
    document
      .querySelectorAll(
        '[class*="card"], [class*="Card"], section, [class*="status"], [class*="result"]',
      )
      .forEach((el) => {
        const titleEl = el.querySelector('h1, h2, h3, h4, [class*="title"], [class*="Title"]');
        const title = (titleEl?.textContent ?? '').trim().slice(0, 80);
        if (!title || title.length < 3 || seen.has(title)) return;
        // 只信白名单标题；其它（FAQ、Frequently Asked Questions、Tools list 等）跳过
        if (!isTrustedTitle(title)) return;
        seen.add(title);

        // SVG 元素的 className 是 SVGAnimatedString 而非 string，要兜底
        const rawCls = el.className;
        const cls = (typeof rawCls === 'string' ? rawCls : (rawCls as SVGAnimatedString).baseVal ?? '').toLowerCase();
        let status: PsCard['status'] = 'unknown';
        if (/success|consistent|valid|good/.test(cls)) status = 'success';
        else if (/warning|warn/.test(cls)) status = 'warning';
        else if (/danger|error|fail|inconsistent/.test(cls)) status = 'danger';
        // 文本 fallback —— 只在白名单卡片里找显式状态字样
        const innerText = (el.textContent ?? '').toLowerCase();
        if (status === 'unknown') {
          if (/collecting\s+data/.test(innerText)) {
            status = 'unknown'; // 仍在加载，明确不算 danger
          } else if (/(mask\s+detected|inconsistent|mismatch|fingerprint\s+detected)/.test(innerText) &&
                     !/not detected/.test(innerText)) {
            status = 'danger';
          } else if (/(warning|attention|review)/.test(innerText)) {
            status = 'warning';
          } else if (/(consistent|all good|verified|natural)/.test(innerText)) {
            status = 'success';
          }
        }
        const summary = (el.textContent ?? '')
          .slice(0, 240)
          .replace(/\s+/g, ' ')
          .trim();
        cards.push({ title, status, summary });
      });
    result.cards = cards;

    // ── 计数 ──
    result.dangerCards = cards.filter((c) => c.status === 'danger').length;
    result.warningCards = cards.filter((c) => c.status === 'warning').length;
    result.successCards = cards.filter((c) => c.status === 'success').length;
    result.unknownCards = cards.filter((c) => c.status === 'unknown').length;

    return result;
  });
}

/**
 * arh.antoinevastel.com/bots — Fp-Scanner（Datadome 研究员维护的 fingerprint
 * bot detector），每项检测给 Consistent / Unsure / Inconsistent 三态。
 *
 * 页面结构：标题 "Result of Fp-scanner" 之下渲染一个列表 / 表，每行形如
 * `[testName]: [Consistent|Unsure|Inconsistent]`。
 *
 * Inconsistent = bot 检出（严重）。Unsure = 模糊（中度）。Consistent = 通过。
 *
 * 提取策略：
 *   1. 找所有列表 row / table row 含 "Consistent" / "Unsure" / "Inconsistent" 关键字
 *   2. 把测试名拆出来，与 Fp-Scanner 已知 24 个检测项对照（USER_AGENT, WEBDRIVER,
 *      WEBGL, NAVIGATOR_PROTOTYPE, NAVIGATOR_LANGUAGES_LENGTH, PLUGINS_LENGTH,
 *      MIME_TYPES_LENGTH, PLUGINS_NAME, ACCURACY_TIMESTAMP, MEDIA_QUERY_DARK_MODE,
 *      ...）
 *   3. 兜底：抓 fp 本体 JSON（fp-collect 上传到下方 `<pre>` 里）
 */
async function extractAntoinevastel(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};

    // ── 1. 检测项三态结果 ──
    interface FpsRow {
      name: string;
      status: 'consistent' | 'unsure' | 'inconsistent' | 'unknown';
      raw: string;
    }
    const rows: FpsRow[] = [];
    const seenNames = new Set<string>();
    // Fp-Scanner 用 <li> / <tr> / <p> 渲染每项；为兼容多版本，全部扫一遍
    const candidates = Array.from(
      document.querySelectorAll('li, tr, p, div'),
    ) as HTMLElement[];
    for (const el of candidates) {
      const text = (el.textContent ?? '').trim();
      if (text.length < 5 || text.length > 300) continue;
      // 三态关键字必须命中其一
      const m = text.match(/\b(Consistent|Unsure|Inconsistent)\b/i);
      if (!m) continue;
      const verdict = (m[1] ?? '').toLowerCase();
      // 把 verdict 之前的部分当 name；去掉冒号 / 减号 / 数字下划线噪声
      const namePart = text
        .slice(0, m.index ?? 0)
        .replace(/[:\-–—]+\s*$/, '')
        .trim();
      // 跳过过长的（很可能整段说明） + 过短的（只剩标点）
      if (namePart.length < 2 || namePart.length > 80) continue;
      if (seenNames.has(namePart)) continue;
      seenNames.add(namePart);
      const status =
        verdict === 'consistent'
          ? 'consistent'
          : verdict === 'unsure'
            ? 'unsure'
            : verdict === 'inconsistent'
              ? 'inconsistent'
              : 'unknown';
      rows.push({ name: namePart, status, raw: text.slice(0, 200) });
    }
    result.rows = rows;
    result.rowsTotal = rows.length;
    result.consistent = rows.filter((r) => r.status === 'consistent').length;
    result.unsure = rows.filter((r) => r.status === 'unsure').length;
    result.inconsistent = rows.filter((r) => r.status === 'inconsistent').length;
    result.inconsistentTests = rows
      .filter((r) => r.status === 'inconsistent')
      .map((r) => r.name);
    result.unsureTests = rows.filter((r) => r.status === 'unsure').map((r) => r.name);

    // ── 2. fp-collect JSON dump（如果暴露在 `<pre>` 里）──
    let fpCollectJson: unknown = null;
    document.querySelectorAll('pre, code').forEach((node) => {
      if (fpCollectJson) return;
      const text = (node.textContent ?? '').trim();
      if (text.length < 100 || text.length > 100_000) return;
      // fp-collect 含 "userAgent" + "languages" + "hardwareConcurrency" 等 key
      if (!/\buserAgent\b.*\blanguages\b/s.test(text)) return;
      try {
        fpCollectJson = JSON.parse(text);
      } catch {
        // 非纯 JSON，跳过
      }
    });
    result.fpCollect = fpCollectJson;

    return result;
  });
}

/**
 * bot.incolumitas.com — Nikolai Tschacher 的综合 bot detector。
 *
 * 页面结构：分多个 section（Behavioral / New Detection Tests / Browser Fingerprint /
 * Canvas / WebGL / Web Worker / Service Worker / Browser Data），每个 section 用
 * `<pre>` 块输出 JSON 结果。本提取器：
 *
 *   1. 抓所有 `<pre>` 节点的 JSON，按 section 标题归类。
 *   2. 关键 boolean / score 字段汇总（intoli/areyouheadless/headless/permissions/iframe
 *      chrome window dimensions, etc.）。
 *   3. fallback：扫正文里 `\bdetected[: ]+(true|yes)\b` 之类的硬信号。
 */
async function extractIncolumitas(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};

    // ── 1. 抓 `<pre>` JSON 块 ──
    interface PreSection {
      heading: string | null;
      json: unknown;
      rawSnippet: string;
    }
    const preSections: PreSection[] = [];
    const pres = Array.from(document.querySelectorAll('pre, code')) as HTMLElement[];
    for (const pre of pres) {
      const text = (pre.textContent ?? '').trim();
      if (text.length < 30 || text.length > 50_000) continue;
      // 找紧邻的上一个 h2/h3/h4 作为 section heading
      let heading: string | null = null;
      let cursor: Element | null = pre;
      while (cursor) {
        cursor = cursor.previousElementSibling;
        if (!cursor) {
          cursor = pre.parentElement;
          if (cursor) cursor = cursor.previousElementSibling;
        }
        if (!cursor) break;
        const tn = cursor.tagName;
        if (tn === 'H1' || tn === 'H2' || tn === 'H3' || tn === 'H4') {
          heading = (cursor.textContent ?? '').trim().slice(0, 80);
          break;
        }
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // 不是 JSON 也保留 rawSnippet（如纯文本测试结果）
      }
      preSections.push({ heading, json: parsed, rawSnippet: text.slice(0, 400) });
    }
    result.preSections = preSections;

    // ── 2. 提取关键布尔/数值 ──
    // incolumitas 关心的"红色信号"字段（命中 = bot 检出）
    const knownBadKeys = [
      'intoli',
      'isHeadlessChrome',
      'detected',
      'areYouHeadless',
      'hasHeadlessUA',
      'webdriver',
      'phantomjs',
      'selenium',
      'iframeChrome',
      'permissionsLeak',
      'languagesNumberMismatch',
      'fakeNotifications',
      'fakeMimeTypes',
      'fakePlugins',
      'badMimeTypes',
      'iframeContentWindowLeaks',
    ];
    const triggeredBadFlags: Array<{ section: string | null; key: string; value: unknown }> = [];
    for (const sec of preSections) {
      if (!sec.json || typeof sec.json !== 'object') continue;
      // 递归扫一层（incolumitas JSON 大多是单层）
      const obj = sec.json as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const lowerK = k.toLowerCase();
        for (const bad of knownBadKeys) {
          if (lowerK.includes(bad.toLowerCase())) {
            if (v === true || v === 'true' || v === 1 || v === 'yes') {
              triggeredBadFlags.push({ section: sec.heading, key: k, value: v });
            }
          }
        }
      }
    }
    result.triggeredBadFlags = triggeredBadFlags;
    result.triggeredBadFlagsCount = triggeredBadFlags.length;

    // ── 3. 文本 fallback：扫整体 "Bot detected" / "Headless detected" 类硬判定 ──
    const allText = document.body?.textContent ?? '';
    result.botDetectedText = /\b(bot\s+detected|headless\s+detected|automation\s+detected)\b/i.test(
      allText,
    );

    // ── 4. behavioral score / category（页面顶部 "Behavioral Classification"） ──
    const behavioralMatch = allText.match(/behavioral\s+classification[^]{0,400}/i);
    result.behavioralSnippet = behavioralMatch
      ? behavioralMatch[0].slice(0, 400).replace(/\s+/g, ' ').trim()
      : null;

    return result;
  });
}

/**
 * fingerprint-scan.com — 商业风格 bot risk score 站。
 *
 * 页面渲染一个 0-100 的 score（"Bot Risk Score"） + 各 surface 子分。Score >50 =
 * 大概率 bot。
 *
 * 提取策略：
 *   1. 抓主分数（页面通常用大字号 / 高亮 `<span>` / `<h2>` 显示）
 *   2. 抓所有 fingerprint 属性表
 *   3. 抓页面里所有数字 0-100 + verdict 关键字（low/medium/high risk）
 */
async function extractFingerprintScan(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};

    // ── 1. 找主分数（启发式：抓最显眼的 0-100 数字） ──
    let botRiskScore: number | null = null;
    let scoreSourceText: string | null = null;
    const candidates = Array.from(
      document.querySelectorAll('h1, h2, h3, [class*="score"], [class*="Score"], [class*="risk"], [class*="Risk"], strong, b, span'),
    ) as HTMLElement[];
    for (const el of candidates) {
      const t = (el.textContent ?? '').trim();
      if (t.length > 200) continue;
      // 同时含有 "score" / "risk" 关键字 + 0-100 数字
      const m = t.match(/\b(\d{1,3})\b/);
      if (!m || !m[1]) continue;
      const n = Number(m[1]);
      if (n < 0 || n > 100) continue;
      // 只在含有 score/risk/bot 上下文里提
      if (!/score|risk|bot/i.test(t)) continue;
      // 优先用第一个匹配且数字明确（不是 "404" 之类的）
      if (botRiskScore === null || /risk\s+score/i.test(t)) {
        botRiskScore = n;
        scoreSourceText = t.slice(0, 150);
      }
    }
    // fallback：扫正文找 "Bot Risk Score: 42" / "Score: 42" 类 pattern
    if (botRiskScore === null) {
      const bodyText = document.body?.textContent ?? '';
      const m = bodyText.match(/(?:bot\s+risk\s+score|risk\s+score|score)[:\s]+(\d{1,3})\b/i);
      if (m && m[1]) {
        const n = Number(m[1]);
        if (n >= 0 && n <= 100) {
          botRiskScore = n;
          scoreSourceText = m[0];
        }
      }
    }
    result.botRiskScore = botRiskScore;
    result.scoreSourceText = scoreSourceText;
    result.scoreVerdict =
      botRiskScore === null
        ? 'unknown'
        : botRiskScore >= 50
          ? 'bot'
          : botRiskScore >= 25
            ? 'suspicious'
            : 'human';

    // ── 2. fingerprint 属性表（如有） ──
    const attrs: Array<{ name: string; value: string }> = [];
    document.querySelectorAll('table tr, dl > *').forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('th, td, dt, dd')) as HTMLTableCellElement[];
      if (cells.length === 2) {
        const [nameCell, valueCell] = cells;
        if (!nameCell || !valueCell) return;
        const name = (nameCell.textContent ?? '').trim();
        const value = (valueCell.textContent ?? '').trim().slice(0, 300);
        if (name && value && name !== 'Property' && name !== 'Attribute') {
          attrs.push({ name, value });
        }
      }
    });
    result.attrs = attrs;
    result.attrsTotal = attrs.length;

    // ── 3. verdict 关键字 ──
    const allText = document.body?.textContent ?? '';
    result.highRiskHit = /\bhigh\s+risk\b/i.test(allText);
    result.lowRiskHit = /\blow\s+risk\b/i.test(allText);
    result.botDetectedText = /\b(bot\s+detected|likely\s+bot|automated)\b/i.test(allText);

    return result;
  });
}
