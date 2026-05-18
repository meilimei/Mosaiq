/**
 * 单条 SurfaceHit 徽标 — surface 色块（左）+ severity 点（中）+ detector 文字（右）。
 *
 * 用于：
 *   - DetectionRunDetailPage 的 hits 列表（每行一个 badge + evidence）
 *   - SiteResultCard 的 per-site hits chip 区（紧凑模式）
 *
 * 设计：
 *   - compact 模式：只显示 surface 字符 + severity 圆点，宽度 ~80px
 *   - 默认模式：surface label + severity 点 + detector，宽度 ~200px
 *   - 不嵌入 evidence（太长，放外层）
 */

import {
  SEVERITY_DOT_CLASS,
  SEVERITY_LABEL,
  SURFACE_BADGE_CLASS,
  SURFACE_LABEL,
} from '@/lib/detection-lab.js';
import { cn } from '@/lib/utils.js';
import type { SurfaceHit } from '@mosaiq/sdk';

interface SurfaceHitBadgeProps {
  hit: SurfaceHit;
  compact?: boolean;
  className?: string;
}

export function SurfaceHitBadge({ hit, compact = false, className }: SurfaceHitBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
        SURFACE_BADGE_CLASS[hit.surface],
        className,
      )}
      title={`${SURFACE_LABEL[hit.surface]} · ${hit.detector} · ${SEVERITY_LABEL[hit.severity]}危`}
    >
      <span className="font-semibold">{SURFACE_LABEL[hit.surface]}</span>
      <span className={cn('leading-none', SEVERITY_DOT_CLASS[hit.severity])}>●</span>
      {!compact && (
        <span className="truncate max-w-[12rem] text-foreground/80">{hit.detector}</span>
      )}
    </span>
  );
}
