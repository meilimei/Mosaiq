/**
 * diagnose-navigator-lies — 扫 navigator.plugins / mimeTypes / pdfViewerEnabled 的所有可能 leak。
 *
 * 用法：pnpm --filter @mosaiq/sdk exec tsx bench/diagnose-navigator-lies.ts
 *
 * 目标：找 CreepJS Navigator lies (b067dc4a) 的 root cause。Phase 1.8 加 spoof 后
 * navigator scan_Navigator queryLies 返回 [] —— 说明不在标准 toString/proxy detection
 * 范围。所以 lie 必然来自 IDL 行为差异（item/namedItem/iterator/Symbol.toStringTag/
 * Plugin instance 的内部 slot 等）。
 */

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import {
  deletePersona,
  launchPersona,
  personaExists,
  savePersona,
} from '../src/index.js';

const PERSONA_ID = `diag-nav-${Date.now().toString(36)}`;

async function main() {
  const persona = createWin11ChromeUsPersona({ id: PERSONA_ID, displayName: 'NavDiag' });
  await savePersona(persona);

  let session: Awaited<ReturnType<typeof launchPersona>> | undefined;
  try {
    session = await launchPersona(persona, { headless: true });
    const page = await session.firstPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('[mosaiq]')) console.log(`[chromium ${msg.type()}] ${t}`);
    });
    await page.goto('about:blank');
    await page.waitForLoadState('domcontentloaded');

    const probe = await page.evaluate(() => {
      const out: Record<string, unknown> = {};

      // ── 0. Sanity ──
      out.plugins_length = navigator.plugins.length;
      out.plugins_isPluginArray = navigator.plugins instanceof PluginArray;
      out.plugins_constructorName = navigator.plugins.constructor.name;
      out.plugins_proto = Object.getPrototypeOf(navigator.plugins) === PluginArray.prototype;
      out.plugins_toString = String(navigator.plugins);
      out.plugins_symToStringTag = (navigator.plugins as unknown as { [Symbol.toStringTag]?: string })[
        Symbol.toStringTag
      ];

      // ── 1. PluginArray IDL methods ──
      const tryFn = <T>(label: string, fn: () => T) => {
        try {
          const v = fn();
          out[label] = typeof v === 'object' && v !== null
            ? `<${(v as object).constructor?.name ?? typeof v}>`
            : v;
        } catch (e) {
          out[label] = `THROW: ${(e as Error).message}`;
        }
      };
      tryFn('plugins_item_0', () => navigator.plugins.item(0));
      tryFn('plugins_item_99', () => navigator.plugins.item(99));
      tryFn('plugins_namedItem_PDFViewer', () =>
        navigator.plugins.namedItem('PDF Viewer'),
      );
      tryFn('plugins_namedItem_unknown', () => navigator.plugins.namedItem('unknown'));
      tryFn('plugins_refresh', () => navigator.plugins.refresh());

      // ── 2. Iterator support ──
      tryFn('plugins_for_of_count', () => {
        let n = 0;
        for (const _p of navigator.plugins as unknown as Iterable<Plugin>) n++;
        return n;
      });
      tryFn('plugins_spread_count', () => {
        return [...(navigator.plugins as unknown as Iterable<Plugin>)].length;
      });
      tryFn('plugins_array_from_count', () => {
        return Array.from(navigator.plugins as unknown as Iterable<Plugin>).length;
      });

      // ── 3. Plugin instance internals ──
      const p0 = navigator.plugins[0];
      out.p0_isPlugin = p0 instanceof Plugin;
      out.p0_constructorName = p0?.constructor?.name;
      out.p0_proto = Object.getPrototypeOf(p0) === Plugin.prototype;
      out.p0_toString = String(p0);
      out.p0_name = p0?.name;
      out.p0_filename = p0?.filename;
      out.p0_description = p0?.description;
      out.p0_length = p0?.length;
      tryFn('p0_item_0', () => p0?.item?.(0));
      tryFn('p0_namedItem_pdf', () => p0?.namedItem?.('application/pdf'));

      // ── 4. MimeType instance internals ──
      const mt0 = (p0 as unknown as { 0: MimeType })?.[0];
      out.mt0_isMimeType = mt0 instanceof MimeType;
      out.mt0_constructorName = mt0?.constructor?.name;
      out.mt0_type = mt0?.type;
      out.mt0_suffixes = mt0?.suffixes;
      out.mt0_description = mt0?.description;
      out.mt0_enabledPlugin_isPlugin = (mt0?.enabledPlugin as unknown) instanceof Plugin;

      // ── 5. navigator.mimeTypes IDL ──
      out.mimeTypes_length = navigator.mimeTypes.length;
      out.mimeTypes_isMimeTypeArray = navigator.mimeTypes instanceof MimeTypeArray;
      out.mimeTypes_constructorName = navigator.mimeTypes.constructor.name;
      tryFn('mimeTypes_item_0', () => navigator.mimeTypes.item(0));
      tryFn('mimeTypes_namedItem_pdf', () =>
        navigator.mimeTypes.namedItem('application/pdf'),
      );

      // ── 6. pdfViewerEnabled ──
      out.pdfViewerEnabled = navigator.pdfViewerEnabled;
      out.pdfViewerEnabled_typeof = typeof navigator.pdfViewerEnabled;

      // ── 7. Notification.permission ──
      out.notif_permission = Notification.permission;
      out.notif_permission_typeof = typeof Notification.permission;
      const notifDesc = Object.getOwnPropertyDescriptor(Notification, 'permission');
      out.notif_descriptor_hasGet = !!notifDesc?.get;
      out.notif_getter_toString = String(notifDesc?.get);
      out.notif_getter_native =
        notifDesc?.get && String(notifDesc.get).includes('[native code]');

      // ── 8. Descriptor 一致性（CreepJS getPrototypeLies 关键扫描点） ──
      const descs = ['plugins', 'mimeTypes', 'pdfViewerEnabled'].map((k) => {
        const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, k);
        return {
          key: k,
          hasGet: !!desc?.get,
          hasSet: !!desc?.set,
          hasValue: 'value' in (desc ?? {}),
          enumerable: desc?.enumerable,
          configurable: desc?.configurable,
          getterName: desc?.get?.name,
          getterToStringTail: desc?.get
            ? String(desc.get).slice(-50)
            : 'N/A',
          getterIsNative:
            !!desc?.get && String(desc.get).includes('[native code]'),
        };
      });
      out.proto_descriptors = descs;

      // ── 9. own property 是否 leaked ──
      out.own_keys_navigator = Object.getOwnPropertyNames(navigator).filter((k) =>
        ['plugins', 'mimeTypes', 'pdfViewerEnabled'].includes(k),
      );

      // ── 10. CreepJS lies Heuristic：getter.call(otherObj) 的行为 ──
      // 真 native getter 在 cross-realm 调用时抛 TypeError "Illegal invocation"
      const navProto = Navigator.prototype;
      const pluginsGetter = Object.getOwnPropertyDescriptor(navProto, 'plugins')?.get;
      tryFn('plugins_getter_called_on_object', () => {
        if (!pluginsGetter) return 'NO_GETTER';
        return pluginsGetter.call({});
      });
      tryFn('plugins_getter_called_on_navigator', () => {
        if (!pluginsGetter) return 'NO_GETTER';
        const result = pluginsGetter.call(navigator);
        return result instanceof PluginArray ? 'PluginArray' : typeof result;
      });

      // 11. Function.prototype.toString.call(getter)
      out.plugins_getter_toString = String(pluginsGetter);
      out.plugins_getter_name = pluginsGetter?.name;

      return out;
    });

    console.log('[diag] Navigator spoof inspection:');
    console.log(JSON.stringify(probe, null, 2));
  } finally {
    if (session) await session.close();
    if (await personaExists(PERSONA_ID)) {
      try {
        deletePersona(PERSONA_ID);
      } catch (e) {
        console.error('[diag] persona cleanup failed', e);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
