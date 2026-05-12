#!/usr/bin/env bash
# Mosaiq Chromium Fork — A.1.a fetch chromium 源码下载启动器
#
# 用法：
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/start-fetch.sh
#
# 这是 Phase A 最长的单向任务。本脚本：
#   1. 启动一个分离的 tmux session 'fetch-chromium'
#   2. 在会话里跑：fetch --nohooks --no-history chromium
#      - --nohooks    跳过 hook 阶段；hook 后面单独跑
#      - --no-history shallow clone（只拿 HEAD 附近 commits）—— 从 65 GB / 12h
#                     压到 ~20-30 GB / 3-5h，对 Mosaiq fork 够用
#      要拉完整 history：env FULL_HISTORY=1 bash start-fetch.sh
#   3. 所有输出 tee 到 ~/chromium/fetch.log（行缓冲，tail -f 实时可见）
#   4. fetch 结束后自动 echo EXIT_CODE 留底，bash 留 session 不退出便于 debug
#
# 启动后可以：
#   - 关闭 IDE / 关闭 PowerShell — 不影响 fetch（tmux daemon 在 WSL VM 内继续跑）
#   - tail -f ~/chromium/fetch.log  ← 任何时候看进度
#   - tmux attach -t fetch-chromium ← 进会话；Ctrl+B 再按 D 退出（不停 fetch）
#   - du -sh ~/chromium             ← 看磁盘占用增长
#
# ❗ 不要：
#   - wsl --shutdown  ← 会杀掉 tmux daemon，fetch 中断（虽可续，但浪费时间）
#   - 关 VPN          ← git 连接会断
#   - 关机 / Windows 自动重启

# shellcheck disable=SC2088  # tilde 在日志文本里仅供展示，不需展开
set -euo pipefail

# Defensive PATH
if [[ -d "${HOME}/depot_tools" ]] && [[ ":${PATH}:" != *":${HOME}/depot_tools:"* ]]; then
  export PATH="${HOME}/depot_tools:${PATH}"
fi

readonly WORKDIR="${HOME}/chromium"
readonly LOGFILE="${WORKDIR}/fetch.log"
readonly SESSION="fetch-chromium"

# 默认 shallow clone（只拿 HEAD 附近 commits）。设 FULL_HISTORY=1 拉全 git history。
if [[ "${FULL_HISTORY:-0}" == "1" ]]; then
  readonly FETCH_ARGS="--nohooks"
  readonly FETCH_MODE="full-history (约 65 GB / 12h)"
else
  readonly FETCH_ARGS="--nohooks --no-history"
  readonly FETCH_MODE="shallow / no-history (约 20-30 GB / 3-5h)"
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

printf '%s%sMosaiq Chromium Fork — A.1.a fetch 启动器%s\n\n' "${C_BOLD}" "${C_BLUE}" "${C_RESET}"

# ── 1. 依赖检查 ────────────────────────────────────────────────
for tool in tmux fetch gclient; do
  if ! command -v "${tool}" > /dev/null 2>&1; then
    log_error "${tool} 不在 PATH —— 跑 setup-wsl.sh 了吗？跑 check-env.sh 验证"
    exit 1
  fi
done
log_ok "tmux / fetch / gclient 全部可用"

# ── 2. 拒绝 root ──────────────────────────────────────────────
if [[ "${EUID}" -eq 0 ]]; then
  log_error "禁止 root 跑 fetch — 切普通用户（见 setup-user.sh）"
  exit 1
fi

# ── 3. 检查既有 session ────────────────────────────────────────
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  log_warn "tmux session '${SESSION}' 已存在 — 不重复启动"
  echo
  echo "  进入观察： tmux attach -t ${SESSION}"
  echo "  看日志：   tail -f ${LOGFILE}"
  echo "  强制清理： tmux kill-session -t ${SESSION}  (会杀掉正在跑的 fetch！)"
  exit 0
fi

# ── 4. 检查既有 .gclient 防止误操作 ────────────────────────────
mkdir -p "${WORKDIR}"
if [[ -f "${WORKDIR}/.gclient" ]] && [[ -d "${WORKDIR}/src/.git" ]]; then
  log_warn "${WORKDIR}/.gclient + src/.git 都已存在 — 看起来上次 fetch 已完成或中断后未清理"
  echo
  echo "如果上次中断要 **续传**："
  echo "  cd ${WORKDIR} && gclient sync --no-history --shallow"
  echo
  echo "如果要**从头**重新 fetch（**慎重，会删 src/ 几十 GB**）："
  echo "  rm -rf ${WORKDIR}/.gclient ${WORKDIR}/.gclient_entries ${WORKDIR}/src"
  echo "  然后重跑本脚本"
  exit 2
