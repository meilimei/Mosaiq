#!/usr/bin/env node
/**
 * scripts/keepalive-reconnect-smoke.mjs
 *
 * Phase 11.5 acceptance smoke: prove keepAlive=true session pod state survives
 * client WS disconnect + reconnect.
 *
 * Flow (single run = 1 sessionId, 2 CDP connections):
 *
 *   1) bb.sessions.create({
 *        keepAlive: true,
 *        userMetadata: { stickyKey: "smoke:<ts>" },
 *      })
 *      → 201, response.keepAlive=true, expiresAt ~24h ahead
 *
 *   2) chromium.connectOverCDP(connectUrl) (#1)
 *      → goto https://example.com
 *      → page.evaluate writes:
 *          - localStorage.setItem('mosaiqKeepAliveProbe', '<probeValue>')
 *          - indexedDB.open('mosaiq_keepalive') + put('probe', <probeValue>)
 *      → assert read-back works in same connection
 *      → page.close + browser.close (disconnects WS but DOES NOT call DELETE
 *        on Mosaiq side)
 *
 *   3) sleep 3s (let pod see WS close + verify session row still status='live'
 *        via GET /v1/sessions/{id})
 *
 *   4) chromium.connectOverCDP(connectUrl) (#2) -- SAME sessionId
 *      → goto https://example.com (or just `pages()` to find the existing tab)
 *      → page.evaluate reads:
 *          - localStorage.getItem('mosaiqKeepAliveProbe')  → must === probeValue
 *          - indexedDB.open(...).get('probe')              → must === probeValue
 *
 *   5) DELETE /v1/sessions/{id} explicitly (so pod doesn't sit billing for 24h)
 *
 * Sticky 409 sub-scenario (separate from main flow):
 *   - Second POST same stickyKey while first is live → expect 409
 *     session.sticky_conflict with detail.existingSessionId + detail.connectUrl
 *
 * Usage (PowerShell):
 *   $env:MOSAIQ_BASE_URL = "https://mosaiq-cloud-runtime.fly.dev"
 *   $env:MOSAIQ_API_KEY  = "msq_sk_live_..."
 *   node scripts/keepalive-reconnect-smoke.mjs
 *
 * Exit 0 if all assertions pass, 1 on any failure. JSON stdout per line for
 * jq / CI parsing.
 *
 * Cost: ~1 keepAlive session × (acquire ~35s + 2 reconnect ~1s each + ~5s of
 * pod-busy time) ≈ $0.002 per run if cleaned up promptly. If DELETE fails to
 * land, the pod will be held until SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS
 * (1h default) ≈ $0.08.
 */

import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';

const baseURL = (process.env.MOSAIQ_BASE_URL ?? '').replace(/\/+$/, '');
const apiKey = process.env.MOSAIQ_API_KEY ?? '';

if (!baseURL) {
  console.error('FAIL: MOSAIQ_BASE_URL is required (e.g. https://mosaiq-cloud-runtime.fly.dev)');
  process.exit(1);
}
if (!apiKey) {
  console.error('FAIL: MOSAIQ_API_KEY is required');
  process.exit(1);
}

const bb = new Browserbase({ apiKey, baseURL });

