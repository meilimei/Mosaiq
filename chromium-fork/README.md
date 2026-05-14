# Mosaiq Chromium Fork

> 🧊 **冷藏（Cold Storage）— 2026-05-13 起**  
> 详见 [`STATUS.md`](./STATUS.md)。本目录所有内容**完整保留**作为 Phase 3 的素材库（**不要删除任何文件**）。  
> Mosaiq 主线已进入 **Phase 1: SDK 注入** 路径，见 `packages/sdk/` 与 `C:\Users\ifly\.windsurf\plans\chromium-fork-pivot-d715ea.md`。

---

<details>
<summary>📦 历史里程碑（点击展开）</summary>

> **历史里程碑（已冷藏）**：Phase A.0 — 环境准备阶段。Chromium 源码 27 GB 已部分 sync，patch 尚未实施。

这是 Mosaiq 长期愿景中**真正的 fork** 工作目录。配套设计：[`docs/CHROMIUM-FORK-GUIDE.md`](../docs/CHROMIUM-FORK-GUIDE.md) 已写完整 460+ 行规划，本目录是其执行落地。

</details>

---

## 目录布局

```
chromium-fork/
├── README.md                    # 本文件
├── .chromium-version            # 锁定的 Chromium stable tag（当前 134.0.6998.117）
├── .wslconfig.template          # WSL2 资源限制模板（拷到 C:\Users\<你>\.wslconfig）
├── patches/
│   ├── README.md                # patch 工作流说明
│   ├── series.txt               # quilt 应用顺序清单（Phase A.0 时为空）
│   ├── 0014-persona-bridge.spec.md
│   ├── 0001-canvas-noise.spec.md
│   └── 0011-tls-ja4-spoof.spec.md
├── scripts/
│   ├── setup-wsl.sh             # 一键装 deps + depot_tools（在 WSL 内跑）
│   ├── check-env.sh             # 环境就绪自检
│   └── apply-patches.sh         # 按 series.txt 顺序应用 patch
└── .github/workflows/
    ├── lint-patches.yml         # ✅ Phase A.0 启用：patch 元数据 + shellcheck
    ├── build-linux.yml          # ⛔ 禁用 — 等 Phase A.1 跑通 + self-hosted runner
    └── upstream-sync.yml        # ⛔ 禁用 — 等 Phase A.4 完成
```

---

## Phase A 完整路线图

```
A.0  ──→  A.1  ──→  A.2          ──→  A.3            ──→  A.4
环境     vanilla    Patch 0014        Patch 0001          Patch 0011
准备     build      Persona Bridge    Canvas Noise        TLS / JA4
1-2 天   8-10 天    3-4 周            4-6 周              6-12 周
```

| 阶段 | 你的机器累计耗时 |
|---|---|
| A.0 | T+1 天 |
| A.1 | T+10 天 |
| A.2 | T+6 周 |
| A.3 | T+12 周 |
| A.4 | **T+24 周（半年）** |

---

## 你 vs Cascade 的分工

### Cascade 做（基本所有非长任务的工作）

- 所有 patch 代码（C++ / mojom IDL / BUILD.gn）
- 所有脚本（bash / PowerShell / yml）
- 所有设计文档（spec.md / README）
- 解读 build 错误日志、定位问题
- 设计单元测试 + 集成测试用例

### 你做（只做物理上必须本地跑的）

- 在 WSL2 终端执行长任务（fetch / sync / build / 增量 build）
- 把 build 错误 / chrome 启动输出贴回给 Cascade
- 跑检测站验证（browserleaks / tls.peet.ws / pixelscan / scrapfly）
- 报告每个 Phase 的 Done condition 是否达标
- 监控 D: 盘磁盘空间，提前预警空间不足

**关键约定**：长任务（fetch / sync / build）必须在 `tmux` 会话里跑，关 IDE 也不影响。每天回来 `tmux attach` 看进度，把日志末尾贴给 Cascade。

---

## 立刻开始：Phase A.0（1-2 天）

### Step 1：拷 .wslconfig 模板

在 Windows PowerShell 执行：

```powershell
Copy-Item d:\projects\Mosaiq\chromium-fork\.wslconfig.template `
          $env:USERPROFILE\.wslconfig
