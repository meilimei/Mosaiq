#!/usr/bin/env bash
# Mosaiq Chromium Fork — A.1.b 切到 stable tag + 同步 DEPS
#
# 前置：A.1.a fetch chromium 已完成（~/chromium/src/.git 存在，tmux session 已结束）
#
# 用法：
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/checkout-stable.sh
#
# 这步做：
#   1. 读 chromium-fork/.chromium-version → 拿目标 tag（例：134.0.6998.117）
#   2. cd ~/chromium/src
#   3. git fetch origin --tags (拉所有 tag refs)
#   4. git checkout {tag}
#   5. cd ~/chromium
#   6. gclient sync -D --with_branch_heads --with_tags
#      （-D 删除 DEPS 已移除的子仓；--with_branch_heads/tags 拉 branch heads 用于 tag）
#
# 预计耗时：1-3 小时（gclient sync 拉 tag 对应的 DEPS 版本差异）

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly VERSION_FILE="${REPO_ROOT}/.chromium-version"
readonly WORKDIR="${HOME}/chromium"
readonly SRC="${WORKDIR}/src"
readonly LOGFILE="${WORKDIR}/checkout-stable.log"

printf '%s%sMosaiq Chromium Fork — A.1.b checkout-stable%s\n\n' "${C_BOLD}" "${C_BLUE}" "${C_RESET}"

# ── 1. 拒绝 root ──────────────────────────────────────────────
if [[ "${EUID}" -eq 0 ]]; then
  log_error "禁止 root 跑"
  exit 1
fi

# ── 2. 读 target tag ──────────────────────────────────────────
if [[ ! -f "${VERSION_FILE}" ]]; then
  log_error "找不到 ${VERSION_FILE}"
  exit 2
fi
TARGET_TAG=$(tr -d '[:space:]' < "${VERSION_FILE}")
if [[ -z "${TARGET_TAG}" ]]; then
  log_error ".chromium-version 内容为空"
  exit 2
fi
log_info "目标 tag: ${TARGET_TAG}"

# ── 3. 校验 fetch 已完成 ─────────────────────────────────────
if [[ ! -d "${SRC}/.git" ]]; then
  log_error "${SRC}/.git 不存在 — A.1.a fetch 还没完成？"
  log_error "提示：bash ${SCRIPT_DIR}/fetch-progress.sh 看 fetch 状态"
  exit 3
fi
log_ok "${SRC}/.git 存在"

# 检查 fetch session 还在不（如果还在，警告但允许继续 — gclient sync 是幂等的）
if tmux has-session -t fetch-chromium 2>/dev/null; then
  log_warn "tmux 'fetch-chromium' session 还在 — 上次 fetch 可能未完工"
  log_warn "建议先看 fetch-progress.sh 确认完工后再 checkout"
fi

# ── 4. 验证 tag 存在（必要时 fetch tags） ─────────────────────
log_info "Step 1/3: fetch tags from origin（拿到 ${TARGET_TAG} 等所有 tag refs）"
cd "${SRC}"

if git rev-parse --verify "refs/tags/${TARGET_TAG}" > /dev/null 2>&1; then
  log_ok "tag ${TARGET_TAG} 已存在本地"
else
  log_info "本地无 ${TARGET_TAG}，从 origin 拉 tags..."
  if ! git fetch origin --tags 2>&1 | tee -a "${LOGFILE}"; then
    log_error "git fetch tags 失败 — 检查网络/VPN"
    exit 4
  fi
  if ! git rev-parse --verify "refs/tags/${TARGET_TAG}" > /dev/null 2>&1; then
    log_error "fetch 后仍找不到 tag ${TARGET_TAG}"
    log_error "确认 .chromium-version 内容是有效 chromium release tag"
    log_error "可用 tags 示例: git -C ${SRC} tag -l '134.*' | head -10"
    exit 4
  fi
fi

# ── 5. checkout tag ───────────────────────────────────────────
log_info "Step 2/3: git checkout ${TARGET_TAG}"
{
  echo "[BEGIN] $(date -Iseconds) checkout-stable"
  echo "[TARGET] ${TARGET_TAG}"
} | tee -a "${LOGFILE}"

# 检查是否已在目标 tag
CURRENT_HEAD=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)
if [[ "${CURRENT_HEAD}" == "${TARGET_TAG}" ]]; then
  log_ok "已在 ${TARGET_TAG}（跳过 checkout）"
else
  log_info "当前在 ${CURRENT_HEAD}，切到 ${TARGET_TAG}..."
  if ! git checkout "tags/${TARGET_TAG}" -B "release-${TARGET_TAG}" 2>&1 | tee -a "${LOGFILE}"; then
    log_error "git checkout 失败 — 工作树可能不干净"
    log_error "查看：cd ${SRC} && git status"
    exit 5
  fi
fi
log_ok "src/ HEAD 在 ${TARGET_TAG}"

# ── 6. gclient sync 到 tag ─────────────────────────────────────
log_info "Step 3/3: gclient sync -D --with_branch_heads --with_tags"
log_info "（预计 1-3 小时，拉 DEPS 子仓的对应版本）"

cd "${WORKDIR}"

# 写一个 tmux session 跑 sync，避免长时间占用当前 shell
SYNC_SESSION="sync-stable"
if tmux has-session -t "${SYNC_SESSION}" 2>/dev/null; then
  log_warn "tmux ${SYNC_SESSION} 已存在 — 跳过启动，加入进去看"
  log_info "命令：tmux attach -t ${SYNC_SESSION}"
  exit 0
fi

tmux new-session -d -s "${SYNC_SESSION}" -c "${WORKDIR}" bash -c "
  export PATH=\"\${HOME}/depot_tools:\${PATH}\"
  export DEPOT_TOOLS_UPDATE=1
  export DEPOT_TOOLS_METRICS=0
  echo '[BEGIN] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  echo '[CMD]   gclient sync -D --with_branch_heads --with_tags' | tee -a '${LOGFILE}'
  echo '----------------------------------------' | tee -a '${LOGFILE}'
  stdbuf -oL -eL gclient sync -D --with_branch_heads --with_tags 2>&1 | tee -a '${LOGFILE}'
  exit_code=\${PIPESTATUS[0]}
  echo '----------------------------------------' | tee -a '${LOGFILE}'
  echo '[END exit='\${exit_code}'] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  exec bash
"

sleep 2
if tmux has-session -t "${SYNC_SESSION}" 2>/dev/null; then
  log_ok "gclient sync 已在 tmux session '${SYNC_SESSION}' 后台启动"
else
  log_error "tmux session 启动失败"
  exit 6
fi

echo
log_info "操作命令："
echo "  看进度：tmux attach -t ${SYNC_SESSION}   (Ctrl+B D 退出不停 sync)"
echo "  日志：  tail -f ${LOGFILE}"
echo "  状态：  tmux has-session -t ${SYNC_SESSION} && echo ALIVE || echo DEAD"
echo
log_warn "完工后会有 [END exit=0]，再跑：bash ${SCRIPT_DIR}/install-build-deps.sh"
