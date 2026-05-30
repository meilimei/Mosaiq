/**
 * Detection Lab 主页面（按 persona）。
 *
 * 功能：
 *   - 顶部 hero：persona id + "New Run" button + cancel button（active 时）
 *   - 实时 progress：active run 时显示进度条（done / total sites）+ 当前 site + 已用时间
 *   - <RunsTrendChart>（>= 2 run 时显示）
 *   - 历史 runs 列表：点击进 detail 页 / 删除
 *
 * 进度订阅：
 *   - mount 时 `mosaiqEvents.onDetectionLabProgress` 订阅
 *   - 用 useRef 保存当前 active runId（startRun 拿到的）作为 filter
 *   - 终态事件（done/canceled/error）到达时：refresh 列表 + 清 active state + 推 toast
 *
 * 并发约束：同一 persona 单 run 串行——main 会拒第二次 startRun。这里直接 disable
 * "New Run" 按钮兜底，避免误点等回程报错。
 */

import {
  AlertCircle,
  ArrowLeft,
  ArrowRightLeft,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/components/Toast.js';
import { RunsTrendChart } from '@/components/detection-lab/RunsTrendChart.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { STATUS_BADGE_CLASS, STATUS_LABEL, formatMs } from '@/lib/detection-lab.js';
import { cn, formatDate } from '@/lib/utils.js';
import type { PersonaId } from '@runova/persona-schema';
import type { DetectionRunSummary, RunProgressEvent } from '@runova/sdk';

interface DetectionLabPageProps {
  personaId: PersonaId;
  personaName?: string;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
  /**
   * v0.9 phase 9.9: 进入对比页（同 persona 的两个 run 间 diff）。父级负责
   * 路由切换；本页只提供入口按钮，run 数 < 2 时按钮 disabled。
   */
  onOpenCompare: () => void;
}

/**
 * 进行中 run 的 UI 状态。runId 在 startRun 返回后立即记录，避免 IPC 事件先于
 * resolve 到达时进度被丢弃。
 */
interface ActiveRunState {
  runId: string;
  startedAtMs: number;
  /** init 事件填 */
  totalSites: number;
  /** 已完成的站数（site-end OK + site-end FAIL 都计） */
  sitesDone: number;
  /** 当前 in-flight site id（site-start 后更新；site-end 后清空等下一个 start） */
  currentSiteId: string | null;
  /** 当前 site 的重试计数（site-retry 累加；site-end 清零） */
  currentRetries: number;
  /** 上次事件的 phase（UI 状态文案用） */
  lastPhase: RunProgressEvent['phase'];
}

const DELETE_CONFIRM_TIMEOUT_MS = 5000;

export function DetectionLabPage({
  personaId,
  personaName,
  onBack,
  onOpenRun,
  onOpenCompare,
}: DetectionLabPageProps) {
  const toast = useToast();
  const [runs, setRuns] = useState<DetectionRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [active, setActive] = useState<ActiveRunState | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  /** 1s tick：让 active run 的"已用时间"实时变化 */
  const [, setTick] = useState(0);
  /** 删除二次确认目标 runId */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const list = await window.mosaiq.detectionLabListRuns(personaId);
      setRuns(list);
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [personaId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 进度订阅 — mount 时挂、unmount 自动 cleanup
  useEffect(() => {
    const cleanup = window.mosaiqEvents.onDetectionLabProgress((msg) => {
      // 仅消费当前页面 active 的 run（别的 persona 的 run 不在乎）
      if (activeRunIdRef.current !== msg.runId) return;
      const evt = msg.progress;
      setActive((prev) => {
        if (!prev || prev.runId !== msg.runId) return prev;
        const next: ActiveRunState = { ...prev, lastPhase: evt.phase };
        switch (evt.phase) {
          case 'init':
            next.totalSites = evt.totalSites ?? prev.totalSites;
            break;
          case 'site-start':
            next.currentSiteId = evt.siteId ?? null;
            next.currentRetries = 0;
            break;
          case 'site-retry':
            next.currentRetries = evt.retryAttempt ?? next.currentRetries + 1;
            break;
          case 'site-end':
            next.sitesDone = prev.sitesDone + 1;
            next.currentSiteId = null;
            next.currentRetries = 0;
            break;
          case 'done':
          case 'canceled':
          case 'error':
            return prev; // 终态在下面处理，不修改 active state
        }
        return next;
      });

      // 终态：清 active + refresh + toast
      if (evt.phase === 'done' || evt.phase === 'canceled' || evt.phase === 'error') {
        activeRunIdRef.current = null;
        setActive(null);
        void refresh();
        if (evt.phase === 'done') {
          toast.success(`Detection run 完成 (${msg.runId})`);
        } else if (evt.phase === 'canceled') {
          toast.info(`已取消 run ${msg.runId}`);
        } else {
          toast.error(`Run 失败：${evt.error ?? '未知错误'}`);
        }
      }
    });
    return cleanup;
  }, [refresh, toast]);

  // 1s tick：active run 的 elapsed 时间
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  // 卸载 cleanup
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const handleStart = async () => {
    if (active || starting) return;
    setStarting(true);
    try {
      const res = await window.mosaiq.detectionLabRun(personaId);
      if (!res.ok) {
        toast.error(`启动失败：${res.error}`);
        return;
      }
      activeRunIdRef.current = res.runId;
      setActive({
        runId: res.runId,
        startedAtMs: Date.now(),
        totalSites: 0,
        sitesDone: 0,
        currentSiteId: null,
        currentRetries: 0,
        lastPhase: 'init',
      });
      toast.info(`已启动 run ${res.runId}`);
    } catch (err) {
      toast.error(`启动失败：${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!active) return;
    try {
      const ok = await window.mosaiq.detectionLabCancel(active.runId);
      if (!ok) {
        toast.info('Run 已不在进行中');
        activeRunIdRef.current = null;
        setActive(null);
        await refresh();
      }
      // ok=true：等终态事件到达再清 active state
    } catch (err) {
      toast.error(`取消失败：${(err as Error).message}`);
    }
  };

  const handleDeleteClick = async (runId: string) => {
    if (confirmingDelete === runId) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
      setConfirmingDelete(null);
      try {
        await window.mosaiq.detectionLabDeleteRun(personaId, runId);
        toast.success(`已删除 run ${runId}`);
        await refresh();
      } catch (err) {
        toast.error(`删除失败：${(err as Error).message}`);
      }
      return;
    }
    setConfirmingDelete(runId);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmingDelete(null);
      confirmTimerRef.current = null;
    }, DELETE_CONFIRM_TIMEOUT_MS);
  };

  /** 给 trend chart 一个稳定的 array reference */
  const trendData = useMemo(() => runs, [runs]);

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
            disabled={loading}
            title="刷新历史 run 列表"
          >
            <RefreshCw className="mr-1 h-4 w-4" /> 刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenCompare}
            disabled={runs.length < 2}
            title={runs.length < 2 ? '至少需要 2 次 run 才能对比' : '对比两次 run 之间的差异'}
          >
            <ArrowRightLeft className="mr-1 h-4 w-4" /> 对比 Runs
          </Button>
          {active ? (
            <Button variant="destructive" size="sm" onClick={handleCancel}>
              <Square className="mr-1 h-4 w-4" /> 取消
            </Button>
          ) : (
            <Button size="sm" onClick={handleStart} disabled={starting}>
              {starting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              新一次 Run
            </Button>
          )}
        </div>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Detection Lab</h1>
        <p className="text-sm text-muted-foreground">
          Persona：<span className="font-mono">{personaName ?? personaId}</span>
          {personaName && (
            <span className="ml-1 text-xs text-muted-foreground/70">（{personaId}）</span>
          )}
        </p>
      </div>

      {/* 进行中 run 进度卡 */}
      {active && <ActiveRunCard active={active} />}

      {/* 趋势图（≥1 个完成 run） */}
      {!loading && runs.length >= 2 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">加权命中趋势（最近 20 次）</CardTitle>
            <CardDescription>下行 = persona 表现改善；红点 = failed / canceled</CardDescription>
          </CardHeader>
          <CardContent>
            <RunsTrendChart runs={trendData} />
          </CardContent>
        </Card>
      )}

      {/* 历史 run 列表 */}
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
      ) : loading ? (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载历史 run…
        </div>
      ) : runs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="text-lg font-medium">还没有 run 记录</div>
            <div className="text-sm text-muted-foreground">
              点击右上「新一次 Run」开始第一次检测
            </div>
            <Button onClick={handleStart} disabled={starting || !!active} className="mt-2">
              {starting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              开始第一次 Run
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">历史 Run（{runs.length}）</CardTitle>
            <CardDescription>点击行查看详情；按 startedAt 降序</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {runs.map((r) => {
                const isConfirming = confirmingDelete === r.runId;
                return (
                  <div
                    key={r.runId}
                    className="group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-muted/40"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRun(r.runId)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-medium',
                          STATUS_BADGE_CLASS[r.status],
                        )}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-sm">{r.runId}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(r.timestamp)} · 耗时 {formatMs(r.durationMs)}
                        </div>
                      </div>
                      <div className="grid shrink-0 grid-cols-3 gap-2 text-xs">
                        <Metric label="OK / 共" value={`${r.sitesOk} / ${r.sitesAttempted}`} />
                        <Metric label="hits" value={String(r.totalHits)} tone="bad" />
                        <Metric label="加权" value={r.weightedHits.toFixed(1)} tone="warn" />
                      </div>
                    </button>
                    {isConfirming ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteClick(r.runId)}
                      >
                        确认删除？
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteClick(r.runId)}
                        title="删除此 run"
                        disabled={r.runId === active?.runId}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部展示组件
// ─────────────────────────────────────────────────────────────────────────────

function ActiveRunCard({ active }: { active: ActiveRunState }) {
  const elapsedMs = Date.now() - active.startedAtMs;
  const percent =
    active.totalSites > 0 ? Math.round((active.sitesDone / active.totalSites) * 100) : 0;
  const phaseText =
    active.lastPhase === 'init'
      ? '初始化…'
      : active.lastPhase === 'site-start'
        ? `跑 ${active.currentSiteId ?? '?'}…`
        : active.lastPhase === 'site-retry'
          ? `${active.currentSiteId ?? '?'} 重试 #${active.currentRetries}…`
          : active.lastPhase === 'site-end'
            ? '等下一站…'
            : active.lastPhase;
  return (
    <Card className="border-blue-500/40">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
            <span className="font-mono">{active.runId}</span>
            <Badge className="border-blue-500/30 bg-blue-500/10 text-blue-400">运行中</Badge>
          </CardTitle>
          <span className="text-xs text-muted-foreground">已用 {formatMs(elapsedMs)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{phaseText}</span>
          <span className="font-mono">
            {active.sitesDone} / {active.totalSites || '?'}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className="min-w-[64px] rounded-md border border-border bg-muted/30 px-2 py-1 text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'text-sm font-semibold leading-tight',
          tone === 'bad' && 'text-red-400',
          tone === 'warn' && 'text-amber-400',
          tone === 'good' && 'text-emerald-400',
        )}
      >
        {value}
      </div>
    </div>
  );
}
