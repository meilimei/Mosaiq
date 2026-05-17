/**
 * Fingerprint perturbation seeds — 反检测核心。
 *
 * 设计理念：「每个 persona 一个稳定噪声种子」。
 *   ✅ 同一 persona 多次启动 → 指纹一致（不会被站点识别为「同一设备多次扰动」）
 *   ✅ 不同 persona → 指纹完全不同（多账号互不关联）
 *   ✅ 噪声幅度足以使 hash 完全变化，但视觉上人眼不可察
 *
 * v0.1 实现（SDK 端 JS 注入）：
 *   - Canvas: 拦截 toDataURL/getImageData，在像素上叠加 (seed + x + y) % 3 - 1 的微噪声
 *   - WebGL: 拦截 readPixels 与 getParameter(UNMASKED_*)
 *   - Audio: 拦截 AnalyserNode.getFloatFrequencyData，叠加 (seed) 1e-7 量级噪声
 *   - Font: 通过 CSS @font-face 探测拦截，仅返回 fontList 中声明的字体
 *   - WebRTC: 拦截 createOffer/createAnswer，根据 mode 处理 ICE candidate
 *
 * 未来 fork 端实现（C++ patch 0001/0002/0003/0004）：
 *   - Canvas 在 Skia 层直接改 pixel buffer
 *   - WebGL 在 ANGLE 层 hook
 *   - Audio 在 web_audio render thread hook
 *   - Font 在 PlatformFontPosix/PlatformFontWin 层过滤
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Noise seed: 32-bit unsigned int as hex string (8 chars)
// ─────────────────────────────────────────────────────────────────────────────

export const NoiseSeedSchema = z
  .string()
  .regex(/^[0-9a-f]{8}$/, 'Noise seed must be 8 hex chars (32-bit unsigned)');
export type NoiseSeed = z.infer<typeof NoiseSeedSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Canvas
// ─────────────────────────────────────────────────────────────────────────────

export const CanvasFingerprintSchema = z.object({
  /** 同一 seed = 同一 Canvas 输出。不同 persona 必须不同 seed。 */
  noiseSeed: NoiseSeedSchema,
  /**
   * 噪声强度。0 = 关闭噪声（不推荐），3 = 默认 ±1 像素，10 = 强（视觉可察觉）。
   * 推荐范围 1-3。
   */
  noiseStrength: z.number().int().min(0).max(10).default(2),
});
export type CanvasFingerprint = z.infer<typeof CanvasFingerprintSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// WebGL
// ─────────────────────────────────────────────────────────────────────────────

export const WebGlFingerprintSchema = z.object({
  noiseSeed: NoiseSeedSchema,
  /**
   * 是否在 readPixels 输出上加入扰动。建议 true。
   */
  perturbReadPixels: z.boolean().default(true),
});
export type WebGlFingerprint = z.infer<typeof WebGlFingerprintSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────────────────────

export const AudioFingerprintSchema = z.object({
  noiseSeed: NoiseSeedSchema,
  /**
   * PCM (linear, -1..1) 域噪声幅度，作用于 `AudioBuffer.getChannelData`。
   * 1e-7 远小于 16-bit PCM ULP (≈3e-5)，听感无差异；累积仍足以改 hashMini。
   */
  noiseAmplitude: z.number().min(0).max(1e-3).default(1e-7),
  /**
   * dB (logarithmic, -100..0) 域噪声幅度，作用于
   * `AnalyserNode.getFloatFrequencyData` (spectrum analysis only)。
   *
   * v0.5 新增：v0.2 ~ v0.4 期间 AnalyserNode 共用 `noiseAmplitude=1e-7`，
   * 但 dB 域 Float32 ULP @ -50 dB ≈ 3.8e-6，1e-7 远低于 ULP → 噪声被
   * round 清零，hook 装上但无效。
   *
   * 默认 0.001 dB ≈ 250× ULP，远低于人耳 JND (~1 dB) 与 audio app 阈值
   * (典型 ≥1 dB)，但保证 Float32 可见 → hash 必变。
   *
   * 仅影响 `AnalyserNode` 频谱分析输出，不影响实际播放音频；
   * 上限 5 dB（即使开到顶 audio 应用也几乎无差异，因为 AnalyserNode
   * 只用于 visualizer / VAD 等读取场景，不进 audio rendering pipeline）。
   */
  noiseAmplitudeDb: z.number().min(0).max(5).default(0.001),
});
export type AudioFingerprint = z.infer<typeof AudioFingerprintSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Fonts
// ─────────────────────────────────────────────────────────────────────────────

export const FontListSchema = z.object({
  /**
   * 声明本 persona 「拥有」的字体白名单。注入脚本拦截字体探测时仅返回此列表。
   * 必须与 OS family 自洽（Windows persona 不应出现 'San Francisco'）。
   */
  fonts: z.array(z.string().min(1).max(96)).min(20).max(500),
});
export type FontList = z.infer<typeof FontListSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// WebRTC
// ─────────────────────────────────────────────────────────────────────────────

export const WebRtcModeSchema = z.enum([
  /** 完全禁用 WebRTC（最安全，但部分站点会用此判定异常） */
  'disabled',
  /** 仅暴露代理 IP（推荐用于反检测+代理场景） */
  'proxy_only',
  /** 默认行为，可能泄露真实本地 IP（不推荐多账号） */
  'default',
]);
export type WebRtcMode = z.infer<typeof WebRtcModeSchema>;

export const WebRtcFingerprintSchema = z.object({
  mode: WebRtcModeSchema.default('proxy_only'),
});
export type WebRtcFingerprint = z.infer<typeof WebRtcFingerprintSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Combined fingerprint block
// ─────────────────────────────────────────────────────────────────────────────

export const FingerprintSchema = z.object({
  canvas: CanvasFingerprintSchema,
  webgl: WebGlFingerprintSchema,
  audio: AudioFingerprintSchema,
  fontList: FontListSchema,
  webrtc: WebRtcFingerprintSchema,
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;
