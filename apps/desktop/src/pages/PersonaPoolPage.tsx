/**
 * Persona Pool Compare page — v0.9 phase 9.4.
 *
 * Pick N personas (2 ≤ N ≤ 8), pull each one's most-recent detection run,
 * and render side-by-side comparison: header strip + multi-polygon radar
 * + per-surface heat-map table.
 *
 * Flow:
 *   1. mount → load all personas via `listPersonas`
 *   2. user toggles checkboxes; `selectedIds` is a Set
 *   3. click "Compare" (enabled at ≥2 selections):
 *      a. for each selected id, list runs → take [0] → load full run
 *      b. for personas with no runs: included in entries but flagged "无 run 记录"
 *      c. on success: switch to comparison view
 *   4. "← 返回选择" goes back to the selector with same selection retained
 *
 * Concurrency:
 *   - Run loads fire in parallel (`Promise.allSettled`); per-persona errors
 *     surface inline and don't block the rest of the comparison.
 *   - Cap at 8 — radar palette has 8 colors and >8 polygons gets unreadable.
 *
 * Why no SDK change:
 *   - We need `hitsBySurface` per persona, which lives on `DetectionRun.score`,
 *     not on `DetectionRunSummary`. Loading the full run JSON per persona
 *     is fine: each is < 100KB and we cap at 8 personas.
 */

