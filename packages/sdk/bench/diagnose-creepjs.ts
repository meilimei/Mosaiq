/**
 * diagnose-creepjs — 在真实 chromium 内复现 CreepJS lies/timezone 检测路径。
 *
 * 用法：
 *   pnpm --filter @mosaiq/sdk exec tsx bench/diagnose-creepjs.ts
 *   $env:HEADED='1'; pnpm --filter @mosaiq/sdk exec tsx bench/diagnose-creepjs.ts
 *
 * 检测分类：
 *   1. Timezone 各 path 一致性（Date.getTimezoneOffset / Intl / Date.toString）
 *   2. Hook 痕迹（toString 含 [native code] 且 name 完整）
 *   3. Descriptor / own property 内省（CreepJS lies/index.ts §getPrototypeLies）
 *   4. Proxy detection 套路（Object.create(new Proxy(fn, {})).toString() 等）
 *
 * 不直接跑 CreepJS bundle — 那需要网络 + 复杂解析。这里只复现关键 detector。
 *
 * 参考：
 *   - $env:TEMP\creep-lies-index.ts:195-260 (lieProps detector)
 *   - $env:TEMP\creep-tz.ts:530-580 (timezone probe + decryptLocation)
 *   - $env:TEMP\creep-intl.ts:130-145 (Intl bold-fail = LowerEntropy.TIME_ZONE)
 */

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import { deletePersona, launchPersona, personaExists, savePersona } from '../src/index.js';

const PERSONA_ID = 'creepjs-diag' as const;
const PERSONA_TIMEZONE = 'America/New_York';

interface CheckResult {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
  severity: 'value' | 'hook'; // value = spoof 值正确性；hook = CreepJS lies 检测
}

