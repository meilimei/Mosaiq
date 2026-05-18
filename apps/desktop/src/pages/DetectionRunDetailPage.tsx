/**
 * 单次 DetectionRun 详情页。
 *
 * 流程：
 *   1. mount 调 `detectionLabGetRun` 拉完整 run
 *   2. 顶部 summary card（status / startedAt / duration / sites OK/FAIL / weightedHits / hits 总数）
 *   3. 左：雷达图（HitsBySurface）；右：headline 数字（creepjsLies / sannysoftPass / dbiBot 等）
 *   4. SurfaceHit 列表（按 surface 分组）
 *   5. 12 站 grid（SiteResultCard，附该站对应 hits）
 *
 * 错误处理：
 *   - run 文件不存在 / 损坏：toast 报错 + 显示 retry 按钮
 *   - 删除：二次确认（与 PersonaListPage 一致风格），成功后回 lab page
 */

import { AlertCircle, ArrowLeft, Check, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/components/Toast.js';
import { HitsBySurfaceRadar } from '@/components/detection-lab/HitsBySurfaceRadar.js';
import { SiteResultCard } from '@/components/detection-lab/SiteResultCard.js';
import { SurfaceHitBadge } from '@/components/detection-lab/SurfaceHitBadge.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import {
  STATUS_BADGE_CLASS,
  STATUS_LABEL,
  SURFACE_LABEL,
  SURFACE_ORDER,
  formatMs,
} from '@/lib/detection-lab.js';
import { cn } from '@/lib/utils.js';
import type { PersonaId } from '@mosaiq/persona-schema';
import type { DetectionRun, SurfaceHit, SurfaceName } from '@mosaiq/sdk';

interface DetectionRunDetailPageProps {
  personaId: PersonaId;
  runId: string;
  onBack: () => void;
  /** 删除成功后调用，让 lab page 重新拉列表 */
  onDeleted?: () => void;
}

const DELETE_CONFIRM_TIMEOUT_MS = 5000;

