/**
 * probe-worker-scope — 在我们 spoof 后的 chromium 里启动一个 DedicatedWorker，
 *   读 navigator.* 与 main scope 比对，验证 §11 worker scope spoof 是否生效。
 *
 *   pnpm --filter @mosaiq/sdk exec tsx bench/probe-worker-scope.ts
 *
 * 期望：worker.userAgent === main.userAgent，hardwareConcurrency / deviceMemory
 *      / language / languages / platform 一致。
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
  const id = `probe-worker-scope-${Date.now().toString(36)}`;
  if (personaExists(id)) deletePersona(id);
  savePersona(createWin11ChromeUsPersona({ id, displayName: 'worker-scope' }));
  const session = await launchPersona(
    createWin11ChromeUsPersona({ id, displayName: 'worker-scope' }),
    { headless: true },
  );
  try {
    const page = await session.firstPage();
    await page.goto('about:blank');

    const result = await page.evaluate(() => {
      // Build a tiny worker source that posts back its navigator.* fields.
      const workerSrc = `
        self.onmessage = function () {
          var nav = self.navigator || {};
          self.postMessage({
            userAgent: nav.userAgent,
            appVersion: nav.appVersion,
            platform: nav.platform,
            vendor: nav.vendor,
            language: nav.language,
            languages: nav.languages ? Array.from(nav.languages) : null,
            hardwareConcurrency: nav.hardwareConcurrency,
            deviceMemory: nav.deviceMemory,
            maxTouchPoints: nav.maxTouchPoints,
          });
        };
      `;
      const blobUrl = URL.createObjectURL(
        new Blob([workerSrc], { type: 'application/javascript' }),
      );

      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const worker = new Worker(blobUrl);
        const t = setTimeout(() => {
          worker.terminate();
          reject(new Error('worker timeout'));
        }, 5000);
        worker.onmessage = (ev) => {
          clearTimeout(t);
          worker.terminate();
          resolve({
            main: {
              userAgent: navigator.userAgent,
              appVersion: navigator.appVersion,
              platform: navigator.platform,
              vendor: navigator.vendor,
              language: navigator.language,
              languages: Array.from(navigator.languages),
              hardwareConcurrency: navigator.hardwareConcurrency,
              deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
              maxTouchPoints: navigator.maxTouchPoints,
            },
            worker: ev.data,
          });
        };
        worker.onerror = (ev) => {
          clearTimeout(t);
          worker.terminate();
          reject(new Error('worker error: ' + (ev as ErrorEvent).message));
        };
        worker.postMessage('go');
      });
    });

    const main = result.main as Record<string, unknown>;
    const worker = result.worker as Record<string, unknown>;
    const fields = [
      'userAgent',
      'appVersion',
      'platform',
      'vendor',
      'language',
      'languages',
      'hardwareConcurrency',
      'deviceMemory',
      'maxTouchPoints',
    ];
    let allMatch = true;
    console.log('field'.padEnd(22), 'main'.padEnd(50), 'worker');
    console.log('-'.repeat(120));
    for (const f of fields) {
      const m = JSON.stringify(main[f]);
      const w = JSON.stringify(worker[f]);
      const ok = m === w;
      if (!ok) allMatch = false;
      console.log((ok ? '  ' : '✗ ') + f.padEnd(20), (m ?? '').slice(0, 48).padEnd(50), w ?? '');
    }
    console.log('-'.repeat(120));
    console.log(allMatch ? '✅ ALL MATCH — worker scope spoof works' : '❌ MISMATCH detected');
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
