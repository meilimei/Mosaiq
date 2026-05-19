/**
 * Per-surface comparison table — rows = surface, cols = persona, cells =
 * hit count for that (surface, persona) intersection.
 *
 * Used by the v0.9 phase 9.4 Persona Pool comparison page below the
 * `<PoolRadarChart>`. Same input shape (`PoolRadarEntry[]`) — the page can
 * compute it once and pass into both.
 *
 * Visual:
 *   - sticky first column (surface label) so wide pools stay readable
 *   - cell color tints by hit count: 0 = muted, 1-2 = amber, ≥3 = red
 *   - column header carries a small color dot matching the radar palette
 *     so the user can read row → which persona did poorly here
 *   - footer row totals each persona's `weightedHits` if provided
 *
 * No external deps — pure tailwind + react.
 */

import { SURFACE_LABEL, SURFACE_ORDER } from '@/lib/detection-lab.js';
import { cn } from '@/lib/utils.js';

import { POOL_COLORS, type PoolRadarEntry } from './PoolRadarChart.js';

interface PoolSurfaceTableProps {
  entries: PoolRadarEntry[];
  /** 可选：每个 persona 的 `weightedHits`，用于 footer 总计行（按 personaId 索引） */
  weightedByPersona?: Record<string, number>;
}

export function PoolSurfaceTable({ entries, weightedByPersona }: PoolSurfaceTableProps) {
  if (entries.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="sticky left-0 z-10 bg-muted/30 px-3 py-2 text-left font-medium">
              Surface
            </th>
            {entries.map((e, i) => {
              const color = POOL_COLORS[i % POOL_COLORS.length] ?? '#888';
              return (
                <th
                  key={e.personaId}
                  className="whitespace-nowrap px-3 py-2 text-left font-medium"
                  title={e.personaId}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{e.displayName}</span>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {SURFACE_ORDER.map((surface) => (
            <tr key={surface} className="border-t border-border/40">
              <td className="sticky left-0 z-10 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
                {SURFACE_LABEL[surface]}
              </td>
              {entries.map((e) => {
                const hits = e.hitsBySurface[surface] ?? 0;
                return (
                  <td
                    key={e.personaId}
                    className={cn('whitespace-nowrap px-3 py-1.5 font-mono text-xs', hitTone(hits))}
                  >
                    {hits === 0 ? <span className="text-muted-foreground/60">—</span> : hits}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {weightedByPersona && (
          <tfoot className="border-t-2 border-border bg-muted/20">
            <tr>
              <td className="sticky left-0 z-10 bg-muted/20 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                加权总分
              </td>
              {entries.map((e) => {
                const w = weightedByPersona[e.personaId] ?? 0;
                return (
                  <td
                    key={e.personaId}
                    className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold text-foreground"
                  >
                    {w.toFixed(1)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Cell color tint by hit count — keep thresholds in sync with v0.8 dashboard pills. */
function hitTone(hits: number): string {
  if (hits === 0) return '';
  if (hits <= 2) return 'bg-amber-500/10 text-amber-300';
  return 'bg-red-500/10 text-red-300';
}
