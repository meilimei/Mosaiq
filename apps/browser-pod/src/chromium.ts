/**
 * Chromium 子进程管理。
 *
 * 单 pod 同时只跑一个 chromium。`spawn(persona, ...)` -> `kill()` 的状态机：
 *
 *   IDLE
 *     │ spawn()
 *     ▼
 *   STARTING (chromium 进程已 fork，等 /json/version 返回)
 *     │  ✓
 *     ▼
 *   RUNNING (cdpUrl 已知，machineId 已分配)
 *     │ kill() / chromium 自死
 *     ▼
 *   IDLE
 *
 * /json/version 是 chromium 的标准 CDP discovery endpoint，返回:
 *   {
 *     "Browser": "Chrome/...",
 *     "webSocketDebuggerUrl": "ws://0.0.0.0:9223/devtools/browser/<uuid>"
 *   }
 *
 * 这个 ws path 是控制平面反向代理的目标。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright-core';

import type { Persona } from '@runova/persona-schema';

import { type CaptchaWatcherHandle, applyCaptchaWatcher } from './captcha.js';
import { loadContext, snapshotContext } from './context-io.js';
import { loadEnv } from './env.js';
import { type ServerStealthHandle, applyServerStealth } from './inject.js';
import { getLogger } from './logger.js';
import { buildChromiumFlags } from './persona-flags.js';
import {
  type ProxyForwarderHandle,
  needsAuthForwarder,
  startProxyForwarder,
} from './proxy-forward.js';

export interface RunningChromium {
  machineId: string;
  pid: number;
  cdpUrl: string;
  startedAt: number;
  /**
   * captcha watcher 计数（observe-first 阶段可观测；未来计费数据基础）。
   * watcher 未挂（session 未请求 solveCaptchas）时为 null。
   */
  captcha: { detected: number; solved: number } | null;
}

export interface ChromiumSpawnInput {
  machineId: string;
  persona: Persona;
  /**
   * 是否做服务端深层注入（Option A）。默认 true。控制平面从 session 的
   * `stealth.inject` 透传；设 false = raw chromium 模式（仅进程级 flag）。
   * 也受 pod env `POD_SERVER_INJECT` 总开关约束（kill-switch）。
   */
  stealthInject?: boolean;
  /**
   * 是否挂 captcha 自动求解 watcher。从 session `stealth.solveCaptchas` 透传。
   * 真正是否调用付费 provider 还受 pod env `POD_CAPTCHA_SOLVER` 约束——本 flag
   * 关时连 watcher 都不挂（零开销）。
   */
  stealthSolveCaptchas?: boolean;
  viewport?: { width: number; height: number };
  ttlSeconds: number;
  /**
   * Phase 11.6: 若提供，启动前 GET loadUrl 装载 context（decrypt + untar 进
   * user-data-dir）。projectId 记入 `current`，供 killChromium 的 snapshot 复用
   * （snapshot URL 只在 /control/stop 才到，但 projectId 在 start 时已知）。
   */
  context?: {
    loadUrl: string;
    projectId: string;
  };
}

/** killChromium 的可选行为：snapshot 回写。 */
export interface KillOptions {
  /** cloud-runtime 签的 snapshot 上传 URL；提供则 kill 后、rm 前回写 context。 */
  snapshotUrl?: string;
}

const VERSION_POLL_INTERVAL_MS = 200;
/** 捕获 chromium stderr/stdout 最后多少字节以备诊断（spawn 失败时随 error 一起报）。 */
const STD_TAIL_BYTES = 16 * 1024;

/**
 * 单 pod 在跑的 chromium 状态。
 *
 * Phase 11.6 新增字段：
 *   - sessionUserDir：snapshot + rm 都要这个路径（之前只活在 spawn 闭包里）
 *   - contextProjectId：context 装载时记下的 project id，killChromium snapshot 复用
 *   - managedKill：killChromium 设 true，让 exit handler **跳过** rm（由 killChromium
 *     在 snapshot 之后才 rm）；unmanaged 退出（crash / TTL / self-death）保持 false，
 *     exit handler 照常立即 rm（不 snapshot）。
 */
let current: {
  proc: ChildProcess;
  info: RunningChromium;
  cleanupTimer: NodeJS.Timeout | null;
  sessionUserDir: string;
  contextProjectId: string | null;
  managedKill: boolean;
  /** Option A: pod 侧服务端注入连接句柄；kill 时先 close 再 SIGTERM。null = 未注入。 */
  injectHandle: ServerStealthHandle | null;
  /** captcha watcher 句柄；kill 时与 injectHandle 一并 close。null = 未挂。 */
  captchaHandle: CaptchaWatcherHandle | null;
  /** Option A: 本地认证转发代理句柄；kill 时 close。null = 未用（无认证代理）。 */
  proxyForwarder: ProxyForwarderHandle | null;
} | null = null;
let startingMachineId: string | null = null;

