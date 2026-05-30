#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Phase 11.2 并发资源行为 smoke。
 *
 * 这个脚本不连 chromium，纯测**资源池**在真 docker / Fly 路径下的并发行为，
 * 是 e2e-smoke.mjs 的补充而不是替代：
 *
 *   - e2e-smoke.mjs        → 串行单 session，verifies CDP wire + persona spoof
 *   - e2e-smoke-concurrent → 并发 N=cap+1 session，verifies race fix + cap 边界 + release
 *
 * 为啥要并发 e2e：
 *   LocalDockerMachineManager / FlyMachineManager 的 acquire() 之前有个
 *   race condition：cap 检查到 #alive.set 之间有 await createContainer / createMachine
 *   的网络 RTT，并发 N+M 个请求都会通过 cap 检查，超 cap 起容器（commit 58581cd
 *   修复 + unit test 覆盖）。但 unit test 是 mock fetchImpl 的，没真正在 docker
 *   socket 路径上验证 placeholder 占位逻辑是否生效。这个 smoke 在真 docker 上
 *   verify race fix 在端到端 wire 上正确工作。
 *
 * 失败模式 = 这个 smoke 能 catch 的 prod 事故：
 *   - 修复回滚：placeholder 逻辑被改动后 race window 重新打开，docker 起超 cap
 *     个容器，host /dev/shm + RAM 烧穿；smoke 这里会看到 successes > cap。
 *   - capacity() 没正确包含 placeholder：busy 数值不对，监控告警失真。
 *   - release 路径不释放容器或 docker rm 没等：busy 不回到 0。
 *
 * 前置（同 e2e-smoke.mjs）：
 *   - cloud-runtime 已在 :8787 监听
 *   - 至少 cap >= 2（否则 skip，没意义）
 *   - MOSAIQ_API_URL / MOSAIQ_API_KEY 环境变量
 *
 * 运行：
 *   node packages/cloud-sdk/scripts/e2e-smoke-concurrent.mjs
 */

import { MosaiqCloudClient } from '../dist/index.js';
import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';

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

const client = new MosaiqCloudClient({ apiUrl, apiKey, projectId, requestTimeoutMs });
log('client configured', { apiUrl, projectId, requestTimeoutMs });

// ─── 1) 取 cap，决定并发数 ─────────────────────────────────────────────────
const health0 = await client.health();
log('initial health', health0.pool);
const cap = health0.pool.cap;
if (cap < 2) {
  // cap=1 没法测 race（race 需要至少 2 个并发位）。e2e workflow 用 cap=4，
  // dev/manual run 用 cap=8 默认；这里只防御性 skip。
  log(`pool cap=${cap} < 2 → skipping concurrent smoke (need at least 2 to exercise cap boundary)`);
  process.exit(0);
}
if (health0.pool.busy !== 0) {
  fail(`initial pool.busy != 0 (got ${health0.pool.busy}); other tests left sessions around?`);
  process.exit(1);
}

// ─── 2) 并发起 cap+1 个 session ─────────────────────────────────────────
// 用 inline persona，所有 session 共享同一份（cloud-runtime 不要求 persona 唯一性，
// race 只测资源池行为）。stealth 全部关闭，省 inject overhead，让 acquire 路径
// 尽快到 docker create + chromium boot 这两个最慢的 step，最大化 race window。
const persona = createWin11ChromeUsPersona({
  id: 'e2e-concurrent',
  displayName: 'E2E Concurrent',
  masterSeed: 'concurrent-seed-001',
});
const N = cap + 1;
log(`launching ${N} concurrent createSession (cap=${cap}); ${N - cap} should reject pool.exhausted`);

const launchT0 = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    client
      .createSession({
        persona: { inline: persona },
        // 关闭所有 stealth 让 acquire 路径最短，race window 暴露最大。
        stealth: { inject: false, humanize: false, rebrowserPatches: false },
        ttlSeconds: 120,
        clientLabel: `e2e-concurrent-${i}`,
      })
      .then(
        (session) => ({ kind: 'ok', session, idx: i }),
        (err) => ({ kind: 'fail', err, idx: i }),
      ),
  ),
);
const launchMs = Date.now() - launchT0;
log(`all ${N} createSession requests settled in ${launchMs}ms`);

