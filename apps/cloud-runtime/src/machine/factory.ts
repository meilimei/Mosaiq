/**
 * 按 env.MACHINE_MANAGER 选实现。
 *
 * - static       → StaticPoolMachineManager（POD_ADDRS 列表，dev 默认）
 * - local-docker → LocalDockerMachineManager（dev 本机 Docker socket）
 * - fly          → FlyMachineManager（prod，phase 11.2）
 */

import { loadEnv } from '../env.js';
import { FlyMachineManager } from './fly.js';
import { LocalDockerMachineManager } from './local-docker.js';
import { StaticPoolMachineManager } from './static.js';
import type { MachineManager } from './types.js';

let cached: MachineManager | null = null;

export function getMachineManager(): MachineManager {
  if (cached) return cached;
  const env = loadEnv();
  switch (env.MACHINE_MANAGER) {
    case 'static': {
      const podAddrs = env.POD_ADDRS.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
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
      });
      break;
    case 'fly':
      // env.ts superRefine 已经保证 fly 模式下 token + appName 必填，这里 ! 是安全的。
      cached = new FlyMachineManager({
        apiToken: env.FLY_API_TOKEN!,
        appName: env.FLY_POD_APP_NAME!,
        apiBaseUrl: env.FLY_API_BASE_URL,
        podImage: env.FLY_BROWSER_POD_IMAGE,
        region: env.FLY_POD_REGION,
        podControlPort: env.FLY_POD_CONTROL_PORT,
        maxMachines: env.FLY_MAX_MACHINES,
        machineCpus: env.FLY_MACHINE_CPUS,
        machineMemoryMb: env.FLY_MACHINE_MEMORY_MB,
      });
      break;
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
