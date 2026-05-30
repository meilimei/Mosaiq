# Changelog

All notable changes to Mosaiq are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while
in 0.x (minor bumps may include breaking changes).

## [Unreleased]

### Added — Cloud server-side injection (Option A) + Detection Lab evidence (2026-05-30)

落实「证据 → 用户 → 夯实」推进建议的第一刀（详见 [`docs/ROADMAP-90D.md`](docs/ROADMAP-90D.md)）。

- **云端服务端注入（Option A，默认开启）** —— 解决「裸 `connectOverCDP` /
  Browserbase baseURL swap 拿不到深层 stealth」的核心矛盾。新增
  `apps/browser-pod/src/inject.ts` `applyServerStealth`：pod 在 chromium 起好后用
  自带 playwright `connectOverCDP` + `addInitScript` 注册与 desktop launcher 同款
  `injectAll`（canvas/WebGL/audio/UA-CH/字体/worker scope）。每 session 受
  `stealth.inject`、pod 受 `POD_SERVER_INJECT` 约束；连接保持到 session 结束，
  `killChromium` 先 close 再 SIGTERM。`apps/browser-pod` 新增 `@runova/sdk` 依赖，
  Dockerfile 用 `MOSAIQ_SDK_SKIP_POSTINSTALL=1` 跳过无关的 rebrowser-patch postinstall。
  **三重验证**：(1) 真 pod + 真 chromium 本地实测，裸 `connectOverCDP` 不调
  `injectInto` 即得 `hardwareConcurrency`/WebGL renderer = persona 值；(2) pod +
  cloud-runtime Docker 镜像构建通过；(3) **全链路 `docker-compose.local-docker.yml`
  e2e 本地跑绿**（cloud-runtime → LocalDocker → pod 容器 → CDP 反代），
  `e2e-smoke.mjs` 新增「不调 injectInto 也 spoof」断言通过。
- **修复 `LocalDockerMachineManager` pod-start 超时** —— 35s→75s（与 Fly 对齐）。
  pod 内 chromium boot 默认 60s，35s 会在慢机器上提前 abort 误判 `pool.pod_unhealthy`
  并丢失 pod 诊断。属上面 compose e2e 实测暴露的既有 bug。
- **`injectAll` realm 级幂等守卫** —— 服务端注入 + 客户端 `injectInto` 双重注册同一
  文档只生效一次，不会双重包装 prototype getter。
- **Detection Lab 首批真实 baseline + scorer 重校准** —— 4 个 fixture persona
  （win11/win10/macOS/Ubuntu）对 12 个 live 站点各跑一次，
  `tests/fixtures/baseline-runs/<id>/baseline.json` 首次提交，detection-lab CI gate
  现真正生效。深入调查首跑的 2 个 hit 后确认**两者均非伪装失败，而是 scorer 判定过严/
  误判严重度**（与 bench `PHASE-1-NEXT-STEPS.md` / `PHASE-2-PLAN.md` 既有结论一致），
  据此重校准 `detection-lab/scorer.ts`（**注入层未改动**——`liesCount=0` + canvas
  正常渲染证明伪装本就 API 一致）：
  - **browserleaks-canvas**：移除「uniqueness>50% → medium hit」。canvas 是高熵指纹，
    真实浏览器 / 隐私工具同样常 100% unique，而 per-persona 噪声本就**故意**让 hash 唯一
    （反跨站追踪）；旧逻辑「唯一性高 = noise 不足」方向是反的。真正的 spoof-failed 信号
    （hash 缺失 / 全黑）仍保留为 high。
  - **creepjs WebGL bold-fail**：`liesCount===0`（无真实撒谎）时由 high 降为 low。这是
    CreepJS 人工策展 GPU 白名单的数据缺口（Intel UHD 730 未收录，真实同款 GPU 用户同样
    bold-fail，「非 Mosaiq bug」），项目 Phase 2.2 bench 已证实 JS 层无法反推命中
    （联合密度 ~5.5e-8）。保持可见但不再误判为 high。
  - **影响**：4 份 baseline weightedHits 4.50 → **0.50**（canvas hit 消除、creepjs
    WebGL 降 low）。scorer 单测 +2（WebGL bold-fail liesCount=0/≠0 两态）。
- **公开 leaderboard** —— `pnpm build-leaderboard` 由 4 份真 baseline 生成静态站
  （部署 GitHub Pages 需 maintainer 开启）。
- **质量护栏** —— CI 加 `@mosaiq/browser-pod` 单测 + non-blocking biome
  changed-files 可见性 gate；`@mosaiq/cli` 版本号改为从 package.json 动态读
  （消除 0.9.0-dev 漂移）；`@runova/cloud-sdk` 纳入 `audit-tarballs`；`cloud-runtime`
  README / ci.yml 注释大面积 doc 漂移修正；`DEVELOPMENT.md §8` 新增技术债清单。
- **新文档 / 模板** —— `docs/EVIDENCE-AND-VALIDATION.md`（baseline bootstrap +
  leaderboard + 硬目标/真账号实测协议）、`docs/ROADMAP-90D.md`（单人+AI 90 天现实
  路线）、`.github/ISSUE_TEMPLATE/detection-report.yml`（反检测命中回流）。
  `RELEASING.md §8` 改成可执行的 npm `@mosaiq` scope go-live 清单（含 cloud-sdk）。

### Added — v0.11 phase 11.1: Cloud Runtime alpha (2026-05-22)

第一次把 Mosaiq 的 cloud track 从设计稿（`docs/CLOUD-RUNTIME-ARCH.md`）落到
能跑的代码：控制平面 + browser-pod + 客户端 SDK + 本地 docker-compose 一键
起。设计文档 [`docs/CLOUD-V0-IMPLEMENTATION.md`](docs/CLOUD-V0-IMPLEMENTATION.md)
是七大 ADR 的工程落地版（Hono on Node / 原生 chromium `--remote-debugging-port`
+ 控制平面 WS 反代 / Drizzle + sqlite / Bearer + sha256 / per-session pod /
不做 Stagehand 兼容预备）。

- **`apps/cloud-runtime`（new app）** — Hono 控制平面，listen `:8787`：
  - REST：`GET /v1/health`、`POST/GET/DELETE /v1/sessions/:id`、
    `GET/POST/GET/DELETE /v1/personas[/:id]`
  - WebSocket：`/v1/sessions/:id/cdp` 全双工反向代理到 pod chromium
    `:9223/devtools/browser/<uuid>`，鉴权支持 Bearer header 或
    `?token=` query 兜底（Stagehand / 浏览器端用例）
  - DB：Drizzle + better-sqlite3（dev 文件 / `:memory:` 测试），6 张表
    schema（`projects`/`api_keys`/`sessions`/`personas`/`usage_events`/
    `audit_events`），`bootstrap.ts` 跑 idempotent `CREATE TABLE IF NOT
    EXISTS`，无 drizzle-kit migration（phase 11.5 上 Stripe 时再引入）
  - MachineManager 抽象 + 三实现：`StaticPoolMachineManager`（v0.11
    默认，POD_ADDRS 列出预跑 pod 轮询分配）、`LocalDockerMachineManager`
    /`FlyMachineManager` 占位（11.2/11.2 落地）
  - 鉴权：Bearer + `sha256(plaintext)` 存 DB（plaintext 不入库），
    `audit_events` 异步写
  - 25/25 vitest 通过（含 Hono `app.request()` 端到端集成 + 静态池单元
    测试 + bootstrap 幂等校验）

- **`apps/browser-pod`（new app）** — 单 session pod：
  - Node HTTP `:9222` 控制端：`GET /healthz`、`POST /control/start`
    （拉起 chromium 子进程）、`POST /control/stop`（kill + 清
    user-data-dir）
  - chromium 子进程 spawn：`playwright-core` 解析 binary 路径，cmdline
    flag 从 persona 派生（`--lang` / `--window-size` /
    `--proxy-server` / `--user-agent` / `--user-data-dir` / `--no-sandbox`
    / `--disable-blink-features=AutomationControlled` 等）
  - chromium `/json/version` 拉到 `webSocketDebuggerUrl` 后回吐给
    控制平面，控制平面 `rewriteCdpHost` 把 chromium 自报的
    `localhost:9223` 换成 pod 路由 host（`browser-pod-1:9223`）
  - TTL 看门狗：`setTimeout(SIGTERM, ttlSeconds*1000)` 兜底失联场景
  - Dockerfile 基于 `mcr.microsoft.com/playwright:v1.59.1-noble`，
    多阶段 build（pnpm install → tsc → minimal runner），1GB shm

- **`packages/cloud-sdk`（new package）** — 客户端 SDK：
  - `MosaiqCloudClient` REST 客户端：`createSession` / `getSession` /
    `closeSession` / `listPersonas` / `getPersona` / `createPersona` /
    `health`，所有非 2xx 抛 `CloudApiError(code, status, detail)`
  - `ManagedCloudSession.injectInto(ctx)` 在 `connectOverCDP` 后用
    `addInitScript` 注入 persona JS-level spoof —— **复用 `@runova/sdk`
    `injection` 的 `buildInjectionConfig` + `injectAll` 同款脚本**，
    让 cloud session 与 desktop `launchPersona()` 行为完全一致
  - 12/12 vitest 通过，包括设计稿 §9 必过的
    `injection-survives-cdp.test.ts` smoke（happy-dom 模拟 frame，eval
    出来的脚本真的把 `navigator.hardwareConcurrency` /
    `navigator.platform` / `navigator.userAgent` 改成 persona 字段）

- **`docker-compose.cloud.yml`** —— 一键起 `cloud-runtime` + 2 个
  `browser-pod`，pod 不暴露 host 端口，仅 docker 内部网络可达，控制
  平面在 `127.0.0.1:8787` 暴露给本机；`.env.cloud.example` 给出 dev
  `SEED_API_KEY` 生成命令

- **`docs/LAUNCHAI-INTEGRATION.md`** —— 让
  [LaunchAI](https://github.com/meilimei/LaunchAI) 把 prod 路径
  `runtime-browserbase.ts`（stub）切到 Mosaiq Cloud 的 hands-on 手册：
  - `runtime-mosaiq.ts` 完整模板代码
  - `BROWSER_RUNTIME=mosaiq` env wire
  - persona 注册流程（POST /v1/personas）+ DEFAULT_PERSONA_ID
  - 故障排查表（最常见的「`cdp_url` host 在 docker 内部网络不可达」
    用 `PUBLIC_BASE_URL=http://localhost:8787` 修）

### Cut from phase 11.1（明确留给后续）

| 何时落 | 功能 |
|---|---|
| v0.12 phase 11.2 | Fly.io 部署 + Postgres schema 镜像 + `FlyMachineManager` 实现 |
| v0.13 phase 11.3 | warm pool（冷启动 < 2s）+ Browserbase 兼容 REST 真实现 + sticky session |
| v0.14 phase 11.4 | Persona Pool Service GA：seed pool / capture / filter-based selection |
| v0.15 phase 11.5 | Stripe Metered + Admin Console（Next.js 管理台）+ `usage_events` emitter |
| v0.16 phase 11.6 | 多 Region + MCP server + Captcha solver |

### 全局测试统计

无回归。`pnpm -r test` 总计：

| package | 测试文件 | 测试数 |
|---|---|---|
| `@runova/persona-schema` | 1 | 26 |
| `@runova/sdk` | 29 | 623 |
| `@mosaiq/cli` | 3 | 64 |
| `@mosaiq/desktop` | 2 | 45 |
| `@mosaiq/cloud-runtime` (new) | 3 | 25 |
| `@mosaiq/browser-pod` (new) | 0 | passWithNoTests |
| `@runova/cloud-sdk` (new) | 3 | 12 |
| **总计** | **41** | **795** |

`pnpm typecheck` 7 包全绿；`pnpm --filter <new>... build` 3 个新包都
出 `dist`。

---

### Track B of v0.10 — the Detection Lab CI gate

**Track B has fully landed on top of `v0.10.0`.** Phases 10.6a + 10.6b
+ 10.7 + 10.8 + 10.9 are all in; the only remaining v0.10 work is the
maintainer-side bootstrap (commit the first `baseline.json` from a green
detection-lab workflow's candidate artifact) and the actual
`npm publish` of `@runova/persona-schema` / `@runova/sdk` /
`@mosaiq/cli` at `0.10.0`.

### Added

- **Phase 10.6a — `stripRunForBaseline` pure projection** (`commit 886a5bc`).
  New SDK export `stripRunForBaseline(run: DetectionRun): DetectionRun`
  (and three placeholder constants: `BASELINE_RUN_ID`,
  `BASELINE_TIMESTAMP`, `BASELINE_CHROMIUM_VERSION`). Replaces — does not
  delete — every field that's environment-dependent (runId / startedAt /
  finishedAt / durationMs / meta.chromiumVersion / raw.timestamp /
  raw.overallMs / per-site durationMs+screenshot+html+retries+bodyText+
  title+error) with stable placeholders so the output is git-trackable:
  the same persona-schema + SDK version producing the same anti-detection
  behavior will yield a byte-identical stripped JSON across runs, runner
  OSes, and chromium build numbers. Behavior-relevant fields
  (personaId / status / score.\* / meta.sdkVersion / raw.persona /
  per-site id+name+url+ok+extracted) are preserved verbatim. 30 vitest
  cases cover field-stripping invariants, run shape preservation,
  null-safe handling of `finishedAt: null` / `raw: undefined`,
  identity-on-already-stripped-input, and the round-trip "stripped run
  is still a valid `DetectionRun` parseable by downstream SDK
  consumers". This is the foundation Phase 10.7's CI comparator stands
  on — without it, every baseline diff would be permanently red.

- **Phase 10.6b — deterministic fixture personas + CI drift gate**
  (`commit 708b7e1`).
  - `scripts/build-fixture-personas.ts` (~143 LOC) — deterministic
    persona-fixture generator. Imports `createWin11ChromeUsPersona`
    from `@runova/persona-schema`, overrides the template's normally-
    random `masterSeed` with the well-known constant
    `'deadbeef'` and replaces `metadata.createdAt` / `updatedAt` (which
    the template factory sets via `new Date()`) with the unix-epoch
    timestamp `'1970-01-01T00:00:00.000Z'`. Output is a single
    pretty-printed JSON file under `tests/fixtures/personas/<id>.json`
    that's byte-stable across regenerations. Two modes:
    `pnpm build-fixture-personas` writes the fixture(s);
    `pnpm build-fixture-personas --check` exits 1 if any committed
    fixture diverges from what the current generator would emit.
  - `tests/fixtures/personas/win11-chrome-us.json` (~3.3 KB) — first
    committed fixture, baseline persona for the Phase 10.7 CI
    comparator. Tagged `template:win11-chrome-us`, `fixture`, `ci`
    so the `extractTemplateTag` resolution path (cli + desktop) round-
    trips correctly.
  - `.github/workflows/ci.yml`: new "Drift check — Detection Lab
    fixture personas" step (`pnpm build-fixture-personas --check`)
    next to the captured-WebGL-profiles drift check + SDK patch drift
    check. Fails the PR if a contributor modifies the generator
    without committing the regenerated JSON (or hand-edits the JSON
    out-of-sync with the generator).
  - The `package.json` `scripts` field gained a top-level
    `build-fixture-personas` alias (`tsx scripts/build-fixture-
    personas.ts`) so CI + local invocations share one entry point.

- **Phase 10.7 — Detection Lab CI gate workflow + file-vs-file
  comparator** (this entry).
  - `scripts/ci-compare-baseline.mjs` (~470 LOC) — the heart of the
    gate. Pure Node ESM, imports `diffRuns` + `stripRunForBaseline`
    from `@runova/sdk` via a workspace-aware `file://` URL (the bare
    `@runova/sdk` specifier doesn't resolve from the workspace root
    because pnpm only symlinks SDK into consumer packages'
    `node_modules`; the file-URL import side-steps the resolver and
    works from any cwd). Two modes:
    - `compare <baseline.json> <candidate.json>
      [--fail-on-regression] [--markdown-out <file>]
      [--network-failure-tolerance <n>] [--require-baseline]`.
      Loads both JSON files, strips the candidate via
      `stripRunForBaseline` so the diff isolates behavior delta from
      environmental noise (host chromium version, ISO timestamps),
      then runs SDK `diffRuns`. Emits a GitHub-flavored markdown
      report (always — to stdout + optionally to a file for the
      workflow's `$GITHUB_STEP_SUMMARY`). Lenient policy: any added
      hit OR rising weightedHits is a regression, but up to
      `--network-failure-tolerance` (default 2) `ok → fail` site
      flips are tolerated if no hits were added and weightedHits
      didn't rise (transient network noise rather than a real
      regression). Exit codes: `0` = pass / `1` = regression
      (with `--fail-on-regression`) / `2` = arg or file error.
      When the baseline file is missing, the script enters
      **bootstrap mode**: emits a markdown report explaining how
      to commit the candidate as the new baseline and exits 0
      (unless `--require-baseline` is set, in which case exit 1).
    - `write-baseline <candidate.json> <out-baseline.json>` — reads
      a raw `DetectionRun` JSON and writes the `stripRunForBaseline`-
      stripped projection to disk. Used to bootstrap a new baseline
      from a CI-runner artifact.
  - `.github/workflows/detection-lab.yml` (~165 LOC) — the workflow.
    Triggers: pull_request (paths-filtered to SDK / persona-schema /
    patches / fixtures / the script + workflow itself), push:main
    (same paths), weekly `cron '0 6 * * 1'`, and `workflow_dispatch`
    (with a `persona` input for ad-hoc re-runs). Steps: checkout →
    pnpm/node setup (pinned to `9.12.0` / `.nvmrc`) → install
    `--frozen-lockfile` → build all three publishable packages →
    `playwright install --with-deps chromium` → import the matrix
    persona fixture into the runner's `~/.mosaiq/personas/` (with
    `--on-conflict overwrite` to ensure the run picks up the
    committed fixture verbatim) → `pnpm mosaiq detection-lab run
    <persona> --json --quiet --retries 3 --timeout 60000` →
    `node scripts/ci-compare-baseline.mjs compare … --fail-on-
    regression --network-failure-tolerance 2` → append markdown
    report to `$GITHUB_STEP_SUMMARY` → always upload the
    `candidate-<persona>.json` + `regression-<persona>.md` +
    `~/.mosaiq/detection-runs/<persona>/` as artifact (retention 14
    days). Matrix on `persona` (single `[win11-chrome-us]` MVP
    entry; expand by adding more fixture files). Concurrency-locked
    to cancel superseded commits' in-flight runs. Timeout 30 min.
  - `tests/fixtures/baseline-runs/README.md` (~85 LOC) —
    contributor docs covering the why ("stripped baseline" rationale,
    list of replaced vs preserved fields), the bootstrap workflow
    (download CI artifact → `write-baseline` → commit), the refresh
    workflow (when a detection site updates its detector), and the
    "do not hand-edit `baseline.json`" rule.
  - Root `package.json` gained a top-level `ci-compare-baseline`
    alias (`node scripts/ci-compare-baseline.mjs`) so local
    invocations share the same entry point as CI.
  - **First-run bootstrap is intentional**: the workflow ships
    without a committed `tests/fixtures/baseline-runs/win11-chrome-
    us/baseline.json`. On the first `main` push (or manual
    `workflow_dispatch`) after this commit, the workflow runs to
    completion, uploads the candidate artifact, and exits 0 with a
    "baseline missing" markdown report. The maintainer downloads
    the candidate, runs `write-baseline`, and commits the result —
    a single short follow-up PR. From that PR onward, the gate is
    active. This avoids committing a baseline produced on a
    developer's local hardware (which would false-positive against
    the `ubuntu-latest` runner's Chromium build).
  - Smoke-tested locally against synthetic baseline + candidate
    JSON fixtures: clean pass (exit 0), regression detected (exit
    1, markdown report with added-hit detail), network-noise
    tolerated (1 site flip → exit 0, "tolerated network noise"
    header), missing baseline (exit 0 by default + exit 1 with
    `--require-baseline`), `write-baseline` mode (round-trip
    verifies stripped fields).

