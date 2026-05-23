#!/usr/bin/env node
/**
 * Phase 11.1 e2e smoke：
 *
 *   1. 用 MosaiqCloudClient 连接 cloud-runtime (http://127.0.0.1:8787)
 *   2. inline 一个 win11-chrome-us persona，调 createSession
 *   3. cloud-runtime → browser-pod → spawn chromium → 返回 ws cdp
 *   4. SDK 用 playwright-core.chromium.connectOverCDP 走 cloud-runtime ws 代理
 *   5. injectInto(context) 灌 persona JS-level spoof
 *   6. newPage → goto about:blank → evaluate 拿 navigator.* 实测值
 *   7. 跟 persona 派生值逐项比对
 *   8. close session，验证 ws/REST 清理
 *
 * 前置：
 *   - browser-pod 已在 :9222 监听
 *   - cloud-runtime 已在 :8787 监听
 *   - MOSAIQ_API_URL / MOSAIQ_API_KEY 环境变量
 *
 * 运行：
 *   node packages/cloud-sdk/scripts/e2e-smoke.mjs
 */

import { MosaiqCloudClient } from '../dist/index.js';
import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';
import { chromium } from 'playwright-core';

const apiUrl = process.env.MOSAIQ_API_URL ?? 'http://127.0.0.1:8787';
const apiKey = process.env.MOSAIQ_API_KEY;
const projectId = process.env.MOSAIQ_PROJECT_ID ?? 'proj_launchai';
const requestTimeoutMs = Number(process.env.MOSAIQ_REQUEST_TIMEOUT_MS ?? '90000');

if (!apiKey) {
  console.error('FATAL: MOSAIQ_API_KEY env required');
  process.exit(2);
}

const t0 = Date.now();
function log(label, ...rest) {
  const ms = (Date.now() - t0).toString().padStart(5, ' ');
  console.log(`[+${ms}ms] ${label}`, ...rest);
}

function ok(label) {
  console.log(`  \u2705 ${label}`);
}

function fail(label, detail) {
  console.log(`  \u274C ${label}`);
  if (detail !== undefined) console.log('     detail:', detail);
  process.exitCode = 1;
}

const persona = createWin11ChromeUsPersona({
  id: 'e2e-smoke-alice',
  displayName: 'E2E Smoke Alice',
  masterSeed: 'cafebabedeadbeef',
});
log('persona built', {
  os: persona.system.os.platformLabel,
  locale: persona.system.locale,
  languages: persona.system.languages,
  cores: persona.hardware.cpu.cores,
  memGb: persona.hardware.deviceMemoryGb,
  screen: `${persona.system.screen.width}x${persona.system.screen.height}`,
  browser: `${persona.browser.brand} ${persona.browser.fullVersion}`,
});

const client = new MosaiqCloudClient({ apiUrl, apiKey, projectId, requestTimeoutMs });
log('client configured', { apiUrl, projectId, requestTimeoutMs });

// ─── /v1/health ─────────────────────────────────────────────────────────────
log('GET /v1/health');
const health = await client.health();
log('health', health);
if (!health.ok) fail('health.ok'); else ok('health.ok');
if (health.pool.cap < 1) fail('pool.cap >= 1'); else ok(`pool.cap=${health.pool.cap}`);

// ─── POST /v1/sessions ──────────────────────────────────────────────────────
log('createSession (inline persona)');
const session = await client.createSession({
  persona: { inline: persona },
  stealth: { inject: true, humanize: false, rebrowserPatches: false },
  ttlSeconds: 600,
  clientLabel: 'e2e-smoke',
});
log('session', {
  id: session.id,
  cdpUrl: session.cdpUrl,
  expiresAt: session.expiresAt,
  stealth: session.stealth,
});
ok(`session.id=${session.id}`);
// cdpUrl 必须指向控制面（cloud-runtime 的 ws proxy），不能漏 pod 内网地址。
// host 由 server 端 PUBLIC_BASE_URL 决定（默认 localhost:8787，也可以是 127.0.0.1
// 或域名），client 不该绑死 host 字面值 —— 改为 parse 后看 pathname。
// 真正要防的是 cdpUrl 直接暴露 pod 私网 IP（172.x.x.x / fdaa:: 等），所以同时
// 黑名单一下常见私网段。
{
  const cdpUrl = session.cdpUrl;
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    fail('cdpUrl is not a valid URL', cdpUrl);
    parsed = null;
  }
  if (parsed) {
    const protoOk = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    const pathOk = parsed.pathname === `/v1/sessions/${session.id}/cdp`;
    // pod 私网段：docker bridge 默认 172.16.0.0/12、Fly 6PN fdaa::/16、k8s 10.0.0.0/8。
    // 这些不应该出现在客户端拿到的 cdpUrl 里。
    const looksLikePodPrivateIp =
      /^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname) ||
      /^10\./.test(parsed.hostname) ||
      /^fdaa[:.]/i.test(parsed.hostname);

    if (!protoOk) fail('cdpUrl protocol not ws/wss', cdpUrl);
    else if (!pathOk) fail('cdpUrl path != /v1/sessions/<id>/cdp', cdpUrl);
    else if (looksLikePodPrivateIp) fail('cdpUrl leaks pod private IP', cdpUrl);
    else ok(`cdpUrl=${cdpUrl}`);
  }
}

