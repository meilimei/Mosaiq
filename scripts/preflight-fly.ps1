# preflight-fly.ps1 -- pre-deploy smoke for cloud-runtime -> Fly.io
#
# Runs the apps/cloud-runtime/Dockerfile end-to-end on the local Docker daemon
# so deploy-day footguns (bad Dockerfile, missing dep, typo in env wiring,
# broken metrics endpoint) surface in ~30s on the dev box instead of waiting
# ~5 min for a remote `flyctl deploy` to fail.
#
# Steps:
#   1. docker build cloud-runtime image
#   2. docker run with prod-equivalent env (NODE_ENV=development so seed.ts
#      can plant a dev API key; everything else mirrors fly.cloud-runtime.toml)
#   3. GET /v1/health  -- expects 200 + db.ok=true
#   4. GET /v1/metrics -- expects 401 without token, 200 with the right
#      METRICS_TOKEN bearer + body contains known counter names
#   5. POST /v1/sessions -- expects 201, or a well-typed 4xx/5xx (NOT 401,
#      429 or 500, which would indicate auth or rate-limit misconfig)
#   6. Stop container cleanly + print Fly deploy checklist
#
# This script never invokes `flyctl deploy` itself. That is an explicit
# manual step (it mutates prod state and ops must be on-line for it).
#
# Exit 0 = all green, safe to deploy. Non-zero = something broke, read stderr.
#
# NOTE on PowerShell: this script is ASCII-only on purpose. Windows PowerShell
# 5.1 reads .ps1 files using the system OEM codepage (e.g. CP936 on Chinese
# Windows) unless the file has a UTF-8 BOM, and mis-decodes multi-byte chars
# as garbage that breaks the parser. Keep this file pure ASCII when editing.
#
# Usage:
#   powershell -File scripts/preflight-fly.ps1
#   pwsh       scripts/preflight-fly.ps1                # PowerShell 7+
#   powershell -File scripts/preflight-fly.ps1 -Port 18787
#   powershell -File scripts/preflight-fly.ps1 -SkipBuild

param(
  [int]    $Port = 18787,
  [string] $ImageTag = 'mosaiq/cloud-runtime:preflight',
  [string] $ContainerName = 'mosaiq-cloud-runtime-preflight',
  [switch] $SkipBuild,
  [switch] $KeepRunning      # debug: leave container up after success
)

# NOTE: deliberately *not* setting $ErrorActionPreference='Stop' globally.
# Windows PowerShell 5.1 treats any line a native command writes to stderr
# as a terminating "NativeCommandError" under Stop, and `docker build`
# writes BuildKit progress (#0 building with ...) to stderr by design.
# Cmdlets that genuinely need Stop semantics (Invoke-WebRequest) carry an
# explicit -ErrorAction Stop. Native-command success/failure is checked via
# $LASTEXITCODE after each call.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repoRoot

# Docker Desktop on Windows installs to "C:\Program Files\Docker\Docker\
# resources\bin\docker.exe" but does not always add it to PATH for non-
# interactive child shells. Detect + prepend if necessary.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  $dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
  if (Test-Path (Join-Path $dockerBin 'docker.exe')) {
    $env:PATH = "$dockerBin;$env:PATH"
  } else {
    Write-Host "[preflight] FAIL: docker not on PATH and not at default install path" -ForegroundColor Red
    Pop-Location
    exit 1
  }
}

function Cleanup {
  if ($KeepRunning) {
    Write-Host "[preflight] -KeepRunning: leaving container $ContainerName up (port $Port)" -ForegroundColor Yellow
    return
  }
  docker rm -f $ContainerName 2>&1 | Out-Null
}

function Fail($msg) {
  Write-Host ""
  Write-Host "[preflight] FAIL: $msg" -ForegroundColor Red
  Cleanup
  Pop-Location
  exit 1
}

