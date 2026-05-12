import { ArrowLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import type { CreatePersonaInput } from '../../electron/ipc-types.js';
import { ProxyFieldset, type ProxyProtocol } from '../components/ProxyFieldset.js';
import { useToast } from '../components/Toast.js';

interface PersonaCreatePageProps {
  onDone: () => void;
  onCancel: () => void;
}

const TEMPLATES = [
  {
    id: 'win11-chrome-us' as const,
    name: 'Windows 11 + Chrome 130 (US)',
    description: 'Reddit 用户最常见配置：Win11 23H2 / 1920×1080 / 8 核 / 8GB',
    defaultTimezone: 'America/New_York',
  },
  {
    id: 'win10-chrome-us' as const,
    name: 'Windows 10 22H2 + Chrome 130 (US)',
    description: '企业 / 老 PC 用户：Win10 22H2 / 1920×1080 / 4 核 / 8GB',
    defaultTimezone: 'America/New_York',
  },
  {
    id: 'macos-sonoma-chrome-us' as const,
    name: 'macOS Sonoma + Chrome 130 (US)',
    description: 'Apple M2 / 14.6 / 1470×956 retina / Reddit Mac 用户',
    defaultTimezone: 'America/Los_Angeles',
  },
  {
    id: 'ubuntu-2204-chrome-us' as const,
    name: 'Ubuntu 22.04 + Chrome 130 (US)',
    description: '开发者画像：Ubuntu LTS / Mesa Intel / 仅适合 HN / GitHub 等技术站',
    defaultTimezone: 'America/New_York',
  },
];

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

export function PersonaCreatePage({ onDone, onCancel }: PersonaCreatePageProps) {
  const toast = useToast();
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]['id']>('win11-chrome-us');
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tags, setTags] = useState('reddit, us');
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

  const idValid = /^[a-z][a-z0-9-]{2,63}$/.test(id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idValid || !displayName) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreatePersonaInput = {
        template,
        id,
        displayName,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes,
        timezone,
      };
      if (proxyEnabled && proxyHost && proxyPort) {
        payload.proxy = {
          protocol: proxyProtocol,
          host: proxyHost,
          port: Number.parseInt(proxyPort, 10),
          username: proxyUser || undefined,
          password: proxyPass || undefined,
          label: proxyLabel || undefined,
        };
      }
      await window.mosaiq.createPersona(payload);
      toast.success(`已创建 ${displayName}`);
      onDone();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(`创建失败：${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon" onClick={onCancel}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">新建 Persona</h1>
          <p className="text-sm text-muted-foreground">选择模板、填写标识、可选配置代理</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. 选择设备模板</CardTitle>
          <CardDescription>Persona 指纹基于真实设备统计，避免「过于独特」被标记</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => {
                setTemplate(t.id);
                setTimezone(t.defaultTimezone);
              }}
              className={`rounded-lg border p-4 text-left transition-colors ${
                template === t.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              <div className="font-medium">{t.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.description}</div>
            </button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. 基础信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="id">Persona ID</Label>
            <Input
              id="id"
              placeholder="reddit-alice"
              value={id}
              onChange={(e) => setId(e.target.value)}
              className="font-mono"
            />
            <div className="text-xs text-muted-foreground">
              kebab-case，3-64 字符，字母开头（如 <code>reddit-alice</code>、
              <code>us-shopping-02</code>）
              {id && !idValid && (
                <Badge variant="destructive" className="ml-2">
                  格式不符
                </Badge>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="displayName">显示名</Label>
            <Input
              id="displayName"
              placeholder="Reddit Alice"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
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
            3. 代理（可选，但强烈推荐）
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
            多 persona 共用同一 IP = Reddit 封号头号险因。住宅代理推荐 IPRoyal / Smartproxy。
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
        <Button type="submit" disabled={!idValid || !displayName || submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          创建 Persona
        </Button>
      </div>
    </form>
  );
}
