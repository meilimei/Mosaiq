# @runova/cloud-sdk

> TypeScript client SDK for **Mosaiq Cloud** — managed anti-detect Chromium
> sessions over CDP-over-WebSocket. Drop-in for Playwright, Stagehand-compatible
> in v0.13+.
>
> Pairs with the open-source `@runova/sdk` (desktop / SDK side) and
> `@runova/persona-schema` (canonical persona JSON).

---

## Install

```bash
npm i @runova/cloud-sdk playwright-core
# or
pnpm add @runova/cloud-sdk playwright-core
```

`playwright-core` is a **peer dependency** — you bring your own version
(must match Mosaiq's pinned `1.59.1` for the rebrowser-patches to apply).

---

## Quickstart

```typescript
import { chromium } from 'playwright-core';
import { MosaiqCloudClient } from '@runova/cloud-sdk';

const client = new MosaiqCloudClient({
  apiUrl: 'https://api.mosaiq.dev',          // or http://localhost:8787 for dev
  apiKey: process.env.MOSAIQ_API_KEY!,        // msq_sk_live_...
  projectId: process.env.MOSAIQ_PROJECT_ID!,  // proj_xxx
});

// Create a session（持久 30 分钟，stealth 全开）
const sess = await client.createSession({
  persona: { id: 'win11-chrome-us' },         // 或 { inline: <Persona JSON> }
  stealth: { inject: true, humanize: true, rebrowserPatches: true },
  ttlSeconds: 1800,
});

// Connect Playwright over CDP
const browser = await chromium.connectOverCDP(sess.cdpUrl, {
  headers: { Authorization: `Bearer ${client.apiKey}` },
});
const ctx = browser.contexts()[0] ?? (await browser.newContext());

// 关键：必须在 page.goto 之前注入 persona JS-level spoof
await sess.injectInto(ctx);

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://example.com');
console.log(await page.evaluate(() => navigator.userAgent));

await sess.close();
```

---

## API surface

### `new MosaiqCloudClient(opts)`

```typescript
interface MosaiqCloudClientOptions {
  apiUrl: string;       // required, e.g. https://api.mosaiq.dev
  apiKey: string;       // required, msq_sk_live_...
  projectId: string;    // required, must match the API key's project
  fetchImpl?: typeof fetch;     // default globalThis.fetch
  requestTimeoutMs?: number;    // default 15_000
}
```

### `client.createSession(input)` → `ManagedCloudSession`

```typescript
interface CreateSessionInput {
  persona: { id: string } | { inline: Persona };
  stealth?: {
    inject?: boolean;            // default true
    humanize?: boolean;          // default true
    rebrowserPatches?: boolean;  // default true
  };
  ttlSeconds?: number;           // default 1800; keepAlive max 86400
  keepAlive?: boolean;           // phase 11.5: WS 断开后 pod 不销毁
  userMetadata?: Record<string, unknown>;  // stickyKey 用于跨 grooming 周期 rejoin
  viewport?: { width: number; height: number };
  clientLabel?: string;          // 审计 tag
}
```

### `client.createSessionOrRejoin(input)` → `ManagedCloudSession`

同 `createSession`，但 sticky 冲突（409 `session.sticky_conflict`）时自动 rejoin
已有 live session（用 `detail.connectUrl`），不抛错。LaunchAI grooming 路径推荐用这个。

```typescript
const sess = await client.createSessionOrRejoin({
  persona: { id: 'win11-chrome-us' },
  keepAlive: true,
  userMetadata: { stickyKey: 'launchai:user_42:reddit' },
  ttlSeconds: 86_400,
});
```

### `ManagedCloudSession`

| 方法 / 属性 | 说明 |
|---|---|
| `id` | session id (`ses_...`) |
| `cdpUrl` | `wss://api.mosaiq.dev/v1/sessions/<id>/cdp` |
| `persona` | 完整 Persona JSON（用于客户端注入 / 调试） |
| `stealth` | 服务端最终生效的 stealth opts |
| `keepAlive` | phase 11.5 flag |
| `expiresAt` | session 自动 GC 的时间 |
| **`await session.injectInto(ctx)`** | 服务端注入已默认开启时可选；inject=false 时 no-op |
| `session.disconnect()` | 只断客户端 CDP 句柄，不 DELETE pod（keepAlive grooming 周期结束用） |
| `await session.close()` | 幂等，DELETE /v1/sessions/:id 销毁 pod |

### Persona / Health 辅助

```typescript
await client.listPersonas();
await client.getPersona(id);
await client.createPersona(persona);
await client.health();           // 不需要 auth
await client.getSession(id);
await client.closeSession(id);   // 跟 session.close() 等价
```

### 错误

所有非 2xx 响应抛 `CloudApiError`：

```typescript
import { CloudApiError, type CloudErrorCode } from '@runova/cloud-sdk';

try {
  await client.createSession({ persona: { id: 'bogus' } });
} catch (err) {
  if (err instanceof CloudApiError) {
    console.error(err.code, err.httpStatus, err.message);
    // err.code: 'persona.not_found' | 'auth.invalid_key' | ... | 'transport.network' | 'transport.timeout'
  }
}
```

---

## How it works under the hood

1. `createSession` POSTs to `cloud-runtime` REST API. Control plane allocates
   a free `browser-pod` from the pool, asks pod to spawn chromium with
   persona-derived flags (`--lang`, `--window-size`, `--proxy-server`,
   `--user-agent`, etc.).
2. The pod's chromium exposes CDP on its internal port (e.g. `:9223`).
   Control plane stores the URL but **never exposes it publicly** — instead it
   gives you `wss://api.mosaiq.dev/v1/sessions/<id>/cdp` which is reverse-proxied
   by control plane (auth + audit + per-minute billing live here).
3. After `connectOverCDP`, you get a Playwright `BrowserContext`. The
   chromium-level config (UA, locale, viewport, proxy) is already applied via
   cmdline flags. JS-level spoof (navigator.* / screen / WebGL / Canvas / Audio
   noise / fonts) is injected via `injectInto(ctx)` which uses the **same
   injection script** as `@runova/sdk` desktop launcher.

---

## Versioning

| Mosaiq Cloud version | client SDK version | Notes |
|---|---|---|
| v0.11.x | `^0.11.0` | First public release. Native API only. |
| v0.13.x | `^0.13.0` | Adds Browserbase-compatible REST. |
| v0.15.x | `^0.15.0` | Adds Stripe Metered usage events on the wire. |

API breaking changes follow semver. Server-side adds are backwards compatible.

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
