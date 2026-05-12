#!/usr/bin/env bash
# Mosaiq Chromium Fork — A.1.c install-build-deps wrapper
#
# 前置：A.1.b checkout-stable 已完成（~/chromium/src 在 stable tag）
#
# 用法：
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/install-build-deps.sh
#
# 这步做：
#   1. 检测 Ubuntu 版本（22.04 / 24.04）
#   2. 跑 ~/chromium/src/build/install-build-deps.sh --no-prompt
#      - --no-prompt 跳过 EULA 确认（CI / 自动化场景）
#      - 不传 --no-* 选项 → 装 host build 必需的全部依赖
#   3. 失败时打印缺包诊断、Ubuntu 版本不兼容提示
#   4. 完工后 gclient runhooks 跑 hook 步骤
#
# 预计耗时：
#   - install-build-deps.sh: 5-20 分钟（apt 装 ~200 个包，含 ttf/clang/llvm 等）
#   - gclient runhooks: 10-30 分钟（拉 NaCl SDK、prebuilt clang、Pgo profile 等
#                                  ~3 GB 资产）

set -euo pipefail

# Defensive PATH
if [[ -d "${HOME}/depot_tools" ]] && [[ ":${PATH}:" != *":${HOME}/depot_tools:"* ]]; then
  export PATH="${HOME}/depot_tools:${PATH}"
fi

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

readonly WORKDIR="${HOME}/chromium"
readonly SRC="${WORKDIR}/src"
readonly DEPS_SCRIPT="${SRC}/build/install-build-deps.sh"
readonly LOGFILE="${WORKDIR}/install-build-deps.log"

printf '%s%sMosaiq Chromium Fork — A.1.c install-build-deps%s\n\n' \
  "${C_BOLD}" "${C_BLUE}" "${C_RESET}"

# ── 1. 拒绝 root ──────────────────────────────────────────────
if [[ "${EUID}" -eq 0 ]]; then
  log_error "禁止 root 直接跑（脚本内部会用 sudo）"
  exit 1
fi

# ── 2. 验证 src/ 已 checkout ──────────────────────────────────
if [[ ! -f "${DEPS_SCRIPT}" ]]; then
  log_error "${DEPS_SCRIPT} 不存在 — checkout-stable 完成了吗？"
  exit 2
fi
log_ok "${DEPS_SCRIPT} 找到"

# ── 3. 检测 Ubuntu 版本 + 警告兼容性 ──────────────────────────
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  case "${VERSION_ID:-}" in
    "22.04")
      log_ok "Ubuntu 22.04 — install-build-deps.sh 官方支持"
      ;;
    "24.04")
      log_warn "Ubuntu 24.04 — install-build-deps.sh 官方支持范围（M128+）"
      log_warn "若个别包名漂移导致失败，会打印缺包提示"
      ;;
    *)
      log_warn "Ubuntu ${VERSION_ID:-unknown} — 非官方测试版本，可能失败"
      ;;
  esac
fi

# ── 4. 跑 install-build-deps.sh ───────────────────────────────
log_info "Step 1/2: 跑 ${DEPS_SCRIPT} --no-prompt"
log_info "（首次约 5-20 分钟，apt 装 ~200 包；以后增量装很快）"
{
  echo "[BEGIN] $(date -Iseconds) install-build-deps"
  echo "[CMD]   ${DEPS_SCRIPT} --no-prompt"
  echo "----------------------------------------"
} | tee -a "${LOGFILE}"

if stdbuf -oL -eL bash "${DEPS_SCRIPT}" --no-prompt 2>&1 | tee -a "${LOGFILE}"; then
  log_ok "install-build-deps.sh 完成"
else
  exit_code="${PIPESTATUS[0]}"
  log_error "install-build-deps.sh 失败 (exit=${exit_code})"
  log_error "看日志末尾：tail -50 ${LOGFILE}"
  log_error "常见原因："
  log_error "  - 24.04 个别包名变化 → 手动 apt install 替代包后重跑"
  log_error "  - apt 源不稳 → 切镜像源或加 retry"
  exit 3
fi
{
  echo "----------------------------------------"
  echo "[END exit=0] $(date -Iseconds) install-build-deps"
} | tee -a "${LOGFILE}"

# ── 5. gclient runhooks ───────────────────────────────────────
log_info "Step 2/2: gclient runhooks（拉 NaCl SDK / clang / pgo profile 等）"
log_info "（10-30 分钟，约 3 GB 下载）"

cd "${WORKDIR}"
HOOK_LOG="${WORKDIR}/runhooks.log"
{
  echo "[BEGIN] $(date -Iseconds) gclient runhooks"
  echo "----------------------------------------"
} | tee -a "${HOOK_LOG}"

# 用 tmux 包装，避免占用当前 shell
HOOK_SESSION="runhooks"
if tmux has-session -t "${HOOK_SESSION}" 2>/dev/null; then
  log_warn "tmux ${HOOK_SESSION} 已存在 — 跳过启动"
  log_info "看进度：tmux attach -t ${HOOK_SESSION}"
  exit 0
fi

tmux new-session -d -s "${HOOK_SESSION}" -c "${WORKDIR}" bash -c "
  export PATH=\"\${HOME}/depot_tools:\${PATH}\"
  export DEPOT_TOOLS_UPDATE=1
  export DEPOT_TOOLS_METRICS=0
  stdbuf -oL -eL gclient runhooks 2>&1 | tee -a '${HOOK_LOG}'
  exit_code=\${PIPESTATUS[0]}
  echo '----------------------------------------' | tee -a '${HOOK_LOG}'
  echo '[END exit='\${exit_code}'] '\$(date -Iseconds) | tee -a '${HOOK_LOG}'
  exec bash
"

sleep 2
if tmux has-session -t "${HOOK_SESSION}" 2>/dev/null; then
  log_ok "gclient runhooks 已在 tmux session '${HOOK_SESSION}' 后台启动"
else
  log_error "tmux session 启动失败"
  exit 4
fi

echo
log_info "操作命令："
echo "  看进度： tmux attach -t ${HOOK_SESSION}   (Ctrl+B D 退出不停)"
echo "  日志：   tail -f ${HOOK_LOG}"
echo
log_warn "完工后会有 [END exit=0]，再跑：bash $(dirname "$0")/build-vanilla.sh"
