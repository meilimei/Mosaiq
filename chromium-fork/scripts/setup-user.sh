#!/usr/bin/env bash
# Mosaiq Chromium Fork — 创建 mosaiq 普通用户 + 配 /etc/wsl.conf
#
# 何时需要：当前 distro 默认用户是 root（常见于 wsl --import 导入的 rootfs，或
# 某些预装镜像）。depot_tools / gclient / install-build-deps.sh 都要求非 root。
#
# 必须以 root 运行（WSL 默认进来就是 root 的场景）：
#   wsl -d <distro>                      # 以 root 进来
#   sudo bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/setup-user.sh
#   exit                                  # 退出 WSL
#   wsl --shutdown                        # (PowerShell) 让 wsl.conf 生效
#   wsl -d <distro>                      # 再进来，这次 whoami 应该是 mosaiq
#
# 这个脚本做的事：
#   1. 检测是否以 root 运行（不是 root 就拒绝）
#   2. 创建 mosaiq 用户（若已存在则跳过）
#   3. 加入 sudo 组 + 配 NOPASSWD sudo（装 build deps 时大量 sudo 不想交互）
#   4. 预创建常用工作目录（~/chromium / ~/depot_tools 的父目录）
#   5. 写 /etc/wsl.conf 的 [user] default=mosaiq
#   6. 打印下一步操作

set -euo pipefail

readonly C_RED=$'\033[0;31m'
readonly C_GREEN=$'\033[0;32m'
readonly C_YELLOW=$'\033[0;33m'
readonly C_BLUE=$'\033[0;34m'
readonly C_BOLD=$'\033[1m'
readonly C_RESET=$'\033[0m'

log_info()  { printf '%s[INFO]%s %s\n'  "${C_BLUE}"   "${C_RESET}" "$*"; }
log_ok()    { printf '%s[ OK ]%s %s\n'  "${C_GREEN}"  "${C_RESET}" "$*"; }
log_warn()  { printf '%s[WARN]%s %s\n'  "${C_YELLOW}" "${C_RESET}" "$*"; }
log_error() { printf '%s[FAIL]%s %s\n'  "${C_RED}"    "${C_RESET}" "$*" >&2; }

readonly TARGET_USER="${MOSAIQ_USER:-mosaiq}"

printf '%s%sMosaiq Chromium Fork — 普通用户创建器%s\n\n' "${C_BOLD}" "${C_BLUE}" "${C_RESET}"

# ── 1. 必须 root ──────────────────────────────────────────────
if [[ "${EUID}" -ne 0 ]]; then
  log_error "本脚本必须以 root 运行（用 sudo 或在默认 root 的 distro 内直接跑）"
  log_error "用法：sudo bash $0"
  exit 1
fi
log_ok "以 root 运行（uid=0）"

# ── 2. 验证 Ubuntu ───────────────────────────────────────────
if [[ ! -f /etc/os-release ]]; then
  log_error "找不到 /etc/os-release"
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  log_error "需要 Ubuntu，检测到 ${ID:-unknown}"
  exit 1
fi
log_ok "OS = ${PRETTY_NAME}"

# ── 3. 创建或跳过用户 ────────────────────────────────────────
if id -u "${TARGET_USER}" > /dev/null 2>&1; then
  log_info "用户 ${TARGET_USER} 已存在，跳过创建"
else
  log_info "创建用户 ${TARGET_USER}（shell=/bin/bash, home=/home/${TARGET_USER}）"
  # -m 建 home，-s bash shell，-G 加次要组（会报 sudo 不存在先不加）
  useradd -m -s /bin/bash "${TARGET_USER}"
  log_ok "用户 ${TARGET_USER} 已创建（uid=$(id -u "${TARGET_USER}")）"
  log_warn "未设密码 —— 建议等会儿跑：sudo passwd ${TARGET_USER}"
  log_warn "（WSL 内本地登录不需要密码，但 sudo 如不配 NOPASSWD 需要）"
fi

# ── 4. sudo 组 + NOPASSWD ────────────────────────────────────
if ! getent group sudo > /dev/null 2>&1; then
  log_warn "sudo 组不存在（minimal rootfs？），跳过加组"
