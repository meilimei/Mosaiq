/**
 * 9-/12-surface 雷达图 — 一眼看出 hits 集中在哪些维度。
 *
 * 数据：`DetectionScore.hitsBySurface`（所有 surface 都有 key，0 也保留），
 * 经 `hitsBySurfaceToRadarData` 归一化按 SURFACE_ORDER 排序后喂给 recharts。
 *
 * 设计：
 *   - 用 recharts 的 PolarAngleAxis tickFormatter 显示中文短标签
 *   - 单 Radar，fill = primary 半透明（dark mode 友好）
 *   - 自动尺寸：父容器需给定高度（detail 页固定 320px）
 *   - 空数据（所有 hits = 0）不绘制 Radar 区域而显示一行"无命中"
 */

import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

import { SURFACE_LABEL, hitsBySurfaceToRadarData } from '@/lib/detection-lab.js';
import type { HitsBySurface, SurfaceName } from '@mosaiq/sdk';

interface HitsBySurfaceRadarProps {
  hitsBySurface: HitsBySurface;
  /** 容器高度，默认 320 */
  height?: number;
}

export function HitsBySurfaceRadar({ hitsBySurface, height = 320 }: HitsBySurfaceRadarProps) {
  const data = hitsBySurfaceToRadarData(hitsBySurface);
  const total = data.reduce((s, d) => s + d.hits, 0);
  /** 轴最大值：max(hits) + 1，保证 0 hits 的轴线也可见 */
  const axisMax = Math.max(1, ...data.map((d) => d.hits));

  if (total === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/5 text-sm text-emerald-400"
        style={{ height }}
      >
        ✓ 全 surface 无命中
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
          <PolarGrid stroke="hsl(var(--border))" />
          <PolarAngleAxis
            dataKey="surface"
            tickFormatter={(v: SurfaceName) => SURFACE_LABEL[v]}
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, axisMax]}
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
            tickCount={Math.min(axisMax + 1, 6)}
            allowDecimals={false}
          />
          <Radar
            name="hits"
            dataKey="hits"
            stroke="hsl(var(--destructive))"
            fill="hsl(var(--destructive))"
            fillOpacity={0.35}
            strokeWidth={1.5}
            dot={{ r: 2, fill: 'hsl(var(--destructive))' }}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(label) => {
              const s = label as SurfaceName | undefined;
              return s ? (SURFACE_LABEL[s] ?? s) : '';
            }}
            formatter={(value) => [`${value as number} 次`, '命中']}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
