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
| @runova/cloud-sdk | workspace local（v0.11.0），prod 之后 npm 装 |
| playwright-core | 1.59.1（cloud-sdk 的 peer dep — 仅 type-only import；LaunchAI 主依赖是 `playwright`，但 pnpm isolated 模式不把内嵌 playwright-core 提到顶级 node_modules，要补装一份满足 TS 类型解析） |

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

LaunchAI 在 monorepo 之外（独立仓库），用 pnpm 的 dir-based link 直接指向 Mosaiq workspace 的源码目录（比 `--global` 稳，且不依赖 pnpm 全局 registry 状态）：

```bash
# 一次性：先在 Mosaiq 侧 build 出 cloud-sdk / persona-schema 的 dist
cd D:/projects/Mosaiq
pnpm --filter @runova/persona-schema build
pnpm --filter @runova/cloud-sdk build

# 装 link：在 LaunchAI 仓库内调用，路径指向 Mosaiq 源码目录
cd D:/projects/LaunchAI
pnpm link D:/projects/Mosaiq/packages/cloud-sdk
pnpm link D:/projects/Mosaiq/packages/persona-schema

# cloud-sdk 把 playwright-core 列为 peer dep（仅 type-only import，runtime 不 require）。
# LaunchAI 主依赖是 `playwright`，但 pnpm isolated 模式不把 playwright 内嵌的
# playwright-core 提到顶级 node_modules，TS 类型解析失败。补一份 devDep（不下载
# 浏览器二进制）：
pnpm add -D playwright-core@1.59.1
```

> **prod 之后**：`@runova/cloud-sdk` 上 npm，直接 `pnpm add @runova/cloud-sdk @runova/persona-schema` 即可。

### 2.2 写 runtime-mosaiq.ts

LaunchAI 既有 BrowserRuntime 契约（见 `src/lib/browser/types.ts`）：

- `BrowserRuntime.kind` 当前是 `'local' | 'browserbase'` — **本步要扩成 `... | 'mosaiq'`**
- `BrowserRuntime.startSession(input: StartSessionInput): Promise<ManagedBrowser>`
- `ManagedBrowser`：`{ id, runtime, page, saveStorageState(), close() }`

先改 `src/lib/browser/types.ts`：

```diff
- export type BrowserRuntimeKind = 'local' | 'browserbase'
+ export type BrowserRuntimeKind = 'local' | 'browserbase' | 'mosaiq'
```

新建 `src/lib/browser/runtime-mosaiq.ts`。要点：

- LaunchAI 主依赖是 `playwright`（不是 `playwright-core`），核心类型相通
- cloud-sdk 的 `injectInto(ctx)` 参数类型来自 playwright-core，结构兼容，cast 一下即可
- session 创建 → CDP 连接 → injectInto → goto，**顺序关键**

