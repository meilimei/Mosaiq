/**
 * 按 env.MACHINE_MANAGER 选实现。
 *
 * - static       → StaticPoolMachineManager（POD_ADDRS 列表，dev 默认）
 * - local-docker → LocalDockerMachineManager（dev 本机 Docker socket）
 * - fly          → FlyMachineManager (phase 11.2) 或 FlyPooledMachineManager (phase 11.3a)
 *                  按 POOL_TARGET_SIZE 切换：0 = 纯 cold path（默认），>0 = pool wrap。
 *                  pool wrap 的失败模式：pool 任意环节挂掉都 fallback 回 cold path，
 *                  acquire 不会因 pool bug 多挂。回滚通过 `flyctl secrets set POOL_TARGET_SIZE=0`。
 */

import { loadEnv } from '../env.js';
import { getLogger } from '../utils/logger.js';
import { FlyPooledMachineManager } from './fly-pool.js';
import { FlyMachineManager } from './fly.js';
import { LocalDockerMachineManager } from './local-docker.js';
import { StaticPoolMachineManager } from './static.js';
import type { MachineManager } from './types.js';

let cached: MachineManager | null = null;

function buildPodEnv(env: ReturnType<typeof loadEnv>): Record<string, string> {
  return {
    POD_CONTEXT_SIZE_MAX_MB: String(env.MOSAIQ_CONTEXT_SIZE_MAX_MB),
    ...(env.MOSAIQ_CONTEXT_MASTER_KEY
      ? { POD_CONTEXT_MASTER_KEY: env.MOSAIQ_CONTEXT_MASTER_KEY }
      : {}),
  };
}

export function getMachineManager(): MachineManager {
  if (cached) return cached;
  const env = loadEnv();
  const podEnv = buildPodEnv(env);
  switch (env.MACHINE_MANAGER) {
    case 'static': {
      const podAddrs = env.POD_ADDRS.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (env.MOSAIQ_CONTEXT_MASTER_KEY) {
        getLogger().warn(
          'machine-manager: contexts are enabled; static browser-pod containers must also set POD_CONTEXT_MASTER_KEY',
        );
      }
      cached = new StaticPoolMachineManager({ podAddrs });
      break;
    }
    case 'local-docker':
      cached = new LocalDockerMachineManager({
        socketPath: env.DOCKER_SOCKET,
        image: env.DOCKER_IMAGE,
        network: env.DOCKER_NETWORK,
        apiBaseUrl: env.DOCKER_API_BASE_URL,
        maxContainers: env.DOCKER_MAX_CONTAINERS,
        shmBytes: env.DOCKER_POD_SHM_BYTES,
        podControlPort: env.FLY_POD_CONTROL_PORT, // 同 pod 镜像，复用同一 PORT 约定
        podEnv,
      });
      break;
    case 'fly': {
      // env.ts superRefine 已经保证 fly 模式下 token + appName 必填，这里 ! 是安全的。
      const flyOpts = {
        apiToken: env.FLY_API_TOKEN!,
        appName: env.FLY_POD_APP_NAME!,
        apiBaseUrl: env.FLY_API_BASE_URL,
        podImage: env.FLY_BROWSER_POD_IMAGE,
        region: env.FLY_POD_REGION,
        podControlPort: env.FLY_POD_CONTROL_PORT,
        maxMachines: env.FLY_MAX_MACHINES,
        machineCpus: env.FLY_MACHINE_CPUS,
        machineMemoryMb: env.FLY_MACHINE_MEMORY_MB,
        podEnv,
      };
      if (env.POOL_TARGET_SIZE > 0) {
        // Phase 11.3a pool wrap
        const pooled = new FlyPooledMachineManager({
          ...flyOpts,
          poolTargetSize: env.POOL_TARGET_SIZE,
          poolReplenishIntervalMs: env.POOL_REPLENISH_INTERVAL_MS,
          poolReplenishConcurrency: env.POOL_REPLENISH_CONCURRENCY,
          poolMaxAgeMs: env.POOL_MAX_AGE_SECONDS * 1000,
          poolProvisionTimeoutMs: env.POOL_PROVISION_TIMEOUT_MS,
          poolBootstrapEvictForeign: env.POOL_BOOTSTRAP_EVICT_FOREIGN,
          poolAutoStart: true,
        });
        // Bootstrap reconcile 异步跑：重启后从 Fly list 重建 pool 视图，不阻塞 server boot。
        // 失败也不退出——pool 空了下次 tick 会自己补，至多前几个 session 多等几秒走 cold。
        void pooled.bootstrap().catch((err) => {
          getLogger().warn(
            { cause: err instanceof Error ? err.message : String(err) },
            'pool bootstrap failed; server will continue, pool will refill on next replenish tick',
          );
        });
        getLogger().info(
          {
            targetSize: env.POOL_TARGET_SIZE,
            replenishIntervalMs: env.POOL_REPLENISH_INTERVAL_MS,
            maxAgeS: env.POOL_MAX_AGE_SECONDS,
          },
          'machine-manager: fly + pool (phase 11.3a)',
        );
        cached = pooled;
      } else {
        getLogger().info('machine-manager: fly cold-only (phase 11.2, POOL_TARGET_SIZE=0)');
        cached = new FlyMachineManager(flyOpts);
      }
      break;
    }
  }
  return cached!;
}

/** 测试用。 */
export function setMachineManagerForTesting(impl: MachineManager | null): void {
  cached = impl;
}

/** shutdown helper。 */
export async function shutdownMachineManager(): Promise<void> {
  if (cached) {
    await cached.shutdown();
    cached = null;
  }
}
