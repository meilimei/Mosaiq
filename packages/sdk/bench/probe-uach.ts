/**
 * probe-uach — 验证 navigator.userAgentData 在 main / worker scope 各自显示什么 brand。
 *   pnpm --filter @mosaiq/sdk exec tsx bench/probe-uach.ts
 */
import { rmSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';

import {
  deletePersona,
  getUserDataDir,
  launchPersona,
  personaExists,
  savePersona,
} from '../src/index.js';

async function main() {
  const id = `probe-uach-${Date.now().toString(36)}`;
  if (personaExists(id)) deletePersona(id);
  savePersona(createWin11ChromeUsPersona({ id, displayName: 'uach' }));
  const session = await launchPersona(
    createWin11ChromeUsPersona({ id, displayName: 'uach' }),
    { headless: true },
  );
  try {
    const page = await session.firstPage();
    await page.goto('https://abrahamjuliot.github.io/creepjs/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const result = await page.evaluate(async () => {
      const nav = navigator as Navigator & {
        userAgentData?: {
          brands: { brand: string; version: string }[];
          mobile: boolean;
          platform: string;
          getHighEntropyValues: (h: string[]) => Promise<Record<string, unknown>>;
          toJSON?: () => unknown;
        };
      };
      const main = {
        hasUAD: !!nav.userAgentData,
        brands: nav.userAgentData?.brands?.map((b) => `${b.brand}/${b.version}`) ?? null,
        mobile: nav.userAgentData?.mobile ?? null,
        platform: nav.userAgentData?.platform ?? null,
        highEntropy: nav.userAgentData
          ? await nav.userAgentData
              .getHighEntropyValues([
                'architecture',
                'bitness',
                'fullVersionList',
                'model',
                'platformVersion',
                'wow64',
              ])
              .catch((e) => `error: ${String(e)}`)
          : null,
      };
      // Worker
      const workerBlob = new Blob(
        [
          `
(async () => {
  const nav = navigator;
  const result = {
    brands: nav.userAgentData?.brands?.map(b => b.brand+'/'+b.version) ?? null,
    platform: nav.userAgentData?.platform ?? null,
    highEntropy: nav.userAgentData
      ? await nav.userAgentData.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platformVersion','wow64']).catch(e => 'err:'+String(e))
      : null,
  };
  self.postMessage(result);
})();
`,
        ],
        { type: 'application/javascript' },
      );
      const workerUrl = URL.createObjectURL(workerBlob);
      const worker: unknown = await new Promise((resolve, reject) => {
        const w = new Worker(workerUrl);
        const t = setTimeout(() => reject(new Error('worker timeout')), 4000);
        w.onmessage = (e) => {
          clearTimeout(t);
          w.terminate();
          resolve(e.data);
        };
        w.onerror = (e) => {
          clearTimeout(t);
          w.terminate();
          reject(new Error(String((e as ErrorEvent).message)));
        };
      });
      return { main, worker };
    });
    console.log('=== MAIN scope ===');
    console.log(JSON.stringify(result.main, null, 2));
    console.log('=== WORKER scope ===');
    console.log(JSON.stringify(result.worker, null, 2));
  } finally {
    await session.close();
    deletePersona(id);
    await wait(500);
    try {
      rmSync(getUserDataDir(id), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
