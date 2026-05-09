/**
 * 代理配置表单 + 一键预检面板。
 *
 * 在 PersonaCreatePage / PersonaEditPage 共用。state 由父组件持有
 * （受控组件模式），本组件只负责 UI 与调用 window.mosaiq.verifyProxy。
 */

import { CheckCircle2, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';

import type { ProxyVerifyResult } from '../../electron/ipc-types.js';
import { Button } from '@/components/ui/button.js';
import { CardContent } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';

export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyFieldsetProps {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;

  protocol: ProxyProtocol;
  onProtocolChange: (v: ProxyProtocol) => void;

  host: string;
  onHostChange: (v: string) => void;

  /** 端口存为 string 以便受控 input；提交时再转 number */
  port: string;
  onPortChange: (v: string) => void;

  username: string;
  onUsernameChange: (v: string) => void;

  password: string;
  onPasswordChange: (v: string) => void;

  label: string;
  onLabelChange: (v: string) => void;

  /** 用于 timezone mismatch 警告 + 一键应用按钮 */
  currentTimezone: string;
  onApplyTimezone: (tz: string) => void;
}

export function ProxyFieldset(props: ProxyFieldsetProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProxyVerifyResult | null>(null);

  const formReady = props.enabled && props.host.trim() && props.port.trim();

  const timezoneMismatch =
    result?.ok &&
    result.detectedTimezone &&
    result.detectedTimezone !== props.currentTimezone;

  const handleTest = async () => {
    if (!formReady) return;
    setTesting(true);
    setResult(null);
    const res = await window.mosaiq.verifyProxy({
      protocol: props.protocol,
      host: props.host.trim(),
      port: Number.parseInt(props.port, 10),
      username: props.username.trim() || undefined,
      password: props.password || undefined,
    });
    setResult(res);
    setTesting(false);
  };

  if (!props.enabled) return null;

  return (
    <CardContent className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="proxyProtocol">协议</Label>
        <select
          id="proxyProtocol"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          value={props.protocol}
          onChange={(e) => props.onProtocolChange(e.target.value as ProxyProtocol)}
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
          value={props.label}
          onChange={(e) => props.onLabelChange(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="proxyHost">主机</Label>
        <Input
          id="proxyHost"
          placeholder="residential.iproyal.com"
          value={props.host}
          onChange={(e) => props.onHostChange(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="proxyPort">端口</Label>
        <Input
          id="proxyPort"
          type="number"
          placeholder="12321"
          value={props.port}
          onChange={(e) => props.onPortChange(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="proxyUser">用户名</Label>
        <Input
          id="proxyUser"
          placeholder="user-session-abc123"
          value={props.username}
          onChange={(e) => props.onUsernameChange(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="proxyPass">密码</Label>
        <Input
          id="proxyPass"
          type="password"
          value={props.password}
          onChange={(e) => props.onPasswordChange(e.target.value)}
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
            onClick={handleTest}
            disabled={!formReady || testing}
          >
            {testing ? (
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

        {result?.ok && (
          <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              代理可用 · {result.latencyMs} ms
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <div className="flex gap-2">
                <dt className="font-medium">出口 IP：</dt>
                <dd className="font-mono">{result.exitIp}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium">国家：</dt>
                <dd>
                  {result.country}
                  {result.region ? ` / ${result.region}` : ''}
                  {result.city ? ` / ${result.city}` : ''}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium">时区：</dt>
                <dd className="font-mono">{result.detectedTimezone ?? '未返回'}</dd>
              </div>
              {result.org && (
                <div className="col-span-2 flex gap-2">
                  <dt className="font-medium">ISP：</dt>
                  <dd className="truncate">{result.org}</dd>
                </div>
              )}
            </dl>

            {timezoneMismatch && (
              <div className="mt-3 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="flex-1">
                  <div className="font-medium">时区不一致警告</div>
                  <div className="mt-0.5">
                    代理出口时区是 <span className="font-mono">{result.detectedTimezone}</span>
                    ，但你当前 Persona 设的是{' '}
                    <span className="font-mono">{props.currentTimezone}</span>。
                    BrowserScan / pixelscan 会把两者不匹配标红。
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 h-7 text-xs"
                    onClick={() =>
                      result.detectedTimezone && props.onApplyTimezone(result.detectedTimezone)
                    }
                  >
                    一键应用 {result.detectedTimezone}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {result && !result.ok && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="flex items-center gap-2 font-medium">
              <XCircle className="h-4 w-4" />
              代理不可用 · {result.latencyMs} ms
            </div>
            <div className="mt-1 text-xs">{result.error}</div>
          </div>
        )}
      </div>
    </CardContent>
  );
}