- **Phase 10.8 — baseline auto-refresh workflow + 3-run consensus**
  (this entry).
  - `scripts/refresh-baseline.mts` (~600 LOC) — the driver. Imports
    `runDetection` / `stripRunForBaseline` / `diffRuns` from
    `@runova/sdk` source (via `.mts` extension so tsx uses ESM
    resolution and matches `@runova/persona-schema`'s `exports.import`
    entry — the workspace root's `package.json` has no `"type"` field,
    so a plain `.ts` script would fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`
    on the persona-schema import). For each committed fixture persona,
    it: (1) imports the fixture into `~/.mosaiq/personas/` with
    `overwrite` conflict resolution, (2) runs `runDetection`
    sequentially N times (default 3, configurable via `--runs 1..9`),
    (3) strips each run via `stripRunForBaseline`, (4) computes a
    consensus DetectionRun, (5) diffs against the committed baseline
    via `diffRuns`, and (6) overwrites the committed baseline iff
    drift was detected. Supports `--check` mode (don't write, exit 1
    on drift), `--persona <id>` filter (repeatable), `--timeout`
    `--retries` per-site knobs. Exit codes: `0` = success / `1` =
    `--check` found drift / `2` = arg error or run failure or
    consensus structural disagreement.
  - **Multi-run consensus algorithm** (the riskiest piece, with full
    test coverage):
    - For each hit-identity (`surface` + `site` + `detector`):
      include in consensus if it appears in ≥ `ceil(N/2)` runs.
      Severity tie-broken toward higher (high > medium > low) —
      under-reporting severity is worse than over-reporting.
    - For each site result: `ok` = majority vote. Ties broken toward
      `false` (don't hide failures from the baseline; worst case is
      a transient failure baked in, caught next refresh cycle).
    - Other fields (`personaId`, `status`, `sitesAttempted`,
      `meta.sdkVersion`, `raw.persona`) must match across runs; if
      they don't, the script bails with exit 2 (signal of unexpected
      mid-run state corruption).
    - `weightedHits` / `hitsBySurface` are recomputed from the
      consensus hits (not summed across input runs — that'd be the
      wrong "mean of weighted sums" instead of "weighted sum of
      consensus").
  - `scripts/refresh-baseline.test.mts` (~250 LOC) — 10 pure unit
    tests covering consensus correctness without spawning Chromium.
    Hand-rolled tiny test runner (uses `node:assert/strict` directly;
    scripts/ isn't a workspace package so a root vitest config would
    be over-engineering for a single test file). Cases: identity for
    n=1, 3-of-3 agreement, 1-of-3 noise drop, 2-of-3 keep,
    site-flip voting, severity tie-break (low+high → high),
    weightedHits recompute correctness, structural disagreement
    (exits 2), `pickWorstSeverity` ordering, `compareHitForSort`
    diff-stable ordering. Refresh script exports the relevant
    helpers + gates `main()` behind an `isDirectInvocation` check
    (`import.meta.url === pathToFileURL(process.argv[1])`) so the
    test file can import them safely without spawning the run loop.
  - `.github/workflows/refresh-baseline.yml` (~210 LOC) — the cron
    + dispatch workflow. Triggers: weekly `cron '0 4 * * 0'`
    (Sundays 04:00 UTC — fires before Monday standup) +
    `workflow_dispatch` with `persona` and `runs` inputs. Steps:
    checkout (with `fetch-depth: 0` so `create-pull-request` can
    diff cleanly against an existing chore branch) → pnpm/node
    setup → install / build / playwright install (same as
    detection-lab.yml) → `pnpm tsx scripts/refresh-baseline.mts
    [args]` with output tee'd to `refresh-baseline.log` →
    `peter-evans/create-pull-request@v6` with branch
    `chore/refresh-baseline` (auto-update existing PR, delete-
    branch on merge), labels `ci`/`baseline`/`automated`, scoped
    `add-paths` to `tests/fixtures/baseline-runs/`. PR body
    documents the two common drift causes (external detector
    change vs internal regression that slipped past
    detection-lab.yml's tolerance) and reviewer checklist. Always
    uploads the run log + working-tree snapshot as artifact (30-
    day retention). Step summary surfaces "PR #N opened" or "no
    drift" status. Concurrency-locked. Permissions
    `contents:write` + `pull-requests:write` for the bot user.
    Timeout 60 min.
  - `.github/workflows/ci.yml`: added a new
    "Test — refresh-baseline consensus" step alongside the
    existing drift checks. Runs `pnpm test:refresh-baseline`
    (the 10 pure unit tests) on every PR so consensus regressions
    are caught at code-review time rather than waiting for the
    Sunday cron to silently write a bad baseline.
  - Root `package.json` gained two aliases:
    `refresh-baseline` (`tsx scripts/refresh-baseline.mts`) and
    `test:refresh-baseline` (`tsx scripts/refresh-baseline.test.mts`).
  - **Why a separate workflow from detection-lab.yml?** The two
    are intentionally orthogonal: detection-lab.yml **gates** PRs
    (must never auto-write the baseline, or every transient flake
    would self-heal and hide real regressions). refresh-
    baseline.yml **refreshes** the baseline behind a maintainer-
    review PR (the human is the final gate). Sharing infrastructure
    (build / playwright / fixture import) but not the failure
    semantics.

- **Phase 10.9 — sticky PR regression comment** (this entry).
  Closes the last v0.10 Track B gap: when `detection-lab.yml` fails
  on a PR, the reviewer no longer has to click into Actions → run →
  Summary tab to see what regressed. The full regression markdown
  (the same one written to `$GITHUB_STEP_SUMMARY`) is now posted as
  a sticky comment on the PR conversation, with a workflow-link
  footer pointing back to the artifact + reproduction commands.
  - `.github/workflows/detection-lab.yml`: added a `permissions:`
    block at workflow scope (`contents: read` + `pull-requests:
    write` — minimum scope for the bot to comment) plus two new
    steps appended after "Append to step summary":
    - **Decorate regression report for PR comment** —
      conditionally appends a `_Full diff in workflow run #N
      (link) — reproduce locally with: pnpm mosaiq detection-lab
      run <persona> + pnpm ci-compare-baseline compare …_` footer
      to `regression-<persona>.md`. The footer is added in the
      workflow (not in `ci-compare-baseline.mjs`) because the
      script doesn't know its caller's run URL.
    - **Comment on PR with regression diff** —
      `marocchino/sticky-pull-request-comment@v2` with
      `header: detection-lab-<persona>` (keyed per-matrix-entry so
      future multi-persona matrices each get their own sticky
      slot, no comment stomping) and `recreate: true` (re-push
      replaces the existing comment in-place rather than spawning
      a new one each commit).
    Both steps gated on `failure() && github.event_name ==
    'pull_request' && hashFiles(regression-<persona>.md) != ''`:
    - `failure()` — only post if the gate fired red, never on
      clean / tolerated-network-noise / bootstrap runs.
    - `github.event_name == 'pull_request'` — push:main / cron /
      workflow_dispatch have no PR conversation to comment on.
    - `hashFiles(...) != ''` — defense in depth: if
      `ci-compare-baseline.mjs` crashed with exit 2 (arg / file
      error) before writing the markdown, skip the comment rather
      than fail-cascade on a missing file.
  - **Why `marocchino/sticky-pull-request-comment@v2` over the
    spec's `peter-evans/create-or-update-comment@v4`:** the
    peter-evans action only edits when given a `comment-id` — so
    the "sticky / replace on re-push" behavior actually requires
    a `peter-evans/find-comment@v3` step before it, plus a unique
    HTML-comment marker in the body. marocchino bakes the same
    semantics into a single action keyed by `header`. Same author
    trust level, half the YAML, same end-user experience. The
    spec in `docs/V0.10-... §12.2` is treated as guidance, not
    contract.
  - Smoke-verified locally that `ci-compare-baseline.mjs
    --markdown-out` writes the expected 529-byte regression report
    on a synthetic regression scenario (1 new high-severity hit,
    weightedHits 0 → 3) and exits 1 — exactly what triggers
    `failure()` in the workflow.
  - **No changes to `ci-compare-baseline.mjs`** — the
    `--markdown-out` plumbing was already added in phase 10.7
    against this future use; phase 10.9 is workflow-only wiring.

## [0.10.0] — 2026-05-21

The **"v0.10 npm distribution + publish-readiness"** release. Takes the
v0.9 CLI parity work (which until now only existed inside the Mosaiq
monorepo) and ships it to npm: `@runova/persona-schema`, `@runova/sdk`,
and `@mosaiq/cli` are now publicly installable as
`npm i @mosaiq/<pkg>@0.10.0`. The 302-line `rebrowser-patches`
playwright-core patch — previously only applied during workspace
`pnpm install` via `pnpm.patchedDependencies` — is now shipped inside the
`@runova/sdk` tarball and applied to external consumers' `playwright-core`
via a `patch-package` `postinstall` hook. Version management switches from
hand-edited `chore(release):` commits to [changesets](https://github.com/changesets/changesets)
with a `fixed` lock-step group across the three publishable packages
(matching the v0.9 lock-step pattern, just automated).

All 4 packages bumped 0.9 → 0.10 in lock-step:

  - `@runova/persona-schema` 0.9.0 → 0.10.0 (no schema changes; release
    sync + npm metadata baseline)
  - `@runova/sdk` 0.9.0 → 0.10.0 (no API changes; npm metadata + the
    `patches/`+`postinstall.cjs` shipping mechanism; `SDK_VERSION`
    constant bumped to keep `DetectionRun.meta.sdkVersion` aligned)
  - `@mosaiq/cli` 0.9.0 → 0.10.0 (no CLI surface changes; `private: true`
    removed so the package can publish)
  - `@mosaiq/desktop` 0.9.0 → 0.10.0 (no behavior change; release sync
    only; desktop remains `private` and never publishes to npm)

This release **does not** ship the Detection Lab CI gate (Track B of the
v0.10 plan, phases 10.6-10.9). That track is now scheduled for v0.11 — the
plan document is in `docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md` and the
phases stay numbered 10.6-10.9 for historical clarity. See
[`docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md`](./docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md)
§10-12 for what's pending.

CI tightened in `5a81738` and `1e989eb`: two new drift gates run on every
PR + push to main —
[`scripts/check-sdk-patch-drift.mjs`](./scripts/check-sdk-patch-drift.mjs)
(byte-compare workspace-root `patches/` vs `packages/sdk/patches/`) and
[`scripts/audit-tarballs.mjs`](./scripts/audit-tarballs.mjs) (verify the
three publishable npm tarballs' file lists against per-package
REQUIRED/FORBIDDEN allow-lists).

### Added

- **Phase 10.1 — package metadata baseline + LICENSE + sdk README**
  (`commit dc4cac3`).
  - Three publishable packages (`@runova/persona-schema` / `@runova/sdk`
    / `@mosaiq/cli`) gained the metadata fields npm registry expects:
    `repository{type,url,directory}` (per-package monorepo path), `bugs`,
    `homepage` (GitHub README anchor), `keywords` (mosaiq / antidetect /
    fingerprint / playwright / automation / ...), `publishConfig {access:
    public, provenance: true}` (npm OIDC attestation badge), and
    `engines.node >=20.10.0` (aligned with workspace root).
  - `packages/<pkg>/LICENSE`: full Apache-2.0 license text (201 lines per
    package, "Copyright 2026 Mosaiq contributors"). Previously the
    package.json `files` field listed `LICENSE.md` but no such file
    physically existed inside any package directory; the npm tarball
    silently shipped without a license. Fixed.
  - `packages/sdk/README.md`: first-time creation (~270 lines). Covers
    5-min Quickstart, Detection Lab `runDetection` usage,
    `formatDetectionRunMarkdown` report shape, public API surface
    organized by area (browser launch / persona storage / portability /
    Detection Lab / Humanize / proxy / paths / persona-schema
    re-exports), Playwright + Stagehand integration recipe, and the
    explicit "known limitations" section that's been previously buried
    in `bench/PHASE-*-PLAN.md` (creepjs WebGL bold-fail math, TLS
    fingerprint gap, chromium-fork cold-storage status).
  - `packages/cli/package.json`: removed `"private": true` so npm
    publish can proceed; the v0.9 `private` flag was a placeholder while
    the CLI matured.
  - Root `package.json`: added `repository` field (parity with
    sub-packages) and confirmed `"private": true` is set (defensive
    guard against an accidental `pnpm publish` from the workspace root,
    which would otherwise publish a stub `mosaiq@0.1.0` placeholder).
  - **Pack dry-run sizes** (verified post-build): `@runova/persona-schema`
    40.0 kB packed / 184.6 kB unpacked / 63 files; `@runova/sdk` 187.5
    kB / 699.7 kB / 125 files; `@mosaiq/cli` 67.9 kB / 309.3 kB / 50
    files. `npm publish --dry-run` against `@runova/sdk` produces 0
    warnings (other than the expected "login required" notice).

- **Phase 10.2 — `patch-package` postinstall ships rebrowser-patches to
  npm consumers** (`commit 1e989eb`).
  - Solves the structural gap noted in the v0.10 plan §2.2: in v0.9, the
    302-line `rebrowser-patches` `playwright-core@1.59.1.patch` is
    applied only by `pnpm.patchedDependencies` during workspace install.
    External `npm i @runova/sdk` consumers receive an unpatched
    `playwright-core` — sannysoft / creepjs gain back the `webdriver`
    surface hit. v0.10 closes this.
  - `packages/sdk/patches/playwright-core@1.59.1.patch`: byte-identical
    copy of the workspace-root `patches/`. Two copies are necessary —
    workspace install (`pnpm.patchedDependencies`) reads the root copy,
    npm consumer install (sdk's `postinstall`) reads the sdk copy. A
    drift check (see below) locks them in sync.
  - `packages/sdk/scripts/postinstall.cjs` (~150 LOC): the patch
    applicator. Detects whether the SDK is installed inside the Mosaiq
    monorepo (no `node_modules` in our resolved path → exit 0,
    `pnpm.patchedDependencies` already handles patching) or inside an
    external consumer's `node_modules/@runova/sdk/`. In the latter case
    it walks up to find the consumer project root (closest ancestor
    `node_modules`'s parent), verifies `playwright-core` exists and is
    exactly version `1.59.1` (refuses to patch other versions —
    fail-loud rather than corrupt a different release), resolves
    `patch-package`'s bin via `require.resolve('patch-package/
    package.json')`, then `spawnSync` invokes it with `--patch-dir`
    pointing back to our shipped `patches/`. **Never exits non-zero** —
    a failed patch warns on stderr but does not break the consumer's
    `npm install`. Escape hatches: `MOSAIQ_SDK_SKIP_POSTINSTALL=1` env
    var, or `npm install --ignore-scripts` (npm's own escape).
  - `packages/sdk/package.json`: `patch-package` added as a regular
    `dependency` (must be at install time, not devDep); `postinstall`
    script entry added; `files` field extended to ship
    `patches/`+`scripts/` in the tarball.
  - `scripts/check-sdk-patch-drift.mjs` (~70 LOC): byte-level drift gate
    between the workspace-root `patches/` and `packages/sdk/patches/`.
    LF-normalized so Windows checkouts (CRLF) don't false-positive.
    Fails CI with explicit `cp <source> <dest>` instructions if drift
    is detected. Wired into the existing `ci.yml` next to the Phase 7.0
    captured-WebGL-profiles drift check (same place reviewers already
    look for these guards).
  - **Trade-off accepted**: `patch-package@^8.0.0` pulls ~18 transitive
    dependencies (chalk / fs-extra / cross-spawn / semver / ...) adding
    ~5 MB to SDK installed size. Acceptable next to the ~30 MB
    playwright-core install the SDK already requires. Alternative
    "vendored fork `@mosaiq/playwright-core`" approach evaluated and
    deferred (see v0.10 plan §5.1 decision matrix; maintenance cost on
    every Playwright release outweighs the install-size win).

- **Phase 10.3 — `prepublishOnly` hooks + tarball audit gate**
  (`commit 5a81738`).
  - Three publishable packages gained `prepublishOnly` scripts:
    `pnpm run clean && pnpm run build && pnpm run typecheck`. Belt-and-
    suspenders against a stale `dist/` shipping to npm even if someone
    bypasses `release.yml` and runs `pnpm publish` from a local shell.
  - `scripts/audit-tarballs.mjs` (~165 LOC): publish gate. For each of
    the three publishable packages, spawns `npm pack --dry-run --json`,
    parses the file list, and asserts (a) all REQUIRED files are
    present (package.json / README.md / LICENSE / `dist/index.{js,d.ts}`
    / sdk's `patches/`+`scripts/postinstall.cjs` / cli's `bin/mosaiq.js`)
    and (b) no FORBIDDEN substring appears in any file path (`bench/`
    / `src/` / `*.test.*` / `chromium-fork` / `captured-profiles` /
    `node_modules` / `tsconfig.json` / `vitest.config`). Fails CI with
    a per-violation list and exit 1 if any assertion breaks. Adding
    "bench" to the SDK `files` field in a failure-mode test reproduced
    18 violations (13 bench result PNGs / HTMLs / JSON + 1 test file
    + 4 bench scripts), confirming the audit catches the regressions
    it's designed to catch.
  - Wired into the existing `ci.yml` next to the drift checks; also
    duplicated into `release.yml` so the release path doesn't depend
    on a successful PR CI pass.

- **Phase 10.4 — changesets lock-step + `release.yml`**
  (`commit e5e1a28`).
  - `@changesets/cli@^2.31.0` added to root devDependencies. Version
    management switches from hand-edited `chore(release):` commits to
    automated changesets PRs.
  - `.changeset/config.json`: `"fixed":
    [["@runova/persona-schema","@runova/sdk","@mosaiq/cli"]]` — the
    three publishable packages bump in lock-step. Touching any one
    via `pnpm changeset` triggers all three to bump together (matches
    the v0.9 manual `chore(release): v0.9.0` pattern in commit
    `dd2b3e8`). `"ignore": ["@mosaiq/desktop"]` — Electron app, never
    on npm. `"changelog": false` — disable changesets'
    auto-CHANGELOG.md generation; we keep `CHANGELOG.md` hand-written
    in Chinese per the v0.1-v0.9 style (auto-generated English
    PR-link format would clash). `"access": "public"` /
    `"updateInternalDependencies": "patch"` /
    `"baseBranch": "main"` for the remaining baseline.
  - `.changeset/README.md` (~110 lines): contributor docs covering the
    `pnpm changeset` ↔ release PR ↔ npm publish loop, the
    hand-written-CHANGELOG rule, and the "v0.10.0 first publish is
    manual" caveat (no changesets accumulated when v0.10 ships, so
    the first publish bypasses the auto-PR path).
  - `.github/workflows/release.yml` (~80 lines): the release CI job.
    On push to `main`, runs the same drift + audit gates as `ci.yml`,
    then `changesets/action@v1` — either opens a `chore(release):
    version packages` PR or, if pending changesets are absent (the
    PR just merged), runs `pnpm changeset publish` to push to npm.
    Permissions include `id-token: write` for npm OIDC provenance
    attestation; `NPM_CONFIG_PROVENANCE=true` makes the published
    packages show "verified provenance" on their npmjs.com page.
    Concurrency-locked to prevent parallel publishes that could clash
    on version numbers.
  - **Lock-step verified**: dry-run added a `.changeset/*.md` for
    `@runova/sdk: minor`; `pnpm changeset status` reported all three
    publishable packages (sdk + cli + persona-schema) scheduled to
    bump together. `pnpm changeset version --snapshot test` confirmed
    desktop did **not** bump (the `ignore` config works). Test
    changeset and snapshot version edits then reverted.

- **Phase 10.5 — release readiness** (this entry).
  - All 4 package.json versions bumped 0.9.0 → 0.10.0 in lock-step.
  - `packages/sdk/src/version.ts`: `SDK_VERSION` bumped to `'0.10.0'`
    to keep `DetectionRun.meta.sdkVersion` aligned with the actual SDK
    version (verified by the existing `version.test.ts` package-json-
    sync test from v0.8 phase 8.5).
  - `README.md` + `QUICKSTART.md`: updated "current milestone" banners
    + status table to reflect 0.10.0 lock-step; added a new "npm
    install path" section as the first 5-minute path for end users
    (alongside the existing monorepo `pnpm install` path for
    contributors). The "下一步行动" / "v0.10 候选" lists from v0.9 are
    rewritten to reflect what's now shipped vs. what's deferred to
    v0.11 (Track B Detection Lab CI gate; real-hardware capture v2;
    public leaderboard).

### Changed

- `pnpm-lock.yaml`: +537 lines for `@changesets/cli` transitive deps
  in phase 10.4, +18 deps for `patch-package` in phase 10.2.
- `.github/workflows/ci.yml`: two new steps — `check-sdk-patch-drift`
  (10.2) and `audit-tarballs` (10.3) — gating every PR + push to main.

### Notes

- **NPM org reservation is a manual step**. Before publishing 0.10.0,
  the maintainer must create the `@mosaiq` organization at
  <https://www.npmjs.com/org/create> and add a granular automation token
  with publish scope to the GitHub repo's `NPM_TOKEN` secret. Both are
  one-time prerequisites — `release.yml` then handles all subsequent
  releases automatically. The 0.10.0 first publish itself is currently
  scheduled to happen manually from a maintainer's shell with
  `NPM_TOKEN` set; see `.changeset/README.md` "v0.10.0 first publish".
- **Once 0.10.0 is on npm, the smoke test** (per the v0.10 plan §16
  release gate definition) is: `mkdir /tmp/smoke && cd /tmp/smoke &&
  npm init -y && npm i -g @mosaiq/cli@0.10.0 && npx playwright install
  chromium && mosaiq personas templates list` — must complete with the
  4-template table printed. If this fails on any of macOS / Linux /
  Windows on Node 20+, the failure becomes a 0.10.1 patch.

## [0.9.0] — 2026-05-20

The **"v0.9 CLI + Detection Lab polish"** release. Pairs the existing
desktop Detection Lab (v0.8.0) with a new headless `@mosaiq/cli` workflow,
adds CI-friendly run comparison gates (single-persona `compare` +
multi-persona `run-all`), ships full persona CRUD from the terminal, and
enriches the desktop UI with screenshot thumbnails, lightbox, persona pool
comparison, in-app markdown export, and a side-by-side Compare Runs page.

All 4 packages bumped 0.8 → 0.9 in lock-step:

  - `@runova/persona-schema` 0.8.0 → 0.9.0 (no schema changes; release sync)
  - `@runova/sdk` 0.8.0 → 0.9.0 (additive API: `formatDetectionRunMarkdown`
    / `FormatMarkdownOptions` from phase 9.6; `diffRuns` / `RunDiff` /
    `RunSnapshot` / `ChangedHit` hoisted from CLI in phase 9.8 — both are
    pure data projections, zero behavior change for existing exports)
  - `@mosaiq/desktop` 0.9.0-dev.0 → 0.9.0
  - `@mosaiq/cli` 0.9.0-dev.0 → 0.9.0 (first stable release of the package
    introduced in phase 9.1)

CI tightened in `e1f8bd0`: CLI vitest (64 cases) and desktop vitest
(45 cases) now run on every PR + push to main alongside the existing
sdk + persona-schema test surface.

### Added

- **Phase 9.1 — `@mosaiq/cli` package with `detection-lab run` + `personas list`**
  (`commit b82700d`).
  - New workspace package `packages/cli`. Single binary entry
    `mosaiq` via `bin: { mosaiq: "./bin/mosaiq.js" }` (the
    `bin/mosaiq.js` shim spawns `dist/cli.js`) shipped under
    `Apache-2.0`.
  - Subcommand `mosaiq detection-lab run <persona-id> [--headed]
    [--only <ids>] [--skip <ids>] [--retries <n>] [--timeout <ms>]
    [--template <name>] [--json] [--quiet]
    [--fail-on-hits none|any|medium|high]`: thin wrapper over
    `runDetection` from `@runova/sdk`. Streams the same
    `RunProgressEvent` phases the desktop renderer consumes (init /
    site-start / site-retry / site-end / done / canceled / error),
    prints a TTY-aware progress bar by default, `--quiet` collapses
    per-site lines but still emits the final summary, `--json` swaps
    the human summary for the full `DetectionRun` JSON. SIGINT
    triggers a cooperative `AbortController` (second Ctrl-C
    force-quits with code 130). Saves to the same
    `~/.mosaiq/detection-runs/` store the desktop reads, so a CLI
    run shows up in the dashboard immediately.
  - Subcommand `mosaiq personas list [--json]`: reads
    `~/.mosaiq/personas/` via `listPersonas` from `@runova/sdk`
    and pretty-prints an `ID / DISPLAY NAME / TEMPLATE / UPDATED`
    table. The `TEMPLATE` column is recovered from the convention
    `tags: ['template:<id>', ...]` (same rule the desktop main
    uses). `--json` emits the raw `Persona[]` array for piping
    into `jq`.
  - `packages/cli/src/output.ts` (99 LOC): tiny color/box/table helper
    so the CLI doesn't pull in `chalk`/`cli-table3` dependencies.
- **Phase 9.2 — `detection-lab list-runs` / `show-run` / `delete-run`**
  (`commit 693a7d3`).
  - `mosaiq detection-lab list-runs <persona-id> [--json]`: lists
    every saved run for the persona, sorted by `startedAt` desc,
    with status-colored badges and a weighted-hits column. `--json`
    emits the raw `DetectionRunSummary[]` array.
  - `mosaiq detection-lab show-run <persona-id> <run-id> [--json]`:
    full `printRunSummary` — header / hits-by-surface bar chart /
    per-site grid / top hits sorted by severity*weight.
  - `mosaiq detection-lab delete-run <persona-id> <run-id> [--yes]`:
    confirms before unlink unless `--yes`. Removes the artifact dir
    too (mirrors the desktop "delete run" button).
- **Phase 9.2b — `detection-lab compare` with regression gate**
  (`commit 4b4b272`).
  - `mosaiq detection-lab compare <persona-id> <run-a> <run-b>
    [--fail-on-regression] [--json]`: side-by-side `weightedHits`,
    `sitesOk/sitesAttempted`, per-surface delta, top hits added /
    removed. With `--fail-on-regression` the process exits 1 when
    run-b regresses vs run-a (added hits, OR ΔweightedHits > 0, OR
    any site flips ok→fail), making it a one-line CI gate against
    persona detection-profile drift. Exit codes: `0` = equivalent
    or B better, `1` = regression detected, `2` = run not found /
    arg error.
  - The compare summary mirrors the desktop's `RunsTrendChart` story
    (downward = improvement) so docs / mental models stay aligned.
- **Phase 9.3 — Screenshot thumbnails on `SiteResultCard`**
  (`commit b28a65b`).
  - Custom `mosaiq-artifact://` Electron protocol scheme registered
    in `apps/desktop/electron/artifact-protocol.ts`. Resolver
    accepts `mosaiq-artifact://detection-run/<personaId>/<runId>/<file>`
    and serves the matching file from the run's artifact dir under
    `~/.mosaiq/detection-runs/<personaId>/<runId>/`.
  - Hardened against path traversal: scheme + segment-count guard,
    persona-id / run-id syntax allowlist, literal `..` reject, URL-
    decoded `..` reject, null-byte reject, extension allowlist
    (`.png` / `.jpg` / `.jpeg` / `.html`), final realpath containment
    check inside the artifact root.
  - `apps/desktop/src/lib/artifact-url.ts`: pure URL builder (encodes
    Windows backslashes to forward slashes, percent-encodes special
    chars). `SiteResultCard` renders a 96px-wide thumbnail when a
    `screenshot` artifact path is present, with hover-zoom +
    click-to-open intent.
- **Phase 9.3 polish — Lightbox + unit tests** (`commit 5c3de19`).
  - In-app lightbox using a native `<dialog>` element (Esc-to-close,
    backdrop-click-to-close, focus trap free via `showModal()`).
    Replaces the previous "open in new window" intent with a proper
    in-app overlay so the desktop window keeps focus.
  - Pure helpers split out: `electron/artifact-protocol-core.ts`
    (138 LOC, no Electron import) so the resolver can be unit-tested
    with vitest in renderer-style. 33 cases for `resolveArtifactPath`
    (scheme / segment / id syntax / traversal / containment / DI),
    12 cases for `buildArtifactUrl` (encoding / Windows backslash /
    runId timestamp shapes). `vitest@^2.1.2` added to the desktop
    workspace; `tsconfig.json` excludes `**/*.test.ts`.
- **Phase 9.4 — Persona pool comparison page** (`commit 49ecdd2`).
  - New desktop page `PersonaPoolPage` (`apps/desktop/src/pages/
    PersonaPoolPage.tsx`, 511 LOC). Lets the user pick 2-8 personas
    and renders side-by-side: header strip with status / score
    summary per persona, multi-polygon `HitsBySurface` radar with
    one polygon per persona (8-color palette, recharts legend
    toggles per persona), per-surface heat-map table with weighted-
    hits totals per persona.
  - New components `PoolRadarChart` (multi-polygon recharts radar
    sharing the 12-surface axes from the v0.8 single-run radar) and
    `PoolSurfaceTable` (heat-mapped cells, color dots in column
    headers match the radar palette).
  - Persona list header gains a `BarChart3`-icon "对比池" button
    next to "导入" / "新建", disabled until persona count ≥ 2.
  - No SDK / IPC changes — the page composes existing
    `detectionLabListRuns` (latest summary) + `detectionLabGetRun`
    (full score) for each selected persona.
- **Phase 9.5 — Persona CRUD CLI** (this entry).
  - `mosaiq personas templates list [--json]`: prints the
    `TEMPLATE_CATALOG` from `@runova/persona-schema/templates` (the
    same data desktop's "新建 Persona" page renders as cards). Acts
    as the discovery surface for `--template` ids before calling
    `personas create`. `--json` emits `{ id, displayName,
    description }[]` (omits the non-serializable `create` fn).
  - `mosaiq personas show <persona-id> [--json]`: pretty-prints
    identity / system / browser / hardware / fingerprint signature
    (canvas / webgl / audio noise seeds + font count + webrtc mode)
    / network (proxy with password redacted as `***`). `--json`
    emits the full `Persona` blob — same shape that's on disk, so
    desktop and CLI agree byte-for-byte.
  - `mosaiq personas create <persona-id> --template <id>
    --display-name <name> [--tags <a,b,c>] [--notes <text>]
    [--timezone <iana>] [--proxy <url>] [--proxy-label <label>]
    [--master-seed <hex>] [--json]`: thin wrapper around
    `TEMPLATE_CATALOG[t].create(...)` + `savePersona`. Mirrors the
    desktop create form 1:1. PersonaId regex validated up-front;
    duplicate-id detected via `personaExists` and surfaced as
    `exit 2`. `--proxy <url>` parses `<protocol>://[user[:pass]@]
    host:port` (http / https / socks5; URL-encoded credentials
    auto-decoded). `template:<id>` tag is auto-appended to the
    user's tags so `personas list` / `show` can round-trip the
    template id (legacy desktop-created personas without this tag
    still resolve via bare-tag fallback in
    `template-tag.ts:extractTemplateTag`).
  - `mosaiq personas delete <persona-id> [--yes | -y]`: interactive
    confirmation by default (1-line preview → `(y/N)` prompt; same
    pattern as `detection-lab delete-run`). Non-TTY without `--yes`
    is rejected with `exit 2` to keep piped invocations from
    silently deleting. Removes only the `<id>.json` file —
    `~/.mosaiq/profiles/<id>/` (chromium user-data-dir) and
    `~/.mosaiq/detection-runs/<id>/` (run history) are intentionally
    preserved, mirroring desktop's delete button behavior.
  - Top-level `mosaiq <command>` routing supports the new 3-segment
    form `mosaiq personas templates list` (router special-cases
    `top=personas, sub=templates` and dispatches on the next
    positional). Existing 2-segment commands (`personas list`,
    `personas show`, etc.) unchanged.
  - 4 new commands + 2 helpers in `packages/cli/src/commands/personas/`:
    - `proxy-url.ts` (~125 LOC): WHATWG `URL`-based parser with a
      regex fallback that recovers explicit default ports
      (`http://h:80`, `https://h:443` — WHATWG URL elides these
      from `url.port`, naive checks would mis-flag as "missing").
      21 vitest cases (happy paths, scheme rejection, port edges,
      path / query / fragment rejection, encoded credentials).
    - `template-tag.ts` (~45 LOC): canonical `template:<id>` ↔
      Persona conversion. `extractTemplateTag` checks
      CLI-prefix-style first, then bare-tag fallback for desktop-
      created personas. `makeTemplateTag` is the inverse.
      8 vitest cases.
  - `packages/cli/src/commands/personas/list.ts` and `show.ts` were
    de-duplicated to share the `extractTemplateTag` helper from
    `template-tag.ts` (deleted the inline copies). No behavior
    change — same prefix-then-bare resolution rule.
  - **CLI vitest:** 0 → 29 (first cli-package test files; SDK / desktop
    test counts unchanged). Workspace-wide typecheck stays clean.
- **Phase 9.5b — `personas update` + `clone`** (this entry).
  - `mosaiq personas update <id> [--display-name <n>] [--tags <a,b,c>]
    [--notes <t>] [--timezone <iana>] [--proxy <url> | --no-proxy]
    [--proxy-label <l>] [--json]`: thin wrapper around SDK
    `updatePersona(id, PersonaPatch)`. Patches the **soft** fields
    (display name / tags / notes / timezone / proxy); hardware
    fingerprint, OS, and browser version are intentionally locked
    (use `personas clone` for a different baseline). Mutual
    exclusion `--proxy` / `--no-proxy` enforced; empty patch (no
    flags) rejected with `exit 2` to avoid silent no-ops. Re-using
    the proxy URL parser from 9.5 means the same encoded-credential
    rules apply.
  - `mosaiq personas clone <source-id> <new-id> --display-name <n>
    [--tags <a,b,c>] [--notes <t>] [--timezone <iana>]
    [--proxy <url> | --no-proxy] [--proxy-label <l>]
    [--master-seed <hex>] [--json]`: thin wrapper around SDK
    `clonePersona(sourceId, CloneOptions)`. Source baseline is
    copied; canvas / webgl / audio noise seeds are re-derived from
    a fresh master seed (or `--master-seed <hex>` for reproducible
    fixtures, identical to the equivalent flag on `create`). Pre-
    flight checks `personaExists` for both source (must exist) and
    `new-id` (must not), surfacing clearer "Source not found" /
    "Target already exists" messages than the SDK's raw throw.
- **Phase 9.5c — `personas export` + `import`** (this entry).
  - `mosaiq personas export <id> [--out <file>] [--include-secrets]`:
    wraps SDK `exportPersonaJson` / `serializePersona`. Default
    redacts `proxy.password` to keep credentials out of shared
    exports and git history; `--include-secrets` opts into raw
    export with a stderr `⚠` warning. With `--out` writes to a file;
    without, streams to stdout (pipe-friendly: TTY detection adds a
    trailing newline only when stdout is a terminal so `> file.json`
    yields strict JSON).
  - `mosaiq personas import <file> [--on-conflict
    error|rename|overwrite] [--json]`: wraps SDK `importPersonaJson`.
    Reads from a file path, or from stdin if the positional is `-`
    (so `cat foo.json | mosaiq personas import -` works on Windows
    too — `fs.readFileSync('-')` doesn't, hence the explicit stream
    helper). Schema validated against `PERSONA_SCHEMA_VERSION = 1`;
    `--on-conflict` strategies match SDK semantics 1:1 (error /
    rename / overwrite). When a stripped-secret import surfaces a
    proxy with username but no password, the human summary
    highlights it with a yellow note suggesting
    `personas update --proxy …` to restore the password before
    launch.
  - 4 new commands in `packages/cli/src/commands/personas/`:
    `update.ts` (~250 LOC), `clone.ts` (~250 LOC), `export.ts`
    (~120 LOC), `import.ts` (~190 LOC). Help text + flag tables
    documented in `packages/cli/README.md`.
  - Top-level `mosaiq <command>` USAGE block listing the now-9
    `personas <subcommand>` entries (was 5 in 9.5, plus
    `templates list`). Router is still flat per-pair pattern-match.
  - **Tests / typecheck:** 4-package workspace typecheck stays
    clean; CLI vitest count unchanged at 29 (these are integration
    commands that compose existing SDK functions; no new pure logic
    that warrants its own test file beyond what proxy-url /
    template-tag already cover). Manual smoke run validates 13
    scenarios end-to-end (create + update display-name + update
    --no-proxy + nothing-to-update reject + --proxy/--no-proxy
    mutual exclusion + clone basic + clone seed reproducibility +
    clone source-not-found + clone id-conflict + export stdout +
    export file + import file + import stdin + import on-conflict
    error/rename/overwrite + import bad JSON + import missing
    file + import bad --on-conflict).
- **Phase 9.6 — `detection-lab export-run` + pure markdown formatter**
  (this entry).
  - `mosaiq detection-lab export-run <persona-id> <run-id>
    [--format md|json] [--out <file>] [--no-site-details] [--no-hits]
    [--no-meta]`: renders a saved `DetectionRun` as a shareable report.
    Default `--format md` is **GitHub Flavored Markdown** — suitable
    for pasting into PR / Issue comments, Slack snippets, or Notion;
    `--format json` emits the full DetectionRun JSON (byte-identical
    to `show-run --json`, so `diff <(show-run --json) <(export-run
    --format json)` is empty by design — the symmetric branch exists
    so users only have to memorize one command + a `--format` toggle).
    `--out <file>` writes to disk (with a green `✓ Exported run …`
    confirmation on stdout); without it the report streams to stdout
    for `> report.md` / `| pbcopy` / `| clip` style use. The three
    `--no-*` flags skip the per-site results table / per-severity
    hits drill-down / environment line respectively, for smaller chat-
    snippet excerpts; they're ignored under `--format json`.
    Exits `2` on missing arg / unknown persona or run / bad
    `--format` value / failed `--out` write.
  - New SDK module `packages/sdk/src/detection-lab/run-format.ts`
    (~310 LOC): `formatDetectionRunMarkdown(run: DetectionRun,
    options?: FormatMarkdownOptions): string` — pure projection, no
    I/O. GFM pipe-tables only (no external template engine; no HTML /
    PDF / shareable URL — those are out-of-scope for 9.6). Output is
    structured into Title / Header / Error (only for failed runs) /
    Summary (metric table + non-zero surface matrix) / Hits (grouped
    high → medium → low with escaped detector + evidence) / Per-site
    results / Footer. `options.headingLevel` (1/2/3) shifts every
    `#` in the report so it can be embedded into a larger Markdown
    document without breaking the outer TOC depth. Re-exported from
    both `@runova/sdk/detection-lab` and the package root.
  - **Tests:** 20 new vitest cases in
    `packages/sdk/src/detection-lab/run-format.test.ts` (clean runs,
    failed / canceled runs, surface matrix, severity ordering,
    markdown escaping for `*` / backtick / pipe, environment-line
    composition with / without chromium + template, `--no-*` flag
    semantics, heading-level offset, duration formatting edges).
    SDK vitest: 544 → 564 tests, all passing. CLI vitest count
    unchanged at 29. Workspace typecheck stays clean.
  - Manual smoke matrix run against a real saved baseline
    (`baseline-bench-mp6uss3k` / `2026-05-18T13-49-09-107Z`):
    md to stdout / md to `--out file` / `--no-site-details --no-hits
    --no-meta` lean variant / `--format json` (verified
    byte-identical to `show-run --json` via `diff <(…) <(…)`) /
    missing positionals / unknown run / unknown `--format html` /
    failing `--out` to a non-existent directory — all 8 paths
    behave as documented.
- **Phase 9.7 — Desktop "Export Markdown" button on run-detail page**
  (this entry).
  - Adds a `导出 .md` button next to `刷新` / `删除` in the header of
    `DetectionRunDetailPage` (`apps/desktop/src/pages/
    DetectionRunDetailPage.tsx`). One click opens a native save
    dialog (default filename `<personaId>-<runId>.md`), then writes
    the same GitHub Flavored Markdown report 9.6's CLI
    `detection-lab export-run` produces. Closes the CLI/desktop
    parity loop the 9.6 CHANGELOG hinted at.
  - New IPC channel `mosaiq:detectionLab:exportRunMarkdown`
    (`MosaiqApi.detectionLabExportRunMarkdown(personaId, runId,
    opts?)`). Three-state result mirroring `exportPersona` 1:1:
    `{ok:true, savedTo}` / `{ok:false, canceled:true}` /
    `{ok:false, error}`. `opts: ExportRunMarkdownOptions` exposes
    the same `includeSiteDetails` / `includeHits` / `includeMeta`
    knobs as the CLI's `--no-*` flags — the v0.9 desktop UI ships
    one-click-with-defaults but the channel contract has the
    toggles reserved so a future "Export options…" sub-menu won't
    break the protocol.
  - **Architecture decision:** the formatter call lives in the
    **main process**, not the renderer. Reason: the renderer
    cannot do a runtime `import { ... } from '@runova/sdk'` (Vite
    dep-optimization follows the SDK barrel into
    `playwright-core/bidi/...` → unresolvable in a browser bundle;
    documented as a "gotcha" in the 9.4 entry below). Main is a
    Node context, already imports SDK, so the chain
    `loadDetectionRun → formatDetectionRunMarkdown → writeFileSync`
    runs there and just hands the result back over IPC. Renderer
    holds only type-only imports (`ExportRunMarkdownOptions`,
    `ExportRunMarkdownResult`), which tsc erases.
  - Renderer wires up: a single `Download` lucide icon button with
    a `Loader2` spinner during the IPC round-trip, `disabled`
    while loading / deleting / already-exporting, toast feedback
    on completion (`已导出 → <path>` on ok, `导出失败：<msg>` on
    error, silent on user-canceled). Failure of the underlying
    `loadDetectionRun` (e.g. the run JSON was deleted between
    page-load and click) surfaces as a toast error rather than an
    unhandled rejection.
  - **Validation:** workspace typecheck clean (4 packages); desktop
    vitest 45/45 unchanged (this change is integration plumbing
    composing the 9.6 SDK formatter — no new pure logic that
    warrants its own test file; the formatter is already covered
    by `run-format.test.ts`); biome lint clean on the 4 changed
    files (the 2 pre-existing diagnostics in
    `DetectionRunDetailPage.tsx` predate this commit on `main`).
    Desktop production build (`pnpm --filter @mosaiq/desktop
    build`) succeeds — proving the new code didn't accidentally
    pull SDK runtime into the renderer bundle (Vite would have
    crashed in dep-optimization). End-to-end smoke: a tsx harness
    that replicates the IPC handler's `loadDetectionRun →
    formatDetectionRunMarkdown → writeFileSync` chain produces
    byte-identical output to `mosaiq detection-lab export-run
    --out <file>` against the same `(personaId, runId)` pair
    (validated with `diff` against `baseline-bench-mp6uss3k /
    2026-05-18T13-49-09-107Z`, exit 0).
- **Phase 9.8 — Hoist `diffRuns` + `RunDiff` types from CLI to SDK
  (refactor + tests)** (this entry).
  - Pure refactor (no user-facing behavior change). The 75-LOC
    `diffRuns(personaId, a, b): RunDiff` function and its supporting
    types (`RunDiff`, `RunSnapshot`, `ChangedHit`) — originally
    shipped in 9.2b as inline CLI code at
    `packages/cli/src/commands/detection-lab/compare.ts` — are
    lifted to a new pure SDK module
    `packages/sdk/src/detection-lab/run-compare.ts` (~230 LOC with
    docs). The function uses only `DetectionRun` / `SurfaceHit`
    types already in the SDK, so this is just landing it at the
    right architectural layer.
  - Motivation: matches the 9.6 pattern of "pure SDK projection +
    thin CLI / desktop consumers" — symmetric with
    `formatDetectionRunMarkdown` (run → markdown). The hoist also
    closes a real test-coverage gap — `diffRuns` had **zero**
    direct tests before this commit (it was only smoke-verified
    against real saved runs during 9.2b development). 29 new
    vitest cases added in `run-compare.test.ts`: snapshot
    projection (3), hit identity matching incl. severity / evidence
    churn (9), delta math (2), site flips (4), site list
    discrepancies (3), `hasRegression` policy (5), failed /
    canceled runs (3).
  - New SDK exports (`@runova/sdk` + `@runova/sdk/detection-lab`):
    `diffRuns`, and types `RunDiff`, `RunSnapshot`, `ChangedHit`.
  - CLI `compare.ts` shrinks from 422 → 268 lines (-154 net, -180
    deleted from the pure-logic section). The remaining code is
    just argv parsing + the colored pretty-printer
    (`printDiff` / `printSnapshot` / `formatDelta` / `printHitLine`
    / `printChangedHit`) which stay CLI-local. The SDK import
    swaps four type imports + `diffRuns` for the deleted inline
    versions; a comment block records the 9.8 hoist for future
    readers.
  - Foundation for a future desktop "Compare Runs" page (9.9+):
    the renderer can consume `RunDiff` over IPC as a structured-
    clone-safe POJO, and the desktop main process can call
    `diffRuns(personaId, runA, runB)` the same way the CLI does
    today — no re-implementation needed.
  - **Validation:** workspace typecheck clean (4 packages, SDK
    rebuilt to refresh `dist/index.d.ts` after adding the new
    exports — needed for `@mosaiq/cli` to resolve the new names).
    SDK vitest: 564 → **593** (+29 in `run-compare.test.ts`); CLI
    vitest: **29** unchanged. Biome lint clean on all 5 changed
    files (CRLF→LF auto-fix applied to the two new SDK files,
    same as 9.6). **Byte-identity smoke:** captured `mosaiq
    detection-lab compare baseline-bench-mp6uss3k
    2026-05-18T13-44-26-599Z 2026-05-18T13-49-09-107Z` text and
    `--json` output pre-refactor → ran the same two invocations
    post-refactor → `diff` exit 0 on both pairs. Exit-code
    smoke: `--fail-on-regression` returns 0 on equivalent runs
    (correct: B not regressing); unknown run id returns 2
    (correct: arg/load error).
- **Phase 9.9 — Desktop "Compare Runs" page** (this entry).
  - New desktop page `DetectionRunComparePage`
    (`apps/desktop/src/pages/DetectionRunComparePage.tsx`, ~520 LOC).
    Lets the user pick two saved runs of the same persona via
    side-by-side `<select>` dropdowns and renders the SDK
    `RunDiff` (9.8 hoist) as: A/B snapshot cards (status / duration
    / sites OK·FAIL / hits / weighted), Δ headline (4 cells
    weightedHits / hits / Δsites OK / Δsites FAIL with green-down /
    red-up coloring), site flips section (`✗ ok→fail` red codes,
    `✓ fail→ok` green codes), site-list discrepancy warning
    (only-in-A / only-in-B for runs that used different `--only`
    filters), Removed / Added / Changed hits sections (using the
    existing `SurfaceHitBadge` component), and a verdict footer
    (regression / improvement / no material change). Layout order
    matches the 9.2b CLI `printDiff` output 1:1 so the two
    surfaces stay mentally aligned.
  - **Default selection:** A = second-newest run, B = newest run
    (list sorted `startedAt` desc). Matches the 9.2b CLI
    convention "A = baseline / older / reference, B = candidate /
    newer / under test" so Δ = B − A answers "did my latest run
    regress vs the previous one?" — the most common manual /
    CI question. A "交换 A/B" button is included for the cases
    where the user wants to flip baseline and candidate without
    re-picking from scratch.
  - **Auto-recompute:** changing either selector fires a fresh
    `detectionLabCompareRuns` IPC; while the round-trip is in
    flight the previous diff stays rendered (avoids flicker), and
    a small "对比中…" spinner sits between the picker cards.
  - New IPC channel `mosaiq:detectionLab:compareRuns`
    (`MosaiqApi.detectionLabCompareRuns(personaId, runIdA,
    runIdB): Promise<RunDiff>`). Unlike 9.7's three-state
    `{ok, canceled, error}` envelope (which fits a save-dialog
    flow), this one throws on either-run-load failure → IPC
    rejects → renderer's `try/catch` surfaces a toast + retry
    button. Reason: a compare-page error is page-fatal (the page
    has nothing to render); a save-dialog error is sidecar
    (the page itself still works).
  - **Architecture:** identical to 9.7 — the `loadDetectionRun
    + loadDetectionRun + diffRuns` chain runs in **main**
    (Node), not the renderer (browser-target Vite). Renderer
    holds `import type { RunDiff }` only, which tsc erases.
    Re-uses 9.7's documented gotcha about not pulling SDK runtime
    into the renderer bundle.
  - Entry point: a new "对比 Runs" button on `DetectionLabPage`'s
    header (`<ArrowRightLeft>` icon, between "刷新" and the
    Run/Cancel toggle), `disabled` while `runs.length < 2` with
    a tooltip explaining why. App.tsx adds a 7th `Page` kind
    `detectionCompare` and threads `onOpenCompare` through to the
    lab page (back-nav: compare → lab → list, mirroring the
    detail-page chain).
  - **Validation:** workspace typecheck clean (4 packages); desktop
    vitest 45/45 unchanged (this change is integration plumbing
    composing the 9.8 SDK `diffRuns` — `run-compare.test.ts` has
    29 cases covering the pure logic, no new test file needed in
    desktop, matching the 9.7 precedent); biome lint clean on the
    6 changed files. Desktop production build (`pnpm --filter
    @mosaiq/desktop build`) succeeds — 2309 renderer modules
    transformed with no Vite dep-optimization complaints, proving
    the new code didn't accidentally pull SDK runtime into the
    renderer bundle.
  - **Byte-identity smoke:** the IPC handler's chain
    (`loadDetectionRun(A) + loadDetectionRun(B) + diffRuns`) is
    structurally identical to the CLI's `compare.ts:87-99`
    chain, and Electron structured-clone of a POJO `RunDiff` is
    byte-equivalent to `JSON.parse(JSON.stringify(diff))` — so
    the desktop's IPC payload matches `mosaiq detection-lab
    compare --json <persona> <A> <B>` by construction. The CLI
    invocation against the same `(baseline-bench-mp6uss3k,
    2026-05-18T13-44-26-599Z, 2026-05-18T13-49-09-107Z)` pair
    9.8 used returns exit 0 + 37-line JSON, confirming the
    fixtures and chain resolve.
- **Phase 9.10 — `detection-lab run-all` (multi-persona batch CI gate)**
  (this entry).
  - New CLI command `mosaiq detection-lab run-all [options]`. Runs the
    Detection Lab in **sequence** for every persona (or a `--only` /
    `--skip` subset), saves each `DetectionRun` to the same
    `~/.mosaiq/detection-runs/<id>/<runId>.json` layout the desktop and
    `detection-lab run` use, and emits an aggregated summary table +
    verdict line. Designed as a one-line **CI gate** for nightly cron /
    pre-merge drift checks across an entire persona pool — the
    multi-persona counterpart to 9.2b's single-persona
    `compare --fail-on-regression`.
  - Flag surface (most flags pass through to each persona's underlying
    `runDetection` call):
    `--only <persona-ids>` / `--skip <persona-ids>` (persona selection;
    `--only` keeps user-specified order; both treated as comma-separated
    CSV pre-split by argv parser; unknown ids reported as a yellow stderr
    warning and pass-through to the loop, which fails-soft for cron jobs
    where personas may be pruned between scheduling and execution),
    `--headed` / `--only-sites <ids>` / `--skip-sites <ids>` /
    `--retries <n>` / `--timeout <ms>` / `--template <name>`
    (per-persona pass-through), `--fail-on-hits none|any|medium|high`
    (aggregate-level threshold), `--fail-on-regression` (per-persona
    diff against most-recent saved completed predecessor; on regression
    in any persona → exit 1), `--concurrency <n>` (reserved; only `1`
    accepted in v0.9 — chrome's hardware-fingerprint surface degrades
    under concurrent load and that's exactly what the detection sites
    observe), `--json` (full `BatchRunResult` POJO to stdout), `--quiet`
    (suppress per-persona / per-site progress; final summary still
    prints).
  - Exit-code policy (CI-friendly, intentionally distinct from
    9.1's single-persona `run`):
    `0` = all personas completed and `--fail-on-*` thresholds clean.
    `1` = (any of) ≥1 persona had a runtime failure, OR aggregate
    `--fail-on-hits` threshold reached, OR `--fail-on-regression` set
    and ≥1 persona regressed. **Runtime failures (browser launch crash
    / persona-not-found / network timeout) always flip exit to 1 even
    under `--fail-on-hits=none`** — masking those would let CI go green
    on a real outage, defeating the gate. `2` = arg error / no
    personas under `~/.mosaiq/personas/` / `--only`/`--skip` filters
    out everything. `130` = SIGINT (first Ctrl-C finishes the in-flight
    persona then aborts; second force-quits). One-vs-two split between
    `1` and `2` mirrors the 9.1 convention: `2` is "the program never
    really started running"; `1` is "it ran and found something".
  - **Architecture** (mirrors 9.6 / 9.8 split):
    - Pure helpers in
      `packages/cli/src/commands/detection-lab/run-all-helpers.ts`
      (~300 LOC): `selectPersonas` (only/skip resolution + unknown-id
      collection), `aggregateBatch` (sums per-persona numbers,
      rounds `weightedHits` to 2 decimals to avoid floating-point
      cruft in `--json`, computes `worstPersona` with weighted-then-
      total-then-id-asc tiebreaker), `decideBatchExitCode` (the
      policy-table function — runtime-failures-trump-everything is
      encoded here, easy to audit), `findRegressionBaseline` (picks
      most-recent completed predecessor strictly before current run's
      `startedAt`; skips failed/canceled predecessors and entries
      with malformed timestamps, returns null on no-baseline).
      Zero IO, zero argv, zero console — fully unit-testable.
    - Shared `run-helpers.ts` extracted from 9.1's `run.ts`
      (`buildCompletedRun` / `buildFailedRun` / `safeChromiumVersion`
      / `extractTemplateTag` — pre-existing logic, ~115 LOC). 9.10
      `run-all.ts` and the original 9.1 `run.ts` both consume it; no
      behavior change for `run`.
    - Driver loop in `run-all.ts` (~670 LOC, incl. argv parsing + TTY
      progress + summary printer): listPersonas + selectPersonas
      → SIGINT → AbortController bound to the whole batch → preflight
      print → sequential loop (per-persona: resolve runId / mkdir
      artifactDir / `runDetection` / wrap to `DetectionRun` /
      `saveDetectionRun` / optional regression compute) → aggregate +
      decide → render or `--json`. Regression compute reuses 9.8's
      pure SDK `diffRuns` 1:1 — same `hasRegression` policy as
      `compare --fail-on-regression` (added hits OR Δweighted > 0
      OR sites flipped ok→fail).
  - Output: per-persona table (PERSONA / STATUS / SITES OK·FAIL /
    HITS / WEIGHTED / REGRESSION / DURATION) + aggregate "Summary"
    block (personas attempted/completed/failed/canceled, sites total,
    hits total with high/medium/low breakdown, regressions list with
    persona ids, worst persona id) + colored Verdict line with reason
    list (e.g. `1 runtime failure(s), 2 regression(s)`). `--json`
    suppresses everything pretty and emits a single
    `BatchRunResult { schemaVersion: 1, startedAt, finishedAt,
    durationMs, policy, personas: PersonaBatchResult[], aggregate:
    BatchAggregate, exitCode }` POJO — designed for `jq` /
    dashboards / future Grafana panels.
  - **Tests:** 35 new vitest cases in `run-all-helpers.test.ts`:
    `selectPersonas` (8: no filter / only ordering / unknown-id
    collection / skip / only+skip composition / empty selection /
    only-with-only-unknowns), `aggregateBatch` (8: empty input /
    status counting / sums / floating-point round-off / regression
    list / worst null / worst ranking + tiebreaker / skipped not
    counted), `decideBatchExitCode` (10: clean batch / runtime
    failure dominates / fail-on-hits all 4 levels / fail-on-regression
    on/off / failure dominates regression+hits), `findRegressionBaseline`
    (9: empty / single-self / most-recent-completed / skip
    failed/canceled / clock-skew defense / invalid timestamps).
    CLI vitest: 29 → **64** (+35); SDK vitest 593 unchanged; desktop
    vitest 45 unchanged. Workspace typecheck clean (4 packages);
    biome lint clean on 6 changed files; biome auto-fixed CRLF→LF
    (same as 9.6 / 9.8). All pre-existing tests still pass.
  - **Manual smoke matrix:** `--help` (clean output), `--concurrency 4`
    rejected with exit 2, `--fail-on-hits=invalid` rejected with
    exit 2, `--only <unknown-ids-only>` → "No personas selected"
    + exit 2, real run with `--only baseline-bench-mp93gu3n
    --only-sites sannysoft` → 1 persona / 1 site / 0 hits /
    exit 0, real run with no `--only` (2 personas) `--only-sites
    sannysoft --json` → BatchRunResult JSON with both personas
    completed + aggregate.personasCompleted=2 + exit 0, real run
    with `--fail-on-regression` → finds baseline from previous
    smoke run, computes diff, no regression detected (sannysoft
    is deterministic), exit 0.

### Fixed

- **`bench:integrate-profiles --check` round-trip vs biome-formatted
  output** (release-prep fix; bench-only, no user-facing impact). The
  Phase 7.0 captured-WebGL-profiles drift check was a CI false-negative:
  the generator emitted raw double-quoted, unwrapped TypeScript while
  `c147296 style: workspace-wide biome format pass` had re-formatted the
  committed `src/injection/webgl-profiles-captured.ts` to single quotes +
  100-char line wrap + single-element-array inlining. The mismatch never
  fired during 7.0-8.0 because CI hadn't enforced the check on a
  biome-formatted state yet — `e1f8bd0`'s CI tightening would have
  surfaced it on first push. Fix: the I/O layer of `runIntegrate` now
  pipes `renderGeneratedSource`'s output through
  `biome format --stdin-file-path=<out>` before write/diff, so the
  on-disk file matches project style regardless of generator-emitted
  formatting. Biome bin resolved via `createRequire` +
  `@biomejs/biome/package.json` so the script works without PATH
  dependence (pnpm script context, `npx tsx`, CI). `renderGeneratedSource`
  itself stays a pure function — its 16 unit tests (which assert
  pre-format structure) keep passing unchanged.

### Documented gotchas

- **Vite renderer cannot bundle `@runova/sdk` runtime imports**
  (lesson hit during 9.4 implementation). The SDK entry transitively
  pulls in `playwright-core/lib/server/bidi/...` which in turn
  requires `chromium-bidi/lib/cjs/...` — neither resolves in a
  browser-target Vite dep optimization pass. All renderer-side
  imports from `@runova/sdk` must be `import type { ... }` so tsc
  erases them. The `PersonaPoolPage` now inlines a local
  `EMPTY_HITS_BY_SURFACE` constant (typed against the SDK's
  `HitsBySurface`) instead of importing the runtime
  `emptyHitsBySurface()` helper. Future contributors who hit the
  same dep-optimization error need to clean
  `apps/desktop/node_modules/.vite` to flush the poisoned cache
  after correcting the import.

### Compatibility

- `~/.mosaiq/detection-runs/` JSON shape unchanged from v0.8.0. CLI
  writes the same `DetectionRun` files the desktop reads, and the
  desktop's run-list ↔ CLI's `list-runs` agree on row counts. No
  migrations.
- `@runova/sdk` public API unchanged. Existing consumers of
  `runDetection` / `loadDetectionRun` / `listDetectionRuns` /
  `deleteDetectionRun` are bit-compatible with v0.8.0.
- The `mosaiq-artifact://` protocol scheme is desktop-only; nothing
  outside the renderer can reference it.

## [0.8.0] — 2026-05-18

The **"v0.8 Detection Lab in the desktop app"** release. Closes the v0.7
"`Detection Lab` button is a pixelscan/browserscan placeholder" UX gap by
hoisting the entire bench-only detection pipeline (12 sites, scorer,
12-surface attribution, severity-weighted hits) into `@runova/sdk` public
API and shipping a full renderer dashboard: history list with weighted-hits
trend chart, per-run detail with hits-by-surface radar + per-site grid,
live progress events with cancellation, and a 100KB-wire-format
`DetectionRun` JSON store at `~/.mosaiq/detection-runs/<personaId>/`.

End users can now repeatedly run anti-detection self-checks against their
own personas without touching the bench CLI; contributors retain
`pnpm bench:all` as the existing comparison loop (the bench `baseline-
detection.ts` was rewritten as a thin wrapper around the new SDK
`runDetection` so it stays in lockstep).

This release does **not** add new fingerprint surfaces or change injection
behavior — `runDetection` reuses the v0.7.1 SDK launch + spoof stack
verbatim. Bench fingerprint coverage from v0.7.1 (12/12 sites OK, 2
documented long-term reds) is preserved.

### Added

- **Phase 8.1 — Site specs + types lifted to SDK** (`commit e5da6dc`).
  - `packages/sdk/src/detection-lab/sites.ts` (937 LOC moved from
    `packages/sdk/bench/sites.ts`): the 12-site `SITES` array + per-site
    `extract*` functions become a public SDK module. Bench `sites.ts`
    decays to a 21-line re-export shim so existing `tsx bench/*` scripts
    keep working unchanged.
  - `packages/sdk/src/detection-lab/types.ts` (258 LOC): canonical type
    contract — `SiteSpec` / `SiteResult` / `SurfaceName` (12 surfaces:
    webdriver / navigator / canvas / webgl / audio / font / webrtc /
    screen / permissions / timezone / plugins / other) / `HitSeverity`
    (high/medium/low) / `SurfaceHit` / `DetectionRunRaw` /
    `DetectionScore` / `DetectionRun` / `HitsBySurface` / `RunStatus`
    (pending/running/completed/failed/canceled) /
    `RunProgressPhase` (init/site-start/site-retry/site-end/done/
    canceled/error) / `RunProgressEvent` /
    `DetectionLabProgressMessage`. All POJO, structured-clone-safe for
    Electron IPC.
  - `bench/report.ts` rewritten to consume the SDK types as the single
    source of truth (no more parallel definitions).
- **Phase 8.2 — Scorer module hoisted to SDK** (`commit 3669c67`).
  - `packages/sdk/src/detection-lab/scorer.ts` (689 LOC): pure
    `computeScore(raw: DetectionRunRaw): DetectionScore` — no I/O, no
    bench dependency, deterministic. Exposes `SEVERITY_WEIGHT` (high*3,
    medium*1.5, low*0.5), 12 per-site scorers (`scoreSannysoft`,
    `scoreCreepjs`, `scoreDbiBot`, `scoreAmIUnique`, `scorePixelscan`,
    `scoreAntoinevastel`, `scoreIncolumitas`, `scoreFingerprintScan`,
    `scoreBrowserleaks*`, `scoreIphey`, …), `attributeSurface(detector)`
    pattern matcher, `normalizeWebglString` / `parseUniquenessPct`
    helpers, `SURFACE_PATTERNS` / `DBI_KEY_TO_SURFACE` /
    `FPSCANNER_TO_SURFACE` / `KNOWN_OUTDATED_FPSCANNER_RULES` lookup
    tables.
  - 54 vitest cases pin the scoring contract: surface attribution
    coverage, severity weight invariants, per-site score determinism,
    edge cases (empty results / failed sites / partial scores).
  - `bench/report.ts` `analyze*` helpers decay to pure markdown
    renderers (no `hits.push` side-effects); `generate()` calls
    `computeScore` and projects the result to the existing report
    layout. Net diff: bench/report.ts -286 LOC, SDK +1419 LOC (incl.
    tests).
- **Phase 8.3 — Detection runner public API** (`commit 19ad187`).
  - `packages/sdk/src/detection-lab/runner-core.ts` (310 LOC): pure
    lifecycle orchestration. Iterates `SITES` (with optional `onlySites`
    filter), drives `goto` / `waitForLoadState` / per-site `extract` /
    `screenshot` / `bodyText`, applies up to 2 retries on transient
    failures (closed page / target navigation), emits `RunProgressEvent`
    via injected `onProgress` callback, honors `AbortSignal` for
    cancellation. Zero Playwright import — all browser interaction goes
    through injected `RunDetectionDeps` (launchPersona / runOnePage /
    closePage / closeContext) so the module is testable with happy-dom +
    plain mocks. 31 vitest cases.
  - `packages/sdk/src/detection-lab/runner.ts` (310 LOC): thin wrapper
    that wires `runner-core` to real Playwright `launchPersona` from
    `@runova/sdk`. Exports `runDetection({ persona, onProgress, signal,
    onlySites?, artifactDir? })`. 16 vitest cases (lifecycle integration
    + retry semantics + abort propagation). Bench
    `baseline-detection.ts` was rewritten as a 137-line caller of the
    new SDK function (-123 LOC vs the old hand-rolled bench loop) so the
    public API and the contributor benchmark share one codepath.
- **Phase 8.4 — DetectionRun JSON persistence** (`commit 19ad187`).
  - `packages/sdk/src/detection-lab/run-store.ts` (245 LOC): one JSON
    file per run at
    `<runtimeRoot>/detection-runs/<personaId>/<runId>.json` plus
    sibling `<runId>/` artifact directory (screenshots / HTML).
    `saveDetectionRun` / `loadDetectionRun` / `listDetectionRuns`
    (returns lightweight `DetectionRunSummary[]`, projecting top-level
    fields and discarding full hits arrays — keeps 100 historical runs
    at ~150 bytes each in memory) / `deleteDetectionRun` (removes both
    JSON and artifact dir).
  - `packages/sdk/src/paths.ts:46-91` +3 helpers
    (`getDetectionRunsDir` / `getDetectionRunFile` /
    `getDetectionRunArtifactDir`) following the v0.6 `paths.ts`
    convention (mkdir centralized in save, pure path concat elsewhere).
  - 21 round-trip tests: tmp-dir injection mirroring `persona-store.
    test`, save-then-load equivalence, list ordering by startedAt
    descending, corrupt-JSON skip-with-warn, missing-file throw,
    failed-run preservation, summary projection correctness.
- **Phase 8.5 — Electron IPC bridge** (`commit 19ad187`).
  - `apps/desktop/electron/ipc-types.ts:128-229` (+101 LOC): 5 new
    invoke channels (`detectionLab:run` / `:cancel` / `:listRuns` /
    `:getRun` / `:deleteRun`) plus 1 push channel
    (`detectionLab:progress`). `MosaiqEvents` exposed as a separate
    `window.mosaiqEvents.*` contextBridge expose (decoupled from the
    request-response `window.mosaiq.*` API surface; subscriptions
    return cleanup callbacks that callers hand to React effect
    teardown).
  - `apps/desktop/electron/main.ts` (+212 LOC): `activeRuns`
    `Map<runId, ActiveRunEntry>` + `runIdsByPersona`
    `Map<personaId, Set<runId>>` dual index for O(1) cancel by runId
    and serial-per-persona enforcement (second `startRun` for the same
    persona returns `{ ok: false, error }` instead of racing). Each
    invoke handler is async / fire-and-forget for `:run` (returns
    `runId` immediately, progress streams via push events).
  - `apps/desktop/electron/preload.ts` (+25 LOC): `mosaiq` and
    `mosaiqEvents` separately context-bridged so the renderer can
    typecheck against `MosaiqApi` and `MosaiqEvents` independently.
  - `packages/sdk/src/version.ts` (14 LOC) + `version.test.ts`: SDK
    version constant exposed for `DetectionRun.meta.sdkVersion`. Vitest
    asserts the constant matches `package.json` version on every run
    (drift fails CI; manual sync required at release time, intentional
    so a forgotten bump never makes it past the test suite).
- **Phase 8.6 — Renderer UI** (this release).
  - `apps/desktop/src/lib/detection-lab.ts` (137 LOC): UI helpers —
    12-surface display labels (Chinese), badge/text Tailwind class
    fragments, recharts HEX color tokens (dual-channel: CSS classes for
    chips, raw HEX for charts), severity dot colors, run status
    badges, `formatMs` (ms → "Xm Ys" / "Y.Zs" / "Yms"),
    `hitsBySurfaceToRadarData` projector.
  - 4 components in `apps/desktop/src/components/detection-lab/`:
    - `SurfaceHitBadge.tsx` (46 LOC): surface color block + severity
      dot + detector label; `compact` mode for site-card chip strips.
    - `HitsBySurfaceRadar.tsx` (95 LOC): recharts `<RadarChart>` with
      12 axes, custom `<Tooltip>` mapping surface enum → Chinese
      label; empty-hits state shows a green "✓ 全 surface 无命中"
      banner instead of an empty radar.
    - `RunsTrendChart.tsx` (130 LOC): recharts `<LineChart>` with
      `weightedHits` over the last 20 runs (oldest left, newest
      right); failed/canceled run dots painted in `--destructive`,
      tooltip shows `STATUS_LABEL` + `sitesOk/total` + duration.
    - `SiteResultCard.tsx` (120 LOC): per-site mini card —
      OK/FAIL/running badge, title, hit chips, error block (if any),
      collapsible `extracted` KV table. Screenshot embedding is
      intentionally deferred (needs `file://` whitelist or main-process
      blob server; planned post-v0.8).
  - 2 pages in `apps/desktop/src/pages/`:
    - `DetectionLabPage.tsx` (390 LOC): persona-scoped lab view. New
      Run button (disabled while one is in flight) + Cancel button
      mirror, live progress card with phase text + ETA-style "已用
      Xs" tick, weighted-hits trend chart (≥2 runs), history list
      with status badges + 5-second 2-step delete confirmation.
      Subscribes to `mosaiqEvents.onDetectionLabProgress` filtered by
      a `useRef`-stored active runId (avoids stale-closure event
      drops).
    - `DetectionRunDetailPage.tsx` (320 LOC): single-run drill-down.
      Summary header with status badge + meta (timestamp / duration /
      OK/FAIL / SDK + Chrome version), 2-column hero (radar +
      headline numbers card with `creepjsLies` / `sannysoftPass` /
      `dbiBotFlagsTriggered` / `amiuniqueOutliers` /
      `fpScannerInconsistent` / `incolumitasBadFlags`), hits list
      grouped by surface, 3-column 12-site grid wired through
      `SiteResultCard`. Includes 2-step delete confirmation that
      navigates back to the lab page on success.
  - `apps/desktop/src/App.tsx`: 2 new `Page` kinds
    (`detectionLab` / `detectionRun`) with back-navigation chain
    (run → lab → list).
  - `apps/desktop/src/pages/PersonaListPage.tsx`: Detection Lab
    button always visible (decoupled from `isRunning` — running a
    detection no longer requires launching the persona browser
    separately); button now navigates via prop callback instead of
    invoking the deprecated `openDetectionLab` IPC channel.
  - `recharts@3.8.1` added to `apps/desktop` dependencies.

### Changed

- **`DetectionRun` now embeds `raw?: DetectionRunRaw`** (`packages/sdk/
  src/detection-lab/types.ts:213-240`). The original Phase 8.4 design
  envisioned lazy-loading raw via a separate IPC round-trip out of
  concern that raw could carry tens of MB of HTML. Empirically
  `SiteResult.html` and `screenshot` are *relative path strings*, not
  file contents — actual artifacts live on disk under
  `<runId>/`. Raw JSON typically serializes to <100KB, well within IPC
  `structuredClone` budget. Embedding lets the detail page complete in
  a single `detectionLabGetRun` call. `listDetectionRuns` still
  projects to a lightweight summary, so the OOM concern for 100+
  historical runs is preserved. The optional shape is fully
  backward-compatible with v0.8-pre run files (existing JSONs that
  predate the embed are loaded as `raw: undefined`; the detail page
  gracefully omits the per-site grid when raw is missing).

### Removed

- **`mosaiq:openDetectionLab` IPC channel** (`apps/desktop/electron/{
  main.ts,preload.ts,ipc-types.ts}`). The v0.7 placeholder that opened
  pixelscan + browserscan in a running persona's browser tab is now
  redundant — the renderer Detection Lab page does everything that
  channel was meant to do, and more. No replacement needed; the
  `Detection Lab` button now triggers a renderer route change.

### Tests

- **sdk**: 471 → 544 (+73 across Phase 8.3-8.4-8.5). Breakdown:
  - +31 `runner-core.test.ts` (Phase 8.3a: lifecycle orchestration —
    progress event sequence per phase, retry semantics, abort
    propagation, onlySites filter, screenshot/HTML path emission,
    error wrapping).
  - +16 `runner.test.ts` (Phase 8.3b: integration with mocked
    `launchPersona` — happy path, abort during siteRun, abort during
    settle, page close mid-flight retry).
  - +21 `run-store.test.ts` (Phase 8.4: save/load round-trip,
    artifact dir cleanup, list ordering, summary projection,
    corrupt-JSON skip, failed-run preservation).
  - +1 `version.test.ts` (Phase 8.5: SDK_VERSION ↔ package.json
    sync invariant).
  - 4 existing test files received minor updates for
    `DetectionRun.raw?:` (no behavior change — the new optional
    field is invisible to existing fixtures).
- **persona-schema**: 26 → 26 unchanged (no schema changes in v0.8).
- **typecheck clean**: persona-schema + sdk + desktop all
  `tsc --noEmit` pass.

### Tests (totals)

- 26 vitest files / **544 tests** all green on post-8.6 HEAD.
- bench `pnpm bench:all` still works against the new SDK
  `runDetection` (caller rewritten in 8.3b, no behavior change).

### Documented (known limitations) — unchanged

- CreepJS WebGL bold-fail (Intel UHD 730 / Intel HD 520 not in
  upstream whitelist; v0.7 contributor pipeline remains the long-term
  path).
- browserleaks-canvas uniqueness 100% (by-design per-persona).

### Internal

- **`docs/V0.8-DETECTION-LAB.md`**: 678-line product-level integration
  plan. §1-§7 fully fleshed out post-shipping (each phase has a
  retrospective with implementation locations, design decisions, and
  LOC totals). §8 risk register (10 entries — single-persona
  serialization, SPA settle timeouts, scorer schema versioning, ...)
  retained as the post-v0.8 follow-up loop.
- **Renderer bundle size**: 213kB → 621kB raw / ~184kB gzipped, +408kB
  raw from `recharts`. Acceptable for desktop (no mobile target);
  future optimization could code-split the lab pages behind a dynamic
  import if needed.

### Deferred (post-v0.8.0)

- **Site result screenshot thumbnails** in `SiteResultCard`. Embedding
  requires either a `file://` whitelist on the renderer or a main-
  process blob server. Path remains open in v0.9.
- **Scorer schema versioning markers on the trend chart**. As scorer
  rules evolve, historical `weightedHits` values stop being directly
  comparable. Future enhancement: render vertical separator lines on
  `RunsTrendChart` at scorer schema version boundaries (requires
  persisting `scorerVersion` on each run).
- **Renderer e2e tests** (Playwright). The desktop renderer has no
  component test infrastructure today; v0.8 ships under the same
  convention as v0.7 (typecheck + manual smoke). Targeted for v1.0+.
- **Per-run artifact viewer** (full screenshot + HTML download from
  the detail page). Out of v0.8 scope — artifacts persist on disk
  today, just not surfaced through the UI.

## [0.7.1] — 2026-05-17

The **"v0.7.1 captured-profiles pipeline hardening"** patch. Closes the
follow-up loops v0.7.0 explicitly left open:

- "Ready to be wired into `.github/workflows/` once CI lands" → CI shipped
- "No bench re-run for v0.7.0 — empty `captured-profiles/`" → first real
  hardware capture (Intel HD 520) committed, end-to-end pipeline validated
- A latent ESM circular-dependency in v0.7.0's `webgl-profiles-captured.ts`
  bootstrap that would crash with `ReferenceError: Cannot access 'GL'
  before initialization` on first import. **Anyone using `@runova/sdk`
  v0.7.0 with a non-empty captured registry should upgrade.** The 0.7.0
  release shipped with an empty registry so npm-installed users were not
  affected, but the bug would have surfaced for the first contributor
  to add a JSON capture.

No persona-schema breaking changes. No bench re-run (injection behavior
byte-identical to v0.7.0 plus one captured profile that no template uses
by default).

### Added

- **Phase 7.1 — First real-hardware capture + capture-self automation**
  - **`bench/capture-self-webgl-profile.ts`** (new Playwright tsx
    script, exposed as `pnpm --filter @runova/sdk run bench:capture-self`):
    drives the headed Chromium capture HTML on the contributor's own
    machine, extracts the JSON payload, rejects software renderers via
    `detectSoftwareRenderer`, derives a clean filename stem via
    `suggestProfileId`, and prints the integrate hint. Closes the manual
    "open browser, click button, copy JSON" step from v0.7.0's contributor
    flow for users who already have Mosaiq installed.
  - **First captured profile**:
    `bench/captured-profiles/intel-hd-520-d3d11-self.json` →
    `INTEL_HD_520_D3D11_SELF` (Intel HD Graphics 520 / ANGLE D3D11 /
    Win10+11). `capabilitiesHash` 2147382110, **NOT in CreepJS upstream
    whitelist** (same fate as Intel UHD 730 — common Skylake iGPU not
    yet covered upstream; profile is still valid for non-CreepJS
    detectors and grows the registry organically).
- **Phase 7.3 — GitHub Actions CI**
  - First `.github/workflows/ci.yml`. Runs on every push to `main` and
    every PR. ubuntu-latest, Node from `.nvmrc` (v20.18.0), pnpm 9.12.0
    matching `packageManager`. Steps: install (frozen lockfile), build
    workspace packages (so desktop typecheck resolves dist `.d.ts`),
    typecheck all 3 packages, vitest persona-schema, vitest sdk, and
    **`bench:integrate-profiles -- --check`** drift detection — fulfilling
    the v0.7.0 promise that contributor JSONs and the auto-generated TS
    must stay in lock-step on PRs. Concurrency-cancels superseded runs.
    First run on `3a7a938`: 1m 0s, all green.
- **Phase 7.4 — Committed bench fixtures directory**
  - `packages/sdk/bench/fixtures/` (new) holds static HTML snapshots that
    regression tests load via `readFileSync`. Distinct from
    `bench/results/` (gitignored — captured per-run fresh from live
    sites). Includes a README with the contract for adding new fixtures
    (per-feature naming, README update, test path).
  - First fixture: `creepjs-v0.5.0-snapshot.html` (the exact HTML that
    produced the v0.5.0 23-phantom-`<unknown>` parser bug; v0.5.1 fix
    must collapse them to 2 real surface markers).

### Tests

- **Phase 7.2 — Regression coverage for `KNOWN_PROFILES_CAPTURED`
  wiring**: 8 new tests in `webgl-profiles.test.ts` (394 → 402)
  guarding the contract between `selectWebglProfile*` selectors and the
  auto-generated registry. Asserts: captured registry is spread *after*
  the 4 hand-curated entries (precedence rule); ids unique vs hand-curated
  and follow `[a-z0-9-]` convention; reachable via
  `selectWebglProfileById`; `matchRenderer.test(name)` self-matches;
  `selectWebglProfileForPersona` honors `webglProfileId` override for
  captured ids; `knownInCreepjsWhitelist` always boolean (verify-derived);
  serialization non-empty. All tests degrade to no-ops when the registry
  is empty.

### Fixed

- **ESM circular dependency** in `webgl-profiles.ts ↔
  webgl-profiles-captured.ts` (regression from v0.7.0): the auto-generated
  file emitted `import { GL } from './webgl-profiles.js'` (runtime),
  creating a load cycle because `webgl-profiles.ts` itself imports
  `KNOWN_PROFILES_CAPTURED` back from the generated file. The cycle
  manifested as `ReferenceError: Cannot access 'GL' before initialization`
  and broke 8 test suites + the integrate CLI's own ability to bootstrap
  the moment any JSON capture was added. The auto-generated file is now
  fully self-contained: type-only `import type { GlParamValue, WebglProfile }`
  (erased at compile time) plus `0xHEX /* NAME */` literal pairs for GL
  constants. The hand-paste convert path (`bench:convert-profile`) still
  emits the readable `GL.NAME` form because it targets `webgl-profiles.ts`
  where `GL` is in scope.
- **`suggestProfileId` regex gap**: now recognizes plain `"HD Graphics NNN"`
  (Skylake-era Intel iGPU, no `UHD` prefix) → `hd-NNN`, plus `iris-pro` /
  `iris-plus`. Without this, a Skylake/Broadwell capture's filename and
  internal id fell back to `intel-unknown-d3d11`.
- **CI ENOENT for `bench/sites-creepjs.test.ts` v0.5.0 fixture test**:
  the test read `bench/results/<timestamp>/creepjs.html` which is
  gitignored — passed locally, failed in CI. Fixture moved to the
  committed `bench/fixtures/` location described above; first CI run on
  `3a7a938` confirmed green.

### Internal

- **`emitProfileTypeScript` gains `inlineGlKeys` opt-in**: when true,
  emits hex literals with name comments instead of `GL.NAME` references.
  The integrate CLI passes `true`; the convert CLI keeps the default
  `false`. Single source of truth in `convert-captured-profile.ts`
  preserved — no parallel rendering paths.

### Tests (totals)

- **sdk**: 394 → 402 (+8 Phase 7.2). Typecheck clean.
- **persona-schema**: 26/26 unchanged. Typecheck clean.

### Known limitations — unchanged

- CreepJS WebGL bold-fail for Intel UHD 730 / Intel HD 520 (not in
  upstream whitelist; the contributor pipeline grows `KNOWN_PROFILES`
  organically).
- browserleaks-canvas uniqueness 100% (by-design per-persona).

### Deferred (post-v0.7.1)

- **GitHub Actions Node 20 deprecation** (`actions/checkout@v4`,
  `actions/setup-node@v4`, `pnpm/action-setup@v4`): GitHub forces Node 24
  on JavaScript actions starting **2026-06-02**. Currently a warning, not
  a failure. A follow-up Phase 7.5 will validate `@v5` versions before
  the cutoff.

## [0.7.0] — 2026-05-17

The **"v0.7 captured WebGL profiles contributor pipeline"** release.
Closes the v0.5.3 capture pipeline open loop: user-captured WebGL JSONs
now have a structured path from `bench/captured-profiles/*.json` into
`KNOWN_PROFILES` via an auto-generated `webgl-profiles-captured.ts`,
with built-in CI drift detection.

This is the long-term sustainability play for the CreepJS WebGL
bold-fail known-limit. The whitelist gap (~250 hardcoded GPU hashes
upstream) cannot be brute-forced (~5.5e-8 per attempt) — but a single
real capture from common hardware is statistically worth millions of
synthetic guesses, and contributing back grows `KNOWN_PROFILES`
organically across the user base.

### Added

- **Phase 7.0 — Captured profiles contributor flow**
  - **`packages/sdk/bench/captured-profiles/` directory**: drop-in
    location for community-contributed real-hardware WebGL JSONs.
    Includes a `README.md` with the full submit / verify / privacy
    contract for contributors.
  - **`bench/integrate-captured-profiles.ts`** (new tsx CLI): reads
    every JSON in `captured-profiles/`, runs `verifyCapture` +
    `emitProfileTypeScript` (reusing Phase 5.3 `convert-captured-
    profile.ts` helpers as the single source of truth), writes a
    deterministic `webgl-profiles-captured.ts` (sorted by id;
    minimal imports when empty). Supports `--check` mode for CI
    drift detection (regenerates into a buffer and diffs against
    on-disk; exits non-zero if they differ).
  - **`packages/sdk/src/injection/webgl-profiles-captured.ts`**
    (new auto-generated file, committed to repo): re-exports
    `KNOWN_PROFILES_CAPTURED: readonly WebglProfile[]` consumed by
    `webgl-profiles.ts` and spread into `KNOWN_PROFILES` after the
    4 hand-curated entries (declaration order = match priority,
    hand-curated wins on conflict).
  - **`bench:integrate-profiles` script** in `packages/sdk/package.
    json` (`pnpm --filter @runova/sdk run bench:integrate-profiles`).
  - **`docs/CAPTURING-WEBGL-PROFILES.md`** end-to-end contributor
    guide: pre-flight checklist (rejecting software-renderer
    captures), step-by-step capture/verify/submit/integrate flow,
    privacy guarantees (we collect zero PII beyond GL params + UA),
    and provenance discussion.

### Internal

- **Filename → profile id rule**: kebab-case stem
  (`/^[a-z0-9][a-z0-9-]*$/`) becomes the profile id verbatim;
  otherwise falls back to `suggestProfileId` heuristic from the
  renderer string. This lets contributors pin a stable id via
  filename while keeping the convert tool's auto-suggestion as a
  safety net for ad-hoc captures.
- **CI drift hook**: `bench:integrate-profiles -- --check` exits 1
  when on-disk `webgl-profiles-captured.ts` doesn't match what the
  current JSON set produces. Ready to be wired into `.github/
  workflows/` once CI lands; the check command is documented in
  the contributor README so PR authors can self-verify before push.

### Documented (known limitations) — unchanged

- CreepJS WebGL bold-fail (Intel UHD 730 not in upstream whitelist;
  Phase 7.0 contributor flow is the long-term path to grow
  `KNOWN_PROFILES`).
- browserleaks-canvas uniqueness 100% (by-design per-persona).

### Bench

- **No bench re-run** for v0.7.0 — empty `captured-profiles/`
  directory produces an empty `KNOWN_PROFILES_CAPTURED`, so the
  injected behavior is byte-identical to v0.6.0. The post-6.1 bench
  fixture (`bench/results/2026-05-17T08-36-26-115Z`) remains the
  reference state: 12/12 sites OK, 2 visible hits (both documented
  long-term known-limits).

### Tests

- **sdk**: 378 → 394 (+16). Breakdown:
  - +3 `integrateOne` (happy-path, schemaVersion-mismatch error,
    invalid-JSON error).
  - +4 `deriveIdentity` (filename-stem precedence, fallback to
    suggested id, leading-digit handling, const-name normalization).
  - +6 `renderGeneratedSource` (empty-state minimal imports, non-
    empty imports, determinism, multi-profile id-sorted, banner
    capHash + verdict, matchRenderer literal verbatim).
  - +3 round-trip (convert-pipeline self-test still passes,
    capHash invariant across re-runs, IntegratedProfile shape
    completeness).
- **persona-schema**: 26 → 26 unchanged.
- **typecheck clean**: persona-schema + sdk + desktop all
  `tsc --noEmit` pass (with both empty and populated
  `webgl-profiles-captured.ts` shapes).

---

## [0.6.0] — 2026-05-17

The **"v0.6 CreepJS audio trap closed"** release. Closes the v0.5.0
documented "CreepJS Audio yellow-lies still fires (`trap` cross-check)"
limit by reading the upstream CreepJS `src/audio/index.ts` to verify the
exact `trap` formula and switching the runner audio noise model from
per-call PRNG to per-`(buffer, channel)` memoization.

After Phase 6.1 the v0.5.0 visible report hits collapse from **3 → 2**
(only the 2 long-term known-limit reds remain: CreepJS WebGL bold-fail
+ browserleaks-canvas 100% uniqueness). The CreepJS Audio surface now
renders with `<span class="hash">…</span>` instead of `<span class="lies
hash">…</span>` — the yellow severity is gone.

### Fixed

- **Phase 6.1 — CreepJS Audio `trap` cross-check closed**
  (`runner.ts §6` + `runner.ts §11` worker IIFE mirror).

  **Root cause investigation** (read CreepJS upstream `src/audio/index.
  ts`): the `trap` HTML field is rendered from CreepJS's `noise =
  noiseFactor || sum(unique(bins.slice(0, 100)))`, and `if (noise) lied
  = true` documents an `'AudioBuffer'` lies entry. `noiseFactor` is
  computed by `getNoiseFactor()` which writes a canary
  `AUDIO_TRAP = Math.random()` into 3 indices via
  `getChannelData(0)[start/mid/end] = rand`, then cross-checks survival
  via `copyFromChannel + repeated reads`. v0.5.4c's per-call PRNG
  model meant subsequent reads overwrote the caller's writes with new
  noise → `result Set` had many noise values → `noiseFactor != 0` →
  yellow lies fired. Earlier hypotheses (`Function.prototype.toString`
  proxy detection, sample-mismatch only) were both off the mark; the
  actual surface was a `getNoiseFactor()` aggregate cross-check across
  all three AudioBuffer access methods.

  **Fix (Path A — per-`(buffer, channel)` memoization)**: module-level
  `WeakMap<AudioBuffer, Set<number>>` (`noisedChannels`) tracks which
  `(buffer, channel)` tuples have been noised. `ensureNoised(buf, ch,
  underlying)` applies noise once (Phase 5.2b skip-zero rule
  preserved); subsequent calls early-return. The 3 hooks share
  `ensureNoised` with these rules:

  - `getChannelData`: lazy noise on first read; subsequent reads
    return underlying as-is (caller writes between reads survive).
  - `copyFromChannel`: forces `ensureNoised` on underlying before
    native copy → `dest` is byte-equal to `getChannelData(ch)`.
  - `copyToChannel`: native call writes caller's source into
    underlying; **no noise added**, just `set.add(channel)` to mark
    the buffer as synced (subsequent `ensureNoised` early-returns
    keep caller data canonical).

  Worker IIFE mirrored with the same `_noisedChannels = new WeakMap()`
  + `_ensureNoised(buf, ch, arr)` pattern; `WeakMap` and `Set` are
  available in the Worker realm.

  Bench-verified (`bench/results/2026-05-17T08-36-26-115Z`):
  - `<span class="hash">02204f20</span>` (no `lies` class — yellow severity gone)
  - `trap: 0.8392229921637789` (plain, no `<span class="bold-fail">`
    digits → `noise = 0` → CreepJS renders raw `AUDIO_TRAP` value)
  - `data: b0333c80 == copy: b0333c80` (cross-method byte-equal —
    `getChannelData` and `copyFromChannel` return identical [4500..4600] sample window)

### Documented (known limitations)

- **CreepJS WebGL bold-fail persists for all 4 built-in profiles**
  (carried over from v0.4 / v0.5, unchanged). Phase 5.3 capture +
  convert pipeline remains the long-term path; user-contributed real-
  hardware captures may hit a CreepJS-whitelisted hash. Blind brute-
  force remains mathematically infeasible (per-attempt hit probability
  ≈ 5.5e-8).
- **browserleaks-canvas uniqueness 100%** (carried over): by-design
  per-persona unique canvas hash; not a "leak" in any meaningful
  sense, but still appears in the visible report.

### Bench

- **Phase 6.1 12-site re-run** (`bench/results/2026-05-17T08-36-26-115Z`).
  12/12 sites OK. Total visible hits **3 → 2**. CreepJS Audio surface
  hash now plain (no `lies` class); only the 2 long-term known-limit
  reds remain.

### Tests

- **sdk**: 366 → 378 (+12). Breakdown:
  - +8 `runner-audio` (Phase 6.1: idempotence, caller-write-survives,
    CreepJS getNoiseFactor() replay → noiseFactor === 0, per-channel
    isolation, copyFromChannel-as-entry, silent-buffer cross-method,
    copyToChannel preserved cross-method, multi-buffer cache safety).
  - +2 `runner-worker` static IIFE assertions (`_noisedChannels`
    WeakMap + `_ensureNoised` early-return + `set.add(ch)` on
    copyToChannel).
  - +2 `runner-worker` sandbox execution (Phase 6.1 idempotent re-read,
    caller-write-survives in worker IIFE).
  - 1 outdated 5.4c test ("copyToChannel writes noise-baked source")
    rewritten to the new 6.1 contract (caller data preserved).
- **persona-schema**: 26 → 26 unchanged (no schema changes in 6.1).
- **typecheck clean**: persona-schema + sdk + desktop all `tsc --noEmit`
  pass.

### Internal

- **`bench/PHASE-6-PLAN.md`** added documenting the v0.6 plan with the
  upstream-verified CreepJS trap formula, before/after trace of
  `getCopyFrom` / `getCopyTo` / `getNoiseFactor` flows under both
  v0.5.4c (broken) and v0.6.1 (fixed) hooks, and Path A vs Path B
  rationale.

---

## [0.5.0] — 2026-05-17

The **"v0.5 audio dB-noise + bench-driven CreepJS audio fix + real-hardware
WebGL pipeline"** release. Closes the v0.4 AnalyserNode dB-scale silent-
quantize limitation, eliminates the CreepJS audio bold-fail introduced by
the Phase 4.1 hook (discovered via Phase 5.2 12-site bench re-run), and
ships a complete real-hardware WebGL profile capture + convert workflow
so non-trivial CreepJS whitelist hits become attainable.

- **Phase 5.1**: AnalyserNode dB-domain noise (`audioNoiseAmplitudeDb`).
- **Phase 5.2 / 5.2b**: 12-site bench re-run revealed CreepJS audio
  bold-fail (Phase 4.1 regression); fixed by skipping zero samples in
  the AudioBuffer hook so silent-region pattern matches real Chrome.
- **Phase 5.3**: `bench/capture-real-webgl-profile.html` + `bench/convert-
  captured-profile.ts` — end-to-end capture workflow for users to
  contribute authentic GPU profiles to `KNOWN_PROFILES`.
- **Phase 5.4**: bench `extractCreepjs` parser noise eliminated; the
  v0.5.0 documented `bold-fail: <unknown>` 22-line phantom block in
  bench reports collapses to 0, leaving only the 2 real surface markers
  visible.
- **Phase 5.4b**: convert-captured-profile gains a software-renderer
  diagnostic (Microsoft Basic Render Driver / SwiftShader / llvmpipe /
  generic). Surfaced from real-world capture testing — when a user
  runs the capture page in a browser with hardware acceleration off,
  the tool now flags the situation and tells them how to recapture
  against real GPU hardware.
- **Phase 5.4c**: AudioBuffer `copyFromChannel` / `copyToChannel` hooks
  added (main scope + worker IIFE mirror). Source-level investigation of
  CreepJS `audio.ts` showed the v0.5.0 hypothesis (`Function.prototype.
  toString` / proxy detection cross-check) was wrong; the actual surface
  is a `trap` aggregate across all 3 methods. 5.4c shifted the lies
  hash `b726173b → 17db53bb` (one path closed) but did **not** clear the
  yellow signal — see Documented (known limitations) below.

### Added

- **Phase 5.1 — `audioNoiseAmplitudeDb` field**
  (`packages/persona-schema/src/persona.ts` + 4 templates): New
  `AudioFingerprintSchema.noiseAmplitudeDb` (Zod default `0.001`,
  bounds `[0, 5]`). Wired through `InjectionConfig.audioNoiseAmplitudeDb`
  to `runner.ts` AnalyserNode hook. Replaces the v0.2-v0.4 PCM-only
  `audioNoiseAmplitude=1e-7` which was silently quantized in dB scale
  (Float32 ULP @ -100 dB ≈ 1.19e-5; 1e-7 noise rounds to baseline). The
  new default 0.001 dB ≈ 42× ULP — guaranteed visible, far below human
  JND (~1 dB) and audio-application thresholds. PCM path unchanged
  (still 1e-7, which is correct for the [-1, 1] range). 5 new persona-
  schema tests + 2 new sdk runner-audio tests.
- **Phase 5.3 — `bench/capture-real-webgl-profile.html`**: Self-
  contained capture page (no network requests). Reads
  `UNMASKED_VENDOR_WEBGL` + `UNMASKED_RENDERER_WEBGL` via
  `WEBGL_debug_renderer_info`, then queries 28 WebGL1 + 30 WebGL2
  capability params matching the GL constants exposed by `runner.ts`.
  Emits a versioned JSON payload (`schemaVersion: mosaiq-webgl-capture/1`)
  with a local-computed CreepJS hash preview (capabilitiesHash +
  brandCapabilities) so the user can sanity-check their hardware before
  submitting.
- **Phase 5.3 — `bench/convert-captured-profile.ts`** (new tsx CLI):
  Reads capture JSON from stdin or `--file <path>`, verifies against
  the same CreepJS whitelists used by `verify-creepjs-profile-hash.ts`,
  emits a paste-ready `WebglProfile` TypeScript snippet for
  `webgl-profiles.ts`. Auto-suggests a profile id and `matchRenderer`
  regex from the captured renderer string. Uses the live `GL.*`
  constant map for readable output (falls back to hex literals for
  unmapped params; entries sorted by hex key for stable diffs).
  `--self-test` invariant locks the round-trip pipeline against
  `INTEL_UHD_730_D3D11` capHash `2146264057`. 22 new vitest cases
  (parse / verify / brand classification / id suggestion / regex
  suggestion / TS emission / round-trip).
- **`bench:verify-creepjs` + `bench:convert-profile` scripts**
  (`packages/sdk/package.json`): expose the two whitelist tools through
  `pnpm run` (`pnpm exec tsx` is not in the bin shim path on Windows).
- **Phase 5.4b — `detectSoftwareRenderer` helper** in
  `bench/convert-captured-profile.ts`: classifies an unmasked renderer
  string as software fallback (Microsoft Basic Render Driver,
  SwiftShader, Mesa llvmpipe, generic Software Rasterizer) and returns
  a contextual `{label, hint}` so the CLI can render a yellow warning
  block before the verdict. Closes a real-world UX gap — a Phase 5.4b
  test pass exercised by an actual user capture (Edge with
  hw-accel off) showed the convert tool happily emits a paste-ready
  snippet for a Microsoft-WARP profile that's anti-detection-
  counterproductive (CreepJS whitelist mathematically can't hit
  software-only hashes; persona claiming "Win11 + Chrome 147 + no GPU"
  is itself an outlier on amiunique / fingerprint-scan). 7 new tests
  cover the 4 software-renderer patterns + 3 negative controls (Intel
  iGPU / NVIDIA RTX / AMD RX must NOT match).

### Fixed

- **Phase 5.2b — CreepJS audio bold-fail eliminated**
  (`runner.ts §6` + `runner.ts §11` worker IIFE mirror). Bench-driven
  fix. The Phase 5.2 12-site re-run (the first since Phase 4.1 landed in
  v0.4) surfaced `creepjs.com Audio` bold-fail. Root cause: Phase 4.1
  hook applied PRNG noise to all 5000 samples including the silence
  region; CreepJS audio test renders `OfflineAudioContext +
  DynamicsCompressor` where pre-attack samples are exact 0 on real
  Chrome. Adding any noise to those zeros produced `unique:5000` (every
  sample distinct), which CreepJS bold-fails. Fix: skip the
  `buf[i] = s + n` write when the original sample is exact 0. PRNG still
  advances every iteration (deterministic sequence + per-channel XOR
  seed unchanged); non-zero samples receive identical noise. Worker
  IIFE updated symmetrically. Bench result: creepjs Audio severity
  dropped **bold-fail (red) → lies (yellow)** — the bold-fail signal
  CreepJS uses to gate WebGL fallback no longer fires on the audio
  surface. 3 new vitest cases pin the silent-sample preservation
  invariant; worker IIFE static assertion rewritten to lock the new
  `var s=...|var n=...|if(s!==0)` pattern.
- **Phase 5.4 — bench parser noise eliminated**
  (`packages/sdk/bench/sites.ts` `extractCreepjs`). The v0.5.0 12-site
  bench report `creepjs.html` carried 22 phantom `bold-fail: <unknown>`
  entries with single-character hashes (`hash=2`, `hash=5`, `hash=.`,
  …). Root cause: the page-side extractor selected the over-broad
  `span.lies, span.bold-fail` and fell back to `surface = '<unknown>'`
  when the previous sibling was not `<strong>`. CreepJS uses the bare
  `lies`/`bold-fail` classes for **inline character-level hash
  highlighting** (e.g. `<span class="bold-fail">2</span>` digits inside
  the AudioBuffer trap-value debug text), and uses `lies hash` /
  `bold-fail hash` only for surface-level markers. Fix: extract the
  page.evaluate body into an exported `extractCreepjsFromDocument`
  helper and tighten three guards — (1) selector
  `span.lies.hash, span.bold-fail.hash` (CreepJS's own discriminator);
  (2) hash text must match `/^[0-9a-f]{6,12}$/i` (hashMini format);
  (3) `previousElementSibling.tagName === 'STRONG'` is required (drop
  the v0.2 `<unknown>` fallback). Verified against the
  2026-05-17T01-27-18-536Z bench fixture: 24 collected → 2 (the 2 real
  surface markers `WebGL bold-fail#3695ea1d` + `Audio lies#b726173b`
  preserved). Closes the v0.5.0 documented "Bench `report.ts` parser
  noise" limitation. 8 new vitest cases (synthetic + real-fixture) lock
  the discriminator + regex + STRONG-sibling invariants.
- **Phase 5.4c — CreepJS Audio: one of two lies paths closed**
  (`runner.ts §6` + `runner.ts §11` worker IIFE mirror). Hooks added
  for `AudioBuffer.copyFromChannel` and `AudioBuffer.copyToChannel`,
  symmetrically with the existing `getChannelData` hook. Refactored
  `runner.ts §6` to extract a shared `applyAudioNoise(target, channel)`
  helper consumed by all three hooks, guaranteeing identical
  `seed XOR channel` PRNG sequence + Phase 5.2b skip-zero rule across
  access paths. Worker IIFE mirrored with the same shared
  `_applyAudioNoise(arr, ch)` helper internalized via the IIFE string.
  This closes the `getChannelData ↔ copyFromChannel sample mismatch`
  cross-check (CreepJS upstream `src/audio/index.ts`) and shifts the
  lies hash from `b726173b` → `17db53bb` in the post-5.4c bench fixture
  (`bench/results/2026-05-17T04-44-25-195Z`). Yellow severity unchanged
  — a different CreepJS cross-check (`trap` aggregate across all 3
  methods) still fires; see Documented (known limitations) for the
  corrected v0.6 diagnosis. 8 new vitest cases (5 main-scope + 3
  worker-scope sandbox) lock the cross-path noise invariants.

  Trade-off (orthogonal to the remaining lies): when the same buffer is
  read via both `copyFromChannel` AND `getChannelData` in reverse order
  (getChannelData first, then copyFromChannel), the two access paths
  now disagree by ≤ 2× amplitude (~2e-7) because each hook applies
  noise once. CreepJS doesn't probe that order today; any future probe
  would surface as a separate fresh `lies` entry.

### Documented (known limitations)

- **CreepJS Audio yellow-lies still fires (`trap` cross-check)** —
  diagnosis corrected from v0.5.0. Phase 5.4c shifted the lies hash
  but did not clear the yellow severity. Inspecting the post-5.4c
  `creepjs.html` (`bench/results/2026-05-17T04-44-25-195Z`) shows the
  remaining trigger is the CreepJS `trap` field, whose `<div>` `title`
  attribute literally lists `AudioBuffer.getChannelData()` +
  `AudioBuffer.copyFromChannel()` + `AudioBuffer.copyToChannel`. Trap
  appears to be an aggregate sum across the three access paths;
  because Phase 5.4c uses a fresh `mulberry32(seed XOR channel)` PRNG
  per call, repeated reads of the same `[4500..4600]` window draw
  different noise samples each time, so the trap deviates from the
  Chrome baseline value the CreepJS team hardcoded. Two paths forward
  for v0.6: (a) memoize per-`(buffer-id, channel-id, sample-index)`
  noise so all three methods return identical noised samples (closes
  trap; spec change to noise determinism — currently per-call); (b)
  inspect the upstream trap formula and pre-compute a baseline-matching
  noise distribution. Yellow `lies` does not gate the WebGL fallback
  the way `bold-fail` does, and no other detector in the 12-site suite
  penalizes it.
- **CreepJS WebGL bold-fail persists for all 4 built-in profiles**
  (carried over from v0.4, unchanged). Phase 5.3 capture + convert
  pipeline is the long-term path: any user can now contribute an
  authentic capture from their machine that may hit a CreepJS-whitelisted
  hash, growing `KNOWN_PROFILES` beyond the 4 built-ins. Blind brute-
  force remains mathematically infeasible (Phase 2.2 Part 2 math:
  per-attempt hit probability ≈ 5.5e-8). The convert tool always emits a
  paste-ready snippet even on whitelist miss — the GPU-persona
  flexibility benefit (Intel iGPU vs NVIDIA / AMD desktop) applies
  regardless of CreepJS whitelist.

After Phase 5.4 + 5.4b + 5.4c the v0.5.0 visible report hits collapse
to: **2 reds** (CreepJS WebGL bold-fail + browserleaks-canvas 100%
uniqueness) + **1 yellow** (CreepJS Audio `trap` lies, hash shifted
from `b726173b` to `17db53bb` after one of two CreepJS cross-checks
was closed by 5.4c). Down from v0.4's 3 reds + the 22-line phantom
block; all 3 remaining hits are documented above as long-term known
limits.

### Bench

- **Phase 5.2 / 5.4c 12-site re-runs**
  (`bench/results/2026-05-17T01-04-37-334Z` → pre-5.2b;
  `bench/results/2026-05-17T01-27-18-536Z` → post-5.2b;
  `bench/results/2026-05-17T04-44-25-195Z` → post-5.4c). 12/12 sites OK
  all three runs. Total visible hits 28 → 25 → **3** (after Phase 5.4
  parser-noise removal: 22 phantom creepjs `<unknown>` entries dropped,
  leaving the 2 reds [creepjs WebGL bold-fail + browserleaks-canvas
  uniqueness 100%] + 1 yellow [creepjs Audio `trap` lies, hash
  `17db53bb` post-5.4c, was `b726173b` pre-5.4c]). All 3 documented as
  long-term known limits above.

### Tests

- **persona-schema**: 21 → 26 (Phase 5.1 introduced 5 new under
  `AudioFingerprintSchema noiseAmplitudeDb`).
- **sdk**: 318 → 366. Breakdown:
  - +2 `runner-audio` (Phase 5.1 dB-noise visibility + bound).
  - +3 `runner-audio` (Phase 5.2b silent-sample preservation + full-
    silence buffer + PRNG-advance invariant).
  - +22 `convert-captured-profile` (Phase 5.3 round-trip / verify /
    brand / id-suggest / regex-suggest / TS-emit).
  - +8 `sites-creepjs` (Phase 5.4 extractCreepjs discriminator + hex
    regex + STRONG-sibling guard + real bench-fixture regression).
  - +7 `convert-captured-profile` (Phase 5.4b detectSoftwareRenderer:
    Microsoft Basic Render Driver / SwiftShader / llvmpipe / generic
    + 3 real-GPU negative controls).
  - +8 `runner-audio` / `runner-worker` (Phase 5.4c
    `copyFromChannel` / `copyToChannel` cross-path noise invariants;
    5 main-scope + 3 worker-scope sandbox).
- **typecheck clean**: persona-schema + sdk + desktop all `tsc --noEmit`
  pass. **Tests**: 366/366 sdk + 26/26 persona-schema all pass on
  post-5.4c HEAD.

### Internal

- **`bench/PHASE-5-PLAN.md`** added documenting the v0.5 plan.
- **MockAudioBuffer** in `runner-audio.test.ts` gained an optional
  `fill` callback so silent-pattern tests can inject zero buffers
  without ad-hoc Float32Array poking.

---

## [0.4.0] — 2026-05-16

The **"v0.4 audio closure + multi-GPU + chromium-fork bridge"** release.
Closes the last major SDK-level fingerprint gap (audio), broadens GPU
persona choice, and opens the chromium-fork enterprise-detector workstream
with three new patch design specs (no native build yet — chromium-fork
remains in cold storage; see `chromium-fork/STATUS.md`).

- **Phase 4.1 – 4.2**: AudioBuffer hook in main + worker scope.
- **Phase 4.3**: CreepJS WebGL second round — NVIDIA RTX 3060 / AMD RX
  6600 alt profiles + verify pipeline.
- **Phase 4.4**: Enterprise detector landscape + 3 new chromium-fork
  patch design specs (`0002 webgl-renderer`, `0016 headless-bypass`,
  `0017 audio-noise`).

### Added

- **Phase 4.1 — AudioBuffer.getChannelData hook (main scope)**
  (`runner.ts §6`): Closes the classic CreepJS / fp.com / FingerprintJS
  audio fingerprint path (`new OfflineAudioContext() → oscillator + dynamicsCompressor →
  startRendering().then(buf.getChannelData)`), which ran completely
  un-spoofed up to v0.3. In-place mulberry32 noise per channel (seed XOR
  channel index → distinct left/right sequences; amplitude
  `audioNoiseAmplitude=1e-7`, well below 16-bit PCM ULP; inaudible but
  shifts `sum.toString()` enough to make `hashMini` per-persona unique).
  New file `runner-audio.test.ts` (9 tests covering noise injection /
  determinism / per-channel XOR / amplitude bound / out-of-range
  forward / v0.2 regression).
- **Phase 4.2 — AudioBuffer worker IIFE mirror** (`runner.ts §11`):
  Mirrors main-scope §6 hook into worker realm. `workerSpoofPayload`
  carries `audioNoiseSeed` + `audioNoiseAmplitude`. Closes worker-scope
  audio fingerprint path (OfflineAudioContext is exposed to dedicated
  workers; without this hook, CreepJS / fp.com audio probes in workers
  would bypass main-scope spoof entirely). 8 new tests in
  `runner-worker.test.ts` (6 static + 2 sandbox execution asserting
  hook is live with per-channel XOR).
- **Phase 4.3 — NVIDIA RTX 3060 + AMD RX 6600 alt WebGL profiles**
  (`webgl-profiles.ts`): `KNOWN_PROFILES` 2 → 4. Gives users
  detector-friendly GPU persona choice (Intel iGPU vs gaming GPU)
  beyond the Intel UHD 630/730 defaults. Both profiles built from
  public webgl fingerprint databases + ANGLE D3D11 backend reports;
  NVIDIA Ampere differs from Intel iGPU on `MAX_VIEWPORT_DIMS` (32767
  vs 16384), `MAX_TEXTURE_IMAGE_UNITS` (32 vs 16),
  `MAX_3D_TEXTURE_SIZE` (16384 vs 2048), `ALIASED_POINT_SIZE_RANGE`
  ([1, 63] vs [1, 1024]), and Ampere-specific `MAX_SAMPLES=32` +
  `MAX_UNIFORM_BUFFER_BINDINGS=84`. AMD RDNA2 sits closer to Intel iGPU
  on viewport / point-size but matches NVIDIA on texture-unit count and
  3D-texture size.
- **Phase 4.3 — `bench/verify-creepjs-profile-hash.ts`** (new tool):
  Automated verification — runs every `KNOWN_PROFILES` entry through
  the CreepJS `capabilitiesHash` (XOR reduce) + `brandCapabilities`
  (hashMini) algorithms and reports whether the result hits the
  hardcoded whitelist (237 cap hashes + 287 brand hashes). Refactored
  shared CreepJS whitelist data into `bench/creepjs-whitelist-data.ts`
  (lib shared with `find-creepjs-whitelist-fit.ts`).
- **Phase 4.3 — 18 new webgl-profiles tests**: Cover RTX 3060 / RX 6600
  match-renderer regex strictness, key differentiating param values vs
  Intel iGPU, and `selectWebglProfileForPersona` multi-profile
  branching.
- **Phase 4.4 — `docs/ENTERPRISE-DETECTORS.md`** (new doc):
  Comprehensive landscape of 6 commercial bot detectors (Castle.io,
  Imperva ABP, DataDome, Cloudflare BM, PerimeterX, Akamai BM) with
  technical breakdown / Mosaiq SDK current coverage / chromium-fork
  patch candidates + v1.0 priority matrix.
- **Phase 4.4 — 3 new chromium-fork patch design specs** (`chromium-fork/patches/`):
  - `0002-webgl-renderer-spoof.spec.md` (P2): GL_VENDOR / GL_RENDERER
    + 49-param spoof in ANGLE / GPU process layer, replacing SDK
    Proxy path to eliminate `Function.prototype.toString` reverse +
    cross-realm prototype comparison detection risk.
  - `0016-headless-detection-bypass.spec.md` (P2): Strip CDP
    `Page.IsAutomatedTask` method, `HeadlessChrome` UA fragments, and
    `--enable-automation` renderer-side exposure; re-enable WebGL2 +
    ServiceWorker in `--headless=new` mode when `PersonaService` is
    active.
  - `0017-audio-fingerprint-noise.spec.md` (P3): Blink AudioBuffer
    C++-level mulberry32 noise injection, replacing SDK §6 + Phase 4.2
    worker mirror; also resolves the AnalyserNode dB+Float32 ULP
    quantize limitation noted below.
- **`chromium-fork/patches/series.txt`** updated with the 3 new entries
  and priority markers (P0/P1/P2/P3).
- **`chromium-fork/STATUS.md`** updated with Phase 4.4 activity log
  (cold storage status unchanged).

### Documented (known limitations)

- **AnalyserNode dB-scale noise silently quantized** (v0.2 limitation
  surfaced by Phase 4.1 tests): `AnalyserNode.getFloatFrequencyData`
  returns dB values (-100 to 0). The 1e-7 `audioNoiseAmplitude` default
  is far below Float32 ULP at that magnitude (~7.6e-6), so the noise
  is rounded back to baseline. Hook installs cleanly (no regression),
  but produces no observable noise. **PCM path
  (`AudioBuffer.getChannelData`) is unaffected** — value range -1..1
  makes 1e-7 visible. v0.5 will add a separate
  `audioNoiseAmplitudeDb` field for dB-aware noise.
- **CreepJS WebGL bold-fail persists for all 4 built-in profiles**:
  Phase 4.3 verify-tool result — Intel UHD 630/730, NVIDIA RTX 3060,
  AMD RX 6600 all miss both CreepJS whitelists (PASS=0, FAIL=4).
  Confirms Phase 2.2 Part 2 math (blind hit probability ≈ 5.5e-8). Not
  a Mosaiq spoof flaw — real RTX 3060 / RX 6600 users hit the same
  outcome. v0.5+ path is a real-hardware capture pipeline (users
  submit their authentic webglParams; `verify-creepjs-profile-hash`
  reusable as the validator). Phase 4.3 value lies in (a) GPU-persona
  flexibility (iGPU vs gaming card), (b) other detectors
  (`browserleaks-webgl`, `arh-antoinevastel`, `incolumitas`) don't rely
  on the CreepJS whitelist, so alt profiles still spoof effectively.

### Changed

- **`KNOWN_PROFILES` array order preserved** for regex matching priority
  — UHD 630 (`\b630\b` stricter) still leads the array; new NVIDIA / AMD
  entries follow Intel. All 4 regexes are mutually exclusive, so
  order does not affect runtime behavior.
- **`InjectionConfig.audioNoiseSeed` + `audioNoiseAmplitude` now flow
  into `workerSpoofPayload`** alongside existing canvas/webgl fields.

### Verification

- **Tests**: persona-schema 21/21, sdk **316/316** (281 → 316, +35
  since v0.3.0: +9 `runner-audio.test.ts`, +8 `runner-worker.test.ts`
  audio mirror, +18 `webgl-profiles.test.ts` NVIDIA/AMD profile).
- **Typecheck**: clean across 3 packages.
- **`bench/verify-creepjs-profile-hash.ts`**: PASS=0, FAIL=4 (expected
  per Phase 2.2 Part 2 math; see "Documented" above).
- **Bench**: 12-site `baseline-detection.ts` not re-run for this
  release. v0.4 changes are additive (audio hook is `typeof
  AudioBuffer`-guarded; new GPU profiles only match via explicit
  `webglProfileId` or matching renderer regex). No spoof surface
  regression risk on existing personas. v0.5 will include a fresh
  12-site bench run with audio surface validation.

### Migration from 0.3.0

No breaking changes. Persona files saved under 0.3.0 remain valid.

- **Opt into NVIDIA / AMD GPU personas**: Set
  `persona.hardware.gpu.webglProfileId = 'nvidia-rtx-3060-d3d11'` or
  `'amd-rx-6600-d3d11'` and update `webglRenderer` / `webglVendor` to
  match. Existing Intel UHD 630/730 personas continue to work
  unchanged.

---

## [0.3.0] — 2026-05-16

The **"v0.3 defensive depth + measurement accuracy"** release. Builds on
v0.2.0 anti-detection engine with three new phases plus consolidated
Phase 2.5–2.6 work that was deferred from v0.2.0:

- **Phase 2.5 – 2.6** (consolidated): Worker scope full mirror (WebGL
  49-param + OffscreenCanvas) and baseline expanded from 9 → 12 sites.
- **Phase 3.1 – 3.3** (this release): Error.stack frame poisoning hardening,
  bench retry mechanism, Castle.io commercial detector limitation
  documented.

### Added

- **Worker scope full mirror** (`Phase 2.6`): Worker IIFE now mirrors
  main scope WebGL 49-param spoof + OffscreenCanvas noise injection +
  `navigator.webdriver` spoof. Was previously partial (2 WebGL params,
  no canvas). Closes CreepJS worker-scope `does not match` flags. 23
  new tests in `runner-worker.test.ts`.
- **3 new baseline detection sites** (`Phase 2.5`): `arh-antoinevastel`
  (Datadome Fp-Scanner 22-rule three-state detector), `incolumitas`
  (multi-section JSON detector including Worker scope navigator props),
  `fingerprint-scan` (Castle.io commercial bot risk score).
  9 → **12** sites in `bench/baseline-detection.ts`.
- **Phase 3.1 — Error.stack frame poisoning hardening** (`runner.ts §13`):
  Installs V8 `Error.prepareStackTrace` global hook in main + worker
  scopes. Filters suspicious frames (`utilityscript`, `blob:`,
  `puppeteer`, `playwright`, `__playwright__`, `__pwInitScripts`,
  `puppeteerExtra`, `evaluationScript`, `cdp.`, `devtools`) before they
  enter user-visible `error.stack`. Defends against detectors that throw
  `ReferenceError` and inspect stack content for automation signatures.
  10 new unit tests. `Function.prototype.toString` stealth preserved via
  manual `stealthRegistry.set` (no Proxy wrap → avoids source-code leak).
- **Phase 3.2 — bench retry mechanism** (`baseline-detection.ts`):
  `runOneWithRetry` wrapper with exponential backoff (1s/2s/4s).
  `RETRIES=N` env (default 2 = 3 total attempts). `SiteResult.retries`
  field + report metadata surfaces measurement reliability. Prevents
  single flaky site (dbi-bot intermittent 60s gateway timeouts) from
  failing the full bench.
- **2 diagnostic probes** (`bench/probe-error-stack.ts`,
  `bench/probe-fpcollect-source.ts`): Direct-injection scripts for
  rapid Error.stack reconnaissance and fp-collect source inspection.
  Drove the Phase 3.1 implementation + Phase 3.3 Castle.io discovery.

### Changed

- **12-site bench hits**: 5 → **2** (Phase 3 cycle). Remaining 2 hits
  are Phase 2 already-documented limitations:
  - `creepjs WebGL bold-fail` (Phase 2.2 negative reverse-fit, CreepJS
    whitelist gap for Intel UHD 730)
  - `browserleaks-canvas uniqueness=100%` (Phase 2.4 per-persona
    uniqueness tradeoff)
- **`extractIncolumitas.knownBadKeys`**: Removed `'webdriver'`.
  Recon via `probe-fpcollect-source.ts` revealed that incolumitas's
  modified fp-collect uses `webDriver: 'webdriver' in navigator`, which
  is **always true on every modern Chrome user** (W3C WebDriver
  Recommendation 2018+ mandates `navigator.webdriver` to exist). This
  was a false positive in our analyzer, not a spoof leak.
- **`analyzeAntoinevastel.KNOWN_OUTDATED_RULES`**: Added `WEBDRIVER` to
  whitelist. fp-scanner 2017 vintage uses same `'webdriver' in navigator`
  check via fp-collect, predating W3C spec update → flags every modern
  Chrome user as Inconsistent. Now shown as ℹ️ informational, not red flag.
- **`analyzeFingerprintScan` Castle.io demote** (`Phase 3.3`):
  Recon revealed `<script src=".../castle.browser.js">` — fingerprint-scan.com
  is a Castle.io commercial detector marketing demo. 75/100 score is
  Castle's enterprise black-box output (out-of-scope for SDK injection
  layer). Demoted to ℹ️ note (same tier as CreepJS WebGL bold-fail).
- **Worker scope `navigator.webdriver` spoof** (`Phase 2.6.1`): Phase 2.6
  worker IIFE `defs` array initially missed `webdriver`. Added — fixes
  worker-realm `navigator.webdriver=true` leak. Discovered via Phase 2.5
  bench against `incolumitas` "Web Worker Navigatory Property" section.
- **`arh-antoinevastel` extractor** (`Phase 2.6.1`): Initial regex used
  `\b(Consistent|Unsure|Inconsistent)\b` word boundary on tr.textContent
  which couldn't match `RULEConsistent{...}` (no separator between
  cells). Rewrote to parse `table#scanner tbody tr` 3-`<td>` structure
  directly. 0 rows → 21 rows captured.

