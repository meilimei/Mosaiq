/**
 * FlyMachineManager —— 占位（phase 11.2）。
 *
 * phase 11.2 要做的事：
 *   - 用 FLY_API_TOKEN 调 Fly Machines REST API（POST /apps/{app}/machines）
 *   - 把 fly-prefer-instance-zone 设到 FLY_REGION
 *   - 创建后 polling 状态直到 'started'
 *   - pod 内部地址用 fly machine 的 6PN（IPv6 private network）
 *   - destroy 时调 DELETE /apps/{app}/machines/{id}
 *
 * 所有 control plane 调用 pod /control/start /control/stop 的逻辑跟 static 一样。
 * 设计上把这部分提到 base class，但 v0.11 phase 11.1 不需要 —— 等 11.2 落地时
 * 一起重构。
 */

import { ApiError } from '../utils/errors.js';
import type { AcquireSpec, AcquiredMachine, MachineManager } from './types.js';

export class FlyMachineManager implements MachineManager {
  readonly kind = 'fly' as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async acquire(_spec: AcquireSpec): Promise<AcquiredMachine> {
    throw new ApiError(
      'machine.spawn_failed',
      'MACHINE_MANAGER=fly is reserved for v0.12 phase 11.2. v0.11 仅支持 static.',
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
