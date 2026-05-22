# @mosaiq/browser-pod

Mosaiq Cloud — per-session browser pod.

启一个 Node HTTP 控制端 (`:9222`)，按控制平面指令 spawn chromium 子进程
(`:9223` CDP)，把 webSocketDebuggerUrl 回吐给控制平面。

> **状态**：v0.11 phase 11.1。容器镜像基于 `mcr.microsoft.com/playwright:v1.59.1-noble`。

---

## 端点

```
GET  /healthz              { ok, busy, machineId, pid }
POST /control/start        { sessionId, persona, stealth, viewport?, ttlSeconds }
POST /control/stop         { machineId }
```

`/control/start` 返回：

```json
{
  "machineId": "mch_xxx",
  "cdpUrl": "ws://localhost:9223/devtools/browser/<uuid>"
}
```

控制平面拿到这个 URL 后会用 `static.ts` 的 `rewriteCdpHost()` 把 `localhost`
换成 pod 的可路由 host（例 `browser-pod-1`）。

---

## 本地起跑（无 docker）

```bash
# 先确保 chromium 装了
npx playwright install chromium

cd apps/browser-pod
pnpm install
pnpm dev
# → 控制端 :9222，等控制平面调 /control/start 才会真的起 chromium
```

或者 docker compose 起跑：

```bash
docker compose -f docker-compose.cloud.yml up browser-pod-1
```

---

## persona → chromium flags

参考 `src/persona-flags.ts`。

| persona 字段 | chromium flag |
|---|---|
| `system.languages[0]` | `--lang=` |
| `system.screen.width/height` | `--window-size=` |
| `network.proxy` | `--proxy-server=` |
| `fingerprint.webrtc.mode === 'proxy_only'` | `--force-webrtc-ip-handling-policy=...` |

JS-level 注入（navigator/screen/WebGL noise/Canvas noise）由客户端
`@mosaiq/cloud-sdk` 在 `connectOverCDP` 后调 `addInitScript` —— 这与 desktop
`@mosaiq/sdk` `launchPersona` 走的是同一份注入脚本。

---

## 限制

- 单 session：同一 pod 同一时刻只能跑一个 chromium。控制平面通过
  `static.ts` 的 busy 标记实现互斥。多 session 跑多 pod。
- TTL 看门狗：`spawnChromium` 设了一个 `ttlSeconds * 1000` 的 timer，
  `setTimeout` 触发 SIGTERM。控制平面正常关闭走 `/control/stop`。

---

## License

Apache-2.0.