import { AlertCircle, ArrowLeft, BarChart3, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/Toast.js';
import { PoolRadarChart, type PoolRadarEntry } from '@/components/detection-lab/PoolRadarChart.js';
import { PoolSurfaceTable } from '@/components/detection-lab/PoolSurfaceTable.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { STATUS_BADGE_CLASS, STATUS_LABEL, formatMs } from '@/lib/detection-lab.js';
import { cn, formatDate } from '@/lib/utils.js';
import type { PersonaId } from '@runova/persona-schema';
import type { DetectionRun, DetectionRunSummary, HitsBySurface } from '@runova/sdk';

import type { PersonaSummary } from '../../electron/ipc-types.js';

/**
 * Local copy of `emptyHitsBySurface()` — we don't import the runtime helper
 * from `@runova/sdk` because that package's entry transitively pulls in
 * playwright-core / chromium-bidi which Vite cannot bundle for the renderer
 * (browser-target). Type-only imports from `@runova/sdk` are fine because
 * tsc erases them; this object literal is the only runtime SDK value we need.
 * If the SDK's HitsBySurface key set changes, tsc here will complain because
 * `HitsBySurface` is a strict `Record<SurfaceName, number>`.
 */
const EMPTY_HITS_BY_SURFACE: HitsBySurface = {
  canvas: 0,
  webgl: 0,
  audio: 0,
  font: 0,
  webrtc: 0,
  navigator: 0,
  screen: 0,
  permissions: 0,
  timezone: 0,
  plugins: 0,
  webdriver: 0,
  other: 0,
};

interface PersonaPoolPageProps {
  onBack: () => void;
  /** 点击对比项跳到 persona 自己的 Detection Lab 页面 */
  onOpenLab: (personaId: PersonaId, displayName: string) => void;
}

/** 支持的最大对比池大小（受调色板 + 可读性约束） */
const MAX_POOL = 8;
/** 至少选 2 个才有「对比」意义 */
const MIN_POOL = 2;

/**
 * 单 persona 的对比池条目载入结果。
 *   - `loaded` & `run`：成功拿到了最新 run（可能 score 为空 → hitsBySurface 全 0）
 *   - `loaded` & `run = null`：persona 从未跑过 detection，UI 显示「无 run 记录」
 *   - `error`：load 抛错，UI 显示错误条
 */
interface PoolItem {
  personaId: PersonaId;
  displayName: string;
  /** 加载状态 */
  state: 'loaded' | 'error';
  /** 最新 run 的摘要（计数字段用：sitesOk / sitesAttempted / weightedHits / status / timestamp） */
  summary: DetectionRunSummary | null;
  /** 拿到的最新 run 完整数据（score.hitsBySurface 用）；persona 没跑过为 null */
  run: DetectionRun | null;
  /** 仅当 state === 'error' 时有值 */
  error?: string;
}

export function PersonaPoolPage({ onBack, onOpenLab }: PersonaPoolPageProps) {
  const toast = useToast();

  // ─── 选择阶段状态 ───────────────────────────────────────────────────────
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<PersonaId>>(new Set());

  // ─── 对比阶段状态 ───────────────────────────────────────────────────────
  /** 'select' = 选择 personas；'compare' = 渲染对比视图 */
  const [phase, setPhase] = useState<'select' | 'compare'>('select');
  const [comparing, setComparing] = useState(false);
  const [items, setItems] = useState<PoolItem[]>([]);

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const list = await window.mosaiq.listPersonas();
      setPersonas(list);
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = (id: PersonaId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= MAX_POOL) {
          toast.info(`对比池最多 ${MAX_POOL} 个 persona`);
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  };

  const handleCompare = async () => {
    if (selectedIds.size < MIN_POOL) return;
    setComparing(true);
    try {
      // 并行：每个 selected persona → list runs → take [0] → load full run
      const ids = [...selectedIds];
      const results = await Promise.allSettled(
        ids.map(async (id): Promise<PoolItem> => {
          const display = personas.find((p) => p.id === id)?.displayName ?? id;
          try {
            const summaries = await window.mosaiq.detectionLabListRuns(id);
            const latest = summaries[0];
            if (!latest) {
              return {
                personaId: id,
                displayName: display,
                state: 'loaded',
                summary: null,
                run: null,
              };
            }
            const run = await window.mosaiq.detectionLabGetRun(id, latest.runId);
            return {
              personaId: id,
              displayName: display,
              state: 'loaded',
              summary: latest,
              run,
            };
          } catch (err) {
            return {
              personaId: id,
              displayName: display,
              state: 'error',
              summary: null,
              run: null,
              error: (err as Error).message,
            };
          }
        }),
      );
      const next: PoolItem[] = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        // Promise.allSettled wraps so a thrown error becomes a rejected promise;
        // our async fn already catches per-persona errors, so this branch is
        // basically defensive.
        const id = ids[i] as PersonaId;
        const display = personas.find((p) => p.id === id)?.displayName ?? id;
        return {
          personaId: id,
          displayName: display,
          state: 'error',
          summary: null,
          run: null,
          error: String(r.reason),
        };
      });
      setItems(next);
      setPhase('compare');
    } finally {
      setComparing(false);
    }
  };

  /** 把 PoolItem[] 派生为 radar / table 喂得动的 PoolRadarEntry[]。无 run / error 都跳过。 */
  const radarEntries = useMemo<PoolRadarEntry[]>(() => {
    const out: PoolRadarEntry[] = [];
    for (const it of items) {
      if (it.state !== 'loaded' || !it.run) continue;
      const hbs: HitsBySurface = it.run.score?.hitsBySurface ?? EMPTY_HITS_BY_SURFACE;
      out.push({
        personaId: it.personaId,
        displayName: it.displayName,
        hitsBySurface: hbs,
      });
    }
    return out;
  }, [items]);

  /** 加权 hits 字典，给 PoolSurfaceTable footer 用 */
  const weightedByPersona = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const it of items) {
      if (it.state === 'loaded' && it.run?.score) {
        out[it.personaId] = it.run.score.weightedHits;
      }
    }
    return out;
  }, [items]);

  // ─── 渲染：选择阶段 ─────────────────────────────────────────────────────
  if (phase === 'select') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="mr-1 h-4 w-4" /> 返回 Persona 列表
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loadingList}
              title="刷新 persona 列表"
            >
              <RefreshCw className="mr-1 h-4 w-4" /> 刷新
            </Button>
            <Button
              size="sm"
              onClick={handleCompare}
              disabled={selectedIds.size < MIN_POOL || comparing}
            >
              {comparing ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <BarChart3 className="mr-1 h-4 w-4" />
              )}
              对比（{selectedIds.size}）
            </Button>
          </div>
        </div>

        <div>
          <h1 className="text-2xl font-bold">Persona 对比池</h1>
          <p className="text-sm text-muted-foreground">
            勾选 {MIN_POOL}-{MAX_POOL} 个 persona，并排对比每个 persona 最近一次 detection run 的
            HitsBySurface 雷达图与 surface 命中表。
          </p>
        </div>

        {listError ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <AlertCircle className="h-8 w-8 text-destructive" />
              <div className="text-sm">列表加载失败</div>
              <div className="text-xs text-muted-foreground">{listError}</div>
              <Button variant="outline" size="sm" onClick={refresh}>
                <RefreshCw className="mr-1 h-4 w-4" /> 重试
              </Button>
            </CardContent>
          </Card>
        ) : loadingList ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载 persona 列表…
          </div>
        ) : personas.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="text-lg font-medium">还没有 persona</div>
              <div className="text-sm text-muted-foreground">
                先在「Persona 列表」页面新建几个 persona 并跑 detection run，再回到这里对比
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">选择 persona（{personas.length} 个可用）</CardTitle>
              <CardDescription>
                点击行勾选；最多 {MAX_POOL} 个。已选 {selectedIds.size}。
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {personas.map((p) => {
                  const checked = selectedIds.has(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggle(p.id)}
                      className={cn(
                        'flex w-full items-center gap-3 px-6 py-3 text-left transition-colors',
                        checked ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/40',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          checked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background',
                        )}
                        aria-hidden="true"
                      >
                        {checked && (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={3}
                            className="h-3 w-3"
                          >
                            <title>已选</title>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{p.displayName}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {p.id}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {p.os} · {p.browser}
                        </Badge>
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // ─── 渲染：对比阶段 ─────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => setPhase('select')}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 返回选择
        </Button>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 返回 Persona 列表
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Persona 对比 — {items.length} 个</h1>
        <p className="text-sm text-muted-foreground">
          每个 persona 取最近一次 detection run。点击 persona 卡片可跳到对应的 Detection Lab。
        </p>
      </div>

      {/* persona 头条带：每个 persona 的状态 + score 摘要 */}
      <div
        className={cn(
          'grid gap-3',
          items.length <= 2 && 'grid-cols-1 md:grid-cols-2',
          items.length === 3 && 'grid-cols-1 md:grid-cols-3',
          items.length >= 4 && 'grid-cols-2 md:grid-cols-4',
        )}
      >
        {items.map((it) => (
          <PoolPersonaCard
            key={it.personaId}
            item={it}
            onOpen={() => onOpenLab(it.personaId, it.displayName)}
          />
        ))}
      </div>

      {/* 多 persona 雷达图 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">HitsBySurface 雷达对比</CardTitle>
          <CardDescription>同 surface 上多 persona 折线重叠 = 共同弱点</CardDescription>
        </CardHeader>
        <CardContent>
          <PoolRadarChart entries={radarEntries} />
        </CardContent>
      </Card>

      {/* 每 surface 命中表 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">每 surface 命中数</CardTitle>
          <CardDescription>底部「加权总分」越低越好</CardDescription>
        </CardHeader>
        <CardContent>
          <PoolSurfaceTable entries={radarEntries} weightedByPersona={weightedByPersona} />
        </CardContent>
      </Card>
    </div>
  );
}

/** 单 persona 头条带卡片 — 包在头条带 grid 里 */
function PoolPersonaCard({ item, onOpen }: { item: PoolItem; onOpen: () => void }) {
  const { state, summary, error, displayName, personaId } = item;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-card p-3 text-left text-card-foreground transition-colors hover:bg-muted/40',
        state === 'error' && 'border-destructive/40',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{displayName}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{personaId}</div>
        </div>
      </div>

      {state === 'error' ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error ?? '未知错误'}
        </div>
      ) : summary ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                STATUS_BADGE_CLASS[summary.status],
              )}
            >
              {STATUS_LABEL[summary.status]}
            </span>
            <span className="text-xs text-muted-foreground">{formatDate(summary.timestamp)}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Metric label="OK" value={`${summary.sitesOk}/${summary.sitesAttempted}`} />
            <Metric
              label="hits"
              value={String(summary.totalHits)}
              tone={summary.totalHits > 0 ? 'bad' : undefined}
            />
            <Metric label="加权" value={summary.weightedHits.toFixed(1)} tone="warn" />
          </div>
          <div className="text-[11px] text-muted-foreground">
            耗时 {formatMs(summary.durationMs)}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-border/40 bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
          无 run 记录 — 先去跑一次 detection
        </div>
      )}
    </button>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'bad' | 'warn';
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-mono text-xs',
          tone === 'bad' && 'text-red-400',
          tone === 'warn' && 'text-amber-400',
        )}
      >
        {value}
      </span>
    </div>
  );
}
