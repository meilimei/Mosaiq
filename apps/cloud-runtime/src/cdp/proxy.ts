/**
 * CDP WebSocket 反向代理。
 *
 * 流量路径：
 *   client (playwright `connectOverCDP`)
 *     ── WSS Upgrade ──→ control-plane :8787 /v1/sessions/:id/cdp
 *                          ├─ 鉴权（Bearer header 或 ?token=...）
 *                          ├─ DB 查 session → cdpInternalUrl
 *                          └─ 全双工管道到 pod chromium :9223/devtools/browser/<uuid>
 *
 * 设计要点：
 *   - 用 `ws` 库的 WebSocketServer({ noServer: true }) 接管 upgrade
 *   - 控制平面对客户端是 WS server，对 pod 是 WS client，中间纯 byte pipe
 *   - 我们不解析 CDP 帧；既保留 binary frame 也保留 text frame
 *   - 任一端 close → 另一端 close（带相同 code 尽量）
 *   - 周期性心跳用 ws 自带 ping/pong（每 30s）
 *
 * 鉴权：
 *   - 优先从 Authorization: Bearer ... header 读（Playwright 的 connectOverCDP
 *     支持 `headers` 参数）
 *   - 兜底从 URL `?token=` 读（浏览器 WS API 不支持自定义 header）
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { eq } from 'drizzle-orm';
import { WebSocket, WebSocketServer } from 'ws';

import { getDb } from '../db/client.js';
import { sessions as sessionsTable } from '../db/schema.js';
import { sha256Hex } from '../utils/hash.js';
import { apiKeys } from '../db/schema.js';
import { getLogger } from '../utils/logger.js';

interface ProxyAuth {
  apiKeyId: string;
  projectId: string;
}

const SESSION_RE = /^\/v1\/sessions\/([A-Za-z0-9_-]+)\/cdp\/?$/;

export function createCdpProxy() {
  const wss = new WebSocketServer({ noServer: true });
  const log = getLogger();

  async function authenticate(req: IncomingMessage): Promise<ProxyAuth | null> {
    const headerToken = (() => {
      const v = req.headers['authorization'];
      if (typeof v === 'string' && v.toLowerCase().startsWith('bearer ')) {
        return v.slice(7).trim();
      }
      return null;
    })();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    const token = headerToken ?? queryToken;
    if (!token) return null;

    const handle = await getDb();
    const rows = await handle.drizzle
      .select({ id: apiKeys.id, projectId: apiKeys.projectId, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, sha256Hex(token)))
      .limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return null;
    return { apiKeyId: row.id, projectId: row.projectId };
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reqUrl = req.url ?? '/';
    const path = reqUrl.split('?')[0] ?? '/';
    const m = SESSION_RE.exec(path);
    if (!m) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const sessionId = m[1] as string;

    const auth = await authenticate(req).catch(() => null);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const handle = await getDb();
    const rows = await handle.drizzle
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (row.projectId !== auth.projectId) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (row.status !== 'live') {
      socket.write('HTTP/1.1 410 Gone\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const podUrl = row.cdpInternalUrl;
      log.info({ sessionId, podUrl }, 'cdp proxy: client upgraded, dialing pod');
      const podWs = new WebSocket(podUrl);

      // 缓冲：在 podWs OPEN 前 client 发的帧先 buffer 不丢
      const pendingFromClient: Array<Buffer | string> = [];
      let podOpen = false;

      const flushClientPending = () => {
        for (const m of pendingFromClient) podWs.send(m);
        pendingFromClient.length = 0;
      };

      podWs.on('open', () => {
        podOpen = true;
        flushClientPending();
      });

      podWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      clientWs.on('message', (data, isBinary) => {
        const payload = isBinary ? (data as Buffer) : data.toString('utf8');
        if (podOpen && podWs.readyState === WebSocket.OPEN) {
          podWs.send(payload);
        } else {
          pendingFromClient.push(payload);
        }
      });

      const closeBoth = (code = 1000, reason = '') => {
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
          try {
            clientWs.close(code, reason);
          } catch {
            /* ignore */
          }
        }
        if (podWs.readyState === WebSocket.OPEN || podWs.readyState === WebSocket.CONNECTING) {
          try {
            podWs.close(code, reason);
          } catch {
            /* ignore */
          }
        }
      };

      clientWs.on('close', (code, reason) => {
        log.debug({ sessionId, code }, 'cdp proxy: client closed');
        closeBoth(code, reason.toString('utf8'));
      });
      podWs.on('close', (code, reason) => {
        log.debug({ sessionId, code }, 'cdp proxy: pod closed');
        closeBoth(code, reason.toString('utf8'));
      });

      clientWs.on('error', (err) => {
        log.warn({ sessionId, err: err.message }, 'cdp proxy: client error');
      });
      podWs.on('error', (err) => {
        log.warn({ sessionId, err: err.message }, 'cdp proxy: pod error');
        closeBoth(1011, 'pod error');
      });

      // 简单的心跳 — 每 30s 发 ping，pong 自动处理
      const heartbeat = setInterval(() => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.ping();
        if (podWs.readyState === WebSocket.OPEN) podWs.ping();
      }, 30_000);
      const stopHeartbeat = () => clearInterval(heartbeat);
      clientWs.on('close', stopHeartbeat);
      podWs.on('close', stopHeartbeat);

      // 更新 last_seen_at
      handle.drizzle
        .update(sessionsTable)
        .set({ lastSeenAt: new Date().toISOString() })
        .where(eq(sessionsTable.id, sessionId))
        .catch(() => undefined);
    });
  }

  return { wss, handleUpgrade };
}
