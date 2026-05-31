# Releasing Mosaiq

> Maintainer runbook for cutting an npm release of the publishable packages
> (`@runova/persona-schema`, `@runova/sdk`, `@runova/cli` on the lock-step 0.10
> trio; `@runova/cloud-sdk` on the independent 0.11 cloud track) and shipping the
> Detection Lab CI baseline alongside. npm scope go-live checklist: [§8](#8-当前状态--go-live-checklistnpm-mosaiq-scope).
>
> 范围: 本文 = "我是 maintainer，怎么从一个 clean `main` 走到三包上 npm + git
> tag + GitHub Release 页 + CI gate 生效" 的端到端清单。
>
> 设计稿（why）: `docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md` §8 (Track A
> 发行) + §10-12 (Track B CI gate)。本文 = 设计稿的 hands-on 浓缩版。

---

## 0. TL;DR — 第一次发版 (v0.10.0)

一次性 setup（[§1](#1-pre-flight-一次性-setup)）走完后：

```bash
# 1. 在干净 main 上跑一次完整 release dry-run
pnpm install --frozen-lockfile
pnpm typecheck && pnpm -r test
pnpm --filter "@runova/persona-schema" --filter "@runova/sdk" --filter "@runova/cli" build
pnpm audit-tarballs                 # tarball 文件清单 + size sanity
pnpm check-sdk-patch-drift          # 确认 patches/playwright-core.patch 与 SDK 同步
pnpm --filter "@runova/persona-schema" publish --dry-run --access public
pnpm --filter "@runova/sdk"            publish --dry-run --access public
pnpm --filter "@runova/cli"            publish --dry-run --access public

# 2. 真发（顺序敏感: persona-schema → sdk → cli）
pnpm --filter "@runova/persona-schema" publish --access public
pnpm --filter "@runova/sdk"            publish --access public
pnpm --filter "@runova/cli"            publish --access public

# 3. 外部 smoke（新机器视角）
cd $(mktemp -d) && npm init -y >/dev/null
npm i @runova/cli@0.10.0
npx mosaiq --version          # → 0.10.0
npx playwright install chromium
npx mosaiq personas templates list   # → win11/win10/macos/ubuntu 4 个模板

# 4. Tag + Release 页
git tag v0.10.0 -m "v0.10.0 — npm distribution + Detection Lab CI gate"
git push origin v0.10.0
# 然后到 https://github.com/meilimei/Mosaiq/releases/new 选 tag = v0.10.0,
# body 复制 CHANGELOG.md 的 [0.10.0] 段

# 5. Detection Lab baseline bootstrap (一次性, 详见 §5)
#   → 触发 detection-lab.yml 在 main 上跑一次
#   → 下 candidate artifact, write-baseline, commit, push
```

后续 v0.10.x / v0.11.0 走 changesets 自动化路径：[§4](#4-后续发布-via-changesets)。

---

## 1. Pre-flight — 一次性 setup

只需做一次（per maintainer）。后续每次发版从 [§3](#3-首次发版-v0100-手工) 起跳。

### 1.1 工具版本

```text
node     >= 20.10.0   # see .nvmrc
pnpm     >= 9.0.0     # repo pin: 9.12.0
git      >= 2.40      # 任何近代版本都行
gh       >= 2.40      # GitHub CLI, 用于 release 页 + artifact 下载
```

`gh auth login` 至少一次，scope 含 `repo` + `read:packages`。

### 1.2 npm org + 2FA

1. 在 npmjs.com 注册并启用 **2FA (TOTP)**。
2. 使用已有 org **`runova`**（`@runova/*`）。**不要**尝试创建 `@mosaiq` org（该 scope 已被他人占用）。
3. 把 maintainer 账号加为 `@runova` org 的 owner / developers team（read-write）。
4. 在 https://www.npmjs.com/settings/<user>/tokens 创建 **Granular Access
   Token**（**不要** Classic）:
   - Permissions: `Read and write` on packages under `@runova` scope
   - Expiry: 90 days（强制 rotate）
   - **不要** 给 owner / admin / org-management 权限
5. 把 token 存到本地 `~/.npmrc`:
   ```text
   //registry.npmjs.org/:_authToken=<the-token>
   ```
6. 同时把 token 加到 GitHub repo `Settings → Secrets and variables →
   Actions → New repository secret`，name = `NPM_TOKEN`。release.yml
   workflow 自动化时会用。

### 1.3 验证本地环境

```bash
# clean clone, 不要在脏 working tree 上发版
git clone git@github.com:meilimei/Mosaiq.git mosaiq-release
cd mosaiq-release
pnpm install --frozen-lockfile
pnpm typecheck
pnpm -r test
pnpm --filter "@runova/persona-schema" --filter "@runova/sdk" --filter "@runova/cli" build
```

全绿 = 环境 OK。任何一项失败 → 先修，不要发版。

---

## 2. Versioning 策略 — 两条可行路径

`main` HEAD 现在包含:

- **Track A** (Phase 10.1-10.5): npm 公开发行的工程基建。三包 `package.json`
  里的 `version` 字段已经在 10.5 里被 bump 成 `0.10.0`，CHANGELOG.md 有
  `## [0.10.0]` 完整段
- **Track B** (Phase 10.6a/10.6b/10.7/10.8/10.9): Detection Lab CI gate +
  baseline 自动 refresh + sticky PR comment。**未** 单独 bump 版本号，挂在
  CHANGELOG.md `## [Unreleased]` 下

发版前要决定怎么打包 Track B：

### 路径 X — 一次性 v0.10.0 (推荐)

把 Track B 合并进 `## [0.10.0]` 段，一次发 `v0.10.0`。

**优点**:
- 三包从来没在 npm 上出现过，外部用户对"v0.10.0 应该包含什么"没有预期
- npm tag 数 = 1，git tag 数 = 1，认知简单
- v0.10 设计稿（`V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md`）就是双轨方案，
  v0.10.0 = 双轨完整 ship 与文档一致

**操作**:
1. 编辑 `CHANGELOG.md`: 把 `## [Unreleased]` 里 10.6a/10.6b/10.7/10.8/10.9
   的 5 个段合并到 `## [0.10.0]` 段尾部（保持时间顺序），删除
   `## [Unreleased]` 标题
2. 不动 `package.json` version（已经是 0.10.0）
3. 走 [§3](#3-首次发版-v0100-手工)

### 路径 Y — 拆 v0.10.0 + v0.10.1

把 Track A 发 `v0.10.0`，Track B 单独发 `v0.10.1`。

**优点**:
- npm release notes 更细粒度，外部用户能看到"啊原来 0.10.1 是加 CI gate
  的"
- 如果 Track B 有 bug，可以单独 deprecate 0.10.1 而不影响 0.10.0

**缺点**:
- 多一次完整 publish + tag + Release 页的工作量
- 0.10.0 → 0.10.1 时间窗如果很短（半天内），外部用户感知不到差异

**操作**:
1. 在 `886a5bc` (10.6a 之前的 commit) 上打 tag `v0.10.0` 并发 npm
   （需要 `git checkout 886a5bc^` → cherry-pick / 回退一次复杂操作）
2. 回到 `main` HEAD，跑 `pnpm changeset` 写一个 patch bump changeset
3. 让 release.yml 自动开 "version packages" PR，merge 后自动发 0.10.1

**结论**: 除非你对 release notes 粒度有强偏好，**走路径 X**。本文剩余
小节默认路径 X。

---

## 3. 首次发版 (v0.10.0) — 手工

> 为什么手工: `.changeset/README.md` 明确写了 "v0.10.0 first publish
> 走手工"。原因 = release.yml 假设 changesets 有 pending bumps，但首次
> 发版我们直接用 `package.json` 里已经 hand-bumped 的 `0.10.0`，没有
> pending changeset。所以 release.yml 在 v0.10.0 时不会触发 publish。

### 3.1 CHANGELOG 整理（如走路径 X）

```bash
git switch main
git pull --ff-only
```

打开 `CHANGELOG.md`，做两件事:

1. 把 `## [Unreleased]` 整段（含 10.6a/10.6b/10.7/10.8/10.9）移动到
   `## [0.10.0] — 2026-05-21` 段尾部
2. 删除空的 `## [Unreleased]` 段（下次发版时再手工加回）

提交:

```bash
git add CHANGELOG.md
git commit -m "chore(release): merge track B (10.6-10.9) into v0.10.0 changelog"
```

### 3.2 Clean state check

```bash
git status                  # 必须 nothing to commit, working tree clean
git log --oneline -5        # 确认 HEAD 是你预期的发版点
rm -rf node_modules packages/*/node_modules apps/*/node_modules
rm -rf packages/*/dist apps/*/dist
pnpm install --frozen-lockfile
```

### 3.3 全部 gate 跑一遍

```bash
pnpm typecheck
pnpm -r test
pnpm lint
pnpm check-sdk-patch-drift
pnpm audit-tarballs
pnpm --filter "@runova/persona-schema" --filter "@runova/sdk" --filter "@runova/cli" build
```

任何一项红 → 修，不要硬发。

### 3.4 Dry-run 三发

```bash
pnpm --filter "@runova/persona-schema" publish --dry-run --access public
pnpm --filter "@runova/sdk"            publish --dry-run --access public
pnpm --filter "@runova/cli"            publish --dry-run --access public
```

每包 stdout 末尾会列 tarball contents。逐个 review:

- ✅ `package.json` / `README.md` / `LICENSE` / `dist/` 全在
- ✅ `@runova/sdk` 的 `patches/playwright-core@1.59.1.patch` 在
  （否则 postinstall apply 会失败）
- ❌ 任何 `src/`、`.ts`（不含 .d.ts）、`tsconfig.json`、`*.test.ts`
  **不应** 出现 — 如果有，先修 `.npmignore` 再继续
- ❌ tarball size 异常（任一包 > 5 MB 都该 review，正常 sdk ~1.5 MB，
  cli ~200 KB，persona-schema ~30 KB）

### 3.5 真发

> ⚠️ 顺序敏感: `@runova/sdk` 依赖 `@runova/persona-schema`，
> `@runova/cli` 依赖前两者。**必须按 schema → sdk → cli 顺序**，
> 否则 npm 解析依赖会拉到旧版本（不存在的版本）然后失败。

```bash
# 本地首发请关 provenance（无 GitHub OIDC 会 EUSAGE）：
#   cd packages/<pkg> && npm publish --access public --provenance=false
# 或 PowerShell 一键（repo 根目录）：
#   .\scripts\npm-first-publish.ps1

pnpm --filter "@runova/persona-schema" publish --access public
# 等 npm OTP prompt → 输入 6 位
pnpm --filter "@runova/sdk"            publish --access public
pnpm --filter "@runova/cli"            publish --access public
pnpm --filter "@runova/cloud-sdk"      publish --access public
```

发完每包后 sanity:

```bash
npm view @runova/persona-schema version    # → 0.10.0
npm view @runova/sdk version               # → 0.10.0
npm view @runova/cli version               # → 0.10.0
```

### 3.6 External smoke

**关键步骤**: 模拟外部新用户视角，确认 `npm i` → `npx mosaiq` 端到端
跑得通。

```bash
TMP=$(mktemp -d)
cd "$TMP"
npm init -y >/dev/null
npm i @runova/cli@0.10.0
npx mosaiq --version                       # 应该是 0.10.0
npx mosaiq personas templates list         # 应该列 4 个 (win11/win10/macos/ubuntu)
npx playwright install chromium            # @runova/sdk 依赖 playwright-core
                                           # postinstall 应该自动 apply patch
ls node_modules/playwright-core/lib/server/chromium/crPage.js | head -1
grep -c "REBROWSER_PATCHES" node_modules/playwright-core/lib/server/chromium/crPage.js
# > 0 = patch applied OK; 0 = patch 没生效, 调查 patch-package log
```

任一步 fail → **立刻** `npm unpublish` 撤回（72h 内可全撤；之后只能 deprecate）：

```bash
npm unpublish @runova/cli@0.10.0 --force
npm unpublish @runova/sdk@0.10.0 --force
npm unpublish @runova/persona-schema@0.10.0 --force
```

修复后从 [§3.2](#32-clean-state-check) 重来。

### 3.7 Tag + GitHub Release

```bash
git tag v0.10.0 -m "v0.10.0 — npm distribution + Detection Lab CI gate"
git push origin v0.10.0
```

到 https://github.com/meilimei/Mosaiq/releases/new

- Tag: `v0.10.0`
- Title: `v0.10.0 — npm distribution + Detection Lab CI gate`
- Body: 把 `CHANGELOG.md` 的 `## [0.10.0]` 段复制进去，去掉顶层 `##`
- ✅ "Set as the latest release"
- ❌ "Set as a pre-release"

发布。

---

## 4. 后续发布 (via changesets)

从 `v0.10.1` 起，发版流程切到自动化：

### 4.1 PR 流程

每个 PR 里加一个 changeset:

```bash
pnpm changeset
# 1. 选包: 因为 fixed group, 选任一即三包齐 bump
# 2. 选 bump 类型: patch / minor / major
# 3. 写一句 summary（会进 release PR body，不进 CHANGELOG.md）
git add .changeset/<generated-name>.md
```

跟 PR 一起 commit + push。Merge 进 main 后：

### 4.2 release.yml 自动 open release PR

`.github/workflows/release.yml` 监听 push:main，检测到有 `.changeset/*.md`
就 open 或更新一个 `chore(release): version packages` PR，bumps
versions、消耗 changeset 文件、写 commit。

### 4.3 Maintainer 编辑 CHANGELOG

打开 release PR，手动编辑 `CHANGELOG.md` 加 `## [X.Y.Z]` 段，Chinese
narrative，参考 `## [0.10.0]` 风格。push 到 release PR。

### 4.4 Merge release PR

merge 后 release.yml 再次触发，检测到没有 pending changesets，**自动**
跑 `pnpm changeset publish`:

- 三包上 npm
- 自动打 git tag `@runova/persona-schema@X.Y.Z` 等（**注意：不是
  `vX.Y.Z`**）

### 4.5 Maintainer 手工创建 `vX.Y.Z` tag + Release 页

```bash
git switch main
git pull --ff-only
git tag vX.Y.Z -m "vX.Y.Z — <one-line summary>"
git push origin vX.Y.Z
```

GitHub Release 页同 [§3.7](#37-tag--github-release)。

---

## 5. Detection Lab baseline — bootstrap & 维护

CI gate (`.github/workflows/detection-lab.yml`) 跑在每个 PR + push:main
上，对比 fresh detection run 与 committed baseline。**第一次** 在 main
上跑会进入 bootstrap 模式（baseline 不存在 → 不 fail，写 candidate
artifact 让 maintainer 提取）。

### 5.1 一次性 bootstrap（每个 fixture persona 一次）

```bash
# 1. push 任何触发 detection-lab.yml 的 commit 到 main
#    （或在 Actions UI workflow_dispatch 一次）

# 2. 等 workflow 跑完 (~10-15 min for 12 sites x 1 persona)

# 3. 下载 candidate artifact
gh run list --workflow=detection-lab.yml --limit 1 --json databaseId -q '.[0].databaseId'
# 得到 RUN_ID
gh run download <RUN_ID> --name detection-lab-win11-chrome-us-<run-number>
# 解压后得到 candidate-win11-chrome-us.json

# 4. 本地 strip + write baseline
node scripts/ci-compare-baseline.mjs write-baseline \
  candidate-win11-chrome-us.json \
  tests/fixtures/baseline-runs/win11-chrome-us/baseline.json

# 5. Commit + PR
git switch -c chore/bootstrap-baseline-win11-chrome-us
git add tests/fixtures/baseline-runs/win11-chrome-us/baseline.json
git commit -m "chore(baseline): bootstrap detection-lab baseline for win11-chrome-us"
gh pr create --title "chore(baseline): bootstrap win11-chrome-us baseline" \
  --body "First baseline for win11-chrome-us. Generated from CI run <RUN_ID>."
```

**重要**: 必须从 **CI runner artifact** 生成 baseline，**不要** 本地
`mosaiq detection-lab run` 跑出来的结果。本地硬件指纹（真实 GPU / OS /
audio context）与 `ubuntu-latest` 不同，会产生 false-positive 回归。

详细 rationale: `tests/fixtures/baseline-runs/README.md`

### 5.2 后续维护（detector 网站更新触发）

当 creepjs / browserscan / 等检测站更新它们的检测器，**真实** detection
behavior 没变但 CI 突然红了：

- **Phase 10.8** 的 `refresh-baseline.yml` 每周 cron 跑一次，多次跑取
  consensus，drift 时自动开 PR — 大部分时候不需要 maintainer 介入
- 手动 refresh 路径同 [§5.1](#51-一次性-bootstrap每个-fixture-persona-一次)
  的步骤 3-5（download artifact → write-baseline → commit PR），唯一
  区别是 commit message 用 `chore(baseline): refresh ...` 而不是
  `bootstrap`

### 5.3 Detection Lab CI gate 真实生效的 end-to-end 验证

发版 + bootstrap 完成后，可选项: **故意造一个 regression** 验证 gate
真的会拦：

```bash
git switch -c test/verify-detection-lab-gate
# 故意 break SDK 注入: 比如注释掉 webdriver getter spoof
# packages/sdk/src/injection/runner.ts 里 webdriver 那块
# 改成 // const wrapWebdriver = ...
pnpm --filter @runova/sdk build
git add -p packages/sdk/src/injection/runner.ts
git commit -m "test: deliberately break webdriver spoof to verify CI gate"
gh pr create --title "test: verify detection-lab CI gate (do not merge)" \
  --body "Should trigger sticky PR comment on detection-lab.yml failure."
```

预期: detection-lab.yml 跑完 → PR 上出现 sticky comment 标
"🚨 Detection Lab regression on win11-chrome-us"，列出 `webdriver`
surface 的 added hit。验证完关 PR、删 branch。

---

## 6. Rollback / hotfix

### 6.1 72h 内（npm unpublish 窗口）

```bash
npm unpublish @runova/cli@X.Y.Z --force
npm unpublish @runova/sdk@X.Y.Z --force
npm unpublish @runova/persona-schema@X.Y.Z --force

# 同时本地删 tag
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
# GitHub Release 页手工删（Releases 列表 → 该 release → Delete）
```

**重要**: 72h 之后 npm 不允许 unpublish 同一 version 号再 publish（policy:
permanent ID）。所以 hotfix 必须 bump 版本号。

### 6.2 72h 后 hotfix

```bash
# 1. cherry-pick / revert / 直接修
# 2. 跑 pnpm changeset 选 patch bump
# 3. 走 §4 自动化流程
# 4. 旧版本可选 deprecate:
npm deprecate @runova/cli@X.Y.Z "Critical bug, use X.Y.(Z+1) or later"
npm deprecate @runova/sdk@X.Y.Z "Critical bug, use X.Y.(Z+1) or later"
npm deprecate @runova/persona-schema@X.Y.Z "Critical bug, use X.Y.(Z+1) or later"
```

---

## 7. 常见坑

- **OTP timing out**: npm 2FA OTP 30 秒一刷，三个 publish 之间会过期。
  每次 publish 前手机看准时间再输
- **`pnpm publish` 报 ETARGET**: 通常是 `packages/sdk` 依赖 `@mosaiq/
  persona-schema@0.10.0` 但 schema 还没发上去。检查发版顺序 (schema → sdk
  → cli)
- **patches/playwright-core@1.59.1.patch 缺失**: external smoke 时
  `npm i @runova/sdk` 没自动 apply patch → 检查 `.npmignore` 是否把
  `patches/` 排除掉了，应该 keep
- **release.yml 不跑**: 检查 PR 里有没有 `.changeset/<name>.md`。没有
  就不会触发版本 bump
- **changesets/action open 不了 PR**: 检查 `GITHUB_TOKEN` 有 `Read and
  write` on Pull requests + Contents（默认应该有）
- **detection-lab.yml 跑了 30 min 还没完**: 12 站之中某站 hang。检查
  workflow log，必要时 cancel + 给那站加超时

---

## 8. 当前状态 & go-live checklist（npm `@runova` scope）

✅ **代码侧**: v0.10（persona-schema / sdk / cli）+ v0.11（cloud-sdk + 私有 cloud-runtime / browser-pod）均已 ship 到 `main`。`audit-tarballs` 现覆盖 **4** 个发包包（含 cloud-sdk）。

⏳ **仍待 maintainer 一次性操作**（需真实 npm 账号 / 凭据，自动化 agent 做不了；这是「npm 上线」与「翻开自动发布」的完整清单）：

✅ **预检（2026-05-31）**：`pnpm audit-tarballs` 四包通过；`publish --dry-run --no-git-checks` 四包均可打包上传。Fly prod：`scripts/prod-smoke-cloud.mjs` → `server_inject_ok`（本地密钥文件跑通）。

1. [x] npm org **`runova`**（`@runova/*`）——`@mosaiq` scope 已被他人占用；CLI 发 **`@runova/cli`**（命令仍为 `mosaiq`）。见 [`NPM-SCOPE-TROUBLESHOOTING.md`](./NPM-SCOPE-TROUBLESHOOTING.md)。
2. [ ] 第一次手工 publish 0.10 三包（[§3](#3-首次发版-v0100-手工)）。
3. [ ] 第一次手工 publish `@runova/cloud-sdk@0.11.0`（**0.11 cloud track**，独立于三包 lock-step）：
   ```bash
   pnpm --filter "@runova/cloud-sdk" publish --dry-run --access public
   pnpm --filter "@runova/cloud-sdk" publish --access public
   ```
   注意 cloud-sdk 的 `playwright-core` 是 **peerDependency**，消费者需自带（README 已说明）。
4. [ ] `git tag` + GitHub Release 页（[§3.7](#37-tag--github-release)）。
5. [ ] Detection Lab baseline bootstrap（[§5.1](#51-一次性-bootstrap每个-fixture-persona-一次)）+ 完整实测见 [`docs/EVIDENCE-AND-VALIDATION.md`](./EVIDENCE-AND-VALIDATION.md)。
6. [ ] **翻开自动发布**：以上都 OK 后，去掉 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 顶部 `push: branches: [main]` 注释 + 配 `NPM_TOKEN`（或 trusted publishing）。之后走 changesets 自动化（[§4](#4-后续发布-via-changesets)）。
   - cloud-sdk **不在** `fixed` lock-step 组（它在 0.11 cloud track、独立 bump），但 `changeset publish` 仍会发它（public + 不在 ignore）；release.yml 已 build 4 包。
7. [ ] **可选**：在 GitHub repo Settings → Secrets 设 `MOSAIQ_API_KEY`，用 [`.github/workflows/prod-smoke-cloud.yml`](../.github/workflows/prod-smoke-cloud.yml) `workflow_dispatch` 做 Fly 回归（期望日志含 `server_inject_ok`）。

估时: 全跑通 ~2-4h（含 detection-lab.yml 首跑 10-15 min 等待）。

---

## 参考资料

- 设计稿 (why): `docs/V0.10-NPM-DISTRIBUTION-AND-CI-GATE.md`
- Changesets 使用: `.changeset/README.md`
- Detection Lab baseline 细节: `tests/fixtures/baseline-runs/README.md`
- CI workflows: `.github/workflows/{ci,release,detection-lab,refresh-baseline}.yml`
- 历史 changelog: `CHANGELOG.md`
