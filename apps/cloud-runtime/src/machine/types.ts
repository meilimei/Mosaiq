/**
 * MachineManager — 机器（pod）后端抽象。
 *
 * 一个 session = 一台 machine。MachineManager 负责拿到一台 machine 的内部
 * CDP URL、暴露释放回收方法、提供池子健康度。
 *
 * 三个实现（v0.11 phase 11.1 只 ship `static` + `local-docker` 占位）：
 *   - StaticPoolMachineManager  — POD_ADDRS env 列出预跑 pod，轮询分配
 *   - LocalDockerMachineManager — 调本机 docker socket 即时拉起 pod (TODO 11.1.b)
 *   - FlyMachineManager         — 调 Fly Machines API (phase 11.2)
 */

import type { Persona } from '@runova/persona-schema';

/** 机器实例的元信息。 */
export interface AcquiredMachine {
  /** machine id（'mch_xxx' / fly machine id / docker container id） */
  id: string;
  /** pod 内部控制端口的 origin，例如 'http://browser-pod-1:9222' */
  podOrigin: string;
  /**
   * pod 上 chromium 暴露的 CDP WebSocket URL，可被控制平面反向代理。
   * 例如 'ws://browser-pod-1:9223' 或 'ws://browser-pod-1:9223/devtools/browser/xxx'。
   * 控制平面不直接连这个，而是把客户端的 WS 全双工 piping 到这里。
   */
  cdpInternalUrl: string;
}

/** acquire(spec) 入参 —— pod 启动时需要的全部 persona 衍生信息。 */
export interface AcquireSpec {
  sessionId: string;
  persona: Persona;
  /** pod-side stealth 选项，传给 browser-pod 的 /control/start。 */
  stealth: {
    inject: boolean;
    humanize: boolean;
    rebrowserPatches: boolean;
    /** pod 服务端自动求解 captcha（reCAPTCHA / hCaptcha / Turnstile）。 */
    solveCaptchas: boolean;
  };
  viewport?: { width: number; height: number };
  /** session ttl，pod 内部的看门狗超时使用。 */
  ttlSeconds: number;
  /**
   * Phase 11.6: Browserbase Contexts API。指定时 pod 在 chromium 启动**前**
   * GET `loadUrl` 拿 encrypted blob，用 `projectId` 派生 AES key 解密，untar 进
   * --user-data-dir，再启动 chromium —— 用户的 cookie / localStorage / IDB
   * 跨 session 复用。无 context 时 pod 走 fresh user-data-dir（与 phase 11.5
   * 之前完全等价）。
   *
   * 见 docs/PHASE-11.6-CONTEXTS-COOKIE-STORAGE.md §6.1 (pod /control/start 扩展)。
   */
  context?: {
    /** 签名的内部下载 URL（包含 ?token=...）。5min TTL。 */
    loadUrl: string;
    /** AES key 派生用 —— pod 用 master + projectId HKDF 派生 per-project key。 */
    projectId: string;
  };
}

/**
 * `release(id, opts?)` 的可选行为开关。
 *
 * Phase 11.5: 引入 `hold: true` 让 keepAlive 长会话路径保留 pod。
 * 默认 hold=false 与 phase 11.4 行为完全一致（destroy machine + 清状态）。
 *
 * 见 docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md §3 (Pod lifecycle) 与 §5
 * (single-use safety carve-out)。
 */
export interface ReleaseOptions {
  /**
   * `true` → 把 machine 保留在"held"状态：跳过 pod /control/stop 与 destroy（fly /
   * docker rm / static 标 idle），machine 实例继续 running，chromium 进程不变，
   * `--user-data-dir` 完整保留。alive map 里仍记账，capacity 计为 busy。
   *
   * `false`（默认）→ 完整销毁：callPodStop + destroyMachine，alive map 清掉。
   * 这是 phase 11.4 默认行为，保留 phase 11.3a single-use invariant。
   *
   * 谁触发 hold=false 关闭一个曾被 hold=true 的 machine：
   *   - DELETE /v1/sessions/{id} 客户端显式关
   *   - session-expiry reaper 看到 idle / hard TTL 过期
   * 见 §3.2 lifecycle 图与 §3.5 reaper 扩展。
   */
  hold?: boolean;
  /**
   * Phase 11.6: 签名的内部 snapshot upload URL。指定时（hold=false 路径专属）
   * pod 在 SIGKILL chromium **之后**、`rm sessionUserDir` **之前**做 tar +
   * 加密 + PUT 到这个 URL。失败不阻止 pod 完成 /control/stop —— 错误隔离让
   * lock 释放与 snapshot 成功解耦（design §5.4）。
   *
   * 仅 DELETE /v1/sessions w/ contextPersist=true 路径填充；其他路径（reaper /
   * idle / sticky evict）一律不填，因为 chromium 已 SIGKILL，user-data-dir 状态
   * 不一致，不应 snapshot。
   *
   * hold=true 时此字段被忽略 —— 真正销毁时机才是 snapshot 时机。
   */
  snapshotUrl?: string;
}

export interface MachineManager {
  /** 实现类型，记录到 /v1/health 用。 */
  readonly kind: 'static' | 'local-docker' | 'fly';

  /**
   * 获取一台 machine。包含与 pod 协商 chromium 启动的全过程：
   *  1) 选 / 起一个 pod
   *  2) POST {podOrigin}/control/start  with persona + stealth opts
   *  3) pod 把 chromium 起好，回 cdp ws path
   *  4) 拼成 AcquiredMachine 返回
   *
   * 失败抛 ApiError('pool.exhausted' | 'machine.spawn_failed' | 'pool.pod_unhealthy')
   */
  acquire(spec: AcquireSpec): Promise<AcquiredMachine>;

  /**
   * 释放 machine。语义按实现 + opts.hold：
   *  - hold=false (默认): 完整销毁
   *      - static  → POST {podOrigin}/control/stop（清 user-data，标 idle）
   *      - docker  → docker rm -f
   *      - fly     → fly machines destroy
   *  - hold=true (phase 11.5): 保留 machine + 用户态全部 state
   *      - 跳过 callPodStop（chromium 进程不动，--user-data-dir 保留）
   *      - 跳过 destroyMachine / docker rm
   *      - alive map 仍记账（machine 持续占 cap 与计费）
   *      - 后续 `release(id, {hold: false})` 真正销毁
   *
   * Phase 11.4 之前的 callers 调 `release(id)` 不传 opts，与 hold=false 等价，
   * 行为零变化。
   */
  release(machineId: string, opts?: ReleaseOptions): Promise<void>;

  /** 当前池容量统计，/v1/health 用。 */
  capacity(): Promise<{ ready: number; busy: number; cap: number }>;

  /** shutdown：把全部 machine 优雅释放（dev 重启场景）。 */
  shutdown(): Promise<void>;
}
