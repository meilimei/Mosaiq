/**
 * 按 env.MACHINE_MANAGER 选实现。
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
      cached = new LocalDockerMachineManager();
      break;
    case 'fly':
      cached = new FlyMachineManager();
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
