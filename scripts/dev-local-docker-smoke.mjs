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
 *   3. 跑 packages/cloud-sdk/scripts/e2e-smoke.mjs（端到端）
 *   4. 任一步失败立即退出非零
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

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const apiUrl = (process.env.MOSAIQ_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const apiKey = process.env.MOSAIQ_API_KEY;
const projectId = process.env.MOSAIQ_PROJECT_ID ?? 'proj_launchai';

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
  process.exit(1);
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
      },
    });
    child.on('exit', (code) => {
      if (code === 0) {
        log(`✅ ${label} OK`);
        resolve(true);
      } else {
        log(`❌ ${label} FAILED (exit=${code})`);
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
log(`MOSAIQ_API_URL=${apiUrl}  PROJECT=${projectId}`);
await waitForHealth();

const registerOk = await runNode('packages/cloud-sdk/scripts/register-persona.mjs', 'register-persona');
if (!registerOk) process.exit(1);

const smokeOk = await runNode('packages/cloud-sdk/scripts/e2e-smoke.mjs', 'e2e-smoke');
if (!smokeOk) process.exit(1);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n🎉 local-docker e2e smoke PASSED in ${elapsed}s`);
