/**
 * Detection Run Compare 页面 — v0.9 phase 9.9.
 *
 * 同 persona 的两个 run 之间做差分。Diff 计算复用 SDK pure `diffRuns`
 * (9.8 hoisted)，desktop 这边只是 picker UI + RunDiff 的渲染层。
 *
 * 流程：
 *   1. mount → `detectionLabListRuns(personaId)` 拉历史 run summary 列表
 *   2. 默认 A = 第二新（baseline / 参考），B = 最新（candidate / 待评估），
 *      原则与 9.2b CLI compare 命令一致：「我刚跑完一次，相比上一次有没有
 *      回归？」是最常见的对比意图
 *   3. 任一 selector 变化 → IPC `detectionLabCompareRuns` → 更新 `diff`
 *   4. 渲染 5 块：A/B 快照（侧边）、Δ 头条、站点翻转 / 站点不一致警告、
 *      Removed / Added / Changed hits 三组列表、Verdict footer
 *
 * UX 选择：
 *   - selector 用原生 `<select>`，搭配 Tailwind 自定义样式 — 项目 ui/ 里
 *     没有 Select primitive，且 native 在键盘 / 屏幕阅读器 / Electron
 *     `accessibilityEnabled` 三方面零成本可用
 *   - A / B 的「角色」（baseline / candidate）始终固定（不交换），保持与
 *     SDK 数据约定一致：delta = B - A，负 = B 更好。即便用户把"较新的"
 *     run 选在 A，UI 也只是机械算 B - A，让用户自己理解方向
 *   - 与 CLI `printDiff` 的渲染顺序对齐（snapshot 双卡 → Δ → site flip →
 *     removed → added → changed → verdict），方便同时维护两个出口
 *
 * 错误：
 *   - 列表 load 失败 → 全页重试卡（与 DetectionLabPage 一致）
 *   - run 数 < 2 → 空状态卡（建议返回先多跑几次）
 *   - IPC `detectionLabCompareRuns` 失败 → toast.error + 保留旧 diff
 *     不清空，避免界面闪烁；retry 按钮重新发起对比
 *
 * 不在本页范围：
 *   - 跳到具体 run 详情：用户自己回 lab page 进入 detail 页（避免跨页导航
 *     状态丢失，本页本身不嵌入 onOpenRun 回调）
 *   - 删除 run / 重新跑：保持单一职责，删除入口在 lab / detail 页
 */

