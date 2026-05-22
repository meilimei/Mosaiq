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

let current: { proc: ChildProcess; info: RunningChromium; cleanupTimer: NodeJS.Timeout | null } | null = null;

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
    cdpPort: env.POD_CDP_PORT,
    userDataDir: sessionUserDir,
    headless: env.POD_HEADLESS,
    ...(input.viewport ? { viewport: input.viewport } : {}),
  });

  log.info(
    { exe, flagsCount: flags.length, cdpPort: env.POD_CDP_PORT, sessionUserDir },
    'spawning chromium',
  );

  const proc = spawn(exe, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const text = chunk.toString('utf8').trim();
    if (text) log.debug({ chromiumStderr: text.slice(0, 500) }, 'chromium stderr');
  });

  let cdpUrl: string;
  try {
    cdpUrl = await waitForCdp(env.POD_CDP_PORT, env.POD_CHROMIUM_BOOT_TIMEOUT_MS);
  } catch (err) {
    proc.kill('SIGKILL');
    throw err;
  }

  // chromium 自报的 webSocketDebuggerUrl 形如 ws://localhost:9223/devtools/browser/<uuid>。
  // 控制平面用 POD_ADDRS 配置（http://browser-pod-1:9222）已经知道 pod 的可路由 host，
  // 它会接收这个 url 然后把 host 部分替换掉。我们这里原样返回，保持 port（9223）
  // 与 path（/devtools/browser/<uuid>）信息完整。
  const info: RunningChromium = {
    machineId: input.machineId,
    pid: proc.pid ?? -1,
    cdpUrl, // 完整 ws://...，控制平面 swap host 部分
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
