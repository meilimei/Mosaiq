#!/usr/bin/env bash
# Mosaiq Chromium Fork — 环境就绪自检
#
# 在 WSL2 内跑：
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/check-env.sh
#
# 输出标准化诊断报告。把整段输出贴给 Cascade，会据此判断当前 phase 状态 +
# 决定是否能继续下一步。
#
# 退出码：
#   0 = 全部 PASS，环境就绪
#   1 = 有 FAIL 的检查项
#   2 = 仅有 WARN 的检查项（建议修但不阻塞）

# shellcheck disable=SC2088  # tilde 在日志文本里仅供展示，不需展开
set -uo pipefail

# Defensive：不依赖 ~/.bashrc / ~/.profile 是否被 source，只要 depot_tools 目录存在
# 就把它加入本脚本的 PATH（子进程也继承）。
if [[ -d "${HOME}/depot_tools" ]] && [[ ":${PATH}:" != *":${HOME}/depot_tools:"* ]]; then
  export PATH="${HOME}/depot_tools:${PATH}"
fi

readonly C_RED=$'\033[0;31m'
readonly C_GREEN=$'\033[0;32m'
readonly C_YELLOW=$'\033[1;33m'
readonly C_BLUE=$'\033[0;34m'
readonly C_BOLD=$'\033[1m'
readonly C_RESET=$'\033[0m'

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

check_pass() {
  printf '  %s[PASS]%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"
  PASS_COUNT=$((PASS_COUNT + 1))
}
check_warn() {
  printf '  %s[WARN]%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"
  WARN_COUNT=$((WARN_COUNT + 1))
}
check_fail() {
  printf '  %s[FAIL]%s %s\n' "${C_RED}" "${C_RESET}" "$*"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}
section() {
  printf '\n%s%s━━ %s ━━%s\n' "${C_BOLD}" "${C_BLUE}" "$*" "${C_RESET}"
}

printf '%s%sMosaiq Chromium Fork — 环境就绪检查%s\n' "${C_BOLD}" "${C_BLUE}" "${C_RESET}"
printf '生成时间: %s\n' "$(date -Iseconds)"
printf '主机名: %s\n' "$(hostname)"

# ── 1. OS / Kernel ──────────────────────────────────────────────
section "1. OS / Kernel"
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" == "ubuntu" ]] && [[ "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
    check_pass "Ubuntu ${VERSION_ID} (${PRETTY_NAME})"
  elif [[ "${ID:-}" == "ubuntu" ]]; then
    check_warn "Ubuntu ${VERSION_ID}（推荐 22.04 或 24.04，install-build-deps.sh 可能报错）"
  else
    check_fail "OS = ${ID:-unknown}，需要 Ubuntu 22.04 或 24.04"
  fi
else
  check_fail "/etc/os-release 不存在"
fi

if grep -qi 'microsoft' /proc/version 2>/dev/null; then
  if grep -qi 'wsl2' /proc/version 2>/dev/null || [[ -n "${WSL_INTEROP:-}" ]]; then
    check_pass "运行在 WSL2 内（kernel: $(uname -r)）"
  else
    check_fail "运行在 WSL1 — IO 性能不够 build Chromium"
  fi
else
  check_warn "未检测到 Microsoft kernel signature — 可能是原生 Linux（也行）"
fi

# 运行用户
if [[ "${EUID}" -eq 0 ]]; then
  check_fail "以 root 运行 — depot_tools / gclient 拒绝 root，请切普通用户（见 setup-user.sh）"
else
  check_pass "运行用户 = $(whoami) (uid=${EUID})"
fi

# ── 2. 硬件资源 ─────────────────────────────────────────────────
section "2. 硬件资源"
TOTAL_MEM_KB=$(grep '^MemTotal:' /proc/meminfo | awk '{print $2}')
TOTAL_MEM_GB=$((TOTAL_MEM_KB / 1024 / 1024))
if [[ "${TOTAL_MEM_GB}" -ge 11 ]]; then
  check_pass "RAM = ${TOTAL_MEM_GB}GB（WSL 已正确分到 12GB 左右）"
elif [[ "${TOTAL_MEM_GB}" -ge 7 ]]; then
  check_warn "RAM = ${TOTAL_MEM_GB}GB — .wslconfig 可能未生效，建议加大 memory= 配置"
else
  check_fail "RAM = ${TOTAL_MEM_GB}GB — 太低无法 build Chromium"