# ----------------------------------------------------------------------------
# Step 1: docker build
# ----------------------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Host "[preflight] step 1/5 -- docker build $ImageTag" -ForegroundColor Cyan
  docker build -f apps/cloud-runtime/Dockerfile -t $ImageTag . 2>&1 | Tee-Object -Variable buildLog | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $buildLog | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
    Fail "docker build exited $LASTEXITCODE"
  }
  Write-Host "[preflight] build OK." -ForegroundColor Green
} else {
  Write-Host "[preflight] step 1/5 -- skipped (-SkipBuild)" -ForegroundColor Yellow
}

# ----------------------------------------------------------------------------
# Step 2: docker run with prod-equivalent env (but static MM, not real Fly API)
# ----------------------------------------------------------------------------
$seedKey = 'msq_sk_preflight_' + ([guid]::NewGuid().ToString('N').Substring(0, 24))
$metricsToken = 'preflight-metrics-' + ([guid]::NewGuid().ToString('N').Substring(0, 16))

Write-Host "[preflight] step 2/5 -- docker run (port $Port, image $ImageTag)" -ForegroundColor Cyan
docker rm -f $ContainerName 2>&1 | Out-Null

# Use an args array (no backtick line-continuation) -- robust against trailing
# whitespace that silently breaks PS 5.1 parsing.
$dockerArgs = @(
  'run', '-d',
  '--name', $ContainerName,
  '-p', "${Port}:8787",
  '-e', 'NODE_ENV=development',
  '-e', 'PORT=8787',
  '-e', 'LOG_LEVEL=info',
  '-e', 'DATABASE_URL=sqlite:/app/data/cloud-runtime.db',
  '-e', 'MACHINE_MANAGER=static',
  '-e', 'POD_ADDRS=http://nonexistent-pod:9222',
  '-e', 'SEED_PROJECT_ID=proj_preflight',
  '-e', "SEED_API_KEY=$seedKey",
  '-e', "METRICS_TOKEN=$metricsToken",
  '-e', "PUBLIC_BASE_URL=http://localhost:${Port}",
  '-e', 'RATE_LIMIT_STRICT_CAPACITY=10',
  '-e', 'RATE_LIMIT_STRICT_REFILL_PER_SEC=1',
  $ImageTag
)
$containerId = & docker @dockerArgs

if ($LASTEXITCODE -ne 0 -or -not $containerId) {
  Fail "docker run failed"
}

# Wait for /v1/health to return 200, up to 30s.
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
  Fail "container did not become healthy in 30s"
}
Write-Host "[preflight] container ready." -ForegroundColor Green

# ----------------------------------------------------------------------------
# Step 3: /v1/health
# ----------------------------------------------------------------------------
Write-Host "[preflight] step 3/5 -- GET /v1/health" -ForegroundColor Cyan
$health = (Invoke-WebRequest -Uri "http://localhost:${Port}/v1/health" -UseBasicParsing).Content | ConvertFrom-Json
if (-not $health.ok)    { Fail "/v1/health ok=false: $($health | ConvertTo-Json -Compress)" }
if (-not $health.db.ok) { Fail "/v1/health db.ok=false" }
Write-Host ("  health.ok={0} db.ok={1} pool={2}" -f $health.ok, $health.db.ok, ($health.pool | ConvertTo-Json -Compress)) -ForegroundColor Green

# ----------------------------------------------------------------------------
# Step 4: /v1/metrics (bearer auth)
# ----------------------------------------------------------------------------
Write-Host "[preflight] step 4/5 -- GET /v1/metrics" -ForegroundColor Cyan
# 4a: missing token -> 401
try {
  $r = Invoke-WebRequest -Uri "http://localhost:${Port}/v1/metrics" -UseBasicParsing -ErrorAction Stop
  Fail "expected 401 without token, got $($r.StatusCode)"
} catch [System.Net.WebException] {
  $sc = [int]$_.Exception.Response.StatusCode
  if ($sc -ne 401) {
    Fail "expected 401, got $sc"
  }
}
# 4b: valid token -> 200 + body contains known counters
$metricsReq = @{
  Uri             = "http://localhost:${Port}/v1/metrics"
  Headers         = @{ Authorization = "Bearer $metricsToken" }
  UseBasicParsing = $true
}
$resp = Invoke-WebRequest @metricsReq
if ($resp.StatusCode -ne 200) { Fail "metrics expected 200, got $($resp.StatusCode)" }
if ($resp.Content -notmatch 'sessions_created_total')       { Fail "metrics body missing sessions_created_total" }
if ($resp.Content -notmatch 'http_request_duration_seconds') { Fail "metrics body missing http_request_duration_seconds" }
Write-Host "  /v1/metrics 401 (no token) OK; 200 + known counters (with token) OK" -ForegroundColor Green

