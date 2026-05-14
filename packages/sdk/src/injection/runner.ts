/**
 * Mosaiq 注入脚本 Runner — 浏览器端执行的反检测核心。
 *
 * 通过 Playwright `context.addInitScript({ content: <string> })` 在每个页面
 * 加载前执行。launcher.ts 在前面 prepend `__name` polyfill 后再拼接 IIFE
 * 调用本函数 — 必须 string 形式，不能用 callback `addInitScript(injectAll, ...)`，
 * 否则被 esbuild keepNames 注入的 `__name(fn, "name")` 在 chromium 里抛
 * ReferenceError 让整个反检测静默死亡。详见 DEVELOPMENT.md §7。
 *
 * 这是 v0.1 的主要反检测手段。未来 Chromium fork 会替换为 C++ patch，
 * 但脚本在 fork 完成前作为回退。
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

  // ── Stealth Function.toString registry (Day 3.6) ──
  //
  // CreepJS lies/index.ts §getPrototypeLies 用
  //   `Function.prototype.toString.call(apiFunction)` 检查函数是否暴露 JS 源码或丢失 name。
  //
  // V8 行为：`Function.prototype.toString.call(new Proxy(nativeFn, {}))` 返回
  //   `"function () { [native code] }"` —— 含 `[native code]` 但**丢了原 name**。
  // 这让 CreepJS 的 `hasKnownToString` 白名单匹配失败 → 标 lies。
  //
  // 修复：在所有 spoof block 收尾后 hook `Function.prototype.toString`，对注册过的
  // proxy 返回**预先捕获的 native toString 字符串**（含正确 name）。
  // 普通调用走 `Reflect.apply` forward 到原 toString。
  //
  // 注册时机：每次创建 Proxy 包装 native 函数前用 `wrapStealth(orig, handler)`，
  // 它会先捕获 `origStr = Function.prototype.toString.call(orig)` 再创建 Proxy 并入册。
  // 全局 toString hook 在 injectAll 末尾安装（在所有 spoof 注册完毕后）。
  type MosaiqStealthState = {
    registry: WeakMap<Function, string>;
    nativeFunctionToString: typeof Function.prototype.toString;
    nativeObjectSetPrototypeOf: typeof Object.setPrototypeOf;
    nativeReflectSetPrototypeOf: typeof Reflect.setPrototypeOf;
    functionToStringProxy?: typeof Function.prototype.toString;
    objectSetPrototypeOfProxy?: typeof Object.setPrototypeOf;
    reflectSetPrototypeOfProxy?: typeof Reflect.setPrototypeOf;
  };
  const stealthGlobal = globalThis as typeof globalThis & {
    __mosaiqStealthState__?: MosaiqStealthState;
  };
  const stealthState =
    stealthGlobal.__mosaiqStealthState__ ??
    (stealthGlobal.__mosaiqStealthState__ = {
      registry: new WeakMap<Function, string>(),
      nativeFunctionToString: Function.prototype.toString,
      nativeObjectSetPrototypeOf: Object.setPrototypeOf,
      nativeReflectSetPrototypeOf: Reflect.setPrototypeOf,
    });
  const stealthRegistry = stealthState.registry;
  function wrapStealth<T extends Function>(orig: T, handler: ProxyHandler<T>): T {
    const origFunction = orig as unknown as Function;
    const origStr =
      stealthRegistry.get(origFunction) ??
      (Reflect.apply(stealthState.nativeFunctionToString, orig, []) as string);
    // 注入默认 setPrototypeOf trap，复刻 V8 原生 [[SetPrototypeOf]] 的循环检测：
    //
    // CreepJS 'failed at too much recursion error' 测试做：
    //   Object.setPrototypeOf(apiFunction, Object.create(apiFunction)).toString()
    // 对原生函数，V8 在 setPrototypeOf 阶段就检出 newProto.proto === target → throw
    // TypeError "Cyclic __proto__ value"。如果 apiFunction 是我们 wrap 的 Proxy，
    // V8 看的 target 是 native 函数，但 newProto.proto = 我们的 Proxy（不直接等于
    // native target），V8 检测不到循环 → 写入成功 → 后续 toString 链查时才 RangeError。
    // 那样会被 CreepJS 当作 lie。修法：proxy 自己的 setPrototypeOf trap 检测
    // newProto 链上是否出现"该 proxy 自身"，是则同样抛 TypeError，模拟 V8 native 行为。
    let proxyRef: T | null = null;
    const mergedHandler: ProxyHandler<T> = handler.setPrototypeOf
      ? handler
      : {
          ...handler,
          setPrototypeOf(target, newProto) {
            if (newProto === null) {
              return Reflect.setPrototypeOf(target, null);
            }
            if (typeof newProto !== 'object') {
              return Reflect.setPrototypeOf(target, newProto);
            }
            // 模拟 V8 在直接传 raw target 时的循环检测：newProto 链含 target → throw。
            if (hasPrototypeCycle(target as unknown as object, newProto)) {
              throw new TypeError("Cyclic __proto__ value");
            }
            // 同时，调用方常常拿到的是 proxy 而非 raw target；对 V8 来说，proxy 的
            //   [[GetPrototypeOf]] 默认 forward 到 target，所以 newProto 链中出现
            // proxyRef 时也等价于一个会立刻形成的循环。我们也要抛 TypeError。
            if (proxyRef && hasPrototypeCycle(proxyRef as unknown as object, newProto)) {
              throw new TypeError("Cyclic __proto__ value");
            }
            return Reflect.setPrototypeOf(target, newProto);
          },
        };
    const proxy = new Proxy(orig, mergedHandler);
    proxyRef = proxy as T;
    stealthRegistry.set(proxy as unknown as Function, origStr);
    return proxy as T;
  }

  function hasPrototypeCycle(target: object, proto: object | null): boolean {
    let curr = proto;
    while (curr) {
      if (curr === target) return true;
      curr = Object.getPrototypeOf(curr);
    }
    return false;
  }

  function throwFunctionToStringTypeError(frameOwner: 'Function' | 'Object'): never {
    const message = "Function.prototype.toString requires that 'this' be a Function";
    const err = new TypeError(message);
    try {
      Object.defineProperty(err, 'stack', {
        value: `TypeError: ${message}\n    at ${frameOwner}.toString (<anonymous>)`,
        configurable: true,
      });
    } catch {
      // noop
    }
    throw err;
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
      // 0. rootObj 自身是否已有 own accessor？
      //    Chromium 的 [Replaceable] IDL 属性（典型例：window.outerWidth /
      //    outerHeight / innerWidth / innerHeight）会被实例化成一个挂在
      //    window 实例上的 own getter，shadow Window.prototype 上的同名
      //    getter。如果只改 prototype，own getter 仍是原生值，spoof 失效。
      const ownDesc = Object.getOwnPropertyDescriptor(rootObj, key);

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

      const protoDesc = definingProto
        ? Object.getOwnPropertyDescriptor(definingProto, key)
        : undefined;
      const origGetter = ownDesc?.get ?? protoDesc?.get;

      if (origGetter) {
        // 用 wrapStealth(Proxy) 包装原生 getter，apply 时返回 fake 值；
        // 同时注册 toString → 让 Function.prototype.toString.call(getter) 返回
        // 原 getter 的 "function get xxx() { [native code] }" 字符串。
        const proxiedGetter = wrapStealth(origGetter, {
          apply(target, thisArg, args) {
            Reflect.apply(target, thisArg, args);
            return value;
          },
        });

        // 1a. 替换 proto 上的 getter（保持 Window.prototype.outerWidth 等
        //     descriptor 一致性，CreepJS 也会查 prototype 上的 getter）。
        if (definingProto && protoDesc?.get) {
          try {
            Object.defineProperty(definingProto, key, {
              get: proxiedGetter,
              set: protoDesc.set,
              enumerable: protoDesc.enumerable ?? true,
              configurable: true,
            });
          } catch {
            // 某些 host 不允许改 IDL 属性，吞掉
          }
        }

        // 1b. 如果 rootObj 自身有 own accessor，也用同一个 proxy 覆盖。
        if (ownDesc) {
          try {
            Object.defineProperty(rootObj, key, {
              get: proxiedGetter,
              set: ownDesc.set,
              enumerable: ownDesc.enumerable ?? true,
              configurable: true,
            });
          } catch {
            // 同上，吞掉
          }
        }
        return;
      }

      if (protoDesc) {
        // proto 上是 data property（少见），直接覆盖值
        Object.defineProperty(definingProto as object, key, {
          value,
          writable: false,
          enumerable: protoDesc.enumerable ?? true,
          configurable: true,
        });
        return;
      }

      // 2. 链上完全没有这个属性 —— 在 immediate prototype 上 shadow 一份
      const immediateProto = Object.getPrototypeOf(rootObj) as object | null;
      if (immediateProto) {
        const synthetic = {
          get [key]() {
            if (this !== rootObj) throw new TypeError('Illegal invocation');
            return value;
          },
        };
        const syntheticGetter = Object.getOwnPropertyDescriptor(synthetic, key)?.get;
        if (!syntheticGetter) return;
        stealthRegistry.set(syntheticGetter, `function get ${key}() { [native code] }`);
        Object.defineProperty(immediateProto, key, {
          get: syntheticGetter,
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
    const defineScreenValue = (key: string, value: number) => {
      if (Object.prototype.hasOwnProperty.call(screen, key)) defineReadOnly(screen, key, value);
      else defineProtoGetter(screen, key, value);
    };
    defineScreenValue('width', config.screen.width);
    defineScreenValue('height', config.screen.height);
    defineScreenValue('availWidth', config.screen.availWidth);
    defineScreenValue('availHeight', config.screen.availHeight);
    defineScreenValue('colorDepth', config.screen.colorDepth);
    defineScreenValue('pixelDepth', config.screen.pixelDepth);
    defineProtoGetter(window, 'outerWidth', config.screen.width);
    defineProtoGetter(window, 'outerHeight', config.screen.height);
    defineProtoGetter(window, 'innerWidth', config.screen.width);
    defineProtoGetter(window, 'innerHeight', config.screen.height);
    defineReadOnlyGetter(window, 'devicePixelRatio', () => config.screen.devicePixelRatio);
    if (window.visualViewport) {
      defineProtoGetter(window.visualViewport, 'width', config.screen.width);
      defineProtoGetter(window.visualViewport, 'height', config.screen.height);
      defineProtoGetter(window.visualViewport, 'scale', 1);
    }

    // matchMedia 劫持 ── CreepJS 的 src/screen/index.ts 用
    //   matchMedia('(device-width: WIDTHpx) and (device-height: HEIGHTpx)').matches
    // 来反查 screen.width/height 是否被 spoof（matchMedia 走浏览器层、绕过 JS getter）。
    // 同样还有 (resolution: Ndppx) 用于反查 devicePixelRatio。
    // 我们 hook MediaQueryList.prototype.matches 的 getter，对包含
    //   device-width / device-height / resolution 的 query 用 spoofed 值评估，
    // 其余 query 仍 forward 给 native。
    if (typeof MediaQueryList !== 'undefined') {
      const mqlProto = MediaQueryList.prototype;
      const matchesDesc = Object.getOwnPropertyDescriptor(mqlProto, 'matches');
      if (matchesDesc?.get) {
        const evalSpoofedQuery = (query: string): boolean | null => {
          // 切分 `(...) and (...) and (...)`，每段用我们识别的 axes 评估；
          // 任一段含未知 axis（如 hover、orientation、color）→ 返回 null（fallback to native）。
          const parts = query.trim().split(/\s+and\s+/i);
          if (parts.length === 0) return null;
          for (const partRaw of parts) {
            const m = /^\(\s*(min-|max-)?(device-width|device-height|resolution|width|height):\s*([\d.]+)\s*(px|dppx|dpi|dpcm)?\s*\)$/i.exec(
              partRaw.trim(),
            );
            if (!m) return null;
            const prefix = (m[1] ?? '').toLowerCase();
            const axis = (m[2] ?? '').toLowerCase();
            const num = Number.parseFloat(m[3] ?? 'NaN');
            const unit = (m[4] ?? '').toLowerCase();
            if (!Number.isFinite(num)) return null;
            let actual: number;
            if (axis === 'device-width' || axis === 'width') actual = config.screen.width;
            else if (axis === 'device-height' || axis === 'height') actual = config.screen.height;
            else if (axis === 'resolution') {
              if (unit === 'dppx') actual = config.screen.devicePixelRatio;
              else if (unit === 'dpi') actual = config.screen.devicePixelRatio * 96;
              else if (unit === 'dpcm') actual = config.screen.devicePixelRatio * 96 * 2.54;
              else return null;
            } else return null;
            if (prefix === 'min-') {
              if (!(actual >= num)) return false;
            } else if (prefix === 'max-') {
              if (!(actual <= num)) return false;
            } else {
              if (actual !== num) return false;
            }
          }
          return true;
        };
        const proxiedMatchesGetter = wrapStealth(matchesDesc.get, {
          apply(target, thisArg, args) {
            try {
              const media = (thisArg as MediaQueryList).media;
              const spoofed = evalSpoofedQuery(media);
              if (spoofed !== null) return spoofed;
            } catch {
              // fall through to native
            }
            return Reflect.apply(target, thisArg, args);
          },
        });
        Object.defineProperty(mqlProto, 'matches', {
          get: proxiedMatchesGetter,
          set: matchesDesc.set,
          enumerable: matchesDesc.enumerable ?? true,
          configurable: true,
        });
      }
    }
  } catch (err) {
    console.debug('[mosaiq] screen spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Timezone (Intl + Date)
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const OrigDateTimeFormat = Intl.DateTimeFormat;

    // ── Intl.DateTimeFormat constructor 用 Proxy 重写 ──
    //
    // Day 3.3 修复：旧实现用 `function (...args) { ... }` 替换 + 手动 setPrototypeOf +
    // defineProperty('prototype') —— 这导致 CreepJS lies/index.ts 的多个 detector
    // 全部 trigger:
    //   - Function.prototype.toString.call(patchedDTF) 返回 JS 源码 → failed toString
    //   - Object.getOwnPropertyDescriptors(patchedDTF) 含 prototype 字段 → failed descriptor keys
    //   - patchedDTF.hasOwnProperty('prototype') === true → failed own property
    //
    // Proxy 默认 forward 这些内省到 target（原 native DateTimeFormat），看起来像原生。
    // 详见 `bench/PHASE-1-NEXT-STEPS.md` §0.6 + Day 3 诊断脚本 `bench/diagnose-creepjs.ts`。
    const proxiedDTF = wrapStealth(OrigDateTimeFormat, {
      construct(target, args: ConstructorParameters<typeof Intl.DateTimeFormat>, newTarget) {
        const [locales, options] = args;
        const merged = { timeZone: config.timezone, ...options };
        return Reflect.construct(target, [locales, merged], newTarget);
      },
      apply(target, _thisArg, args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        // Intl.DateTimeFormat(...) 不带 new 时按 ECMA-402 等同于 new DateTimeFormat(...)
        const [locales, options] = args;
        const merged = { timeZone: config.timezone, ...options };
        return Reflect.construct(target, [locales, merged]);
      },
    });
    (Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat =
      proxiedDTF as unknown as typeof Intl.DateTimeFormat;

    // ── Date.prototype.getTimezoneOffset 用 Proxy 重写 ──
    //
    // 同样的 lies hidden 模式 —— 不能用普通 function 替换。
    // 注意：Proxy 的 apply trap 接收 thisArg，需要 forward 给 spoof 逻辑当作 Date 实例。
    const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    const proxiedGTO = wrapStealth(origGetTimezoneOffset, {
      apply(target, thisArg: Date) {
        try {
          const dt = new OrigDateTimeFormat('en-US', {
            timeZone: config.timezone,
            timeZoneName: 'shortOffset',
          });
          const parts = dt.formatToParts(thisArg);
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
        return Reflect.apply(target, thisArg, []);
      },
    });
    Date.prototype.getTimezoneOffset = proxiedGTO;
  } catch (err) {
    console.debug('[mosaiq] timezone spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3.5. SpeechSynthesis — TTS voices 暴露 OS 语言
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Windows / macOS TTS 暴露真实系统 voices（如中文系统给出 Microsoft Huihui [zh-CN]），
  // CreepJS speech detector：
  //   if (defaultVoiceLang.split('-')[0] !== Intl.locale.split('-')[0])
  //     LowerEntropy.TIME_ZONE = true  // → Intl `bold-fail`
  //
  // 修复：spoof speechSynthesis.getVoices() 返回 persona-consistent voices。
  // 详见 `bench/PHASE-1-NEXT-STEPS.md` §0.6 Day 3.5。
  if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisVoice !== 'undefined')
    try {
      const lang0 = config.languages[0] ?? 'en-US';
      const langPrefix = lang0.split('-')[0] ?? 'en';

      // 派生 voice 集合 —— 基于 persona locale。覆盖常见 OS TTS:
      //  - Windows: Microsoft <Name> Desktop - <Lang>
      //  - macOS:   <Name> (en-US)
      //  - Chromium 共通: Google <locale>
      const voiceTemplates: Record<string, Array<{ name: string; lang: string }>> = {
        en: [
          { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' },
          { name: 'Microsoft Zira Desktop - English (United States)', lang: 'en-US' },
          { name: 'Google US English', lang: 'en-US' },
        ],
        zh: [
          { name: 'Microsoft Huihui Desktop - Chinese (Simplified)', lang: 'zh-CN' },
          { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
        ],
        ja: [{ name: 'Microsoft Haruka Desktop - Japanese', lang: 'ja-JP' }],
        ko: [{ name: 'Microsoft Heami Desktop - Korean', lang: 'ko-KR' }],
        fr: [{ name: 'Microsoft Hortense Desktop - French', lang: 'fr-FR' }],
        de: [{ name: 'Microsoft Hedda Desktop - German', lang: 'de-DE' }],
      };

      const tpl = voiceTemplates[langPrefix] ??
        voiceTemplates.en ?? [
          { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' },
        ];

      // 构造伪 SpeechSynthesisVoice 对象，挂上原生 prototype 让 instanceof 检查通过
      const fakeVoices = tpl.map((v, i) => {
        const obj = Object.create(SpeechSynthesisVoice.prototype) as SpeechSynthesisVoice;
        Object.defineProperties(obj, {
          name: { value: v.name, enumerable: true },
          lang: { value: v.lang, enumerable: true },
          voiceURI: { value: v.name, enumerable: true },
          localService: { value: true, enumerable: true },
          default: { value: i === 0, enumerable: true }, // 第一个是 default
        });
        return obj;
      });

      const origGetVoices = SpeechSynthesis.prototype.getVoices;
      const proxiedGetVoices = wrapStealth(origGetVoices, {
        apply() {
          return fakeVoices;
        },
      });
      SpeechSynthesis.prototype.getVoices = proxiedGetVoices;
    } catch (err) {
      console.debug('[mosaiq] speech spoof failed', err);
    }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. WebGL
  // ═══════════════════════════════════════════════════════════════════════════

  // typeof guard：极端 headless / 测试环境可能没有 WebGL，提前跳过避免
  // ReferenceError 触发外层 catch 输出 console.debug 噪声。
  if (typeof WebGLRenderingContext !== 'undefined')
    try {
      const WEBGL_UNMASKED_VENDOR = 0x9245;
      const WEBGL_UNMASKED_RENDERER = 0x9246;

      // 用 Proxy 替换 getParameter — 关键点：Proxy 不重写 `toString`，所以
      //   `WebGLRenderingContext.prototype.getParameter.toString()`
      // 会 forward 到 target.toString() 返回 `function getParameter() { [native code] }`，
      // 而不是暴露我们的 JS 源码。这是 BrowserLeaks `! ` hook detection 的修复方案。
      // 详见 `bench/PHASE-1-NEXT-STEPS.md` §0.5 与 `DEVELOPMENT.md` §7。
      const makeGetParameterProxy = (orig: WebGLRenderingContext['getParameter']) =>
        wrapStealth(orig, {
          apply(target, thisArg, args: [number]) {
            const [pname] = args;
            if (pname === WEBGL_UNMASKED_VENDOR) return config.webglVendor;
            if (pname === WEBGL_UNMASKED_RENDERER) return config.webglRenderer;
            return Reflect.apply(target, thisArg, args);
          },
        });

      WebGLRenderingContext.prototype.getParameter = makeGetParameterProxy(
        WebGLRenderingContext.prototype.getParameter,
      );

      // WebGL2RenderingContext.prototype.getParameter 在 chromium 里通常**继承自** WebGL1
      // （同一个函数对象），但 spec 允许独立实现，所以保险起见两个都包一层 Proxy。
      // 注意：如果两者是同一函数对象，上面那一行已经替换了 WebGL1 的 prototype slot，
      // WebGL2 仍 inherit 那个 proxied 版本 — 但 `WebGL2.prototype.getParameter` 这个
      // own property（如果存在）需要单独处理。
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const desc = Object.getOwnPropertyDescriptor(
          WebGL2RenderingContext.prototype,
          'getParameter',
        );
        if (desc && typeof desc.value === 'function') {
          WebGL2RenderingContext.prototype.getParameter = makeGetParameterProxy(
            desc.value as WebGL2RenderingContext['getParameter'],
          );
        }
      }

      // readPixels 扰动 — 同样用 wrapStealth Proxy 保持 toString 透明
      if (config.webglPerturbReadPixels) {
        const prng = makePrng(config.webglNoiseSeed);
        const proxiedReadPixels = wrapStealth(WebGLRenderingContext.prototype.readPixels, {
          apply(target, thisArg, args) {
            Reflect.apply(target, thisArg, args);
            const pixels = args[6] as ArrayBufferView | null;
            if (pixels && pixels.byteLength > 0) {
              const view = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
              // 仅扰动 1% 像素，幅度 ±1。视觉不可察觉但 hash 改变
              const sampleCount = Math.max(1, Math.floor(view.length * 0.01));
              for (let i = 0; i < sampleCount; i++) {
                const idx = Math.floor(prng() * view.length);
                const delta = prng() < 0.5 ? -1 : 1;
                const current = view[idx] ?? 0;
                view[idx] = Math.max(0, Math.min(255, current + delta));
              }
            }
          },
        });
        WebGLRenderingContext.prototype.readPixels = proxiedReadPixels;
      }
    } catch (err) {
      console.debug('[mosaiq] webgl spoof failed', err);
    }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Canvas
  // ═══════════════════════════════════════════════════════════════════════════

  // typeof guard：测试环境通常没有 CanvasRenderingContext2D，跳过避免噪声。
  if (typeof HTMLCanvasElement !== 'undefined' && typeof CanvasRenderingContext2D !== 'undefined')
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
        HTMLCanvasElement.prototype.toDataURL = wrapStealth(origToDataURL, {
          apply(target, thisArg: HTMLCanvasElement, args: [string?, number?]) {
            const [type, quality] = args;
            const ctx = thisArg.getContext('2d');
            if (ctx && thisArg.width > 0 && thisArg.height > 0) {
              try {
                const imageData = ctx.getImageData(0, 0, thisArg.width, thisArg.height);
                perturbImageData(imageData);
                ctx.putImageData(imageData, 0, 0);
              } catch {
                // tainted canvas 或 CORS，跳过
              }
            }
            return Reflect.apply(target, thisArg, [type as string, quality]) as string;
          },
        });

        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = wrapStealth(origGetImageData, {
          apply(
            target,
            thisArg: CanvasRenderingContext2D,
            args: [number, number, number, number, ImageDataSettings?],
          ) {
            const imageData = Reflect.apply(target, thisArg, args) as ImageData;
            return perturbImageData(imageData);
          },
        });
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
      AnalyserNode.prototype.getFloatFrequencyData = wrapStealth(origGetFloat, {
        apply(target, thisArg: AnalyserNode, args: [Float32Array]) {
          Reflect.apply(target, thisArg, args);
          const [array] = args;
          for (let i = 0; i < array.length; i++) {
            array[i] = (array[i] ?? 0) + (audioPrng() - 0.5) * amplitude;
          }
        },
      });
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
      const origCheck = (document.fonts as FontFaceSet).check;
      (document.fonts as FontFaceSet).check = wrapStealth(origCheck, {
        apply(target, thisArg: FontFaceSet, args: [string, string?]) {
          const [font, text] = args;
          // 提取字体名：从 'bold 16px "Comic Sans MS"' 中取 "Comic Sans MS"
          const match = font.match(/(?:"([^"]+)"|'([^']+)'|([^\s,]+))(?:\s*,.*)?$/);
          const family = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim().toLowerCase();
          if (!family) return Reflect.apply(target, thisArg, [font, text]) as boolean;
          // 系统通用字体总是返回 true
          if (
            ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'].includes(family)
          ) {
            return Reflect.apply(target, thisArg, [font, text]) as boolean;
          }
          // 只有白名单内的字体返回 true
          return fontSet.has(family);
        },
      });
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
    // Permissions.prototype.query 必须用 wrapStealth Proxy 包装在 prototype 上。
    // 直接 navigator.permissions.query = fn 会让 CreepJS lies/index.ts 触发：
    //   - failed toString（暴露 JS 源码）
    //   - failed "prototype" in function（普通函数有 prototype，native 没有）
    //   - failed descriptor / own property（own keys 不是 ['length','name']）
    // → lieProps['Permissions.query'] = true
    // → CreepJS line 261 detectProxies = true → 全 API 升级到 advanced Proxy detection
    // → Timezone / WebGL / Screen / Navigator / DOMRect / Canvas 全部级联标 lies
    const handler: ProxyHandler<Permissions['query']> = {
      apply(target, thisArg: Permissions, args: [PermissionDescriptor]) {
        const [desc] = args;
        if (desc?.name === 'notifications') {
          return Promise.resolve({
            state: 'prompt',
            name: 'notifications',
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          } as unknown as PermissionStatus);
        }
        return Reflect.apply(target, thisArg, args);
      },
    };
    const PermsProto = (globalThis as unknown as { Permissions?: { prototype: Permissions } })
      .Permissions?.prototype;
    let proxiedFromProto: Permissions['query'] | null = null;
    if (PermsProto && typeof PermsProto.query === 'function') {
      // 优先 hook prototype —— 这是 CreepJS getPrototypeLies 实际扫描位置
      proxiedFromProto = wrapStealth(PermsProto.query, handler);
      PermsProto.query = proxiedFromProto;
    }
    // 验证 prototype hook 是否真生效。happy-dom / 部分实现把 query 内部 bind 到
    // instance 或走 C++ 直接调用，prototype 改了不会被走到 —— 此时需要 instance 兜底。
    if (
      typeof navigator.permissions?.query === 'function' &&
      navigator.permissions.query !== proxiedFromProto
    ) {
      const orig = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = wrapStealth(orig, handler);
    }
  } catch (err) {
    console.debug('[mosaiq] permissions spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. Worker / SharedWorker scope (Phase 1.5)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CreepJS worker-scope module 在 DedicatedWorker 内读 `navigator.userAgent /
  // hardwareConcurrency / deviceMemory / language / languages` 与 main scope
  // 比对，不一致即标 `does not match worker scope`。我们的 init script 仅注入
  // main world，worker 默认拿到的是 chromium 真实值（headless UA / 真 CPU
  // 核数 / 真内存），三条 lies 因此持续亮起。
  //
  // 修法：hook `Worker` / `SharedWorker` 构造器，把目标脚本通过 Blob URL 包成
  //   <spoof IIFE> + importScripts(absoluteUrl)   // classic
  //   <spoof IIFE> + import(absoluteUrl);         // module
  // 让 worker 启动后第一时间用 `Object.defineProperty` 覆盖 navigator getter。
  //
  // 限制（v0.1 范围）：
  //   - ServiceWorker 不覆盖（生命周期跨页面 + 单独 register 流程，留 v0.2）
  //   - Worker 内嵌套创建的 worker 不覆盖（main world hook 不传递）
  //   - 严格 CSP `script-src 'self'` 站点的 blob: 加载会失败 → fallback 原 Worker
  try {
    if (typeof Worker !== 'undefined') {
      const workerSpoofPayload = {
        userAgent: config.userAgent,
        appVersion: config.appVersion,
        platform: config.platform,
        vendor: config.vendor,
        language: config.languages[0] ?? 'en-US',
        languages: [...config.languages],
        hardwareConcurrency: config.hardwareConcurrency,
        deviceMemory: config.deviceMemory,
        maxTouchPoints: config.maxTouchPoints,
        webglVendor: config.webglVendor,
        webglRenderer: config.webglRenderer,
      };
      // 注意：var + forEach 是为了规避循环变量 closure 陷阱，并兼容老引擎。
      // 整段必须自包含、不引用外部 binding —— 它会被序列化进 Blob 在 worker
      // realm 重新执行，跟 main world 没有任何共享作用域。
      //
      // WebGL 部分：worker 内 OffscreenCanvas 仍能拿 WebGL/WebGL2 context；CreepJS
      //   会用 worker 的 getParameter 读 UNMASKED_VENDOR_WEBGL (0x9245) / RENDERER
      //   (0x9246)，发现 SwiftShader 之类 headless 真实值 → `hasBadWebGL: true`
      //   bold-fail。需把 main world 已做的 vendor/renderer 替换镜像到 worker。
      const workerSpoofSrc =
        '(function(){try{var P=' +
        JSON.stringify(workerSpoofPayload) +
        ';' +
        // navigator.* 覆盖
        'if(typeof navigator!=="undefined"){' +
        'var defs=[' +
        '["userAgent",P.userAgent],' +
        '["appVersion",P.appVersion],' +
        '["platform",P.platform],' +
        '["vendor",P.vendor],' +
        '["language",P.language],' +
        '["languages",Object.freeze(P.languages.slice())],' +
        '["hardwareConcurrency",P.hardwareConcurrency],' +
        '["deviceMemory",P.deviceMemory],' +
        '["maxTouchPoints",P.maxTouchPoints]' +
        '];' +
        'defs.forEach(function(pair){var k=pair[0],v=pair[1];' +
        'try{Object.defineProperty(navigator,k,{get:function(){return v;},configurable:true});}catch(e){}' +
        '});' +
        '}' +
        // WebGL 1/2 getParameter UNMASKED_VENDOR/RENDERER 覆盖
        'var ctxs=[];' +
        'if(typeof WebGLRenderingContext!=="undefined")ctxs.push(WebGLRenderingContext);' +
        'if(typeof WebGL2RenderingContext!=="undefined")ctxs.push(WebGL2RenderingContext);' +
        'ctxs.forEach(function(Ctx){' +
        'try{' +
        'var origGP=Ctx.prototype.getParameter;' +
        'Ctx.prototype.getParameter=function(pname){' +
        'if(pname===0x9245)return P.webglVendor;' +
        'if(pname===0x9246)return P.webglRenderer;' +
        'return origGP.call(this,pname);' +
        '};' +
        '}catch(e){}' +
        '});' +
        '}catch(e){}})();';

      function resolveWorkerScriptUrl(scriptUrl: string | URL): string {
        if (scriptUrl instanceof URL) return scriptUrl.href;
        const raw = String(scriptUrl);
        // blob: / data: 直接透传，importScripts 可吞同源 blob
        if (raw.startsWith('blob:') || raw.startsWith('data:')) return raw;
        return new URL(raw, location.href).href;
      }

      function buildWorkerInline(absoluteUrl: string, isModule: boolean): string {
        if (isModule) {
          return workerSpoofSrc + '\nimport(' + JSON.stringify(absoluteUrl) + ');';
        }
        return workerSpoofSrc + '\nimportScripts(' + JSON.stringify(absoluteUrl) + ');';
      }

      const OrigWorker = Worker;
      const wrappedWorker = wrapStealth(OrigWorker as unknown as Function, {
        construct(target, args: unknown[]) {
          try {
            const [scriptUrl, opts] = args as [string | URL, WorkerOptions?];
            const absoluteUrl = resolveWorkerScriptUrl(scriptUrl);
            const isModule = (opts as { type?: string } | undefined)?.type === 'module';
            const inline = buildWorkerInline(absoluteUrl, isModule);
            const blob = new Blob([inline], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            return Reflect.construct(
              target as unknown as new (...args: unknown[]) => Worker,
              [blobUrl, opts],
            );
          } catch {
            // CSP / cross-origin / 任何异常 → fallback 原始构造，不阻塞应用
            return Reflect.construct(
              target as unknown as new (...args: unknown[]) => Worker,
              args,
            );
          }
        },
      }) as unknown as typeof Worker;
      (globalThis as unknown as { Worker: typeof Worker }).Worker = wrappedWorker;

      // ServiceWorker hook —— CreepJS 优先用 navigator.serviceWorker.register('./creep.js')，
      // 完全绕开 Worker 构造器。我们必须把 SW 脚本本身改写成 [spoof IIFE + 原脚本]。
      // 做法：拦截 register(scriptUrl, opts) → fetch(absUrl) 拉同源脚本 → 拼装 →
      //   Blob URL → 用 blob: 注册。任何失败 fallback 到原 register（不破坏真 PWA）。
      //
      // 注意：Chrome 仍允许 blob: scheme 用于 SW 注册（M147 测过），但 scope 默认是
      // blob URL 路径，多数 fingerprint 站点不关心 scope，影响有限。
      try {
        const swContainer = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer })
          .serviceWorker;
        if (swContainer && typeof swContainer.register === 'function') {
          const origRegister = swContainer.register;
          const wrappedRegister = wrapStealth(origRegister as unknown as Function, {
            apply(target, thisArg: unknown, args: unknown[]) {
              return (async () => {
                try {
                  const [scriptUrl, options] = args as [
                    string | URL,
                    RegistrationOptions | undefined,
                  ];
                  const absUrl = new URL(String(scriptUrl), location.href).href;
                  // fetch 同源脚本（SW 本身就同源限制，浏览器会满足）
                  const resp = await fetch(absUrl, { credentials: 'same-origin' });
                  if (!resp.ok) throw new Error('sw script fetch failed');
                  const text = await resp.text();
                  const wrapped = workerSpoofSrc + '\n' + text;
                  const blob = new Blob([wrapped], { type: 'application/javascript' });
                  const blobUrl = URL.createObjectURL(blob);
                  return await Reflect.apply(
                    target as unknown as Function,
                    thisArg,
                    [blobUrl, options],
                  );
                } catch (err) {
                  // Chrome 自 M96 起拒绝 blob:/data: 协议注册 SW，无法把 spoof 注入
                  // SW realm。这种情况下走原始 register 会让指纹站拿到真实 navigator
                  // 数据。改为 reject —— CreepJS / 类似检测会 fallback 到 SharedWorker
                  // / DedicatedWorker（这两个我们 hook 了），spoof 仍生效。
                  //
                  // 代价：真实 PWA 在 Mosaiq 下注册 SW 会失败（offline / push 等降级），
                  // 后续 v0.2 通过 persona.swPolicy 配置切回 passthrough。
                  throw err instanceof Error ? err : new Error(String(err));
                }
              })();
            },
          });
          // serviceWorker.register 定义在 ServiceWorkerContainer.prototype，
          // 这里把实例上覆盖一份（外面调 navigator.serviceWorker.register(...) 时优先看 own）。
          Object.defineProperty(swContainer, 'register', {
            value: wrappedRegister,
            configurable: true,
            writable: true,
          });
        }
      } catch (err) {
        console.debug('[mosaiq] sw register hook failed', err);
      }

      if (typeof SharedWorker !== 'undefined') {
        const OrigSharedWorker = SharedWorker;
        const wrappedShared = wrapStealth(OrigSharedWorker as unknown as Function, {
          construct(target, args: unknown[]) {
            try {
              const [scriptUrl, opts] = args as [
                string | URL,
                string | WorkerOptions | undefined,
              ];
              const absoluteUrl = resolveWorkerScriptUrl(scriptUrl);
              const optObj = typeof opts === 'object' ? opts : undefined;
              const isModule = optObj?.type === 'module';
              const inline = buildWorkerInline(absoluteUrl, isModule);
              const blob = new Blob([inline], { type: 'application/javascript' });
              const blobUrl = URL.createObjectURL(blob);
              return Reflect.construct(
                target as unknown as new (...args: unknown[]) => SharedWorker,
                [blobUrl, opts],
              );
            } catch {
              return Reflect.construct(
                target as unknown as new (...args: unknown[]) => SharedWorker,
                args,
              );
            }
          },
        }) as unknown as typeof SharedWorker;
        (globalThis as unknown as { SharedWorker: typeof SharedWorker }).SharedWorker =
          wrappedShared;
      }
    }
  } catch (err) {
    console.debug('[mosaiq] worker scope spoof failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ✱ FINAL：原型环 + Function.prototype.toString 透明性 (Day 3.6)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 在所有 spoof block 完成后，把 `Function.prototype.toString` 替换为
  // wrapStealth Proxy —— 对 stealthRegistry 中注册过的函数返回**原生 toString 字符串**
  // （在 wrap 时已捕获，含正确 name），骗过 CreepJS `hasKnownToString` 白名单匹配。
  //
  // 关键：这里的 Proxy 也通过 wrapStealth 自注册，让
  //   `Function.prototype.toString.call(Function.prototype.toString)`
  // 也返回原 native 字符串（防止 `lieProps['Function.toString']` 检测）。
  try {
    // 早期版本曾在此处全局 wrap Object.setPrototypeOf / Reflect.setPrototypeOf，
    // 试图在循环时静默 no-op 或抛 TypeError。但这两种策略都被 CreepJS 抓到：
    //   - no-op + 不抛 → 'failed at too much recursion error' 预期 TypeError；
    //   - 主动 throw TypeError → 'failed at chain cycle error'（升级路径）期待 RangeError 而非
    //     TypeError，会立刻命中 lie。
    // 正确做法是让 per-proxy setPrototypeOf trap 模拟 V8 在直接 raw target
    // 上的同步循环检测（throw TypeError），其它场景（CreepJS 自己再包一层 proxy）
    // 让 V8 默认行为接管：先写入成功，后续 toString 链查时由 V8 抛 RangeError。
    // 因此这里不再覆盖全局 setPrototypeOf。

    if (!stealthState.functionToStringProxy) {
      // 走 wrapStealth：除了 apply trap，自动获得 stealthRegistry 注册 +
      // setPrototypeOf 循环检测 trap（与所有 spoof proxy 一致）。
      stealthState.functionToStringProxy = wrapStealth(stealthState.nativeFunctionToString, {
        apply(target, thisArg: unknown, args: unknown[]) {
          // 注册过的函数 → 返回 wrap 时捕获的 native 字符串
          if (typeof thisArg === 'function') {
            const cached = stealthRegistry.get(thisArg);
            if (cached !== undefined) return cached;
            return Reflect.apply(target, thisArg, args);
          }
          if (thisArg == null) throwFunctionToStringTypeError('Function');
          const proto = Object.getPrototypeOf(thisArg as object);
          let frameOwner: 'Function' | 'Object' = 'Function';
          if (typeof proto === 'function' && !stealthRegistry.has(proto)) {
            try {
              const source = Reflect.apply(stealthState.nativeFunctionToString, proto, []) as string;
              if (source === 'function () { [native code] }') frameOwner = 'Object';
            } catch {
              frameOwner = 'Object';
            }
          }
          throwFunctionToStringTypeError(frameOwner);
        },
      });
    }
    Function.prototype.toString = stealthState.functionToStringProxy;
  } catch (err) {
    console.debug('[mosaiq] toString stealth failed', err);
  }
}