fi

# ── 5. 网络快速预检 ───────────────────────────────────────────
log_info "网络预检（chromium gerrit + CIPD）..."
http_gs=$(curl -sI --max-time 10 -o /dev/null -w '%{http_code}' \
            https://chromium.googlesource.com 2>/dev/null || echo 000)
http_cipd=$(curl -sI --max-time 10 -o /dev/null -w '%{http_code}' \
            https://chrome-infra-packages.appspot.com 2>/dev/null || echo 000)
if [[ "${http_gs}" == "000" ]] || [[ "${http_cipd}" == "000" ]]; then
  log_error "网络不可达 — gerrit=${http_gs} cipd=${http_cipd}"
  log_error "确认 VPN 已开启 + WSL 能直连"
  exit 3
fi
log_ok "网络可达 (gerrit=${http_gs} cipd=${http_cipd})"

# ── 6. 磁盘空间预检 ───────────────────────────────────────────
home_avail_gb=$(df -BG "${WORKDIR}" | awk 'NR==2 {gsub("G","",$4); print $4}')
if [[ "${home_avail_gb}" -lt 60 ]]; then
  log_error "~/chromium 所在分区可用 ${home_avail_gb}GB — fetch 至少需 ~50GB"
  exit 4
fi
log_ok "~/chromium 分区可用 ${home_avail_gb}GB"

# ── 7. 启动 ───────────────────────────────────────────────────
START_TIME=$(date -Iseconds)
log_info "启动 tmux session: ${SESSION}"
log_info "工作目录:          ${WORKDIR}"
log_info "日志文件:          ${LOGFILE}"
log_info "开始时间:          ${START_TIME}"
echo

# stdbuf -oL -eL 行缓冲，tee -a 追加（保留以前的日志若有）
# script 注入 PTY 让 fetch 内部 progress bar 行为正常
# bash -c 包装让所有命令在一个 shell 里执行
tmux new-session -d -s "${SESSION}" -c "${WORKDIR}" bash -c "
  export PATH=\"\${HOME}/depot_tools:\${PATH}\"
  # DEPOT_TOOLS_UPDATE=0 阻止 fetch 启动前自更新 depot_tools（避免 VPN 抖动时
  # depot_tools git fetch 失败导致整个 fetch 早死）。手动 cd ~/depot_tools && git pull
  # 可在网络稳定时再做。
  export DEPOT_TOOLS_UPDATE=0
  export DEPOT_TOOLS_METRICS=0
  echo '[BEGIN] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  echo '[CMD]   fetch ${FETCH_ARGS} chromium' | tee -a '${LOGFILE}'
  echo '[MODE]  ${FETCH_MODE}' | tee -a '${LOGFILE}'
  echo '[PWD]   '\$(pwd) | tee -a '${LOGFILE}'
  echo '----------------------------------------' | tee -a '${LOGFILE}'
  stdbuf -oL -eL fetch ${FETCH_ARGS} chromium 2>&1 | tee -a '${LOGFILE}'
  exit_code=\${PIPESTATUS[0]}
  echo '----------------------------------------' | tee -a '${LOGFILE}'
  echo '[END exit='\${exit_code}'] '\$(date -Iseconds) | tee -a '${LOGFILE}'
  echo '[INFO] tmux session stays alive for inspection; exit with: exit / Ctrl+D'
  exec bash
"

sleep 2

if tmux has-session -t "${SESSION}" 2>/dev/null; then
  log_ok "fetch 已在 tmux session '${SESSION}' 后台启动 ✓"
else
  log_error "tmux session 启动失败 — 看 ${LOGFILE} 或重试"
  exit 5
fi

echo
printf '%s%s下一步操作：%s\n' "${C_BOLD}" "${C_YELLOW}" "${C_RESET}"
echo "  实时看日志：     tail -f ${LOGFILE}"
echo "  进 tmux 看实时： tmux attach -t ${SESSION}"
echo "                   （Ctrl+B 然后 D 退出，**不会**停止 fetch）"
echo "  看占用增长：     du -sh ${WORKDIR}"
echo "  session 状态：   tmux has-session -t ${SESSION} && echo ALIVE || echo DEAD"
echo "  紧急停止：       tmux kill-session -t ${SESSION}"
echo
log_warn "fetch 预计 ${FETCH_MODE}"
log_warn "完工后会看到 [END exit=0] 标记；非 0 表示有错，把日志末尾贴给 Cascade"
log_warn "中途任意时刻跑 fetch-progress.sh 可看进度"
