#!/usr/bin/env bash
# Mosaiq Chromium Fork — VPN / chromium 网络可达性诊断
#
# 用法（PowerShell 调用）：
#   wsl -d Ubuntu -- bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/network-test.sh
#
# 在 fetch 启动失败时跑这个，确认 VPN 真的能跑 git+TLS。
# 输出：3 次重试的延迟统计 + depot_tools 当前 commit。

set -uo pipefail

if [[ -d "${HOME}/depot_tools" ]] && [[ ":${PATH}:" != *":${HOME}/depot_tools:"* ]]; then
  export PATH="${HOME}/depot_tools:${PATH}"
fi

readonly C_GREEN=$'\033[0;32m'
readonly C_YELLOW=$'\033[0;33m'
readonly C_RED=$'\033[0;31m'
readonly C_BLUE=$'\033[0;34m'
readonly C_BOLD=$'\033[1m'
readonly C_RESET=$'\033[0m'

printf '%s%sMosaiq Chromium Fork — network-test%s\n\n' "${C_BOLD}" "${C_BLUE}" "${C_RESET}"

echo "════════════════════════════════════════════════"
echo "1. DNS 解析"
echo "════════════════════════════════════════════════"
for host in chromium.googlesource.com chrome-infra-packages.appspot.com; do
  ip=$(getent hosts "${host}" 2>/dev/null | awk '{print $1}' | head -1)
  if [[ -n "${ip}" ]]; then
    printf '  %s[ OK ]%s %s → %s\n' "${C_GREEN}" "${C_RESET}" "${host}" "${ip}"
  else
    printf '  %s[FAIL]%s %s\n' "${C_RED}" "${C_RESET}" "${host}"
  fi
done

echo
echo "════════════════════════════════════════════════"
echo "2. TLS handshake (curl) × 3"
echo "════════════════════════════════════════════════"
declare -i tls_ok=0
declare -i tls_fail=0
for i in 1 2 3; do
  printf '  try %d: ' "${i}"
  if curl -sS -w 'code=%{http_code} dns=%{time_namelookup}s tls=%{time_appconnect}s total=%{time_total}s\n' \
       -o /dev/null --max-time 30 https://chromium.googlesource.com/ 2>&1; then
    tls_ok=$((tls_ok + 1))
  else
    tls_fail=$((tls_fail + 1))
    printf '%s    [FAIL]%s\n' "${C_RED}" "${C_RESET}"
  fi
done
echo
printf '  TLS 结果：%d/3 通过\n' "${tls_ok}"

echo
echo "════════════════════════════════════════════════"
echo "3. git ls-remote × 3"
echo "════════════════════════════════════════════════"
declare -i git_ok=0
declare -i git_fail=0
for i in 1 2 3; do
  printf '  try %d: ' "${i}"
  start=$(date +%s%3N)
  if out=$(git ls-remote --heads https://chromium.googlesource.com/chromium/src.git HEAD 2>&1); then
    end=$(date +%s%3N)
    elapsed=$((end - start))
    head_sha=$(echo "${out}" | head -1 | awk '{print substr($1,1,12)}')
    printf '%s[ OK ]%s %dms HEAD=%s\n' "${C_GREEN}" "${C_RESET}" "${elapsed}" "${head_sha}"
    git_ok=$((git_ok + 1))
  else
    end=$(date +%s%3N)
    elapsed=$((end - start))
    printf '%s[FAIL]%s %dms\n' "${C_RED}" "${C_RESET}" "${elapsed}"
    echo "${out}" | sed 's/^/         /' | head -3
    git_fail=$((git_fail + 1))
  fi
done
echo
printf '  git 结果：%d/3 通过\n' "${git_ok}"

echo
echo "════════════════════════════════════════════════"
echo "4. depot_tools 状态"
echo "════════════════════════════════════════════════"
if [[ -d "${HOME}/depot_tools/.git" ]]; then
  cd "${HOME}/depot_tools"
  echo "  分支: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "  当前: $(git log -1 --format='%h %ar — %s' 2>/dev/null)"
  if git fetch --dry-run origin 2>&1 | head -3 | sed 's/^/  /'; then
    echo "  fetch 模拟正常"
  else
    echo "  fetch 模拟失败 — 上游不可达"
  fi
else
  echo "  ✗ ~/depot_tools/.git 不存在"
fi

echo
echo "════════════════════════════════════════════════"
echo "总结"
echo "════════════════════════════════════════════════"
if [[ ${git_ok} -ge 2 && ${tls_ok} -ge 2 ]]; then
  printf '%s[ OK ]%s 网络看起来稳定 — 可以安全启动 fetch\n' "${C_GREEN}" "${C_RESET}"
  exit 0
elif [[ ${git_ok} -ge 1 ]]; then
  printf '%s[WARN]%s 网络间歇 — 慎重启动 fetch，期间可能多次重试\n' "${C_YELLOW}" "${C_RESET}"
  exit 2
else
  printf '%s[FAIL]%s 网络不通 — 不要启动 fetch，先修 VPN\n' "${C_RED}" "${C_RESET}"
  exit 1
fi
