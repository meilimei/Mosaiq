/**
 * `--proxy <url>` flag 解析。把单字符串 `<protocol>://[user[:pass]@]host:port`
 * 解成 Persona template ctor 接受的 proxy 子对象（不含 `bypassList`，
 * 模板 ctor 内部会填 `[]`）。
 *
 * 支持的协议（与 Persona schema 的 `ProxyConfig.protocol` 对齐）：
 *   - http
 *   - https
 *   - socks5
 *
 * URL-encoded credentials 会被自动 decode：传 `pass%40word` 即为字面量
 * `pass@word`。Node 的 WHATWG `URL` 把 `username` / `password` 字段以
 * 已编码形式返回，所以需要在 wrapper 里 `decodeURIComponent`。
 *
 * 拒绝场景（保守语义，避免 silently 把不像代理的 URL 接收下去）：
 *   - 协议非 http / https / socks5（含 `socks5h://`，SDK 不支持 DNS-over-proxy）
 *   - host 缺失
 *   - port 缺失或不在 1..65535
 *   - URL 含 path（除 `/`） / query / fragment
 *   - URL-decode credentials 时抛错（malformed `%`）
 */

export interface ParsedProxyInput {
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxyUrl(input: string): ParsedProxyInput {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('Proxy URL is empty');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid proxy URL: ${trimmed}`);
  }

  // url.protocol 形如 'http:' / 'socks5:'，去尾冒号
  const proto = url.protocol.replace(/:$/, '');
  if (proto !== 'http' && proto !== 'https' && proto !== 'socks5') {
    throw new Error(
      `Unsupported proxy protocol "${proto}" in ${trimmed}; supported: http, https, socks5`,
    );
  }

  if (!url.hostname) {
    throw new Error(`Proxy URL missing host: ${trimmed}`);
  }
  // WHATWG URL 把"等于 scheme 默认端口"的 `:NN` 序列化成空串
  // （http=80 / https=443）。用户字面写 `https://h:443` 时 url.port = ''，
  // 朴素判 missing 会误杀。fallback 用正则去原串里找 explicit port。
  const explicitPort = url.port ? Number.parseInt(url.port, 10) : extractExplicitPort(trimmed);
  if (explicitPort === null) {
    throw new Error(`Proxy URL missing port: ${trimmed}`);
  }
  if (!Number.isFinite(explicitPort) || explicitPort < 1 || explicitPort > 65535) {
    throw new Error(`Proxy URL has invalid port "${explicitPort}" (1..65535): ${trimmed}`);
  }
  const port = explicitPort;

  // 拒绝 path / query / fragment ——
  // 对 special scheme（http/https）path 默认是 `/`；
  // non-special scheme（socks5）path 默认是空串。两种"空"都允许通过。
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error(`Proxy URL must not include a path: ${trimmed}`);
  }
  if (url.search !== '') {
    throw new Error(`Proxy URL must not include a query string: ${trimmed}`);
  }
  if (url.hash !== '') {
    throw new Error(`Proxy URL must not include a fragment: ${trimmed}`);
  }

  let username: string | undefined;
  let password: string | undefined;
  try {
    username = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    throw new Error(`Proxy URL credentials contain malformed percent-encoding: ${trimmed}`);
  }

  return {
    protocol: proto,
    host: url.hostname,
    port,
    username,
    password,
  };
}

/**
 * 从原始 URL 字符串里挖出 `:NN` 的显式端口。
 *
 * URL ctor 在端口与 scheme 默认值匹配时（http:80 / https:443）会把 `url.port`
 * 序列化成空串，导致 fall-through 到 "missing port" 报错。这个 helper 重新解析
 * 原串、跳过 scheme + userinfo、在 host:port 段里抓数字。
 *
 * 解析步骤：
 *   1. 去掉 `<scheme>://` 前缀
 *   2. 砍掉 `?` / `#` / `/<path>` 之后的部分
 *   3. 用最后一个 `@` 切掉 userinfo（避免密码里的 `:` 误识别为端口）
 *   4. 在 `host:port` 段尾匹配 `:(\d+)$`
 *
 * 没找到（用户压根没写端口）→ 返回 null，让调用方丢出 "missing port" 错误。
 */
function extractExplicitPort(raw: string): number | null {
  const afterScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const beforePath = afterScheme.replace(/[/?#].*$/, '');
  const atIdx = beforePath.lastIndexOf('@');
  const hostport = atIdx >= 0 ? beforePath.slice(atIdx + 1) : beforePath;
  const match = /:(\d+)$/.exec(hostport);
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}
