#!/usr/bin/env bash
# Mosaiq Chromium Fork — Apply Patch Series
#
# 在 ~/chromium/src 内调用（已 git checkout 到 .chromium-version 指定的 stable tag）：
#   bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/apply-patches.sh [选项]
#
# 选项：
#   (无)        实际应用所有 patch（修改 working tree）
#   --dry-run   只跑 git apply --check 验证能否干净应用，不动 working tree
#   --list      只列出 series.txt 配置 + patches/ 实际文件对照，不应用任何东西
#   --verify    校验 series.txt 与 patches/*.patch 文件一致性（孤儿 / 缺失检测）
#
# 退出码：
#   0 = 成功（或 series 为空 no-op）
#   1 = patch 应用失败 / 冲突
#   2 = 环境/配置错误（不在 src 内、找不到 series.txt 等）
#   3 = --verify 发现不一致

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly SERIES="${REPO_ROOT}/patches/series.txt"
readonly PATCHES_DIR="${REPO_ROOT}/patches"

readonly C_RED=$'\033[0;31m'
readonly C_GREEN=$'\033[0;32m'
readonly C_YELLOW=$'\033[1;33m'
readonly C_BLUE=$'\033[0;34m'
readonly C_RESET=$'\033[0m'

log()   { printf '[apply-patches] %s\n' "$*"; }
fail()  { printf '%s[apply-patches] FAIL%s %s\n' "${C_RED}"    "${C_RESET}" "$*" >&2; }
ok()    { printf '%s[apply-patches] OK%s   %s\n' "${C_GREEN}"  "${C_RESET}" "$*"; }
warn()  { printf '%s[apply-patches] WARN%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; }
info()  { printf '%s[apply-patches] INFO%s %s\n' "${C_BLUE}"   "${C_RESET}" "$*"; }

# ── 解析 flag ─────────────────────────────────────────────────
MODE="apply"
for arg in "$@"; do
  case "${arg}" in
    --dry-run) MODE="dry-run" ;;
    --list)    MODE="list" ;;
    --verify)  MODE="verify" ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      fail "未知参数：${arg}"
      fail "用法：apply-patches.sh [--dry-run|--list|--verify]"
      exit 2
      ;;
  esac
done

# ── 解析 series.txt ───────────────────────────────────────────
if [[ ! -f "${SERIES}" ]]; then
  fail "找不到 ${SERIES}"
  exit 2
fi

declare -a PATCHES_FROM_SERIES=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line//[[:space:]]/}"
  [[ -z "${line}" ]] && continue
  PATCHES_FROM_SERIES+=("${line}")
done < "${SERIES}"

