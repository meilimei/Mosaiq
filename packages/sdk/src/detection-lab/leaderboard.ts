/**
 * detection-lab/leaderboard — pure DetectionRun[] → public leaderboard projection.
 *
 * 把一组（每个 persona / engine 一份）`DetectionRun` 聚合成一张排行榜，并渲染成
 * **自包含的静态 HTML**（内联 CSS，无外部依赖 / 无 JS），用于公开发布
 * （GitHub Pages）。两段式，方便单测：
 *
 *   1. `buildLeaderboard(entries)` → `LeaderboardModel`（纯数据：排名 + surface 矩阵）
 *   2. `renderLeaderboardHtml(model)` → `string`（HTML 字符串）
 *
 * 设计原则（与 run-format.ts 等 pure 模块对齐）：
 *   - 无 I/O：不读盘、不写盘、不 console、不 fetch。输入 const-ref，输出值。
 *   - 时间可注入（`nowIso`）以保证渲染确定性，单测断言完整 HTML。
 *   - `engine` 字段是一等公民：当前只填 Mosaiq 自家 persona，但留好竞品行的位置，
 *     等真实测得竞品数据后直接追加 entry 即可（**绝不臆造竞品数字**）。
 *
 * 分数语义：`weightedHits` 越低越好（命中越少 = 反检测越强）。排名按 weightedHits
 * 升序，平手按 sitesFail 升序，再按 label 字典序。
 */

import type { DetectionRun, HitsBySurface, RunStatus, SurfaceName } from './types.js';
import { emptyHitsBySurface } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 公共契约
// ─────────────────────────────────────────────────────────────────────────────

/** 排行榜单元输入 —— 一个 engine × persona 的一次评分运行。 */
export interface LeaderboardEntry {
  /**
   * Engine / 产品标签，例如 `'Mosaiq'`。同一张榜可混入竞品行（未来），
   * 所以它是一等字段而不是写死。
   */
  engine: string;
  /** persona / profile 行的人类可读标签，例如 `'Windows 11 · Chrome 130 (US)'`。 */
  personaLabel: string;
  /** 被评分的运行（完整 `DetectionRun` 或 `stripRunForBaseline` 的投影都可）。 */
  run: DetectionRun;
}

/** 渲染好的一行排行榜。 */
export interface LeaderboardRow {
  engine: string;
  personaLabel: string;
  personaId: string;
  /** 1-based 排名（weightedHits 升序，越低越好）。 */
  rank: number;
  weightedHits: number;
  sitesOk: number;
  sitesFail: number;
  creepjsLies: number;
  creepjsBoldFail: number;
  sannysoftPass: number;
  sannysoftTotal: number;
  hitsBySurface: HitsBySurface;
  status: RunStatus;
  /** false = 该 run 没有 score（failed / canceled 且无 partial），行渲染成 "—"。 */
  hasScore: boolean;
}

export interface LeaderboardModel {
  /** 渲染时间（ISO）。 */
  generatedAt: string;
  /** 已排名的行。 */
  rows: LeaderboardRow[];
  /** surface 矩阵的列顺序（稳定）。 */
  surfaces: readonly SurfaceName[];
  /** 入榜 run 里观察到的 SDK 版本（取第一个非空）。 */
  sdkVersion?: string;
  /** 入榜 run 里观察到的 Chromium 版本（取第一个非空且非 baseline 占位）。 */
  chromiumVersion?: string;
  totalEngines: number;
  totalPersonas: number;
}

export interface BuildLeaderboardOptions {
  /** 注入"现在"（ISO）以保证确定性。默认 `new Date().toISOString()`。 */
  nowIso?: string;
}

export interface RenderLeaderboardOptions {
  /** 页面 `<title>` / `<h1>`。默认 `'Mosaiq Detection Lab Leaderboard'`。 */
  title?: string;
  /**
   * 方法论 / 数据来源说明段落（已是可信 HTML，原样插入；调用方自负转义）。
   * 默认给一段诚实的免责声明。
   */
  methodologyHtml?: string;
}

// surface 矩阵列顺序：高价值面在前（与 run-format.ts 一致）。
const SURFACE_ORDER: readonly SurfaceName[] = [
  'webdriver',
  'navigator',
  'canvas',
  'webgl',
  'audio',
  'font',
  'webrtc',
  'screen',
  'permissions',
  'timezone',
  'plugins',
  'other',
];

const BASELINE_VERSION_PLACEHOLDER = 'baseline';

// ─────────────────────────────────────────────────────────────────────────────
// 1) 聚合 + 排名
// ─────────────────────────────────────────────────────────────────────────────

