#!/usr/bin/env bash
# Mosaiq Chromium Fork — A.1.d vanilla build（未打 patch 的原版构建）
#
# 前置：A.1.c install-build-deps + gclient runhooks 已完成
#       （~/chromium/src/buildtools 完整，~/chromium/src/third_party/llvm-build 已下）
#
# 用法：
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/build-vanilla.sh
#
# 这一步：
#   1. 验证 src/ 干净且在 stable tag
#   2. gn gen out/Vanilla 用 chromium 推荐的 release 默认 args
#   3. autoninja -C out/Vanilla chrome（编译主 binary）
#   4. 记录开始/结束时间，输出 binary 大小
#
# 预计耗时：
#   - gn gen:   1-2 分钟
#   - autoninja chrome: **24-48 小时**（i7-6500U 2C/4T 单台机器，这是最长的 build）
#     - 如果有 ccache / 远程编译会快得多，但 Mosaiq 不依赖
#     - 链接阶段（最后 30 分钟）会占满 12GB RAM + 24GB swap
#
# build 输出：
#   ~/chromium/src/out/Vanilla/chrome    (~250 MB stripped)
#   ~/chromium/src/out/Vanilla/*.so       (libosmesa.so 等)

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
readonly WORKDIR="${HOME}/chromium"
readonly SRC="${WORKDIR}/src"
readonly OUT_DIR="${SRC}/out/Vanilla"
readonly LOGFILE="${WORKDIR}/build-vanilla.log"
readonly BUILD_SESSION="build-vanilla"

# Build args — 针对 i7-6500U + 16GB RAM 的低端机优化
# - is_debug=false               release 编译
# - is_official_build=false      不走 PGO + LTO（链接阶段会爆 RAM）
# - symbol_level=1               减小 symbol（crash 时还能粗略 trace）
# - blink_symbol_level=0         blink 不带 symbol（最大省）
# - is_component_build=false     单 binary，更接近 release 行为
# - enable_nacl=false            NaCl deprecated，禁用省 8GB+ 编译时间
# - use_remoteexec=false         不用远程编译（Mosaiq 没 reclient 配置）
# - use_lld=true                 用 lld 链接器（比 gold 快、内存友好）
# - chrome_pgo_phase=0           禁用 PGO（PGO profile 数据 ~500MB，加载会爆 RAM）
readonly GN_ARGS='is_debug=false
is_official_build=false
symbol_level=1
blink_symbol_level=0
is_component_build=false
enable_nacl=false
use_remoteexec=false
use_lld=true
chrome_pgo_phase=0
treat_warnings_as_errors=false'

printf '%s%sMosaiq Chromium Fork — A.1.d vanilla build%s\n\n' \
  "${C_BOLD}" "${C_BLUE}" "${C_RESET}"

# ── 1. 拒绝 root ──────────────────────────────────────────────
if [[ "${EUID}" -eq 0 ]]; then
  log_error "禁止 root 跑"
  exit 1
fi

# ── 2. 验证 src/ ─────────────────────────────────────────────
if [[ ! -d "${SRC}/.git" ]]; then
  log_error "${SRC}/.git 不存在"
  exit 2
fi
if [[ ! -d "${SRC}/buildtools" ]]; then
  log_error "${SRC}/buildtools 不存在 — gclient runhooks 完成了吗？"
  exit 2
fi
if [[ ! -d "${SRC}/third_party/llvm-build/Release+Asserts" ]]; then
  log_error "clang toolchain 不存在 — gclient runhooks 完成了吗？"
  exit 2
fi
log_ok "src/ 完整（git + buildtools + clang）"

# ── 3. 验证 src/ 在期望 tag ──────────────────────────────────
EXPECTED_TAG=$(tr -d '[:space:]' < "${REPO_ROOT}/.chromium-version" 2>/dev/null || echo '')
if [[ -n "${EXPECTED_TAG}" ]]; then
  cd "${SRC}"
  CURR=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)
  if [[ "${CURR}" != "${EXPECTED_TAG}" ]]; then
    log_warn "src/ HEAD = ${CURR}，期望 ${EXPECTED_TAG}（继续，但你的产物会与预期不一致）"
  else
    log_ok "src/ HEAD = ${EXPECTED_TAG}"
  fi
fi

# ── 4. 验证 patches 状态（vanilla 阶段要求干净） ──────────────
cd "${SRC}"
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  log_warn "src/ 有未提交改动 — vanilla build 期望干净 src/"
  log_warn "如果是已 apply 的 patch，回退后再 build：cd ${SRC} && git reset --hard"
