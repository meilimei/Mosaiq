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

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright-core';

import type { Persona } from '@mosaiq/persona-schema';

import { loadEnv } from './env.js';
import { getLogger } from './logger.js';
import { buildChromiumFlags } from './persona-flags.js';

export interface RunningChromium {
  machineId: string;
  pid: number;
  cdpUrl: string;
  startedAt: number;
}

export interface ChromiumSpawnInput {
  machineId: string;
  persona: Persona;
  viewport?: { width: number; height: number };
  ttlSeconds: number;
}

const VERSION_POLL_INTERVAL_MS = 200;
/** 捕获 chromium stderr/stdout 最后多少字节以备诊断（spawn 失败时随 error 一起报）。 */
const STD_TAIL_BYTES = 16 * 1024;

let current: { proc: ChildProcess; info: RunningChromium; cleanupTimer: NodeJS.Timeout | null } | null = null;

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
    return joined.length > STD_TAIL_BYTES
      ? joined.slice(joined.length - STD_TAIL_BYTES)
      : joined;
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
  if (current) {
    throw new Error(`pod is busy: machineId=${current.info.machineId}`);
  }

  const env = loadEnv();
  const log = getLogger();

  const userDataDir = path.resolve(env.POD_PROFILE_DIR);
  // 每个 session 用独立目录避免 cross-session 污染（pod 是单 session 但
  // 万一 control plane 调度复用同 pod 的边界场景，多目录更稳）
  const sessionUserDir = path.join(userDataDir, input.machineId);
  await mkdir(sessionUserDir, { recursive: true });

  const exe = resolveChromiumExecutable();
  const flags = buildChromiumFlags({
    persona: input.persona,
    internalCdpPort: env.POD_CDP_INTERNAL_PORT,
    userDataDir: sessionUserDir,
    headless: env.POD_HEADLESS,
    ...(input.viewport ? { viewport: input.viewport } : {}),
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
      current = null;
      // best-effort 清理 user-data-dir
      rm(sessionUserDir, { recursive: true, force: true }).catch(() => undefined);
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
    internalCdpUrl = await waitForCdp(
      env.POD_CDP_INTERNAL_PORT,
      env.POD_CHROMIUM_BOOT_TIMEOUT_MS,
    );
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

  const info: RunningChromium = {
    machineId: input.machineId,
    pid: proc.pid ?? -1,
    cdpUrl, // ws://127.0.0.1:<EXTERNAL>/devtools/browser/<uuid>，cloud-runtime swap host
    startedAt: Date.now(),
  };

  // TTL 看门狗：超时自动 kill。控制平面正常关闭通过 /control/stop 触发。
  const cleanupTimer = setTimeout(() => {
    log.warn({ machineId: input.machineId, ttl: input.ttlSeconds }, 'TTL hit, killing chromium');
    proc.kill('SIGTERM');
  }, input.ttlSeconds * 1000);

  current = { proc, info, cleanupTimer };
  log.info({ machineId: info.machineId, pid: info.pid, cdpUrl }, 'chromium ready');
  return info;
}

export async function killChromium(machineId: string): Promise<void> {
  const log = getLogger();
  if (!current || current.info.machineId !== machineId) {
    log.debug({ machineId, busyMachineId: current?.info.machineId ?? null }, 'killChromium: no match, idempotent skip');
    return;
  }
  if (current.cleanupTimer) clearTimeout(current.cleanupTimer);
  const proc = current.proc;
  proc.kill('SIGTERM');
  // 给 chromium 5s 优雅退出
  const killed = await new Promise<boolean>((resolve) => {
    const tm = setTimeout(() => resolve(false), 5_000);
    proc.once('exit', () => {
      clearTimeout(tm);
      resolve(true);
    });
  });
  if (!killed) {
    log.warn({ machineId }, 'chromium did not exit on SIGTERM, sending SIGKILL');
    proc.kill('SIGKILL');
  }
  // exit handler 清空 current
}

export function getRunning(): RunningChromium | null {
  return current?.info ?? null;
}

export async function shutdownChromium(): Promise<void> {
  if (current) await killChromium(current.info.machineId);
}