export class PodBusyError extends Error {
  constructor(readonly machineId: string) {
    super(`pod is busy: machineId=${machineId}`);
  }
}

/**
 * Ring buffer式捕获 child process 输出。只保留最后的 STD_TAIL_BYTES，
 * 不增长无限（chromium 生命周期同步，正常 ~30s，但 verbose 错误场景下可以几 MB）。
 */
class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  append(chunk: Buffer): void {
    const text = chunk.toString('utf8');
    this.chunks.push(text);
    this.size += text.length;
    // 超过 2x 上限后 trim（避免每次 append 都走 trim）
    if (this.size > STD_TAIL_BYTES * 2) this.trim();
  }
  private trim(): void {
    while (this.size > STD_TAIL_BYTES && this.chunks.length > 1) {
      const head = this.chunks.shift()!;
      this.size -= head.length;
    }
  }
  toString(): string {
    this.trim();
    const joined = this.chunks.join('');
    return joined.length > STD_TAIL_BYTES ? joined.slice(joined.length - STD_TAIL_BYTES) : joined;
  }
}

/** 解析 chromium 可执行路径。优先 env 覆盖，回退 playwright-core 默认。 */
export function resolveChromiumExecutable(): string {
  const env = loadEnv();
  if (env.POD_CHROME_EXECUTABLE) return env.POD_CHROME_EXECUTABLE;
  // playwright-core 的 BrowserType.executablePath() 返回 bundled chromium 路径
  // 注意：playwright-core 不带 binary，需要 npx playwright install chromium
  const exe = chromium.executablePath();
  if (!exe) {
    throw new Error(
      'Cannot resolve chromium binary. Set POD_CHROME_EXECUTABLE env or run `npx playwright install chromium` first.',
    );
  }
  return exe;
}

async function fetchJsonVersion(port: number, signal: AbortSignal): Promise<string> {
  const url = `http://127.0.0.1:${port}/json/version`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    throw new Error(`/json/version returned ${resp.status}`);
  }
  const json = (await resp.json()) as { webSocketDebuggerUrl?: string };
  if (!json.webSocketDebuggerUrl) {
    throw new Error('/json/version did not include webSocketDebuggerUrl');
  }
  return json.webSocketDebuggerUrl;
}

async function waitForCdp(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const log = getLogger();
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), Math.min(remaining, 1500));
    try {
      const url = await fetchJsonVersion(port, ctrl.signal);
      clearTimeout(tm);
      return url;
    } catch (err) {
      clearTimeout(tm);
      log.debug(
        { port, err: err instanceof Error ? err.message : String(err) },
        'waitForCdp: not ready',
      );
      await new Promise((r) => setTimeout(r, VERSION_POLL_INTERVAL_MS));
    }
  }
  throw new Error(`chromium /json/version did not become ready within ${timeoutMs}ms`);
}