```

> ⚠️ 只在你**没有**自己的 `~/.wslconfig` 时拷。如果已有，对比合并 —— 关键值是 `memory=12GB / processors=4 / swap=24GB / swapFile=D:\WSL\swap.vhdx`。

然后建好 `D:\WSL\` 目录（swapFile 父目录必须存在）：

```powershell
New-Item -ItemType Directory -Force -Path D:\WSL | Out-Null
```

### Step 2：装 / 启动 WSL2 + Ubuntu

```powershell
# 检查是否已装
wsl --list --verbose
```

如果已有 `Ubuntu` / `Ubuntu-22.04` / `Ubuntu-24.04` 任意一个（22.04 或 24.04 LTS），
**直接用**，不用重装。没有就装：

```powershell
wsl --install -d Ubuntu-24.04     # 推荐 24.04；22.04 也支持
```

### Step 3：让 .wslconfig 生效

```powershell
wsl --shutdown   # 关掉所有 WSL 实例
wsl -d Ubuntu    # 重新启动（distro 名按 wsl -l -v 实际输出来）
```

进入 shell 后用 `free -h` 验证 RAM 是 12GB 左右、`nproc` 输出 4：

```bash
free -h    # 应显示 ~11-12Gi
nproc      # 应输出 4
```

### Step 3.5：（仅当 whoami 是 root 时跑）创建普通用户

某些 WSL distro（`wsl --import` 导入的 rootfs、或某些预装镜像）默认登录用户是 root。
depot_tools / gclient / install-build-deps.sh 都**拒绝 root**，必须切普通用户：

```bash
# 在 WSL 内（仍以 root 身份）
whoami                      # 若输出 root，才需要这一步
sudo bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/setup-user.sh
exit                        # 退出 WSL
```

```powershell
wsl --shutdown              # 让 /etc/wsl.conf 生效
wsl -d Ubuntu               # 再进来
```

```bash
whoami                      # 这次应输出 mosaiq
```

### Step 4：在 WSL 内跑 setup-wsl.sh

```bash
# 你现在已是普通用户（whoami 不是 root）
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/setup-wsl.sh
```

这步会：
- apt 装基础依赖（git / python3 / ninja / jq / tmux 等）
- clone depot_tools 到 `~/depot_tools`
- 把 `~/depot_tools` 加到 `~/.bashrc` 的 PATH
- 创建 `~/chromium/` 工作目录（**仅 mkdir，不 fetch**）

**预计耗时**：5-15 分钟（apt 装包 + clone depot_tools，受网络影响）

### Step 5：退出 WSL 重进让 PATH 生效

```bash
exit           # 退出 WSL
```

```powershell
wsl -d Ubuntu   # 重进（distro 名按实际）
```

### Step 6：跑 check-env.sh 自检

```bash
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/check-env.sh
```

这步会输出 9 大类标准化诊断报告。把**整段输出贴给 Cascade**，会据此：

- 判断 A.0 是否验收通过
- 修复任何 FAIL 项
- 评估 WARN 项是否会影响 A.1

---

## A.0 Done Condition

- `wsl -d Ubuntu -- whoami` 输出非 root 用户（如 `mosaiq`）
- WSL 内 `free -h` 显示 RAM ≥ 11 GB（`.wslconfig` 已生效）
- WSL 内 `nproc` 输出 4
- WSL 内 `which gclient` 命中 `/home/<用户>/depot_tools/gclient`
- `check-env.sh` 退出码 0（33/33 PASS）或 2（仅 WARN）
- Cascade 确认 A.0 验收

---

## A.0 完成后才能做的事

A.1 各阶段都有独立 wrapper 脚本，都会把长任务启动到 tmux 并输入日志文件。

### A.1.a fetch chromium（3-15 小时，看 VPN 带宽）

```bash
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/start-fetch.sh
```

创建 tmux session `fetch-chromium`，超时期间任何时候可查：

```bash
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/fetch-progress.sh
# 输出：tmux 状态 / 已运行时长 / 磁盘占用 / 活跃子进程 / 网络连接 / 最近日志
```

完工后 `~/chromium/fetch.log` 会出现 `[END exit=0] ...`。

### A.1.b 切到锁定 tag + gclient sync（1-3 小时）

```bash
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/checkout-stable.sh
```

读 `.chromium-version` 的内容（`134.0.6998.117`），切 src/ HEAD，后台 tmux `sync-stable` 跑 `gclient sync -D --with_branch_heads --with_tags`。

### A.1.c install-build-deps + runhooks（15-50 分钟）

```bash
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/install-build-deps.sh
```

1. 跑 `src/build/install-build-deps.sh --no-prompt`（装 ~200 个 apt 包）
2. 后台 tmux `runhooks` 跑 `gclient runhooks`（拉 NaCl SDK / clang / pgo profile ～3 GB）

### A.1.d vanilla build（24-48 小时连跑）

```bash
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/build-vanilla.sh
```

创建 `out/Vanilla/` 跟 `args.gn`（已低端机调优），后台 tmux `build-vanilla` 跑 `autoninja -C out/Vanilla chrome`。

关键 args（脚本里已预设）：

| arg | 值 | 理由 |
|---|---|---|
| `is_debug` | `false` | release 编译 |
| `is_official_build` | `false` | 不走 PGO+LTO，避免链接阶段 OOM |
| `symbol_level` | `1` | 小 symbol，crash 还能粗略 trace |
| `is_component_build` | `false` | 单 binary 接近 release 行为 |
| `enable_nacl` | `false` | NaCl deprecated，省 8GB+ 编译时间 |
| `use_lld` | `true` | lld 比 gold 快 + 内存友好 |
| `chrome_pgo_phase` | `0` | 禁 PGO，profile 入内存会爆 |

**这是最危险的一步**。可能失败模式 + 应对：

| 症状 | 应对 |
|---|---|
| 链接 OOM（`virtual memory exhausted`） | `.wslconfig` swap 调到 32GB，重启 WSL 重 link |
| 单个 .cc OOM | 在 args.gn 加 `parallel_link_jobs=1 concurrent_links=1` 重跑 gn gen |
| WSL 进程被 OOM killer | `vm.overcommit_memory=1` 已在 .wslconfig，应已生效 |
| /tmp 满 | `export TMPDIR=~/chromium/tmp && mkdir -p $TMPDIR` 重跑 |
| clang ICE | `rm -rf out/Vanilla` 重跑 gn gen |

### A.1.e 验证 vanilla chrome

```bash
cd ~/chromium/src
./out/Vanilla/chrome --version
# 期望：Chromium 134.0.6998.117

