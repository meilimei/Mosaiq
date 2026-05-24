#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * dev-local-docker-smoke.mjs — phase 11.2 LocalDocker e2e wrapper。
 *
 * 假设你已经跑了：
 *   docker compose -f docker-compose.local-docker.yml up --build -d
 *
 * 这个 wrapper 做的事：
 *   1. 轮询 /v1/health 直到 cloud-runtime 就绪（最多 60s）
 *   2. 跑 packages/cloud-sdk/scripts/register-persona.mjs（幂等）
 *   3. 跑 packages/cloud-sdk/scripts/e2e-smoke.mjs（端到端单 session + chromium）
 *   4. 跑 packages/cloud-sdk/scripts/e2e-smoke-concurrent.mjs（并发 cap+1，
 *      验证 race fix + 资源池行为；不连 chromium，只测 REST 层）
 *   5. 任一步失败立即退出非零
 *
 * 区别于 phase 11.1 static smoke：这里 cloud-runtime 在 docker 里跑，会通过
 * mount 的 /var/run/docker.sock 动态拉 mosaiq/browser-pod 容器，跟 prod (Fly
 * per-session microVM) 拓扑同构。第一次 createSession 时延会比 static 高
 * （多一次 docker create+start+healthz），属正常。
 *
 * Env (推荐放进 .env.cloud)：
 *   MOSAIQ_API_URL       默认 http://127.0.0.1:8787
 *   MOSAIQ_API_KEY       cloud-runtime 启动用的 SEED_API_KEY
 *   MOSAIQ_PROJECT_ID    默认 proj_launchai
 *
 * 用法：
 *   node scripts/dev-local-docker-smoke.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const apiUrl = (process.env.MOSAIQ_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const apiKey = process.env.MOSAIQ_API_KEY;
const projectId = process.env.MOSAIQ_PROJECT_ID ?? 'proj_launchai';
const requestTimeoutMs = process.env.MOSAIQ_REQUEST_TIMEOUT_MS ?? '90000';
// MOSAIQ_METRICS_TOKEN: when set, smoke asserts /v1/metrics auth + body shape.
// When unset, the new verifyMetricsEndpoint() step still runs but only asserts
// that the endpoint returns 404 (the "disabled by env" mode). The health.db.ok
// assertion is unconditional and lives inside waitForHealth(). Keeps backwards-
// compat with older .env.cloud files that don't define MOSAIQ_METRICS_TOKEN.
const metricsToken = process.env.MOSAIQ_METRICS_TOKEN ?? '';

if (!apiKey) {
  console.error('FATAL: MOSAIQ_API_KEY env required (must match cloud-runtime SEED_API_KEY)');
  process.exit(2);
}

const t0 = Date.now();
function log(msg, ...rest) {
  const ms = String(Date.now() - t0).padStart(5, ' ');
  console.log(`[+${ms}ms] ${msg}`, ...rest);
}

// ─── 1) wait for /v1/health ──────────────────────────────────────────────

/**
 * Health probe 超时时把 docker 状态 + cloud-runtime 容器 stderr 直接打到 stdout，
 * 这样 CI 失败时不用下载 artifact，看 workflow 网页就知道为啥起不来（OOM、
 * sqlite 路径权限、pnpm install 漏依赖、native 模块编译失败 等）。
 *
 * 我们故意 try/catch 每个子命令独立 —— 即使 docker daemon 在某些 dev 环境里没装
 * （比如 Windows 没开 WSL2 integration），脚本也别第二次崩，至少把已知信息打出来。
 */
function dumpDockerDiagnostics() {
  const composeFile = path.join(REPO, 'docker-compose.local-docker.yml');
  const tryRun = (label, args) => {
    console.error(`\n--- ${label} ---`);
    try {
      const r = spawnSync('docker', args, { encoding: 'utf8', cwd: REPO });
      if (r.error) {
        console.error(`(skipped: ${r.error.message})`);
        return;
      }
      if (r.stdout) console.error(r.stdout.trimEnd());
      if (r.stderr) console.error(r.stderr.trimEnd());
    } catch (err) {
      console.error(`(failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  tryRun('docker compose ps', ['compose', '-f', composeFile, 'ps', '-a']);
  tryRun('cloud-runtime logs (last 200 lines)', [
    'compose',
    '-f',
    composeFile,
    'logs',
    '--no-color',
    '--tail=200',
    'cloud-runtime',
  ]);
  tryRun('browser-pod-image logs (last 50 lines)', [
    'compose',
    '-f',
    composeFile,
    'logs',
    '--no-color',
    '--tail=50',
    'browser-pod-image',
  ]);
  tryRun('docker ps -a (cloud-runtime label)', [
    'ps',
    '-a',
    '--filter',
    'label=com.mosaiq.runtime=cloud-runtime',
    '--format',
    'table {{.ID}}\t{{.Status}}\t{{.Names}}',
  ]);
  console.error('\n--- dynamic pod logs (label=com.mosaiq.runtime=cloud-runtime, last 120 lines each) ---');
  try {
    const ids = spawnSync('docker', [
      'ps',
      '-aq',
      '--filter',
      'label=com.mosaiq.runtime=cloud-runtime',
    ], { encoding: 'utf8', cwd: REPO });
    if (ids.error) {
      console.error(`(skipped: ${ids.error.message})`);
    } else {
      for (const id of ids.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        console.error(`\n--- docker logs ${id} ---`);
        const logs = spawnSync('docker', ['logs', '--tail=120', id], { encoding: 'utf8', cwd: REPO });
        if (logs.stdout) console.error(logs.stdout.trimEnd());
        if (logs.stderr) console.error(logs.stderr.trimEnd());
      }
    }
  } catch (err) {
    console.error(`(failed: ${err instanceof Error ? err.message : String(err)})`);
  }
  console.error('--- end docker diagnostics ---\n');
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  let attempts = 0;
  let lastError = '';
  while (Date.now() < deadline) {
    attempts++;
    try {
      const resp = await fetch(`${apiUrl}/v1/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        const json = await resp.json().catch(() => ({}));
        log(`health OK after ${attempts} probe(s)`, json);
        // Phase 11.2 prod-hardening: /v1/health now reports db.ok. The control
        // plane can respond 200 with db.ok=false (sqlite handle open but
        // SELECT 1 failed -- disk full, schema drift, file locked by stale
        // process). That's a deploy-day footgun we must fail CI on: a "green"
        // health probe with a non-functional DB silently routes traffic to a
        // runtime that 500s on every session create.
        if (json && typeof json === 'object' && json.db && json.db.ok === false) {
          console.error(
            `FATAL: /v1/health returned ok but db.ok=false. body=${JSON.stringify(json)}`,
          );
          dumpDockerDiagnostics();
          process.exit(1);
        }
        return json;
      }
      lastError = `status=${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.error(`FATAL: cloud-runtime /v1/health not ready in 60s. last error: ${lastError}`);
  console.error('Hint: did you run `docker compose -f docker-compose.local-docker.yml up -d` first?');
  dumpDockerDiagnostics();
  process.exit(1);
}

// ─── 1b) /v1/metrics — prod-hardening regression gate (phase 11.2) ─────────
//
// Catches regressions in:
//   - METRICS_TOKEN bearer auth wiring (missing token must 401, NOT 200/500)
//   - prom-client registry exposition (body must contain known counter names)
//   - rate-limit middleware doesn't gate /v1/metrics (scraper would be DoS'd
//     by its own per-IP token bucket if mounted under rate-limit)
//
// When MOSAIQ_METRICS_TOKEN is unset, /v1/metrics returns 404 (endpoint is
// "disabled"). That's a legitimate prod mode (operator decided not to expose
// metrics); we just log and skip the body assertions. The unauth probe still
// runs and asserts 404 (NOT 401 or 500).
async function verifyMetricsEndpoint() {
  log('verifying /v1/metrics (prod-hardening regression gate)');
  const expectedStatus = metricsToken ? 401 : 404;

  // (a) unauth probe
  const noauth = await fetch(`${apiUrl}/v1/metrics`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (noauth.status !== expectedStatus) {
    console.error(
      `FATAL: GET /v1/metrics without auth: expected ${expectedStatus}, got ${noauth.status}`,
    );
    dumpDockerDiagnostics();
    process.exit(1);
  }
  log(`  unauth probe -> ${noauth.status} OK`);

  if (!metricsToken) {
    log('  MOSAIQ_METRICS_TOKEN unset -> skipping body assertions (endpoint disabled by env)');
    return;
  }

  // (b) wrong-token probe -> 401
  const wrongToken = await fetch(`${apiUrl}/v1/metrics`, {
    headers: { authorization: 'Bearer not-the-real-token' },
    signal: AbortSignal.timeout(5_000),
  });
  if (wrongToken.status !== 401) {
    console.error(
      `FATAL: GET /v1/metrics with wrong bearer: expected 401, got ${wrongToken.status}`,
    );
    dumpDockerDiagnostics();
    process.exit(1);
  }
  log('  wrong-token probe -> 401 OK');

  // (c) correct-token probe -> 200 + body contains known counters
  const authed = await fetch(`${apiUrl}/v1/metrics`, {
    headers: { authorization: `Bearer ${metricsToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (authed.status !== 200) {
    const body = await authed.text().catch(() => '');
    console.error(
      `FATAL: GET /v1/metrics with bearer: expected 200, got ${authed.status}. body=${body.slice(0, 256)}`,
    );
    dumpDockerDiagnostics();
    process.exit(1);
  }
  const body = await authed.text();
  const required = ['sessions_created_total', 'http_request_duration_seconds'];
  const missing = required.filter((name) => !body.includes(name));
  if (missing.length > 0) {
    console.error(
      `FATAL: /v1/metrics body missing required metric(s): ${missing.join(', ')}. body head=${body.slice(0, 512)}`,
    );
    dumpDockerDiagnostics();
    process.exit(1);
  }
  log(`  authed probe -> 200, body contains [${required.join(', ')}] OK`);
}

// ─── 2) sub-process runner ───────────────────────────────────────────────
function runNode(scriptRelPath, label) {
  return new Promise((resolve) => {
    log(`▶  ${label}: node ${scriptRelPath}`);
    const child = spawn(process.execPath, [path.join(REPO, scriptRelPath)], {
      cwd: REPO,
      stdio: 'inherit',
      env: {
        ...process.env,
        MOSAIQ_API_URL: apiUrl,
        MOSAIQ_API_KEY: apiKey,
        MOSAIQ_PROJECT_ID: projectId,
        MOSAIQ_REQUEST_TIMEOUT_MS: requestTimeoutMs,
      },
    });
    child.on('exit', (code) => {
      if (code === 0) {
        log(`✅ ${label} OK`);
        resolve(true);
      } else {
        log(`❌ ${label} FAILED (exit=${code})`);
        dumpDockerDiagnostics();
        resolve(false);
      }
    });
    child.on('error', (err) => {
      log(`❌ ${label} spawn error`, err.message);
      resolve(false);
    });
  });
}

// ─── main ────────────────────────────────────────────────────────────────
log(`MOSAIQ_API_URL=${apiUrl}  PROJECT=${projectId}  REQUEST_TIMEOUT_MS=${requestTimeoutMs}`);
log(`MOSAIQ_METRICS_TOKEN ${metricsToken ? 'set (will verify /v1/metrics auth+body)' : 'unset (will only verify /v1/metrics returns 404)'}`);
await waitForHealth();
await verifyMetricsEndpoint();

const registerOk = await runNode('packages/cloud-sdk/scripts/register-persona.mjs', 'register-persona');
if (!registerOk) process.exit(1);

const smokeOk = await runNode('packages/cloud-sdk/scripts/e2e-smoke.mjs', 'e2e-smoke');
if (!smokeOk) process.exit(1);

// 并发 smoke 跑在串行 smoke 之后，依赖前一步已经 release 完所有 session（pool
// 回到 busy=0），不然 concurrent smoke 第一步 initial-busy 检查会失败。
const concurrentOk = await runNode(
  'packages/cloud-sdk/scripts/e2e-smoke-concurrent.mjs',
  'e2e-smoke-concurrent',
);
if (!concurrentOk) process.exit(1);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n🎉 local-docker e2e smoke PASSED in ${elapsed}s`);
