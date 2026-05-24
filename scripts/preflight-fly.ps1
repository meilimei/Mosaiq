# preflight-fly.ps1 — pre-deploy smoke for cloud-runtime → Fly.io
#
# 跑这个脚本在本地把 `apps/cloud-runtime/Dockerfile` 端到端走一遍：
#   1. docker build cloud-runtime image
#   2. docker run（绑随机端口）+ 注入跟 prod fly env 等价的 env vars
#   3. curl /v1/health 看 200 + db.ok=true
#   4. curl /v1/metrics 用 METRICS_TOKEN 看 200 + 有几个 known metrics
#   5. POST /v1/sessions 用 SEED_API_KEY 试创建（用 static MachineManager，
#      不真打 fly machines API；这层只验路由 + auth + rate limit 配置都对）
#   6. 干净 stop 容器 + 输出 prod checklist
#
# 不会真的 `flyctl deploy`，那是显式手工动作（破坏性，需要 ops 在线）。
#
# Exit 0 = 全绿可以 deploy；non-zero = 有问题，看 stderr 修。
#
# 用法：
#   pwsh scripts/preflight-fly.ps1
#   pwsh scripts/preflight-fly.ps1 -Port 18787       # 自定 host port
#   pwsh scripts/preflight-fly.ps1 -SkipBuild        # 复用上次 build 的镜像

