#!/usr/bin/env bash
# Mosaiq Chromium Fork — 强制 IPv4 优先（绕过 VPN IPv6 路由问题）
#
# 场景：某些 VPN 把 IPv4 通过 hijack DNS 重定向，但 IPv6 不被代理 →
#       chromium.googlesource.com 解析返回真实 IPv6 → curl 走 v6 超时。
#       但 git 默认偏好 v4 → git ls-remote OK，curl 失败。
#       gclient sync 内部用 curl 拉 CIPD 包 → 失败。
#
# 修复：通过 /etc/gai.conf 设 IPv4-mapped 优先级 100（默认 v6 优先级 ≈ 50），
#       让 getaddrinfo() 偏好 IPv4。
#
# 用法：
#   wsl -d Ubuntu -- bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/fix-ipv4-pref.sh

set -euo pipefail

readonly C_GREEN=$'\033[0;32m'
readonly C_RED=$'\033[0;31m'
readonly C_BLUE=$'\033[0;34m'
readonly C_RESET=$'\033[0m'

readonly GAI_CONF="/etc/gai.conf"
readonly MAGIC_LINE="precedence ::ffff:0:0/96 100"

printf '%s[INFO]%s 当前 %s 自定义行：\n' "${C_BLUE}" "${C_RESET}" "${GAI_CONF}"
grep -v '^#' "${GAI_CONF}" 2>/dev/null | grep -v '^$' | sed 's/^/  /' || echo "  (空)"

if grep -qF "${MAGIC_LINE}" "${GAI_CONF}" 2>/dev/null; then
  printf '%s[ OK ]%s IPv4 优先已设置\n' "${C_GREEN}" "${C_RESET}"
else
  printf '%s[INFO]%s 写入 IPv4 优先规则...\n' "${C_BLUE}" "${C_RESET}"
  echo "${MAGIC_LINE}" | sudo tee -a "${GAI_CONF}" > /dev/null
  printf '%s[ OK ]%s 已添加：%s\n' "${C_GREEN}" "${C_RESET}" "${MAGIC_LINE}"
fi

echo
printf '%s[INFO]%s 验证 curl 走 IPv4：\n' "${C_BLUE}" "${C_RESET}"
out=$(curl -sS --max-time 15 -w 'code=%{http_code} ip=%{remote_ip} time=%{time_total}s\n' \
        -o /dev/null https://chromium.googlesource.com/ 2>&1) || true
echo "  ${out}"

if echo "${out}" | grep -qE 'code=200|code=302'; then
  printf '%s[ OK ]%s curl 通了，可以启动 sync-resume.sh\n' "${C_GREEN}" "${C_RESET}"
  exit 0
elif echo "${out}" | grep -qE 'ip=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'; then
  printf '%s[WARN]%s 已走 IPv4 但 HTTP 异常 — 看上面错误码\n' "${C_BLUE}" "${C_RESET}"
  exit 2
else
  printf '%s[FAIL]%s curl 还是不通，可能 VPN 完全断了\n' "${C_RED}" "${C_RESET}"
  exit 1
fi
