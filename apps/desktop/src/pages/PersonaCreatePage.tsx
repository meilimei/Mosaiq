import { ArrowLeft, CheckCircle2, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';

import type { CreatePersonaInput, ProxyVerifyResult } from '../../electron/ipc-types.js';
import { useToast } from '../components/Toast.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';

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
    id: 'macos-sonoma-chrome-us' as const,
    name: 'macOS Sonoma + Chrome 130 (US)',
    description: 'Apple M2 / 14.6 / 1470×956 retina / Reddit Mac 用户',
    defaultTimezone: 'America/Los_Angeles',
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
  const [proxyProtocol, setProxyProtocol] = useState<'http' | 'https' | 'socks5'>('http');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState('');
  const [proxyUser, setProxyUser] = useState('');
  const [proxyPass, setProxyPass] = useState('');
  const [proxyLabel, setProxyLabel] = useState('');

  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyResult, setProxyResult] = useState<ProxyVerifyResult | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idValid = /^[a-z][a-z0-9-]{2,63}$/.test(id);
  const proxyFormReady = proxyEnabled && proxyHost.trim() && proxyPort.trim();
  const timezoneMismatch =
    proxyResult?.ok &&
    proxyResult.detectedTimezone &&
    proxyResult.detectedTimezone !== timezone;

  const handleTestProxy = async () => {
    if (!proxyFormReady) return;
    setProxyTesting(true);
    setProxyResult(null);
    const res = await window.mosaiq.verifyProxy({
      protocol: proxyProtocol,
      host: proxyHost.trim(),
      port: Number.parseInt(proxyPort, 10),
      username: proxyUser.trim() || undefined,
      password: proxyPass || undefined,
    });
    setProxyResult(res);
    setProxyTesting(false);
  };

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
              {id && !idValid && <Badge variant="destructive" className="ml-2">格式不符</Badge>}
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
        {proxyEnabled && (
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="proxyProtocol">协议</Label>
              <select
                id="proxyProtocol"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={proxyProtocol}
                onChange={(e) =>
                  setProxyProtocol(e.target.value as 'http' | 'https' | 'socks5')
                }
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxyLabel">标签</Label>
              <Input
                id="proxyLabel"
                placeholder="iproyal-us-sticky"
                value={proxyLabel}
                onChange={(e) => setProxyLabel(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxyHost">主机</Label>
              <Input
                id="proxyHost"
                placeholder="residential.iproyal.com"
                value={proxyHost}
                onChange={(e) => setProxyHost(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxyPort">端口</Label>
              <Input
                id="proxyPort"
                type="number"
                placeholder="12321"
                value={proxyPort}
                onChange={(e) => setProxyPort(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxyUser">用户名</Label>
              <Input
                id="proxyUser"
                placeholder="user-session-abc123"
                value={proxyUser}
                onChange={(e) => setProxyUser(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxyPass">密码</Label>
              <Input
                id="proxyPass"
                type="password"
                value={proxyPass}
                onChange={(e) => setProxyPass(e.target.value)}
              />
            </div>

            <div className="md:col-span-2 space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">代理预检</div>
                  <div className="text-xs text-muted-foreground">
                    通过代理拉一次 ipinfo.io，确认凭据可用并显示出口 IP / 国家 / 时区
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleTestProxy}
                  disabled={!proxyFormReady || proxyTesting}
                >
                  {proxyTesting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      测试中…
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      测试代理
                    </>
                  )}
                </Button>
              </div>

              {proxyResult?.ok && (
                <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-green-400">
                    <CheckCircle2 className="h-4 w-4" />
                    代理可用 · {proxyResult.latencyMs} ms
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <div className="flex gap-2">
                      <dt className="font-medium">出口 IP：</dt>
                      <dd className="font-mono">{proxyResult.exitIp}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-medium">国家：</dt>
                      <dd>
                        {proxyResult.country}
                        {proxyResult.region ? ` / ${proxyResult.region}` : ''}
                        {proxyResult.city ? ` / ${proxyResult.city}` : ''}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-medium">时区：</dt>
                      <dd className="font-mono">{proxyResult.detectedTimezone ?? '未返回'}</dd>
                    </div>
                    {proxyResult.org && (
                      <div className="col-span-2 flex gap-2">
                        <dt className="font-medium">ISP：</dt>
                        <dd className="truncate">{proxyResult.org}</dd>
                      </div>
                    )}
                  </dl>

                  {timezoneMismatch && (
                    <div className="mt-3 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="font-medium">时区不一致警告</div>
                        <div className="mt-0.5">
                          代理出口时区是 <span className="font-mono">{proxyResult.detectedTimezone}</span>，
                          但你当前 Persona 设的是 <span className="font-mono">{timezone}</span>。
                          BrowserScan / pixelscan 会把两者不匹配标红。
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2 h-7 text-xs"
                          onClick={() => setTimezone(proxyResult.detectedTimezone ?? timezone)}
                        >
                          一键应用 {proxyResult.detectedTimezone}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {proxyResult && !proxyResult.ok && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <div className="flex items-center gap-2 font-medium">
                    <XCircle className="h-4 w-4" />
                    代理不可用 · {proxyResult.latencyMs} ms
                  </div>
                  <div className="mt-1 text-xs">{proxyResult.error}</div>
                </div>
              )}
            </div>
          </CardContent>
        )}
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
