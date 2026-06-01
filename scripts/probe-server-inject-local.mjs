#!/usr/bin/env node
import { chromium } from 'playwright-core';
/**
 * Local probe: pod /control/start → client connectOverCDP (no injectInto) → hc check.
 * Usage: node scripts/probe-server-inject-local.mjs [controlPort] [personaCores]
 */
import { createWin11ChromeUsPersona } from '../packages/persona-schema/dist/templates/index.js';

const controlPort = Number(process.argv[2] ?? '19222');
const expectedCores = Number(process.argv[3] ?? '8');

const persona = createWin11ChromeUsPersona({ id: 'probe-local', displayName: 'Probe' });

const startRes = await fetch(`http://127.0.0.1:${controlPort}/control/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sessionId: 'ses_probe',
    persona,
    stealth: { inject: true, humanize: false, rebrowserPatches: false },
    ttlSeconds: 120,
  }),
});
if (!startRes.ok) {
  console.error('start failed', startRes.status, await startRes.text());
  process.exit(1);
}
const startBody = await startRes.json();
const { cdpUrl, machineId } = startBody;
const clientUrl = cdpUrl.replace('127.0.0.1:9223', '127.0.0.1:19223');
console.log('cdpUrl', clientUrl);

const browser = await chromium.connectOverCDP(clientUrl, { timeout: 30_000 });
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
const hc = await page.evaluate(() => navigator.hardwareConcurrency);
await browser.close();

await fetch(`http://127.0.0.1:${controlPort}/control/stop`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ machineId }),
}).catch(() => {});

if (hc === expectedCores) {
  console.log('OK server-side injection:', hc);
  process.exit(0);
}
console.error('FAIL hc=', hc, 'expected', expectedCores);
process.exit(1);
