# LaunchAI ↔ Mosaiq Cloud 接入手册

> 把 [LaunchAI](https://github.com/meilimei/LaunchAI) 的 `BrowserRuntime` prod 路径
> 从 stub `runtime-browserbase.ts` 切到 Mosaiq Cloud。
>
> 适用版本：Mosaiq v0.11 phase 11.1（本地 docker compose）+ LaunchAI master HEAD。

---

## 0. 前置条件

| 项 | 说明 |
|---|---|
| Node | 20.10+（LaunchAI / Mosaiq 仓库都用 nvm pin 20.18） |
| docker | 24+（Mosaiq cloud 用 docker compose 起 pod 池） |
| pnpm | 9.12+ |
| @mosaiq/cloud-sdk | workspace local（v0.11.0），prod 之后 npm 装 |

---

## 1. 启动 Mosaiq Cloud（本地）

```bash
cd D:/projects/Mosaiq

# 1.1 准备 env
cp .env.cloud.example .env.cloud
# 编辑 .env.cloud，把 SEED_API_KEY 改成自己的 32 字符随机串
# Linux/macOS:  echo "msq_sk_dev_seed_$(openssl rand -hex 12)"
# PowerShell:   "msq_sk_dev_seed_$(-join ((48..57)+(97..122) | Get-Random -Count 24 | %{[char]$_}))"

# 1.2 第一次需要 build 镜像（本地 source → docker image），以后改代码再跑会增量
docker compose --env-file .env.cloud -f docker-compose.cloud.yml up --build

# 1.3 验证起来了（在新 shell 里）
curl http://localhost:8787/v1/health
# → {"ok":true,"version":"0.11.0","machine_manager":"static","pool":{"ready":2,"busy":0,"cap":2}}
```

**期望状态**：

- 控制平面在 `:8787`
- 2 个 browser-pod 容器在 docker 内部网络（`browser-pod-1`, `browser-pod-2`），未暴露 host 端口
- `ready=2 busy=0`

如果 `ready=0`：browser-pod 没起来。`docker compose logs browser-pod-1` 看错误，常见是 chromium 缺依赖（`mcr.microsoft.com/playwright` base image 应该自带）或权限不足（确认 `--no-sandbox` 已加）。

---

## 2. LaunchAI 端 — 切到 mosaiq runtime

### 2.1 装依赖

LaunchAI 在 monorepo 之外（独立仓库），因此本地用 `npm link` 或 file-link 引用 Mosaiq workspace：

```bash
cd D:/projects/Mosaiq/packages/cloud-sdk
pnpm build
pnpm link --global

cd D:/projects/LaunchAI
pnpm link --global @mosaiq/cloud-sdk
# 同时也得 link persona-schema 因为 cloud-sdk 类型 re-export
cd D:/projects/Mosaiq/packages/persona-schema
pnpm link --global
cd D:/projects/LaunchAI
pnpm link --global @mosaiq/persona-schema

# playwright-core 是 cloud-sdk 的 peer dep，LaunchAI 已经装过
```

> **prod 之后**：`@mosaiq/cloud-sdk` 上 npm，直接 `pnpm add @mosaiq/cloud-sdk @mosaiq/persona-schema` 即可。

### 2.2 写 runtime-mosaiq.ts

新建 `src/lib/browser/runtime-mosaiq.ts`：

```typescript
import { chromium, type BrowserContext, type Page } from 'playwright-core';

import {
  MosaiqCloudClient,
  type ManagedCloudSession,
  type Persona,
} from '@mosaiq/cloud-sdk';

import type { BrowserRuntime, BrowserRuntimeStartInput, BrowserRuntimeSession } from './runtime';

/**
 * Mosaiq Cloud runtime — prod 路径。
 *
 * 与 LocalPlaywrightRuntime 的边界：
 *   - LocalPlaywright = dev only，调本机 chromium
 *   - MosaiqCloud     = prod，调远程 cloud-runtime + 远程 browser-pod
 *
 * BrowserRuntime 契约（LaunchAI/src/lib/browser/runtime.ts）：
 *   - startSession({ userId, platform, startUrl?, storageState? }) → BrowserRuntimeSession
 *   - session.page  : Playwright Page
 *   - session.saveStorageState() : 持久化 cookie
 *   - session.close()
 */

const REQUIRED_ENV = ['MOSAIQ_API_URL', 'MOSAIQ_API_KEY', 'MOSAIQ_PROJECT_ID'] as const;
function readEnv() {
  for (const k of REQUIRED_ENV) {
    if (!process.env[k]) throw new Error(`Mosaiq runtime: missing env ${k}`);
  }
  return {
    apiUrl: process.env.MOSAIQ_API_URL!,
    apiKey: process.env.MOSAIQ_API_KEY!,
    projectId: process.env.MOSAIQ_PROJECT_ID!,
  };
}

let cachedClient: MosaiqCloudClient | null = null;
function getClient(): MosaiqCloudClient {
  if (cachedClient) return cachedClient;
  cachedClient = new MosaiqCloudClient(readEnv());
  return cachedClient;
}

/**
 * LaunchAI 给 mosaiq runtime 的 persona 来源：
 *   1) 从 LaunchAI 自己的 user profile DB 读 PersonaJSON（v0.11 由前端 onboarding 绑定）
 *   2) 没有 → 用环境变量 MOSAIQ_DEFAULT_PERSONA_ID 拿一个全局 seed persona
 *
 * 这一段属于 LaunchAI 业务逻辑，下面只给 stub 接口；填充策略让 LaunchAI 自己决定。
 */
async function resolvePersonaForUser(userId: string): Promise<{
  persona?: Persona;
  personaId?: string;
}> {
  // TODO: 接 LaunchAI BrowserStorageState DB 后改这里
  // const stored = await db.userPersonas.findUnique({ where: { userId } });
  // if (stored) return { persona: stored.persona };
  if (process.env.MOSAIQ_DEFAULT_PERSONA_ID) {
    return { personaId: process.env.MOSAIQ_DEFAULT_PERSONA_ID };
  }
  throw new Error(
    `Mosaiq runtime: no persona for userId=${userId}. ` +
      'Set MOSAIQ_DEFAULT_PERSONA_ID or wire LaunchAI persona DB.',
  );
}

export const mosaiqCloudRuntime: BrowserRuntime = {
  kind: 'mosaiq',
  async startSession(input: BrowserRuntimeStartInput): Promise<BrowserRuntimeSession> {
    const client = getClient();
    const { persona, personaId } = await resolvePersonaForUser(input.userId);

    const sess: ManagedCloudSession = await client.createSession({
      persona: persona ? { inline: persona } : { id: personaId! },
      stealth: { inject: true, humanize: true, rebrowserPatches: true },
      ttlSeconds: 1800,
      clientLabel: `launchai:${input.userId}:${input.platform}`,
    });

    // playwright-core 的 connectOverCDP 支持 headers，控制平面用 Bearer 鉴权
    const browser = await chromium.connectOverCDP(sess.cdpUrl, {
      headers: { Authorization: `Bearer ${getClient().apiKey}` },
    });
    const ctx: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());

    // ⚠️ 关键：必须在任何 page.goto() 前调，否则首屏指纹是 raw chromium
    await sess.injectInto(ctx);

    // 还原 LaunchAI 之前保存的 BrowserStorageState（如果有）
    if (input.storageState) {
      await ctx.addCookies(input.storageState.cookies ?? []);
      // localStorage / IndexedDB 由 browser-pod 的 user-data-dir 持久化，
      // 这里只补 cookies。Phase 11.4 加上 sticky session 后可以彻底交给 pod。
    }

    const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
    if (input.startUrl) await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' });

    return {
      id: sess.id,
      runtime: 'mosaiq',
      page,
      async saveStorageState() {
        return ctx.storageState();
      },
      async close() {
        try {
          await browser.close();
        } catch {
          /* browser 已断 */
        }
        await sess.close();
      },
    };
  },
};
```

### 2.3 wire 到 BrowserRuntime 工厂

LaunchAI 通常有个 `getBrowserRuntime()` 函数按 `BROWSER_RUNTIME` env 选实现：

```typescript
// src/lib/browser/index.ts
import { localPlaywrightRuntime } from './runtime-local';
import { mosaiqCloudRuntime } from './runtime-mosaiq';

export function getBrowserRuntime(): BrowserRuntime {
  const kind = process.env.BROWSER_RUNTIME ?? 'local';
  switch (kind) {
    case 'mosaiq':
      return mosaiqCloudRuntime;
    case 'local':
    default:
      return localPlaywrightRuntime;
  }
}
```

### 2.4 .env.local

```text
BROWSER_RUNTIME=mosaiq
MOSAIQ_API_URL=http://localhost:8787
MOSAIQ_API_KEY=msq_sk_dev_seed_xxxxxxxxxxxxxxxxxxxxxx        # 与 .env.cloud 一致
MOSAIQ_PROJECT_ID=proj_launchai
MOSAIQ_DEFAULT_PERSONA_ID=                                   # 见 §2.5
```

### 2.5 上一个 persona 进 cloud-runtime

第一次跑前需要在控制平面注册一个 persona（v0.11 没有 seed pool，必须手工上）：

```bash
# 用任意一个 desktop 或 fixture persona JSON
PERSONA_JSON=$(cat tests/fixtures/personas/win11-chrome-us.json)

curl -X POST http://localhost:8787/v1/personas \
  -H "Authorization: Bearer $MOSAIQ_API_KEY" \
  -H "content-type: application/json" \
  -d "$PERSONA_JSON"

# → 201 { "id": "win11-chrome-us", "source": "user", "project_id": "proj_launchai" }
```

把 `MOSAIQ_DEFAULT_PERSONA_ID=win11-chrome-us` 写进 LaunchAI `.env.local`。

---

## 3. 端到端 smoke

```bash
# 三个终端：
#   T1：cd D:/projects/Mosaiq && docker compose -f docker-compose.cloud.yml up
#   T2：cd D:/projects/LaunchAI && pnpm dev
#   T3：手工触发 launch（按 LaunchAI 自己的 happy-path，例如 reddit launch）
```

观察：

1. **T1（cloud-runtime log）** —— 出现：
   ```
   [info] session created  sessionId=ses_xxx machineId=mch_xxx ttl=1800
   [info] cdp proxy: client upgraded, dialing pod
   ```
2. **T2（LaunchAI log）** —— `BrowserRuntime` 选 mosaiq + page.goto 成功
3. **手工**：在 LaunchAI 的目标网站观察 navigator.userAgent / screen 等指标，应该
   与 `MOSAIQ_DEFAULT_PERSONA_ID` 对应的 persona 一致

如果挂在 chromium connect 那一步：

- 99% 是 cdp_url host 不通。控制平面在 docker 内部网络，但
  `chromium.connectOverCDP` 在 LaunchAI 进程里跑（不在 docker 里），需要走
  host 暴露的 `127.0.0.1:8787`。检查 `PUBLIC_BASE_URL` env 是否是
  `http://localhost:8787`（不是 `http://cloud-runtime:8787`）

---

## 4. Persona 来源策略（中长期）

| 来源 | phase | 说明 |
|---|---|---|
| `inline` | 11.1 ✅ | 客户端直接传完整 Persona JSON。LaunchAI 把每个 user 的 persona 存自己 DB，每次 startSession 时拿出来 inline 进 createSession |
| `id` 引用注册 persona | 11.1 ✅ | LaunchAI 在 onboarding 时调 POST /v1/personas 注册一次，之后 startSession 只传 id |
| `filter`（按地区/OS 自动选） | 11.4 | Persona Pool Service GA 后，LaunchAI 不再自己管 persona —— 给 `{ filter: { region: 'US', os: 'win11' } }`，控制平面从 seed pool / capture pool 选最匹配的 |

LaunchAI 应该在 v0.11 用 `inline`，等 11.4 落地后切 `filter`。

---

## 5. Persona 注入和 LaunchAI BrowserStorageState 的边界

LaunchAI 现有 `BrowserStorageState` 模型：

```typescript
interface BrowserStorageState {
  cookies: Cookie[];
  localStorage?: Record<string, string>;
  indexedDb?: ...; // 实验中
}
```

切到 Mosaiq Cloud 后这个模型仍然有效，但**实际持久化层换位**：

- **cookies** —— LaunchAI 还是自己 DB 存（saveStorageState → ctx.storageState）。Mosaiq 不存 cookies
- **localStorage / IndexedDB** —— 交给 browser-pod 的 `/data/profile` user-data-dir。`docker-compose.cloud.yml` 给每个 pod 一个独立 volume，pod 重启数据保留
- **session 之间的 sticky 路由** —— v0.11 phase 11.1 没有 sticky，每次 startSession 拿哪个 pod 是 round-robin 的。这意味着同 (userId, platform) 的两次 startSession **可能拿到不同 pod**，IndexedDB / Service Worker 不连续

**解决方案**：

- v0.11 phase 11.1：LaunchAI 把关键状态（cookie + 关键 localStorage 项）走 BrowserStorageState 走自己 DB，不依赖 pod-side 持久化
- v0.13 phase 11.3：Mosaiq Cloud 加 `keep_alive: true` + sticky 路由（同 sessionId 永远同 pod，pod 闲置不立即回收）

---

## 6. 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| `MosaiqCloudClient: missing env MOSAIQ_API_KEY` | LaunchAI 没读 .env.local | 检查 next.config / vite config 是否 expose env 给 server-side |
| `CloudApiError(transport.network)` | docker 没起来 / 端口被占 | `curl localhost:8787/v1/health` 验证 |
| `CloudApiError(auth.invalid_key)` | LaunchAI .env.local 的 SEED_API_KEY 与 cloud-runtime 不一致 | docker compose down + 改 .env.cloud + up |
| `chromium.connectOverCDP` 挂 30s 然后 timeout | cdp_url 用了 `cloud-runtime` hostname（仅 docker 内可达） | PUBLIC_BASE_URL 设 `http://localhost:8787` |
| navigator.userAgent 仍是 raw chromium | session.injectInto() 没在 page.goto 前调 | 顺序：`browser=connectOverCDP → ctx=contexts[0] → injectInto(ctx) → ctx.newPage() → page.goto` |
| pod busy 第二个 session 拿不到 → `pool.exhausted` | 两个 pod 都被先前请求占了 | 关掉旧 session 或 docker-compose.yml 里加 `browser-pod-3/4` |

---

## 7. 后续路标

| 时间点 | 我能跑什么 |
|---|---|
| **v0.11 phase 11.1（now）** | LaunchAI dev 切 `BROWSER_RUNTIME=mosaiq`，1 个 user 在本机端到端 |
| **v0.12 phase 11.2** | LaunchAI prod env 切 `MOSAIQ_API_URL=https://api.mosaiq.dev`（Fly 部署） |
| **v0.13 phase 11.3** | Stagehand 接入：LaunchAI 内部别处用 Stagehand 时只改 apiUrl，不改 runtime |
| **v0.14 phase 11.4** | persona filter（不再 hand-pick `MOSAIQ_DEFAULT_PERSONA_ID`） |
| **v0.15 phase 11.5** | Stripe metered 计费：LaunchAI 知道每 user 用了多少 browser-min |

---

**owner（Mosaiq 侧）**：cloud infra
**owner（LaunchAI 侧）**：browser runtime maintainer
**最后更新**：2026-05-22（v0.11 phase 11.1 落地）
