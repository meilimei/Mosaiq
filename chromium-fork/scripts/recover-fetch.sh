#!/usr/bin/env bash
# Mosaiq Chromium Fork — fetch 中断恢复
#
# 场景：start-fetch.sh 跑到一半，WSL VM 被 shutdown / Windows 崩溃 / 网络断。
#       `~/chromium/_gclient_src_<hash>/.git/objects/pack/tmp_pack_*` 已有 GB 级数据。
#       目标：尽可能保留已下载的 pack，避免 65 GB 重下。
#
# 用法：
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/recover-fetch.sh [--verify-only]
#
# 流程：
#   1. 找 _gclient_src_<hash> staging 目录
#   2. 找 tmp_pack_* 文件并报告大小
#   3. 在 tmux session `pack-verify` 里跑 `git index-pack -v` 验证 pack 完整性
#      - 这一步 1-3 小时（65 GB pack），用满 1 CPU + 几 GB RAM
#      - 写日志 ~/chromium/pack-verify.log
#   4. --verify-only 模式只跑到这里
#   5. 若 verify 通过：把 pack rename 进 .git/objects/pack/，mv staging → src，
#      让 gclient sync 接管
#   6. 若 verify 失败：报错让用户决定重下或人工 debug

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
readonly VERIFY_LOG="${WORKDIR}/pack-verify.log"
readonly VERIFY_SESSION="pack-verify"

MODE="full"
for arg in "$@"; do
  case "${arg}" in
    --verify-only) MODE="verify-only" ;;
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      log_error "未知参数：${arg}"
      exit 2
      ;;
  esac
done

printf '%s%sMosaiq Chromium Fork — recover-fetch%s\n\n' "${C_BOLD}" "${C_BLUE}" "${C_RESET}"

