/**
 * InjectionConfig — 精简后序列化传入浏览器端 init script 的配置。
 *
 * 只包含原始、可序列化的字段；从 Persona 派生但不依赖 Persona 类型，
 * 便于在隔离的 page context 中直接使用。
 */

export interface InjectionConfig {
  // Identity
  userAgent: string;
  appVersion: string;
  platform: string;
  vendor: string;
  languages: readonly string[];

  // Hardware
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;

  // Screen
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
  };

  // Timezone
  timezone: string;

  // GPU / WebGL
  webglVendor: string;
  webglRenderer: string;

  // Audio
  audioSampleRate: number;
  audioOutputLatency: number;
  audioInputDevices: number;
  audioOutputDevices: number;

  // Fingerprint perturbation
  canvasNoiseSeed: number;
  canvasNoiseStrength: number;
  webglNoiseSeed: number;
  webglPerturbReadPixels: boolean;
  audioNoiseSeed: number;
  audioNoiseAmplitude: number;

  // Fonts
  fontList: readonly string[];

  // WebRTC
  webrtcMode: 'disabled' | 'proxy_only' | 'default';
}