// ─── GET /v1/health pool reflects busy ──────────────────────────────────────
const health2 = await client.health();
log('health after acquire', health2);
if (health2.pool.busy < 1) fail('pool.busy>=1 after acquire', health2.pool);
else ok(`pool.busy=${health2.pool.busy} after acquire`);

// ─── connect playwright-core over CDP via cloud-runtime ws proxy ────────────
log('chromium.connectOverCDP');
let browser;
try {
  browser = await chromium.connectOverCDP(session.cdpUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 30_000,
  });
} catch (err) {
  fail('connectOverCDP', err?.message ?? err);
  process.exit(1);
}
ok('connectOverCDP succeeded');

const contexts = browser.contexts();
log('browser.contexts()', { count: contexts.length });
const ctx = contexts[0] ?? (await browser.newContext());

// ─── inject persona JS-level spoof BEFORE first goto ────────────────────────
log('injectInto(context)');
await session.injectInto(ctx);
ok('injectInto resolved');

// ─── open a page and evaluate navigator.* ───────────────────────────────────
log('ctx.newPage + goto about:blank');
const page = await ctx.newPage();
await page.goto('about:blank');
const observed = await page.evaluate(() => {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: Array.from(navigator.languages),
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    screenW: screen.width,
    screenH: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    timezoneOffset: new Date().getTimezoneOffset(),
    intlTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
});
log('observed', observed);

// ─── compare against persona-derived expectations ──────────────────────────
const expectations = {
  platform: persona.system.os.platformLabel, // 'Win32'
  languages: persona.system.languages, // ['en-US', 'en']
  language: persona.system.languages[0],
  hardwareConcurrency: persona.hardware.cpu.cores,
  deviceMemory: persona.hardware.deviceMemoryGb,
  maxTouchPoints: persona.hardware.maxTouchPoints,
  screenW: persona.system.screen.width,
  screenH: persona.system.screen.height,
  devicePixelRatio: persona.system.screen.devicePixelRatio,
  intlTimezone: persona.system.timezone,
};

function eq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

for (const [key, want] of Object.entries(expectations)) {
  const got = observed[key];
  if (eq(got, want)) {
    ok(`${key} = ${JSON.stringify(got)}`);
  } else {
    fail(`${key} mismatch`, { want, got });
  }
}

// userAgent must reflect persona platform and chrome version
const ua = observed.userAgent;
if (!ua.includes('Windows NT 10.0')) fail('userAgent contains Windows NT 10.0', ua);
else ok('userAgent contains Windows NT 10.0');
if (!ua.includes(`Chrome/${persona.browser.fullVersion}`)) {
  fail(`userAgent contains Chrome/${persona.browser.fullVersion}`, ua);
} else {
  ok(`userAgent contains Chrome/${persona.browser.fullVersion}`);
}

// ─── close ──────────────────────────────────────────────────────────────────
log('closing page + browser');
await page.close();
await browser.close().catch(() => undefined);

log('DELETE /v1/sessions/:id (idempotent)');
await session.close();
const info = await client.getSession(session.id).catch((err) => ({ err }));
if (info?.err) {
  log('getSession after close threw (acceptable if 404)', info.err.code ?? info.err.message);
} else {
  log('session info after close', { status: info.status });
  if (info.status !== 'closed') {
    fail('session.status == "closed" after close', info.status);
  } else {
    ok('session.status == "closed"');
  }
}

const health3 = await client.health();
log('health after release', health3);
if (health3.pool.busy !== 0) fail('pool.busy == 0 after release', health3.pool);
else ok('pool.busy == 0 after release');

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log('');
if (process.exitCode === 1) {
  console.log(`\u26A0\uFE0F  e2e smoke FAILED in ${elapsed}s`);
  process.exit(1);
} else {
  console.log(`\uD83C\uDF89  e2e smoke PASSED in ${elapsed}s`);
  process.exit(0);
}
