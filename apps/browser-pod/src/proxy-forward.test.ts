import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type ProxyForwarderHandle,
  type UpstreamProxy,
  needsAuthForwarder,
  startProxyForwarder,
} from './proxy-forward.js';

describe('needsAuthForwarder', () => {
  const base: UpstreamProxy = {
    protocol: 'http',
    host: 'h',
    port: 1,
    username: 'u',
    password: 'p',
  };

  it('true for http/https upstream with username', () => {
    expect(needsAuthForwarder({ ...base, protocol: 'http' })).toBe(true);
    expect(needsAuthForwarder({ ...base, protocol: 'https' })).toBe(true);
  });

  it('false when no username (direct --proxy-server is fine)', () => {
    expect(needsAuthForwarder({ ...base, username: undefined })).toBe(false);
  });

  it('false for socks5 (not yet supported by the forwarder)', () => {
    expect(needsAuthForwarder({ ...base, protocol: 'socks5' })).toBe(false);
  });
});

interface FakeUpstream {
  port: number;
  /** 最近一次 CONNECT 收到的 Proxy-Authorization 头（null = 未收到）。 */
  lastAuth: string | null;
  close(): Promise<void>;
}

/**
 * 起一个假的上游 HTTP 代理：校验/记录 Proxy-Authorization，认证正确则建立隧道，
 * 把客户端发来的字节原样 echo 回去（验证端到端隧道 + 认证注入）。
 */
function startFakeUpstream(expectAuth: string): Promise<FakeUpstream> {
  const state: { lastAuth: string | null } = { lastAuth: null };
  const sockets = new Set<net.Socket>();
  const server = http.createServer();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('connect', (req, socket) => {
    const auth = req.headers['proxy-authorization'] ?? null;
    state.lastAuth = Array.isArray(auth) ? (auth[0] ?? null) : auth;
    if (state.lastAuth !== expectAuth) {
      socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      socket.end();
      return;
    }
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    // echo：隧道内回显客户端字节
    socket.on('data', (d) => socket.write(d));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        get lastAuth() {
          return state.lastAuth;
        },
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            sockets.clear();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

describe('startProxyForwarder (e2e)', () => {
  let fw: ProxyForwarderHandle | null = null;
  let up: FakeUpstream | null = null;

  afterEach(async () => {
    await fw?.close();
    await up?.close();
    fw = null;
    up = null;
  });

  it('injects Proxy-Authorization toward upstream and tunnels bytes via CONNECT', async () => {
    const expectAuth = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    up = await startFakeUpstream(expectAuth);
    fw = await startProxyForwarder({
      protocol: 'http',
      host: '127.0.0.1',
      port: up.port,
      username: 'user',
      password: 'pass',
    });
    const fwPort = fw.port;

    const echoed = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: fwPort,
        method: 'CONNECT',
        path: 'example.com:443',
      });
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`tunnel status ${res.statusCode}`));
          return;
        }
        socket.once('data', (d) => {
          resolve(d.toString('utf8'));
          socket.end();
        });
        socket.write('ping');
      });
      req.on('error', reject);
      req.end();
    });

    expect(up.lastAuth).toBe(expectAuth);
    expect(echoed).toBe('ping');
  });

  it('rejects unsupported upstreams (socks5 / no username)', async () => {
    await expect(
      startProxyForwarder({ protocol: 'socks5', host: 'h', port: 1, username: 'u', password: 'p' }),
    ).rejects.toThrow();
    await expect(startProxyForwarder({ protocol: 'http', host: 'h', port: 1 })).rejects.toThrow();
  });
});
