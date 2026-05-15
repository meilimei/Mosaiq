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

  // UA Client Hints —— navigator.userAgentData
  // 主 scope 默认 Chromium 实现暴露 "HeadlessChrome" 的 brand，我们覆盖整套
  // NavigatorUAData 表面：brands / mobile / platform / getHighEntropyValues。
  // 同样的 spoof block 也会被嵌入 Worker / SharedWorker / SW 的脚本内，保证
  // worker scope userAgentData 不会反向揭示 headless 痕迹。
  uaCh: {
    brands: ReadonlyArray<{ brand: string; version: string }>;
    fullVersionList: ReadonlyArray<{ brand: string; version: string }>;
    mobile: boolean;
    /** "Windows" / "macOS" / "Linux"（注意：这里跟 navigator.platform 不同字符串） */
    platform: string;
    /** Chrome UA-CH reduction 后的值：Win11→"15.0.0"，Win10→"10.0.0"，macOS→"14.0.0" 等 */
    platformVersion: string;
    /** "x86" / "arm" */
    architecture: string;
    /** "64" / "32" */
    bitness: string;
    /** 一般 false，model 一般 "" —— 桌面 persona */
    wow64: boolean;
    model: string;
  };

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
