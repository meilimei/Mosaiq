# 真账号实测记录（Real-Account Testing Log）

> **怎么用**：这是 [EVIDENCE-AND-VALIDATION.md §4](./EVIDENCE-AND-VALIDATION.md) 协议的**填写表**。
> 每跑一次（每天 / 每个 persona × 站点）就追加一行。**禁止伪造**——所有行必须来自真实操作。
> 被识破 / 被 challenge 的行，开 issue（[detection-report 模板](../.github/ISSUE_TEMPLATE/detection-report.yml)）后把 issue 链接填进「证据」列。
>
> 完整操作步骤见 [REAL-ACCOUNT-TESTING-RUNBOOK.md](./REAL-ACCOUNT-TESTING-RUNBOOK.md)。

---

## 本轮元信息

| 项 | 值 |
|---|---|
| 开始日期 | 2026-__-__ |
| SDK 版本 | `@runova/sdk` 0.10.1 |
| chromium 版本 | （从任一 persona 的 `/json/version` 或 CreepJS 读，填这里） |
| 代理服务商 | （IPRoyal / Decodo / … 见 PROXY-GUIDE.md；或「无代理 = 本机 IP」） |
| 操作人 | __ |

四个模板 persona（按 RUNBOOK §1 创建，每个绑独立住宅代理）：

| persona-id | 模板 | 代理标签 | 用途 |
|---|---|---|---|
| `real-win11` | win11-chrome-us | __ | Reddit / Cloudflare |
| `real-win10` | win10-chrome-us | __ | X / DataDome |
| `real-macos` | macos-sonoma-chrome-us | __ | Google |
| `real-ubuntu` | ubuntu-2204-chrome-us | __ | 交叉验证 |

---

## 结果记录

> `结果` 取值：`pass`（顺利通过/登录）/ `challenge`（出验证码/二次验证但能过）/ `block`（被拦/封号/无法继续）。
> `被识破 surface`：尽量具体到指纹面（webgl / canvas / navigator / tls / 行为 / IP / 其他），别只写「被封」。

| 日期 | persona | 目标站 | 路径 | 结果 | 被识破 surface | 证据 / issue 链接 |
|------|---------|--------|------|------|----------------|-------------------|
| 2026-__-__ | real-win11 | reddit.com/login | open-persona | | | |
| 2026-__-__ | real-win11 | nopecha cloudflare demo | open-persona | | | |
| 2026-__-__ | real-win10 | x.com/login | open-persona | | | |
| 2026-__-__ | real-win10 | datadome bot test | open-persona | | | |
| 2026-__-__ | real-macos | accounts.google.com | open-persona | | | |
| 2026-__-__ | real-ubuntu | creepjs | open-persona | | | |

（继续往下加行。）

---

## 每日小结（可选，便于回看趋势）

### 2026-__-__（Day 1）
- 跑了哪些 persona × 站点：
- pass / challenge / block 计数：
- 新开的 detection-report issue：
- 观察 / 怀疑：

### 2026-__-__（Day 2）
- …

---

## 一周收尾汇总

| 指标 | 数值 |
|---|---|
| 总测次数 | |
| pass | |
| challenge | |
| block | |
| 开的 detection-report issue 数 | |
| 最常被识破的 surface | |

**结论与下一步**（喂给 `packages/sdk/src/injection/runner.ts` 的修补优先级）：

-