/** @type {(label: string, obj?: Record<string, unknown>) => void} */
function log(label, obj) {
  const base = { ts: new Date().toISOString(), label };
  const extra = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : { data: obj };
  console.log(JSON.stringify({ ...base, ...extra }));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

const stickyKey = `smoke:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
const probeValue = `kav_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

let createdSessionId = null;
let exitCode = 0;

async function step1Create() {
  const t0 = Date.now();
  const session = await bb.sessions.create({
    keepAlive: true,
    userMetadata: { stickyKey },
  });
  const acquireMs = Date.now() - t0;
  createdSessionId = session.id;
  log('s1.created', {
    sessionId: session.id,
    keepAlive: session.keepAlive,
    expiresAt: session.expiresAt,
    acquireMs,
    stickyKey,
  });
  if (session.keepAlive !== true) {
    throw new Error(`assert fail: session.keepAlive=${session.keepAlive}, expected true`);
  }
  if (!session.connectUrl || !session.connectUrl.includes('?token=sks_')) {
    throw new Error(
      `assert fail: connectUrl missing or no signing key token: ${session.connectUrl}`,
    );
  }
  return session;
}

async function step2WriteState(connectUrl) {
  const t0 = Date.now();
  const browser = await chromium.connectOverCDP(connectUrl);
  const connect1Ms = Date.now() - t0;
  log('s2.connected', { connect1Ms });

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    const nav0 = Date.now();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    const navMs = Date.now() - nav0;

    const writeResult = await page.evaluate(async (probe) => {
      localStorage.setItem('mosaiqKeepAliveProbe', probe);
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaiq_keepalive', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(probe, 'probe');
          tx.oncomplete = () => {
            req.result.close();
            resolve(undefined);
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
      return {
        ls: localStorage.getItem('mosaiqKeepAliveProbe'),
        idbStored: true,
      };
    }, probeValue);

    if (writeResult.ls !== probeValue) {
      throw new Error(`localStorage write/read mismatch: got ${writeResult.ls}`);
    }
    log('s2.wrote-state', { navMs, ls: writeResult.ls, idbStored: writeResult.idbStored });
  } finally {
    await browser.close();
    log('s2.disconnected', {});
  }
}

async function step3VerifyStillLive(sessionId) {
  // GET /v1/sessions/{id} returns superset shape: native status:'live'|'closed'
  // + BB-compat endedAt:null|<iso>. We use endedAt as the source-of-truth
  // aliveness check (matches what BB SDK clients consume) and ALSO assert on
  // native status as a sanity check.
  await sleep(3000);
  const resp = await fetch(`${baseURL}/v1/sessions/${sessionId}`, {
    headers: { 'X-BB-API-Key': apiKey },
  });
  const body = await resp.json();
  if (resp.status !== 200) {
    throw new Error(`GET /v1/sessions/{id} returned ${resp.status}: ${JSON.stringify(body)}`);
  }
  if (body.endedAt !== null) {
    throw new Error(
      `session.endedAt=${body.endedAt} after WS disconnect, expected null (still alive)`,
    );
  }
  if (body.status !== 'live') {
    throw new Error(`session.status=${body.status} after WS disconnect, expected 'live'`);
  }
  log('s3.still-running', { status: body.status, endedAt: body.endedAt });
}

async function step4ReconnectAndRead(connectUrl) {
  const t0 = Date.now();
  const browser = await chromium.connectOverCDP(connectUrl);
  const reconnectMs = Date.now() - t0;
  log('s4.reconnected', { reconnectMs });

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    // 复用上一个 tab；新 page 会在 about:blank 起，没有 example.com origin。
    let page = context.pages().find((p) => p.url().includes('example.com'));
    if (!page) {
      // pod 重启 / chromium 内部丢标签页 → state 必然丢失，本测试要 fail。
      // 但我们继续走完读路径让 fail 信息更清晰。
      page = context.pages()[0] ?? (await context.newPage());
      log('s4.warn', { reason: 'example.com tab not found, may indicate pod restart' });
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    }

    const readResult = await page.evaluate(async () => {
      const ls = localStorage.getItem('mosaiqKeepAliveProbe');
      const idb = await new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaiq_keepalive', 1);
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction('kv', 'readonly');
            const getReq = tx.objectStore('kv').get('probe');
            getReq.onsuccess = () => {
              req.result.close();
              resolve(getReq.result);
            };
            getReq.onerror = () => reject(getReq.error);
          } catch (e) {
            resolve(`(idb error: ${e?.message ?? String(e)})`);
          }
        };
        req.onerror = () => reject(req.error);
      });
      return { ls, idb };
    });

    if (readResult.ls !== probeValue) {
      throw new Error(
        `localStorage MISMATCH after reconnect: got '${readResult.ls}', expected '${probeValue}'`,
      );
    }
    if (readResult.idb !== probeValue) {
      throw new Error(
        `indexedDB MISMATCH after reconnect: got '${readResult.idb}', expected '${probeValue}'`,
      );
    }
    log('s4.state-preserved', { ls: readResult.ls, idb: readResult.idb });
  } finally {
    await browser.close();
  }
}

async function step5StickyConflict() {
  // 第二次同 stickyKey POST 应当 409
  const resp = await fetch(`${baseURL}/v1/sessions`, {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      keepAlive: true,
      userMetadata: { stickyKey },
    }),
  });
  const body = await resp.json();
  if (resp.status !== 409) {
    throw new Error(`expected 409 sticky_conflict, got ${resp.status}: ${JSON.stringify(body)}`);
  }
  if (body.error?.code !== 'session.sticky_conflict') {
    throw new Error(`expected error.code=session.sticky_conflict, got ${body.error?.code}`);
  }
  if (body.error?.detail?.existingSessionId !== createdSessionId) {
    throw new Error(
      `expected detail.existingSessionId=${createdSessionId}, got ${body.error?.detail?.existingSessionId}`,
    );
  }
  if (!body.error?.detail?.connectUrl?.includes('?token=sks_')) {
    throw new Error(
      `expected detail.connectUrl with ?token=sks_ for one-step rejoin, got ${body.error?.detail?.connectUrl}`,
    );
  }
  log('s5.sticky-conflict-confirmed', {
    code: body.error.code,
    existingSessionId: body.error.detail.existingSessionId,
    expiresAt: body.error.detail.expiresAt,
  });
}

async function cleanup() {
  if (!createdSessionId) return;
  try {
    const resp = await fetch(`${baseURL}/v1/sessions/${createdSessionId}`, {
      method: 'DELETE',
      headers: { 'X-BB-API-Key': apiKey },
    });
    log('cleanup.delete', { sessionId: createdSessionId, status: resp.status });
  } catch (err) {
    log('cleanup.error', { sessionId: createdSessionId, err: err?.message ?? String(err) });
  }
}

async function main() {
  try {
    const session = await step1Create();
    await step2WriteState(session.connectUrl);
    await step3VerifyStillLive(session.id);
    await step4ReconnectAndRead(session.connectUrl);
    await step5StickyConflict();
    log('PASS', { sessionId: createdSessionId, stickyKey });
  } catch (err) {
    log('FAIL', { err: err?.message ?? String(err), sessionId: createdSessionId });
    exitCode = 1;
  } finally {
    await cleanup();
  }
  process.exit(exitCode);
}

main();