export function buildLeaderboard(
  entries: readonly LeaderboardEntry[],
  options: BuildLeaderboardOptions = {},
): LeaderboardModel {
  const generatedAt = options.nowIso ?? new Date().toISOString();

  const rows: LeaderboardRow[] = entries.map((entry) => {
    const { run } = entry;
    const score = run.score;
    return {
      engine: entry.engine,
      personaLabel: entry.personaLabel,
      personaId: run.personaId,
      rank: 0, // filled after sort
      weightedHits: score?.weightedHits ?? 0,
      sitesOk: score?.sitesOk ?? 0,
      sitesFail: score?.sitesFail ?? 0,
      creepjsLies: score?.creepjsLies ?? 0,
      creepjsBoldFail: score?.creepjsBoldFail ?? 0,
      sannysoftPass: score?.sannysoftPass ?? 0,
      sannysoftTotal: score?.sannysoftTotal ?? 0,
      hitsBySurface: score ? { ...score.hitsBySurface } : emptyHitsBySurface(),
      status: run.status,
      hasScore: score !== null && score !== undefined,
    };
  });

  // weightedHits 升序（越低越强）→ sitesFail 升序 → label 字典序。
  // 无 score 的行永远沉底（不参与名次的有意义比较）。
  rows.sort((a, b) => {
    if (a.hasScore !== b.hasScore) return a.hasScore ? -1 : 1;
    if (a.weightedHits !== b.weightedHits) return a.weightedHits - b.weightedHits;
    if (a.sitesFail !== b.sitesFail) return a.sitesFail - b.sitesFail;
    return a.personaLabel.localeCompare(b.personaLabel);
  });

  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  const sdkVersion = firstNonEmpty(entries.map((e) => e.run.meta?.sdkVersion));
  const chromiumVersion = firstNonEmpty(
    entries
      .map((e) => e.run.meta?.chromiumVersion)
      .filter((v) => v !== BASELINE_VERSION_PLACEHOLDER),
  );

  const engines = new Set(entries.map((e) => e.engine));
  const personas = new Set(entries.map((e) => e.run.personaId));

  return {
    generatedAt,
    rows,
    surfaces: SURFACE_ORDER,
    sdkVersion,
    chromiumVersion,
    totalEngines: engines.size,
    totalPersonas: personas.size,
  };
}