### Documented (known limitations)

- **fingerprint-scan (Castle.io) commercial detector**: Reverse engineering
  Castle.io's minified browser fingerprinter + black-box server-side
  scoring is out-of-scope for v0.3 SDK injection layer. Castle.io
  reverse should be addressed in v0.4+ chromium-fork patches.

### Verification

- **Tests**: persona-schema 21/21, sdk **281/281** (248 → 281, +10 Phase 3.1
  stack hardening + 23 Phase 2.6 worker).
- **Typecheck**: clean across 3 packages.
- **Bench**: 12-site `baseline-detection.ts` ran 12 OK / 0 FAIL,
  hits=**2** (both Phase 2 already-documented known-limits).
  Latest result: `bench/results/2026-05-16T13-25-39-879Z/`.
- **Probe**: `bench/probe-error-stack.ts` confirms zero suspicious
  frames in main + worker scopes post-Phase 3.1 hook.

### Migration from 0.2.0

No breaking changes. Persona files saved under 0.2.0 remain valid.

---

## [0.2.0] — 2026-05-16

The **"v0.2 anti-detection engine"** release. Builds on the v0.1.0 Persona +
Electron foundation with two major anti-fingerprinting phases:

- **Phase 1.5 – 1.9b** (consolidated): Worker-scope spoof, UA Client Hints,
  CDP detection hardening, navigator-lies fix, full WebGL 49-parameter spoof.
