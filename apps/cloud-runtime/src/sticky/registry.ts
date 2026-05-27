/**
 * In-process sticky session registry (Phase 11.5).
 *
 * 维护 `(projectId, stickyKey) → { sessionId, expiresAt }` 的 map。让客户端
 * `POST /v1/sessions { keepAlive: true, userMetadata: { stickyKey } }` 第二次
 * 命中同一 `(projectId, stickyKey)` 时拿到 `409 session.sticky_conflict`，
 * 而不是创建第二个 session（造成同 customer 同逻辑身份的 IndexedDB / SW
 * 状态分裂）。
 *
 * 见 `docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md` §4。
 *
 * # 单实例假设
 * Map 在 cloud-runtime 进程内。Prod 当前 1 instance（mosaiq-cloud-runtime
 * 在 iad 1 machine）。横扩到 N instance 时必须换 Redis-backed map（phase
 * 11.5b 跟同样 in-memory 的 rate limiter 一起改），否则不同 instance 之间
 * 路由不一致会让 sticky 失效。
 *
 * # bootstrap 行为
 * 进程重启时 map 内存丢失。已 live 的 keepAlive session 在 sessions 表里
 * 仍存在，但 sticky 路由会失忆 —— 同 (projectId, stickyKey) 的下一次 POST
 * 会再创建一个新 session（不会冲突）。代价是 ≤ 1 个 pod 浪费 + 该 customer
 * 同 stickyKey 暂时分裂为两个 session（业务影响：IndexedDB / SW 状态在第
 * 二次创建后是新的；reaper 30s 内会 GC 旧 entry 如果该旧 session 此时 idle）。
 * Phase 11.5b 引入 Redis-backed map 时一并加 bootstrap reconcile from DB
 * 消除这个窗口。当前接受这个 ≤ 30s 双注 risk —— 重启窗口短、单 customer
 * cost cap 受 `KEEPALIVE_SESSIONS_PER_PROJECT_MAX` 限制（不会跑飞）。
 *
 * # 内部 map key 形式
 * 用 `${projectId}\u0000${stickyKey}` —— NUL 不可能出现在合法 JSON 字符串里
 * （JSON.parse 会拒 `"\u0000"`-only string；但即使来了，作为 stickyKey 的一
 * 部分也只会自映射回同一 entry，无歧义）。这避免了 `projectId + ':' + stickyKey`
 * 拼接里如果 stickyKey 含冒号导致的边界歧义。
 */

interface StickyEntry {
  sessionId: string;
  expiresAt: string;
}

const stickyMap = new Map<string, StickyEntry>();

function compositeKey(projectId: string, stickyKey: string): string {
  return `${projectId}\u0000${stickyKey}`;
}

/**
 * Lookup 是否已有同 `(projectId, stickyKey)` 注册的 entry。
 * 返回 entry 不代表该 session 一定还 live —— 调用方应再用 entry.sessionId
 * 反查 `sessions` 表确认 status='live' 且 expiresAt > now，避免 stale entry
 * 误阻挡新建（reaper 标 closed 时会 evict，但如果 evict 与新建并发，仍可能
 * 短暂看到 stale entry）。
 */
export function stickyRegistryGet(
  projectId: string,
  stickyKey: string,
): StickyEntry | undefined {
  return stickyMap.get(compositeKey(projectId, stickyKey));
}

/**
 * 注册一个 sticky entry。POST /v1/sessions 成功后调用。
 *
 * 若同 key 已有 entry，**覆盖**之 —— 这种 case 一般出现在 stickyRegistryDelete
 * 漏掉的清理路径（理论上不应发生，但容错好于报错）。
 */
export function stickyRegistrySet(
  projectId: string,
  stickyKey: string,
  entry: StickyEntry,
): void {
  stickyMap.set(compositeKey(projectId, stickyKey), entry);
}

/**
 * 移除 sticky entry。在以下路径调用：
 *  - DELETE /v1/sessions/:id 显式关闭（commit 4）
 *  - session-expiry reaper 标 closed（commit 4）
 *  - POST /v1/sessions 命中 stale entry（DB 显示 session 已死）→ evict 后继续走新建
 *
 * 幂等：未注册的 key 也安全。
 */
export function stickyRegistryDelete(projectId: string, stickyKey: string): void {
  stickyMap.delete(compositeKey(projectId, stickyKey));
}

/** @internal Test only. 清空整个 registry，beforeEach 用。 */
export function resetStickyRegistryForTesting(): void {
  stickyMap.clear();
}

/** @internal Test only. 返回当前 entry 数量。 */
export function stickyRegistrySizeForTesting(): number {
  return stickyMap.size;
}
