#!/usr/bin/env bash
# Mosaiq Chromium Fork — gclient sync 续传（DEPS 子仓中断恢复）
#
# 场景：start-fetch.sh 内部 fetch + gclient sync 在 DEPS 子仓阶段失败
#       （网络抖动 / DNS 失败 / TLS 中断），但 src/ 主仓已就位。
#       gclient sync 是幂等的，本脚本帮你后台续传。
#
# 用法：
#   wsl -d Ubuntu -- bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/sync-resume.sh
#
# 流程：
#   1. 校验 ~/chromium/.gclient 和 ~/chromium/src 都已存在
#   2. 清理 _bad_scm 隔离目录（gclient 会重新 clone）
#   3. 杀旧 tmux session 'gclient-sync'（如有）
#   4. 启动新 tmux session 跑 gclient sync --nohooks --no-history
#   5. 输出 tee 到 ~/chromium/sync.log
#
# 看进度：
#   tail -f ~/chromium/sync.log
#   tmux attach -t gclient-sync   (Ctrl+B D 退出)

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

readonly WORKDIR="${HOME}/chromium"
readonly LOGFILE="${WORKDIR}/sync.log"
readonly SESSION="gclient-sync"

# 默认 shallow（与 start-fetch.sh 一致）。FULL_HISTORY=1 opt-out。
if [[ "${FULL_HISTORY:-0}" == "1" ]]; then
  readonly SYNC_ARGS="--nohooks"
else
  readonly SYNC_ARGS="--nohooks --no-history"
fi

if [[ -d "${HOME}/depot_tools" ]] && [[ ":${PATH}:" != *":${HOME}/depot_tools:"* ]]; then
  export PATH="${HOME}/depot_tools:${PATH}"
fi

printf '%s%sMosaiq Chromium Fork — sync-resume%s\n\n' "${C_BOLD}" "${C_BLUE}" "${C_RESET}"

# ── 1. 前提检查 ──────────────────────────────────────────────
if [[ ! -f "${WORKDIR}/.gclient" ]]; then
  log_error "${WORKDIR}/.gclient 不存在 — 先跑 start-fetch.sh 让 fetch 创建主仓"
  exit 2
fi
if [[ ! -d "${WORKDIR}/src/.git" ]]; then
  log_error "${WORKDIR}/src/.git 不存在 — fetch 主仓没成功，必须重跑 start-fetch.sh"
  exit 2
fi
log_ok ".gclient 存在 ($(wc -c < "${WORKDIR}/.gclient") bytes)"
log_ok "src/.git 存在 ($(du -sh "${WORKDIR}/src/.git" | awk '{print $1}'))"

# ── 2. 清 _bad_scm 隔离目录 ──────────────────────────────────
if [[ -d "${WORKDIR}/_bad_scm" ]]; then
  bad_count=$(find "${WORKDIR}/_bad_scm" -mindepth 1 -maxdepth 4 -type d | wc -l)
  bad_size=$(du -sh "${WORKDIR}/_bad_scm" | awk '{print $1}')
  log_warn "发现 _bad_scm 隔离目录 (${bad_size}, ${bad_count} entries) — 清理"
  rm -rf "${WORKDIR}/_bad_scm"
  log_ok "_bad_scm 已清"
fi

# ── 3. 杀旧 session ──────────────────────────────────────────
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  log_warn "tmux session '${SESSION}' 已存在 — 杀掉重启"
  tmux kill-session -t "${SESSION}"
fi
# 顺便杀已结束的 fetch-chromium session（避免混淆）
if tmux has-session -t fetch-chromium 2>/dev/null; then
  if ! pgrep -f 'fetch.*chromium\|gclient.*sync' >/dev/null 2>&1; then
    log_info "fetch-chromium session 残留但无活动进程 — 清理"
    tmux kill-session -t fetch-chromium 2>/dev/null || true
  fi
fi

# ── 4. 网络快速预检 ──────────────────────────────────────────
log_info "网络预检..."
if ! curl -sS --max-time 10 -o /dev/null -w '%{http_code}\n' \
     https://chromium.googlesource.com/ 2>&1 | grep -q '^200$'; then
  log_error "chromium.googlesource.com 不可达 — 跑 network-test.sh 排查"
  exit 3
fi
log_ok "网络可达"

# ── 5. 启动 sync ─────────────────────────────────────────────
START_TIME=$(date -Iseconds)
log_info "启动 gclient sync ${SYNC_ARGS}"
log_info "tmux session: ${SESSION}"
log_info "日志:         ${LOGFILE}"
log_info "开始时间:     ${START_TIME}"

tmux new-session -d -s "${SESSION}" -c "${WORKDIR}" bash -c "
  export PATH=\"\${HOME}/depot_tools:\${PATH}\"
  export DEPOT_TOOLS_UPDATE=0
  export DEPOT_TOOLS_METRICS=0
  echo '[BEGIN] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  echo '[CMD]   gclient sync ${SYNC_ARGS}' | tee -a '${LOGFILE}'
  echo '[PWD]   '\$(pwd) | tee -a '${LOGFILE}'
  echo '----------------------------------------' | tee -a '${LOGFILE}'
  stdbuf -oL -eL gclient sync ${SYNC_ARGS} 2>&1 | tee -a '${LOGFILE}'
  exit_code=\${PIPESTATUS[0]}
  echo '----------------------------------------' | tee -a '${LOGFILE}'
  echo '[END exit='\${exit_code}'] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  echo '[INFO] tmux session stays alive for inspection; exit with: exit / Ctrl+D'
  exec bash
"

sleep 2
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  log_ok "sync-resume 已在 tmux session '${SESSION}' 后台启动"
else
  log_error "tmux session 启动失败"
  exit 4
fi

echo
printf '%s%s下一步操作：%s\n' "${C_BOLD}" "${C_YELLOW}" "${C_RESET}"
echo "  实时看日志：     tail -f ${LOGFILE}"
echo "  进 tmux 看实时： tmux attach -t ${SESSION}"
echo "                   （Ctrl+B 然后 D 退出，**不会**停止 sync）"
echo "  紧急停止：       tmux kill-session -t ${SESSION}"
echo
log_warn "sync 预计 30-90 分钟（看 DEPS 数量 + 网络）"
log_warn "完工后看到 [END exit=0]；非 0 再跑本脚本即可（gclient 幂等）"