fi

CPU_COUNT=$(nproc)
if [[ "${CPU_COUNT}" -ge 4 ]]; then
  check_pass "CPU 核数 = ${CPU_COUNT}"
elif [[ "${CPU_COUNT}" -ge 2 ]]; then
  check_warn "CPU 核数 = ${CPU_COUNT}（.wslconfig processors= 可能未生效）"
else
  check_fail "CPU 核数 = ${CPU_COUNT}（太少）"
fi

SWAP_KB=$(grep '^SwapTotal:' /proc/meminfo | awk '{print $2}')
SWAP_GB=$((SWAP_KB / 1024 / 1024))
if [[ "${SWAP_GB}" -ge 20 ]]; then
  check_pass "Swap = ${SWAP_GB}GB（够链接阶段）"
elif [[ "${SWAP_GB}" -ge 8 ]]; then
  check_warn "Swap = ${SWAP_GB}GB（建议 24GB，链接阶段可能 OOM）"
else
  check_fail "Swap = ${SWAP_GB}GB — 链接阶段几乎必 OOM"
fi

OVERCOMMIT=$(cat /proc/sys/vm/overcommit_memory 2>/dev/null || echo unknown)
if [[ "${OVERCOMMIT}" == "1" ]]; then
  check_pass "vm.overcommit_memory = 1（链接器 mmap 友好）"
else
  check_warn "vm.overcommit_memory = ${OVERCOMMIT}（链接可能预提交失败）"
fi

# ── 3. 磁盘 ─────────────────────────────────────────────────────
section "3. 磁盘"
if [[ -d /mnt/d ]]; then
  D_AVAIL=$(df -BG /mnt/d | awk 'NR==2 {gsub("G","",$4); print $4}')
  if [[ "${D_AVAIL}" -ge 200 ]]; then
    check_pass "Windows D: 盘 (/mnt/d) 可用 ${D_AVAIL}GB"
  else
    check_warn "Windows D: 盘可用 ${D_AVAIL}GB（推荐 ≥ 200GB）"
  fi
else
  check_fail "/mnt/d 不存在"
fi

# WSL 内 ~ 所在的 vhdx 空间
HOME_AVAIL=$(df -BG "${HOME}" | awk 'NR==2 {gsub("G","",$4); print $4}')
HOME_DEV=$(df "${HOME}" | awk 'NR==2 {print $1}')
if [[ "${HOME_AVAIL}" -ge 150 ]]; then
  check_pass "~ 所在分区 (${HOME_DEV}) 可用 ${HOME_AVAIL}GB"
else
  check_warn "~ 所在分区可用 ${HOME_AVAIL}GB（fetch+build 需 ~180GB）"
fi

# ── 4. 工具链 ───────────────────────────────────────────────────
section "4. 工具链"
need_tools=(git curl python3 ninja jq tmux file lsb_release)
for tool in "${need_tools[@]}"; do
  if command -v "${tool}" > /dev/null 2>&1; then
    VERSION=$("${tool}" --version 2>&1 | head -1 | tr -d '\n' || echo '?')
    check_pass "${tool}: ${VERSION}"
  else
    check_fail "${tool}: 未安装"
  fi
done

PYTHON3_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo unknown)
if [[ "${PYTHON3_VERSION}" =~ ^3\.(8|9|10|11|12)$ ]]; then
  check_pass "python3 = ${PYTHON3_VERSION}（depot_tools 兼容）"
else
  check_warn "python3 = ${PYTHON3_VERSION}（depot_tools 未必兼容）"
fi

# ── 5. depot_tools ─────────────────────────────────────────────
section "5. depot_tools"
if command -v gclient > /dev/null 2>&1; then
  GCLIENT_PATH=$(command -v gclient)
  check_pass "gclient 在 PATH: ${GCLIENT_PATH}"
else
  check_fail "gclient 不在 PATH — 你可能没 source ~/.bashrc / 没重进 WSL"
fi

if command -v gn > /dev/null 2>&1; then
  check_pass "gn 在 PATH"
else
  check_warn "gn 不在 PATH（fetch 后会从 buildtools/ 拉到，暂时 OK）"
fi

if command -v autoninja > /dev/null 2>&1; then
  check_pass "autoninja 在 PATH"
else
  check_fail "autoninja 不在 PATH"
fi

