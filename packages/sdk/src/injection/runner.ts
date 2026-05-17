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

    // userAgentData（UA-CH）—— 完整覆盖 NavigatorUAData 表面。
    //
    // Chromium headless 模式默认 brand list 含 "HeadlessChrome"，跨 main / worker /
    // service worker realm 都会泄露。我们用 persona 派生的 `config.uaCh` 把：
    //   - 静态属性: brands / mobile / platform
    //   - 异步方法: getHighEntropyValues(hints)
    // 全部覆盖。任何调用方拿到的都是按 Chrome 105+ UA-CH reduction 政策格式化的值。
    //
    // 注意：每次访问 brands / 每次 getHighEntropyValues 都返回新对象（数组/对象
    // 深拷贝），防止指纹脚本通过 mutation 在我们 spoof 之间注入污染。
    if ('userAgentData' in navigator) {
      const nav = navigator as Navigator & { userAgentData?: unknown };
      const uad = nav.userAgentData as
        | {
            brands?: { brand: string; version: string }[];
            mobile?: boolean;
            platform?: string;
            getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
            toJSON?: () => Record<string, unknown>;
          }
        | undefined;
      if (uad) {
        const uaCh = config.uaCh;
        // 关键：NavigatorUAData 实例 own 属性的 defineProperty 会**静默失败**
        // （Chromium WebIDL interface 实例不允许新增 own slot），但其 prototype
        // 上的 brands / mobile / platform getter 是 `configurable: true` 的访问器，
        // 可以原地替换。所以这里直接动 prototype。
        // 该 prototype 仅给 navigator.userAgentData 这一个实例用，redefinition
        // 副作用为 0（不会污染别的对象）。
        const uadProto = Object.getPrototypeOf(uad);
        if (uadProto) {
          defineReadOnlyGetter(uadProto, 'brands', () => uaCh.brands.map((b) => ({ ...b })));
          defineReadOnlyGetter(uadProto, 'mobile', () => uaCh.mobile);
          defineReadOnlyGetter(uadProto, 'platform', () => uaCh.platform);
        }

        // getHighEntropyValues —— 按 hints 子集返回。
        // Chromium 现行行为：未请求的字段不出现在返回对象里；brands/mobile/platform
        // 即使不请求也总会出现（low-entropy baseline）。我们 mirror 这个语义。
        if (typeof uad.getHighEntropyValues === 'function') {
          const origGHEV = uad.getHighEntropyValues;
          const wrappedGHEV = wrapStealth(origGHEV as unknown as Function, {
            apply(_target, _thisArg, args: unknown[]) {
              const hints = Array.isArray(args[0]) ? (args[0] as string[]) : [];
              const result: Record<string, unknown> = {
                brands: uaCh.brands.map((b) => ({ ...b })),
                mobile: uaCh.mobile,
                platform: uaCh.platform,
              };
              for (const hint of hints) {
                switch (hint) {
                  case 'architecture':
                    result.architecture = uaCh.architecture;
                    break;
                  case 'bitness':
                    result.bitness = uaCh.bitness;
                    break;
                  case 'model':
                    result.model = uaCh.model;
                    break;
                  case 'platformVersion':
                    result.platformVersion = uaCh.platformVersion;
                    break;
                  case 'wow64':
                    result.wow64 = uaCh.wow64;
                    break;
                  case 'fullVersionList':
                    result.fullVersionList = uaCh.fullVersionList.map((b) => ({ ...b }));
                    break;
                  case 'formFactors':
                    result.formFactors = ['Desktop'];
                    break;
                  default:
                    // 未知 hint 静默忽略（与 Chromium 默认行为一致）
                    break;
                }
              }
              return Promise.resolve(result);
            },
          });
          // 同上 —— getHighEntropyValues 也在 NavigatorUAData.prototype 上。
          if (uadProto) {
            try {
              Object.defineProperty(uadProto, 'getHighEntropyValues', {
                value: wrappedGHEV,
                configurable: true,
                writable: true,
              });
            } catch {
              // 极个别 Chromium 版本上 proto 也被冻 —— 接受降级（静态属性仍生效）
            }
          }
        }

        // toJSON()：CreepJS / 其他检测脚本会直接 JSON.stringify(uad)，需要它也返回
        // 同一组 spoofed 值，否则两条路径数据不一致 → 立刻被判 lies。
        if (uadProto) {
          try {
            Object.defineProperty(uadProto, 'toJSON', {
              value: function toJSON() {
                return {
                  brands: uaCh.brands.map((b) => ({ ...b })),
                  mobile: uaCh.mobile,
                  platform: uaCh.platform,
                };
              },
              configurable: true,
              writable: true,
            });
          } catch {
            // ignore — toJSON 不是 ID 杀手
          }
        }
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

      // ── GL capability 参数表（Phase 1.9） ──
      //
      // Profile 由 build-config.ts 按 persona.gpu.webglRenderer 选定；map 内的 key
      // 是 hex 字符串（"0x0d33"），value 是 number 或 number[]。我们把它重建成
      // pname → 值 的查找表，typed-array 值在重建时按 IDL 规定的 Int32Array /
      // Float32Array 包回。这样 getParameter Proxy 能直接 O(1) 找替换值。
      //
      // 哪些 pname 需要 Int32Array vs Float32Array —— 与 webgl-profiles.ts 内
      // INT32_ARRAY_PARAMS / FLOAT32_ARRAY_PARAMS 同步（这里复刻一份避免跨文件
      // 依赖；runner 序列化进 page 后没有外部 import）。
      const INT32_PNAMES = new Set<number>([
        0x0d3a, // MAX_VIEWPORT_DIMS
      ]);
      const FLOAT32_PNAMES = new Set<number>([
        0x846e, // ALIASED_LINE_WIDTH_RANGE
        0x846d, // ALIASED_POINT_SIZE_RANGE
      ]);

      // string return type 的 GL pname（VENDOR/RENDERER/VERSION/SHADING_LANGUAGE_VERSION）
      // 对应 webgl-profiles.ts 内 STRING_PARAMS。runner 序列化进 page 后没有外部 import，
      // 这里复刻一份。
      const STRING_PNAMES = new Set<number>([
        0x1f00, // VENDOR
        0x1f01, // RENDERER
        0x1f02, // VERSION
        0x8b8c, // SHADING_LANGUAGE_VERSION
      ]);

      type SpoofVal = number | string | Int32Array | Float32Array;

      const buildSpoofMap = (
        serialized: Readonly<Record<string, number | readonly number[] | string>> | undefined,
      ): Map<number, SpoofVal> => {
        const out = new Map<number, SpoofVal>();
        if (!serialized) return out;
        for (const [hex, val] of Object.entries(serialized)) {
          const pname = parseInt(hex, 16);
          if (Array.isArray(val)) {
            // CreepJS 等 hash typed array 的 BYTES_PER_ELEMENT + .length + .buffer
            // 指纹，必须用真正的 Int32Array / Float32Array 而非普通 number[]。
            // 否则 Array.isArray(value) === true 反而暴露 spoof。
            if (INT32_PNAMES.has(pname)) {
              out.set(pname, new Int32Array(val));
            } else if (FLOAT32_PNAMES.has(pname)) {
              out.set(pname, new Float32Array(val));
            } else {
              // 未知 pname 默认 Int32Array（GL 多数 array 参数是整数 limit）
              out.set(pname, new Int32Array(val));
            }
          } else if (typeof val === 'number') {
            out.set(pname, val);
          } else if (typeof val === 'string') {
            // sanity: string 仅允许在 VENDOR/RENDERER/VERSION/SHADING_LANGUAGE_VERSION
            if (!STRING_PNAMES.has(pname)) {
              console.debug(`[mosaiq] webgl spoof: unexpected string for pname 0x${pname.toString(16)}`);
            }
            out.set(pname, val);
          }
        }
        return out;
      };

      const webgl1Spoof = buildSpoofMap(config.webglProfile?.webgl1);
      const webgl2Spoof = buildSpoofMap(config.webglProfile?.webgl2);
      // WebGL2 context 也会读 WebGL1 参数（继承），所以 merge 两表给 WebGL2 用。
      // **关键**：webgl2 优先 —— VERSION / SHADING_LANGUAGE_VERSION 在 WebGL1 是
      // "WebGL 1.0..."，WebGL2 是 "WebGL 2.0..."，merge 时 webgl2 必须覆盖 webgl1 同 key。
      // Map 构造按入参顺序后写覆盖前写，所以 [...webgl1Spoof, ...webgl2Spoof] 即正确顺序。
      const webgl2MergedSpoof = new Map<number, SpoofVal>([
        ...webgl1Spoof,
        ...webgl2Spoof,
      ]);

      // 用 Proxy 替换 getParameter — 关键点：Proxy 不重写 `toString`，所以
      //   `WebGLRenderingContext.prototype.getParameter.toString()`
      // 会 forward 到 target.toString() 返回 `function getParameter() { [native code] }`，
      // 而不是暴露我们的 JS 源码。这是 BrowserLeaks `! ` hook detection 的修复方案。
      // 详见 `bench/PHASE-1-NEXT-STEPS.md` §0.5 与 `DEVELOPMENT.md` §7。
      //
      // Phase 1.9：spoof 表查找 → typed array 每次返回一份新 copy（real GL 也是
      // 每调用一次构造新 typed array，缓存同一引用会被 CreepJS 检出"返回相同对象"）。
      // string / number 是 immutable primitive，直接返回即可（不需 clone）。
      const cloneSpoofValue = (v: SpoofVal) => {
        if (typeof v === 'number' || typeof v === 'string') return v;
        if (v instanceof Int32Array) return new Int32Array(v);
        return new Float32Array(v);
      };

      const makeGetParameterProxy = (
        orig: WebGLRenderingContext['getParameter'],
        spoofMap: ReadonlyMap<number, SpoofVal>,
      ) =>
        wrapStealth(orig, {
          apply(target, thisArg, args: [number]) {
            const [pname] = args;
            if (pname === WEBGL_UNMASKED_VENDOR) return config.webglVendor;
            if (pname === WEBGL_UNMASKED_RENDERER) return config.webglRenderer;
            const spoofed = spoofMap.get(pname);
            if (spoofed !== undefined) return cloneSpoofValue(spoofed);
            return Reflect.apply(target, thisArg, args);
          },
        });

      WebGLRenderingContext.prototype.getParameter = makeGetParameterProxy(
        WebGLRenderingContext.prototype.getParameter,
        webgl1Spoof,
      );

      // WebGL2RenderingContext.prototype.getParameter 在 chromium 里通常**继承自** WebGL1
      // （同一个函数对象），但 spec 允许独立实现，所以保险起见两个都包一层 Proxy。
      // 注意：如果两者是同一函数对象，上面那一行已经替换了 WebGL1 的 prototype slot，
      // WebGL2 仍 inherit 那个 proxied 版本 — 但 `WebGL2.prototype.getParameter` 这个
      // own property（如果存在）需要单独处理。
      //
      // Phase 1.9：WebGL2 用 merged spoof（包含 WebGL1 + WebGL2 全部参数）。
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const desc = Object.getOwnPropertyDescriptor(
          WebGL2RenderingContext.prototype,
          'getParameter',
        );
        if (desc && typeof desc.value === 'function') {
          WebGL2RenderingContext.prototype.getParameter = makeGetParameterProxy(
            desc.value as WebGL2RenderingContext['getParameter'],
            webgl2MergedSpoof,
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
  //
  // Phase 2.4: 双 guard 防 CreepJS canvas lies / LowerEntropy.CANVAS 触发
  //
  // 历史：v0.2 对所有 pixel 加 ±1 LSB noise。CreepJS canvas/index.ts 有两条
  // 独立 lies/lower-entropy 检测：
  //
  //   Check 1 "pixel data modified"：clearRect(0,0,W,H) + getImageData(0,0,8,8)
  //     检查 Math.max(...data) > 0。我们的噪声让清空 8x8 区域的 R/G/B 从 0 变
  //     成 0 或 1（负 delta clamp 到 0，正 delta 到 1）→ max==1 → lies trigger
  //
  //   Check 2 "suspicious pixel data"：canvas=2x2 上画特定 fillRect+arc+fill
  //     pattern，getImageData(0,0,2,2) join('') 与硬编码 KnownImageData
  //     (BLINK/GECKO/WEBKIT 各 ~8 个) 比对。我们的噪声让真值偏移 ±1
  //     → 不匹配任何 KnownImageData → LowerEntropy.CANVAS=true
  //
  // 修复策略（Phase 2.4）：
  //
  //   - **isProbeCanvas**：canvas.width ≤ 16 && height ≤ 16 → 跳过 noise
  //     处理 Check 2（CreepJS 2x2 probe canvas）。真实 fingerprinter 用
  //     >= 50x50（CreepJS textURI / browserleaks 220x30），不受影响。
  //
  //   - **isAllZero**：getImageData 返回区域全 0 → 跳过 noise
  //     处理 Check 1（cleared 8x8 region on 50x50 canvas — 大 canvas 不被
  //     isProbeCanvas 跳过，但读到的区域全 0，仍跳过 noise）
  //
  // 副作用分析：
  //   - 失去 ≤16x16 canvas 的 spoof：fingerprinter 几乎不用这种尺寸
  //   - 失去 cleared/transparent 区域的 spoof：本来就没有可指纹化的内容
  //   - 保留 ≥17x17 canvas + 有内容区域的 spoof：browserleaks-canvas / CreepJS
  //     textURI emojiURI / sannysoft canvas 等仍正常打 noise → uniqueness 不退化
  // ═══════════════════════════════════════════════════════════════════════════

  // typeof guard：测试环境通常没有 CanvasRenderingContext2D，跳过避免噪声。
  if (typeof HTMLCanvasElement !== 'undefined' && typeof CanvasRenderingContext2D !== 'undefined')
    try {
      const strength = config.canvasNoiseStrength;
      if (strength > 0) {
        const prngSeed = config.canvasNoiseSeed;

        // Phase 2.4 guard 1: 探测 canvas 是否是 CreepJS-style probe（≤16x16）
        function isProbeCanvas(canvas: HTMLCanvasElement): boolean {
          return canvas.width <= 16 && canvas.height <= 16;
        }

        // Phase 2.4 guard 2: 探测 ImageData 是否全 0（cleared / transparent）
        // O(n) 扫描；探测 region ≤ 8x8 = 256 byte 的情况下成本可忽略
        function isAllZero(data: Uint8ClampedArray): boolean {
          for (let i = 0; i < data.length; i++) {
            if (data[i] !== 0) return false;
          }
          return true;
        }

        function perturbImageData(imageData: ImageData): ImageData {
          // Phase 2.4: 防 CreepJS Check 1 "pixel data modified"
          // 全 0 区域（clearRect 后）不加 noise，保留 Math.max(...) === 0
          if (isAllZero(imageData.data)) return imageData;

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
            // Phase 2.4: skip probe-size canvas（防 CreepJS Check 2 "suspicious
            // pixel data"，2x2 probe 走原 path → 命中 KnownImageData → low entropy 不触发）
            if (
              ctx &&
              thisArg.width > 0 &&
              thisArg.height > 0 &&
              !isProbeCanvas(thisArg)
            ) {
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
            // Phase 2.4: skip probe-size canvas（同上）
            if (thisArg.canvas && isProbeCanvas(thisArg.canvas)) {
              return imageData;
            }
            // perturbImageData 内会再做 isAllZero check 防 Check 1
            return perturbImageData(imageData);
          },
        });
      }
    } catch (err) {
      console.debug('[mosaiq] canvas spoof failed', err);
    }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. AudioContext + AudioBuffer
  //
  // Phase 4.1: 在 v0.3 之前 §6 只 hook AnalyserNode.getFloatFrequencyData
  // （real-time spectrum）+ AudioContext.sampleRate getter。但**经典 audio
  // fingerprint**（CreepJS / fp.com / FingerprintJS audio probe）走的是另一条
  // 路径 —— OfflineAudioContext + DynamicsCompressor + AudioBuffer.getChannelData：
  //
  //   const ctx = new OfflineAudioContext(1, 5000, 44100);
  //   const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency = 10000;
  //   const cmp = ctx.createDynamicsCompressor(); // threshold/knee/ratio/attack/release
  //   osc.connect(cmp); cmp.connect(ctx.destination);
  //   osc.start();
  //   return ctx.startRendering().then(buf => {
  //     const data = buf.getChannelData(0);
  //     let sum = 0;
  //     for (let i = 0; i < buf.length; i++) sum += Math.abs(data[i]);
  //     return hashMini(sum.toString());
  //   });
  //
  // 这条路径在 v0.3 完全裸奔：oscillator + compressor 渲染结果 deterministic
  // （同 Chrome+OS+ANGLE 永远一样），detector 拿稳定 hash 跨 persona 关联。
  //
  // 修法：hook AudioBuffer.prototype.getChannelData —— 一次 hook 覆盖
  //   - OfflineAudioContext.startRendering 渲染结果
  //   - 实时 AudioContext.createBuffer / decodeAudioData 解码 PCM
  //   - 任何其他 AudioBuffer 来源
  // 直接在返回的 Float32Array 上 in-place 加 1e-7 量级 noise，量级远小于
  // 16-bit PCM quantization (≈3e-5)，听感无差异。但 5000 sample × 5e-8
  // random walk ≈ 1e-4 累积偏移，改变 sum.toString() 第 4-6 位 → hash 必变。
  //
  // per-channel seed XOR：左右声道用不同 noise，避免 stereo correlation 检测。
  //
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const audioPrng = makePrng(config.audioNoiseSeed);
    const amplitude = config.audioNoiseAmplitude;
    // Phase 5.1: dB-domain 独立 amplitude（v0.2 ~ v0.4 共用 1e-7 PCM 值
    // 会被 Float32 ULP @ -50 dB ≈ 3.8e-6 round 清零；0.001 dB ≈ 250× ULP
    // 远低于人耳 JND ~1 dB，但保证 hash 必变）
    const amplitudeDb = config.audioNoiseAmplitudeDb;

    if (typeof AnalyserNode !== 'undefined') {
      const origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = wrapStealth(origGetFloat, {
        apply(target, thisArg: AnalyserNode, args: [Float32Array]) {
          Reflect.apply(target, thisArg, args);
          const [array] = args;
          for (let i = 0; i < array.length; i++) {
            array[i] = (array[i] ?? 0) + (audioPrng() - 0.5) * amplitudeDb;
          }
        },
      });
    }

    // Phase 4.1: AudioBuffer.getChannelData 拦截（CreepJS / fp.com 经典路径）
    // Phase 5.4c: + AudioBuffer.copyFromChannel / copyToChannel 同序列 mirror
    //             修 CreepJS 'getChannelData and copyFromChannel samples mismatch'
    //             yellow lies。CreepJS audio.ts 直接 cross-check：
    //               buffer.copyFromChannel(copy, 0)  // 原始数据 → copy
    //               bins = buffer.getChannelData(0)  // in-place 加 noise → bins
    //               if (binsSample[4500..4600] !== copySample[4500..4600]) lied=true
    //             v0.5.0 只 hook getChannelData → copy 没噪声、bins 有噪声 → mismatch。
    //             修法：copyFromChannel hook 用同一 PRNG 序列（seed XOR channel）
    //             把同一 pattern 写到 destination；copyToChannel 反向 mirror，
    //             让 caller 写入的非零样本同样吸纳 noise，保下次 getChannelData
    //             cross-check 一致。
    if (typeof AudioBuffer !== 'undefined') {
      // 共享的 noise applier：在已 populate 的 Float32Array 上施加 channel-seeded
      // PRNG noise（skip-zero 规则与 Phase 5.2b 一致）。所有三个 hook 复用同一逻辑，
      // 保 getChannelData / copyFromChannel / copyToChannel 跨调用样本一致。
      const applyAudioNoise = (target: Float32Array, channel: number): void => {
        const channelPrng = makePrng((config.audioNoiseSeed ^ channel) >>> 0);
        for (let i = 0; i < target.length; i++) {
          const sample = target[i] ?? 0;
          // PRNG 每样本 advance（保 deterministic 序列），noise 仅条件 add
          const noise = (channelPrng() - 0.5) * amplitude;
          if (sample !== 0) target[i] = sample + noise;
        }
      };

      const origGCD = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = wrapStealth(origGCD, {
        apply(target, thisArg: AudioBuffer, args: [number]) {
          const buffer = Reflect.apply(target, thisArg, args) as Float32Array;
          // per-channel deterministic PRNG：seed XOR channel index
          // 左右声道用不同 noise 序列，避免 detector 比对左右相关性
          const channel = (args[0] ?? 0) | 0;
          // Phase 5.2b：silent (==0) samples 保留原值，仅给 non-zero samples 加 noise。
          // CreepJS audio test 跑 OfflineAudioContext + DynamicsCompressor 5000-sample
          // 渲染，attack ramp 之前样本应该是 exact 0（real Chrome 行为）。如果给所有
          // 样本加 noise，5000 样本全 unique → CreepJS unique:5000 → bold-fail。
          // 跳过 0 让 silence pattern 与 real Chrome 一致；non-zero 样本仍带 PRNG noise，
          // sum/hash 仍 per-persona unique，跨 persona 区分依然成立。
          applyAudioNoise(buffer, channel);
          return buffer;
        },
      });

      // Phase 5.4c: copyFromChannel(destination, channelNumber, bufferOffset?)
      // 真实语义：从 buffer 的 channelNumber 通道复制 [bufferOffset..bufferOffset+
      // destination.length) 区间到 destination。对于 CreepJS 路径 bufferOffset=0
      // 且 destination.length === buffer.length，所以 PRNG advance 步数一致 →
      // destination 与 getChannelData 返回值会逐样本相等（同 seed^channel + 同 skip-
      // zero 规则）。bufferOffset > 0 时 PRNG 起点不同，仍 deterministic 但样本量
      // 减少，不会与同次 getChannelData 直接相等 —— 但 CreepJS 不在该路径上做相等
      // 比对，可接受。
      const origCopyFrom = AudioBuffer.prototype.copyFromChannel;
      if (typeof origCopyFrom === 'function') {
        AudioBuffer.prototype.copyFromChannel = wrapStealth(origCopyFrom, {
          apply(target, thisArg: AudioBuffer, args: [Float32Array, number, number?]) {
            Reflect.apply(target, thisArg, args);
            const destination = args[0];
            const channel = (args[1] ?? 0) | 0;
            // bufferOffset 默认 0，CreepJS 走该 default
            applyAudioNoise(destination, channel);
          },
        });
      }

      // Phase 5.4c: copyToChannel(source, channelNumber, bufferOffset?)
      // 反向 mirror：caller 写入新数据到通道。先把 source 噪声化（in-place 给
      // caller 的 Float32Array 加 noise），再调原 native 把噪声化数据写进 buffer。
      // 这样下一次 getChannelData / copyFromChannel 读出来的样本就已经吸纳 noise，
      // 跨 access path 保持一致。
      // 注意：source 是 readonly Float32Array per spec，但 noise 是 add-then-write，
      // 不会破坏 caller 之外的 source 内容（只改 caller 自己刚分配的数组）。
      const origCopyTo = AudioBuffer.prototype.copyToChannel;
      if (typeof origCopyTo === 'function') {
        AudioBuffer.prototype.copyToChannel = wrapStealth(origCopyTo, {
          apply(target, thisArg: AudioBuffer, args: [Float32Array, number, number?]) {
            const source = args[0];
            const channel = (args[1] ?? 0) | 0;
            applyAudioNoise(source, channel);
            return Reflect.apply(target, thisArg, args);
          },
        });
      }
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
  // 10.5. Notification.permission + navigator.plugins / mimeTypes / pdfViewerEnabled
  //
  // 这一块覆盖 sannysoft 上仍亮红的 4 个 legacy 检测器：
  //   - Permissions (New)     ← Notification.permission='denied' + permissions.query='prompt' 不一致 → 老 headless bug
  //   - Plugins Length (Old)  ← navigator.plugins.length === 0
  //   - Plugins is of type PluginArray ← navigator.plugins 不是 PluginArray 实例
  //   - HEADCHR_PLUGINS / HEADCHR_PERMISSIONS ← fpscanner 同款检测
  //
  // 实现策略：
  //   - Chrome 88+ 给所有用户硬编码 5 个 PDF 插件（PDF Viewer / Chrome PDF Viewer /
  //     Chromium PDF Viewer / Microsoft Edge PDF Viewer / WebKit built-in PDF），
  //     全部映射到内部 `internal-pdf-viewer` filename。每个用户都拿到同一份 → 0 entropy。
  //   - mimeTypes 跟着挂 application/pdf 与 text/pdf，enabledPlugin 指向 PDF Viewer。
  //   - Notification.permission = 'default'（headless 默认 'denied'，real Chrome 'default'）。
  //     与 §10 permissions.query='prompt' 配合，sannysoft "Permissions (New)" 通过。
  //
  // 反检测兼容：
  //   - 所有 plugin / mimeType 用 Object.create(<原型>) 构造，保证 instanceof 通过。
  //   - 用 defineProtoGetter 在 Navigator.prototype 上挂 plugins/mimeTypes/pdfViewerEnabled
  //     的 [[Replaceable]] getter（不留 own property，getter.toString() 仍是 native）。
  //   - 不引入新的 own keys，CreepJS getPrototypeLies 扫不到异常。
  // ═══════════════════════════════════════════════════════════════════════════

  // 10.5.a Notification.permission
  try {
    if (typeof Notification !== 'undefined') {
      const desc = Object.getOwnPropertyDescriptor(Notification, 'permission');
      if (desc?.get) {
        const proxiedGetter = wrapStealth(desc.get, {
          apply: () => 'default',
        });
        Object.defineProperty(Notification, 'permission', {
          get: proxiedGetter,
          configurable: true,
        });
      }
    }
  } catch (err) {
    console.debug('[mosaiq] Notification.permission spoof failed', err);
  }

  // 10.5.b navigator.plugins / navigator.mimeTypes / navigator.pdfViewerEnabled
  try {
    if (
      typeof PluginArray === 'undefined' ||
      typeof Plugin === 'undefined' ||
      typeof MimeType === 'undefined' ||
      typeof MimeTypeArray === 'undefined'
    ) {
      // 极端 host（部分 worker / test 环境）没这些构造函数 —— 静默跳过
      throw new Error('plugin/mime constructors unavailable');
    }

    // ---- 1. PDF plugins & mime metadata (Chrome 88+ 公开常量) ----
    const pluginData = [
      { name: 'PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chromium PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Microsoft Edge PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'WebKit built-in PDF', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
    ];
    const mimeData = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ];

    // ---- 2. MimeType 实例（继承 MimeType.prototype 通过 instanceof） ----
    //
    // 真实 Chromium 的 MimeType IDL 属性（type/suffixes/description/enabledPlugin）都是
    // **prototype getter**，不是 own enumerable property。Object.values(mimeType) 在
    // real chrome 返回 `[]`。
    //
    // 我们把这些 metadata 设成 **enumerable: false**，与 real chrome 行为一致；CreepJS
    // `getPluginLies` 内部的 `Object.values(plugin).map(m => m.type)` 不会被这些数据污染
    // （参见 §10.5.b 末端的 `Object.values` 注释）。
    const mimeInstances = mimeData.map((m) => {
      const mt = Object.create(MimeType.prototype) as MimeType & { enabledPlugin?: Plugin };
      Object.defineProperties(mt, {
        type: { value: m.type, enumerable: false, configurable: false },
        suffixes: { value: m.suffixes, enumerable: false, configurable: false },
        description: { value: m.description, enumerable: false, configurable: false },
      });
      return mt;
    });

    // ---- 3. Plugin 实例（每个 plugin 内部嵌 mimeTypes，支持索引访问） ----
    //
    // **关键**：name / description / filename / length 必须 `enumerable: false`。
    // 原因：CreepJS `getPluginLies()` 在 `src/lies/index.ts` 里这样取 plugin 的 mimeTypes:
    //
    //   pluginsList.forEach((plugin) => {
    //     const pluginMimeTypes = Object.values(plugin).map((mt) => mt.type)
    //     pluginMimeTypes.forEach((mt) => {
    //       if (!trustedMimeTypes.has(mt)) lies.push('invalid mimetype');
    //     })
    //   })
    //
    // 即只期望 `Object.values(plugin)` 返回 MimeType 列表（numeric indices）。如果我们
    // 把 metadata 也设成 enumerable，`Object.values` 会返回 `[<MimeType>×2, "PDF Viewer",
    // "Portable...", "internal-pdf-viewer"]`，字符串 `.type === undefined`，CreepJS 标 5
    // 个 invalid mimetype → Navigator lies 触发。Phase 1.9 真机 bench 即由此导致回归。
    //
    // 修复：metadata enumerable:false（与 real chrome IDL 一致 —— 这些都是 prototype
    // attribute getter，不应作为 own property 出现在 instance 上）。
    const pluginInstances = pluginData.map((p) => {
      const plugin = Object.create(Plugin.prototype) as Plugin;
      Object.defineProperties(plugin, {
        name: { value: p.name, enumerable: false, configurable: false },
        description: { value: p.description, enumerable: false, configurable: false },
        filename: { value: p.filename, enumerable: false, configurable: false },
        length: { value: mimeInstances.length, enumerable: false, configurable: false },
      });
      // plugin[0], plugin[1] → mimeType（数字索引保留 enumerable:true，与 real chrome 一致）
      mimeInstances.forEach((mt, j) => {
        Object.defineProperty(plugin, String(j), { value: mt, enumerable: true });
      });
      Object.defineProperty(plugin, 'item', {
        value: (n: number) => mimeInstances[n] ?? null,
        configurable: true,
      });
      Object.defineProperty(plugin, 'namedItem', {
        value: (n: string) => mimeInstances.find((mt) => mt.type === n) ?? null,
        configurable: true,
      });
      return plugin;
    });

    // 双向：mimeType.enabledPlugin → PDF Viewer（任选 plugins[0]）。同样 enumerable:false
    // 与 real chrome IDL 一致。
    mimeInstances.forEach((mt) => {
      Object.defineProperty(mt, 'enabledPlugin', {
        value: pluginInstances[0],
        enumerable: false,
        configurable: false,
      });
    });

    // ---- 4. PluginArray ----
    const fakePluginArray = Object.create(PluginArray.prototype) as PluginArray;
    pluginInstances.forEach((p, i) => {
      Object.defineProperty(fakePluginArray, String(i), { value: p, enumerable: true });
      // 命名访问：navigator.plugins['PDF Viewer'] → plugin
      Object.defineProperty(fakePluginArray, p.name, { value: p, enumerable: false });
    });
    Object.defineProperties(fakePluginArray, {
      length: { value: pluginInstances.length, enumerable: false, configurable: false },
      item: {
        value: (n: number) => pluginInstances[n] ?? null,
        configurable: true,
      },
      namedItem: {
        value: (n: string) => pluginInstances.find((p) => p.name === n) ?? null,
        configurable: true,
      },
      refresh: { value: () => {}, configurable: true },
    });

    // ---- 5. MimeTypeArray ----
    const fakeMimeArray = Object.create(MimeTypeArray.prototype) as MimeTypeArray;
    mimeInstances.forEach((mt, i) => {
      Object.defineProperty(fakeMimeArray, String(i), { value: mt, enumerable: true });
      Object.defineProperty(fakeMimeArray, mt.type, { value: mt, enumerable: false });
    });
    Object.defineProperties(fakeMimeArray, {
      length: { value: mimeInstances.length, enumerable: false, configurable: false },
      item: {
        value: (n: number) => mimeInstances[n] ?? null,
        configurable: true,
      },
      namedItem: {
        value: (n: string) => mimeInstances.find((mt) => mt.type === n) ?? null,
        configurable: true,
      },
    });

    // ---- 6. 挂到 Navigator.prototype 上（与其他 navigator 字段同款 stealth 路径） ----
    defineProtoGetter(navigator, 'plugins', fakePluginArray);
    defineProtoGetter(navigator, 'mimeTypes', fakeMimeArray);
    // pdfViewerEnabled 是 Chrome 88+ 引入的布尔，PDF 插件存在时为 true。
    // 真实 Chrome 全局 true（统一硬编码，与 plugins 同样无 entropy）。
    defineProtoGetter(navigator, 'pdfViewerEnabled', true);
  } catch (err) {
    console.debug('[mosaiq] plugins/mimeTypes spoof failed', err);
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
        // Phase 2.6: 完整 49-param WebGL spoof 镜像（main scope §4）。worker 内
        // CreepJS 通过 OffscreenCanvas 拿 WebGL/WebGL2 context，读 49 个 capability
        // 参数。仅靠 UNMASKED_VENDOR/RENDERER 两个字符串 spoof 不够 —— 跨 scope
        // capability hash 一致性失败立刻被 CreepJS 标 `does not match worker scope`。
        // 这里把 main scope hex-keyed webgl1/webgl2 profile 原样透传给 worker，
        // worker IIFE 内部重建 spoofMap + 替换 prototype.getParameter。
        webgl1Profile: config.webglProfile?.webgl1 ?? null,
        webgl2Profile: config.webglProfile?.webgl2 ?? null,
        // Phase 2.6: OffscreenCanvas spoof params（main scope §5 canvas 镜像）。
        // worker 内 fingerprinter 可用 OffscreenCanvasRenderingContext2D 跑 canvas
        // fingerprinting 完全绕开 main scope HTMLCanvasElement spoof。这里把
        // canvas noise seed/strength 透传，worker IIFE 复刻 isProbeCanvas /
        // isAllZero / perturbImageData 三件套 + hook getImageData / convertToBlob。
        canvasNoiseSeed: config.canvasNoiseSeed,
        canvasNoiseStrength: config.canvasNoiseStrength,
        // Phase 4.2: AudioBuffer spoof params（main scope §6 audio 镜像）。
        // worker 内 OfflineAudioContext + AudioBuffer.getChannelData 是经典
        // audio fingerprint 路径（CreepJS / fp.com），main scope hook 无法跨
        // realm。透传 seed + amplitude 到 worker IIFE 复刻 per-channel noise。
        audioNoiseSeed: config.audioNoiseSeed,
        audioNoiseAmplitude: config.audioNoiseAmplitude,
        uaCh: {
          brands: config.uaCh.brands.map((b) => ({ brand: b.brand, version: b.version })),
          fullVersionList: config.uaCh.fullVersionList.map((b) => ({
            brand: b.brand,
            version: b.version,
          })),
          mobile: config.uaCh.mobile,
          platform: config.uaCh.platform,
          platformVersion: config.uaCh.platformVersion,
          architecture: config.uaCh.architecture,
          bitness: config.uaCh.bitness,
          wow64: config.uaCh.wow64,
          model: config.uaCh.model,
        },
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
        '["maxTouchPoints",P.maxTouchPoints],' +
        // Phase 2.6.1（Phase 2.5 bench finding）：worker scope `navigator.webdriver`
        // 必须强制 false。chromium 启 `--enable-automation` flag 时 worker realm 也
        // 继承 webdriver=true，main scope spoof 仅在 main 生效。incolumitas modified
        // fp-collect 通过 worker realm 取 navigator.webdriver 检测我们 → 命中 bot
        // 信号 (`Fp-collect (Modified by Me).webDriver = true`)。把 webdriver 加进
        // defs，与 main scope §2 (defineProtoGetter `webdriver`, false) 对称。
        '["webdriver",false]' +
        '];' +
        'defs.forEach(function(pair){var k=pair[0],v=pair[1];' +
        'try{Object.defineProperty(navigator,k,{get:function(){return v;},configurable:true});}catch(e){}' +
        '});' +
        // navigator.userAgentData (UA-CH) 完整覆盖。
        // 在 worker realm 里 navigator.userAgentData 默认含 "HeadlessChrome" brand，
        // 必须在 brands / mobile / platform getter + getHighEntropyValues + toJSON
        // 全部点上替换值，否则 CreepJS 在 worker section 立刻看出端倪。
        'try{var uad=navigator.userAgentData;if(uad){' +
        'var U=P.uaCh;' +
        'var dup=function(arr){return arr.map(function(b){return{brand:b.brand,version:b.version};});};' +
        // NavigatorUAData 实例 own 改不动 —— 只能动 prototype（同 main scope）。
        'var proto=Object.getPrototypeOf(uad);' +
        'if(proto){' +
        'try{Object.defineProperty(proto,"brands",{get:function(){return dup(U.brands);},configurable:true});}catch(e){}' +
        'try{Object.defineProperty(proto,"mobile",{get:function(){return U.mobile;},configurable:true});}catch(e){}' +
        'try{Object.defineProperty(proto,"platform",{get:function(){return U.platform;},configurable:true});}catch(e){}' +
        'var ghev=function(hints){' +
        'var out={brands:dup(U.brands),mobile:U.mobile,platform:U.platform};' +
        'var hh=Array.isArray(hints)?hints:[];' +
        'for(var i=0;i<hh.length;i++){var h=hh[i];' +
        'if(h==="architecture")out.architecture=U.architecture;' +
        'else if(h==="bitness")out.bitness=U.bitness;' +
        'else if(h==="model")out.model=U.model;' +
        'else if(h==="platformVersion")out.platformVersion=U.platformVersion;' +
        'else if(h==="wow64")out.wow64=U.wow64;' +
        'else if(h==="fullVersionList")out.fullVersionList=dup(U.fullVersionList);' +
        'else if(h==="formFactors")out.formFactors=["Desktop"];' +
        '}' +
        'return Promise.resolve(out);};' +
        'try{Object.defineProperty(proto,"getHighEntropyValues",{value:ghev,configurable:true,writable:true});}catch(e){}' +
        'try{Object.defineProperty(proto,"toJSON",{value:function(){return{brands:dup(U.brands),mobile:U.mobile,platform:U.platform};},configurable:true,writable:true});}catch(e){}' +
        '}' +
        '}}catch(e){}' +
        '}' +
        // ── Phase 2.6: WebGL 49-param 完整镜像（main scope §4 对称） ──
        //
        // 复刻 main scope buildSpoofMap + makeGetParameterProxy 逻辑。
        // INT32_PNAMES / FLOAT32_PNAMES / STRING_PNAMES 三个 set 必须与
        // main scope (runner.ts:685-701) 保持同步 —— 若 main 增删 pname，
        // 这里也要同步更新（无 import 共享，纯字符串复刻）。
        'try{' +
        'var I32S={};I32S[0x0d3a]=1;' + // MAX_VIEWPORT_DIMS
        'var F32S={};F32S[0x846e]=1;F32S[0x846d]=1;' + // ALIASED_LINE_WIDTH_RANGE, ALIASED_POINT_SIZE_RANGE
        'var STRS={};STRS[0x1f00]=1;STRS[0x1f01]=1;STRS[0x1f02]=1;STRS[0x8b8c]=1;' + // VENDOR/RENDERER/VERSION/SHADING_LANGUAGE_VERSION
        'function _buildSpoofMap(obj){var m=new Map();if(!obj)return m;' +
        'var keys=Object.keys(obj);for(var i=0;i<keys.length;i++){' +
        'var k=keys[i];var pname=parseInt(k,16);var val=obj[k];' +
        'if(Array.isArray(val)){' +
        'if(I32S[pname])m.set(pname,new Int32Array(val));' +
        'else if(F32S[pname])m.set(pname,new Float32Array(val));' +
        'else m.set(pname,new Int32Array(val));' +
        '}else if(typeof val==="number"||typeof val==="string"){m.set(pname,val);}' +
        '}return m;}' +
        'var _gl1Map=_buildSpoofMap(P.webgl1Profile);' +
        'var _gl2Merged=new Map();' +
        '_gl1Map.forEach(function(v,k){_gl2Merged.set(k,v);});' +
        'var _gl2Map=_buildSpoofMap(P.webgl2Profile);' +
        '_gl2Map.forEach(function(v,k){_gl2Merged.set(k,v);});' +
        'function _cloneSpoofVal(v){' +
        'if(typeof v==="number"||typeof v==="string")return v;' +
        'if(v instanceof Int32Array)return new Int32Array(v);' +
        'return new Float32Array(v);' +
        '}' +
        'function _makeGP(orig,spoofMap){' +
        'return function getParameter(pname){' +
        'if(pname===0x9245)return P.webglVendor;' +
        'if(pname===0x9246)return P.webglRenderer;' +
        'var v=spoofMap.get(pname);' +
        'if(v!==undefined)return _cloneSpoofVal(v);' +
        'return orig.call(this,pname);' +
        '};' +
        '}' +
        'try{if(typeof WebGLRenderingContext!=="undefined"){' +
        'var _origGP1=WebGLRenderingContext.prototype.getParameter;' +
        'WebGLRenderingContext.prototype.getParameter=_makeGP(_origGP1,_gl1Map);' +
        '}}catch(e){}' +
        'try{if(typeof WebGL2RenderingContext!=="undefined"){' +
        'var _d2=Object.getOwnPropertyDescriptor(WebGL2RenderingContext.prototype,"getParameter");' +
        'if(_d2&&typeof _d2.value==="function"){' +
        'WebGL2RenderingContext.prototype.getParameter=_makeGP(_d2.value,_gl2Merged);' +
        '}}}catch(e){}' +
        '}catch(e){}' +
        // ── Phase 2.6: OffscreenCanvas 镜像（main scope §5 canvas spoof 对称） ──
        //
        // Worker 内 fingerprinter 可用 new OffscreenCanvas(w,h).getContext("2d")
        // 跑 canvas 探测，完全绕开 main scope HTMLCanvasElement spoof。
        // 双 guard 同 main scope：isProbeCanvas (≤16x16) + isAllZero (cleared region)。
        // 不 hook convertToBlob —— OffscreenCanvas 用 getImageData 已可被指纹化，
        // 而 convertToBlob 是 async 调用，正确包装它需要复刻 main scope toDataURL
        // 的 read-perturb-writeback 流程；optimization 留 v0.3。
        'try{' +
        'if(typeof OffscreenCanvasRenderingContext2D!=="undefined"&&P.canvasNoiseStrength>0){' +
        'function _mkPrng(seed){' +
        'var a=seed>>>0;' +
        'return function(){' +
        'a=(a+0x6d2b79f5)>>>0;var t=a;' +
        't=Math.imul(t^(t>>>15),t|1);' +
        't^=t+Math.imul(t^(t>>>7),t|61);' +
        'return((t^(t>>>14))>>>0)/4294967296;' +
        '};}' +
        'function _isProbeOC(c){return c&&c.width<=16&&c.height<=16;}' +
        'function _isAllZeroOC(d){for(var i=0;i<d.length;i++){if(d[i]!==0)return false;}return true;}' +
        'function _perturbOC(imageData){' +
        'if(_isAllZeroOC(imageData.data))return imageData;' +
        'var prng=_mkPrng(P.canvasNoiseSeed);' +
        'var data=imageData.data;var s=P.canvasNoiseStrength;' +
        'for(var i=0;i<data.length;i+=4){' +
        'var delta=Math.floor((prng()-0.5)*2*s);' +
        'if(delta!==0){' +
        'data[i]=Math.max(0,Math.min(255,(data[i]||0)+delta));' +
        'data[i+1]=Math.max(0,Math.min(255,(data[i+1]||0)+delta));' +
        'data[i+2]=Math.max(0,Math.min(255,(data[i+2]||0)+delta));' +
        '}}return imageData;}' +
        'var _origGID=OffscreenCanvasRenderingContext2D.prototype.getImageData;' +
        'OffscreenCanvasRenderingContext2D.prototype.getImageData=function(x,y,w,h,settings){' +
        'var imageData=_origGID.call(this,x,y,w,h,settings);' +
        'if(this.canvas&&_isProbeOC(this.canvas))return imageData;' +
        'return _perturbOC(imageData);' +
        '};' +
        '}}catch(e){}' +
        // ── Phase 4.2: AudioBuffer 镜像（main scope §6 audio spoof 对称） ──
        //
        // Worker scope 内可用 audio API：OfflineAudioContext + AudioBuffer
        // （AudioContext/AnalyserNode 不暴露给 dedicated worker —— 它们绑扬声器）。
        // CreepJS / fp.com 的经典 audio fingerprint 走 OfflineAudioContext +
        // DynamicsCompressor + AudioBuffer.getChannelData 路径，**完全可在
        // worker realm 内执行绕开 main scope hook**。这里复刻 main scope §6
        // 的 per-channel seed XOR noise，让跨 scope fingerprint 一致地 unique。
        //
        // 单点 hook：AudioBuffer.prototype.getChannelData。覆盖 startRendering /
        // createBuffer / decodeAudioData 所有产出 AudioBuffer 的来源。
        // 量级 audioNoiseAmplitude（默认 1e-7）远小于 16-bit PCM ULP，听感无差异，
        // 但 5000-sample sum 在 toString() 4-6 位小数即可改变 hashMini 输出。
        'try{if(typeof AudioBuffer!=="undefined"){' +
        'function _mkAudioPrng(seed){' +
        'var a=seed>>>0;' +
        'return function(){' +
        'a=(a+0x6d2b79f5)>>>0;var t=a;' +
        't=Math.imul(t^(t>>>15),t|1);' +
        't^=t+Math.imul(t^(t>>>7),t|61);' +
        'return((t^(t>>>14))>>>0)/4294967296;' +
        '};' +
        '}' +
        'var _audioAmp=P.audioNoiseAmplitude;' +
        'var _audioSeed=P.audioNoiseSeed>>>0;' +
        // Phase 5.2b mirror：silent samples 保留 exact 0，避免 CreepJS unique:5000 bold-fail。
        // PRNG 仍每样本 advance 一次保 deterministic，noise 条件 add。
        // Phase 5.4c mirror：抽出 _applyAudioNoise 共享给 getChannelData /
        // copyFromChannel / copyToChannel，三条 access path 噪声序列一致 → 修
        // CreepJS 'getChannelData and copyFromChannel samples mismatch' yellow lies。
        'function _applyAudioNoise(arr,ch){' +
        'var prng=_mkAudioPrng((_audioSeed^(ch|0))>>>0);' +
        'for(var i=0;i<arr.length;i++){var s=arr[i]||0;var n=(prng()-0.5)*_audioAmp;if(s!==0)arr[i]=s+n;}' +
        '}' +
        'var _origGCD=AudioBuffer.prototype.getChannelData;' +
        'AudioBuffer.prototype.getChannelData=function(channel){' +
        'var buf=_origGCD.call(this,channel);' +
        '_applyAudioNoise(buf,channel);' +
        'return buf;' +
        '};' +
        // Phase 5.4c worker mirror：copyFromChannel hook —— 让 CreepJS 跨 access
        // path cross-check 一致（同 PRNG seed^channel + skip-zero 规则）。
        'if(typeof AudioBuffer.prototype.copyFromChannel==="function"){' +
        'var _origCopyFrom=AudioBuffer.prototype.copyFromChannel;' +
        'AudioBuffer.prototype.copyFromChannel=function(destination,channelNumber,bufferOffset){' +
        '_origCopyFrom.call(this,destination,channelNumber,bufferOffset);' +
        '_applyAudioNoise(destination,channelNumber);' +
        '};' +
        '}' +
        // Phase 5.4c worker mirror：copyToChannel hook —— 反向，先 noise source 再写入。
        'if(typeof AudioBuffer.prototype.copyToChannel==="function"){' +
        'var _origCopyTo=AudioBuffer.prototype.copyToChannel;' +
        'AudioBuffer.prototype.copyToChannel=function(source,channelNumber,bufferOffset){' +
        '_applyAudioNoise(source,channelNumber);' +
        'return _origCopyTo.call(this,source,channelNumber,bufferOffset);' +
        '};' +
        '}' +
        '}}catch(e){}' +
        // ── CDP detection hardening (mirror of main scope §12) ──
        // dbi-bot `isAutomatedWithCDPInWebWorker` 会在 worker 内复刻同一探测：
        //   var e=new Error();Object.defineProperty(e,"stack",{get:...});console.log(e);
        // 把 Object.defineProperty / Reflect.defineProperty / Object.defineProperties
        // 三条路径都拦截：当目标是 Error 实例且要在 stack 上装 accessor 时静默吞掉。
        'try{' +
        'var _isErrInst=function(o){if(o==null||typeof o!=="object")return false;try{return o instanceof Error;}catch(e){return false;}};' +
        'var _hasAcc=function(d){return d!=null&&typeof d==="object"&&(typeof d.get==="function"||typeof d.set==="function");};' +
        'var _origDP=Object.defineProperty;' +
        'Object.defineProperty=function(obj,prop,desc){' +
        'if(prop==="stack"&&_isErrInst(obj)&&_hasAcc(desc))return obj;' +
        'return _origDP.call(Object,obj,prop,desc);' +
        '};' +
        'var _origRDP=Reflect.defineProperty;' +
        'Reflect.defineProperty=function(obj,prop,desc){' +
        'if(prop==="stack"&&_isErrInst(obj)&&_hasAcc(desc))return true;' +
        'return _origRDP.call(Reflect,obj,prop,desc);' +
        '};' +
        'var _origDPs=Object.defineProperties;' +
        'Object.defineProperties=function(obj,descs){' +
        'if(_isErrInst(obj)&&descs!=null&&typeof descs==="object"){' +
        'var f={};' +
        'var ks=Object.keys(descs);' +
        'for(var i=0;i<ks.length;i++){var k=ks[i];var d=descs[k];' +
        'if(k==="stack"&&_hasAcc(d))continue;' +
        'if(d!==undefined)f[k]=d;' +
        '}' +
        'return _origDPs.call(Object,obj,f);' +
        '}' +
        'return _origDPs.call(Object,obj,descs);' +
        '};' +
        '}catch(e){}' +
        // ── Error.stack frame poisoning hardening (mirror of main scope §13) ──
        // Phase 3.1 worker scope 关键：worker 用 URL.createObjectURL(new Blob) 加载，
        // 其 stack 始终含 `blob:null/<uuid>:N:N` URL leak。incolumitas / fp-scanner /
        // modified fp-collect 通过 throw + read err.stack 反查 → 命中 blob: 即 bot。
        // 装 Error.prepareStackTrace V8 hook，filter 后返回 cleaned string。
        'try{' +
        'var _SUSP=["utilityscript","puppeteer","playwright","__playwright__","__pwinitscripts","puppeteerextra","evaluationscript","cdp.","devtools"];' +
        'var _SUSP_PFX=["blob:","data:"];' +
        'var _isSusp=function(cs){try{' +
        'var fn=String(cs.getFunctionName?cs.getFunctionName():"");' +
        'var file=String(cs.getFileName?cs.getFileName():"");' +
        'var c=(fn+" "+file).toLowerCase();' +
        'for(var i=0;i<_SUSP.length;i++){if(c.indexOf(_SUSP[i])>=0)return true;}' +
        'var fl=file.toLowerCase();' +
        'for(var j=0;j<_SUSP_PFX.length;j++){if(fl.indexOf(_SUSP_PFX[j])===0)return true;}' +
        '}catch(e){}' +
        'return false;};' +
        'var _origPrep=Error.prepareStackTrace;' +
        'Error.prepareStackTrace=function(err,ss){' +
        'var f=[];for(var i=0;i<ss.length;i++){if(!_isSusp(ss[i]))f.push(ss[i]);}' +
        'if(typeof _origPrep==="function"){try{return _origPrep.call(Error,err,f);}catch(e){}}' +
        'var head=String(err)||(err&&err.message?err.message:"Error");' +
        'var lines=[];for(var k=0;k<f.length;k++){lines.push("    at "+String(f[k]));}' +
        'return head+(lines.length?"\\n"+lines.join("\\n"):"");' +
        '};' +
        '}catch(e){}' +
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
  // 12. CDP Detection Hardening — JS Layer (Phase 1.6, 2026-05-15)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ⚠️ 重要范围澄清（2026-05-15 实测后写）：
  //   本 JS 层 hook **不能**让 dbi-bot 的 `isAutomatedWithCDP` 翻 false。
  //   dbi-bot 实际使用的是 `Runtime.consoleAPICalled` 事件检测——只要 Playwright /
  //   Puppeteer 调过 `Runtime.enable`（默认每个 frame 都调），任何 console.* 都会
  //   触发 V8 inspector 把消息序列化送给 host，**这一步发生在 V8 内部，JS 拦不住**。
  //   真正的修复需要在 Playwright 源码或 chromium-fork 层面禁掉 `Runtime.enable` 自动调用
  //   （参 rebrowser-patches 的做法）。这条留给 v0.2 / chromium-fork 阶段。
  //
  // 那为什么还保留这段？因为它**并不冗余**：
  //   1. dbi-bot 的[2024 公开文章](https://deviceandbrowserinfo.com/learning_zone/articles/detecting-headless-chrome-puppeteer-2024)
  //      给出了**老式探测**写法：
  //        var e = new Error();
  //        Object.defineProperty(e, 'stack', { get() { detected = true; } });
  //        console.log(e);  // CDP 序列化时调 getter → detected = true
  //      （注：dbi-bot 自己**已经升级**到 Runtime.consoleAPICalled 事件检测，但很多
  //      自部署反爬、教学站、第三方 stealth-test 仍用上述老式探测代码片段。）
  //   2. 把 `Object.defineProperty` 等三条路径上对 Error.stack 装 accessor 的尝试
  //      静默吞掉，**精确**关掉那条路径，零误伤合法库（sentry / pino / mocha / jest
  //      / lodash / react 都读 .stack 但**不会**用 defineProperty + getter 模式
  //      重定义它，这个 pattern 几乎是 CDP 探测专用）。
  //   3. 防御纵深：哪天哪个反爬同时跑两条 probe，至少老的我们能挡住。
  //
  // 修法：拦截 `Object.defineProperty` / `Reflect.defineProperty` /
  // `Object.defineProperties` 三条路径，当调用方试图给 Error 实例的 `stack` 属性
  // 安装 accessor descriptor (getter/setter) 时**静默吞掉**——返回成功值但不实际
  // 安装。后续 console.log 走到 CDP 序列化时读到的还是原始 stack 字符串，
  // detection getter 永不触发。
  //
  // 同样的逻辑镜像到 worker scope。见上方 workerSpoofSrc 内嵌入的对应字符串。
  try {
    function isErrorInstance(obj: unknown): boolean {
      if (obj == null || typeof obj !== 'object') return false;
      try {
        return obj instanceof Error;
      } catch {
        return false;
      }
    }
    function hasAccessor(desc: unknown): desc is PropertyDescriptor {
      if (desc == null || typeof desc !== 'object') return false;
      const d = desc as PropertyDescriptor;
      return typeof d.get === 'function' || typeof d.set === 'function';
    }
    function shouldBlockStackHook(
      obj: unknown,
      prop: PropertyKey,
      desc: unknown,
    ): boolean {
      return prop === 'stack' && isErrorInstance(obj) && hasAccessor(desc);
    }

    const origDefineProperty = Object.defineProperty;
    Object.defineProperty = wrapStealth(origDefineProperty, {
      apply(target, thisArg: unknown, args: unknown[]) {
        if (args.length >= 3) {
          const [obj, prop, desc] = args as [unknown, PropertyKey, unknown];
          if (shouldBlockStackHook(obj, prop, desc)) {
            // 返回原 obj 假装成功（Object.defineProperty 真实返回值就是第一参）。
            return obj as object;
          }
        }
        return Reflect.apply(target, thisArg, args);
      },
    }) as typeof Object.defineProperty;

    const origReflectDefineProperty = Reflect.defineProperty;
    Reflect.defineProperty = wrapStealth(origReflectDefineProperty, {
      apply(target, thisArg: unknown, args: unknown[]) {
        if (args.length >= 3) {
          const [obj, prop, desc] = args as [unknown, PropertyKey, unknown];
          if (shouldBlockStackHook(obj, prop, desc)) {
            // Reflect.defineProperty 真实返回 boolean (success)。
            return true;
          }
        }
        return Reflect.apply(target, thisArg, args);
      },
    }) as typeof Reflect.defineProperty;

    const origDefineProperties = Object.defineProperties;
    Object.defineProperties = wrapStealth(origDefineProperties, {
      apply(target, thisArg: unknown, args: unknown[]) {
        if (args.length >= 2) {
          const [obj, descs] = args as [unknown, unknown];
          if (
            isErrorInstance(obj) &&
            descs != null &&
            typeof descs === 'object'
          ) {
            // 过滤掉 stack 上的 accessor descriptor，其它正常透传。
            const filtered: PropertyDescriptorMap = {};
            const src = descs as Record<string, unknown>;
            for (const k of Object.keys(src)) {
              const d = src[k];
              if (k === 'stack' && hasAccessor(d)) continue;
              if (d !== undefined) filtered[k] = d as PropertyDescriptor;
            }
            return Reflect.apply(target, thisArg, [obj, filtered]) as object;
          }
        }
        return Reflect.apply(target, thisArg, args);
      },
    }) as typeof Object.defineProperties;
  } catch (err) {
    console.debug('[mosaiq] cdp hardening failed', err);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. Error.stack frame poisoning hardening (Phase 3.1, 2026-05-16)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 触发：Phase 2.5 全 12-站 bench (results/2026-05-16T12-43-07-880Z/) +
  // `bench/probe-error-stack.ts` 探测到：
  //   - MAIN scope: stack 含 `at UtilityScript.evaluate (<anonymous>:N:N)` —
  //     Playwright 注入痕迹（即使我们 spoof 完美，Playwright eval 路径本身
  //     就在 stack 里留 "UtilityScript" 字符串）
  //   - WORKER scope: stack 含 `at self.onmessage (blob:null/<uuid>:N:N)` —
  //     §11 worker IIFE 通过 `URL.createObjectURL(new Blob(...))` 加载，
  //     stack 始终带 `blob:` URL leak（这是 v0.2 worker 透明性根本性 leak）
  //
  // 实战指向：incolumitas modified fp-collect（Phase 2.5 raw JSON 抓到
  // `webDriver: true` 同时 `webDriverValue: false`，配合 `errorsGenerated:
  // ["azeaze is not defined", ...]`）→ detector 通过故意 throw
  // ReferenceError 并 inspect err.stack 字符串反查自动化框架 signature。
  // 同时 arh-antoinevastel `WEBDRIVER` Inconsistent 大概率同一根因
  // （fp-scanner 直接用 fp-collect 的 webDriver 字段）。
  //
  // 修法：装 V8 全局 `Error.prepareStackTrace` hook —— 第一次读 err.stack
  // 时 V8 调它，传入 raw error + 结构化 CallSite[] stack frames。我们 filter
  // 掉敏感 frame 后委托给原 hook（若有）或 V8 默认格式，永远不让 PATTERNS
  // 进入用户可见 stack。
  //
  // ⚠️ Anti-detection 副作用：默认 `Error.prepareStackTrace === undefined`，
  // 装上后变 function。detector 可 typeof 检测。缓解：
  //   1. wrapStealth 包装 hook → `Function.prototype.toString` 返回 native 字符串
  //   2. **不**走 `Object.defineProperty` 装 hook（accessor descriptor 极可疑），
  //      直接赋值（与 puppeteer-extra-plugin-stealth / rebrowser-patches 同手法）
  //   3. V8 字段本身的存在不在已知 fp-collect / fp-scanner / CreepJS 检测点列表
  try {
    interface CallSite {
      getFunctionName(): string | null;
      getFileName(): string | null;
      toString(): string;
    }
    const SUSPICIOUS_SUBSTRS = [
      'utilityscript',
      'puppeteer',
      'playwright',
      '__playwright__',
      '__pwinitscripts',
      'puppeteerextra',
      'evaluationscript',
      'cdp.',
      'devtools',
    ];
    const SUSPICIOUS_FILE_PREFIXES = ['blob:', 'data:'];

    function isSuspiciousFrame(cs: CallSite): boolean {
      try {
        const fn = String(cs.getFunctionName() ?? '');
        const file = String(cs.getFileName() ?? '');
        const combined = (fn + ' ' + file).toLowerCase();
        for (const p of SUSPICIOUS_SUBSTRS) {
          if (combined.includes(p)) return true;
        }
        const fileLower = file.toLowerCase();
        for (const p of SUSPICIOUS_FILE_PREFIXES) {
          if (fileLower.startsWith(p)) return true;
        }
      } catch {
        // CallSite getter 抛错 → 保守不当可疑
      }
      return false;
    }

    const ErrorCtor = Error as unknown as {
      prepareStackTrace?: (err: Error, stack: unknown[]) => string;
    };
    const origPrep = ErrorCtor.prepareStackTrace;

    const ourPrep = function prepareStackTrace(
      err: Error,
      structuredStack: unknown[],
    ): string {
      const filtered = (structuredStack as CallSite[]).filter(
        (cs) => !isSuspiciousFrame(cs),
      );
      // 委托给原 hook（如果有），否则走 V8 default 格式
      if (typeof origPrep === 'function') {
        try {
          return origPrep.call(Error, err, filtered);
        } catch {
          // 原 hook 出错降级 default
        }
      }
      const head = String(err) || (err && err.message ? err.message : 'Error');
      const lines = filtered.map((cs) => '    at ' + String(cs));
      return head + (lines.length ? '\n' + lines.join('\n') : '');
    };

    // 不走 wrapStealth(Proxy) —— wrapStealth 默认捕获的 origStr 是
    // `Function.prototype.toString.call(ourPrep)`，会返回我们的 source code
    // （非 native）→ detector 一调 toString 立刻看穿。改为直接手动注册到
    // stealthRegistry：Function.prototype.toString hook 命中时返回 native
    // 风格字符串。同时 V8 不再多一层 Proxy 间接调用，性能 + 行为更稳。
    stealthRegistry.set(ourPrep, 'function prepareStackTrace() { [native code] }');

    try {
      ErrorCtor.prepareStackTrace = ourPrep;
    } catch {
      // 某些 frozen 环境下赋值失败 — 不影响主流程
    }
  } catch (err) {
    console.debug('[mosaiq] error stack hardening failed', err);
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
