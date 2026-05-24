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
import { bumpLastSeenAt } from '../db/session-activity.js';
import { sha256Hex } from '../utils/hash.js';
import { apiKeys } from '../db/schema.js';
import { getLogger } from '../utils/logger.js';

interface ProxyAuth {
  apiKeyId: string;
  projectId: string;
}

const SESSION_RE = /^\/v1\/sessions\/([A-Za-z0-9_-]+)\/cdp\/?$/;

/**
 * last_seen_at 周期 bump 间隔。60s 是写入率（sqlite WAL）和 ops 信号粒度
 * 之间的折中：每分钟一次写入对 prod 几千个 alive session 也只是 ~17 写/s，
 * 完全在 sqlite WAL 容量内；ops 想看"过去 5 分钟有没有动过"完全 OK。
 *
 * 测试可通过模块边界注入，不暴露 env 因为这是稳定常量（业务上不需要调）。
 */
const LAST_SEEN_BUMP_INTERVAL_MS = 60_000;

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
      // ws 客户端默认不发 Origin。chromium 111+ 在 --remote-allow-origins 没匹配时
      // 会拒 upgrade，缺 Origin 又不在允许列表里也会被拒。即使 pod 端我们已经传了
      // --remote-allow-origins=*，这里依然显式打一个安全的 origin 兜底（chromium
      // 接 '*' 时也接非 null Origin）。
      const podWs = new WebSocket(podUrl, {
        headers: { Origin: 'http://localhost' },
      });

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
        // err 可能携带的关键诊断字段（按 Node ws 的实际形状）：
        //   - message    'connect ECONNREFUSED 1.2.3.4:9223' / 'Unexpected server response: 403'
        //   - code       errno 'ECONNREFUSED' 'ECONNRESET' 'ETIMEDOUT'
        //   - statusCode HTTP 状态码（仅 ws upgrade 被拒时）
        // 三者一起 dump 才能区分「拨号失败」vs「chromium 拒了 upgrade」vs「连接被中断」。
        const e = err as Error & {
          code?: string;
          statusCode?: number;
          headers?: Record<string, string | string[]>;
        };
        log.warn(
          {
            sessionId,
            podUrl,
            err: e.message,
            errCode: e.code,
            statusCode: e.statusCode,
            podWsReadyState: podWs.readyState,
            podOpen,
          },
          'cdp proxy: pod error',
        );
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

      // last_seen_at 维护：
      //
      //   - 立即 bump 一次（client 刚 upgrade 上来）
      //   - 后续每 LAST_SEEN_BUMP_INTERVAL_MS 周期 bump 一次（活跃信号）
      //   - close 时再 bump 一次（关闭时刻精确记录）
      //
      // 用周期 bump 而不是 "每帧 bump"：
      //   - 单 session CDP 一秒可能上百帧（mouse move、网络事件），每帧打
      //     一次 sqlite UPDATE 会让 sqlite WAL 飙升
      //   - 周期 bump（默认 60s）只产生 ~每分钟一次写入，prod 可接受
      //   - 容忍 last_seen_at 至多滞后 60s，比 reaper 周期（30s）粗，但
      //     last_seen_at 的语义是"是否还活着"而非"精确到秒的活动时间"，60s
      //     粒度对 ops 排查"僵尸 session"足够
      const bumpLastSeen = (): void => {
        // 不 await：CDP 转发是热路径，DB 写要走完异步链。bumpLastSeenAt
        // 自身吞所有错误，不需要这里再 catch。
        void bumpLastSeenAt(handle, sessionId);
      };
      bumpLastSeen();
      const lastSeenTicker = setInterval(bumpLastSeen, LAST_SEEN_BUMP_INTERVAL_MS);
      const stopLastSeenTicker = (): void => {
        clearInterval(lastSeenTicker);
        bumpLastSeen(); // close 时刻再 bump 一次
      };
      clientWs.on('close', stopLastSeenTicker);
      podWs.on('close', stopLastSeenTicker);
    });
  }

  return { wss, handleUpgrade };
}
