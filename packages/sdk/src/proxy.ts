/**
 * 代理参数构造：Chromium `--proxy-server=...` 与 Playwright launch proxy 配置。
 * 以及 verifyProxy()：实际通过代理拉一次 IP 信息端点，验证连通性。
 */

import * as https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import type { ProxyConfig } from '@runova/persona-schema';

/**
 * 构造 Chromium --proxy-server= 值。
 * 例：'http://proxy.example.com:8080' / 'socks5://user:pass@host:1080'
 *
 * 注意：Chromium 的 --proxy-server 不接受 userinfo 内嵌。用户名密码必须
 * 通过 DevTools Protocol `Network.setExtraHTTPHeaders` 或 Playwright
 * context proxy 的 username/password 传递。
 */
export function buildProxyServerArg(proxy: ProxyConfig): string {
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

/**
 * Playwright launch 的 proxy 结构。
 */
export interface PlaywrightProxy {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export function toPlaywrightProxy(proxy: ProxyConfig): PlaywrightProxy {
  return {
    server: buildProxyServerArg(proxy),
    bypass:
      proxy.bypassList && proxy.bypassList.length > 0 ? proxy.bypassList.join(',') : undefined,
    username: proxy.username,
    password: proxy.password,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyProxy: 实际拨号一次，确认代理活、能出公网、出口在哪
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 代理预检结果。
 *   - ok=true 时：exitIp/country/... 至少 exitIp 有值
 *   - ok=false 时：error 描述失败原因
 *   - latencyMs 总是有效（从发起到结束）
 */
export interface ProxyVerifyResult {
  ok: boolean;
  exitIp?: string;
  /** ISO 国家码，如 'US' / 'JP' */
  country?: string;
  city?: string;
  region?: string;
  /** 代理出口节点的「IANA 时区」，如 'America/New_York' */
  detectedTimezone?: string;
  /** ISP / ASN，如 'AS7922 Comcast Cable Communications, LLC' */
  org?: string;
  /** 端到端延迟（毫秒） */
  latencyMs: number;
  /** ok=false 时的人话错误描述 */
  error?: string;
}

export interface ProxyVerifyOptions {
  /**
   * IP 信息端点。默认 https://ipinfo.io/json （免费 50k req/月，无需 token）。
   * 返回字段：ip / city / region / country / timezone / org
   */
  endpoint?: string;
  /** 总超时（毫秒）。默认 15 秒，住宅代理首次拨号偶尔会慢。 */
  timeoutMs?: number;
}

/**
 * 通过代理实际请求 IP 信息端点，验证代理可用并返回出口元数据。
 *
 * 设计：不抛异常 —— 任何失败都包装进 `{ ok: false, error }`，
 * 让调用方（UI）能直接渲染为表单提示，无需 try/catch。
 *
 * 应用场景：
 *   1. 用户在 PersonaCreatePage 配完代理后，点「测试代理」立即拿到反馈
 *   2. 启动 Persona 之前的健康检查
 *   3. CI / 定时任务批量检查代理池存活率
 */
export async function verifyProxy(
  proxy: ProxyConfig,
  options: ProxyVerifyOptions = {},
): Promise<ProxyVerifyResult> {
  const start = Date.now();
  const endpoint = options.endpoint ?? 'https://ipinfo.io/json';
  const timeoutMs = options.timeoutMs ?? 15_000;

  let agent: https.Agent;
  try {
    agent = createProxyAgent(proxy);
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: `proxy config invalid: ${(err as Error).message}`,
    };
  }

  try {
    const body = await fetchThroughAgent(endpoint, agent, timeoutMs);
    const json = JSON.parse(body) as Partial<{
      ip: string;
      country: string;
      city: string;
      region: string;
      timezone: string;
      org: string;
    }>;

    if (!json.ip) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: 'endpoint returned no IP — response shape unexpected',
      };
    }

    return {
      ok: true,
      exitIp: json.ip,
      country: json.country,
      city: json.city,
      region: json.region,
      detectedTimezone: json.timezone,
      org: json.org,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: humanizeProxyError(err as NodeJS.ErrnoException),
    };
  }
}

function createProxyAgent(proxy: ProxyConfig): https.Agent {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
    : '';
  const url = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;

  if (proxy.protocol === 'socks5') {
    return new SocksProxyAgent(url);
  }
  // http 与 https 都走 HttpsProxyAgent —— 它支持 CONNECT 隧道，无论代理本身是 http
  // 还是 https，对目标 https URL 都会发起 CONNECT。
  return new HttpsProxyAgent(url);
}

function fetchThroughAgent(url: string, agent: https.Agent, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent,
        timeout: timeoutMs,
        headers: {
          // ipinfo.io 默认返回 HTML when called from browser-ish UA, force JSON via Accept
          Accept: 'application/json',
          'User-Agent': 'mosaiq-proxy-verifier/0.1',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
  });
}

function humanizeProxyError(err: NodeJS.ErrnoException): string {
  const code = err.code ?? '';
  // 把 Node 的低层错误码映射成「用户能看懂」的中文提示
  const map: Record<string, string> = {
    ECONNREFUSED: '代理服务器拒绝连接（host/port 错误？）',
    ENOTFOUND: '代理主机名 DNS 解析失败',
    ETIMEDOUT: '连接代理超时（host/port 不可达？）',
    ECONNRESET: '代理连接被重置（认证失败？欠费？）',
    EHOSTUNREACH: '到代理主机网络不可达',
    EPROTO: 'TLS 握手失败（代理服务器配置问题？）',
  };
  if (map[code]) return `${map[code]} [${code}]`;
  return err.message || '未知错误';
}
