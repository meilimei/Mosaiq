#!/usr/bin/env bash
# Mosaiq Chromium Fork — WSL2 Ubuntu 22.04 / 24.04 一键环境准备
#
# 执行环境：WSL2 内 Ubuntu 22.04 (jammy) 或 24.04 (noble)（不在 Windows PowerShell！）
# 用法：
#   wsl -d <你的-distro>         # 常见名称：Ubuntu / Ubuntu-22.04 / Ubuntu-24.04
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/setup-wsl.sh
#
# ❗ 前置：必须以**普通用户**运行。如果当前 distro 默认用户是 root（常见于 wsl --import
#    导入的 rootfs），先跑：
#      sudo bash scripts/setup-user.sh     # 创建 mosaiq 用户
#      wsl --shutdown  (PowerShell)         # 切默认用户
#      wsl -d <distro>                      # 再进来以 mosaiq 身份
#
# 这个脚本做的事：
#   1. 验证 OS 是 Ubuntu 22.04 或 24.04
#   2. 装 apt 系统依赖（git / python3 / curl / build-essential / lsb-release / file 等）
#   3. clone depot_tools 到 ~/depot_tools
#   4. 把 ~/depot_tools 加到 ~/.bashrc 的 PATH
#   5. 创建 ~/chromium 工作目录（仅 mkdir，不 fetch）
#   6. 设置 git config 默认 user.email / user.name（为后面 git format-patch 准备）
#   7. 跑 self-test 输出 next steps
#
# 这个脚本**不**做的事：
#   - 不 fetch chromium 源码（30-50h 任务，要单独启动）
#   - 不跑 install-build-deps.sh（要 sudo + 上百个 apt 包，要 fetch 后跑）
#   - 不动 Windows 那侧的 D: 盘文件
#
# 退出码：
#   0 = 成功，可以继续 check-env.sh
#   1 = OS 版本不对
#   2 = 网络问题（depot_tools clone 失败）
#   3 = apt 装包失败

set -euo pipefail

# ── 颜色输出 ─────────────────────────────────────────────────────
readonly C_RED=$'\033[0;31m'
readonly C_GREEN=$'\033[0;32m'
readonly C_YELLOW=$'\033[1;33m'
readonly C_BLUE=$'\033[0;34m'
readonly C_RESET=$'\033[0m'

log_info()  { printf '%s[INFO]%s %s\n'  "${C_BLUE}"   "${C_RESET}" "$*"; }
log_ok()    { printf '%s[ OK ]%s %s\n'  "${C_GREEN}"  "${C_RESET}" "$*"; }
log_warn()  { printf '%s[WARN]%s %s\n'  "${C_YELLOW}" "${C_RESET}" "$*"; }
log_error() { printf '%s[FAIL]%s %s\n'  "${C_RED}"    "${C_RESET}" "$*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT

log_info "Mosaiq Chromium Fork — Phase A.0 setup"
log_info "Repo root (mounted from Windows D:): ${REPO_ROOT}"
echo

# ── 1. 验证 OS ──────────────────────────────────────────────────
log_info "Step 1/7: 检查 OS 版本"
if [[ ! -f /etc/os-release ]]; then
  log_error "找不到 /etc/os-release —— 这不是标准 Linux？"
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  log_error "需要 Ubuntu，但检测到 ${ID:-unknown}"
  exit 1
fi
case "${VERSION_ID:-}" in
  "22.04"|"24.04")
    log_ok "OS = ${PRETTY_NAME}"
    ;;
  *)
    log_warn "推荐 Ubuntu 22.04 或 24.04，当前 ${VERSION_ID:-unknown}（继续，但 install-build-deps.sh 可能报错）"
    log_ok "OS = ${PRETTY_NAME}"
    ;;
esac

# ── 1.5 拒绝 root ─────────────────────────────────────────────
if [[ "${EUID}" -eq 0 ]]; then
  log_error "不能以 root 运行 —— depot_tools / gclient / install-build-deps 均要求普通用户"
  log_error "解决：先跑 sudo bash ${SCRIPT_DIR}/setup-user.sh 创建 mosaiq 用户，"
  log_error "       wsl --shutdown 后重新进入 WSL，再重新运行本脚本。"
  exit 4
fi

# ── 2. 验证在 WSL2 ────────────────────────────────────────────
log_info "Step 2/7: 检查是否在 WSL2"
if ! grep -qi 'microsoft' /proc/version 2>/dev/null; then
  log_warn "/proc/version 里没看到 Microsoft，你可能在原生 Linux —— OK 继续"
else
  if grep -qi 'wsl2' /proc/version 2>/dev/null || [[ -n "${WSL_INTEROP:-}" ]]; then
    log_ok "在 WSL2 内"
  else
    log_warn "可能是 WSL1，建议升级到 WSL2（WSL1 的 IO 性能不足以 build Chromium）"
  fi
fi

# ── 3. 检查 D: 盘 mount ─────────────────────────────────────────
log_info "Step 3/7: 检查 D: 盘 mount"
if [[ ! -d /mnt/d ]]; then
  log_error "/mnt/d 不存在 —— D: 盘没挂载？"
  exit 1
fi
local_avail=$(df -BG /mnt/d | awk 'NR==2 {print $4}' | tr -d 'G')
if [[ -z "${local_avail}" ]] || [[ "${local_avail}" -lt 200 ]]; then
  log_warn "D: 盘可用空间 ${local_avail}GB < 200GB，可能不够 fetch + build"