import {
  AlertCircle,
  ArrowLeft,
  ArrowRightLeft,
  Loader2,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/Toast.js';
import { SurfaceHitBadge } from '@/components/detection-lab/SurfaceHitBadge.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { STATUS_BADGE_CLASS, STATUS_LABEL, formatMs } from '@/lib/detection-lab.js';
import { cn, formatDate } from '@/lib/utils.js';
import type { PersonaId } from '@mosaiq/persona-schema';
import type { DetectionRunSummary, RunDiff } from '@mosaiq/sdk';

interface DetectionRunComparePageProps {
  personaId: PersonaId;
  personaName?: string;
  onBack: () => void;
}

export function DetectionRunComparePage({
  personaId,
  personaName,
  onBack,
}: DetectionRunComparePageProps) {
  const toast = useToast();
  const [runs, setRuns] = useState<DetectionRunSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  /** A = baseline / older 默认；B = candidate / newer 默认 */
  const [runIdA, setRunIdA] = useState<string | null>(null);
  const [runIdB, setRunIdB] = useState<string | null>(null);

  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const list = await window.mosaiq.detectionLabListRuns(personaId);
      setRuns(list);
      // 默认：A = 第二新，B = 最新（list 已按 startedAt desc 排序）。
      // 用解构 + 显式 undefined 检查走 noUncheckedIndexedAccess 的窄化。
      const [newest, secondNewest] = list;
      if (newest && secondNewest) {
        setRunIdA(secondNewest.runId);
        setRunIdB(newest.runId);
      } else {
        setRunIdA(null);
        setRunIdB(null);
      }
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [personaId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 任一 selector 变化（且都已选）→ 触发 diff
  useEffect(() => {
    if (!runIdA || !runIdB) {
      setDiff(null);
      setCompareError(null);
      return;
    }
    let canceled = false;
    setComparing(true);
    setCompareError(null);
    window.mosaiq
      .detectionLabCompareRuns(personaId, runIdA, runIdB)
      .then((res) => {
        if (canceled) return;
        setDiff(res);
      })
      .catch((err: Error) => {
        if (canceled) return;
        setCompareError(err.message);
        toast.error(`对比失败：${err.message}`);
        // 不清 diff：让上次结果保留以避免界面骤然空白
      })
      .finally(() => {
        if (!canceled) setComparing(false);
      });
    return () => {
      canceled = true;
    };
  }, [personaId, runIdA, runIdB, toast]);

  /**
   * "交换 A/B" 按钮：把 A 和 B 互换，重新触发 diff（useEffect 自动响应）。
   * 用户改变心意把 baseline 和 candidate 弄反了的时候有用。
   */
  const handleSwap = () => {
    setRunIdA(runIdB);
    setRunIdB(runIdA);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 返回 Detection Lab
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loadingList}
            title="刷新历史 run 列表"
          >
            <RefreshCw className={cn('mr-1 h-4 w-4', loadingList && 'animate-spin')} /> 刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSwap}
            disabled={!runIdA || !runIdB || comparing}
            title="交换 A 和 B"
          >
            <ArrowRightLeft className="mr-1 h-4 w-4" /> 交换 A/B
          </Button>
        </div>
      </div>

      <div>
        <h1 className="text-2xl font-bold">对比 Detection Runs</h1>
        <p className="text-sm text-muted-foreground">
          Persona：<span className="font-mono">{personaName ?? personaId}</span>
          {personaName && (
            <span className="ml-1 text-xs text-muted-foreground/70">（{personaId}）</span>
          )}
          <span className="ml-3 text-xs text-muted-foreground/70">
            约定：A = baseline / 参考 · B = candidate / 待评估 · Δ = B - A
          </span>
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
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载历史 run…
        </div>
      ) : runs.length < 2 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="text-lg font-medium">至少需要 2 次 run 才能对比</div>
            <div className="text-sm text-muted-foreground">
              当前只有 {runs.length} 次记录。返回 Detection Lab 多跑几次，再来对比。
            </div>
            <Button variant="outline" onClick={onBack} className="mt-2">
              <ArrowLeft className="mr-1 h-4 w-4" /> 返回 Detection Lab
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <RunSnapshotPickerCard
              slot="A"
              slotLabel="baseline / 参考"
              runs={runs}
              value={runIdA}
              onChange={setRunIdA}
              snap={diff?.runA ?? null}
            />
            <RunSnapshotPickerCard
              slot="B"
              slotLabel="candidate / 待评估"
              runs={runs}
              value={runIdB}
              onChange={setRunIdB}
              snap={diff?.runB ?? null}
            />
          </div>

          {/* IPC 在跑：显示加载条；先前的 diff 仍然在后面渲染 */}
          {comparing && (
            <div className="flex items-center justify-center py-2 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> 对比中…
            </div>
          )}

          {/* 上次对比失败：醒目提示 + retry */}
          {!comparing && compareError && (
            <Card className="border-destructive/40">
              <CardContent className="flex items-center justify-between gap-3 py-4">
                <div className="flex items-center gap-2 text-sm">
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  对比失败：{compareError}
                </div>
                {/* 触发 useEffect 再跑：通过 setRunIdA(...) 写回当前值 */}
                <Button variant="outline" size="sm" onClick={() => setRunIdA(runIdA)}>
                  <RefreshCw className="mr-1 h-4 w-4" /> 重试
                </Button>
              </CardContent>
            </Card>
          )}

          {diff && (
            <>
              <DeltaHeadlineCard diff={diff} />
              <SiteListSection diff={diff} />
              <RemovedHitsSection diff={diff} />
              <AddedHitsSection diff={diff} />
              <ChangedHitsSection diff={diff} />
              {/* 完全没变 + 没翻转 → 显式说明，避免用户疑惑「页面是不是没刷新」 */}
              {diff.removed.length === 0 &&
                diff.added.length === 0 &&
                diff.changed.length === 0 &&
                diff.sitesFlipped.okToFail.length === 0 &&
                diff.sitesFlipped.failToOk.length === 0 && (
                  <Card>
                    <CardContent className="py-6 text-center text-sm text-muted-foreground">
                      两次 run 完全等价 — 没有 hit 变化、没有站点翻转。
                    </CardContent>
                  </Card>
                )}
              <VerdictFooter diff={diff} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单边（A 或 B）的 selector + 快照卡。`snap` 来自 diff.runA / diff.runB；
 * 在第一次 IPC resolve 之前 snap 是 null，此时只渲染 selector + 占位文字。
 *
 * `slot` prop（不叫 `role`）：避免 Biome a11y/useValidAriaRole 把它当成
 * HTML `role` ARIA 属性来校验。
 */
function RunSnapshotPickerCard({
  slot,
  slotLabel,
  runs,
  value,
  onChange,
  snap,
}: {
  slot: 'A' | 'B';
  slotLabel: string;
  runs: DetectionRunSummary[];
  value: string | null;
  onChange: (id: string) => void;
  snap: RunDiff['runA'] | null;
}) {
  const summary = runs.find((r) => r.runId === value);
  return (
    <Card className={slot === 'A' ? 'border-blue-500/30' : 'border-purple-500/30'}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Badge
              className={cn(
                'border font-bold',
                slot === 'A'
                  ? 'border-blue-500/40 bg-blue-500/10 text-blue-400'
                  : 'border-purple-500/40 bg-purple-500/10 text-purple-400',
              )}
            >
              {slot}
            </Badge>
            <span className="text-muted-foreground">{slotLabel}</span>
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        >
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.runId} · {STATUS_LABEL[r.status]} · w{r.weightedHits.toFixed(1)}
            </option>
          ))}
        </select>
        {snap && summary ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <KV label="状态">
              <span
                className={cn(
                  'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                  STATUS_BADGE_CLASS[snap.status],
                )}
              >
                {STATUS_LABEL[snap.status]}
              </span>
            </KV>
            <KV label="时间">{formatDate(summary.timestamp)}</KV>
            <KV label="耗时">{formatMs(snap.durationMs)}</KV>
            <KV label="站点">
              <span className="text-emerald-400">{snap.sitesOk} ok</span>
              {' · '}
              <span className={snap.sitesFail > 0 ? 'text-red-400' : 'text-muted-foreground'}>
                {snap.sitesFail} fail
              </span>
            </KV>
            <KV label="hits">{snap.totalHits}</KV>
            <KV label="加权">
              <span className="font-mono">{snap.weightedHits.toFixed(2)}</span>
            </KV>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">加载中…</div>
        )}
      </CardContent>
    </Card>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-10 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/**
 * Δ 头条：weightedHits / hits / sites Δok / Δfail。颜色规则：
 *   - delta < 0 → green（B 更好）
 *   - delta = 0 → muted
 *   - delta > 0 → red（B 更差）
 *
 * sitesOk 反转：Δok 为正反而是好事（更多站点过了），所以 green / red 调向：
 *   - Δok > 0 → green，Δok < 0 → red
 *   - Δfail > 0 → red，Δfail < 0 → green
 */
