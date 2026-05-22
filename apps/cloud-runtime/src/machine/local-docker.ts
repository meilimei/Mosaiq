/**
 * LocalDockerMachineManager —— 占位实现（v0.11 phase 11.1 不 ship）。
 *
 * 真正的 local-docker 路径需要：
 *   - 调 unix:///var/run/docker.sock 起容器
 *   - 把 pod port 映射到 host
 *   - 等待 pod /healthz 就绪
 *   - 容器结束后 docker rm
 *
 * 这一坨工作量与 phase 11.2 的 Fly 实现高度重叠（都是「调 API 起 / 销毁机器，
 * 然后用 fetch 跟 pod 协商」），统一在 11.2 一起做。
 *
 * 现在 MACHINE_MANAGER=local-docker 启动 → 直接 throw 友好错误，提示走
 * static + 手工 docker compose up。
 */

import { ApiError } from '../utils/errors.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from './types.js';

export class LocalDockerMachineManager implements MachineManager {
  readonly kind = 'local-docker' as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async acquire(_spec: AcquireSpec): Promise<AcquiredMachine> {
    throw new ApiError(
      'machine.spawn_failed',
      'MACHINE_MANAGER=local-docker is not implemented in v0.11 phase 11.1. ' +
        '用 docker compose -f docker-compose.cloud.yml up 起预跑 pod, 然后切回 MACHINE_MANAGER=static.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async release(_machineId: string): Promise<void> {
    /* no-op */
  }

  async capacity(): Promise<{ ready: number; busy: number; cap: number }> {
    return { ready: 0, busy: 0, cap: 0 };
  }

  async shutdown(): Promise<void> {
    /* no-op */
  }
}