```typescript
import { chromium, type BrowserContext, type Page } from 'playwright'
import { nanoid } from 'nanoid'

import { MosaiqCloudClient, type ManagedCloudSession } from '@runova/cloud-sdk'

import type { BrowserRuntime, ManagedBrowser, StartSessionInput } from './types'

const REQUIRED_ENV = ['MOSAIQ_API_URL', 'MOSAIQ_API_KEY', 'MOSAIQ_PROJECT_ID'] as const
function readEnv() {
  for (const k of REQUIRED_ENV) {
    if (!process.env[k]) throw new Error(`Mosaiq runtime: missing env ${k}`)
  }
  return {
    apiUrl: process.env.MOSAIQ_API_URL!,
    apiKey: process.env.MOSAIQ_API_KEY!,
    projectId: process.env.MOSAIQ_PROJECT_ID!,
  }
}

let cachedClient: MosaiqCloudClient | null = null
function getClient(): MosaiqCloudClient {
  if (cachedClient) return cachedClient
  cachedClient = new MosaiqCloudClient(readEnv())
  return cachedClient
}

/**
 * v0.11 phase 11.1：LaunchAI 还没有 per-user persona DB，先用单一默认 persona id。
 * LaunchAI 接好 user persona DB 后改这里（参考第 4 节 Persona 来源策略）。
 */
async function resolvePersonaIdForUser(_userId: string): Promise<string> {
  const id = process.env.MOSAIQ_DEFAULT_PERSONA_ID
  if (!id) {
    throw new Error(
      'Mosaiq runtime: MOSAIQ_DEFAULT_PERSONA_ID is not set. Either set it to a ' +
        'persona id you previously POSTed to /v1/personas, or extend ' +
        'resolvePersonaIdForUser() to look up the user-specific persona.',
    )
  }
  return id
}

export const mosaiqCloudRuntime: BrowserRuntime = {
  kind: 'mosaiq',
  async startSession(input: StartSessionInput): Promise<ManagedBrowser> {
    const client = getClient()
    const personaId = await resolvePersonaIdForUser(input.userId)

    const sess: ManagedCloudSession = await client.createSession({
      persona: { id: personaId },
      stealth: { inject: true, humanize: true, rebrowserPatches: true },
      ttlSeconds: 1800,
      clientLabel: `launchai:${input.userId}:${input.platform}`,
    })

    let browser
    try {
      browser = await chromium.connectOverCDP(sess.cdpUrl, {
        headers: { Authorization: `Bearer ${client.apiKey}` },
        timeout: 30_000,
      })
    } catch (err) {
      // CDP 握手失败 → pod 这边也 wedge，先释放再 throw
      await sess.close().catch(() => undefined)
      throw err
    }

    const ctx: BrowserContext = browser.contexts()[0] ?? (await browser.newContext())

    // ⚠️ 关键：必须在任何 page.goto() 前调，否则首屏指纹是 raw chromium
    // cloud-sdk 的 BrowserContext 来自 playwright-core，与 playwright 的结构兼容
    await sess.injectInto(ctx as unknown as Parameters<typeof sess.injectInto>[0])

    if (input.storageState) {
      await ctx.addCookies(input.storageState.cookies ?? [])
      // localStorage / IndexedDB 由 browser-pod 的 user-data-dir 持久化
      // Phase 11.4 加上 sticky session 后可以彻底交给 pod
    }

    const page: Page = ctx.pages()[0] ?? (await ctx.newPage())
    if (input.startUrl) {
      await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' })
    }

    const id = `mosaiq_${nanoid(10)}`

    return {
      id,
      runtime: 'mosaiq',
      page,
      async saveStorageState() {
        const state = await ctx.storageState()
        return state as Awaited<ReturnType<ManagedBrowser['saveStorageState']>>
      },
      async close() {
        try {
          await browser.close()
        } catch {
          /* browser already disconnected; pod side cleaned up by sess.close */
        }
        await sess.close().catch(() => undefined)
      },
    }
  },
}
```

### 2.3 wire 到 BrowserRuntime 工厂

LaunchAI 现有工厂在 `src/lib/browser/runtime.ts`（已有 `'local'` / `'browserbase'` 分支），patch 加 `'mosaiq'` 分支：

```diff
  // src/lib/browser/runtime.ts
  import type { BrowserRuntime, BrowserRuntimeKind } from './types'
  import { localPlaywrightRuntime } from './runtime-local'
  import { browserbaseRuntime } from './runtime-browserbase'
+ import { mosaiqCloudRuntime } from './runtime-mosaiq'

  function resolveKind(): BrowserRuntimeKind {
    const raw = (process.env.BROWSER_RUNTIME ?? 'local').toLowerCase()
    if (raw === 'browserbase') return 'browserbase'
+   if (raw === 'mosaiq') return 'mosaiq'
    return 'local'
  }

  export function getBrowserRuntime(): BrowserRuntime {
    const kind = resolveKind()
    if (kind === 'browserbase') return browserbaseRuntime
+   if (kind === 'mosaiq') return mosaiqCloudRuntime
    return localPlaywrightRuntime
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

第一次跑前需要在控制平面注册一个 persona（v0.11 没有 seed pool，必须手工上）。Mosaiq 仓库带了一个幂等的注册脚本（重跑 → 409 duplicate 视作成功），它从 `@runova/persona-schema` 的内置模板生成 PersonaJSON 并 POST 上去：

```powershell
cd D:/projects/Mosaiq
$env:MOSAIQ_API_URL    = "http://127.0.0.1:8787"
$env:MOSAIQ_API_KEY    = "<你的 SEED_API_KEY，与 .env.cloud 一致>"
$env:MOSAIQ_PROJECT_ID = "proj_launchai"

