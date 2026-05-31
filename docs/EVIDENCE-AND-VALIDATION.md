# 证据与验证手册（Evidence & Validation）

> **为什么有这篇**：Mosaiq 的整个卖点是「真自检 / 过 IPHey/CreepJS / 强于 Browserbase」，但目前仓库里**没有任何 committed 的实测证据**——`tests/fixtures/baseline-runs/` 为空、leaderboard 未公开、没有硬目标（Cloudflare/DataDome）与真账号实测记录。在拿到这些证据前，对外宣称反检测能力都是**未经证明**的。这篇是把「证明它真能打」从口号变成可执行步骤的 runbook。
>
> ⚠️ 本手册里**真账号实测、硬目标实测、npm publish、GitHub Pages 启用**等步骤需要**人**用真实凭据/账号执行，且**禁止伪造数据**——baseline / leaderboard 必须来自真实运行。

---

## 0. 一句话优先级

把下面三件事按顺序做完，比再 ship 任何新功能都重要：

1. **bootstrap 第一份 committed baseline** —— 让 CI gate 真正生效、让「分数」可追踪。
2. **公开 leaderboard** —— 诚实地把 Mosaiq vs Browserbase/竞品 的实测分摆出来。
3. **硬目标 + 真账号实测一周** —— 把被识破的点回流成 issue，喂给 `runner.ts` 修补。

---

## 1. 先决条件

```bash
pnpm install
pnpm --filter @runova/sdk build          # ci-compare-baseline / leaderboard 脚本读 sdk/dist
npx playwright install chromium          # Detection Lab 跑真 chromium
```

四个 fixture persona（CI gate 用）由模板确定性生成：

```bash
pnpm build-fixture-personas              # 写 tests/fixtures/personas/*.json（--check 仅校验漂移）
```

---

## 2. Bootstrap 第一份 committed baseline

baseline 是「这个 persona 在 12 个检测站的已知良好结果」。CI 的 `detection-lab.yml` 用它做回归对比；没有 baseline，gate 只会进入 bootstrap 提示而不真正拦截。

**路径 A —— 从 CI 候选产物 bootstrap（推荐，最干净）**

1. 在 GitHub 手动触发 `.github/workflows/detection-lab.yml`（`workflow_dispatch`），或等一次绿色 run。
2. 下载该 run 的 `candidate-<persona>.json` artifact。
3. 本地转成 baseline 并提交：

```bash
node scripts/ci-compare-baseline.mjs write-baseline \
  candidate-win11-chrome-us.json \
  tests/fixtures/baseline-runs/win11-chrome-us/baseline.json
git add tests/fixtures/baseline-runs/
git commit -m "chore(baseline): bootstrap detection-lab baseline for win11-chrome-us"
```

**路径 B —— 本地跑一份候选再 bootstrap**

```bash
pnpm mosaiq detection-lab run win11-chrome-us --json > candidate.json
node scripts/ci-compare-baseline.mjs write-baseline \
  candidate.json tests/fixtures/baseline-runs/win11-chrome-us/baseline.json
```

> 注意：本地单跑一次受网络/检测站波动影响。**更稳的做法是用 `refresh-baseline`** 做多跑次共识：
> ```bash
> pnpm refresh-baseline            # 多跑次 consensus，降单次 flake（见 .github/workflows/refresh-baseline.yml）
> ```

**矩阵扩容**：先 bootstrap `win11-chrome-us`，再把 `win10-chrome-us` / `macos-sonoma-chrome-us` / `ubuntu-2204-chrome-us` 各 bootstrap 一份，验证跨平台一致性。maintainer 侧完整流程见 [`docs/RELEASING.md`](./RELEASING.md)。

---

## 3. 公开 leaderboard（诚实对比）

把 Mosaiq vs Browserbase / AdsPower / Multilogin 的实测分做成静态站，这是 PRD §2 承诺的 GTM 资产。

```bash
pnpm build-leaderboard            # 从 committed baselines 生成静态 HTML → _site/
```

- CI：`.github/workflows/leaderboard.yml` 在 PR 上 build artifact、在 `main` 上 deploy 到 GitHub Pages。
- **需人操作一次**：在仓库 Settings → Pages 启用 GitHub Pages（source = Actions）。
- **诚实原则**：过不了的项照实标红/标注，不挑数据。竞品分要可复现（注明跑法/日期/版本），否则会被打脸。

---

## 4. 硬目标 + 真账号实测协议（每周，人工）

Detection Lab 的 12 个站点是**自动化体检**，但**不能替代**真实风控站点 + 真账号的实战。这一段必须人来跑，按下面的协议记录，结果回流成 issue（用 [detection-report 模板](../.github/ISSUE_TEMPLATE/detection-report.yml)）。

**协议**：

1. 4 个模板 persona 各建一个，分别在以下场景跑一周：
   - Cloudflare 严格保护站（如某些电商/票务登录页）
   - DataDome / Akamai / PerimeterX 保护站
   - 真账号登录：Reddit / X / Google（注意各平台 ToS，自担风险）
2. 每天记录：能否过人机/能否登录/是否被 challenge/账号是否存活。
3. 任何被识破/被 challenge：立刻开 detection-report issue，附**具体被识破的 surface**（不要只写「被封了」）。

**结果记录模板**（复制到 issue 或一个跟踪文档）：

```
日期 | persona | 目标站 | 路径(desktop/cli/sdk/cloud) | 结果(pass/challenge/block) | 被识破的 surface | 证据链接
-----|---------|--------|----------------------------|----------------------------|------------------|--------
```

> 云端注意（v0.11 起）：裸 `connectOverCDP` / `@browserbasehq/sdk` baseURL swap **默认带服务端深层注入**（与 desktop 同套 `injectAll`）。`stealth.inject: false` 或 pod `POD_SERVER_INJECT=0` 时才是 raw chromium。客户端 `injectInto()` 仍可用且与服务端注入幂等。

---

## 5. 被识破后怎么回流

1. 开 issue（detection-report 模板自动带 `detection` label）。
2. 复现 → 定位到 `packages/sdk/src/injection/runner.ts` 的对应 surface。
3. 修 → 跑 `pnpm --filter @runova/sdk test` + 针对性 `bench/diagnose-*.ts` 真 chromium 验证。
4. 更新受影响 persona 的 baseline（路径见 §2），让回归被锁住。

---

## 6. 对外口径（别自己打脸）

- 没有 committed baseline / 公开 leaderboard 之前：**不要**对外宣称具体通过率数字。
- 云端深层反指纹：v0.11 起**默认服务端注入**（裸 baseURL swap 即有深层 stealth）；关闭注入见 session `stealth.inject` / `POD_SERVER_INJECT`（见 [`docs/CLOUD-RUNTIME-ARCH.md`](./CLOUD-RUNTIME-ARCH.md) §2.5）。
- 竞品对比分：必须可复现（跑法 + 日期 + 版本），否则不发。
