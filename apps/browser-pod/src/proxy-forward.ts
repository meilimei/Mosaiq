/**
 * 本地认证转发代理（Option A，issue #5）。
 *
 * 背景：pod 直接 spawn chromium，`--proxy-server` **不携带认证**，所以带
 * username/password 的上游代理（住宅 / ISP，如 IPRoyal）在云端用不了。
 *
 * 本模块在 pod 内起一个监听 `127.0.0.1:<随机口>` 的轻量 HTTP 代理：
 *   - chromium 用 `--proxy-server=http://127.0.0.1:<port>` 指向它（无需认证）；
 *   - 它把请求转发到真正的上游代理，并注入 `Proxy-Authorization` 头。
 *
 * 这样凭据只活在 pod 进程内、不进 chromium 命令行（避免 argv 泄漏），对 chromium
 * 完全透明。支持上游协议：http / https(TLS-to-proxy)。socks5 暂不支持（见下）。
 *
 * 仅当上游代理**带认证且协议为 http/https** 时才需要本转发器；无认证 / socks5
 * 由 persona-flags.ts 走传统 `--proxy-server` 直连（socks5+认证是已知缺口，留作
 * 后续：需 socks5 客户端握手）。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import { getLogger } from './logger.js';

/** 本转发器支持的上游协议（socks5 暂不支持，需独立握手实现）。 */
export type ForwardableProtocol = 'http' | 'https';

/** 转发器需要的上游代理字段（结构化，避免耦合 persona-schema 导出）。 */
export interface UpstreamProxy {
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyForwarderHandle {
  /** chromium 用的本地代理 URL，形如 http://127.0.0.1:<port>。 */
  url: string;
  /** 本地监听端口（OS 分配）。 */
  port: number;
  /** 关闭转发器（幂等，best-effort）。 */
  close(): Promise<void>;
}

/**
 * 判断某个上游代理是否需要 / 能够走本地认证转发器。
 * 条件：带 username（需认证）且协议为 http/https（本转发器支持的上游）。
 */
export function needsAuthForwarder(p: UpstreamProxy): p is UpstreamProxy & {
  protocol: ForwardableProtocol;
  username: string;
} {
  return Boolean(p.username) && (p.protocol === 'http' || p.protocol === 'https');
}

/** 构造 `Proxy-Authorization: Basic <base64(user:pass)>` 头值。 */
function buildProxyAuthHeader(username: string, password: string): string {
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * 拨通到上游代理的 TCP / TLS 连接（尚未发任何 CDP/CONNECT 数据）。
 *   - http  → 明文 TCP
 *   - https → TLS（servername=上游 host，用于 SNI / 证书校验）
 */
function dialUpstream(p: UpstreamProxy & { protocol: ForwardableProtocol }): net.Socket {
  if (p.protocol === 'https') {
    return tls.connect({ host: p.host, port: p.port, servername: p.host });
  }
  return net.connect({ host: p.host, port: p.port });
}

/**
 * 处理来自 chromium 的 CONNECT（HTTPS 目标，主路径）。
 * 向上游发带 Proxy-Authorization 的 CONNECT，握手成功后双向 pipe。
 */
function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  p: UpstreamProxy & { protocol: ForwardableProtocol; username: string },
  authHeader: string,
  log: ReturnType<typeof getLogger>,
  track: (s: net.Socket) => void,
): void {
  const target = req.url ?? '';
  const upstream = dialUpstream(p);
  track(upstream);
  let settled = false;

  const failClient = (msg: string) => {
    if (settled) return;
    settled = true;
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } catch {
      /* client already gone */
    }
    clientSocket.destroy();
    upstream.destroy();
    log.warn({ target, reason: msg }, 'proxy-forward: CONNECT failed');
  };

  upstream.on('error', (err) => failClient(`upstream error: ${err.message}`));
  clientSocket.on('error', () => upstream.destroy());

