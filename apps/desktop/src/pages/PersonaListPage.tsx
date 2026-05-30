import {
  Activity,
  BarChart3,
  Check,
  Copy,
  Download,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { formatDate, formatDuration } from '@/lib/utils.js';
import type { PersonaId } from '@runova/persona-schema';
import type { PersonaSummary } from '../../electron/ipc-types.js';
import { useToast } from '../components/Toast.js';

interface PersonaListPageProps {
  onCreate: () => void;
  onEdit: (id: PersonaId) => void;
  onClone: (id: PersonaId) => void;
  /** 跳转到 Detection Lab 页（detection run 历史 + 启动新 run）。displayName 用作页头副标题 */
  onDetectionLab: (id: PersonaId, displayName: string) => void;
  /** v0.9 phase 9.4: 跳转到多-persona 对比池页面 */
  onPersonaPool: () => void;
}

/** 删除二次确认 5 秒后自动取消，避免误点 */
const DELETE_CONFIRM_TIMEOUT_MS = 5000;
/** 列表轮询间隔。短了浪费 IPC，长了运行中 persona 状态延迟可见 */
const POLL_INTERVAL_MS = 3000;

export function PersonaListPage({
  onCreate,
  onEdit,
  onClone,
  onDetectionLab,
  onPersonaPool,
}: PersonaListPageProps) {
  const toast = useToast();
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  /** 当前正在执行 IPC 操作的 persona id（启动/停止/自检中），用于显示 spinner */
  const [busy, setBusy] = useState<PersonaId | null>(null);
  /** 错误信息按 persona id 归属，inline 显示在对应卡片下方 */
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 处于「等待二次确认」状态的删除目标 */
  const [confirmingDelete, setConfirmingDelete] = useState<PersonaId | null>(null);
  /** 上次刷新时间，给「刷新于 X 前」标签用 */
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(Date.now());
  /** 每秒强制 re-render 的 tick，让运行时长 / 刷新时间显示实时变化 */
  const [, setTick] = useState(0);

  // ── 搜索 / 筛选 ─────────────────────────────────────────────────────────
  /** 搜索词：在 displayName / id / notes / proxyLabel / tags 上做 substring 匹配 */
  const [searchQuery, setSearchQuery] = useState('');
  /** 已选中的标签集合。多选 = AND（persona 必须含全部选中的标签才显示） */
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  /** 5s 自动取消二次确认的 timer 引用，避免泄漏 */
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const list = await window.mosaiq.listPersonas();
    setPersonas(list);
    setLastRefreshAt(Date.now());
    setLoading(false);
  }, []);

  // 初次加载 + 周期轮询
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // 1s tick：让「已运行 Xm」/ 「刷新于 Xs 前」实时变化
  // 仅当有运行中 persona 或最近刷新过时启用，避免空闲 idle 时浪费渲染
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // 卸载时清理二次确认 timer
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const setErrorFor = (id: PersonaId, msg: string | null) => {
    setErrors((prev) => {
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });
  };

  const handleLaunch = async (id: PersonaId) => {
    setBusy(id);
    setErrorFor(id, null);
    const res = await window.mosaiq.launchPersona(id);
    setBusy(null);
    if (!res.ok) {
      setErrorFor(id, res.error);
      toast.error(`启动失败：${res.error}`);
    }
    await refresh();
  };

  const handleStop = async (id: PersonaId) => {
    setBusy(id);
    setErrorFor(id, null);
    await window.mosaiq.stopPersona(id);
    setBusy(null);
    await refresh();
    toast.info(`已停止 ${id}`);
  };

  /**
   * 跳转到 Detection Lab：纯 renderer 路由切换，不走 IPC。
   *
   * v0.8 之前 `openDetectionLab` IPC 会在已启动 persona 浏览器里打开两个反检测站，
   * v0.8 起 Detection Lab 是独立功能（与 launch 解耦），所以这里直接 setPage。
   * 旧 `window.mosaiq.openDetectionLab` channel 暂保留兼容（main.ts 未删），但 UI
   * 不再调用——deprecate 在 8.7。
   */
  const handleDetectionLab = (id: PersonaId, displayName: string) => {
    onDetectionLab(id, displayName);
  };

  /**
   * 导出单个 persona 为 JSON 文件。默认脱敏代理密码 (stripSecrets:true)，
   * 防止不小心把凭据发到 IM / git 。高级用户可手动编辑 JSON 补回。
   */
  const handleExport = async (id: PersonaId) => {
    setBusy(id);
    setErrorFor(id, null);
    try {
      const res = await window.mosaiq.exportPersona(id, { stripSecrets: true });
      if (res.ok) {
        toast.success(`已导出 → ${res.savedTo}`);
      } else if ('canceled' in res && res.canceled) {
        // 静默，用户取消不是错误
      } else if ('error' in res) {
        setErrorFor(id, res.error);
        toast.error(`导出失败：${res.error}`);
      }
    } finally {
      setBusy(null);
    }
  };

  /**
   * 从 JSON 文件导入 persona。后端默认 onConflict='rename'，
   * 冲突时自动走 `<id>-imported` / `<id>-imported-2`，永远不会覆盖现有 persona。
   */
  const handleImport = async () => {
    try {
      const res = await window.mosaiq.importPersona();
      if (res.ok) {
        await refresh();
        if (res.renamedFrom && res.renamedFrom !== res.persona.id) {
          toast.success(
            `导入成功（原 ID 「${res.renamedFrom}」冲突，已重命名为「${res.persona.id}」）`,
          );
        } else {
          toast.success(`已导入 ${res.persona.id}`);
        }
      } else if ('canceled' in res && res.canceled) {
        // 静默
      } else if ('error' in res) {
        toast.error(`导入失败：${res.error}`);
      }
    } catch (err) {
      toast.error(`导入失败：${(err as Error).message}`);
    }
  };

  /**
   * 双击删除流程：
   *   1. 第一次点 → 进入 confirming 状态（按钮变红 + 显示「确认删除？」），5s 自动取消
   *   2. 在 confirming 状态点 → 真删
   * 比 native confirm() 体验好得多（不阻塞、可取消、视觉一致）
   */
  const handleDeleteClick = async (id: PersonaId) => {
    if (confirmingDelete === id) {
      // 第二次点：真删
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
      setConfirmingDelete(null);
      setBusy(id);
      try {
        await window.mosaiq.deletePersona(id);
        await refresh();
        toast.success(`已删除 ${id}`);
      } catch (err) {
        const msg = (err as Error).message;
        setErrorFor(id, msg);
        toast.error(`删除失败：${msg}`);
      } finally {
        setBusy(null);
      }
      return;
    }
    // 第一次点：进入 confirming，5s 后自动取消
    setConfirmingDelete(id);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmingDelete(null);
      confirmTimerRef.current = null;
    }, DELETE_CONFIRM_TIMEOUT_MS);
  };

  const handleManualRefresh = async () => {
    await refresh();
  };

  const refreshSecondsAgo = Math.floor((Date.now() - lastRefreshAt) / 1000);

  // ── 派生：所有去重后的标签 + 当前过滤后的列表 ─────────────────────────────
  /**
   * 全集标签：取所有 persona 的 tags 并集，按字母排序，限制最多展示在 chip
   * 区域；仅作展示用，搜索时仍可用 `tag:foo` 风格直接命中（substring 也覆盖）。
   */
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of personas) {
      for (const t of p.tags) set.add(t);
    }
    return Array.from(set).sort();
  }, [personas]);

  /**
   * 经过 searchQuery（substring，case-insensitive，覆盖多字段）+ selectedTags（AND）筛选
   * 后剩下的 persona。注意保持原有顺序（store 来的就是 store 顺序）。
   */
  const filteredPersonas = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return personas.filter((p) => {
      // 标签 AND 过滤
      if (selectedTags.size > 0) {
        for (const t of selectedTags) {
          if (!p.tags.includes(t)) return false;
        }
      }
      // substring 搜索
      if (q.length === 0) return true;
      const haystack = [
        p.displayName,
        p.id,
        p.notes,
        p.proxyLabel ?? '',
        p.os,
        p.browser,
        ...p.tags,
      ]
        .join('\u0001')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [personas, searchQuery, selectedTags]);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedTags(new Set());
  };

  const hasActiveFilter = searchQuery.length > 0 || selectedTags.size > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Persona 列表</h1>
          <p className="text-sm text-muted-foreground">
            每个 Persona 代表一个独立的浏览器身份。Cookie、指纹、代理完全隔离。
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!loading && personas.length > 0 && (
            <span
              className="text-xs text-muted-foreground"
              title={new Date(lastRefreshAt).toLocaleString()}
            >
              刷新于 {refreshSecondsAgo}s 前
            </span>
          )}
          <Button variant="outline" size="icon" onClick={handleManualRefresh} title="立即刷新">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={onPersonaPool}
            title="并排对比 N 个 persona 的检测得分"
            disabled={loading || personas.length < 2}
          >
            <BarChart3 className="mr-2 h-4 w-4" /> 对比池
          </Button>
          <Button variant="outline" onClick={handleImport} title="从 JSON 导入 Persona">
            <Upload className="mr-2 h-4 w-4" /> 导入
          </Button>
          <Button onClick={onCreate}>
            <Plus className="mr-2 h-4 w-4" /> 新建 Persona
          </Button>
        </div>
      </div>

      {/* 搜索 / 标签筛选 toolbar：persona 数 ≥ 1 才显示，避免空态时干扰 */}
      {!loading && personas.length > 0 && (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="搜索 displayName / id / notes / 代理标签 / 标签…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title="清除搜索"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">标签：</span>
              {allTags.map((tag) => {
                const active = selectedTags.has(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`rounded-full border px-2 py-0.5 transition-colors ${
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-secondary text-secondary-foreground hover:bg-secondary/80'
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
              {hasActiveFilter && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-auto text-muted-foreground hover:text-foreground"
                >
                  清除筛选
                </button>
              )}
            </div>
          )}
          {hasActiveFilter && (
            <div className="text-xs text-muted-foreground">
              {filteredPersonas.length} / {personas.length} 个 Persona
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : personas.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center space-y-3 py-16 text-center">
            <ShieldCheck className="h-12 w-12 text-muted-foreground" />
            <div className="text-lg font-medium">还没有 Persona</div>
            <div className="text-sm text-muted-foreground">
              点击「新建 Persona」创建你的第一个反检测浏览器身份
            </div>
            <Button onClick={onCreate} className="mt-2">
              <Plus className="mr-2 h-4 w-4" /> 创建第一个 Persona
            </Button>
          </CardContent>
        </Card>
      ) : filteredPersonas.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center space-y-3 py-12 text-center">
            <Search className="h-10 w-10 text-muted-foreground" />
            <div className="text-base font-medium">没有匹配的 Persona</div>
            <div className="text-xs text-muted-foreground">
              当前筛选：
              {searchQuery && <span className="ml-1 font-mono">「{searchQuery}」</span>}
              {selectedTags.size > 0 && (
                <span className="ml-1">标签 {Array.from(selectedTags).join(', ')}</span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              清除筛选
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredPersonas.map((p) => {
            const isBusy = busy === p.id;
            const isConfirming = confirmingDelete === p.id;
            const errMsg = errors[p.id];
            return (
              <Card key={p.id}>
                <CardHeader className="flex-row items-start justify-between space-y-0">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2">
                      {p.displayName}
                      {p.isRunning && (
                        <Badge variant="success" className="ml-2">
                          <Activity className="mr-1 h-3 w-3" /> 运行中
                          {p.lastLaunchedAt && (
                            <span className="ml-1 font-mono opacity-80">
                              · {formatDuration(p.lastLaunchedAt)}
                            </span>
                          )}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-3 text-xs">
                      <span className="font-mono">{p.id}</span>
                      <span>·</span>
                      <span>{p.os}</span>
                      <span>·</span>
                      <span>{p.browser}</span>
                      {p.proxyLabel && (
                        <>
                          <span>·</span>
                          <span className="font-mono">🌐 {p.proxyLabel}</span>
                        </>
                      )}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    {/* Detection Lab 始终可见（与 launch 解耦） */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDetectionLab(p.id, p.displayName)}
                      title="打开 Detection Lab（启动反检测体检 + 历史 run）"
                    >
                      <ShieldCheck className="mr-1 h-4 w-4" /> Detection Lab
                    </Button>
                    {p.isRunning ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleStop(p.id)}
                        disabled={isBusy}
                      >
                        {isBusy ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <Square className="mr-1 h-4 w-4" />
                        )}
                        停止
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => handleLaunch(p.id)} disabled={isBusy}>
                        {isBusy ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="mr-1 h-4 w-4" />
                        )}
                        启动
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onEdit(p.id)}
                      disabled={isBusy}
                      title="编辑 Persona"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onClone(p.id)}
                      disabled={isBusy}
                      title="克隆 Persona（复用画像，独立指纹种子）"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleExport(p.id)}
                      disabled={isBusy}
                      title="导出为 JSON（默认脱敏代理密码）"
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    {/* 内联二次确认替代 native confirm()：第一次点变红 + 文字「确认？」，5s 自动取消 */}
                    {isConfirming ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteClick(p.id)}
                        disabled={isBusy || p.isRunning}
                      >
                        <Check className="mr-1 h-4 w-4" />
                        确认删除？
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteClick(p.id)}
                        disabled={isBusy || p.isRunning}
                        title={
                          p.isRunning
                            ? '请先停止运行中的 Persona 再删除'
                            : '删除 Persona（cookies 和本地数据将一并消除）'
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <div>
                      <span className="font-medium">启动次数：</span>
                      {p.launchCount}
                    </div>
                    <div>
                      <span className="font-medium">上次启动：</span>
                      {formatDate(p.lastLaunchedAt)}
                    </div>
                    {p.tags.length > 0 && (
                      <div className="flex gap-1">
                        {p.tags.map((t) => (
                          <Badge key={t} variant="secondary">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  {errMsg && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      <span className="font-medium">操作失败：</span>
                      {errMsg}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
