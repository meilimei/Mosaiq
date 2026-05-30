/**
 * Multi-polygon radar — overlays one polygon per persona on a single
 * `HitsBySurface` chart.
 *
 * Used by the v0.9 phase 9.4 Persona Pool comparison page to make
 * cross-persona detection profiles visually diff-able at a glance.
 *
 * Data shape:
 *   - input: `Array<{ personaId, displayName, hitsBySurface }>`
 *   - flattened to recharts data:
 *       `[{ surface, label, [persona1Id]: hits, [persona2Id]: hits, ... }, …]`
 *     one row per surface (12 rows fixed), one Radar per persona.
 *
 * Visual:
 *   - shared axes, color palette deterministic per persona index
 *   - all polygons semi-transparent (fillOpacity 0.20) so overlap reads
 *     as additive shading
 *   - tooltip shows surface + each persona's hit count for that surface
 *   - legend below maps colors to persona names; clicking a legend entry
 *     toggles that persona's polygon (recharts default behavior)
 *
 * Empty data (no entries, or all hits = 0) renders a single "全 surface
 * 无命中" green pill, mirroring `HitsBySurfaceRadar`.
 */

import {
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

import { SURFACE_LABEL, hitsBySurfaceToRadarData } from '@/lib/detection-lab.js';
import type { PersonaId } from '@runova/persona-schema';
import type { HitsBySurface, SurfaceName } from '@runova/sdk';

export interface PoolRadarEntry {
  personaId: PersonaId;
  displayName: string;
  hitsBySurface: HitsBySurface;
}

interface PoolRadarChartProps {
  entries: PoolRadarEntry[];
  /** 容器高度，默认 360（比单 persona radar 略高，给 legend 留位置） */
  height?: number;
}

/**
 * Color palette for up to 8 personas (sourced from Tailwind palette midtones,
 * picked for distinctness on dark mode background). Repeats if we ever need
 * more — but the page-level UI caps selection at 8.
 */
const POOL_COLORS = [
  '#60a5fa', // blue-400
  '#f87171', // red-400
  '#34d399', // emerald-400
  '#fbbf24', // amber-400
  '#a78bfa', // violet-400
  '#f472b6', // pink-400
  '#22d3ee', // cyan-400
  '#fb923c', // orange-400
] as const;

export function PoolRadarChart({ entries, height = 360 }: PoolRadarChartProps) {
  // Build the row-per-surface matrix that recharts wants. Each row carries
  // one "hits" value per persona keyed by personaId.
  const data = (() => {
    if (entries.length === 0) return [];
    // Use the first entry's surface order — they all share SURFACE_ORDER via
    // hitsBySurfaceToRadarData, so the rows are aligned by index.
    const firstShape = hitsBySurfaceToRadarData(entries[0]?.hitsBySurface ?? ({} as HitsBySurface));
    return firstShape.map((row, rowIdx) => {
      const out: Record<string, number | string> = {
        surface: row.surface,
        label: row.label,
      };
      for (const e of entries) {
        const shape = hitsBySurfaceToRadarData(e.hitsBySurface);
        out[e.personaId] = shape[rowIdx]?.hits ?? 0;
      }
      return out;
    });
  })();

  // Compute axis max across all personas + all surfaces; +1 so the outer ring
  // is always visible even at low hit counts.
  const axisMax = entries.reduce((max, e) => {
    const shape = hitsBySurfaceToRadarData(e.hitsBySurface);
    return Math.max(max, ...shape.map((d) => d.hits));
  }, 1);

  // All-zero short-circuit (parallel to HitsBySurfaceRadar empty state).
  const total = entries.reduce(
    (s, e) => s + Object.values(e.hitsBySurface).reduce((a, b) => a + b, 0),
    0,
  );
  if (entries.length === 0 || total === 0) {
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
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="70%">
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
          {entries.map((e, i) => {
            const color = POOL_COLORS[i % POOL_COLORS.length] ?? '#888';
            return (
              <Radar
                key={e.personaId}
                name={e.displayName}
                dataKey={e.personaId}
                stroke={color}
                fill={color}
                fillOpacity={0.2}
                strokeWidth={1.5}
                dot={{ r: 2, fill: color }}
              />
            );
          })}
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
            formatter={(value, name) => [`${value as number} 次`, String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconSize={10} iconType="circle" />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Re-export the palette so the per-surface table can match Radar colors. */
export { POOL_COLORS };
