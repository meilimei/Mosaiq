/**
 * Hardware-level identity: CPU, memory, GPU, audio output.
 *
 * 这层暴露给 Web 平台的接口主要是：
 *   - navigator.hardwareConcurrency (CPU)
 *   - navigator.deviceMemory (内存粗粒度，仅 0.25/0.5/1/2/4/8)
 *   - WebGL UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
 *   - GPUAdapter.info (WebGPU)
 *   - AudioContext sampleRate / outputLatency
 *
 * v0.1 通过 CDP 注入脚本拦截上述接口；未来 fork 在 GPU process / Audio service 直接改。
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// CPU & Memory
// ─────────────────────────────────────────────────────────────────────────────

export const CpuSchema = z.object({
  /** 4, 6, 8, 12, 16, 20, 24, 32 (与 navigator.hardwareConcurrency 对应) */
  cores: z.number().int().min(2).max(64),
  /**
   * 仅用于内部建模与 telemetry，不直接暴露给 Web。
   * 例：'Intel Core i7-13700H', 'Apple M2 Pro', 'AMD Ryzen 7 7840U'
   */
  modelName: z.string().min(1).max(128).optional(),
});
export type Cpu = z.infer<typeof CpuSchema>;

/**
 * navigator.deviceMemory 只允许 [0.25, 0.5, 1, 2, 4, 8]。
 * 真机 ≥8GB 也只暴露 8。
 */
export const DeviceMemoryGbSchema = z.union([
  z.literal(0.25),
  z.literal(0.5),
  z.literal(1),
  z.literal(2),
  z.literal(4),
  z.literal(8),
]);
export type DeviceMemoryGb = z.infer<typeof DeviceMemoryGbSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// GPU
// ─────────────────────────────────────────────────────────────────────────────

export const GpuVendorSchema = z.enum(['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm']);
export type GpuVendor = z.infer<typeof GpuVendorSchema>;

export const GpuSchema = z.object({
  vendor: GpuVendorSchema,
  /**
   * WebGL UNMASKED_VENDOR_WEBGL，例：
   *   'Google Inc. (NVIDIA)' / 'Google Inc. (Intel)' / 'Apple GPU'
   */
  webglVendor: z.string().min(1).max(128),
  /**
   * WebGL UNMASKED_RENDERER_WEBGL，例：
   *   'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
   *   'Apple M2 Pro'
   *   'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.1)'
   */
  webglRenderer: z.string().min(1).max(256),
  /** WebGPU adapter info (Chrome 113+). 可选；未提供时 SDK 推断。 */
  webgpu: z
    .object({
      vendor: z.string().default(''),
      architecture: z.string().default(''),
      device: z.string().default(''),
      description: z.string().default(''),
    })
    .optional(),
});
export type Gpu = z.infer<typeof GpuSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────────────────────

export const AudioSchema = z.object({
  /** 标准 44100 / 48000；浏览器最常见 48000 */
  sampleRate: z.union([z.literal(44100), z.literal(48000)]).default(48000),
  /** AudioContext.outputLatency，单位 sec。0.005~0.05 之间为典型值 */
  outputLatencySec: z.number().min(0).max(1).default(0.01),
  /** 设备数（kind=audiooutput） */
  outputDeviceCount: z.number().int().min(1).max(8).default(1),
  /** 设备数（kind=audioinput） */
  inputDeviceCount: z.number().int().min(0).max(8).default(1),
});
export type Audio = z.infer<typeof AudioSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Combined hardware
// ─────────────────────────────────────────────────────────────────────────────

export const HardwareSchema = z.object({
  cpu: CpuSchema,
  deviceMemoryGb: DeviceMemoryGbSchema,
  gpu: GpuSchema,
  audio: AudioSchema,
  /** Touch points for navigator.maxTouchPoints. 桌面通常 0，手机/触屏笔电 ≥1 */
  maxTouchPoints: z.number().int().min(0).max(10).default(0),
});
export type Hardware = z.infer<typeof HardwareSchema>;