async function main() {
  console.log('[diag] starting CreepJS lies/timezone diagnostic\n');

  if (personaExists(PERSONA_ID)) deletePersona(PERSONA_ID);
  const persona = createWin11ChromeUsPersona({
    id: PERSONA_ID,
    displayName: 'CreepJS Diagnostic',
    masterSeed: 'deadbeef',
    timezone: PERSONA_TIMEZONE,
  });
  savePersona(persona);

  console.log(`[diag] persona timezone = "${PERSONA_TIMEZONE}"`);
  // America/New_York EST (Nov-Mar) = UTC-5 = offset +300 / EDT (Mar-Nov) = UTC-4 = offset +240
  // 当前日期 (2026-05) 属于 EDT 期 → 期望 offset = 240

  const headed = process.env.HEADED === '1';
  const session = await launchPersona(persona, { headless: !headed });

  try {
    const page = await session.firstPage();
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[mosaiq]')) console.log(`[chromium console ${msg.type()}] ${text}`);
    });
    await page.goto('about:blank');
    await page.waitForLoadState('domcontentloaded');

    const probe = await page.evaluate(() => {
      const out: Record<string, unknown> = {};

      // ─────────────────────────────────────────────────────────────────
      // 1. Timezone value paths
      // ─────────────────────────────────────────────────────────────────
      try {
        out.intl_timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (e) {
        out.intl_timeZone = `ERROR: ${(e as Error).message}`;
      }

      try {
        out.date_getTimezoneOffset = new Date().getTimezoneOffset();
      } catch (e) {
        out.date_getTimezoneOffset = `ERROR: ${(e as Error).message}`;
      }

      try {
        // CreepJS timezone.ts line ~535: zone = (''+new Date()).replace(/.*\(|\).*/g, '')
        const dateStr = '' + new Date();
        out.date_toString = dateStr;
        const tzNameMatch = dateStr.match(/\(([^)]+)\)/);
        out.date_toString_tzName = tzNameMatch ? tzNameMatch[1] : '(none)';
      } catch (e) {
        out.date_toString = `ERROR: ${(e as Error).message}`;
      }

      try {
        out.date_toTimeString = new Date().toTimeString();
      } catch (e) {
        out.date_toTimeString = `ERROR: ${(e as Error).message}`;
      }

      try {
        out.date_toLocaleString = new Date().toLocaleString();
      } catch (e) {
        out.date_toLocaleString = `ERROR: ${(e as Error).message}`;
      }

      // ─────────────────────────────────────────────────────────────────
      // SpeechSynthesis voices — Intl bold-fail 的真正根因
      // ─────────────────────────────────────────────────────────────────
      // CreepJS speech detector：
      //   if (defaultVoiceLang.split('-')[0] !== Intl.locale.split('-')[0])
      //     LowerEntropy.TIME_ZONE = true  // → Intl bold-fail
      // 注意：voices 异步加载，需要等 voiceschanged
      out.speech_voicesCount = 'PENDING';

      // CreepJS decryptLocation 用的关键：summer offset 在指定 year
      try {
        const year = 1113;
        const summer = +new Date(`7/1/${year}`);
        const summerUTC = +new Date(`${year}-07-01`);
        const sysOffset = (summer - summerUTC) / 60000;
        out.creepjs_sysOffset_1113 = sysOffset; // 这是 CreepJS 拿到的系统 offset

        const intlSummer = +new Date(
          new Intl.DateTimeFormat('en', {
            timeZone: 'America/New_York', // 用 persona timezone
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
          }).format(new Date(`7/1/${year}`)),
        );
        const intlOffset = (intlSummer - summerUTC) / 60000;
        out.creepjs_intlOffset_1113 = intlOffset; // persona 期望 offset

        out.creepjs_offset_mismatch = sysOffset !== intlOffset;
      } catch (e) {
        out.creepjs_sysOffset_1113 = `ERROR: ${(e as Error).message}`;
      }

      // ─────────────────────────────────────────────────────────────────
      // 2. Hook 痕迹（CreepJS lies/index.ts §getPrototypeLies）
      // ─────────────────────────────────────────────────────────────────

      const checkFn = (fn: () => unknown, label: string, expectedName: string) => {
        const r: Record<string, unknown> = {};
        try {
          const target = fn() as unknown as Function;
          r.functionSource = Function.prototype.toString.call(target);
          r.isNativeCode = String(r.functionSource).includes('[native code]');
          r.hasExpectedName = String(r.functionSource).includes(`function ${expectedName}(`);
          r.descriptorKeys = Object.keys(Object.getOwnPropertyDescriptors(target)).sort().join(',');
          r.ownPropertyNames = Object.getOwnPropertyNames(target).sort().join(',');
          r.descriptorKeysOK = r.descriptorKeys === 'length,name';
          r.hasPrototype = 'prototype' in target;
          r.hasOwnArguments = target.hasOwnProperty('arguments');
          r.hasOwnCaller = target.hasOwnProperty('caller');
          r.hasOwnPrototype = target.hasOwnProperty('prototype');
          r.hasOwnToString = target.hasOwnProperty('toString');

          // Proxy detection 套路 #1
          try {
            const _ = Object.create(target).toString();
            r.proxyDetect_objCreateToString = 'NO_ERROR (suspicious)';
          } catch (e) {
            r.proxyDetect_objCreateToString = `THREW ${(e as Error).constructor.name}`;
          }
          // Proxy detection 套路 #2
          try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const _ = Object.create(new Proxy(target, {})).toString();
            r.proxyDetect_objCreateProxyToString = 'NO_ERROR (suspicious)';
          } catch (e) {
            r.proxyDetect_objCreateProxyToString = `THREW ${(e as Error).constructor.name}`;
          }
        } catch (e) {
          r.error = (e as Error).message;
        }
        out[`hook_${label}`] = r;
      };

      checkFn(
        () => Date.prototype.getTimezoneOffset,
        'Date_getTimezoneOffset',
        'getTimezoneOffset',
      );
      checkFn(() => Date.prototype.toString, 'Date_toString', 'toString');
      checkFn(() => Intl.DateTimeFormat, 'Intl_DateTimeFormat', 'DateTimeFormat');
      checkFn(
        () => WebGLRenderingContext.prototype.getParameter,
        'WebGL_getParameter',
        'getParameter',
      );

      // ─────────────────────────────────────────────────────────────────
      // 3. CreepJS queryLies 全套移植 —— 每个 surface 报告具体哪个 detector 触发
      // ─────────────────────────────────────────────────────────────────
      const HAS_REFLECT = 'Reflect' in self;
      const IS_BLINK = true;

      function isTypeError(err: unknown): boolean {
        return (err as { constructor?: { name?: string } })?.constructor?.name === 'TypeError';
      }
      function failsTypeError(
        spawnErr: () => void,
        withStack?: (err: unknown) => boolean,
        final?: () => void,
      ): boolean {
        try {
          spawnErr();
          throw Error();
        } catch (err) {
          if (!isTypeError(err)) return true;
          return withStack ? withStack(err) : false;
        } finally {
          final?.();
        }
      }
      function hasKnownToString(name: string): Record<string, true> {
        return {
          [`function ${name}() { [native code] }`]: true,
          [`function get ${name}() { [native code] }`]: true,
          [`function () { [native code] }`]: true,
        };
      }
      function hasValidStack(err: unknown, reg: RegExp, i: number = 1) {
        const e = err as { stack?: string; message?: string };
        if (i === 0) return reg.test(e.message ?? '');
        return reg.test((e.stack ?? '').split('\n')[i] ?? '');
      }
      const AT_FUNCTION = /at Function\.toString /;
      const AT_OBJECT = /at Object\.toString/;

      function queryLies(apiFunction: Function, lieProps: Record<string, number>, ownerObj?: { name?: string }): string[] {
        if (typeof apiFunction !== 'function') return [];
        const name = (apiFunction.name || '').replace(/get\s/, '');
        const objName = ownerObj?.name;
        const nativeProto = Object.getPrototypeOf(apiFunction);
        const lies: Record<string, boolean> = {
          'failed undefined properties':
            !!ownerObj &&
            /^(screen|navigator)$/i.test(objName ?? '') &&
            !!(
              Object.getOwnPropertyDescriptor(
                (self as unknown as Record<string, object>)[objName!.toLowerCase()],
                name,
              ) ||
              (HAS_REFLECT &&
                Reflect.getOwnPropertyDescriptor(
                  (self as unknown as Record<string, object>)[objName!.toLowerCase()],
                  name,
                ))
            ),
          'failed toString':
            !hasKnownToString(name)[Function.prototype.toString.call(apiFunction)] ||
            !hasKnownToString('toString')[Function.prototype.toString.call(apiFunction.toString)],
          'failed "prototype" in function': 'prototype' in apiFunction,
          'failed descriptor': !!(
            Object.getOwnPropertyDescriptor(apiFunction, 'arguments') ||
            Reflect.getOwnPropertyDescriptor(apiFunction, 'arguments') ||
            Object.getOwnPropertyDescriptor(apiFunction, 'caller') ||
            Reflect.getOwnPropertyDescriptor(apiFunction, 'caller') ||
            Object.getOwnPropertyDescriptor(apiFunction, 'prototype') ||
            Reflect.getOwnPropertyDescriptor(apiFunction, 'prototype') ||
            Object.getOwnPropertyDescriptor(apiFunction, 'toString') ||
            Reflect.getOwnPropertyDescriptor(apiFunction, 'toString')
          ),
          'failed own property': !!(
            apiFunction.hasOwnProperty('arguments') ||
            apiFunction.hasOwnProperty('caller') ||
            apiFunction.hasOwnProperty('prototype') ||
            apiFunction.hasOwnProperty('toString')
          ),
          'failed descriptor keys':
            Object.keys(Object.getOwnPropertyDescriptors(apiFunction)).sort().toString() !==
            'length,name',
          'failed own property names':
            Object.getOwnPropertyNames(apiFunction).sort().toString() !== 'length,name',
          'failed own keys names':
            HAS_REFLECT && Reflect.ownKeys(apiFunction).sort().toString() !== 'length,name',
          'failed object toString error':
            failsTypeError(
              () => Object.create(apiFunction).toString(),
              (err) => IS_BLINK && !hasValidStack(err, AT_FUNCTION),
            ) ||
            failsTypeError(
              () => Object.create(new Proxy(apiFunction, {})).toString(),
              (err) => IS_BLINK && !hasValidStack(err, AT_OBJECT),
            ),
          'failed at too much recursion error': failsTypeError(() => {
            Object.setPrototypeOf(apiFunction, Object.create(apiFunction)).toString();
          }, undefined, () => Object.setPrototypeOf(apiFunction, nativeProto)),
        };
        // detectProxies 升级位
        const detectProxies =
          name === 'toString' ||
          !!lieProps['Function.toString'] ||
          !!lieProps['Permissions.query'];
        if (detectProxies) {
          // 这里我们只关心**额外触发**的检测，跳过 instanceof / define properties 等噪声
          (lies as Record<string, boolean>)['__proxyDetectionEscalated__'] = true;
        }
        return Object.keys(lies).filter((k) => !!lies[k] && !k.startsWith('__'));
      }

      function scanProto(
        protoFn: () => Function | object,
        targets: string[] | null,
        ownerObj?: { name?: string },
      ): Array<{ prop: string; lies: string[] }> {
        const results: Array<{ prop: string; lies: string[] }> = [];
        let proto: object;
        try {
          const obj = protoFn() as Function | { prototype?: object };
          proto = (obj as { prototype?: object }).prototype ?? (obj as object);
        } catch {
          return results;
        }
        const props = Array.from(
          new Set([...Object.getOwnPropertyNames(proto), ...Object.keys(proto)]),
        );
        const lieProps: Record<string, number> = {};
        for (const name of props) {
          if (name === 'constructor') continue;
          if (targets && !targets.includes(name)) continue;
          try {
            const protoCast = proto as Record<string, unknown>;
            try {
              const fn = protoCast[name];
              if (typeof fn === 'function') {
                const lies = queryLies(fn, lieProps, ownerObj);
                if (lies.length > 0) {
                  results.push({ prop: name, lies });
                  lieProps[`${(ownerObj as { name?: string })?.name ?? '?'}.${name}`] = lies.length;
                }
                continue;
              }
              if (
                name !== 'name' &&
                name !== 'length' &&
                name[0] !== name[0].toUpperCase()
              ) {
                const lies = ['failed descriptor.value undefined'];
                results.push({ prop: name, lies });
                lieProps[`${(ownerObj as { name?: string })?.name ?? '?'}.${name}`] = lies.length;
              }
              continue;
            } catch {
              // CreepJS fallback path: prototype getter access often throws Illegal invocation.
            }
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (desc?.get) {
              const lies = queryLies(desc.get, lieProps, ownerObj);
              if (lies.length > 0) {
                results.push({ prop: name, lies });
                lieProps[`${(ownerObj as { name?: string })?.name ?? '?'}.${name}`] = lies.length;
              }
            }
          } catch (e) {
            results.push({ prop: name, lies: [`exec error: ${(e as Error).message}`] });
          }
        }
        return results;
      }

      out.scan_Navigator = scanProto(
        () => (self as unknown as { Navigator: typeof Navigator }).Navigator,
        [
          'appCodeName', 'appName', 'appVersion', 'connection', 'deviceMemory',
          'getBattery', 'getGamepads', 'hardwareConcurrency', 'language', 'languages',
          'maxTouchPoints', 'mimeTypes', 'platform', 'plugins', 'product', 'productSub',
          'sendBeacon', 'serviceWorker', 'storage', 'userAgent', 'vendor', 'vendorSub',
          'webdriver', 'gpu',
        ],
        { name: 'Navigator' },
      );
      out.scan_Screen = scanProto(
        () => (self as unknown as { Screen: typeof Screen }).Screen,
        null,
        { name: 'Screen' },
      );
      out.scan_DOMRect = scanProto(
        () => (self as unknown as { DOMRect: typeof DOMRect }).DOMRect,
        null,
        { name: 'DOMRect' },
      );
      out.scan_WebGL = scanProto(
        () => (self as unknown as { WebGLRenderingContext: typeof WebGLRenderingContext })
          .WebGLRenderingContext,
        ['bufferData', 'getParameter', 'readPixels'],
        { name: 'WebGLRenderingContext' },
      );
      out.scan_Permissions = scanProto(
        () => (self as unknown as { Permissions: typeof Permissions }).Permissions,
        ['query'],
        { name: 'Permissions' },
      );
      out.scan_Intl_DTF = scanProto(
        () => Intl.DateTimeFormat,
        ['format', 'formatRange', 'formatToParts', 'resolvedOptions'],
        { name: 'DateTimeFormat' },
      );
      out.scan_Date = scanProto(
        () => Date,
        ['getTimezoneOffset', 'toString', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
         'toTimeString', 'toDateString'],
        { name: 'Date' },
      );

      // ─────────────────────────────────────────────────────────────────
      // 4. Stack 取证 —— 捕获 failed object toString error 的实际 stack frame
      // ─────────────────────────────────────────────────────────────────
      const stackCapture: Record<string, { name: string; message: string; stackLines: string[] }> = {};
      const captureStack = (label: string, fn: () => void) => {
        try {
          fn();
          stackCapture[label] = { name: 'NO_THROW', message: '', stackLines: [] };
        } catch (err) {
          const e = err as Error;
          stackCapture[label] = {
            name: e.constructor.name,
            message: e.message,
            stackLines: (e.stack ?? '').split('\n').slice(0, 6),
          };
        }
      };
      captureStack('Date_getTimezoneOffset.objCreate.toString', () =>
        Object.create(Date.prototype.getTimezoneOffset).toString(),
      );
      captureStack('Date_getTimezoneOffset.proxyObjCreate.toString', () =>
        Object.create(new Proxy(Date.prototype.getTimezoneOffset, {})).toString(),
      );
      captureStack('Date_getTimezoneOffset.tooMuchRecursion', () => {
        const fn = Date.prototype.getTimezoneOffset;
        Object.setPrototypeOf(fn, Object.create(fn)).toString();
      });
      out.stackCapture = stackCapture;

      return out;
    });

    // 异步等 SpeechSynthesis voices 加载（最多 2 秒）
    const speechProbe = await page.evaluate(async () => {
      const sync = window.speechSynthesis;
      if (!sync) return { error: 'no speechSynthesis' };
      let voices = sync.getVoices();
      if (voices.length === 0) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => resolve(), 2000);
          sync.addEventListener(
            'voiceschanged',
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
        voices = sync.getVoices();
      }
      const defaultLocal = voices.find((v) => v.default && v.localService);
      const localeLang = Intl.DateTimeFormat().resolvedOptions().locale;
      const defaultLang = defaultLocal?.lang ?? '';
      return {
        voicesCount: voices.length,
        defaultVoiceName: defaultLocal?.name ?? '(none)',
        defaultVoiceLang: defaultLang,
        allLangs: [...new Set(voices.map((v) => v.lang))].sort().join(','),
        intlLocale: localeLang,
        // 完全复现 CreepJS 的条件
        triggersLowerEntropyTimeZone:
          !!defaultLang &&
          defaultLang.split('-')[0] !== localeLang.split('-')[0],
      };
    });
    Object.assign(probe, speechProbe);

    console.log('[diag] probe result:');
    console.log(JSON.stringify(probe, null, 2));

    // 期望 offset：America/New_York EDT = +240（2026-05 是 EDT）
    // 但 CreepJS 用 year=1113，那时没有 DST 概念 → 用标准 EST = +300
    // 严格说要看 V8 怎么算 1113 这个远古年份。先用动态计算的 intlOffset 当 baseline
    const expectedIntlOffset = probe.creepjs_intlOffset_1113;

    const checks: CheckResult[] = [
      // ── Spoof 值正确性 ──
      {
        name: '[value] Intl.DateTimeFormat().resolvedOptions().timeZone',
        expected: PERSONA_TIMEZONE,
        actual: String(probe.intl_timeZone ?? 'N/A'),
        pass: probe.intl_timeZone === PERSONA_TIMEZONE,
        severity: 'value',
      },
      {
        name: '[value] Date.toString() 含 persona timezone 缩写（不含系统真实时区）',
        expected: '含 "EDT" / "EST" / "Eastern" 或 "New York" 之一',
        actual: String(probe.date_toString_tzName ?? 'N/A'),
        pass: /eastern|new york|EDT|EST/i.test(String(probe.date_toString_tzName ?? '')),
        severity: 'value',
      },
      {
        name: '[value] CreepJS system offset 与 Intl offset 一致（消 Intl bold-fail 关键）',
        expected: `system offset === ${expectedIntlOffset}`,
        actual: `sys=${probe.creepjs_sysOffset_1113}, intl=${expectedIntlOffset}, mismatch=${probe.creepjs_offset_mismatch}`,
        pass: probe.creepjs_offset_mismatch === false,
        severity: 'value',
      },

      // ── Hook 痕迹（CreepJS lies detector） ──
      {
        name: '[hook] Date.prototype.getTimezoneOffset.toString() 含 [native code]',
        expected: 'true',
        actual: String((probe.hook_Date_getTimezoneOffset as any)?.isNativeCode ?? 'N/A'),
        pass: (probe.hook_Date_getTimezoneOffset as any)?.isNativeCode === true,
        severity: 'hook',
      },
      {
        name: '[hook] Date.getTimezoneOffset.toString() 含正确 name',
        expected: 'function getTimezoneOffset(',
        actual: String((probe.hook_Date_getTimezoneOffset as any)?.functionSource ?? 'N/A'),
        pass: (probe.hook_Date_getTimezoneOffset as any)?.hasExpectedName === true,
        severity: 'hook',
      },
      {
        name: '[hook] Date.getTimezoneOffset descriptorKeys === "length,name"',
        expected: 'length,name',
        actual: String((probe.hook_Date_getTimezoneOffset as any)?.descriptorKeys ?? 'N/A'),
        pass: (probe.hook_Date_getTimezoneOffset as any)?.descriptorKeysOK === true,
        severity: 'hook',
      },
      {
        name: '[hook] Date.getTimezoneOffset 不能有 "prototype" 属性',
        expected: 'false',
        actual: String((probe.hook_Date_getTimezoneOffset as any)?.hasPrototype ?? 'N/A'),
        pass: (probe.hook_Date_getTimezoneOffset as any)?.hasPrototype === false,
        severity: 'hook',
      },

      // ── WebGL getParameter Proxy 留下的痕迹（已知 lies 源） ──
      {
        name: '[hook] WebGL getParameter.toString() 含正确 name "getParameter"',
        expected: 'function getParameter(',
        actual: String((probe.hook_WebGL_getParameter as any)?.functionSource ?? 'N/A'),
        pass: (probe.hook_WebGL_getParameter as any)?.hasExpectedName === true,
        severity: 'hook',
      },
      {
        name: '[hook] Intl.DateTimeFormat.toString() 含正确 name "DateTimeFormat"',
        expected: 'function DateTimeFormat(',
        actual: String((probe.hook_Intl_DateTimeFormat as any)?.functionSource ?? 'N/A'),
        pass: (probe.hook_Intl_DateTimeFormat as any)?.hasExpectedName === true,
        severity: 'hook',
      },
    ];

    console.log('\n[diag] check results:');
    console.log('─'.repeat(100));
    let pass = 0;
    let fail = 0;
    let valueFail = 0;
    let hookFail = 0;
    for (const c of checks) {
      const icon = c.pass ? '✅' : '❌';
      console.log(`${icon} ${c.name}`);
      if (!c.pass) {
        console.log(`   expected: ${c.expected}`);
        console.log(`   actual:   ${c.actual.slice(0, 150)}`);
      }
      if (c.pass) pass++;
      else {
        fail++;
        if (c.severity === 'value') valueFail++;
        else hookFail++;
      }
    }
    console.log('─'.repeat(100));
    console.log(`[diag] summary: ${pass}/${checks.length} pass, ${fail} fail`);
    console.log(`         value fails (实际 spoof 漏): ${valueFail}`);
    console.log(`         hook fails (CreepJS lies trigger): ${hookFail}`);

    // CreepJS queryLies 移植扫描结果
    console.log('\n[diag] CreepJS queryLies port — per-surface lies detail:');
    console.log('─'.repeat(100));
    const scans: Array<[string, unknown]> = [
      ['Navigator', probe.scan_Navigator],
      ['Screen', probe.scan_Screen],
      ['DOMRect', probe.scan_DOMRect],
      ['WebGLRenderingContext', probe.scan_WebGL],
      ['Permissions', probe.scan_Permissions],
      ['Intl.DateTimeFormat', probe.scan_Intl_DTF],
      ['Date', probe.scan_Date],
    ];
    let totalSurfaceLies = 0;
    for (const [surface, scan] of scans) {
      const list = (scan as Array<{ prop: string; lies: string[] }>) ?? [];
      if (list.length === 0) {
        console.log(`✅ ${surface}: clean`);
        continue;
      }
      console.log(`❌ ${surface}: ${list.length} prop(s) with lies`);
      for (const item of list) {
        console.log(`     • ${item.prop}: [${item.lies.join(', ')}]`);
        totalSurfaceLies++;
      }
    }
    console.log('─'.repeat(100));
    console.log(`[diag] total props with lies across surfaces: ${totalSurfaceLies}`);
  } finally {
    await session.close();
    deletePersona(PERSONA_ID);
  }
}

main().catch((err) => {
  console.error('[diag] fatal:', err);
  process.exit(1);
});
