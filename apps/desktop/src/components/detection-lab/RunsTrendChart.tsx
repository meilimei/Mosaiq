/**
 * 历史 run 趋势图 — `weightedHits` 折线（次轴：sitesFail 柱）。
 *
 * 数据：DetectionRunSummary[]（main process 返回，已按 startedAt 降序）。
 * 我们在组件内 reverse 成升序（左→右 = 早→晚），并只取最近 N=20 个。
 *
 * 设计：
 *   - 用 LineChart，X 轴 = 序号 + 短日期 tick，避免数十次 run 时 timestamp 拥挤
 *   - weightedHits 线 = primary 色
 *   - failed / canceled run 的点用 destructive 标红（dot renderer）
 *   - 高度 200px（detail 页 inline，列表页 hero 上方）
 *   - 空数据（0 run）不渲染，返回 null（父级决定空态 UI）
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { DetectionRunSummary } from '@runova/sdk';

import { STATUS_LABEL, formatMs } from '@/lib/detection-lab.js';

interface RunsTrendChartProps {
  runs: DetectionRunSummary[];
  height?: number;
  /** 最大显示条数；默认 20。多余的丢弃最早 */
  maxPoints?: number;
}

interface TrendPoint {
  /** 1-based 序号（X 轴 label） */
  idx: number;
  weightedHits: number;
  totalHits: number;
  sitesOk: number;
  sitesFail: number;
  durationMs: number;
  startedAt: string;
  shortTime: string;
  status: DetectionRunSummary['status'];
  runId: string;
}

export function RunsTrendChart({ runs, height = 200, maxPoints = 20 }: RunsTrendChartProps) {
  if (runs.length === 0) return null;

  // 截取最近 N 个，升序排列（chart 左→右 = 早→晚）
  const points: TrendPoint[] = [...runs]
    .slice(0, maxPoints)
    .reverse()
    .map((r, i) => ({
      idx: i + 1,
      weightedHits: r.weightedHits,
      totalHits: r.totalHits,
      sitesOk: r.sitesOk,
      sitesFail: r.sitesFail,
      durationMs: r.durationMs,
      startedAt: r.timestamp,
      shortTime: new Date(r.timestamp).toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      status: r.status,
      runId: r.runId,
    }));

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis
            dataKey="idx"
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
            stroke="hsl(var(--border))"
          />
          <YAxis
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
            stroke="hsl(var(--border))"
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(_, payload) => {
              const p = payload?.[0]?.payload as TrendPoint | undefined;
              if (!p) return '';
              return `#${p.idx} · ${p.shortTime}`;
            }}
            formatter={(value, _name, ctx) => {
              const p = ctx?.payload as TrendPoint | undefined;
              if (!p) return [value, 'weightedHits'];
              return [
                `${p.weightedHits.toFixed(1)} · ${STATUS_LABEL[p.status]} · ${p.sitesOk}/${p.sitesOk + p.sitesFail} OK · ${formatMs(p.durationMs)}`,
                '加权命中',
              ];
            }}
          />
          <Line
            type="monotone"
            dataKey="weightedHits"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={(props) => {
              const { cx, cy, payload, index } = props as {
                cx: number;
                cy: number;
                payload: TrendPoint;
                index: number;
              };
              const fail = payload.status === 'failed' || payload.status === 'canceled';
              return (
                <circle
                  key={`dot-${payload.runId}-${index}`}
                  cx={cx}
                  cy={cy}
                  r={fail ? 4 : 3}
                  fill={fail ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
                  stroke="hsl(var(--background))"
                  strokeWidth={1}
                />
              );
            }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