- **Phase 2.1 – 2.4** (this release): Multi-profile WebGL infrastructure,
  second built-in GPU profile (UHD 630), CreepJS limitations documentation,
  canvas spoof double-guard defeating CreepJS lies + LowerEntropy.CANVAS.

### Added

- **WebGL profile selection** (`Phase 2.1`): `Persona.hardware.gpu.webglProfileId`
  field lets users explicitly select a built-in WebGL profile, bypassing the
  default regex-based renderer matching. Typo-tolerant: unknown id falls back
  to regex match.
- **Second built-in WebGL profile** (`Phase 2.2 part 1`): `intel-uhd-630-d3d11`
  for `win10-chrome-us` template. Brings full 49-parameter coverage (vs
  v0.1.0 UNMASKED-only fallback) on Windows 10 personas → defeats cross-check
  fail on non-CreepJS fingerprinters.
- **Canvas spoof double-guard** (`Phase 2.4`): Two new helpers in
  `runner.ts` §5 — `isProbeCanvas` (skip ≤16×16 canvases) and `isAllZero`
  (skip cleared/transparent regions). Defeats CreepJS's two independent
  canvas detections:
  - `CanvasRenderingContext2D.getImageData: pixel data modified` lie
    (cleared 8×8 region read on 50×50 canvas after clearRect)
  - `LowerEntropy.CANVAS = true` from `suspicious pixel data` (hardcoded
    `KnownImageData.BLINK/GECKO/WEBKIT` whitelist comparison on 2×2 probe)