./out/Vanilla/chrome --no-sandbox --headless=new --dump-dom https://example.com
# 期望：example.com 的 HTML
```

---

## A.1 Done Condition（分水岭）

- `chrome --version` 输出锁定的 134.0.6998.117
- `chrome --headless --dump-dom https://example.com` 返回正常 HTML

跑通 = A 路径物理可行，进入 Phase A.2 写 Persona Bridge patch。  
跑不通 = 必须切 A.cloud（云机 build）或 A.staged（仅维护 patch 草稿不真 build）。

---

## 进度日志

跨多次会话开发时，你每天给 Cascade 发的最少信息：

```
日期：2026-MM-DD
当前 Phase：A.1.x
[贴 fetch-progress.sh 输出] 或
[贴 ~/chromium/<阶段>.log 末尾 30-100 行]
```

Cascade 据此判断该不该继续等 / 该不该改参数 / 该不该回滚。

---

## 风险与逃生路径

| 风险 | 触发 | 应对 |
|---|---|---|
| 链接 OOM | A.1.d link 阶段 | swap 加大；切 component_build；单 link 并发 |
| WSL2 vhdx 膨胀 | A.1.b 后 vhdx > 150GB | `wsl --shutdown` + PowerShell `Optimize-VHD` |
| D: 盘见底 | 任何阶段 `df` < 10GB | 监控；删 out/ 内 debug；`gclient sync --delete_unversioned_trees` |
| 翻墙断线 | A.1.a fetch 阶段 | 用 tmux 不会丢；网回来后 `git fetch --all` 续 |
| 上游 stable 漂移 | Phase A.2-A.4 跨周 | **锁 .chromium-version**，patch 稳定前不动 |
| Phase 卡 > 2 周 | 任意 phase 卡住 | 回 plan review，考虑切 A.cloud / A.staged |

---

## 不在本目录范围内

- ❌ Mosaiq for Windows / macOS 发布二进制（要等真 build 机或上云）
- ❌ Cloud Runtime（K8s + 多租户，独立仓库）
- ❌ Patch 0002-0010 / 0012-0013 / 0015（Phase B 工作）
- ❌ Auto-update / 代码签名（发布时再做）
- ❌ Detection Lab leaderboard（Mosaiq Cloud 范围）

完整规划见 [`docs/CHROMIUM-FORK-GUIDE.md`](../docs/CHROMIUM-FORK-GUIDE.md) §0-9。
