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
  /** 站点特异提取器，可选 */
  extract?: (page: Page) => Promise<Record<string, unknown>>;
}

/**
 * 6 个目标站。按反指纹检测严苛程度从低到高排序。
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