else
  if id -nG "${TARGET_USER}" | tr ' ' '\n' | grep -qx 'sudo'; then
    log_info "${TARGET_USER} 已在 sudo 组"
  else
    usermod -aG sudo "${TARGET_USER}"
    log_ok "${TARGET_USER} 已加入 sudo 组"
  fi
fi

# 装 sudo 命令自身（有些 minimal rootfs 没装）
if ! command -v sudo > /dev/null 2>&1; then
  log_info "apt 安装 sudo 包"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo
fi

SUDOERS_FILE="/etc/sudoers.d/90-mosaiq-nopasswd"
if [[ -f "${SUDOERS_FILE}" ]]; then
  log_info "NOPASSWD sudo 规则已存在：${SUDOERS_FILE}"
else
  # 写 NOPASSWD 让 apt-get / install-build-deps.sh 不被交互卡住
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${TARGET_USER}" > "${SUDOERS_FILE}"
  chmod 0440 "${SUDOERS_FILE}"
  # 做语法校验
  if visudo -c -f "${SUDOERS_FILE}" > /dev/null 2>&1; then
    log_ok "已写 NOPASSWD sudo 规则：${SUDOERS_FILE}"
  else
    log_error "sudoers 文件语法校验失败，删除：${SUDOERS_FILE}"
    rm -f "${SUDOERS_FILE}"
    exit 3
  fi
fi

# ── 5. 预建工作目录（空，setup-wsl.sh 会填内容）──────────────
TARGET_HOME="/home/${TARGET_USER}"
install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_USER}" "${TARGET_HOME}/chromium"
log_ok "创建 ${TARGET_HOME}/chromium 归属 ${TARGET_USER}"

# ── 6. /etc/wsl.conf ────────────────────────────────────────
WSL_CONF="/etc/wsl.conf"
MARKER_BEGIN="# >>> mosaiq-default-user >>>"
MARKER_END="# <<< mosaiq-default-user <<<"

# 先清掉旧的 marker 块（若有），再追加新的
if [[ -f "${WSL_CONF}" ]] && grep -qF "${MARKER_BEGIN}" "${WSL_CONF}"; then
  log_info "${WSL_CONF} 已有旧的 mosaiq 块，更新中"
  # 用 sed 删掉 marker 间所有行（含 marker 本身）
  sed -i "/^${MARKER_BEGIN}/,/^${MARKER_END}/d" "${WSL_CONF}"
fi

# 检测是否已有别的 [user] default= 段（防冲突）
if [[ -f "${WSL_CONF}" ]] && grep -Pzq '(?s)\[user\][^\[]*default\s*=' "${WSL_CONF}"; then
  log_warn "${WSL_CONF} 已有别的 [user] default=，**不会**覆盖。请手动编辑指向 ${TARGET_USER}"
else
  cat >> "${WSL_CONF}" <<EOF

${MARKER_BEGIN}
[user]
default=${TARGET_USER}
${MARKER_END}
EOF
  log_ok "${WSL_CONF} 已写入 [user] default=${TARGET_USER}"
fi

# ── 7. 下一步 ───────────────────────────────────────────────
echo
log_ok "setup-user.sh 完成 ✓"
echo
printf '%s%s下一步（非常重要，必须按顺序）：%s\n' "${C_BOLD}" "${C_YELLOW}" "${C_RESET}"
echo "  1. 在 WSL 内退出：exit"
echo "  2. 在 Windows PowerShell：wsl --shutdown"
echo "  3. 在 Windows PowerShell：wsl -d Ubuntu"
echo "     → 这次 whoami 应该输出：${TARGET_USER}"
echo "  4. 跑：bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/setup-wsl.sh"
echo "  5. 再退重进，跑：bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/check-env.sh"
echo
log_warn "（如需给 ${TARGET_USER} 设密码：passwd ${TARGET_USER}；WSL 本地 shell 不需要，"
log_warn " 但若要远程 SSH 或 su，则需要。NOPASSWD sudo 已配，apt-get 不会被密码卡。）"
