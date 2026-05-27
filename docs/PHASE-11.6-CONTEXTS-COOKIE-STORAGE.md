# Phase 11.6 — Browserbase Contexts API（跨 session 持久化 cookie / IndexedDB / localStorage）

> 目标：让用户**一次登录、多次复用**——把整个 chromium `--user-data-dir`（cookies + localStorage + IndexedDB + ServiceWorker + sessionStorage + form autofill + 浏览器 prefs）抽成可命名、可复用、可删除的 `Context` 资源；新 session 通过 `browserSettings.context.{ id, persist }` 把 context 装载到 pod，session 关闭时（如果 persist=true）反向把 user-data-dir 快照回 context 存储。
>
> **与 phase 11.5 keepAlive 的区别**：keepAlive 让单一 session 跨 WS 重连保持 pod 不死；contexts 让**不同的 session**（不同 sessionId、不同时间、可能不同地理位置）共享同一份持久化 user 状态。两者是互补的——LaunchAI 这种"几小时跑一次 grooming"场景适合 contexts；"一个连续 8h agent loop 中间断 WS"适合 keepAlive。

| 维度 | 决策 |
|---|---|
| Scope | 11.6a：实现 BB Contexts API 100% surface（POST/DELETE `/v1/contexts` + `browserSettings.context`），fs storage backend，AES-GCM encryption at rest，pod side download/snapshot 走 `/control/start` 体内的 signed URL |
| Out-of-scope（→ 11.6b） | S3/R2 backend、cross-region context replication、context partial update（仅个别 cookie）、context import/export from external auth state |
| 安全 invariant | (1) Context 内容只对创建它的 `projectId` 可见——同 customer 的所有 sessions 都能 reuse；跨 customer 不可读不可写。(2) Plaintext tarball 不落本地磁盘——AES-GCM 加密 with per-project HKDF 派生 key + master KMS key 掌握在 fly secrets。(3) Pod 拉取 / 推送 contexts 的 URL 用 HMAC 签 5 min 短窗，过期不可重放。 |
| 一致性 invariant | 一个 context 同一时刻最多被 1 个 live session 持有（match BB）；并发尝试 → 409 `context.in_use`。Snapshot 仅在 DELETE w/ persist=true 路径触发——TTL/idle/crash 路径不写回，context 停在最后一次成功 snapshot |
| 与 keepAlive 互动 | keepAlive=true + context=present 合法。`active_session_id` 在 keepAlive session 期间持续锁定 context；DELETE 触发最终 snapshot + 释放。WS reconnect 不重新 load context（pod 没销毁）也不写回（still 持有锁）。 |
| 性能预期 | Empty context load < 50ms；populated context（典型 5–20MB compressed） load < 2s；snapshot < 3s。Cold acquire + context load 总 < 40s（与 phase 11.3a baseline 持平 + 1–2s context overhead） |
| 实现工作量 | 5 commits + cross-repo smoke，**5–7 天**（Mosaiq 侧），LaunchAI 侧 follow-up ~3h（改 runtime-mosaiq.ts 创建 + reuse context） |

---

## 1. 用户场景与产品定位

### 1.1 LaunchAI Reddit 场景（驱动用例）

```
Day 1, 00:00 UTC — 首次 grooming
  user.create_context() → ctx_redditUser123
  user.create_session({ context: { id: ctx_redditUser123, persist: true } })
  // user-data-dir 空，chromium fresh boot
  // 自动化登录 Reddit（用户预先填的 username + password）
  // 跑 7 个动作（upvote / comment / save 等）
  // session.delete() → snapshot user-data-dir back to ctx_redditUser123
  // pod destroyed

Day 1, 08:00 UTC — 第二次 grooming（同 user）
  user.create_session({ context: { id: ctx_redditUser123, persist: true } })
  // pod boot → download ctx_redditUser123 tarball → extract to user-data-dir
  // chromium 启动，**已登录**（cookie + localStorage + IDB 都还在）
  // 跑下一批动作
  // session.delete() → snapshot back

Day 30 — 用户取消订阅
  user.delete_context(ctx_redditUser123) → tarball 物理删除
```

**关键收益**：LaunchAI 不再需要每次跑都做完整的 Reddit 登录（包括 captcha / 2FA / device verification 等阻塞步骤）；Reddit 那边看到的也是同一个稳定的 device fingerprint + session cookie，**可信度评分**显著高于"每次新登录"。

### 1.2 vs phase 11.5 keepAlive 的对比

| 维度 | phase 11.5 keepAlive | phase 11.6 contexts |
|---|---|---|
| 跨什么持久化 | 单 sessionId 内的 WS 重连 | 跨不同 sessionId（不同时间） |
| Pod 生命周期 | 永远不死（24h ceiling）| 每 session 启停一次（match keepAlive=false 默认） |
| 成本 | 5 keepAlive × $1.9/天 = $9.5/天/customer | 0（pod 不长期运行）+ 存储 (~$0.05/GB/mo on fly volume) |
| 适用 | 连续 agent loop（hours）、长 transactions | 周期性任务（daily / weekly grooming）、登录后的多次访问 |
| LaunchAI 用法 | grooming 中途断网恢复 | grooming 之间复用登录态 |
| 最大窗口 | 24h（一个 session 内）| 永久（context 不过期 unless 用户 delete） |