if [[ -d "${HOME}/depot_tools/.git" ]]; then
  DT_REV=$(git -C "${HOME}/depot_tools" rev-parse --short HEAD 2>/dev/null || echo unknown)
  check_pass "depot_tools clone 完整 (rev: ${DT_REV})"
else
  check_fail "~/depot_tools/.git 不存在"
fi

# ── 6. git 配置 ────────────────────────────────────────────────
section "6. git 配置"
GIT_EMAIL=$(git config --global user.email 2>/dev/null || echo '')
GIT_NAME=$(git config --global user.name 2>/dev/null || echo '')
if [[ -n "${GIT_EMAIL}" ]] && [[ -n "${GIT_NAME}" ]]; then
  check_pass "git user = ${GIT_NAME} <${GIT_EMAIL}>"
else
  check_warn "git user.name / user.email 未设置（format-patch 时需要）"
fi

# ── 7. 网络（chromium gerrit / google source） ─────────────────
section "7. 网络可达性（要翻墙）"
PROBE_HOSTS=(
  "https://chromium.googlesource.com"
  "https://chrome-infra-packages.appspot.com"
  "https://chromiumdash.appspot.com"
)
for url in "${PROBE_HOSTS[@]}"; do
  # 只验证 TCP+TLS 握手与 HTTP 响应是否返回了状态码；不看状态码大小（某些
  # endpoint 对 HEAD 返回 405 仍算可达）。000 = 连接层失败。
  http_code=$(curl -sI --max-time 10 -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null || echo 000)
  if [[ "${http_code}" != "000" ]]; then
    check_pass "可达: ${url} (HTTP ${http_code})"
  else
    check_warn "不可达: ${url}（fetch 会失败 — 配 proxy）"
  fi
done

# ── 8. fork 仓库挂载 ───────────────────────────────────────────
section "8. fork 仓库挂载"
FORK_ROOT="/mnt/d/projects/Mosaiq/chromium-fork"
if [[ -d "${FORK_ROOT}" ]]; then
  check_pass "fork 仓库可读: ${FORK_ROOT}"
  for f in scripts/setup-wsl.sh scripts/check-env.sh patches/series.txt README.md; do
    if [[ -f "${FORK_ROOT}/${f}" ]]; then
      check_pass "  ${f}"
    else
      check_warn "  ${f} 缺失"
    fi
  done
else
  check_fail "${FORK_ROOT} 不存在 — 是不是 D: 没挂载？"
fi

# ── 9. 工作目录 ────────────────────────────────────────────────
section "9. ~/chromium 工作目录"
if [[ -d "${HOME}/chromium" ]]; then
  check_pass "~/chromium 存在"
  if [[ -d "${HOME}/chromium/src" ]]; then
    SRC_SIZE=$(du -sh "${HOME}/chromium/src" 2>/dev/null | awk '{print $1}')
    check_warn "~/chromium/src 已存在 (${SRC_SIZE}) — fetch 已开始或残留？"
  else
    check_pass "~/chromium/src 不存在（A.0 期间正常 — fetch 还没启动）"
  fi
else
  check_fail "~/chromium 不存在 — setup-wsl.sh 没跑成功"
fi

# ── 总结 ────────────────────────────────────────────────────────
section "总结"
TOTAL=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT))
printf '  %s%d%s pass   %s%d%s warn   %s%d%s fail   (共 %d 项)\n' \
  "${C_GREEN}" "${PASS_COUNT}" "${C_RESET}" \
  "${C_YELLOW}" "${WARN_COUNT}" "${C_RESET}" \
  "${C_RED}" "${FAIL_COUNT}" "${C_RESET}" \
  "${TOTAL}"

echo
if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  printf '%sA.0 验收：未通过 ✗%s\n' "${C_RED}" "${C_RESET}"
  printf '把上面的输出贴给 Cascade，会针对 FAIL 项给出修复方案。\n'
  exit 1
elif [[ "${WARN_COUNT}" -gt 0 ]]; then
  printf '%sA.0 验收：有警告但可继续 △%s\n' "${C_YELLOW}" "${C_RESET}"
  printf '把上面的输出贴给 Cascade，会评估 WARN 是否影响后续 phase。\n'
  exit 2
else
  printf '%sA.0 验收：通过 ✓%s\n' "${C_GREEN}" "${C_RESET}"
  printf '可以贴输出给 Cascade，确认后启动 A.1.a fetch chromium。\n'
  exit 0
fi