export async function spawnChromium(input: ChromiumSpawnInput): Promise<RunningChromium> {
  const busyMachineId = getBusyMachineId();
  if (busyMachineId) {
    throw new PodBusyError(busyMachineId);
  }

  startingMachineId = input.machineId;
  try {
    return await spawnChromiumInner(input);
  } catch (err) {
    const sessionUserDir = path.join(path.resolve(loadEnv().POD_PROFILE_DIR), input.machineId);
    await rm(sessionUserDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  } finally {
    if (startingMachineId === input.machineId) startingMachineId = null;
  }
}

async function spawnChromiumInner(input: ChromiumSpawnInput): Promise<RunningChromium> {
  const env = loadEnv();
  const log = getLogger();

  const userDataDir = path.resolve(env.POD_PROFILE_DIR);
  // 每个 session 用独立目录避免 cross-session 污染（pod 是单 session 但
  // 万一 control plane 调度复用同 pod 的边界场景，多目录更稳）
  const sessionUserDir = path.join(userDataDir, input.machineId);
  await mkdir(sessionUserDir, { recursive: true });

  // Phase 11.6: 装载 context（若有）—— 必须在 chromium 启动**前**，让 chromium
  // 一上来就读到已有的 cookie / localStorage / IndexedDB。loadContext 内部对 404
  // （空 context）走 fresh boot；对网络 / decrypt / untar 失败抛错，让 spawn 失败
  // 而不是静默用空 profile（用户期待自己的登录态，loud fail 更安全）。
  if (input.context) {
    await loadContext(input.context, sessionUserDir);
  }

  const exe = resolveChromiumExecutable();

  // ── Option A（issue #5）：带认证的上游代理走 pod 内本地转发代理 ──
  // chromium 的 --proxy-server 不带认证；当 persona 上游代理带 username 且为
  // http/https 时，起一个本地转发器注入 Proxy-Authorization，让 chromium 指向它。
  // 受 env POD_PROXY_AUTH_FORWARD 总开关约束（false = 回退传统直连，认证被丢弃）。
  // socks5+认证暂不支持（需独立握手），走 else 分支（传统 flag，认证丢失）。
  let proxyForwarder: ProxyForwarderHandle | null = null;
  let proxyServerOverride: string | undefined;
  const upstream = input.persona.network.proxy;
  if (upstream && env.POD_PROXY_AUTH_FORWARD && needsAuthForwarder(upstream)) {
    try {
      proxyForwarder = await startProxyForwarder(upstream);
      proxyServerOverride = proxyForwarder.url;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), upstreamHost: upstream.host },
        'proxy-forward: failed to start; falling back to direct (auth will be dropped)',
      );
    }
  }

  const flags = buildChromiumFlags({
    persona: input.persona,
    internalCdpPort: env.POD_CDP_INTERNAL_PORT,
    userDataDir: sessionUserDir,
    headless: env.POD_HEADLESS,
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(proxyServerOverride ? { proxyServerOverride } : {}),
  });

  log.info(
    {
      exe,
      flagsCount: flags.length,
      internalCdpPort: env.POD_CDP_INTERNAL_PORT,
      externalCdpPort: env.POD_CDP_PORT,
      sessionUserDir,
    },
    'spawning chromium',
  );

  // 关掉 chromium 对 dbus 的所有探测。Playwright base 镜像不含 dbus daemon，
  // chromium 默认会反复尝试连 system bus（/run/dbus/system_bus_socket）和 session
  // bus，每次失败有 1-5s 的内部 timeout，累积启动期可达 15s+。设这两个 env 让
  // libdbus 直接当成 "无 bus"，所有探测立即失败而不重试。也覆盖 host 父进程可能
  // 有的 dbus address，避免误连到一个 host 上无效的 bus address。
  //
  // value 'disabled:' 是 libdbus 内部约定（src/dbus-transport.c parse_address），
  // 见到这个 transport name 就直接 return 不发起连接。空字符串也有同样效果但语义
  // 不如 'disabled:' 清晰。详见 freedesktop dbus-daemon(1) ADDRESSES 段。
  const chromiumEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DBUS_SYSTEM_BUS_ADDRESS: 'disabled:',
    DBUS_SESSION_BUS_ADDRESS: 'disabled:',
  };
  const proc = spawn(exe, flags, { stdio: ['ignore', 'pipe', 'pipe'], env: chromiumEnv });
  // 捕获 stderr / stdout 到 ring buffer，供 spawn 失败时诊断（比如4 只丢 debug log
  // 会被 prod LOG_LEVEL=info 吃掉，踩过坑）。
  const stderrTail = new TailBuffer();
  const stdoutTail = new TailBuffer();
  proc.on('error', (err) => {
    log.error({ err }, 'chromium process error');
  });
  proc.on('exit', (code, signal) => {
    log.info({ code, signal }, 'chromium exited');
    if (current && current.proc === proc) {
      if (current.cleanupTimer) clearTimeout(current.cleanupTimer);
      const wasManaged = current.managedKill;
      const handle = current.injectHandle;
      const captcha = current.captchaHandle;
      const forwarder = current.proxyForwarder;
      current = null;
      // Option A: 关掉服务端注入的 playwright 连接。unmanaged 退出（crash/TTL/self-
      // death）时 chromium 已死，连接会自然报错；managed 退出时 killChromium 已先关，
      // 这里 double-close 是安全的（close 内部 best-effort catch）。
      void handle?.close();
      // captcha watcher 同理：double-close 安全（内部 best-effort catch）。
      void captcha?.close();
      // Option A: 关本地认证转发代理（chromium 已退出，无连接需服务）。
      void forwarder?.close();
      // Phase 11.6: managed kill（killChromium）会在 snapshot 之后自己 rm，这里
      // 跳过避免在 snapshot 读取 user-data-dir 之前就把它删了。Unmanaged 退出
      // （crash / TTL SIGTERM / chromium self-death）照常立即清理，不 snapshot。
      if (!wasManaged) {
        rm(sessionUserDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail.append(chunk);
    const text = chunk.toString('utf8').trim();
    if (text) log.debug({ chromiumStderr: text.slice(0, 500) }, 'chromium stderr');
  });
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutTail.append(chunk);
  });

  let internalCdpUrl: string;
  try {
    // 探活走 internal port —— chromium 真正 listen 在 127.0.0.1:POD_CDP_INTERNAL_PORT
    internalCdpUrl = await waitForCdp(env.POD_CDP_INTERNAL_PORT, env.POD_CHROMIUM_BOOT_TIMEOUT_MS);
  } catch (err) {
    // 抢救诊断：把 chromium stderr / stdout 以 error 级输出，并拼进抛出的
    // error 的 detail 里（在 cloud-runtime/api 响应里可见）。Prod 现场看到
    // `pod returned 500 / chromium /json/version did not become ready` 时靠这里
    // 定位到 chromium 自己说了什么。
    const stderrSnap = stderrTail.toString();
    const stdoutSnap = stdoutTail.toString();
    log.error(
      {
        machineId: input.machineId,
        chromiumExe: exe,
        chromiumFlags: flags,
        chromiumStderr: stderrSnap,
        chromiumStdout: stdoutSnap,
      },
      'chromium spawn failed; captured stderr/stdout below',
    );
    proc.kill('SIGKILL');
    // Option A: chromium 没起来，关掉已建的本地转发代理（current 此刻还没赋值，
    // exit handler 不会处理它）。
    void proxyForwarder?.close();
    // Re-throw with diagnostic suffix — 控制平面会把这个 message 拼到
    // /v1/sessions 响应 detail.body 里，使诊断无需 ssh 进机器。
    const baseMsg = err instanceof Error ? err.message : String(err);
    const tail = stderrSnap.trim().slice(-800);
    throw new Error(
      tail
        ? `${baseMsg} | chromium stderr (last 800B): ${tail}`
        : `${baseMsg} | chromium stderr was empty`,
    );
  }

  // chromium 自报的 webSocketDebuggerUrl 形如 ws://127.0.0.1:<INTERNAL>/devtools/browser/<uuid>。
  // 我们要把这个 URL 上报给 cloud-runtime 之前，把 port 从 INTERNAL（chromium 实际监听）
  // 改成 EXTERNAL（relay 对外监听）—— 这样 cloud-runtime 的 rewriteCdpHost 只需要换
  // host 不需要改 port（与 fly / static 模式的契约保持一致）。
  //
  // host 保留为 127.0.0.1（cloud-runtime 会再用容器 IP 替换）。
  const externalUrl = new URL(internalCdpUrl);
  externalUrl.port = String(env.POD_CDP_PORT);
  const cdpUrl = externalUrl.toString();

  // ── Option A: 服务端深层注入 ──
  // 在 spawnChromium 返回（= 控制平面把 cdpUrl 回给客户端）**之前**注册 injectAll，
  // 确保客户端随后 connectOverCDP 创建的页面一加载就带 canvas/WebGL/audio/UA-CH/字体/
  // worker 全套深层 spoof（而不只是进程级 flag）。受 session 的 stealthInject + pod env
  // POD_SERVER_INJECT 双重 gate。applyServerStealth 内部 fail-soft，绝不抛错。
  const doInject = (input.stealthInject ?? true) && env.POD_SERVER_INJECT;
  const injectHandle = doInject
    ? await applyServerStealth({
        browserWSEndpoint: internalCdpUrl,
        persona: input.persona,
      })
    : null;

  // ── Captcha 自动求解 watcher（gap fill phase A）──
  // 仅当 session 请求 stealth.solveCaptchas 时才挂（关时零开销）。watcher 内部再按
  // pod env POD_CAPTCHA_SOLVER / provider 决定「真正求解」还是「仅观察+日志」。
  // 同样 fail-soft，绝不抛错。挂在 inject 之后，确保检测页面已带深层 spoof。
  const captchaStats = input.stealthSolveCaptchas ? { detected: 0, solved: 0 } : null;
  const captchaHandle =
    input.stealthSolveCaptchas && captchaStats
      ? await applyCaptchaWatcher({
          browserWSEndpoint: internalCdpUrl,
          env,
          onEvent: (event) => {
            if (event === 'detected') captchaStats.detected += 1;
            else captchaStats.solved += 1;
          },
        })
      : null;

  const info: RunningChromium = {
    machineId: input.machineId,
    pid: proc.pid ?? -1,
    cdpUrl, // ws://127.0.0.1:<EXTERNAL>/devtools/browser/<uuid>，cloud-runtime swap host
    startedAt: Date.now(),
    captcha: captchaStats,
  };

  // TTL 看门狗：超时自动 kill。控制平面正常关闭通过 /control/stop 触发。
  const cleanupTimer = setTimeout(() => {
    log.warn({ machineId: input.machineId, ttl: input.ttlSeconds }, 'TTL hit, killing chromium');
    proc.kill('SIGTERM');
  }, input.ttlSeconds * 1000);

  current = {
    proc,
    info,
    cleanupTimer,
    sessionUserDir,
    contextProjectId: input.context?.projectId ?? null,
    managedKill: false,
    injectHandle,
    captchaHandle,
    proxyForwarder,
  };
  log.info(
    {
      machineId: info.machineId,
      pid: info.pid,
      cdpUrl,
      serverInject: doInject,
      captchaWatcher: Boolean(captchaHandle),
    },
    'chromium ready',
  );
  return info;
}