export function DetectionRunDetailPage({
  personaId,
  runId,
  onBack,
  onDeleted,
}: DetectionRunDetailPageProps) {
  const toast = useToast();
  const [run, setRun] = useState<DetectionRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await window.mosaiq.detectionLabGetRun(personaId, runId);
      setRun(r);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [personaId, runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  /** 按 site id 分组的 hits，O(n) build 一次给 12 个 SiteResultCard 用 */
  const hitsBySite = useMemo<Record<string, SurfaceHit[]>>(() => {
    const out: Record<string, SurfaceHit[]> = {};
    const all = run?.score?.hits ?? [];
    for (const h of all) {
      (out[h.site] ||= []).push(h);
    }
    return out;
  }, [run]);

  /** 按 surface 分组（详情面板第二个 section 用） */
  const hitsBySurface = useMemo<Record<SurfaceName, SurfaceHit[]>>(() => {
    const out = Object.fromEntries(SURFACE_ORDER.map((s) => [s, [] as SurfaceHit[]])) as Record<
      SurfaceName,
      SurfaceHit[]
    >;
    for (const h of run?.score?.hits ?? []) {
      out[h.surface].push(h);
    }
    return out;
  }, [run]);

  const handleDelete = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(
        () => setConfirmingDelete(false),
        DELETE_CONFIRM_TIMEOUT_MS,
      );
      return;
    }
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = null;
    setConfirmingDelete(false);
    setDeleting(true);
    try {
      await window.mosaiq.detectionLabDeleteRun(personaId, runId);
      toast.success(`已删除 run ${runId}`);
      onDeleted?.();
      onBack();
    } catch (err) {
      toast.error(`删除失败：${(err as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载 run…
      </div>
    );
  }

  if (loadError || !run) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 返回
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertCircle className="h-10 w-10 text-destructive" />
            <div className="text-lg font-medium">加载 run 失败</div>
            <div className="text-sm text-muted-foreground">{loadError ?? '未知错误'}</div>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw className="mr-1 h-4 w-4" /> 重试
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const score = run.score;
  const totalSites = run.raw?.sitesAttempted ?? run.sitesAttempted.length;
  const okSites = score?.sitesOk ?? 0;
  const failSites = score?.sitesFail ?? 0;
  const startedShort = new Date(run.startedAt).toLocaleString();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 返回历史列表
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading || deleting}
            title="重新加载"
          >
            <RefreshCw className="mr-1 h-4 w-4" /> 刷新
          </Button>
          {confirmingDelete ? (
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
              <Check className="mr-1 h-4 w-4" /> 确认删除？
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              title="删除此 run（含 artifacts）"
            >
              {deleting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-4 w-4" />
              )}
              删除
            </Button>
          )}
        </div>
      </div>

      {/* Summary card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <span className="font-mono text-base">{run.id}</span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
                    STATUS_BADGE_CLASS[run.status],
                  )}
                >
                  {STATUS_LABEL[run.status]}
                </span>
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-3 text-xs">
                <span>{startedShort}</span>
                <span>·</span>
                <span>耗时 {formatMs(run.durationMs)}</span>
                <span>·</span>
                <span>
                  站点 <span className="text-emerald-400">{okSites}</span> OK ·{' '}
                  <span className="text-red-400">{failSites}</span> FAIL · 共 {totalSites}
                </span>
                {run.meta?.sdkVersion && (
                  <>
                    <span>·</span>
                    <span className="font-mono">SDK v{run.meta.sdkVersion}</span>
                  </>
                )}
                {run.meta?.chromiumVersion && (
                  <>
                    <span>·</span>
                    <span className="font-mono">Chrome {run.meta.chromiumVersion}</span>
                  </>
                )}
              </CardDescription>
            </div>
            {/* Headline 数字 */}
            {score && (
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                <Headline label="加权命中" value={score.weightedHits.toFixed(1)} accent="primary" />
                <Headline label="hits 总数" value={String(score.hits.length)} />
                <Headline label="CreepJS lies" value={String(score.creepjsLies)} />
              </div>
            )}
          </div>
        </CardHeader>
        {run.error && (
          <CardContent>
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span className="font-medium">错误：</span>
              {run.error}
            </div>
          </CardContent>
        )}
      </Card>

      {/* 雷达 + 关键数字 grid */}
      {score && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Surface 命中分布</CardTitle>
            </CardHeader>
            <CardContent>
              <HitsBySurfaceRadar hitsBySurface={score.hitsBySurface} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">站点关键数字</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <StatRow
                label="sannysoft 通过"
                value={`${score.sannysoftPass} / ${score.sannysoftTotal}`}
              />
              <StatRow
                label="CreepJS bold-fail"
                value={String(score.creepjsBoldFail)}
                tone={score.creepjsBoldFail > 0 ? 'bad' : 'good'}
              />
              <StatRow
                label="dbi-bot 触发"
                value={String(score.dbiBotFlagsTriggered)}
                tone={score.dbiBotFlagsTriggered > 0 ? 'bad' : 'good'}
              />
              <StatRow
                label="amiunique outlier"
                value={String(score.amiuniqueOutliers)}
                tone={score.amiuniqueOutliers > 0 ? 'warn' : 'good'}
              />
              <StatRow
                label="Fp-Scanner inconsistent"
                value={String(score.fpScannerInconsistent)}
                tone={score.fpScannerInconsistent > 0 ? 'bad' : 'good'}
              />
              <StatRow
                label="incolumitas bad flag"
                value={String(score.incolumitasBadFlags)}
                tone={score.incolumitasBadFlags > 0 ? 'bad' : 'good'}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* hits 按 surface 分组列表 */}
      {score && score.hits.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">SurfaceHit 列表（{score.hits.length}）</CardTitle>
            <CardDescription>按 surface 分组，点站点 grid 可查看上下文</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {SURFACE_ORDER.map((s) => {
              const arr = hitsBySurface[s];
              if (arr.length === 0) return null;
              return (
                <div key={s} className="space-y-1">
                  <div className="text-xs font-semibold text-muted-foreground">
                    {SURFACE_LABEL[s]} · {arr.length}
                  </div>
                  <div className="space-y-1">
                    {arr.map((h, i) => (
                      <div
                        key={`${h.surface}-${h.detector}-${h.site}-${i}`}
                        className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-2 text-xs"
                      >
                        <SurfaceHitBadge hit={h} compact />
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-muted-foreground">
                            {h.site} · {h.detector}
                          </div>
                          <div className="mt-0.5 break-words">{h.evidence}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* 12 站 grid */}
      {run.raw && run.raw.results && run.raw.results.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">站点结果</h2>
            <span className="text-xs text-muted-foreground">{run.raw.results.length} 站</span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {run.raw.results.map((r) => (
              <SiteResultCard key={r.id} site={r} hits={hitsBySite[r.id] ?? []} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部展示组件
// ─────────────────────────────────────────────────────────────────────────────

function Headline({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'primary';
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'text-lg font-semibold leading-tight',
          accent === 'primary' && 'text-primary',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <Badge
        className={cn(
          tone === 'good' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
          tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-400',
          tone === 'bad' && 'border-red-500/30 bg-red-500/10 text-red-400',
        )}
      >
        {value}
      </Badge>
    </div>
  );
}