function DeltaHeadlineCard({ diff }: { diff: RunDiff }) {
  const { weightedHits, totalHits, sitesOk, sitesFail } = diff.delta;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Δ B - A</CardTitle>
        <CardDescription>负 = B 表现更好；正 = B 退化</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <DeltaCell
            label="weightedHits"
            value={weightedHits}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`}
            direction="lower-better"
          />
          <DeltaCell
            label="hits 总数"
            value={totalHits}
            format={(v) => `${v > 0 ? '+' : ''}${v}`}
            direction="lower-better"
          />
          <DeltaCell
            label="Δsites OK"
            value={sitesOk}
            format={(v) => `${v > 0 ? '+' : ''}${v}`}
            direction="higher-better"
          />
          <DeltaCell
            label="Δsites FAIL"
            value={sitesFail}
            format={(v) => `${v > 0 ? '+' : ''}${v}`}
            direction="lower-better"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function DeltaCell({
  label,
  value,
  format,
  direction,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  /** lower-better：负 = green，正 = red；higher-better：反之 */
  direction: 'lower-better' | 'higher-better';
}) {
  const isImprovement =
    (direction === 'lower-better' && value < 0) || (direction === 'higher-better' && value > 0);
  const isRegression =
    (direction === 'lower-better' && value > 0) || (direction === 'higher-better' && value < 0);
  const arrow =
    value === 0 ? null : isImprovement ? (
      <TrendingDown className="h-4 w-4" />
    ) : (
      <TrendingUp className="h-4 w-4" />
    );
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 flex items-center justify-center gap-1 text-base font-semibold leading-tight',
          isImprovement && 'text-emerald-400',
          isRegression && 'text-red-400',
          value === 0 && 'text-muted-foreground',
        )}
      >
        {arrow}
        <span className="font-mono">{format(value)}</span>
      </div>
    </div>
  );
}

/**
 * 站点翻转 + 站点列表不一致警告（合并展示，留白少）。
 * 全空时整个 section 不渲染。
 */
function SiteListSection({ diff }: { diff: RunDiff }) {
  const { sitesFlipped, sitesOnlyInA, sitesOnlyInB } = diff;
  const hasFlips = sitesFlipped.okToFail.length > 0 || sitesFlipped.failToOk.length > 0;
  const hasOnly = sitesOnlyInA.length > 0 || sitesOnlyInB.length > 0;
  if (!hasFlips && !hasOnly) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">站点状态</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {sitesFlipped.okToFail.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-red-400">✗ ok → fail：</span>
            {sitesFlipped.okToFail.map((s) => (
              <code
                key={s}
                className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-xs text-red-400"
              >
                {s}
              </code>
            ))}
          </div>
        )}
        {sitesFlipped.failToOk.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-emerald-400">✓ fail → ok：</span>
            {sitesFlipped.failToOk.map((s) => (
              <code
                key={s}
                className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-400"
              >
                {s}
              </code>
            ))}
          </div>
        )}
        {hasOnly && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
            <div className="mb-1 font-medium">
              ⚠ 站点列表不一致（两次 run 用了不同的 onlySites？）
            </div>
            {sitesOnlyInA.length > 0 && (
              <div>
                只在 A：<span className="font-mono">{sitesOnlyInA.join(', ')}</span>
              </div>
            )}
            {sitesOnlyInB.length > 0 && (
              <div>
                只在 B：<span className="font-mono">{sitesOnlyInB.join(', ')}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RemovedHitsSection({ diff }: { diff: RunDiff }) {
  if (diff.removed.length === 0) return null;
  return (
    <Card className="border-emerald-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-emerald-400">
          ✓ Removed ({diff.removed.length})
        </CardTitle>
        <CardDescription>A 有、B 没有 — B 改进的证据</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {diff.removed.map((h) => (
          <div key={`${h.surface}\x00${h.site}\x00${h.detector}`} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <SurfaceHitBadge hit={h} />
              <span className="text-xs text-muted-foreground">{h.site}</span>
            </div>
            {h.evidence && (
              <div className="ml-1 truncate text-xs text-muted-foreground/80">{h.evidence}</div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AddedHitsSection({ diff }: { diff: RunDiff }) {
  if (diff.added.length === 0) return null;
  return (
    <Card className="border-red-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-red-400">
          ✗ Added ({diff.added.length})
        </CardTitle>
        <CardDescription>A 没有、B 有 — B 退化的证据</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {diff.added.map((h) => (
          <div key={`${h.surface}\x00${h.site}\x00${h.detector}`} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <SurfaceHitBadge hit={h} />
              <span className="text-xs text-muted-foreground">{h.site}</span>
            </div>
            {h.evidence && (
              <div className="ml-1 truncate text-xs text-muted-foreground/80">{h.evidence}</div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ChangedHitsSection({ diff }: { diff: RunDiff }) {
  if (diff.changed.length === 0) return null;
  return (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-amber-400">
          ~ Changed ({diff.changed.length})
        </CardTitle>
        <CardDescription>identity 相同但 severity / evidence 变了</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {diff.changed.map((c) => (
          <div
            key={`${c.after.surface}\x00${c.after.site}\x00${c.after.detector}`}
            className="flex flex-col gap-1"
          >
            <div className="flex items-center gap-2">
              <SurfaceHitBadge hit={c.after} />
              <span className="text-xs text-muted-foreground">{c.after.site}</span>
            </div>
            {c.diff.includes('severity') && (
              <div className="ml-1 text-xs">
                <span className="text-muted-foreground">severity：</span>
                <span className="text-muted-foreground/80">{c.before.severity}</span>
                <span className="mx-1 text-muted-foreground">→</span>
                <span className="font-medium">{c.after.severity}</span>
              </div>
            )}
            {c.diff.includes('evidence') && (
              <div className="ml-1 space-y-0.5 text-xs">
                <div className="text-muted-foreground/80">- {c.before.evidence}</div>
                <div>+ {c.after.evidence}</div>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Verdict footer。三态：
 *   - hasRegression → red「B 退化」
 *   - delta.weightedHits < 0 ‖ removed.length > 0 → green「B 改善」
 *   - else → muted「无实质变化」
 *
 * 优先级：regression > improvement > neutral。即便 delta.weightedHits < 0，
 * 只要 hasRegression 为 true（例如 added 了 1 个 high hit + 减少了 2 个 low），
 * 仍按 regression 论 — CLI compare 9.2b 的 fail-on-regression 也是这套策略。
 */
function VerdictFooter({ diff }: { diff: RunDiff }) {
  const isRegression = diff.hasRegression;
  const isImprovement = !isRegression && (diff.delta.weightedHits < 0 || diff.removed.length > 0);
  const tone = isRegression ? 'bad' : isImprovement ? 'good' : 'neutral';
  return (
    <Card
      className={cn(
        tone === 'bad' && 'border-destructive/50 bg-destructive/5',
        tone === 'good' && 'border-emerald-500/40 bg-emerald-500/5',
        tone === 'neutral' && 'border-border',
      )}
    >
      <CardContent className="flex items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          {tone === 'bad' && <span className="text-red-400">✗ 结论：B 相比 A 出现回归</span>}
          {tone === 'good' && <span className="text-emerald-400">✓ 结论：B 相比 A 有改善</span>}
          {tone === 'neutral' && <span className="text-muted-foreground">结论：无实质变化</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          {diff.added.length > 0 && <span className="mr-3">added {diff.added.length}</span>}
          {diff.removed.length > 0 && <span className="mr-3">removed {diff.removed.length}</span>}
          {diff.changed.length > 0 && <span className="mr-3">changed {diff.changed.length}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