  const onReady = () => {
    upstream.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
        `Proxy-Authorization: ${authHeader}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    readUpstreamConnectReply(
      upstream,
      clientSocket,
      head,
      target,
      () => {
        settled = true;
      },
      failClient,
    );
  };
  upstream.once(p.protocol === 'https' ? 'secureConnect' : 'connect', onReady);
}

/**
 * 读上游对 CONNECT 的应答头，2xx 则告知 chromium 隧道建立并双向 pipe；否则失败。
 */
function readUpstreamConnectReply(
  upstream: net.Socket,
  clientSocket: net.Socket,
  head: Buffer,
  target: string,
  markSettled: () => void,
  failClient: (msg: string) => void,
): void {
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) {
      if (buf.length > 16 * 1024) failClient('upstream CONNECT reply too large');
      return;
    }
    upstream.removeListener('data', onData);
    const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('utf8');
    const code = Number.parseInt(statusLine.split(/\s+/)[1] ?? '', 10);
    if (code < 200 || code >= 300) {
      failClient(`upstream CONNECT status ${code || statusLine}`);
      return;
    }
    markSettled();
    // 上游头之后若带了多余字节（隧道首包），原样转给 chromium。
    const leftover = buf.slice(sep + 4);
    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (leftover.length) clientSocket.write(leftover);
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  };
  upstream.on('data', onData);
}

/**
 * 处理来自 chromium 的明文 HTTP 请求（http:// 目标）。chromium 发绝对 URI 形式，
 * 我们把它原样转给上游代理，并加 Proxy-Authorization。
 */
function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: UpstreamProxy & { protocol: ForwardableProtocol; username: string },
  authHeader: string,
  log: ReturnType<typeof getLogger>,
): void {
  const mod = p.protocol === 'https' ? https : http;
  const headers = { ...req.headers, 'proxy-authorization': authHeader };
  const proxyReq = mod.request(
    {
      host: p.host,
      port: p.port,
      method: req.method,
      path: req.url, // chromium 代理模式下是绝对 URI
      headers,
      ...(p.protocol === 'https' ? { servername: p.host } : {}),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    log.warn({ url: req.url, reason: err.message }, 'proxy-forward: HTTP request failed');
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxyReq);
}

/**
 * 起一个本地认证转发代理，监听 127.0.0.1:<OS 分配口>，转发到 `upstream` 并注入认证。
 * 仅接受 `needsAuthForwarder(upstream) === true` 的上游（http/https + 带 username）。
 */
export function startProxyForwarder(upstream: UpstreamProxy): Promise<ProxyForwarderHandle> {
  if (!needsAuthForwarder(upstream)) {
    return Promise.reject(
      new Error(
        `startProxyForwarder: unsupported upstream (need http/https + username; got protocol=${upstream.protocol}, hasUser=${Boolean(upstream.username)})`,
      ),
    );
  }
  const log = getLogger();
  const authHeader = buildProxyAuthHeader(upstream.username, upstream.password ?? '');
  // 追踪所有 socket（入站 + 上游），close 时强制 destroy —— CONNECT 隧道的 socket
  // 会从 http.Server 脱管，closeAllConnections 收不到它们，不显式 destroy 则
  // server.close() 回调永不触发（killChromium 会卡住）。
  const openSockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    openSockets.add(s);
    s.once('close', () => openSockets.delete(s));
  };
  const server = http.createServer((req, res) =>
    handleRequest(req, res, upstream, authHeader, log),
  );
  server.on('connection', track);
  server.on('connect', (req, socket, head) =>
    handleConnect(req, socket as net.Socket, head, upstream, authHeader, log, track),
  );
  // 单连接错误不能掀翻整个 server（否则一个坏隧道 = pod 整个代理挂掉）。
  server.on('clientError', (_err, socket) => socket.destroy());

  return new Promise<ProxyForwarderHandle>((resolve, reject) => {
    server.once('error', reject);
    // 仅绑 127.0.0.1：只给本机 chromium 用，绝不对外暴露（凭据安全边界）。
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('proxy-forward: failed to obtain listen port'));
        return;
      }
      const port = addr.port;
      log.info(
        { port, upstreamHost: upstream.host, upstreamProto: upstream.protocol },
        'proxy-forward: listening (auth injected toward upstream)',
      );
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((res) => {
            // 先 destroy 所有追踪到的 socket（含脱管的 CONNECT 隧道），再 close server。
            for (const s of openSockets) s.destroy();
            openSockets.clear();
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}