/** 等 proc 退出，最多 ms 毫秒。已退出立即 true；超时 false。 */
function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const tm = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => {
      clearTimeout(tm);
      resolve(true);
    });
  });
}

/**
 * 优雅停 chromium。
 *
 * Phase 11.6 流程（opts.snapshotUrl 提供时）：
 *   1) 设 managedKill=true（让 exit handler 跳过 rm）
 *   2) SIGTERM → 等 5s → 不退则 SIGKILL → 再等 3s 确保进程已死
 *   3) snapshot user-data-dir 回写 cloud-runtime（best-effort，永不抛）
 *   4) rm user-data-dir
 *
 * 无 snapshotUrl 时退化为 phase 11.5 行为（kill + 由本函数 rm），唯一区别是 rm
 * 移到了 killChromium（因为 managedKill 让 exit handler 不再 rm）。
 *
 * 幂等：machineId 不匹配 current 直接返回（重复 /control/stop 安全）。
 */
export async function killChromium(machineId: string, opts: KillOptions = {}): Promise<void> {
  const log = getLogger();
  if (!current || current.info.machineId !== machineId) {
    log.debug(
      { machineId, busyMachineId: current?.info.machineId ?? null },
      'killChromium: no match, idempotent skip',
    );
    return;
  }
  // 捕获 snapshot + rm 需要的状态（exit handler 即将把 current 置 null）。
  const proc = current.proc;
  const sessionUserDir = current.sessionUserDir;
  const contextProjectId = current.contextProjectId;
  const injectHandle = current.injectHandle;
  const captchaHandle = current.captchaHandle;
  const proxyForwarder = current.proxyForwarder;
  current.managedKill = true; // exit handler 跳过 rm，交给本函数
  if (current.cleanupTimer) clearTimeout(current.cleanupTimer);

  // Option A: 先关服务端注入的 playwright 连接，再 SIGTERM chromium —— 避免连接在
  // chromium 被杀时报一堆 disconnect 错误。best-effort。captcha watcher 同样先关。
  await injectHandle?.close();
  await captchaHandle?.close();
  // Option A: 关本地认证转发代理（exit handler 之后还会 double-close，幂等安全）。
  await proxyForwarder?.close();

  proc.kill('SIGTERM');
  const killed = await waitForExit(proc, 5_000);
  if (!killed) {
    log.warn({ machineId }, 'chromium did not exit on SIGTERM, sending SIGKILL');
    proc.kill('SIGKILL');
    await waitForExit(proc, 3_000);
  }
  // 此刻 exit handler 已跑（current=null），且因 managedKill 跳过了 rm。

  // Phase 11.6: snapshot 回写（best-effort，在 rm 之前）。
  if (opts.snapshotUrl) {
    if (contextProjectId) {
      const res = await snapshotContext(
        { uploadUrl: opts.snapshotUrl, projectId: contextProjectId },
        sessionUserDir,
      );
      if (!res.ok) {
        log.warn(
          { machineId, reason: res.reason, bytes: res.bytes ?? null },
          'context snapshot did not succeed (lock will still be released by cloud-runtime)',
        );
      }
    } else {
      // snapshotUrl 来了但 start 时没带 context —— 不该发生（cloud-runtime 只在
      // contextPersist 时发 snapshotUrl），防御性跳过。
      log.warn({ machineId }, 'snapshotUrl provided but no contextProjectId; skipping snapshot');
    }
  }

  // 清理 user-data-dir（snapshot 完成 / 跳过后才删）。
  await rm(sessionUserDir, { recursive: true, force: true }).catch(() => undefined);
}

export function getRunning(): RunningChromium | null {
  return current?.info ?? null;
}

export function getBusyMachineId(): string | null {
  return current?.info.machineId ?? startingMachineId;
}

export async function shutdownChromium(): Promise<void> {
  if (current) await killChromium(current.info.machineId);
}