**两者可叠加**：keepAlive=true + context=ctx_X = "本 session 内不死 + 跨 session 复用 cookie"。LaunchAI 实际不太用得到 keepAlive，contexts 是更核心的诉求。

### 1.3 PRD 侧映射

PRD §3.1b row "Cookie Jar 真隔离"（Desktop chromium fork P0）→ Cloud 侧的对应实现就是 contexts。Stagehand 用户对此有重度依赖（[BB doc 列表](https://docs.browserbase.com/features/contexts) 把它列为 P1 feature）。

PRD §3 Cloud tier 定价：
- **Hobby** $29/mo：max 5 contexts（cap on `contexts_per_project_max`）
- **Pro** $99/mo：max 50 contexts
- **Scale** $499/mo：max 500 contexts
- **Enterprise**：定制

phase 11.6a 用单一 env knob `MOSAIQ_CONTEXTS_PER_PROJECT_MAX`（默认 100，覆盖 Hobby/Pro），按 customer 升降；分 tier 的差异化定价交给 phase 11.7 stripe metering 接管。

---

## 2. Browserbase Contexts API 契约

来源：https://docs.browserbase.com/features/contexts（2026-05-27 抓取）

### 2.1 Endpoint surface（仅 3 个）

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/v1/contexts` | `{}`（空） | `201 { id: "ctx_..." }` |
| `DELETE` | `/v1/contexts/{id}` | — | `204 No Content` |
| `POST` | `/v1/sessions` | `{ browserSettings: { context: { id: "ctx_...", persist: true } } }` | 同 phase 11.4 shape，session 用该 context 启动 |

注意 BB 没有 `GET /v1/contexts` 列表 endpoint（也没有 `/v1/contexts/{id}` 详情），客户自己负责存 context id。我们先 100% match，列表 endpoint 留给 11.6b（如果用户呼声大）。

### 2.2 `browserSettings.context` 子结构

```typescript
{
  id: string;          // ctx_xxxx，必填
  persist: boolean;    // 默认 true（BB），false = 只读模式
}
```

`persist: false` 语义：context 数据装载进 pod，但 session 关闭时**不**写回。用于"我想看看上次的状态但不想覆盖"的只读场景。我们 100% match。

### 2.3 What does a Context store

按 BB doc 列表，context tarball 应当包含 chromium `--user-data-dir` 下的：

| 项 | 子路径 | 重要性 |
|---|---|---|
| Cookies | `Default/Cookies` (sqlite) + `Default/Cookies-journal` | 必须 |
| Local Storage | `Default/Local Storage/leveldb/` | 必须 |
| IndexedDB | `Default/IndexedDB/<origin>/...` | 必须（LaunchAI Reddit / X 强依赖） |
| Session Storage | `Default/Session Storage/leveldb/` | 高 |
| Service Workers | `Default/Service Worker/Database/` + `Default/Service Worker/ScriptCache/` | 中 |
| Form autofill | `Default/Web Data` (sqlite) | 中 |
| 浏览器 prefs | `Default/Preferences` + `Local State` | 低（HSTS / 权限授予） |
| Cache | `Default/Cache/`、`Default/Code Cache/` | **排除**（GB 级且仅性能优化） |

**实施**：tar 时**排除** `Cache/`、`Code Cache/`、`GPUCache/`、`File System/`（Chromium 自重建），只保留上面表里的目录。预期典型 size 5–20MB compressed，重度 IDB 用户最多 ~50–100MB。

---

## 3. 设计决策

| # | 问题 | 选项 | 默认建议 |
|---|---|---|---|
| 1 | Storage backend | (a) fs only (b) S3/R2 only (c) pluggable interface, fs default 11.6a, S3 11.6b | **(c)** —— 同 MachineManager interface 套路；接口稳定，加 S3 impl 不动调用方 |
| 2 | 加密 at rest | (a) plaintext on encrypted volume (b) AES-GCM per-project HKDF, master in fly secrets (c) defer to 11.6b | **(b)** —— context 含 user creds（Reddit cookies、X auth tokens），plaintext 落盘有 PR 风险；AES-GCM ~30 LOC，master key rotation 也通过 fly secrets 直接做 |
| 3 | Pod ↔ runtime tarball 传输 | (a) inline base64 in `/control/start` body（HTTP body 限制 + 内存浪费）(b) signed URL for download / upload，pod self-fetch（要 internal endpoint）(c) shared volume mount（Fly volume 不能跨 machine 共享，技术上不可行） | **(b)** —— pod GET signed URL → 流式 untar，pod 完成后 PUT signed URL → 流式 tar；cloud-runtime 暴露 `/v1/_internal/contexts/{id}/{download\|snapshot}?token=hmac(...)`，HMAC 签 5min 短窗 |
| 4 | Context-session 锁 | (a) 1:1 强锁（match BB），并发 409 (b) N:1（多 session 共享 read-only），写时锁 (c) 不锁，最后写赢 | **(a)** —— BB 行为；同 sessionId 重复 (= keepAlive reconnect) 不算锁冲突，因为 active_session_id 还是同一个 |
| 5 | Snapshot 时机 | (a) 仅 graceful DELETE w/ persist=true (b) 也覆盖 TTL/idle reaper 路径 (c) 周期性自动 snapshot | **(a)** —— BB 行为；reaper 路径 chromium 进程已被 SIGKILL，user-data-dir 状态不一致，不应 snapshot；用户自负责"我没 DELETE 就丢更新" |
| 6 | Quota | (a) 不限 (b) MOSAIQ_CONTEXTS_PER_PROJECT_MAX=100 + MOSAIQ_CONTEXT_SIZE_MAX_MB=200 (c) 多档 plan-aware | **(b)** —— 100 contexts × 50MB avg = 5GB/project，单 fly volume 100GB 容下 20 projects；超 size 直接 reject snapshot 并 keep 旧版本（pod 收到 413 → 降级为 persist=false） |
| 7 | persist 默认值 | (a) `true`（match BB）(b) `false`（保守） | **(a)** —— BB 默认；用户主动选 `persist: false` 表"只读模式"，隐式 persist=true 才是直觉 |
| 8 | 编解码 + 压缩 | (a) tar 不压缩（大）(b) tar.gz（标准）(c) tar.zst（更小更快） | **(c)** —— zstd 比 gzip 压缩率高 ~30%、解压快 2-3x；node 有 `zstd` 原生绑定（`@hpcc-js/wasm-zstd` 或 `simple-zstd`），pod 镜像加这一个二进制约 1MB |
| 9 | "context not found" 行为 | (a) 创 session 直接 404 (b) 自动创 context fresh + 装载 (c) warn 但允许（fresh fallback） | **(a)** —— context 是用户显式创建的资源；找不到要么是 typo 要么被 delete 了，自动 fallback 会掩盖 bug；BB 也是 404 |

---

## 4. 数据模型

### 4.1 新表 `contexts`

```sql
CREATE TABLE contexts (
  id TEXT PRIMARY KEY,                    -- 'ctx_<22 char base58>'
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- 存储后端：phase 11.6a 仅 'fs'，11.6b 加 's3'
  storage_backend TEXT NOT NULL DEFAULT 'fs',
  -- backend-specific 路径：fs = '/data/contexts/ctx_xxx.tar.zst.enc'，s3 = 'bucket/path/key'
  storage_key TEXT NOT NULL,

  -- 加密 metadata：算法 + IV/nonce（key 自身派生自 master KMS + projectId，不存）
  enc_algo TEXT NOT NULL DEFAULT 'aes-256-gcm',
  enc_nonce BLOB,                         -- 12 bytes for GCM；NULL 表示 empty context（no payload）

  -- 当前快照尺寸（解压前 .tar.zst.enc 的字节数），observability + quota
  bytes INTEGER,

  -- 锁定：active_session_id 不为 NULL = context 正被某 session 持有
  active_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  active_session_acquired_at TEXT,

  -- 生命周期戳
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_snapshot_at TEXT,                  -- NULL 表示从未 snapshot 过（empty context）
  deleted_at TEXT                         -- soft delete，blob 异步 GC（11.6b 加 GC job）
);

CREATE INDEX IF NOT EXISTS contexts_project_idx ON contexts (project_id);
CREATE INDEX IF NOT EXISTS contexts_active_session_idx ON contexts (active_session_id) WHERE active_session_id IS NOT NULL;
```

**为啥 `active_session_id` 用 FK 而不是单独 lock 表**：
- 数据库强制：`ON DELETE SET NULL` 保证 session 异常 close 时锁自动清掉，不需要额外 reconciliation job
- 单 row 更新原子（与 sessions.context_id 同事务），避免分布式锁
- 部分 index 只索引 active 行，写入开销低

### 4.2 `sessions` 表新增列

```sql
ALTER TABLE sessions ADD COLUMN context_id TEXT REFERENCES contexts(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN context_persist INTEGER NOT NULL DEFAULT 0;  -- bool: snapshot back on close?
```

shapeSession 把 `context_id` 映射到 BB-compat `contextId` 字段（之前是 stub `null`，phase 11.6 起回真值）。

---

## 5. 端点详细设计

### 5.1 `POST /v1/contexts`

```http
POST /v1/contexts
Content-Type: application/json
X-BB-API-Key: msq_sk_live_...

{}
```

**Behavior**：
1. 鉴权：通过 phase 11.4 dual-shape auth middleware，从 API key 推 `projectId`
2. Quota：count active contexts for projectId（`deleted_at IS NULL`）≥ `MOSAIQ_CONTEXTS_PER_PROJECT_MAX` → 429 `pool.contexts_saturated`
3. 创建 row：`id=newId('ctx')`、`storage_backend='fs'`、`storage_key='ctx_xxx.tar.zst.enc'`（相对路径）、`bytes=NULL`（empty）、其他默认
4. 不预分配 blob —— 第一次 snapshot 时才写盘
5. 返回 `201 { id, projectId, createdAt }`（BB 只返 id；我们 superset，便于客户 debug）

### 5.2 `DELETE /v1/contexts/{id}`

```http
DELETE /v1/contexts/ctx_abc123
X-BB-API-Key: msq_sk_live_...
```

**Behavior**：
1. 鉴权 + project 归属校验（不属于本 project → 404，不区分 not-found vs forbidden，避免枚举）
2. `active_session_id` 不为 NULL → 409 `context.in_use`，detail 含 `activeSessionId`
3. soft delete：`deleted_at=now()`；blob 不立即 unlink（让 in-flight read 安全完成）
4. 返回 `204 No Content`
5. 后台：phase 11.6a 不带 GC job，blob 物理删交给 11.6b。soft-deleted 行不计入 quota

### 5.3 `POST /v1/sessions { browserSettings: { context: ... } }`

扩展 phase 11.4 的 `BrowserSettingsSchema`：

```typescript
const ContextRequestSchema = z.object({
  id: z.string().regex(/^ctx_[A-Za-z0-9]{22}$/),
  persist: z.boolean().default(true),  // BB 默认 true
});

const BrowserSettingsSchema = z.object({
  viewport: ViewportSchema.optional(),
  context: ContextRequestSchema.optional(),  // ← 新增
}).passthrough();
```

**Behavior**：phase 11.4 + 11.5 路径之上：
1. 解析 `req.browserSettings?.context?.id`
2. 校验 context 存在 + 属于本 project + 未 soft-delete → 否则 404 `context.not_found`
3. 校验未被锁 → 否则 409 `context.in_use { activeSessionId, expectedAvailableAt }`
4. 计算 signed download URL：`${BASE_URL}/v1/_internal/contexts/${ctxId}/download?token=${hmac(ctxId+expiresAt+secret)}`
5. 把 `contextLoadUrl` + `contextLoadKeyId=projectId` 加进发给 pod 的 `/control/start` body（pod 用 keyId 派生 AES key）
6. acquire pod 之后，原子更新：`UPDATE contexts SET active_session_id=?, active_session_acquired_at=now WHERE id=? AND active_session_id IS NULL`（OCC，affected rows=0 → 409）
7. 同时把 `context_id` + `context_persist` 落到 sessions 表
8. shapeSession 返回 contextId 真值

### 5.4 `DELETE /v1/sessions/{id}` 的 context 处理

phase 11.5 commit 4 已经处理了 sticky eviction + sessionsClosedTotal 计数。phase 11.6 在 hold:false 销毁路径前**插入 snapshot**：

```typescript
// 伪代码，commit 5 实现
if (row.contextId && row.contextPersist) {
  // 1. 计算 signed snapshot URL
  const snapshotUrl = signSnapshotUrl(row.contextId, projectId);
  // 2. 调 pod /control/stop 时附带 snapshotUrl，pod 内部走"先 snapshot 再 kill"
  await mm.releaseWithSnapshot(machineId, { hold: false, snapshotUrl });
  // 3. snapshot URL handler 已经把 blob 落盘 + 更新 contexts.bytes / last_snapshot_at
}

// 4. 释放 lock（即使 snapshot 失败也要释放）
await db.update(contexts)
  .set({ active_session_id: null, active_session_acquired_at: null })
  .where({ id: row.contextId });
```

**关键 invariant**：lock 释放与 snapshot 失败解耦。snapshot 失败（pod tar 失败 / network / 413 size limit）→ lock 仍释放，context 停在上次成功 snapshot。响应里加 warning 字段 `snapshotFailed: true` 让客户感知。

### 5.5 内部端点 `/v1/_internal/contexts/{id}/{download|snapshot}`

Pod 调用专用，不属于公开 API surface（不在 OpenAPI 描述里）。

```
GET  /v1/_internal/contexts/{id}/download?token={hmac}
  → 200 + binary stream of /data/contexts/{ctxId}.tar.zst.enc
  → 404 if not found / deleted
  → 401 if token invalid / expired

PUT  /v1/_internal/contexts/{id}/snapshot?token={hmac}
  Content-Type: application/octet-stream
  Body: encrypted tar.zst stream
  → 204 on success（同时 update bytes / last_snapshot_at）
  → 413 if size > MOSAIQ_CONTEXT_SIZE_MAX_MB
  → 401 if token invalid / expired
```

**Token 格式**：HMAC-SHA256(`MOSAIQ_INTERNAL_HMAC_SECRET`, `${ctxId}|${op}|${expiresAtUnix}`)。token 编码 `${expiresAt}.${hex(hmac)}`。Pod 验签时同时校验 expiresAt。

**为啥不用 cloud-runtime 的标准 API key**：pod 不应当持有客户 API key（pod 是内部 component，密钥泄漏面应当为 0）。用 fly secrets 注入 internal HMAC，与外部 auth 完全解耦。

---

## 6. Pod runtime 改动（`apps/browser-pod`）

### 6.1 `/control/start` 入参扩展

```typescript
// 现有 schema + phase 11.6 新字段
const StartSchema = z.object({
  // ... 现有字段
  // ── phase 11.6 ──
  context: z.object({
    /** signed URL，pod GET 拿 encrypted tarball */
    loadUrl: z.string().url(),
    /** AES key derivation 用的 project id（与 master KMS 派生 per-project key）*/
    projectId: z.string().min(1),
    /** 加密算法 */
    encAlgo: z.literal('aes-256-gcm'),
    /** GCM nonce，cloud-runtime 在 download response header 里附带 */
  }).optional(),
});
```

### 6.2 `/control/stop` 入参扩展

```typescript
const StopSchema = z.object({
  machineId: z.string().min(1),
  // ── phase 11.6 ──
  /** 非空 → snapshot user-data-dir 到此 URL（PUT），完成后再 kill chromium */
  snapshot: z.object({
    uploadUrl: z.string().url(),
    projectId: z.string().min(1),  // for AES key derive
    encAlgo: z.literal('aes-256-gcm'),
  }).optional(),
});
```

### 6.3 chromium 启动前：context load 流程

```typescript
// apps/browser-pod/src/context-load.ts (新文件)
async function loadContext(input: ContextLoadInput, userDataDir: string): Promise<void> {
  // 1. GET signed URL，stream 进 buffer（or pipe to file）
  const resp = await fetch(input.loadUrl);
  if (resp.status === 404) {
    log.warn('context blob 404 — empty context, skipping load');
    return;
  }
  if (!resp.ok) throw new Error(`context load failed: ${resp.status}`);
  
  // 2. 解密：AES-256-GCM with key=HKDF(MASTER_KEY, projectId)
  const nonce = resp.headers.get('x-mosaiq-context-nonce');
  const encrypted = await resp.arrayBuffer();
  const decrypted = await aesGcmDecrypt(encrypted, deriveKey(input.projectId), nonce);
  
  // 3. zstd 解压 → tar 解包到 userDataDir
  const tarball = zstdDecompress(decrypted);
  await tarExtract(tarball, userDataDir);
  
  log.info({ bytes: encrypted.byteLength }, 'context loaded');
}
```

`spawnChromium` 在 mkdir userDataDir 之后、buildChromiumFlags 之前加：

```typescript
if (input.context) {
  await loadContext(input.context, sessionUserDir);
}
```

### 6.4 chromium kill 后：snapshot upload 流程

`killChromium` 现有逻辑：SIGTERM → wait 5s → SIGKILL → user-data-dir cleanup。

phase 11.6 在 SIGKILL 之后、`rm sessionUserDir` 之前插入 snapshot：

```typescript
async function snapshotContext(input: SnapshotInput, userDataDir: string): Promise<void> {
  // 1. tar 子进程：tar -cf - <userDataDir> --exclude='Default/Cache' --exclude='Default/Code Cache' ...
  const tarStream = spawn('tar', ['-cf', '-', '-C', userDataDir, '.', /* excludes */]);
  
  // 2. zstd 压缩
  const zstdStream = tarStream.stdout.pipe(zstdCompress());
  
  // 3. AES-GCM 加密 + 收 buffer（先全部加密再 PUT，避免分块流式加密的复杂度，预期 5-50MB 可接受）
  const plaintext = await streamToBuffer(zstdStream);
  if (plaintext.length > MAX_SIZE_BYTES) throw new Error('context too large');
  const { encrypted, nonce } = aesGcmEncrypt(plaintext, deriveKey(input.projectId));
  
  // 4. PUT 到 signed URL
  const resp = await fetch(input.uploadUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'x-mosaiq-context-nonce': nonce.toString('hex'),
    },
    body: encrypted,
  });
  if (resp.status === 413) {
    log.warn({ bytes: encrypted.length }, 'snapshot rejected: too large');
    return; // 不抛，让 kill 流程继续；cloud-runtime 已收到 413 不会 update last_snapshot_at
  }
  if (!resp.ok) throw new Error(`snapshot PUT failed: ${resp.status}`);
}
```

**错误隔离**：snapshot 失败**不阻止** chromium kill 完成（pod 必须返回 204 给 cloud-runtime）。日志报警 + cloud-runtime 收 PUT 失败时在 DELETE 响应里附 `snapshotFailed: true`。

### 6.5 加密 helpers（共享 lib）

新建 `packages/cloud-crypto`（or 直接在 cloud-runtime + browser-pod 各放一份相同代码）。核心 ~40 LOC：

```typescript
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const NONCE_LEN = 12;

