import { type Server, type Socket, createConnection, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { type CdpRelay, startCdpRelay } from './relay.js';

// 起一个 echo server 充当 "chromium"。echo bytes 回去就行 —— relay 不关心协议。
async function startEchoServer(): Promise<{
  server: Server;
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      sock.on('data', (chunk) => {
        if (sock.writable) sock.write(chunk);
      });
    });
    server.on('error', reject);
    // 127.0.0.1 + port=0 → OS 分配空闲 port
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || !addr) {
        reject(new Error('echo server address() returned unexpected shape'));
        return;
      }
      resolve({
        server,
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// 连接到 relay 并发一段 bytes，等同长度 echo 回来后 resolve。
function roundtrip(host: string, port: number, payload: Buffer, timeoutMs = 2000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock: Socket = createConnection({ host, port });
    const chunks: Buffer[] = [];
    let received = 0;
    const tm = setTimeout(() => {
      sock.destroy();
      reject(
        new Error(
          `roundtrip timeout after ${timeoutMs}ms (got ${received}/${payload.length} bytes)`,
        ),
      );
    }, timeoutMs);
    sock.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= payload.length) {
        clearTimeout(tm);
        sock.end();
        resolve(Buffer.concat(chunks));
      }
    });
    sock.on('error', (err) => {
      clearTimeout(tm);
      reject(err);
    });
    sock.on('connect', () => sock.write(payload));
  });
}

// 等 a TCP connect 失败（用于 ECONNREFUSED 行为验证）
function expectConnectFails(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve, reject) => {
    const sock: Socket = createConnection({ host, port });
    const tm = setTimeout(() => {
      sock.destroy();
      reject(new Error(`expected connect failure but socket stayed alive for ${timeoutMs}ms`));
    }, timeoutMs);
    sock.on('connect', () => {
      // 连上是 OK 的 —— relay accept 了之后才会 dial upstream，这里只要等 close
      sock.on('close', (hadErr) => {
        clearTimeout(tm);
        if (hadErr) {
          resolve(new Error('socket closed with error') as NodeJS.ErrnoException);
        } else {
          // 没 error 标记也接受 —— upstream 拒绝时 relay 主动 destroy clientSock
          resolve(
            new Error('socket closed by relay (upstream unreachable)') as NodeJS.ErrnoException,
          );
        }
      });
    });
    sock.on('error', (err) => {
      clearTimeout(tm);
      resolve(err as NodeJS.ErrnoException);
    });
  });
}

describe('startCdpRelay', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const c = cleanups.pop();
      if (c) await c().catch(() => undefined);
    }
  });

  it('forwards bytes bidirectionally to upstream', async () => {
    const echo = await startEchoServer();
    cleanups.push(echo.close);

    const relay: CdpRelay = await startCdpRelay({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: echo.port,
    });
    cleanups.push(relay.close);

    const addr = relay.address();
    expect(addr).not.toBeNull();
    const payload = Buffer.from('GET /json/version HTTP/1.1\r\nHost: x\r\n\r\n');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const got = await roundtrip('127.0.0.1', addr!.port, payload);
    expect(got.equals(payload)).toBe(true);
  });

  it('survives multiple concurrent client connections', async () => {
    const echo = await startEchoServer();
    cleanups.push(echo.close);

    const relay: CdpRelay = await startCdpRelay({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: echo.port,
    });
    cleanups.push(relay.close);

    const addr = relay.address();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const port = addr!.port;
    const payloads = Array.from({ length: 8 }, (_, i) => Buffer.from(`msg-${i}-${'x'.repeat(64)}`));
    const results = await Promise.all(payloads.map((p) => roundtrip('127.0.0.1', port, p)));
    results.forEach((got, i) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(got.equals(payloads[i]!)).toBe(true);
    });
  });

  it('destroys client socket when upstream is unreachable (ECONNREFUSED)', async () => {
    // 指向一个不存在的 port（保证不在用：用 0 → OS 不会监听）
    // 实际操作：先开一个 server 拿到 port，再关掉它，确保这个 port 一定没人 listen
    const tmp = await startEchoServer();
    await tmp.close();
    const deadPort = tmp.port;

    const relay: CdpRelay = await startCdpRelay({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: deadPort,
    });
    cleanups.push(relay.close);

    const addr = relay.address();
    expect(addr).not.toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const err = await expectConnectFails('127.0.0.1', addr!.port);
    expect(err).toBeTruthy();
  });

  it('close() stops accepting new connections', async () => {
    const echo = await startEchoServer();
    cleanups.push(echo.close);

    const relay: CdpRelay = await startCdpRelay({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: echo.port,
    });

    const addr = relay.address();
    expect(addr).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const port = addr!.port;

    await relay.close();

    // close 之后新连接应该失败
    await expect(roundtrip('127.0.0.1', port, Buffer.from('hi'), 1000)).rejects.toThrow();
  });
});