- **WebGL 49-parameter spoof** (`Phase 1.9 / 1.9b`): Full ANGLE D3D11 backend
  parameter coverage for `intel-uhd-730-d3d11` profile —
  `MAX_TEXTURE_SIZE`, `MAX_VIEWPORT_DIMS`, `ALIASED_*_RANGE`, and 46 others.
  String params (`VENDOR`, `RENDERER`, `VERSION`, `SHADING_LANGUAGE_VERSION`)
  now also covered.
- **UA Client Hints full spoof** (`bdf5b89`): `navigator.userAgentData`
  brands, fullVersionList, platform, platformVersion, architecture, bitness,
  wow64, model — all spoofed in main + worker scope. Prevents
  `"HeadlessChrome"` brand leak via UA-CH reduction.
- **Worker scope hardening** (`Phase 1.5`): SDK injects spoof block into
  ServiceWorker / DedicatedWorker / SharedWorker scripts. Eliminates CreepJS
  worker `lies` count (Navigator API parity main ↔ worker).
- **CDP detection hardening** (`Phase 1.6`): Patches `Runtime.evaluate` /
  `Inspector.detached` indicators. Adds 3 new baseline sites for CDP
  detection coverage.
- **Rebrowser-patches integration** (`Phase 1.7.1`): Applies upstream
  rebrowser patches to `playwright-core@1.59.1` for additional headless
  signature removal.
