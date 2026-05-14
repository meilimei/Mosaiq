# Chromium Fork 目录状态

> 🧊 **冷藏（Cold Storage）— 2026-05-13 起**

## TL;DR

本目录的 fork+build chromium 路径**暂停**。Mosaiq 主线进入 **Phase 1: SDK 注入** 路径，详见 `packages/sdk/`。本目录所有内容**完整保留**作为 Phase 3 的素材库，**不要删除任何文件**。

## 为什么冷藏

| 原因 | 详情 |
|---|---|
| **硬件硬约束** | i7-6500U 2C4T / 11GB RAM 无法本地 build chromium。首次 build 30-50 小时，每次 patch 改一行增量 link 5-30 分钟。 |
| **网络不稳** | VPN IPv6 路由问题，多次 fetch / sync 失败（最后一次 27 GB / 35-40 GB 又因 DNS 失败 exit 1） |
| **工程效率** | Phase A 全跑完估计半年，期间无法 ship 产品 |
| **同行经验** | Multilogin / GoLogin / AdsPower / Browserbase 全部先用注入做 MVP，**没有一家从 Day 1 fork chromium** |

## 主线在哪

**`packages/sdk/`** — Phase 1 SDK 注入路径

- `packages/sdk/src/injection/runner.ts` 22KB 已覆盖 navigator/screen/Intl/permissions/chrome shim
- `packages/sdk/src/humanize/` 49 测试鼠标/键盘真人化
- `packages/sdk/src/launcher.ts` `--disable-blink-features=AutomationControlled` 等关键 flag
- Phase 1 工作：补 Canvas / WebGL / Audio / Font / WebRTC 5 个 surface

详见根目录 plan：`C:\Users\ifly\.windsurf\plans\chromium-fork-pivot-d715ea.md`。

## 已沉淀资产（**不要删**）

| 资产 | 路径 | Phase 3 用途 |
|---|---|---|
| **27 GB sync 数据** | WSL: `/home/mosaiq/chromium/` (主仓 + 部分 DEPS) | Phase 3 启动时直接 rsync 到云 VM，省 4-8h 重 fetch |
| **11 个脚本** | `scripts/*.sh` | Phase 3 全部能复用（fetch / sync / recover / apply-patches / build / lint） |
| **3 个 patch 草稿** | `patches/0001-canvas-noise.spec.md` / `patches/0011-tls-ja4-spoof.spec.md` / `patches/0014-persona-bridge.spec.md` | Phase 3 patch 设计起点（部分 Phase 1 已用其抽象写注入版） |
| **CI lint** | `.github/workflows/lint-patches.yml` | Phase 3 直接启用 |
| **环境配置模板** | `.wslconfig.template`（12GB build 配置）/ `.wslconfig.phase1.template`（4GB 日用配置）| Phase 3 切回 12GB |
| **Chromium 版本锁** | `.chromium-version` (134.0.6998.117) | Phase 3 起点版本（解冻时考虑是否 bump） |

## Phase 3 解冻条件（明确触发器）

只有同时满足以下 3 项才解冻：

1. ✅ Phase 1-2 实测出 ≥ 3 项指纹**只能 fork chromium 才能修**（注入做不到），且这些指纹在客户目标站被反爬使用
2. ✅ Mosaiq 月收入 / 融资 ≥ €500（覆盖云 build 费 + rebase 工时）
3. ✅ 客户群里有支付意愿明确升级到带 fork 版本（加价 ≥ €30/月）

预计 **6-12 个月内**触发。

## Phase 3 解冻路径（最小 fork，不是全量 fork）

不再走 README 里描述的 Phase A.1-A.4 全量 fork（半年路径）。Phase 3 只做：

1. 起 Hetzner CCX33（16vCPU/64GB）spot VM 或 GitHub Actions self-hosted runner
2. rsync 本目录现有 27GB sync 数据到云 VM（省 4-8h fetch）
3. checkout 锁定的 stable tag（`.chromium-version`）
4. 应用 Phase 1-2 实测确认的 2-5 个 patch（**不是 14 个全量 patch**）
5. 云端 build 出 binary `mosaiq-chrome`
6. 替换 playwright-core 默认 chromium

预计 Phase 3 工期：**1-2 月**（不是半年），因为只做必要 patch + 云端高配 build。

## 维护规则

- ❌ **不删除**任何文件（包括 sync 数据）
- ❌ **不修改** `patches/*.spec.md` 内容（草案稳定，Phase 3 微调）
- ✅ 可在 README.md 加 badge / 注释标记冷藏
- ✅ 可补充本 STATUS.md 反映新决策
- ✅ 脚本（`scripts/*.sh`）如有 bug 可修，因为 Phase 3 也用

## 上次活动

- **2026-05-11** — Phase A.0 环境验证 + A.1.a fetch 启动
- **2026-05-13 06:56:51** — sync-resume 又因 DNS 失败 exit 1（最后一次活动）
- **2026-05-13 21:13** — 用户反馈电脑卡死，决定 pivot
- **2026-05-13 21:30** — 写本 STATUS.md，进入冷藏

## 联系

主线 plan：`C:\Users\ifly\.windsurf\plans\chromium-fork-pivot-d715ea.md`  
项目入口：`d:\projects\Mosaiq\` 根 README
