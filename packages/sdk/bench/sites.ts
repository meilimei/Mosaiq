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
 * 9 个目标站。按反指纹检测严苛程度从低到高排序。
 *
 * 加 3 个站的动机（Phase 1 收尾，扩展防御面）：
 *   - **dbi-bot** (deviceandbrowserinfo) ：暴露**最直接的布尔信号**（`isPlaywright`、
 *     `hasInconsistentClientHints`、`hasInconsistentWorkerValues`、`isWebGLInconsistent` 等），
 *     这些恰好对应我们 v0.1 已实施的 spoof 面，是最快的 sanity check。
 *   - **amiunique** ：给出每个属性的**全球独特性百分比**——能识别"我们 spoof 出的某个值
 *     在其数据库中过于罕见"的 outlier，提示需要再贴近常见 persona。
 *   - **pixelscan** ：商业反检测圈最常用的 mask check 站之一，给出整体 mask/bot
 *     verdict + 分类指标。SPA 加载较慢，settle 给足。
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