- **15 new tests** for canvas spoof Phase 2.4 (`runner-canvas.test.ts`),
  using polyfilled `CanvasRenderingContext2D` + `ImageData` (happy-dom lacks
  both). Total SDK tests: 209 → **248**.
- **Persona-schema tests** for `webglProfileId` derivation + override
  validation: 17 → **21**.

### Changed

- **CreepJS lies count**: 10 → 2 (Phase 1.x rollup). Remaining 2 are
  documented as data-coverage limitations (see below).
- **`build-config.ts` WebGL profile selection**: Now uses high-level
  `selectWebglProfileForPersona(persona)` API instead of inline regex
  match, supporting `webglProfileId` override.
- **`packages/persona-schema/README.md`**: New `WebGL profile 选择 (v0.3+)`
  section documenting `webglProfileId` field + 2 built-in profiles + the
  CreepJS WebGL bold-fail expectation.

### Documented (known limitations)

- **CreepJS WebGL bold-fail expected** (`Phase 2.2 part 2`, `Phase 2.3`):
  All 4 built-in persona templates trigger `LowerEntropy.WEBGL` on
  creepjs.com. Root cause: CreepJS's hardcoded GPU whitelist (237 capability
  hashes + 287 brand hashes) has joint density ~3.7e-15 vs the 2^32 hash
  space. Blind reverse-fit is mathematically infeasible (~2.7×10¹⁴ expected
  tries). Real-hardware Intel UHD 730 users hit the same outcome. Not a
  spoof flaw; documented in `packages/sdk/bench/PHASE-2-PLAN.md` Phase 2.2
  Part 2 with full analysis tool (`bench/find-creepjs-whitelist-fit.ts`).

