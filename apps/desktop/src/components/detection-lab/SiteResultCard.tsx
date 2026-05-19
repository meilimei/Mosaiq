/**
 * 单站 SiteResult 卡片 — detail 页 12 站 grid 的单元。
 *
 * 展示：
 *   - 顶部 chip 行：站点 name + OK/FAIL badge + durationMs + retries（如有）
 *   - title（如有）
 *   - 该站触发的 hits 徽标（compact）
 *   - 截图缩略图（v0.9 phase 9.3：`mosaiq-artifact://` 协议加载，需要
 *     `personaId` + `runId` props，仅当 `site.ok && site.screenshot` 时渲染）
 *   - 可折叠的 extracted KV 表
 *   - 失败时显示 error message
 */

import { ChevronDown, ChevronRight, ImageOff, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge.js';
import { buildArtifactUrl } from '@/lib/artifact-url.js';
import { formatMs } from '@/lib/detection-lab.js';
import { cn } from '@/lib/utils.js';
import type { PersonaId } from '@mosaiq/persona-schema';
import type { SiteResult, SurfaceHit } from '@mosaiq/sdk';

import { SurfaceHitBadge } from './SurfaceHitBadge.js';

interface SiteResultCardProps {
  site: SiteResult;
  /** 该站对应的 SurfaceHit[]（由 detail 页按 site id 分组后传入） */
  hits: SurfaceHit[];
  /** 是否正在跑（live progress 用） */
  running?: boolean;
  /** v0.9 phase 9.3: 为缩略图构造 `mosaiq-artifact://` URL。不传则不渲染缩略图。 */
  personaId?: PersonaId;
  runId?: string;
}

export function SiteResultCard({
  site,
  hits,
  running = false,
  personaId,
  runId,
}: SiteResultCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const extractedEntries = site.extracted ? Object.entries(site.extracted) : [];
  const hasExtracted = extractedEntries.length > 0;

  // 缩略图渲染条件：run 成功、该站 ok、有 screenshot 路径、且上下文传了
  // personaId + runId。live `running` 状态下不渲染（文件可能还没落盘）。
  const showThumbnail =
    !running && site.ok && !!site.screenshot && !!personaId && !!runId && !thumbFailed;
  const thumbnailUrl = showThumbnail
    ? buildArtifactUrl(personaId, runId, site.screenshot ?? '')
    : null;

  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-3 text-card-foreground transition-colors',
        site.ok ? 'border-border' : 'border-destructive/40',
        running && 'border-blue-500/40',
      )}
    >
      {/* 顶部 status row */}
      <div className="flex items-center gap-2">
        {running ? (
          <Badge className="border-blue-500/30 bg-blue-500/10 text-blue-400">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" /> 进行中
          </Badge>
        ) : site.ok ? (
          <Badge variant="success">OK</Badge>
        ) : (
          <Badge variant="destructive">FAIL</Badge>
        )}
        <span className="truncate text-sm font-medium">{site.name}</span>
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
          {formatMs(site.durationMs)}
          {site.retries && site.retries > 0 ? ` · 重试 ${site.retries}` : ''}
        </span>
      </div>

      {/* title */}
      {site.title && (
        <div className="mt-1 truncate text-xs text-muted-foreground" title={site.title}>
          {site.title}
        </div>
      )}

      {/* hits chips */}
      {hits.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {hits.map((h, i) => (
            <SurfaceHitBadge key={`${h.surface}-${h.detector}-${i}`} hit={h} compact />
          ))}
        </div>
      )}

      {/* screenshot thumbnail (v0.9 phase 9.3) */}
      {thumbnailUrl && (
        <a
          href={thumbnailUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block overflow-hidden rounded-md border border-border/60 bg-muted/30 transition-colors hover:border-border"
          title="点击查看全图"
        >
          <img
            src={thumbnailUrl}
            alt={`${site.name} 截图`}
            loading="lazy"
            decoding="async"
            className="h-28 w-full object-cover object-top"
            onError={() => setThumbFailed(true)}
          />
        </a>
      )}
      {!running && site.ok && site.screenshot && thumbFailed && (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
          <ImageOff className="h-3.5 w-3.5" />
          <span>缩略图加载失败</span>
        </div>
      )}

      {/* error */}
      {!site.ok && site.error && (
        <div className="mt-2 break-all rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {site.error}
        </div>
      )}

      {/* extracted toggle */}
      {hasExtracted && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          extracted ({extractedEntries.length})
        </button>
      )}
      {expanded && hasExtracted && (
        <div className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/30 p-2">
          <table className="w-full text-xs">
            <tbody>
              {extractedEntries.map(([k, v]) => (
                <tr key={k} className="border-b border-border/40 last:border-b-0">
                  <td className="whitespace-nowrap py-1 pr-2 font-mono text-muted-foreground">
                    {k}
                  </td>
                  <td className="break-all py-1 font-mono">{formatExtractedValue(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 显示 extracted 字段值：原始 string/number/boolean 直出；对象 JSON.stringify 紧凑形式 */
function formatExtractedValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s && s.length > 200 ? `${s.slice(0, 200)}…` : (s ?? String(v));
  } catch {
    return String(v);
  }
}