node packages/cloud-sdk/scripts/register-persona.mjs
# → ✅ registered: id=win11-chrome-us-default source=user project_id=proj_launchai
```

把 `MOSAIQ_DEFAULT_PERSONA_ID=win11-chrome-us-default` 写进 LaunchAI `.env.local`。

> 想换其他 persona id / 模板：传 `MOSAIQ_PERSONA_ID` / `MOSAIQ_PERSONA_TEMPLATE` /
> `MOSAIQ_PERSONA_DISPLAY_NAME` / `MOSAIQ_PERSONA_SEED` 给脚本即可。详见
> `packages/cloud-sdk/scripts/register-persona.mjs` 头注释。

---

## 3. 端到端 smoke

LaunchAI 仓库提供了独立 smoke 脚本 `scripts/dev-mosaiq-smoke.ts`，不需要启 Next.js / Clerk / queue —— 直接调 `getBrowserRuntime().startSession()` 验完整链路（runtime 选择 → REST → CDP proxy → pod chromium → persona injection → navigator/screen 观察 → close）：

```bash
# T1：Mosaiq 控制平面（pod + cloud-runtime）已起，§1 那一节
# T2：persona 已注册，§2.5 那一节
# 然后：
cd D:/projects/LaunchAI
pnpm dev:mosaiq-smoke
```

期望输出（首次 chromium spawn 约 9–11s，整体 10–15s）：

```
[+    3ms] BROWSER_RUNTIME=mosaiq
[+   79ms] runtime.kind = mosaiq
[+   79ms] startSession({ userId: mosaiq-smoke-user, platform: reddit, startUrl: about:blank })
[+ 9252ms] session.id = mosaiq_xxxxxxxxxx  runtime = mosaiq
  ✅ session.runtime === 'mosaiq'
  ✅ navigator.platform == "Win32"
  ✅ navigator.languages == ["en-US","en"]
  ✅ navigator.hardwareConcurrency == 8
  ✅ navigator.deviceMemory == 8
  ✅ screen.width == 1920
  ✅ Intl.timezone == America/New_York
  ✅ userAgent contains Windows NT 10.0
  ✅ userAgent contains Chrome/130.
  ... (14 checks total)
[+10445ms] state.cookies is array
[+12097ms] done
🎉 LaunchAI ↔ Mosaiq Cloud smoke PASSED in 12.1s
```

跑通后，把 `BROWSER_RUNTIME=mosaiq` 留在 `.env.local` 里，LaunchAI 现有所有 `getBrowserRuntime()` 调用点（agent / connect:account / browser:check 等）都会自动走 mosaiq 路径，业务代码无需改。

如果挂在 `chromium.connectOverCDP` 那一步：

- 99% 是 cdp_url host 不通。控制平面在 docker 内部网络，但
  `chromium.connectOverCDP` 在 LaunchAI 进程里跑（不在 docker 里），需要走
  host 暴露的 `127.0.0.1:8787`。检查 `PUBLIC_BASE_URL` env 是否是
  `http://localhost:8787` / `http://127.0.0.1:8787`（不是 `http://cloud-runtime:8787`）

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
**最后更新**：2026-05-23（v0.11 phase 11.1 落地 + LaunchAI 端集成验收 14/14）
