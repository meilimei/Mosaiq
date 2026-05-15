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
  /**
   * 可选 GPU 参数对照表，按 persona.gpu.webglRenderer 字符串匹配选定（见
   * `webgl-profiles.ts`）。runner.ts §4 在 getParameter Proxy 内读这张表，把
   * MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS / ALIASED_*_RANGE 等 capability 常量
   * 替换成与声称 GPU 一致的值，消 CreepJS WebGL bold-fail。
   *
   * 序列化形式：key 是 hex 字符串（`"0x0d33"`），value 是 number 或
   * number[]（typed array 在 page context 内由 runner.ts 重建）。
   *
   * 无匹配 profile 时 `null`，runner.ts 跳过 GL param spoof，仅保留
   * UNMASKED_VENDOR/RENDERER 两个字符串 spoof（v0.1 行为）。
   */
  webglProfile: {
    readonly name: string;
    // value 可以是：number（capability）、readonly number[]（typed-array dims/range）、
    // string（VENDOR/RENDERER/VERSION/SHADING_LANGUAGE_VERSION，Phase 1.9b 加入）
    readonly webgl1: Readonly<Record<string, number | readonly number[] | string>>;
    readonly webgl2: Readonly<Record<string, number | readonly number[] | string>>;
  } | null;

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
