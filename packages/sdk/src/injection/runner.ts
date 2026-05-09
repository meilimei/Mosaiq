/**
 * Mosaiq 注入脚本 Runner — 浏览器端执行的反检测核心。
 *
 * 通过 Playwright `context.addInitScript(injectAll, config)` 在每个页面
 * 加载前执行。这是 v0.1 的主要反检测手段。未来 Chromium fork 会替换
 * 为 C++ patch，但脚本在 fork 完成前作为回退。
 *
 * 覆盖面（按检测优先级排序）：
 *   1. navigator.userAgent / platform / language / hardwareConcurrency / deviceMemory
 *   2. screen.* / window.devicePixelRatio
 *   3. Intl.DateTimeFormat().resolvedOptions().timeZone + Date.prototype.getTimezoneOffset
 *   4. WebGL UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL + readPixels 扰动
 *   5. Canvas toDataURL/getImageData 噪声
 *   6. AudioContext Float32 噪声
 *   7. 字体探测仅返回白名单
 *   8. WebRTC 策略
 *   9. navigator.permissions.query 的 notifications 权限一致性
 *  10. window.chrome 的存在性（headless 常缺）
 *
 * 注意：此函数体必须自包含，不能引用外部作用域（会被 Playwright 序列化）。
 */

import type { InjectionConfig } from './types.js';

