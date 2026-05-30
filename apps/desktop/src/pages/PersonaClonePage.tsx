/**
 * 克隆 persona：以现有 persona 为模板创建新身份。
 *
 * 设计：
 *   - 复用源 persona 的 OS / 浏览器 / 硬件 / 字体 / locale 基线
 *   - 强制重新生成所有 noise seed（在 SDK 内自动完成）
 *   - 用户必填：新 ID + 新显示名
 *   - 可改：tags / notes / timezone / proxy（默认沿用源）
 *
 * 用途：账号矩阵。同一个机器画像下养多个独立账号，cookie / IP / 指纹噪声完全独立。
 */

import { ArrowLeft, Copy, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import type { PersonaId } from '@runova/persona-schema';
import type { ClonePersonaInput } from '../../electron/ipc-types.js';
import { ProxyFieldset, type ProxyProtocol } from '../components/ProxyFieldset.js';
import { useToast } from '../components/Toast.js';

interface PersonaClonePageProps {
  sourceId: PersonaId;
  onDone: () => void;
  onCancel: () => void;
}

const TIMEZONES = [
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'America/Denver',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
];

export function PersonaClonePage({ sourceId, onDone, onCancel }: PersonaClonePageProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 源 persona 信息（只读展示）
  const [sourceDisplayName, setSourceDisplayName] = useState('');
  const [sourceOs, setSourceOs] = useState('');
  const [sourceBrowser, setSourceBrowser] = useState('');

  // 必填：新身份
  const [newId, setNewId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');

  // 可改字段（预填源值）
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');

  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyProtocol, setProxyProtocol] = useState<ProxyProtocol>('http');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState('');
  const [proxyUser, setProxyUser] = useState('');
  const [proxyPass, setProxyPass] = useState('');
  const [proxyLabel, setProxyLabel] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const newIdValid = /^[a-z][a-z0-9-]{2,63}$/.test(newId);

  // 加载源 persona 并预填表单
  useEffect(() => {
    void (async () => {
      try {
        const source = await window.mosaiq.getPersona(sourceId);
        setSourceDisplayName(source.metadata.displayName);
        setSourceOs(`${source.system.os.family} ${source.system.os.version}`);
        setSourceBrowser(`${source.browser.brand} ${source.browser.majorVersion}`);

        // 预填可改字段
        setTags(source.metadata.tags.join(', '));
        setNotes(source.metadata.notes);
        setTimezone(source.system.timezone);

        // 默认建议的新名字：在源后追加 -2（用户可改）
        setNewDisplayName(`${source.metadata.displayName} 副本`);

        if (source.network.proxy) {
          setProxyEnabled(true);
          setProxyProtocol(source.network.proxy.protocol);
          setProxyHost(source.network.proxy.host);
          setProxyPort(String(source.network.proxy.port));
          setProxyUser(source.network.proxy.username ?? '');
          setProxyPass(source.network.proxy.password ?? '');
          setProxyLabel(source.network.proxy.label ?? '');
        }
      } catch (err) {
        setLoadError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [sourceId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIdValid || !newDisplayName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const input: ClonePersonaInput = {
        newId,
        newDisplayName: newDisplayName.trim(),
        newTags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        newNotes: notes,
        newTimezone: timezone,
      };

      if (proxyEnabled && proxyHost.trim() && proxyPort.trim()) {
        input.newProxy = {
          protocol: proxyProtocol,
          host: proxyHost.trim(),
          port: Number.parseInt(proxyPort, 10),
          username: proxyUser.trim() || undefined,
          password: proxyPass || undefined,
          label: proxyLabel.trim() || undefined,
        };
      } else {
        // 用户取消代理勾选 → 显式 null 表示「不带代理」
        input.newProxy = null;
      }

      await window.mosaiq.clonePersona(sourceId, input);
      toast.success(`已克隆 ${newDisplayName.trim()}（指纹种子已重新生成）`);
      onDone();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(`克隆失败：${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载源 Persona…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" onClick={onCancel}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold">加载失败</h1>
        </div>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon" onClick={onCancel}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Copy className="h-6 w-6" />
            克隆 Persona
          </h1>
          <p className="text-sm text-muted-foreground">
            复用源的硬件画像，但生成全新指纹种子。Cookie / IP / Canvas / WebGL 完全独立。
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>源 Persona（基线复制源）</CardTitle>
          <CardDescription>
            OS / 浏览器 / 硬件画像会原样复制；指纹噪声 seed 会重新生成
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">源 ID</Label>
            <div className="font-mono text-sm">{sourceId}</div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">源显示名</Label>
            <div className="text-sm">{sourceDisplayName}</div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">画像</Label>
            <div className="text-sm">
              {sourceOs} · {sourceBrowser}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>新 Persona 的身份</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="newId">新 Persona ID</Label>
            <Input
              id="newId"
              placeholder="reddit-alice-2"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              className="font-mono"
            />
            <div className="text-xs text-muted-foreground">
              kebab-case，3-64 字符，字母开头。必须不与现有 persona 冲突。
              {newId && !newIdValid && (
                <Badge variant="destructive" className="ml-2">
                  格式不符
                </Badge>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="newDisplayName">新显示名</Label>
            <Input
              id="newDisplayName"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>沿用与覆盖</CardTitle>
          <CardDescription>下面字段默认沿用源的值，按需修改</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tags">标签（逗号分隔）</Label>
            <Input
              id="tags"
              placeholder="reddit, us, warming"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">时区</Label>
            <select
              id="timezone"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
              {!TIMEZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="notes">备注</Label>
            <Input
              id="notes"
              placeholder="这个号用于 r/programming 回帖"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            代理
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-normal">
              <input
                type="checkbox"
                checked={proxyEnabled}
                onChange={(e) => setProxyEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              启用
            </label>
          </CardTitle>
          <CardDescription>
            <strong>多 persona 同 IP 是反检测头号忌讳</strong>。强烈建议用住宅代理 sticky session
            为每个克隆出的 persona 分配不同 username（旋转 session ID）。
          </CardDescription>
        </CardHeader>
        <ProxyFieldset
          enabled={proxyEnabled}
          protocol={proxyProtocol}
          onProtocolChange={setProxyProtocol}
          host={proxyHost}
          onHostChange={setProxyHost}
          port={proxyPort}
          onPortChange={setProxyPort}
          username={proxyUser}
          onUsernameChange={setProxyUser}
          password={proxyPass}
          onPasswordChange={setProxyPass}
          label={proxyLabel}
          onLabelChange={setProxyLabel}
          currentTimezone={timezone}
          onApplyTimezone={setTimezone}
        />
      </Card>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button type="submit" disabled={!newIdValid || !newDisplayName.trim() || submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          创建克隆
        </Button>
      </div>
    </form>
  );
}