function firstNonEmpty(values: ReadonlyArray<string | undefined>): string | undefined {
  for (const v of values) {
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 渲染静态 HTML
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_METHODOLOGY_HTML =
  '<p>Each row is a real <code>mosaiq detection-lab run</code> against the ' +
  'committed fixture persona, scored across a battery of public ' +
  'fingerprint / bot-detection sites. <strong>Lower <code>weightedHits</code> ' +
  'is better</strong> (fewer detector hits = stronger anti-detection). ' +
  'Numbers are reproducible from this repo\u2019s baseline runs; no figures ' +
  'are hand-edited. Competitor engines are only listed when we have a real ' +
  'measured run \u2014 we never estimate or fabricate their scores.</p>';

export function renderLeaderboardHtml(
  model: LeaderboardModel,
  options: RenderLeaderboardOptions = {},
): string {
  const title = options.title ?? 'Mosaiq Detection Lab Leaderboard';
  const methodologyHtml = options.methodologyHtml ?? DEFAULT_METHODOLOGY_HTML;

  const metaParts: string[] = [];
  if (model.sdkVersion) metaParts.push(`SDK ${esc(model.sdkVersion)}`);
  if (model.chromiumVersion) metaParts.push(`Chromium ${esc(model.chromiumVersion)}`);
  metaParts.push(`${model.totalPersonas} persona(s)`);
  metaParts.push(`${model.totalEngines} engine(s)`);

  const head = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<a class="back" href="../">\u2190 Mosaiq</a>',
    `<h1>${esc(title)}</h1>`,
    `<p class="meta">Generated ${esc(model.generatedAt)} · ${metaParts.join(' · ')}</p>`,
    `<section class="methodology">${methodologyHtml}</section>`,
  ];

  const body =
    model.rows.length === 0
      ? ['<p class="empty">No runs yet — commit a baseline to populate the board.</p>']
      : [renderScoreTable(model), renderSurfaceMatrix(model)];

  const foot = [
    '<footer>',
    '<p>Reproduce locally: <code>pnpm mosaiq detection-lab run &lt;persona-id&gt;</code>, ' +
      'then regenerate this page with <code>pnpm build-leaderboard</code>.</p>',
    '</footer>',
    '</main>',
    '</body>',
    '</html>',
  ];

  return `${[...head, ...body, ...foot].join('\n')}\n`;
}

function renderScoreTable(model: LeaderboardModel): string {
  const header = `<thead><tr>${th('#')}${th('Engine')}${th('Persona')}${th('Weighted hits', 'num')}${th('Sites ok/fail', 'num')}${th('CreepJS lies', 'num')}${th('CreepJS bold-fail', 'num')}${th('Sannysoft', 'num')}</tr></thead>`;

  const rows = model.rows
    .map((r) => {
      const sann = r.sannysoftTotal > 0 ? `${r.sannysoftPass}/${r.sannysoftTotal}` : '—';
      const sites = r.hasScore ? `${r.sitesOk}/${r.sitesFail}` : '—';
      const weighted = r.hasScore ? fmtNum(r.weightedHits) : '—';
      const cls = r.hasScore ? '' : ' class="no-score"';
      return `<tr${cls}>${td(String(r.rank))}${td(esc(r.engine))}${td(`${esc(r.personaLabel)} <span class="pid">${esc(r.personaId)}</span>`)}${td(weighted, 'num')}${td(sites, 'num')}${td(r.hasScore ? String(r.creepjsLies) : '—', 'num')}${td(r.hasScore ? String(r.creepjsBoldFail) : '—', 'num')}${td(sann, 'num')}</tr>`;
    })
    .join('');

  return `<h2>Ranking</h2>\n<table class="board">${header}<tbody>${rows}</tbody></table>`;
}

function renderSurfaceMatrix(model: LeaderboardModel): string {
  const header = `<thead><tr>${th('Persona')}${model.surfaces.map((s) => th(s, 'num')).join('')}</tr></thead>`;

  const rows = model.rows
    .map((r) => {
      const cells = model.surfaces
        .map((s) => {
          const n = r.hitsBySurface[s] ?? 0;
          const cls = n > 0 ? 'num hit' : 'num';
          return td(r.hasScore ? String(n) : '—', cls);
        })
        .join('');
      return `<tr>${td(`${esc(r.personaLabel)} <span class="pid">${esc(r.personaId)}</span>`)}${cells}</tr>`;
    })
    .join('');

  return `<h2>Hits by surface</h2>\n<table class="board matrix">${header}<tbody>${rows}</tbody></table>`;
}

// ── tiny html helpers ────────────────────────────────────────────────────────

function th(text: string, cls?: string): string {
  return cls ? `<th class="${cls}">${esc(text)}</th>` : `<th>${esc(text)}</th>`;
}

/** `text` is assumed already-safe HTML (callers pass escaped content or markup). */
function td(html: string, cls?: string): string {
  return cls ? `<td class="${cls}">${html}</td>` : `<td>${html}</td>`;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  ':root{--fg:#101411;--muted:#5f6860;--line:#d7ddd4;--hit:#b7524d;--accent:#237a58;--bg:#f6f7f4;--panel:#fff}',
  '*{box-sizing:border-box}',
  'body{margin:0;font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}',
  'main{max-width:980px;margin:0 auto;padding:2rem 1.25rem 4rem}',
  'a.back{display:inline-block;margin-bottom:1rem;color:var(--accent);font-weight:700;font-size:.9rem;text-decoration:none}',
  'a.back:hover{text-decoration:underline}',
  'h1{font-size:1.6rem;margin:0 0 .25rem}',
  'h2{font-size:1.15rem;margin:2.25rem 0 .75rem}',
  '.meta{color:var(--muted);margin:.25rem 0 1.5rem;font-size:.9rem}',
  '.methodology{color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem}',
  '.methodology p{margin:0}',
  'table.board{border-collapse:collapse;width:100%;font-size:.9rem;background:var(--panel)}',
  'table.board th,table.board td{border:1px solid var(--line);padding:.4rem .55rem;text-align:left}',
  'table.board th{background:#f1f4ee;font-weight:600}',
  'table.board td.num,table.board th.num{text-align:right;font-variant-numeric:tabular-nums}',
  'table.board tbody tr:nth-child(odd){background:#fbfcfa}',
  'table.board tr.no-score{color:var(--muted)}',
  'td.hit{color:var(--hit);font-weight:600}',
  '.pid{color:var(--muted);font-size:.78rem;font-family:ui-monospace,monospace}',
  'table.matrix{font-size:.82rem}',
  '.empty{color:var(--muted)}',
  'footer{margin-top:2.5rem;color:var(--muted);font-size:.85rem;border-top:1px solid var(--line);padding-top:1rem}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;background:#eef1ea;padding:.05em .35em;border-radius:4px}',
].join('');