export function injectAll(config: InjectionConfig): void {
  // ═══════════════════════════════════════════════════════════════════════════
  // 内联工具：稳定 PRNG + 值覆盖辅助
  // ═══════════════════════════════════════════════════════════════════════════

  function makePrng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function defineReadOnly<T>(obj: object, key: string, value: T): void {
    try {
      Object.defineProperty(obj, key, {
        get: () => value,
        enumerable: true,
        configurable: true,
      });
    } catch {
      // 某些环境下属性不可配置，忽略失败
    }
  }

  function defineReadOnlyGetter<T>(obj: object, key: string, getter: () => T): void {
    try {
      Object.defineProperty(obj, key, {
        get: getter,
        enumerable: true,
        configurable: true,
      });
    } catch {
      // noop
    }
  }

  /**
   * 在原型链上注入 getter。先 walk prototype 链找到属性真正定义的位置
   * （IDL mixin 接口经常把属性挂在 Navigator.prototype 之外的更深 proto，
   * 比如 deviceMemory 实际在 NavigatorDeviceMemory mixin 的 prototype 上），
   * 然后通过 Proxy 包装原生 getter 强制返回 fake 值，同时保留
   * `Function.prototype.toString` 的 "[native code]" 输出，骗过 stealth 检测。
   *
   * 如果 walk 链找不到（属性不存在），就在 immediate prototype 上直接定义 own
   * property —— 这种情况通常是 chromium 把某个 API 默认禁用了，我们补一份。
   *
   * 反检测库的常见检测点：
   *   - Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver') 是否存在
   *   - getter.toString() 是否包含 "[native code]"
   *   - Object.getOwnPropertyDescriptor(navigator, 'webdriver') 是否有 own property（必须无）
   * 我们的实现同时绕过这三类。
   */
  function defineProtoGetter(rootObj: object, key: string, value: unknown): void {
    try {
      // 1. walk prototype 链找属性所在的 proto
      let definingProto: object | null = null;
      let curr: object | null = Object.getPrototypeOf(rootObj);
      while (curr) {
        if (Object.prototype.hasOwnProperty.call(curr, key)) {
          definingProto = curr;
          break;
        }
        curr = Object.getPrototypeOf(curr);
      }

      if (definingProto) {
        const desc = Object.getOwnPropertyDescriptor(definingProto, key);
        if (desc?.get) {
          // 在原始定义点用 Proxy 包装原生 getter，apply 时返回 fake 值
          const proxiedGetter = new Proxy(desc.get, {
            apply() {
              return value;
            },
          });
          Object.defineProperty(definingProto, key, {
            get: proxiedGetter,
            set: desc.set,
            enumerable: desc.enumerable ?? true,
            configurable: true,
          });
          return;
        }
        // desc 是 data property（少见），直接覆盖值
        Object.defineProperty(definingProto, key, {
          value,
          writable: false,
          enumerable: desc?.enumerable ?? true,
          configurable: true,
        });
        return;
      }

      // 2. 链上完全没有这个属性 —— 在 immediate prototype 上 shadow 一份
      const immediateProto = Object.getPrototypeOf(rootObj) as object | null;
      if (immediateProto) {
        Object.defineProperty(immediateProto, key, {
          get: () => value,
          enumerable: true,
          configurable: true,
        });
      }
    } catch {
      // noop
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Navigator (prototype-level，避免被 own-property 检测识破)
  //
  //   - 把 navigator 实例直接传给 defineProtoGetter
  //   - 由 walker 自动找到属性真实定义的 proto（IDL mixin 经常挂在比
  //     Navigator.prototype 更深的 NavigatorDeviceMemory / NavigatorID 等
  //     mixin prototype 上）
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    defineProtoGetter(navigator, 'userAgent', config.userAgent);
    defineProtoGetter(navigator, 'appVersion', config.appVersion);
    defineProtoGetter(navigator, 'platform', config.platform);
    defineProtoGetter(navigator, 'vendor', config.vendor);
    defineProtoGetter(navigator, 'language', config.languages[0] ?? 'en-US');
    defineProtoGetter(navigator, 'languages', Object.freeze([...config.languages]));
    defineProtoGetter(navigator, 'hardwareConcurrency', config.hardwareConcurrency);
    defineProtoGetter(navigator, 'deviceMemory', config.deviceMemory);
    defineProtoGetter(navigator, 'maxTouchPoints', config.maxTouchPoints);

    // webdriver 标志必须为 false。Chrome 启动 --enable-automation 或被 CDP
    // 控制时会自动把这个 getter 改成 return true；我们用 Proxy 包装强制 false。
    defineProtoGetter(navigator, 'webdriver', false);

    // userAgentData（UA-CH）minimally override
    if ('userAgentData' in navigator) {
      const nav = navigator as Navigator & { userAgentData?: unknown };
      const uad = nav.userAgentData as
        | {
            brands?: { brand: string; version: string }[];
            mobile?: boolean;
            platform?: string;
            getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
          }
        | undefined;
      if (uad) {
        defineReadOnlyGetter(uad, 'platform', () => {
          switch (config.platform) {
            case 'Win32':
              return 'Windows';
            case 'MacIntel':
              return 'macOS';
            default:
              return 'Linux';
          }
        });
      }
    }
  } catch (err) {
    console.debug('[mosaiq] navigator spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Screen & window
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    defineReadOnly(screen, 'width', config.screen.width);
    defineReadOnly(screen, 'height', config.screen.height);
    defineReadOnly(screen, 'availWidth', config.screen.availWidth);
    defineReadOnly(screen, 'availHeight', config.screen.availHeight);
    defineReadOnly(screen, 'colorDepth', config.screen.colorDepth);
    defineReadOnly(screen, 'pixelDepth', config.screen.pixelDepth);
    defineReadOnlyGetter(window, 'devicePixelRatio', () => config.screen.devicePixelRatio);
  } catch (err) {
    console.debug('[mosaiq] screen spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Timezone (Intl + Date)
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const OrigDateTimeFormat = Intl.DateTimeFormat;
    const patchedDTF: typeof Intl.DateTimeFormat = function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      const [locales, options] = args;
      const merged = { timeZone: config.timezone, ...options };
      return new OrigDateTimeFormat(locales, merged);
    } as unknown as typeof Intl.DateTimeFormat;

    Object.setPrototypeOf(patchedDTF, OrigDateTimeFormat);
    Object.defineProperty(patchedDTF, 'prototype', {
      value: OrigDateTimeFormat.prototype,
      writable: false,
    });
    (Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = patchedDTF;

    // Date.prototype.getTimezoneOffset 需要与 timezone 自洽
    // 简化实现：使用 Intl 派生 offset
    const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function (): number {
      try {
        const dt = new (OrigDateTimeFormat as unknown as typeof Intl.DateTimeFormat)('en-US', {
          timeZone: config.timezone,
          timeZoneName: 'shortOffset',
        });
        const parts = dt.formatToParts(this);
        const offsetPart = parts.find((p) => p.type === 'timeZoneName');
        if (offsetPart) {
          const m = offsetPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
          if (m) {
            const sign = m[1] === '-' ? 1 : -1;
            const hours = Number.parseInt(m[2] ?? '0', 10);
            const minutes = Number.parseInt(m[3] ?? '0', 10);
            return sign * (hours * 60 + minutes);
          }
        }
      } catch {
        // fall through
      }
      return origGetTimezoneOffset.call(this);
    };
  } catch (err) {
    console.debug('[mosaiq] timezone spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. WebGL
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const WEBGL_UNMASKED_VENDOR = 0x9245;
    const WEBGL_UNMASKED_RENDERER = 0x9246;

    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (
      this: WebGLRenderingContext,
      pname: number,
    ) {
      if (pname === WEBGL_UNMASKED_VENDOR) return config.webglVendor;
      if (pname === WEBGL_UNMASKED_RENDERER) return config.webglRenderer;
      return origGetParameter.call(this, pname);
    };

    if (typeof WebGL2RenderingContext !== 'undefined') {
      const orig2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (
        this: WebGL2RenderingContext,
        pname: number,
      ) {
        if (pname === WEBGL_UNMASKED_VENDOR) return config.webglVendor;
        if (pname === WEBGL_UNMASKED_RENDERER) return config.webglRenderer;
        return orig2.call(this, pname);
      };
    }

    // readPixels 扰动
    if (config.webglPerturbReadPixels) {
      const origReadPixels = WebGLRenderingContext.prototype.readPixels;
      const prng = makePrng(config.webglNoiseSeed);
      WebGLRenderingContext.prototype.readPixels = function (
        this: WebGLRenderingContext,
        x: number,
        y: number,
        width: number,
        height: number,
        format: number,
        type: number,
        pixels: ArrayBufferView | null,
      ): void {
        origReadPixels.call(this, x, y, width, height, format, type, pixels);
        if (pixels && pixels.byteLength > 0) {
          const view = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
          // 仅扰动 1% 像素，幅度 ±1。视觉不可察觉但 hash 改变
          const sampleCount = Math.max(1, Math.floor(view.length * 0.01));
          for (let i = 0; i < sampleCount; i++) {
            const idx = Math.floor(prng() * view.length);
            const delta = (prng() < 0.5 ? -1 : 1);
            const current = view[idx] ?? 0;
            view[idx] = Math.max(0, Math.min(255, current + delta));
          }
        }
      };
    }
  } catch (err) {
    console.debug('[mosaiq] webgl spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Canvas
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const strength = config.canvasNoiseStrength;
    if (strength > 0) {
      const prngSeed = config.canvasNoiseSeed;

      function perturbImageData(imageData: ImageData): ImageData {
        const prng = makePrng(prngSeed);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const delta = Math.floor((prng() - 0.5) * 2 * strength);
          if (delta !== 0) {
            data[i] = Math.max(0, Math.min(255, (data[i] ?? 0) + delta));
            data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] ?? 0) + delta));
            data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] ?? 0) + delta));
          }
        }
        return imageData;
      }

      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (
        this: HTMLCanvasElement,
        type?: string,
        quality?: number,
      ): string {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          try {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            perturbImageData(imageData);
            ctx.putImageData(imageData, 0, 0);
          } catch {
            // tainted canvas 或 CORS，跳过
          }
        }
        return origToDataURL.call(this, type as string, quality);
      };

      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (
        this: CanvasRenderingContext2D,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        settings?: ImageDataSettings,
      ): ImageData {
        const imageData = origGetImageData.call(this, sx, sy, sw, sh, settings);
        return perturbImageData(imageData);
      };
    }
  } catch (err) {
    console.debug('[mosaiq] canvas spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. AudioContext
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const audioPrng = makePrng(config.audioNoiseSeed);
    const amplitude = config.audioNoiseAmplitude;

    if (typeof AnalyserNode !== 'undefined') {
      const origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function (
        this: AnalyserNode,
        array: Float32Array,
      ): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (origGetFloat as any).call(this, array);
        for (let i = 0; i < array.length; i++) {
          array[i] = (array[i] ?? 0) + (audioPrng() - 0.5) * amplitude;
        }
      };
    }

    // AudioContext sampleRate 一致性
    if (typeof AudioContext !== 'undefined') {
      defineReadOnlyGetter(AudioContext.prototype, 'sampleRate', () => config.audioSampleRate);
    }
  } catch (err) {
    console.debug('[mosaiq] audio spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Fonts (通过 FontFaceSet.check 拦截字体探测)
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const fontSet = new Set(config.fontList.map((f) => f.toLowerCase()));
    if (typeof document !== 'undefined' && document.fonts) {
      const origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = (font: string, text?: string): boolean => {
        // 提取字体名：从 'bold 16px "Comic Sans MS"' 中取 "Comic Sans MS"
        const match = font.match(/(?:"([^"]+)"|'([^']+)'|([^\s,]+))(?:\s*,.*)?$/);
        const family = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim().toLowerCase();
        if (!family) return origCheck(font, text);
        // 系统通用字体总是返回 true
        if (['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'].includes(family)) {
          return origCheck(font, text);
        }
        // 只有白名单内的字体返回 true
        return fontSet.has(family);
      };
    }
  } catch (err) {
    console.debug('[mosaiq] fonts spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. WebRTC
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    if (config.webrtcMode === 'disabled') {
      // 直接拆 RTCPeerConnection 构造器
      defineReadOnly(window, 'RTCPeerConnection', undefined);
      defineReadOnly(window, 'webkitRTCPeerConnection', undefined);
    }
    // proxy_only 模式主要靠 Chromium 启动参数 --force-webrtc-ip-handling-policy
    // 这里无需额外 JS 处理
  } catch (err) {
    console.debug('[mosaiq] webrtc spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Chrome object (headless 常缺失；Playwright 默认也缺)
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    if (!(window as Window & { chrome?: unknown }).chrome) {
      (window as Window & { chrome?: unknown }).chrome = {
        runtime: {},
        loadTimes: () => ({}),
        csi: () => ({}),
        app: {},
      };
    }
  } catch (err) {
    console.debug('[mosaiq] chrome shim failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. navigator.permissions 一致性（notifications 应为 default 而非 denied）
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    if (navigator.permissions?.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (desc: PermissionDescriptor): Promise<PermissionStatus> => {
        if (desc.name === 'notifications') {
          return Promise.resolve({
            state: 'prompt',
            name: 'notifications',
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          } as unknown as PermissionStatus);
        }
        return origQuery(desc);
      };
    }
  } catch (err) {
    console.debug('[mosaiq] permissions spoof failed', err);
  }
}
