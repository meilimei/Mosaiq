#!/usr/bin/env bash
# Mosaiq Chromium Fork — A.1.a fetch 进度快照
#
# 用法（WSL 内或 PowerShell 通过 wsl -d Ubuntu -- 调用）：
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/fetch-progress.sh
#
# 输出关键指标：tmux 状态 / 已运行时长 / 磁盘占用 / 当前活跃子进程 / 网络连接
# / 最近日志。可反复跑（只读，无副作用）。

# shellcheck disable=SC2009  # pgrep 拿不到 etime/pcpu/pmem 格式化字段，必须用 ps
set -uo pipefail

readonly C_BOLD=$'\033[1m'
readonly C_RESET=$'\033[0m'
readonly C_GREEN=$'\033[0;32m'
readonly C_YELLOW=$'\033[0;33m'
readonly C_RED=$'\033[0;31m'
readonly C_BLUE=$'\033[0;34m'

readonly SESSION="fetch-chromium"
readonly WORKDIR="${HOME}/chromium"
readonly LOGFILE="${WORKDIR}/fetch.log"

section() {
  printf '\n%s%s━━ %s ━━%s\n' "${C_BOLD}" "${C_BLUE}" "$*" "${C_RESET}"
}

printf '%sMosaiq A.1.a fetch — 进度快照%s\n' "${C_BOLD}" "${C_RESET}"
printf '快照时间: %s\n' "$(date -Iseconds)"

# ── 1. tmux session 状态 ──────────────────────────────────────
section "1. tmux session"
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  printf '  %s[ALIVE]%s tmux session %s 存活\n' "${C_GREEN}" "${C_RESET}" "${SESSION}"
else
  printf '  %s[DEAD]%s  tmux session %s 不存在（fetch 已完成或被杀）\n' \
    "${C_RED}" "${C_RESET}" "${SESSION}"
fi

# ── 2. 已运行时长 ──────────────────────────────────────────────
section "2. 已运行时长"
if [[ -f "${LOGFILE}" ]]; then
  begin_ts=$(head -5 "${LOGFILE}" | grep -oP '\[BEGIN\]\s+\K\S+' | head -1 || echo '')
  if [[ -n "${begin_ts}" ]]; then
    begin_epoch=$(date -d "${begin_ts}" +%s 2>/dev/null || echo 0)
    now_epoch=$(date +%s)
    if [[ "${begin_epoch}" -gt 0 ]]; then
      elapsed=$((now_epoch - begin_epoch))
      hours=$((elapsed / 3600))
      mins=$(( (elapsed % 3600) / 60 ))
      printf '  开始时间: %s\n' "${begin_ts}"
      printf '  已运行:   %dh %dm (%d s)\n' "${hours}" "${mins}" "${elapsed}"
    fi
  fi
  # 检测是否有 [END] 标记
  if grep -q '^\[END' "${LOGFILE}"; then
    end_line=$(grep '^\[END' "${LOGFILE}" | tail -1)
    printf '  %s[FINISHED]%s %s\n' "${C_GREEN}" "${C_RESET}" "${end_line}"
  fi
else
  printf '  %s[WARN]%s 日志文件不存在: %s\n' "${C_YELLOW}" "${C_RESET}" "${LOGFILE}"
fi

# ── 3. 磁盘占用 ────────────────────────────────────────────────
section "3. 磁盘占用"
if [[ -d "${WORKDIR}" ]]; then
  total=$(du -sh "${WORKDIR}" 2>/dev/null | awk '{print $1}')
  printf '  %s 总占用: %s\n' "${WORKDIR}" "${total}"
  if [[ -d "${WORKDIR}/src" ]]; then
    src_size=$(du -sh "${WORKDIR}/src" 2>/dev/null | awk '{print $1}')
    src_git=$(du -sh "${WORKDIR}/src/.git" 2>/dev/null | awk '{print $1}')
    printf '  ├─ src/      %s\n' "${src_size}"
    printf '  └─ src/.git/ %s\n' "${src_git}"
  fi
  avail=$(df -BG "${WORKDIR}" | awk 'NR==2 {gsub("G","",$4); print $4}')
  printf '  分区剩余: %sGB\n' "${avail}"
fi

# ── 4. 当前活跃子进程 ─────────────────────────────────────────
section "4. 活跃子进程（fetch/gclient/git/python）"
# 只显示包含相关关键字的进程
ps -eo pid,etime,pcpu,pmem,cmd 2>/dev/null | \
  grep -E 'fetch\.py|gclient\.py|git remote|git-remote|git fetch|git clone|cipd' | \
  grep -v grep | \
  awk '{printf "  PID=%-7s ELAP=%-9s CPU=%-5s MEM=%-5s %s\n", $1, $2, $3"%", $4"%", substr($0, index($0,$5), 80)}' \
  | head -10

active_count=$(ps -eo cmd 2>/dev/null | grep -cE 'fetch\.py|gclient\.py|git remote|git-remote|git fetch|git clone|cipd' || echo 0)
if [[ "${active_count}" -eq 0 ]]; then
  printf '  %s[INFO]%s 没有活跃 fetch 子进程（可能完工 / 卡住 / 完成）\n' \
    "${C_YELLOW}" "${C_RESET}"
fi

# ── 5. 网络连接 ────────────────────────────────────────────────
section "5. 网络连接（HTTPS 出站）"
ss -tn 2>/dev/null | awk 'NR>1 && $5 ~ /:443$/ {print "  " $0}' | head -10
estab=$(ss -tn 2>/dev/null | awk 'NR>1 && $5 ~ /:443$/' | wc -l)
printf '  共 %d 个 HTTPS ESTAB 连接\n' "${estab}"

# ── 6. 最近日志（tail -30） ────────────────────────────────────
section "6. 最近日志 (tail -30)"
if [[ -f "${LOGFILE}" ]]; then
  tail -30 "${LOGFILE}" | sed 's/^/  /'
else
  printf '  (无日志文件)\n'
fi

# ── 7. tmux 屏幕（capture） ────────────────────────────────────
section "7. tmux 屏幕实时快照"
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  tmux capture-pane -t "${SESSION}" -p 2>/dev/null | tail -15 | sed 's/^/  /'
else
  printf '  (tmux session 不存在)\n'
fi

echo
printf '%s完整日志:%s tail -f %s\n' "${C_BOLD}" "${C_RESET}" "${LOGFILE}"
printf '%s进入 tmux:%s tmux attach -t %s   (Ctrl+B D 退出)\n' "${C_BOLD}" "${C_RESET}" "${SESSION}"