param(
  [int]    $Port = 18787,
  [string] $ImageTag = 'mosaiq/cloud-runtime:preflight',
  [string] $ContainerName = 'mosaiq-cloud-runtime-preflight',
  [switch] $SkipBuild,
  [switch] $KeepRunning      # debug 用：跑完不关容器
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repoRoot

function Fail($msg) {
  Write-Host ""
  Write-Host "[preflight] FAIL: $msg" -ForegroundColor Red
  Cleanup
  Pop-Location
  exit 1
}

function Cleanup {
  if ($KeepRunning) {
    Write-Host "[preflight] -KeepRunning: leaving container $ContainerName up (port $Port)" -ForegroundColor Yellow
    return
  }
  docker rm -f $ContainerName 2>&1 | Out-Null
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: docker build
# ──────────────────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  Write-Host "[preflight] step 1/5 — docker build $ImageTag" -ForegroundColor Cyan
  docker build -f apps/cloud-runtime/Dockerfile -t $ImageTag . 2>&1 | Tee-Object -Variable buildLog | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $buildLog | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
    Fail "docker build exited $LASTEXITCODE"
  }
  Write-Host "[preflight] build OK." -ForegroundColor Green
} else {
  Write-Host "[preflight] step 1/5 — skipped (-SkipBuild)" -ForegroundColor Yellow
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: docker run with prod-equivalent env (但用 static mm，不打 fly API)
# ──────────────────────────────────────────────────────────────────────────────
$seedKey = 'msq_sk_preflight_' + ([guid]::NewGuid().ToString('N').Substring(0, 24))
$metricsToken = 'preflight-metrics-' + ([guid]::NewGuid().ToString('N').Substring(0, 16))

Write-Host "[preflight] step 2/5 — docker run (port $Port, image $ImageTag)" -ForegroundColor Cyan
docker rm -f $ContainerName 2>&1 | Out-Null
$containerId = docker run -d `
  --name $ContainerName `
  -p "${Port}:8787" `
  -e NODE_ENV=development `
  -e PORT=8787 `
  -e LOG_LEVEL=info `
  -e DATABASE_URL='sqlite:/data/cloud-runtime.db' `
  -e MACHINE_MANAGER=static `
  -e POD_ADDRS=http://nonexistent-pod:9222 `
  -e SEED_PROJECT_ID=proj_preflight `
  -e SEED_API_KEY=$seedKey `
  -e METRICS_TOKEN=$metricsToken `
  -e PUBLIC_BASE_URL="http://localhost:${Port}" `
  -e RATE_LIMIT_STRICT_CAPACITY=10 `
  -e RATE_LIMIT_STRICT_REFILL_PER_SEC=1 `
  $ImageTag

if ($LASTEXITCODE -ne 0 -or -not $containerId) {
  Fail "docker run failed"
}

# 等容器 ready，最多 30 秒
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:${Port}/v1/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
}
if (-not $ready) {
  Write-Host "[preflight] container logs:" -ForegroundColor Yellow
  docker logs $ContainerName 2>&1 | Select-Object -Last 40 | ForEach-Object { Write-Host $_ }
  Fail "container didn't become healthy in 30s"
}
Write-Host "[preflight] container ready." -ForegroundColor Green

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: /v1/health
# ──────────────────────────────────────────────────────────────────────────────
Write-Host "[preflight] step 3/5 — GET /v1/health" -ForegroundColor Cyan
$health = (Invoke-WebRequest -Uri "http://localhost:${Port}/v1/health" -UseBasicParsing).Content | ConvertFrom-Json
if (-not $health.ok)         { Fail "/v1/health ok=false: $($health | ConvertTo-Json -Compress)" }
if (-not $health.db.ok)      { Fail "/v1/health db.ok=false" }
Write-Host "  health.ok=$($health.ok) db.ok=$($health.db.ok) pool=$($health.pool | ConvertTo-Json -Compress)" -ForegroundColor Green

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: /v1/metrics (bearer auth)
# ──────────────────────────────────────────────────────────────────────────────
Write-Host "[preflight] step 4/5 — GET /v1/metrics" -ForegroundColor Cyan
# 4a: 缺 token → 401
try {
  $r = Invoke-WebRequest -Uri "http://localhost:${Port}/v1/metrics" -UseBasicParsing -ErrorAction Stop
  Fail "expected 401 without token, got $($r.StatusCode)"
} catch [System.Net.WebException] {
  if ($_.Exception.Response.StatusCode -ne 401) {
    Fail "expected 401, got $($_.Exception.Response.StatusCode)"
  }
}
# 4b: 正确 token → 200 + 文本含 sessions_created_total
$resp = Invoke-WebRequest -Uri "http://localhost:${Port}/v1/metrics" `
  -Headers @{ Authorization = "Bearer $metricsToken" } -UseBasicParsing
if ($resp.StatusCode -ne 200) { Fail "metrics expected 200, got $($resp.StatusCode)" }
if ($resp.Content -notmatch 'sessions_created_total') { Fail "metrics body missing sessions_created_total" }
if ($resp.Content -notmatch 'http_request_duration_seconds') { Fail "metrics body missing http_request_duration_seconds" }
Write-Host "  /v1/metrics 401 (no token) ✓  200 + known counters (with token) ✓" -ForegroundColor Green

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: createSession (static mm; 不打 fly API)
# ──────────────────────────────────────────────────────────────────────────────
# Note: 这里期望 createSession 走 static mm 成功（POD_ADDRS 写了一个不存在的
# pod，所以会在 healthcheck 阶段失败 —— 但 ApiError 路径仍能验证 rate limit /
# auth / DB 配置是对的）。我们只断言 "不是 500 / 不是 401 / 不是 429"。
Write-Host "[preflight] step 5/5 — POST /v1/sessions (auth + rate-limit smoke)" -ForegroundColor Cyan
$body = @{
  project_id = 'proj_preflight'
  persona = @{ inline = @{
    id = 'preflight-persona'
    user_agent = 'Mozilla/5.0 preflight'
    os = @{ name = 'Windows'; version = '11' }
    browser = @{ name = 'Chrome'; major = 120 }
    viewport = @{ width = 1920; height = 1080 }
    screen = @{ width = 1920; height = 1080; dpr = 1 }
    locale = 'en-US'
    timezone = 'America/New_York'
    languages = @('en-US')
  }}
} | ConvertTo-Json -Depth 6 -Compress
try {
  $r = Invoke-WebRequest -Uri "http://localhost:${Port}/v1/sessions" -Method POST `
    -Headers @{ Authorization = "Bearer $seedKey"; 'Content-Type' = 'application/json' } `
    -Body $body -UseBasicParsing -ErrorAction Stop
  # 期望 201 或 503/422（pod 不可达）；不期望 401/429/500
  if ($r.StatusCode -ne 201) {
    Fail "unexpected createSession status $($r.StatusCode)"
  }
  Write-Host "  POST /v1/sessions → 201 ✓" -ForegroundColor Green
} catch [System.Net.WebException] {
  $sc = [int]$_.Exception.Response.StatusCode
  if ($sc -eq 401 -or $sc -eq 403) { Fail "createSession unexpectedly auth-rejected ($sc)" }
  if ($sc -eq 429) { Fail "createSession unexpectedly rate-limited ($sc) — check RATE_LIMIT_STRICT_CAPACITY" }
  if ($sc -eq 500) { Fail "createSession 500 — check container logs" }
  # 503/422 OK：pod 不可达 / persona schema 拒
  Write-Host "  POST /v1/sessions → $sc (expected; static pod unreachable, but routing/auth/rate-limit verified)" -ForegroundColor Green
}

# ──────────────────────────────────────────────────────────────────────────────
# 收尾
# ──────────────────────────────────────────────────────────────────────────────
Cleanup
Pop-Location

Write-Host ""
Write-Host "[preflight] all checks passed." -ForegroundColor Green
Write-Host ""
Write-Host "──── Deploy checklist ──────────────────────────────────────────────────" -ForegroundColor Cyan
Write-Host "  1. Confirm flyctl auth: flyctl auth whoami  (should be ifly@163.com)"
Write-Host "  2. Confirm secrets set: flyctl secrets list -a mosaiq-cloud-runtime"
Write-Host "       FLY_API_TOKEN, FLY_APP_NAME, METRICS_TOKEN  (no SEED_API_KEY in prod!)"
Write-Host "  3. Confirm volume:      flyctl volumes list -a mosaiq-cloud-runtime"
Write-Host "       cloud_runtime_data in iad, ≥1GB"
Write-Host "  4. Deploy:              flyctl deploy --config fly.cloud-runtime.toml \"
Write-Host "                                       --dockerfile apps/cloud-runtime/Dockerfile"
Write-Host "  5. Post-deploy smoke:   curl https://mosaiq-cloud-runtime.fly.dev/v1/health"
Write-Host "                          curl -H 'Authorization: Bearer \$METRICS_TOKEN' \"
Write-Host "                               https://mosaiq-cloud-runtime.fly.dev/v1/metrics | head"
Write-Host "  6. Bootstrap prod API key (per docs/PHASE-11.2-FLY-DEPLOY.md §6)"
Write-Host "─────────────────────────────────────────────────────────────────────"
