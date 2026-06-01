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
 * 鉴权 (phase 11.4 commit 4c)：按优先级三叉 fallback
 *   1. Authorization: Bearer <api_key>             # native SDK / Playwright connectOverCDP({ headers })
 *   2. URL `?token=<session.signing_key>`          # Stagehand 路径（session-scoped）
 *   3. URL `?token=<api_key>`                      # 浏览器 WS API、legacy CLI
 *
 * 路径 2 在 phase 11.4 commit 4c 加入，是使 Stagehand 零配置调
 * `chromium.connectOverCDP(session.connectUrl)` 能连上的关键：Playwright
 * 默认不携 header，connectUrl 必须自带凭据。signing key 是 session 范围的
 * 最小凭据（只能接本 session），泄露后的蔓延屁股小于 API key。
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { eq } from 'drizzle-orm';
import { WebSocket, WebSocketServer } from 'ws';

import { getDb } from '../db/client.js';
import { sessions as sessionsTable } from '../db/schema.js';
import { apiKeys } from '../db/schema.js';
import { bumpLastSeenAt } from '../db/session-activity.js';
import { sha256Hex } from '../utils/hash.js';
import { getLogger } from '../utils/logger.js';

interface ProxyAuth {
  /** 使用了哪种凭据：API key (full project scope) 或 session signing key (session scope)。 */
  scope: 'api_key' | 'session_key';
  /** API key id 或 合成错 'sks:<sessionId>' 评调 audit。 */
  apiKeyId: string;
  /** 该 session 所属 project（两种路径都能拿到）。 */
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

  /**
   * 鉴权。调用时传入已查到的 session 行，让我们能在没额外 DB query
   * 的情况下识别 session-scoped signing key。
   *
   * 优先级：Bearer header > ?token= as session signing key > ?token= as api key plaintext.
   * “session signing key” 必须与 URL :id 对上的那个 session 的 row.signingKey 严格相等，
   * 防止 “拿 session A 的 signing key 去连 session B”。
   */
  async function authenticate(
    req: IncomingMessage,
    sessionRow: { id: string; projectId: string; signingKey: string | null },
  ): Promise<ProxyAuth | null> {
    const headerToken = (() => {
      const v = req.headers.authorization;
      if (typeof v === 'string' && v.toLowerCase().startsWith('bearer ')) {
        return v.slice(7).trim();
      }
      return null;
    })();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');

    // 路径 2：query token 与 session.signing_key 严格相等。仅 ?token= 路线，
    // header 路径永远走 api_key 语义（全项父 scope）。常量时间比较避免 timing。
    if (queryToken && sessionRow.signingKey) {
      const a = Buffer.from(queryToken);
      const b = Buffer.from(sessionRow.signingKey);
      if (a.length === b.length) {
        // crypto.timingSafeEqual 不能跨长度，用 length 预检后调用。
        try {
          const { timingSafeEqual } = await import('node:crypto');
          if (timingSafeEqual(a, b)) {
            return {
              scope: 'session_key',
              apiKeyId: `sks:${sessionRow.id}`,
              projectId: sessionRow.projectId,
            };
          }
        } catch {
          /* fall through to api_key path */
        }
      }
    }

    // 路径 1 / 3：api_key plaintext（从header或query token取）。
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
    return { scope: 'api_key', apiKeyId: row.id, projectId: row.projectId };
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

    // session row 必须在 auth 之前拿到。signing key 路径需要比对 row.signingKey。
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

    const auth = await authenticate(req, row).catch(() => null);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // session_key 路径 隐含了 project 隔离（token 与 row.signingKey 严等且 row 就是
    // 该 session），跳过 projectId 对账。api_key 路径仍需验证。
    if (auth.scope === 'api_key' && row.projectId !== auth.projectId) {
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
        if (
          clientWs.readyState === WebSocket.OPEN ||
          clientWs.readyState === WebSocket.CONNECTING
        ) {
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