else
  log_ok "D: 盘可用 ${local_avail}GB"
fi

# ── 4. 装 apt 依赖 ──────────────────────────────────────────────
log_info "Step 4/7: 装 apt 基础依赖（需要 sudo 密码）"
APT_PKGS=(
  git
  curl
  wget
  python3
  python3-pip
  python3-venv
  build-essential
  lsb-release
  file
  ca-certificates
  gnupg
  pkg-config
  ninja-build
  unzip
  zip
  jq
  tmux
)
if ! sudo apt-get update -qq; then
  log_error "apt-get update 失败 —— 检查网络 / proxy"
  exit 3
fi
if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${APT_PKGS[@]}"; then
  log_error "apt-get install 失败"
  exit 3
fi
log_ok "apt 依赖已装：${APT_PKGS[*]}"

# ── 5. depot_tools ─────────────────────────────────────────────
log_info "Step 5/7: 安装 depot_tools 到 ~/depot_tools"
DEPOT_TOOLS_DIR="${HOME}/depot_tools"
if [[ -d "${DEPOT_TOOLS_DIR}/.git" ]]; then
  log_info "depot_tools 已存在，跑 git pull 更新"
  if ! git -C "${DEPOT_TOOLS_DIR}" pull --ff-only; then
    log_warn "git pull 失败（可能是本地有改动），跳过更新"
  fi
else
  if ! git clone --depth=1 \
       https://chromium.googlesource.com/chromium/tools/depot_tools.git \
       "${DEPOT_TOOLS_DIR}"; then
    log_error "depot_tools clone 失败 —— 检查能否访问 chromium.googlesource.com（要翻墙）"
    log_error "提示：在 WSL 里设置代理：export https_proxy=http://<host>:<port>"
    exit 2
  fi
fi
log_ok "depot_tools at ${DEPOT_TOOLS_DIR}"

# ── 6. PATH + 环境变量 ─────────────────────────────────────────
# 同时写 ~/.bashrc (interactive shell) + ~/.profile (login shell)
# Ubuntu 默认 .bashrc 开头会 `[[ $- != *i* ]] && return`，non-interactive 下不跑，
# 所以 `bash -l -c` 这种 non-interactive login shell 必须靠 .profile 才能拿到 PATH。
log_info "Step 6/7: 配置 ~/.bashrc + ~/.profile"
RC_MARKER='# >>> mosaiq-chromium-fork >>>'
RC_END='# <<< mosaiq-chromium-fork <<<'
write_rc_block() {
  local rc_file="$1"
  if [[ -f "${rc_file}" ]] && grep -qF "${RC_MARKER}" "${rc_file}"; then
    log_info "${rc_file} 已有 mosaiq 配置块，跳过"
    return 0
  fi
  cat >> "${rc_file}" <<EOF

${RC_MARKER}
# Mosaiq Chromium Fork — Phase A 环境
export PATH="\${HOME}/depot_tools:\${PATH}"
export DEPOT_TOOLS_UPDATE=1
# 不让 depot_tools 的 metrics 上报
export DEPOT_TOOLS_METRICS=0
# 把 gclient cache 放 D: 盘大空间区域
export GCLIENT_CACHE_DIR="\${HOME}/chromium/.gclient_cache"
${RC_END}
EOF
  log_ok "已追加 PATH + DEPOT_TOOLS 环境变量到 ${rc_file}"
}
write_rc_block "${HOME}/.bashrc"
# ~/.profile 若不存在就 touch 一个（某些 minimal rootfs 没有）
[[ -f "${HOME}/.profile" ]] || : > "${HOME}/.profile"
write_rc_block "${HOME}/.profile"

# 当前 shell 立刻生效
export PATH="${HOME}/depot_tools:${PATH}"
export DEPOT_TOOLS_UPDATE=1
export DEPOT_TOOLS_METRICS=0

# ── 7. 创建 ~/chromium 工作目录 + git config ────────────────────
log_info "Step 7/7: 准备 ~/chromium 工作目录 + git config"
mkdir -p "${HOME}/chromium"
log_ok "${HOME}/chromium 已创建"

if ! git config --global user.email > /dev/null 2>&1; then
  log_warn "git config user.email 未设置 —— 后续 format-patch 需要"
  log_warn "运行：git config --global user.email \"you@example.com\""
  log_warn "      git config --global user.name  \"Your Name\""
fi

# ── self-test：验证 depot_tools 可用 ──────────────────────────
echo
log_info "Self-test：验证 depot_tools 命令可达"
if ! command -v gclient > /dev/null 2>&1; then
  log_error "gclient 不在 PATH —— ~/.bashrc 加了但当前 shell 未 source"
  log_error "退出后重进 WSL 或执行 'source ~/.bashrc' 后再跑 check-env.sh"
  exit 0
fi
GCLIENT_VERSION=$(gclient --version 2>&1 | head -1 || true)
log_ok "gclient 可用：${GCLIENT_VERSION}"

# ── 完工 ─────────────────────────────────────────────────────
echo
log_ok "Phase A.0 setup 完成 ✓"
echo
log_info "下一步："
echo "  1. 退出 WSL（exit）后重进，让 PATH 生效"
echo "  2. 跑 check-env.sh 全面验证："
echo "     bash ${REPO_ROOT}/scripts/check-env.sh"
echo "  3. 把输出贴给 Cascade，A.0 验收通过后再启动 A.1.a fetch"
echo
log_warn "⚠️  不要在 A.0 验收前自己跑 fetch chromium —— fetch 是 30-50h 单向任务"
