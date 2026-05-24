/**
 * TCP relay (port forwarder) — 解决 chromium headless 下 `--remote-debugging-address`
 * 不生效的已知 bug（issues.chromium.org/issues/40261787）。
 *
 * 网络拓扑：
 *
 *   cloud-runtime ── TCP ──→ pod:9223 (relay, :: dual-stack 默认；Fly 6PN 走 IPv6)
 *                                │ pipe
 *                                ▼
 *                            127.0.0.1:9224 (chromium 实际 CDP server)
 *
 * 实现要点：
 *   - 纯字节级双向 pipe，不解析协议（HTTP/1.1 upgrade + WebSocket 都透明转发）
 *   - 任一端 close → 另一端 close（end → end，让 chromium 看到正常 EOF）
 *   - 任一端 error → 强制 destroy 双方（避免泄漏）
 *   - upstream connect 失败 → clientSock 立刻 destroy（cloud-runtime 拿到
 *     ECONNRESET，cdp proxy log 里能看到具体原因）
 *
 * 性能：每会话 ~1 个 client 连接（playwright WS）+ 偶发 /json/* HTTP 探测连接，
 * 单 pod 同时只跑一个 chromium，关心连接数没意义。简单 pipe 已经足够。
 */

import { createConnection, createServer, type Server, type Socket } from 'node:net';

import { getLogger } from './logger.js';

export interface CdpRelayOptions {
  /** relay 监听的 host —— 容器里默认 '::'（IPv6 dual-stack，让 Fly 6PN 可达）。 */
  listenHost: string;
  /** relay 监听的 port —— 即 POD_CDP_PORT，cloud-runtime 直连这个。 */
  listenPort: number;
  /** 转发目标 host —— chromium 实际 bind 的地址，固定 '127.0.0.1'。 */
  targetHost: string;
  /** 转发目标 port —— 即 POD_CDP_INTERNAL_PORT，chromium 的 CDP server。 */
  targetPort: number;
}

export interface CdpRelay {
  /** 优雅关闭：停止 accept 新连接 + 等已有连接自然结束。 */
  close: () => Promise<void>;
  /** 用于诊断/测试 —— relay 实际监听的地址（OS 分配的 port 在 listenPort=0 时有意义）。 */
  address: () => { host: string; port: number } | null;
}

export function startCdpRelay(opts: CdpRelayOptions): Promise<CdpRelay> {
  const log = getLogger();

  return new Promise((resolve, reject) => {
    const server: Server = createServer((clientSock: Socket) => {
      const upstream: Socket = createConnection({
        host: opts.targetHost,
        port: opts.targetPort,
      });

      let upstreamReady = false;

      // ── pipe 两个方向 ───────────────────────────────────────────────────
      // 重要：不用 pipe(stream).pipe(stream) 来回串，因为那样错误处理散乱；
      // 显式 on('data') + write() + on('end') + end() 让生命周期清晰。
      clientSock.on('data', (chunk) => {
        if (upstream.writable) upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (clientSock.writable) clientSock.write(chunk);
      });

      // ── 半关闭传播（让 WS close frame 走完） ────────────────────────────
      clientSock.on('end', () => {
        if (upstream.writable) upstream.end();
      });
      upstream.on('end', () => {
        if (clientSock.writable) clientSock.end();
      });

      // ── upstream connect 成功 / 失败 ────────────────────────────────────
      upstream.on('connect', () => {
        upstreamReady = true;
      });
      upstream.on('error', (err) => {
        const e = err as Error & { code?: string };
        log.warn(
          {
            err: e.message,
            errCode: e.code,
            target: `${opts.targetHost}:${opts.targetPort}`,
            upstreamReady,
          },
          'cdp relay: upstream error',
        );
        clientSock.destroy();
      });

      clientSock.on('error', (err) => {
        const e = err as Error & { code?: string };
        log.warn(
          { err: e.message, errCode: e.code },
          'cdp relay: client socket error',
        );
        upstream.destroy();
      });

      // ── 全 close 后清理引用 ─────────────────────────────────────────────
      clientSock.on('close', () => upstream.destroy());
      upstream.on('close', () => clientSock.destroy());
    });

    server.on('error', (err) => {
      log.error(
        { err: err.message, listen: `${opts.listenHost}:${opts.listenPort}` },
        'cdp relay: server error',
      );
      reject(err);
    });

    server.listen(opts.listenPort, opts.listenHost, () => {
      const addr = server.address();
      const port =
        typeof addr === 'object' && addr ? addr.port : opts.listenPort;
      log.info(
        {
          listenHost: opts.listenHost,
          listenPort: port,
          target: `${opts.targetHost}:${opts.targetPort}`,
        },
        'cdp relay listening',
      );
      resolve({
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
        address: () => {
          const a = server.address();
          if (typeof a === 'object' && a) return { host: a.address, port: a.port };
          return null;
        },
      });
    });
  });
}