fi

# ── 5. tmux 复用检查 ──────────────────────────────────────────
if tmux has-session -t "${BUILD_SESSION}" 2>/dev/null; then
  log_warn "tmux ${BUILD_SESSION} 已存在 — 不重启"
  log_info "看进度：tmux attach -t ${BUILD_SESSION}"
  log_info "日志：  tail -f ${LOGFILE}"
  exit 0
fi

# ── 6. 检查磁盘空间 ───────────────────────────────────────────
avail=$(df -BG "${WORKDIR}" | awk 'NR==2 {gsub("G","",$4); print $4}')
if [[ "${avail}" -lt 80 ]]; then
  # shellcheck disable=SC2088  # tilde 在日志文本里仅供展示，不需展开
  log_warn "~/chromium 分区可用 ${avail}GB，vanilla build 中间产物 ~70GB"
fi
log_ok "分区可用 ${avail}GB"

# ── 7. gn gen ─────────────────────────────────────────────────
log_info "Step 1/2: gn gen ${OUT_DIR}"
mkdir -p "${OUT_DIR}"
echo "${GN_ARGS}" > "${OUT_DIR}/args.gn"
log_info "GN args 写入 ${OUT_DIR}/args.gn:"
# 缩进 4 空格显示 GN_ARGS（不依赖外部 sed/awk）
printf '    %s\n' "${GN_ARGS//$'\n'/$'\n    '}"

{
  echo "[BEGIN] $(date -Iseconds) build-vanilla"
  echo "[STAGE] gn gen"
} | tee -a "${LOGFILE}"

cd "${SRC}"
if ! gn gen "${OUT_DIR}" 2>&1 | tee -a "${LOGFILE}"; then
  log_error "gn gen 失败"
  exit 5
fi
log_ok "gn gen 完成"

# ── 8. autoninja chrome 在 tmux 里跑 ──────────────────────────
log_info "Step 2/2: autoninja -C out/Vanilla chrome（在 tmux 后台跑）"
log_warn "预计 24-48 小时（i7-6500U 单机），链接阶段会用满 12GB RAM + 24GB swap"

tmux new-session -d -s "${BUILD_SESSION}" -c "${SRC}" bash -c "
  export PATH=\"\${HOME}/depot_tools:\${PATH}\"
  export DEPOT_TOOLS_UPDATE=1
  export DEPOT_TOOLS_METRICS=0
  echo '[STAGE] autoninja chrome' | tee -a '${LOGFILE}'
  echo '[BEGIN_NINJA] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  echo '----------------------------------------' | tee -a '${LOGFILE}'
  stdbuf -oL -eL autoninja -C '${OUT_DIR}' chrome 2>&1 | tee -a '${LOGFILE}'
  exit_code=\${PIPESTATUS[0]}
  echo '----------------------------------------' | tee -a '${LOGFILE}'
  echo '[END_NINJA exit='\${exit_code}'] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  if [[ \${exit_code} -eq 0 ]] && [[ -f '${OUT_DIR}/chrome' ]]; then
    size=\$(du -h '${OUT_DIR}/chrome' | awk '{print \$1}')
    echo \"[SIZE] chrome binary: \${size}\" | tee -a '${LOGFILE}'
  fi
  echo '[END exit='\${exit_code}'] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  exec bash
"

sleep 2
if tmux has-session -t "${BUILD_SESSION}" 2>/dev/null; then
  log_ok "vanilla build 已在 tmux session '${BUILD_SESSION}' 后台启动"
else
  log_error "tmux session 启动失败"
  exit 6
fi

echo
log_info "操作命令："
echo "  看进度（autoninja 进度条）：tmux attach -t ${BUILD_SESSION}   (Ctrl+B D 退出不停)"
echo "  日志：                       tail -f ${LOGFILE}"
echo "  当前 ninja step：            tail -3 ${LOGFILE}"
echo "  内存监控：                   watch -n 5 free -h"
echo
log_warn "build 失败常见原因（贴日志末尾给 Cascade 分析）："
log_warn "  - 链接阶段 OOM：lld 段错误 / killed → 加大 .wslconfig swap"
log_warn "  - 临时空间不足：/tmp 满 → export TMPDIR=${WORKDIR}/tmp 重跑"
log_warn "  - clang ICE：toolchain 损坏 → rm -rf out/Vanilla 重跑 gn gen"
log_warn "完工后会有 [END exit=0]，A.1 全部通过 → A.2 起开始 patch 工作"
