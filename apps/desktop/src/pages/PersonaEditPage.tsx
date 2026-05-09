/**
 * 编辑已存在的 persona。仅允许修改不会破坏指纹一致性的字段：
 * displayName / tags / notes / timezone / proxy。
 *
 * 不允许修改：id、模板、所有硬件指纹字段。想改这些请走克隆 + 新建流程，
 * 保留旧 persona 的 cookie / 养号状态。
 */

import { ArrowLeft, Loader2, AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ProxyFieldset, type ProxyProtocol } from '../components/ProxyFieldset.js';
import { useToast } from '../components/Toast.js';
import type { PersonaId } from '@mosaiq/persona-schema';
import type { UpdatePersonaInput } from '../../electron/ipc-types.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';

interface PersonaEditPageProps {
  personaId: PersonaId;
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

export function PersonaEditPage({ personaId, onDone, onCancel }: PersonaEditPageProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 只读字段（仅展示）
  const [os, setOs] = useState('');
  const [browser, setBrowser] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  // 可编辑字段
  const [displayName, setDisplayName] = useState('');
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

  // 加载 persona
  useEffect(() => {
    void (async () => {
      try {
        const persona = await window.mosaiq.getPersona(personaId);
        setOs(`${persona.system.os.family} ${persona.system.os.version}`);
        setBrowser(`${persona.browser.brand} ${persona.browser.majorVersion}`);
        setDisplayName(persona.metadata.displayName);
        setTags(persona.metadata.tags.join(', '));
        setNotes(persona.metadata.notes);
        setTimezone(persona.system.timezone);

        if (persona.network.proxy) {
          setProxyEnabled(true);
          setProxyProtocol(persona.network.proxy.protocol);
          setProxyHost(persona.network.proxy.host);
          setProxyPort(String(persona.network.proxy.port));
          setProxyUser(persona.network.proxy.username ?? '');
          setProxyPass(persona.network.proxy.password ?? '');
          setProxyLabel(persona.network.proxy.label ?? '');
        }

        // 检查 isRunning（用于 UI 提示）
        const running = await window.mosaiq.getRunningPersonas();
        setIsRunning(running.includes(personaId));
      } catch (err) {
        setLoadError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [personaId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const patch: UpdatePersonaInput = {
        displayName: displayName.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes,
        timezone,
      };

      if (proxyEnabled && proxyHost.trim() && proxyPort.trim()) {
        patch.proxy = {
          protocol: proxyProtocol,
          host: proxyHost.trim(),
          port: Number.parseInt(proxyPort, 10),
          username: proxyUser.trim() || undefined,
          password: proxyPass || undefined,
          label: proxyLabel.trim() || undefined,
        };
      } else {
        // 用户取消代理 → 显式 null 让后端移除
        patch.proxy = null;
      }

      await window.mosaiq.updatePersona(personaId, patch);
      toast.success(
        isRunning
          ? `已保存 ${displayName.trim()}（重启浏览器后生效）`
          : `已保存 ${displayName.trim()}`,
      );
      onDone();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(`保存失败：${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载 Persona…
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
          <h1 className="text-2xl font-bold">编辑 Persona</h1>
          <p className="text-sm text-muted-foreground">
            可改时区 / 备注 / 代理。硬件指纹与浏览器版本不可改（要改请克隆新建）。
          </p>
        </div>
      </div>

      {isRunning && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <div className="font-medium">这个 Persona 正在运行</div>
            <div className="mt-0.5 text-xs">
              修改会保存到磁盘，但已打开的浏览器仍用旧配置。新值会在下次启动时生效。
            </div>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>身份（不可改）</CardTitle>
          <CardDescription>这些字段决定 persona 的指纹一致性，改了等于换 persona</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Persona ID</Label>
            <div className="font-mono text-sm">{personaId}</div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">操作系统</Label>
            <div className="text-sm">{os}</div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">浏览器</Label>
            <div className="text-sm">{browser}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>基础信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="displayName">显示名</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            {!displayName.trim() && (
              <Badge variant="destructive" className="ml-2">
                显示名不能为空
              </Badge>
            )}
          </div>
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
              {/* 如果当前时区不在预设列表里（如手工编辑过 JSON），仍显示出来 */}
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
          <CardDescription>取消勾选并保存即移除代理；改字段即换代理（cookie 不会丢）</CardDescription>
        </CardHeader>
        <ProxyFieldset
          enabled={proxyEnabled}
          onEnabledChange={setProxyEnabled}
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
        <Button type="submit" disabled={!displayName.trim() || submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          保存修改
        </Button>
      </div>
    </form>
  );
}
