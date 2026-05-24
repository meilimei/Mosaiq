#!/usr/bin/env node
/**
 * scripts/prod-smoke-cloud.mjs
 *
 * End-to-end smoke test against a deployed mosaiq-cloud-runtime instance.
 * Proves the full path:
 *   client → cloud-runtime → FlyMachineManager → fly machines API
 *          → spawn browser-pod → /healthz → CDP URL → DELETE → release
 *
 * Costs ~$0.0001-0.001 per run (one shared-2x machine for <2 min).
 *
 * Usage:
 *   $env:MOSAIQ_BASE_URL = "https://mosaiq-cloud-runtime.fly.dev"
 *   $env:MOSAIQ_API_KEY  = "msq_sk_live_..."
 *   node scripts/prod-smoke-cloud.mjs
 *
 * Optional:
 *   $env:MOSAIQ_PROJECT_ID = "proj_launchai"   # default: proj_launchai
 *   $env:MOSAIQ_TTL_SECONDS = "120"            # default: 120 (2 min)
 *
 * Exit 0 on success, 1 on any failure. Pipes structured JSON to stdout
 * for grep / CI assertion.
 */

import { createWin11ChromeUsPersona } from '../packages/persona-schema/dist/templates/index.js';

const baseUrl = (process.env.MOSAIQ_BASE_URL ?? '').replace(/\/+$/, '');
const apiKey = process.env.MOSAIQ_API_KEY ?? '';
const projectId = process.env.MOSAIQ_PROJECT_ID ?? 'proj_launchai';
const ttlSeconds = Number(process.env.MOSAIQ_TTL_SECONDS ?? '120');

if (!baseUrl) {
  console.error('FAIL: MOSAIQ_BASE_URL is required');
  process.exit(1);
}
if (!apiKey) {
  console.error('FAIL: MOSAIQ_API_KEY is required');
  process.exit(1);
}

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
};

/** @type {(label: string, obj: unknown) => void} */
function logStep(label, obj) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), label, ...((obj && typeof obj === 'object') ? obj : { data: obj }) }));
}

async function main() {
  logStep('start', { baseUrl, projectId, ttlSeconds });

  // ── 1. /v1/health ──────────────────────────────────────────────────────────
  const t1 = Date.now();
  const healthRes = await fetch(`${baseUrl}/v1/health`, { method: 'GET' });
  const healthBody = await healthRes.json();
  logStep('health', { status: healthRes.status, ms: Date.now() - t1, body: healthBody });
  if (healthRes.status !== 200 || !healthBody?.ok) {
    throw new Error(`health not ok: ${JSON.stringify(healthBody)}`);
  }

  // ── 2. POST /v1/sessions (inline persona) ──────────────────────────────────
  // generate a real persona via the canonical builder
  const personaId = `smoke-${Date.now().toString(36)}`;
  const persona = createWin11ChromeUsPersona({
    id: personaId,
    displayName: `Smoke ${personaId}`,
  });
  logStep('persona_built', { id: personaId, schemaVersion: persona.schemaVersion });

  const createBody = {
    project_id: projectId,
    persona: { inline: persona },
    lifecycle: { ttl_seconds: ttlSeconds },
    client_label: 'prod-smoke-cloud',
  };

  const t2 = Date.now();
  const createRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(createBody),
  });
  const createMs = Date.now() - t2;
  const createBodyResp = await createRes.json();
  logStep('session_create', { status: createRes.status, ms: createMs, body: createBodyResp });

  if (createRes.status !== 201) {
    throw new Error(`session create failed: HTTP ${createRes.status} ${JSON.stringify(createBodyResp)}`);
  }
  const sessionId = createBodyResp?.id;
  const cdpUrl = createBodyResp?.cdp_url;
  if (!sessionId || !cdpUrl) {
    throw new Error(`session response missing id or cdp_url: ${JSON.stringify(createBodyResp)}`);
  }

  // ── 3. GET /v1/sessions/:id ────────────────────────────────────────────────
  const t3 = Date.now();
  const getRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
    method: 'GET',
    headers: authHeaders,
  });
  const getBody = await getRes.json();
  logStep('session_get', { status: getRes.status, ms: Date.now() - t3, status_field: getBody?.status });
  if (getRes.status !== 200) {
    throw new Error(`session get failed: HTTP ${getRes.status}`);
  }

  // ── 4. DELETE /v1/sessions/:id ─────────────────────────────────────────────
  const t4 = Date.now();
  const delRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  const delMs = Date.now() - t4;
  // DELETE may return 204 (no body) or 200 with body
  let delBody = null;
  try { delBody = await delRes.json(); } catch { /* 204 no body */ }
  logStep('session_delete', { status: delRes.status, ms: delMs, body: delBody });
  if (delRes.status >= 400) {
    throw new Error(`session delete failed: HTTP ${delRes.status}`);
  }

  // ── done ──────────────────────────────────────────────────────────────────
  logStep('done', {
    sessionId,
    cdpUrl,
    timings: { create_ms: createMs, delete_ms: delMs, total_ms: Date.now() - t1 },
  });
}

main().catch((err) => {
  console.error('SMOKE_FAIL:', err?.message ?? String(err));
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