### Fixed

- **Navigator lies regression** (`Phase 1.8`): Several `Navigator.prototype`
  getters were leaving `own property` traces detectable by CreepJS's
  `failed own property` check. Now all spoof via `defineProtoGetter` →
  prototype-only, instance-clean.
- **Canvas spoof noise on cleared regions**: v0.1.0 added ±1 LSB noise to
  ALL pixels including transparent ones, causing CreepJS to flag canvas as
  modified even on fresh `clearRect`. Phase 2.4 `isAllZero` guard fixes.

### Verification

- **Tests**: persona-schema 21/21, sdk 248/248 (15 new canvas tests).
- **Typecheck**: clean across 3 packages (`@runova/persona-schema`,
  `@runova/sdk`, `@mosaiq/desktop`).
- **Bench**: `packages/sdk/bench/baseline-detection.ts` available for
  end-to-end Chromium validation (user-runnable; not auto-executed).

### Migration from 0.1.0

No breaking changes. Persona files saved under 0.1.0 remain valid; new
optional `hardware.gpu.webglProfileId` field defaults to `undefined`
(regex fallback retains v0.1.0 behavior for win11).

---

## [0.1.0] — 2026-05-07

Initial public release. See git tag `v0.1.0`.

- Persona schema + 4 templates (`win11-chrome-us`, `win10-chrome-us`,
  `macos-chrome-us`, `ubuntu-chrome-us`)
- SDK injection engine: navigator / screen / Intl / WebGL / Canvas / Audio
  / fonts / WebRTC spoof via Playwright `addInitScript`
- Electron desktop shell with Persona browser launcher
- humanize input engine (mouse jitter, keystroke timing)
- 9-site baseline detection bench (creepjs, sannysoft, browserleaks, etc.)

[0.5.0]: https://github.com/meilimei/Mosaiq/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/meilimei/Mosaiq/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/meilimei/Mosaiq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/meilimei/Mosaiq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/meilimei/Mosaiq/releases/tag/v0.1.0
