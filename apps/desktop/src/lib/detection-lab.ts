/**
 * Detection Lab UI 共用纯辅助：颜色 / 标签 / 格式化。
 *
 * 设计原则：
 *   - SurfaceName / HitSeverity → Tailwind class fragment（不返回完整 className，
 *     交给调用方与 layout 组合）
 *   - SURFACE_COLOR_HEX 给 recharts 这种只接受真实 HEX 的库用
 *   - 所有标签中文化，统一术语口径（与 docs/V0.8-DETECTION-LAB.md 对齐）
 */

import type { DetectionRunSummary, HitSeverity, HitsBySurface, SurfaceName } from '@runova/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// Surface
// ─────────────────────────────────────────────────────────────────────────────

/** 雷达图 / 列表 / 徽标的展示顺序（与色板一一对应） */
export const SURFACE_ORDER: readonly SurfaceName[] = [
  'webdriver',
  'navigator',
  'canvas',
  'webgl',
  'audio',
  'font',
  'webrtc',
  'screen',
  'permissions',
  'timezone',
  'plugins',
  'other',
] as const;

/** Surface → 中文短标签（≤4 字符，雷达图轴 / 徽标用） */
export const SURFACE_LABEL: Record<SurfaceName, string> = {
  webdriver: 'WebDriver',
  navigator: 'Navigator',
  canvas: 'Canvas',
  webgl: 'WebGL',
  audio: 'Audio',
  font: '字体',
  webrtc: 'WebRTC',
  screen: '屏幕',
  permissions: '权限',
  timezone: '时区',
  plugins: '插件',
  other: '其它',
};

/**
 * Surface → Tailwind 色板 fragment（border / bg / text 三态）。
 *
 * 颜色选择避免与 destructive / success / primary 冲突，且高识别度。
 * webdriver / navigator 红黄色调（高危），canvas / webgl 紫蓝（最常 spoof），
 * audio / font / webrtc / screen 中性，permissions / timezone 暖色，
 * plugins / other 灰色。
 */
export const SURFACE_BADGE_CLASS: Record<SurfaceName, string> = {
  webdriver: 'border-red-500/30 bg-red-500/10 text-red-400',
  navigator: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  canvas: 'border-purple-500/30 bg-purple-500/10 text-purple-400',
  webgl: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  audio: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
  font: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  webrtc: 'border-pink-500/30 bg-pink-500/10 text-pink-400',
  screen: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-400',
  permissions: 'border-orange-500/30 bg-orange-500/10 text-orange-400',
  timezone: 'border-teal-500/30 bg-teal-500/10 text-teal-400',
  plugins: 'border-lime-500/30 bg-lime-500/10 text-lime-400',
  other: 'border-slate-500/30 bg-slate-500/10 text-slate-400',
};

/** Surface → recharts 用 HEX（与 SURFACE_BADGE_CLASS 颜色家族对齐） */
export const SURFACE_COLOR_HEX: Record<SurfaceName, string> = {
  webdriver: '#f87171', // red-400
  navigator: '#fbbf24', // amber-400
  canvas: '#c084fc', // purple-400
  webgl: '#60a5fa', // blue-400
  audio: '#22d3ee', // cyan-400
  font: '#34d399', // emerald-400
  webrtc: '#f472b6', // pink-400
  screen: '#818cf8', // indigo-400
  permissions: '#fb923c', // orange-400
  timezone: '#2dd4bf', // teal-400
  plugins: '#a3e635', // lime-400
  other: '#94a3b8', // slate-400
};

// ─────────────────────────────────────────────────────────────────────────────
// Severity
// ─────────────────────────────────────────────────────────────────────────────

export const SEVERITY_LABEL: Record<HitSeverity, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 严重度点（hit 列表前缀的 ●）的 Tailwind text-color */
export const SEVERITY_DOT_CLASS: Record<HitSeverity, string> = {
  high: 'text-red-500',
  medium: 'text-amber-400',
  low: 'text-slate-500',
};

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<DetectionRunSummary['status'], string> = {
  pending: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

/** Status → Badge 颜色 className（与 ui/badge.tsx 三态 success/secondary/destructive 风格保持一致） */
export const STATUS_BADGE_CLASS: Record<DetectionRunSummary['status'], string> = {
  pending: 'border-slate-500/30 bg-slate-500/10 text-slate-400',
  running: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  failed: 'border-red-500/30 bg-red-500/10 text-red-400',
  canceled: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
};

// ─────────────────────────────────────────────────────────────────────────────
// 格式化
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把毫秒数格式化为「Xm Ys」/「Y.Zs」/「Yms」。
 * 与 lib/utils.ts 的 formatDuration（ISO → 现在）不同：这里直接传 ms。
 */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

/**
 * 转换 HitsBySurface 为雷达图 data：[{ surface, label, hits, color }]。
 * 按 SURFACE_ORDER 排序确保各次 run 之间雷达图轴位置稳定。
 */
export function hitsBySurfaceToRadarData(hitsBySurface: HitsBySurface): Array<{
  surface: SurfaceName;
  label: string;
  hits: number;
}> {
  return SURFACE_ORDER.map((s) => ({
    surface: s,
    label: SURFACE_LABEL[s],
    hits: hitsBySurface[s] ?? 0,
  }));
}