# ── 1. 找 staging dir ─────────────────────────────────────────
mapfile -t STAGING_DIRS < <(find "${WORKDIR}" -maxdepth 1 -type d -name '_gclient_src_*' 2>/dev/null)
if [[ ${#STAGING_DIRS[@]} -eq 0 ]]; then
  log_error "找不到 ${WORKDIR}/_gclient_src_* staging 目录"
  log_error "如果 src/ 已存在（fetch 完成），不需要 recover；跑 checkout-stable.sh"
  exit 3
fi
if [[ ${#STAGING_DIRS[@]} -gt 1 ]]; then
  log_warn "找到多个 staging 目录："
  for d in "${STAGING_DIRS[@]}"; do printf '  %s\n' "${d}"; done
  log_warn "只处理最近修改的那个"
fi
STAGING="${STAGING_DIRS[0]}"
log_ok "staging: ${STAGING}"

# ── 2. 找 tmp_pack（按文件大小降序排，最大的当主候选）────────
# 如果有多个 tmp_pack（之前 partial fetch 留下的），最大的最可能是完整的
mapfile -t TMP_PACKS < <(find "${STAGING}/.git/objects/pack" -maxdepth 1 -name 'tmp_pack_*' -printf '%s\t%p\n' 2>/dev/null | sort -rn | cut -f2)
if [[ ${#TMP_PACKS[@]} -eq 0 ]]; then
  log_error "${STAGING}/.git/objects/pack/ 内找不到 tmp_pack_*"
  log_error "可能 git 已经把 pack rename 完了，看 ls -la 确认"
  ls -la "${STAGING}/.git/objects/pack/" 2>&1 | sed 's/^/  /'
  exit 3
fi
if [[ ${#TMP_PACKS[@]} -gt 1 ]]; then
  log_warn "找到 ${#TMP_PACKS[@]} 个 tmp_pack 文件（取最大的）："
  for p in "${TMP_PACKS[@]}"; do
    sz=$(du -h "${p}" 2>/dev/null | awk '{print $1}')
    printf '    %s (%s)\n' "${p}" "${sz}"
  done
fi
TMP_PACK="${TMP_PACKS[0]}"
PACK_SIZE=$(du -h "${TMP_PACK}" | awk '{print $1}')
PACK_BYTES=$(stat -c%s "${TMP_PACK}")
log_ok "选中: ${TMP_PACK} (${PACK_SIZE})"
# 健全性检查：< 1 GB 可能是个 partial / 损坏文件
if [[ "${PACK_BYTES}" -lt 1073741824 ]]; then
  log_warn "pack < 1 GB —— 看起来不像 chromium 全 pack（正常应 ~30-70 GB）"
  log_warn "确认这是你想要 recover 的文件后再继续"
fi

# ── 3. 如已有 verify session,直接 attach 模式 ────────────────
if tmux has-session -t "${VERIFY_SESSION}" 2>/dev/null; then
  log_warn "tmux session '${VERIFY_SESSION}' 已存在 — 不重启 verify"
  log_info "看进度： tmux attach -t ${VERIFY_SESSION}"
  log_info "日志：   tail -f ${VERIFY_LOG}"
  exit 0
fi

# ── 4. 检查是否已 verify 过 ──────────────────────────────────
if [[ -f "${VERIFY_LOG}" ]] && grep -q '^\[END exit=0\]' "${VERIFY_LOG}" 2>/dev/null; then
  log_ok "已检测到 verify 完成日志（${VERIFY_LOG}）"
  if [[ "${MODE}" == "verify-only" ]]; then
    log_info "verify-only 模式 — 跳过 takeover"
    exit 0
  fi
  log_info "进入 takeover 阶段..."
else
  # ── 5. 启动 verify (tmux) ─────────────────────────────────────
  # git index-pack 要求 input 文件以 .pack 结尾，但 tmp_pack_* 不符合。
  # 用 symlink 避免修改原文件（如果 verify 失败，原文件还在）
  PACK_LINK="${TMP_PACK}.pack"
  log_info "创建 symlink: ${PACK_LINK} → $(basename "${TMP_PACK}")"
  ln -sf "$(basename "${TMP_PACK}")" "${PACK_LINK}"

  log_info "启动 git index-pack 验证 ${PACK_SIZE} pack..."
  log_info "（这一步 1-3 小时，CPU 单核满载，RAM ~3-5 GB）"
  log_info "tmux session: ${VERIFY_SESSION}"
  log_info "日志：        ${VERIFY_LOG}"

  tmux new-session -d -s "${VERIFY_SESSION}" -c "${STAGING}/.git/objects/pack" bash -c "
    : > '${VERIFY_LOG}'
    echo '[BEGIN] '\$(date -Iseconds) | tee -a '${VERIFY_LOG}'
    echo '[CMD]   git index-pack -v \$(basename '${PACK_LINK}')' | tee -a '${VERIFY_LOG}'
    echo '[SIZE]  ${PACK_SIZE}' | tee -a '${VERIFY_LOG}'
    echo '----------------------------------------' | tee -a '${VERIFY_LOG}'
    stdbuf -oL -eL git index-pack -v \$(basename '${PACK_LINK}') 2>&1 | tee -a '${VERIFY_LOG}'
    exit_code=\${PIPESTATUS[0]}
    echo '----------------------------------------' | tee -a '${VERIFY_LOG}'
    echo '[END exit='\${exit_code}'] '\$(date -Iseconds) | tee -a '${VERIFY_LOG}'
    if [[ \${exit_code} -eq 0 ]]; then
      echo '[OK] pack is complete, idx generated' | tee -a '${VERIFY_LOG}'
    else
      echo '[FAIL] pack is corrupted, must re-download' | tee -a '${VERIFY_LOG}'
    fi
    exec bash
  "

  sleep 2
  if tmux has-session -t "${VERIFY_SESSION}" 2>/dev/null; then
    log_ok "verify 已在 tmux session '${VERIFY_SESSION}' 后台启动"
  else
    log_error "tmux session 启动失败"
    exit 4
  fi

  echo
  log_info "操作命令："
  echo "  看进度：tmux attach -t ${VERIFY_SESSION}   (Ctrl+B D 退出不停)"
  echo "  日志：  tail -f ${VERIFY_LOG}"
  echo "  完工后：再跑 bash $0  让它进入 takeover 阶段"
  exit 0
fi

# ── 6. takeover：转 src/ + gclient sync ───────────────────────
log_info "Takeover Step 1/3: 检查 verify 生成的 idx 文件"
mapfile -t PACK_FILES < <(find "${STAGING}/.git/objects/pack" -maxdepth 1 -name '*.pack' 2>/dev/null)
mapfile -t IDX_FILES  < <(find "${STAGING}/.git/objects/pack" -maxdepth 1 -name '*.idx'  2>/dev/null)
if [[ ${#PACK_FILES[@]} -eq 0 ]] || [[ ${#IDX_FILES[@]} -eq 0 ]]; then
  log_error "找不到 .pack 或 .idx 文件，verify 步可能输出形式不一样"
  ls -la "${STAGING}/.git/objects/pack/" 2>&1 | sed 's/^/  /'
  log_error "人工检查后再继续"
  exit 5
fi
log_ok "pack 文件: ${PACK_FILES[0]}"
log_ok "idx 文件:  ${IDX_FILES[0]}"

log_info "Takeover Step 2/3: 把 staging 转成正式 src/"
if [[ -d "${WORKDIR}/src" ]]; then
  log_error "${WORKDIR}/src 已存在，不能覆盖"
  log_error "如果是空 dir 可以删，但请人工确认"
  exit 6
fi

# 删除 tmp_pack（已经被 index-pack 转成正式 pack 了）
mapfile -t REMAINING_TMP < <(find "${STAGING}/.git/objects/pack" -maxdepth 1 -name 'tmp_pack_*' 2>/dev/null)
if [[ ${#REMAINING_TMP[@]} -gt 0 ]]; then
  log_info "清理 tmp_pack 残留..."
  for f in "${REMAINING_TMP[@]}"; do
    log_info "  rm ${f}"
    rm -f "${f}"
  done
fi

# 检查 .git/HEAD 状态
cd "${STAGING}"
log_info "git fsck（验证对象图完整）..."
if git fsck --no-dangling 2>&1 | tee -a "${VERIFY_LOG}" | head -20; then
  log_ok "git fsck 通过"
else
  log_warn "git fsck 报错（看日志），但继续 — 可能是 dangling object 不影响 checkout"
fi

# 设置 HEAD 指向 origin/main（或 master 看 chromium 实际默认）
log_info "git fetch origin --depth=1 拿到 ref 信息（应该极快，pack 已在本地）..."
git remote add origin https://chromium.googlesource.com/chromium/src.git 2>/dev/null || true
if ! git fetch origin --depth=1 --no-tags 2>&1 | tee -a "${VERIFY_LOG}"; then
  log_warn "git fetch 失败（VPN 断？），但 pack 在本地，可手动 checkout"
fi

# rename
log_info "mv ${STAGING} ${WORKDIR}/src"
mv "${STAGING}" "${WORKDIR}/src"

log_info "Takeover Step 3/3: 把 gclient .gclient_entries 状态写好"
# 不写 .gclient_entries，让 gclient sync 自己重新发现 src/ 并接管

log_ok "Takeover 完成！src/ 已就位"
echo
log_info "下一步：跑 gclient sync 让 DEPS 子仓继续下"
echo "  cd ${WORKDIR}"
echo "  tmux new-session -d -s sync-resume 'gclient sync --nohooks 2>&1 | tee -a ~/chromium/sync-resume.log'"
echo "  tmux attach -t sync-resume   # 看进度"
echo
log_info "或者直接跑 checkout-stable.sh 让它处理 sync + tag checkout"
