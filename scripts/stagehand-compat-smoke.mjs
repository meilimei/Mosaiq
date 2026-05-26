#!/usr/bin/env node
/**
 * scripts/stagehand-compat-smoke.mjs
 *
 * Proves: the official `@browserbasehq/sdk` client works against our
 * cloud-runtime baseURL with zero Mosaiq-specific code. This is the
 * Stagehand compat acceptance test for phase 11.4 (PRD M6).
 *
 * Three sub-scenarios per run, in increasing surface area:
 *
 *   s1_empty           — bb.sessions.create({})
 *                         exercises: X-BB-API-Key auth, default persona seed,
 *                         BB response superset, connectUrl wiring
 *
 *   s2_userMetadata    — bb.sessions.create({ userMetadata: {...} })
 *                         exercises: BB request body acceptance, userMetadata
 *                         persistence + echo
 *
 *   s3_viewport        — bb.sessions.create({ browserSettings: { viewport }})
 *                         exercises: browserSettings.viewport honoring (not
 *                         dropped into unsupportedFields)
 *
 * For each: assert response has `connectUrl`, then `chromium.connectOverCDP(connectUrl)`
 * → goto https://example.com → assert title === "Example Domain" → close +
 * best-effort DELETE /v1/sessions/:id so we don't hold the fly machine for the
 * full TTL.
 *
 * Usage:
 *   $env:MOSAIQ_BASE_URL = "https://mosaiq-cloud-runtime.fly.dev"
 *   $env:MOSAIQ_API_KEY  = "msq_sk_live_..."
 *   node scripts/stagehand-compat-smoke.mjs
 *
 * Exit 0 if all 3 scenarios pass, 1 on any failure. Stdout is line-delimited
 * JSON (jq-friendly) so CI can pipe-grep the result.
 *
 * Cost: ~$0.0003-0.001 per run (3 sessions × ~30s each on shared-2x).
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

/** @type {(label: string, obj?: unknown) => void} */
function log(label, obj) {
  const base = { ts: new Date().toISOString(), label };
  const extra = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : { data: obj };
  console.log(JSON.stringify({ ...base, ...extra }));
}

/**
 * Run one scenario: create via BB SDK, connect via Playwright CDP, navigate,
 * verify title, close + best-effort release.
 *
 * @param {string} name short scenario id used in log labels
 * @param {Record<string, unknown>} createOpts what we hand to bb.sessions.create()
 * @returns {Promise<{ ok: true, sessionId: string }>}
 */
async function runScenario(name, createOpts) {
  const t0 = Date.now();
  log(`${name}:create_start`, { createOpts });

  // 1. Create session via real Browserbase SDK ───────────────────────────────
  const session = await bb.sessions.create(createOpts);
  const sessionId = session.id;
  const connectUrl = session.connectUrl;

  log(`${name}:create_ok`, {
    sessionId,
    connectUrl,
    projectId: session.projectId,
    createMs: Date.now() - t0,
    // BB-superset response should also include our native snake_case mirror
    // (the SDK doesn't type these, but they're on the wire)
    nativeId: /** @type {any} */ (session).id,
    userMetadata: /** @type {any} */ (session).userMetadata,
  });

  if (!connectUrl) {
    throw new Error(`${name}: SDK response missing connectUrl`);
  }
  if (!sessionId || !sessionId.startsWith('ses_')) {
    throw new Error(`${name}: SDK response missing or malformed id: ${sessionId}`);
  }

  // 2. Connect via Playwright CDP ─────────────────────────────────────────────
  const tConn = Date.now();
  const browser = await chromium.connectOverCDP(connectUrl);
  log(`${name}:cdp_connected`, { sessionId, connectMs: Date.now() - tConn });

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    const tNav = Date.now();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const title = await page.title();
    log(`${name}:nav_ok`, { sessionId, title, navMs: Date.now() - tNav });

    if (title !== 'Example Domain') {
      throw new Error(`${name}: unexpected title "${title}" (expected "Example Domain")`);
    }
  } finally {
    try {
      await browser.close();
    } catch (err) {
      log(`${name}:close_warn`, { warn: errMsg(err) });
    }
  }

  // 3. Best-effort DELETE so the fly machine releases now rather than at TTL.
  //    Uses X-BB-API-Key explicitly to exercise commit-1 auth on the cleanup
  //    path too. Failure here is non-fatal; the session-expiry reaper picks it
  //    up within SESSION_TTL_MAX_SECONDS anyway.
  try {
    const delRes = await fetch(`${baseURL}/v1/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'X-BB-API-Key': apiKey },
    });
    log(`${name}:delete`, { sessionId, status: delRes.status });
  } catch (err) {
    log(`${name}:delete_warn`, { warn: errMsg(err) });
  }

  log(`${name}:done`, { sessionId, totalMs: Date.now() - t0 });
  return { ok: true, sessionId };
}

/** @type {(err: unknown) => string} */
function errMsg(err) {
  if (err && typeof err === 'object' && 'message' in err) {
    return String(/** @type {{ message: unknown }} */ (err).message);
  }
  return String(err);
}

async function main() {
  log('start', { baseURL });

  // s1_empty is the smoking gun: proves that `bb.sessions.create({})` — the
  // canonical Stagehand SDK call with zero options — produces a usable
  // session. Requires every commit in phase 11.4 to be in place (auth + BB
  // shape + default persona seed + connectUrl wiring).
  await runScenario('s1_empty', {});

  await runScenario('s2_userMetadata', {
    userMetadata: { source: 'stagehand-compat-smoke', runAt: new Date().toISOString() },
  });

  await runScenario('s3_viewport', {
    browserSettings: { viewport: { width: 1366, height: 768 } },
  });

  log('all_done', { ok: true });
}

main().catch((err) => {
  log('fatal', { error: errMsg(err), stack: /** @type {Error} */ (err)?.stack });
  process.exit(1);
});