const successes = results.filter((r) => r.kind === 'ok');
const failures = results.filter((r) => r.kind === 'fail');

log(`successes=${successes.length}, failures=${failures.length}`);

// ─── 3) 断言：恰好 cap 个成功 ──────────────────────────────────────────
// 这是 race fix 的核心 invariant。修复回滚后这里会 > cap，意味着 docker 已经
// 起了超 cap 个容器，host 资源被烧。
if (successes.length !== cap) {
  fail(`expected exactly ${cap} successes, got ${successes.length}`, {
    successCount: successes.length,
    failureCount: failures.length,
    failureCodes: failures.map((f) => f.err?.code ?? '?'),
  });
} else {
  ok(`exactly ${cap} sessions acquired (race fix invariant)`);
}

// ─── 4) 断言：N-cap 个 reject with pool.exhausted ─────────────────────
if (failures.length !== N - cap) {
  fail(`expected ${N - cap} failures, got ${failures.length}`);
} else {
  ok(`${failures.length} request(s) rejected as expected`);
  for (const f of failures) {
    const code = f.err?.code ?? '?';
    if (code !== 'pool.exhausted') {
      fail(`failure[${f.idx}].code != pool.exhausted (got '${code}')`, {
        message: f.err?.message,
        httpStatus: f.err?.httpStatus,
        detail: f.err?.detail,
      });
    } else {
      ok(`failure[${f.idx}] code=pool.exhausted httpStatus=${f.err?.httpStatus ?? '?'}`);
    }
  }
}

// 多余的 session id 应该都不同（不要意外地把同一 session 返回多次）
const sessionIds = successes.map((s) => s.session.id);
const uniqueIds = new Set(sessionIds);
if (uniqueIds.size !== sessionIds.length) {
  fail(`session ids not unique`, { sessionIds });
} else {
  ok(`all ${sessionIds.length} session ids unique`);
}

// ─── 5) 断言：health 反映 busy=cap ─────────────────────────────────────
const health1 = await client.health();
log('health after burst', health1.pool);
if (health1.pool.busy !== cap) {
  fail(`pool.busy != cap after burst (expected ${cap}, got ${health1.pool.busy})`, health1.pool);
} else {
  ok(`pool.busy=${cap} matches successful acquires`);
}

// ─── 6) 释放所有 sessions ──────────────────────────────────────────────
// Promise.all 并发 close。release 内部串行 docker rm，但 cloud-runtime 自己
// 也是并发处理这些 DELETE 请求。
log(`closing ${successes.length} sessions concurrently`);
const closeT0 = Date.now();
const closeResults = await Promise.allSettled(successes.map((r) => r.session.close()));
const closeMs = Date.now() - closeT0;
log(`all close() settled in ${closeMs}ms`);

const closeFailed = closeResults.filter((r) => r.status === 'rejected');
if (closeFailed.length > 0) {
  fail(`${closeFailed.length} session.close() failed`, {
    reasons: closeFailed.map((r) => r.reason?.message ?? String(r.reason)),
  });
} else {
  ok(`all ${closeResults.length} sessions closed cleanly`);
}

// ─── 7) 断言：health 反映 busy=0 ─────────────────────────────────────
// release 在 cloud-runtime 路由层是 await 完整 docker rm 才返回的，所以
// session.close() resolved 之后 capacity 应该立刻准确（不需要 grace period）。
const health2 = await client.health();
log('health after release', health2.pool);
if (health2.pool.busy !== 0) {
  fail(`pool.busy != 0 after release (got ${health2.pool.busy})`, health2.pool);
} else {
  ok('pool.busy=0 after release (release path fully drained)');
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log('');
if (process.exitCode === 1) {
  console.log(`\u26A0\uFE0F  e2e concurrent smoke FAILED in ${elapsed}s`);
  process.exit(1);
} else {
  console.log(`\uD83C\uDF89  e2e concurrent smoke PASSED in ${elapsed}s`);
  process.exit(0);
}