# ----------------------------------------------------------------------------
# Step 5: createSession (static mm; does not call fly API)
# ----------------------------------------------------------------------------
# POD_ADDRS points at a non-existent pod, so createSession will fail at the
# pod /control/start phase. That is intentional -- we only need to verify
# routing, auth, rate-limit and DB are wired correctly. The accept set is
# {201, 422, 503}; the reject set is {401, 403, 429, 500}.
Write-Host "[preflight] step 5/5 -- POST /v1/sessions (auth + rate-limit smoke)" -ForegroundColor Cyan
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

$sessReq = @{
  Uri             = "http://localhost:${Port}/v1/sessions"
  Method          = 'POST'
  Headers         = @{ Authorization = "Bearer $seedKey"; 'Content-Type' = 'application/json' }
  Body            = $body
  UseBasicParsing = $true
  ErrorAction     = 'Stop'
}
try {
  $r = Invoke-WebRequest @sessReq
  if ($r.StatusCode -ne 201) {
    Fail "unexpected createSession status $($r.StatusCode)"
  }
  Write-Host "  POST /v1/sessions -> 201 OK" -ForegroundColor Green
} catch [System.Net.WebException] {
  $sc = [int]$_.Exception.Response.StatusCode
  if ($sc -eq 401 -or $sc -eq 403) { Fail "createSession unexpectedly auth-rejected ($sc)" }
  if ($sc -eq 429) { Fail "createSession unexpectedly rate-limited ($sc) -- check RATE_LIMIT_STRICT_CAPACITY" }
  if ($sc -eq 500) { Fail "createSession 500 -- check container logs" }
  # 422 / 503 are acceptable: persona schema rejection or pod unreachable.
  Write-Host "  POST /v1/sessions -> $sc (expected; static pod unreachable, but routing/auth/rate-limit verified)" -ForegroundColor Green
}

# ----------------------------------------------------------------------------
# Cleanup + checklist
# ----------------------------------------------------------------------------
Cleanup
Pop-Location

Write-Host ""
Write-Host "[preflight] all checks passed." -ForegroundColor Green
Write-Host ""
Write-Host "==== Deploy checklist ======================================================" -ForegroundColor Cyan
Write-Host "  1. Confirm flyctl auth:  flyctl auth whoami    (expected: ifly@163.com)"
Write-Host "  2. Confirm secrets set:  flyctl secrets list -a mosaiq-cloud-runtime"
Write-Host "       FLY_API_TOKEN, FLY_APP_NAME, METRICS_TOKEN  (NO SEED_API_KEY in prod!)"
Write-Host "  3. Confirm volume:       flyctl volumes list -a mosaiq-cloud-runtime"
Write-Host "       cloud_runtime_data in iad, >= 1GB"
Write-Host "  4. Deploy:               flyctl deploy --config fly.cloud-runtime.toml \"
Write-Host "                                         --dockerfile apps/cloud-runtime/Dockerfile"
Write-Host "  5. Post-deploy smoke:    curl https://mosaiq-cloud-runtime.fly.dev/v1/health"
Write-Host "                           curl -H 'Authorization: Bearer `$METRICS_TOKEN' \"
Write-Host "                                https://mosaiq-cloud-runtime.fly.dev/v1/metrics | head"
Write-Host "  6. Bootstrap prod API key (see docs/PHASE-11.2-FLY-DEPLOY.md sec 6)"
Write-Host "============================================================================" -ForegroundColor Cyan