# ── --list / --verify 模式：不需要在 src/ 也能跑 ──────────────
if [[ "${MODE}" == "list" ]] || [[ "${MODE}" == "verify" ]]; then
  info "series.txt 列出 ${#PATCHES_FROM_SERIES[@]} 个 patch"
  for p in "${PATCHES_FROM_SERIES[@]}"; do
    if [[ -f "${PATCHES_DIR}/${p}" ]]; then
      size=$(wc -l < "${PATCHES_DIR}/${p}" | tr -d ' ')
      ok "  ${p} (${size} lines)"
    else
      fail "  ${p} — 文件不存在!"
    fi
  done

  # 孤儿 patch 检测（patches/*.patch 文件存在但 series.txt 没引用）
  echo
  info "孤儿 patch 检测（patches/*.patch 但不在 series.txt）："
  declare -i orphan_count=0
  if compgen -G "${PATCHES_DIR}/*.patch" > /dev/null; then
    for f in "${PATCHES_DIR}"/*.patch; do
      basename_f=$(basename "${f}")
      found=0
      for s in "${PATCHES_FROM_SERIES[@]}"; do
        if [[ "${s}" == "${basename_f}" ]]; then
          found=1
          break
        fi
      done
      if [[ "${found}" -eq 0 ]]; then
        warn "  孤儿: ${basename_f}"
        orphan_count=$((orphan_count + 1))
      fi
    done
  fi
  if [[ "${orphan_count}" -eq 0 ]]; then
    ok "  无孤儿"
  fi

  # 缺失 patch 文件检测（series 引用但文件不存在）
  echo
  info "缺失 patch 文件检测（series.txt 引用但 patches/ 里没有）："
  declare -i missing_count=0
  for s in "${PATCHES_FROM_SERIES[@]}"; do
    if [[ ! -f "${PATCHES_DIR}/${s}" ]]; then
      fail "  缺失: ${s}"
      missing_count=$((missing_count + 1))
    fi
  done
  if [[ "${missing_count}" -eq 0 ]]; then
    ok "  无缺失"
  fi

  if [[ "${MODE}" == "verify" ]]; then
    if [[ "${orphan_count}" -gt 0 ]] || [[ "${missing_count}" -gt 0 ]]; then
      fail "校验失败：${orphan_count} 孤儿 + ${missing_count} 缺失"
      exit 3
    fi
    ok "校验通过"
  fi
  exit 0
fi

# ── apply / dry-run：必须在 chromium src 目录内 ────────────────
if [[ ! -f .gn ]] || [[ ! -d third_party/blink ]]; then
  fail "当前目录不是 chromium src（找不到 .gn / third_party/blink/）"
  fail "请 cd ~/chromium/src 再跑这个脚本"
  exit 2
fi

# 校验 chromium 在期望的 stable tag
EXPECTED_TAG=$(cat "${REPO_ROOT}/.chromium-version" 2>/dev/null || echo "")
if [[ -n "${EXPECTED_TAG}" ]]; then
  CURR_HEAD=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)
  if [[ "${CURR_HEAD}" != "${EXPECTED_TAG}" ]]; then
    warn "当前 git HEAD = ${CURR_HEAD}，预期 = ${EXPECTED_TAG}"
    warn "继续，但 patch 可能出现行号偏移"
  fi
fi

if [[ ${#PATCHES_FROM_SERIES[@]} -eq 0 ]]; then
  ok "series.txt 为空（Phase A.0/A.1 期间正常） — no-op"
  exit 0
fi

case "${MODE}" in
  dry-run)
    log "DRY-RUN — 只验证不应用 (${#PATCHES_FROM_SERIES[@]} 个 patch)"
    ;;
  apply)
    log "APPLY — 将依次应用 ${#PATCHES_FROM_SERIES[@]} 个 patch"
    ;;
esac
for p in "${PATCHES_FROM_SERIES[@]}"; do
  printf '  - %s\n' "${p}"
done
echo

# ── 逐个 apply / check ────────────────────────────────────────
declare -i applied=0
for patch_name in "${PATCHES_FROM_SERIES[@]}"; do
  patch_path="${PATCHES_DIR}/${patch_name}"
  if [[ ! -f "${patch_path}" ]]; then
    fail "找不到 ${patch_path}"
    fail "已成功 ${applied} / ${#PATCHES_FROM_SERIES[@]}"
    exit 1
  fi

  if [[ "${MODE}" == "dry-run" ]]; then
    log "Checking ${patch_name} ..."
    if git apply --3way --check "${patch_path}" 2>/dev/null; then
      ok "${patch_name} (clean)"
      applied=$((applied + 1))
    else
      fail "${patch_name} — 应用会失败"
      git apply --3way --check "${patch_path}" 2>&1 | sed 's/^/    /' || true
      fail "已 OK ${applied} / ${#PATCHES_FROM_SERIES[@]}"
      exit 1
    fi
  else
    log "Applying ${patch_name} ..."
    if git apply --3way --check "${patch_path}" 2>/dev/null; then
      git apply --3way "${patch_path}"
      ok "${patch_name}"
      applied=$((applied + 1))
    else
      fail "${patch_name} 应用失败"
      fail "冲突详情："
      git apply --3way --check "${patch_path}" 2>&1 | sed 's/^/    /' || true
      fail "已成功 ${applied} / ${#PATCHES_FROM_SERIES[@]}"
      fail "处理 SOP：见 docs/CHROMIUM-FORK-GUIDE.md §4.3"
      exit 1
    fi
  fi
done

if [[ "${MODE}" == "dry-run" ]]; then
  ok "全部 ${applied} 个 patch dry-run 通过（实际不应用，工作树未改）"
else
  ok "全部 ${applied} 个 patch 应用成功"
fi