export function deriveKey(masterKey: Buffer, projectId: string): Buffer {
  // HKDF-SHA256: master_key + projectId → per-project 32-byte key
  // info='mosaiq-ctx-v1' 让 future protocol bump 不撞 key
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from(projectId), 'mosaiq-ctx-v1', KEY_LEN));
}

export function encrypt(plaintext: Buffer, key: Buffer): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();  // 16 bytes
  return { ciphertext, nonce, tag };
}

export function decrypt(ciphertext: Buffer, key: Buffer, nonce: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

存盘格式：`[nonce(12)][tag(16)][ciphertext]`，单文件无需外部 metadata（除 contexts.enc_nonce 不存了，nonce 写在 blob 头部）。

---

## 7. 实施计划

### Commit 1：schema + env + storage interface（foundation）

**文件**：
- `apps/cloud-runtime/src/db/schema.ts` —— 加 `contexts` 表 drizzle 定义；`sessions` 加 `contextId` + `contextPersist`
- `apps/cloud-runtime/src/db/bootstrap.ts` —— 加 contexts 表 CREATE + sessions 列 ALTER 进 `COLUMN_ADDITIONS`；contexts indexes 进 `INDEX_ADDITIONS`（**严格遵守 phase 11.5 commit 6 学到的迁移顺序教训**）
- `apps/cloud-runtime/src/env.ts` —— 加 `MOSAIQ_CONTEXTS_PER_PROJECT_MAX=100`、`MOSAIQ_CONTEXT_SIZE_MAX_MB=200`、`MOSAIQ_CONTEXT_STORAGE_PATH=/data/contexts`、`MOSAIQ_CONTEXT_MASTER_KEY=`（fly secret，base64 32 bytes）、`MOSAIQ_INTERNAL_HMAC_SECRET=`（fly secret）
- `apps/cloud-runtime/src/contexts/storage.ts` —— `interface ContextStorage { read(key): Stream; write(key, stream): Promise<bytes>; delete(key): Promise<void> }` + `FsContextStorage` impl
- `apps/cloud-runtime/src/contexts/storage.test.ts` —— FsContextStorage 单测
- `apps/cloud-runtime/src/utils/crypto.ts`（or `packages/cloud-crypto`）—— deriveKey / encrypt / decrypt
- `apps/cloud-runtime/src/utils/crypto.test.ts` —— round-trip + tamper detect
- `apps/cloud-runtime/src/db/bootstrap.test.ts` —— 加 upgrade-path regression test 仿 phase 11.5 commit 6

**测试基线**：217 + ~8 = 225

### Commit 2：POST/DELETE `/v1/contexts` endpoints

**文件**：
- `apps/cloud-runtime/src/routes/contexts.ts` —— Hono router
- `apps/cloud-runtime/src/routes/contexts.test.ts`
- `apps/cloud-runtime/src/utils/errors.ts` —— 加 `pool.contexts_saturated`、`context.not_found`、`context.in_use` 三个 code
- `apps/cloud-runtime/src/app.ts` —— mount contextsRoute under `/v1/contexts`

**测试**：~10 个（POST 创、DELETE 软删、quota 429、project 归属 404、in_use 409、auth 失败）

**验收基线**：225 + 10 = 235

### Commit 3：pod runtime context load + snapshot

**文件**：
- `apps/browser-pod/src/app.ts` —— StartSchema / StopSchema 扩展 context 字段
- `apps/browser-pod/src/context-io.ts` —— loadContext + snapshotContext（GET + tar 解包；tar + PUT）
- `apps/browser-pod/src/context-io.test.ts` —— 用本地 echo server + tmp dir
- `apps/browser-pod/src/chromium.ts` —— spawnChromium 集成 loadContext；killChromium 集成 snapshotContext
- `apps/browser-pod/src/env.ts` —— 加 `POD_CONTEXT_MASTER_KEY`、`POD_INTERNAL_HMAC_SECRET`（与 cloud-runtime fly secrets 同源）
- `apps/browser-pod/src/persona-flags.ts` —— 不变
- `apps/browser-pod/Dockerfile` —— 装 `tar`（已有）+ `zstd`（apt-get install zstd）

**测试**：~6 个（load empty 404、load happy path、load size > limit、snapshot happy、snapshot 413、snapshot 网络失败 graceful）

**验收基线**：235 + 6 = 241

### Commit 4：cloud-runtime POST `/v1/sessions browserSettings.context` 集成

**文件**：
- `apps/cloud-runtime/src/routes/sessions.ts` —— `BrowserSettingsSchema` 加 context；POST 路径加 context lock/load/route；DELETE 路径加 snapshot trigger（先打通 happy path，commit 5 完善 persist=false 路径与 metrics）
- `apps/cloud-runtime/src/routes/_internal-contexts.ts` —— `/v1/_internal/contexts/{id}/{download,snapshot}` handlers + HMAC verify
- `apps/cloud-runtime/src/routes/_internal-contexts.test.ts`
- `apps/cloud-runtime/src/machine/types.ts` —— `MachineManager.release(id, opts: { hold, snapshotUrl?: ... })` 扩展 opts
- 各 MachineManager 实现（static / local-docker / fly / fly-pool）—— 把 snapshotUrl 透传给 pod /control/stop body
- `apps/cloud-runtime/src/routes/sessions.test.ts` 加 ~6 个 context 集成测试

**测试**：~10 个

**验收基线**：241 + 10 = 251

### Commit 5：metrics + smoke + docs + persist=false 收尾

**文件**：
- `apps/cloud-runtime/src/metrics.ts` —— 加 `contexts_active{project_id}` gauge、`context_snapshot_bytes` histogram、`context_load_duration_seconds`、`context_snapshot_duration_seconds`、`contexts_total{op=create|delete|snapshot|load,outcome=success|failed}`
- `apps/cloud-runtime/src/routes/metrics.ts` —— scrape 时刷 contexts_active gauge
- `scripts/contexts-persist-smoke.mjs` —— 新建：(1) bb.contexts.create() (2) session1: login 模拟（write cookie + IDB）→ DELETE w/ persist=true (3) session2: 同 contextId → page.evaluate read cookie + IDB → 字节级断言相等
- `docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md` —— 本 doc，§7 实测填表
- `docs/PHASE-11.4-STAGEHAND-COMPAT.md` —— Contexts API 行从 `❌ phase 11.6` 改 `✓ phase 11.6`，加 back-link
- `apps/cloud-runtime/README.md` —— 限制列表删 contexts 一条；BB compat 段说"phase 11.6 起 honored"
- `README.md` 顶部 cloud quickstart 加 contexts 例子

**验收基线**：251 + ~3 = 254（smoke 不算单测）

### 部署 + verify

- `flyctl secrets set MOSAIQ_CONTEXT_MASTER_KEY=$(openssl rand -base64 32) MOSAIQ_INTERNAL_HMAC_SECRET=$(openssl rand -base64 64)`
- 同 phase 11.5 流程：deploy → ssh console 拿 transient key → 跑 `scripts/contexts-persist-smoke.mjs` ≥ 5 次填本 doc §7.1 表
- 验 LaunchAI 跨仓 follow-up：他们用 `bb.contexts.create()` + `browserSettings.context.id` 替代每次重新登录路径

---

## 8. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Chromium 启动时 user-data-dir 文件锁导致 tar 解包失败 | 中 | 加载失败 → session 创建失败 | 严格保证 spawnChromium 在 loadContext 完成**之后**；loadContext 失败 → return error，cloud-runtime 把 session 标 errored |
| Snapshot 时 chromium 进程仍 hold sqlite WAL → 导致 cookie/IDB 不一致 | 高 | 部分数据丢失 | killChromium 必须等 SIGTERM 优雅退出 + sleep 1s 让 fsync flush，再 SIGKILL；snapshotContext 在 chromium 完全退出之后才 tar |
| Snapshot 上传超 200MB 限制 | 中 | session DELETE 警告但成功，context 停在旧版本 | 客户感知（response.snapshotFailed=true）+ 默认 200MB 已经覆盖典型 chrome profile（>200MB 通常是 cache 没排除干净） |
| AES-GCM master key 旋转 | 低 | 旋转时所有 contexts 都需要 re-encrypt | 设计支持 key versioning：`enc_algo='aes-256-gcm-v1'`，加 v2 时 lazy migrate；phase 11.6a 不实现，11.6b 按需 |
| 内部 HMAC secret 泄漏 → 攻击者伪造 download URL 拖取任意 context | 极低（需先突破 cloud-runtime fly secrets） | 灾难（跨 customer cookie 泄漏） | secret rotation via fly secrets；token 5min TTL 限制泄漏窗口；**关键防御**：download URL handler 仅响应 pod 内部 IP（fly private network），公网请求一律 401（即使 token 合法） |
| Fly volume 撑爆（100GB） | 低 | 写盘失败 → snapshot 报警 | quota 公式 `MOSAIQ_CONTEXTS_PER_PROJECT_MAX × MOSAIQ_CONTEXT_SIZE_MAX_MB ≤ 20GB`，留足头空间；ops 监控 `df` |
| Context "in_use" lock 被异常 session 卡住 | 中 | 客户卡 409 无法创新 session | session DELETE / reaper 都要 release lock；对 reaper 路径，`active_session_id` 在 session row 更新为 closed 时通过 trigger 同步清零 ——**11.6a 简化为同事务里清，不依赖 trigger** |
| LaunchAI 大规模上线后单 fly 实例 IO 瓶颈 | 低（alpha 阶段） | snapshot 慢 → 客户体验差 | phase 11.6b S3/R2 backend，offload IO；同时引入 horizontal scaling 准备 |

---

## 9. 不在范围（→ phase 11.6b 或后续）

- **S3/R2 storage backend** —— 11.6b。横扩前置依赖
- **Cross-region context replication** —— phase 11.8 multi-region 时考虑
- **Context partial update**（仅替换某 cookie）—— BB 也不支持，跳过
- **Context fork / clone** —— 用户用 `bb.contexts.create()` 然后用同一份初始数据装载到多个 session（要 read-only mode）。phase 11.6a `persist: false` 已经覆盖只读复用；fork 是更上层语义
- **GC job** —— soft-deleted contexts 物理删盘。11.6b 加 cron job
- **Context list / detail endpoints** —— BB 没有。我们也不做
- **Encryption key rotation** —— 11.6c 或更晚
- **Context size monitoring + auto-trim** —— ops alert 替代

---

## 10. LaunchAI 跨仓 follow-up

| 文件 | 改动 |
|---|---|
| `src/lib/browser/runtime-mosaiq.ts` 新增 helper | `ensureContext(userId, platform)`：先查本地 KV 看 `${platform}:${userId}` → ctxId 映射；命中复用，未命中 `bb.contexts.create()` 存映射 |
| `src/lib/browser/runtime-mosaiq.ts` startSession | 启动 session 时一律带 `browserSettings: { context: { id: ctxId, persist: true } }` |
| `src/lib/browser/runtime-mosaiq.ts` 删除登录路径 | 现有"每次跑重新登录"代码改为：检测到 already logged in（page.url 含 user dashboard）则跳过登录步骤；新 context 时正常跑登录一次 |
| `src/lib/platforms/manifests/reddit.manifest.ts` | 添加 `loginCheckUrl: 'https://reddit.com/login'`、`loggedInIndicator: '.user-menu-button'` 让 runtime 判断 |

owner（Mosaiq 侧）：cloud infra
owner（LaunchAI 侧）：browser runtime maintainer

**预期收益**：grooming 时间从 90s（含 login）降到 ~30s（context load + 直接干活），且 Reddit 风控 trust score 显著提升（账号常驻同 cookie + device fingerprint）。

---

## 11. 验收标准

### 11.1 代码侧

- [ ] Commit 1（schema + env + storage interface + crypto）：+8 测试 → 225/225
- [ ] Commit 2（POST/DELETE /v1/contexts）：+10 测试 → 235/235
- [ ] Commit 3（pod context I/O）：+6 测试 → 241/241
- [ ] Commit 4（session integration + internal endpoints）：+10 测试 → 251/251
- [ ] Commit 5（metrics + smoke + docs）：+3 测试 → 254/254
- [ ] phase 11.5 keepAlive 全部测试保持绿
- [ ] phase 11.4a 全部 186 测试保持绿
- [ ] phase 11.6 数据库迁移在**已存在 sessions / contexts 表**的 prod-like DB 上跑通（commit 1 加 upgrade-path regression test，仿 phase 11.5 commit 6 教训）

### 11.2 prod 验证

- [ ] `scripts/contexts-persist-smoke.mjs` 5 跑次全 pass：session1 写 cookie + IDB → DELETE persist → session2 同 contextId 装载 → 读 cookie + IDB byte-equal
- [ ] §7.3 边界：context 不存在 404、context in-use 409、quota 满 429、size > 200MB 时 PUT 413 graceful 处理
- [ ] `/v1/metrics` 暴露 `contexts_active{project_id}`、`context_load_duration_seconds`、`context_snapshot_duration_seconds`、`context_snapshot_bytes`
- [ ] LaunchAI 跨仓 smoke：第 2 次 grooming 不重新登录（trajectory log + GET /v1/sessions/{id}.contextId 双向验证）

### 11.3 文档

- [ ] 本 doc §7 实测填表
- [ ] `docs/PHASE-11.4-STAGEHAND-COMPAT.md` Contexts 行 `❌` → `✓ phase 11.6`
- [ ] `apps/cloud-runtime/README.md` Browserbase compat 段更新
- [ ] `README.md` 顶部 cloud quickstart 加 contexts 例子（一段代码）
- [ ] `docs/PRD.md` §3 Cloud tier 给 contexts 数加 link

---

## 12. 测试结果（待 §11.2 部署后填）

### 12.1 Mosaiq 侧 smoke

| 跑次 | 时间 (UTC) | session1 acquire ms | session1 snapshot ms | snapshot bytes | session2 load ms | cookie+IDB byte-equal | 结果 |
|---|---|---|---|---|---|---|---|
| #1 | TBD | — | — | — | — | — | TBD |
| #2 | TBD | — | — | — | — | — | TBD |
| #3 | TBD | — | — | — | — | — | TBD |
| #4 | TBD | — | — | — | — | — | TBD |
| #5 | TBD | — | — | — | — | — | TBD |
| **mean** | — | — | **target < 3s** | — | **target < 2s** | — | — |

### 12.2 边界场景

| 场景 | 期望 | 实测 |
|---|---|---|
| 创第 (MAX+1) 个 context | 429 `pool.contexts_saturated` | TBD |
| 用不存在的 contextId 创 session | 404 `context.not_found` | TBD |
| 同 contextId 并发创 2 个 session | 第 2 个 409 `context.in_use` + detail.activeSessionId | TBD |
| Snapshot tarball > MAX_SIZE | PUT 413，response.snapshotFailed=true，context 停在上次成功 snapshot | TBD |
| Tampered tarball（GCM auth fail）| pod 抛错 → cloud-runtime mark session errored | TBD |
| `persist: false` 模式 | session DELETE 不触发 snapshot；context.last_snapshot_at 不变 | TBD |

---

## 附录 A — Browserbase Contexts 参考契约

来源：https://docs.browserbase.com/features/contexts (2026-05-27 抓取)

```text
Contexts allow you to persist user data across multiple browser sessions, enabling
smoother automation, seamless authentication, and faster end-to-end workflows.

What data does a Context store?
- Cookies — including session cookies, explicitly backed up and restored between sessions
- localStorage — per-origin key-value storage
- IndexedDB — structured client-side databases
- Session Storage — tab-scoped storage
- Service Workers — site-controlled caching and offline support
- Web Data — form autofill entries and saved form data
- Browser preferences — site-level settings, permissions, and security state (e.g., HSTS)

POST /v1/contexts             {} → { id }
DELETE /v1/contexts/{id}      → 204
POST /v1/sessions {
  browserSettings: {
    context: { id, persist: true }
  }
}                              → 同 BB 标准 session 响应

persist=true (default)         在 session 关闭时把 user-data-dir 反向 snapshot 到 context
persist=false                  只读模式：装载 context 但不写回
```

---

## 13. 与 phase 11.5 的衔接 + 设计风格沿用

phase 11.5 教会我们的（沿用到 phase 11.6）：

1. **迁移顺序**：CREATE INDEX 引用的列必须先 ALTER。phase 11.6 commit 1 加 contexts 表 + sessions.context_id 列时严格按 STATEMENTS → COLUMN_ADDITIONS → INDEX_ADDITIONS 顺序，并加 upgrade-path regression test
2. **API 形状 superset**：response 同时含 native（snake_case）+ BB-compat（camelCase）字段，contextId 是个例
3. **OCC + atomic transition**：phase 11.5 sticky lock 用 `WHERE active_session_id IS NULL` OCC，phase 11.6 context lock 同款。原子 update 优于读改写
4. **观察性优先**：metrics label 把生命周期阶段拆到位（load/snapshot/create/delete + outcome），dashboard 能直接画 funnel
5. **Smoke script 是 verify 黄金标准**：单测 + prod smoke 两层；phase 11.5 单测 217 全绿但 prod 因迁移 bug crash-loop，smoke 是兜底
6. **Internal-only endpoints 单独 prefix**：phase 11.6 `/v1/_internal/*` 不在 public OpenAPI，文档明确标"pod control plane only"
