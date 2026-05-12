/**
 * proxy.ts 单元测试。
 *
 * 重点：
 *   - buildProxyServerArg 不能把用户名密码塞进 URL（Chromium --proxy-server
 *     不支持 userinfo，会被识别成 host 的一部分导致连接失败）
 *   - toPlaywrightProxy 正确翻译 ProxyConfig 到 Playwright launch 选项
 *
 * 不测：verifyProxy（带网络 IO），留给手工/集成测试。
 */

import { describe, expect, it } from 'vitest';

import type { ProxyConfig } from '@mosaiq/persona-schema';

import { buildProxyServerArg, toPlaywrightProxy } from './proxy.js';

describe('buildProxyServerArg', () => {
  it('builds http://host:port', () => {
    const cfg: ProxyConfig = {
      protocol: 'http',
      host: 'proxy.example.com',
      port: 8080,
      bypassList: [],
    };
    expect(buildProxyServerArg(cfg)).toBe('http://proxy.example.com:8080');
  });

  it('builds https://host:port', () => {
    const cfg: ProxyConfig = {
      protocol: 'https',
      host: 'tls.proxy.io',
      port: 443,
      bypassList: [],
    };
    expect(buildProxyServerArg(cfg)).toBe('https://tls.proxy.io:443');
  });

  it('builds socks5://host:port', () => {
    const cfg: ProxyConfig = {
      protocol: 'socks5',
      host: '10.0.0.1',
      port: 1080,
      bypassList: [],
    };
    expect(buildProxyServerArg(cfg)).toBe('socks5://10.0.0.1:1080');
  });

  it('does NOT embed username/password in the URL', () => {
    // Chromium 的 --proxy-server 解析器把 user:pass@host 当作主机名一部分，
    // 这里必须只输出协议 + host + port。
    const cfg: ProxyConfig = {
      protocol: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: 'alice',
      password: 's3cret!',
      bypassList: [],
    };
    const result = buildProxyServerArg(cfg);
    expect(result).toBe('http://proxy.example.com:8080');
    expect(result).not.toContain('alice');
    expect(result).not.toContain('s3cret');
    expect(result).not.toContain('@');
  });
});

describe('toPlaywrightProxy', () => {
  it('maps minimal config (no auth, no bypass)', () => {
    const cfg: ProxyConfig = { protocol: 'http', host: 'h', port: 80, bypassList: [] };
    expect(toPlaywrightProxy(cfg)).toEqual({
      server: 'http://h:80',
      bypass: undefined,
      username: undefined,
      password: undefined,
    });
  });

  it('propagates username/password verbatim (Playwright will URL-encode at send time)', () => {
    const cfg: ProxyConfig = {
      protocol: 'http',
      host: 'h',
      port: 80,
      username: 'user@email',
      password: 'p:ass/word',
      bypassList: [],
    };
    const out = toPlaywrightProxy(cfg);
    expect(out.username).toBe('user@email');
    expect(out.password).toBe('p:ass/word');
  });

  it('joins bypassList with comma', () => {
    const cfg: ProxyConfig = {
      protocol: 'http',
      host: 'h',
      port: 80,
      bypassList: ['localhost', '127.0.0.1', '*.internal'],
    };
    expect(toPlaywrightProxy(cfg).bypass).toBe('localhost,127.0.0.1,*.internal');
  });

  it('treats empty bypassList as no bypass', () => {
    // 显式空数组应当与未提供等价，避免给 Playwright 传一个空字符串
    const cfg: ProxyConfig = { protocol: 'http', host: 'h', port: 80, bypassList: [] };
    expect(toPlaywrightProxy(cfg).bypass).toBeUndefined();
  });

  it('does not leak persona-only fields (label, etc.) into Playwright proxy', () => {
    const cfg: ProxyConfig = {
      protocol: 'socks5',
      host: 'h',
      port: 1080,
      label: 'iproyal-us-sticky-001',
      bypassList: [],
    };
    const out = toPlaywrightProxy(cfg);
    expect(out).not.toHaveProperty('label');
    expect(out).not.toHaveProperty('protocol');
    expect(out).not.toHaveProperty('host');
    expect(out).not.toHaveProperty('port');
  });
});
