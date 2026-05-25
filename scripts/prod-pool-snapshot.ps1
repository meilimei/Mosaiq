# prod-pool-snapshot.ps1 -- fetch + parse Phase 11.3a pool metrics from prod
#
# Pulls `/v1/metrics` from mosaiq-cloud-runtime.fly.dev (or another host),
# parses out the 5 pool counters + the `mm_acquire_duration_seconds` histogram,
# prints a human-readable summary, and writes a timestamped JSON snapshot to
# `tmp/pool-snapshots/`.
#
# Designed as the MVP observability path for the Phase 11.3a phased rollout
# (see docs/PHASE-11.3-MACHINE-POOL.md). Run it before/after each rollout
# step to compute deltas; no full Prometheus / Grafana stack required.
#
# # Usage
#
#   $env:METRICS_TOKEN = "<token from flyctl secrets>"
#   powershell -File scripts/prod-pool-snapshot.ps1
#   powershell -File scripts/prod-pool-snapshot.ps1 -Label "before-pool-1"
#   powershell -File scripts/prod-pool-snapshot.ps1 -Host "staging.fly.dev"
#
# # Decision criteria (recap)
#
#   - Hit rate >= 80%  -> bump POOL_TARGET_SIZE up
#   - Hit rate <  50%  -> investigate (pool churn? Fly API failures?)
#   - provisions{failed} > 5% -> Fly Machines API health issue, file ticket
#   - mm_acquire P50 dropped >= 15s  -> pool is delivering on its promise
#
# # NOTE on PowerShell
#
# ASCII-only on purpose (same reason as preflight-fly.ps1: PS 5.1 mis-decodes
# UTF-8 without BOM on Chinese Windows codepages). Keep edits pure ASCII.

param(
  [string] $TargetHost = 'mosaiq-cloud-runtime.fly.dev',
  [string] $Label      = '',
  [string] $Token      = $env:METRICS_TOKEN,
  [switch] $NoSave     # diagnostic: print only, do not write JSON
)

$ErrorActionPreference = 'Stop'

# ---- preflight -------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Host '[ERR] METRICS_TOKEN not set. Either:' -ForegroundColor Red
  Write-Host '       $env:METRICS_TOKEN = "..."'
  Write-Host '       or pass -Token <value>'
  Write-Host ''
  Write-Host '     Retrieve from prod:'
  Write-Host '       flyctl secrets list --app mosaiq-cloud-runtime'
  Write-Host '     (token value is not viewable; if lost, rotate via `flyctl secrets set`)'
  exit 2
}

$baseUrl = "https://$TargetHost"
$url     = "$baseUrl/v1/metrics"

Write-Host "[snapshot] scraping $url" -ForegroundColor Cyan

# ---- fetch -----------------------------------------------------------------
try {
  $resp = Invoke-WebRequest -Uri $url `
    -Headers @{ Authorization = "Bearer $Token" } `
    -UseBasicParsing `
    -TimeoutSec 30
} catch {
  Write-Host "[ERR] fetch failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

if ($resp.StatusCode -ne 200) {
  Write-Host "[ERR] HTTP $($resp.StatusCode) (expected 200)" -ForegroundColor Red
  Write-Host $resp.Content
  exit 1
}

$body = $resp.Content
$ts   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ssZ")

# ---- parse -----------------------------------------------------------------
# Prometheus exposition format: ignore lines starting with `#`, each metric
# line is `<name>{labels} <value>` or `<name> <value>`. Build a hashmap keyed
# by the canonical metric_label_string, value = float.

function Parse-Metric {
  param(
    [string]   $Body,
    [string]   $Name,
    [string[]] $Labels    # ordered label names, optional
  )
  $values = @{}
  foreach ($line in $Body -split "`n") {
    $line = $line.Trim()
    if ($line.StartsWith('#') -or $line -eq '') { continue }
    if (-not $line.StartsWith($Name)) { continue }

    # parse `<name>{k="v",...} <value>` OR `<name> <value>`
    if ($line -match "^$([regex]::Escape($Name))(\{([^}]*)\})?\s+([0-9eE.+\-]+)$") {
      $rawLabels = $matches[2]
      $rawValue  = [double]$matches[3]
      $key = if ($rawLabels) { $rawLabels } else { '<no-labels>' }
      $values[$key] = $rawValue
    }
  }
  return $values
}

# 5 pool metrics + the histogram we care about
$hits        = Parse-Metric -Body $body -Name 'machine_pool_hits_total'
$misses      = Parse-Metric -Body $body -Name 'machine_pool_misses_total'
$provisions  = Parse-Metric -Body $body -Name 'machine_pool_provisions_total'
$evictions   = Parse-Metric -Body $body -Name 'machine_pool_evictions_total'
$entries     = Parse-Metric -Body $body -Name 'machine_pool_entries'

# histogram: mm_acquire_duration_seconds_sum / _count for mean,
# _bucket{le="X"} for percentile (we'll just print sum/count + buckets)
$acquireSum   = Parse-Metric -Body $body -Name 'mm_acquire_duration_seconds_sum'
$acquireCount = Parse-Metric -Body $body -Name 'mm_acquire_duration_seconds_count'
$acquireBkt   = Parse-Metric -Body $body -Name 'mm_acquire_duration_seconds_bucket'

# Aggregate hits/misses for hit-rate calc
$totalHits   = ($hits.Values   | Measure-Object -Sum).Sum
$totalMisses = ($misses.Values | Measure-Object -Sum).Sum
$consumeAttempts = $totalHits + $totalMisses
$hitRate = if ($consumeAttempts -gt 0) { [Math]::Round(($totalHits / $consumeAttempts) * 100, 1) } else { $null }

# Aggregate provisions
$provSuccess = if ($provisions['outcome="success"']) { $provisions['outcome="success"'] } else { 0 }
$provFailed  = if ($provisions['outcome="failed"'])  { $provisions['outcome="failed"']  } else { 0 }
$provTotal   = $provSuccess + $provFailed
$provFailRate = if ($provTotal -gt 0) { [Math]::Round(($provFailed / $provTotal) * 100, 1) } else { $null }

# Mean acquire time
$acqSumVal   = ($acquireSum.Values   | Measure-Object -Sum).Sum
$acqCountVal = ($acquireCount.Values | Measure-Object -Sum).Sum
$meanAcquire = if ($acqCountVal -gt 0) { [Math]::Round($acqSumVal / $acqCountVal, 2) } else { $null }

# ---- print summary ---------------------------------------------------------
Write-Host ''
Write-Host "=== Phase 11.3a pool snapshot @ $ts ===" -ForegroundColor Yellow
Write-Host "host:    $TargetHost"
Write-Host "label:   $Label"
Write-Host ''

Write-Host '--- pool entries (gauge, current) ---' -ForegroundColor Cyan
if ($entries.Count -eq 0) {
  Write-Host '  (no machine_pool_entries series -- pool likely disabled or not bootstrapped)'
} else {
  foreach ($k in $entries.Keys | Sort-Object) {
    Write-Host ("  {0,-40} {1}" -f $k, $entries[$k])
  }
}

Write-Host ''
Write-Host '--- consume counters (cumulative) ---' -ForegroundColor Cyan
Write-Host ("  hits_total                              {0}" -f $totalHits)
foreach ($k in $misses.Keys | Sort-Object) {
  Write-Host ("  misses_total{0,-30}    {1}" -f $k, $misses[$k])
}
if ($null -ne $hitRate) {
  Write-Host ("  >>> hit rate                            {0}%  (target: >=80%)" -f $hitRate) -ForegroundColor Green
} else {
  Write-Host '  >>> hit rate                            n/a (no consume attempts yet)' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '--- provisions (cumulative) ---' -ForegroundColor Cyan
Write-Host ("  provisions_total{{success}}              {0}" -f $provSuccess)
Write-Host ("  provisions_total{{failed}}               {0}" -f $provFailed)
if ($null -ne $provFailRate) {
  $color = if ($provFailRate -gt 5) { 'Red' } else { 'Green' }
  Write-Host ("  >>> provision failure rate              {0}%  (target: <5%)" -f $provFailRate) -ForegroundColor $color
}

Write-Host ''
Write-Host '--- evictions (cumulative, by reason) ---' -ForegroundColor Cyan
if ($evictions.Count -eq 0) {
  Write-Host '  (none yet)'
} else {
  foreach ($k in $evictions.Keys | Sort-Object) {
    Write-Host ("  {0,-40} {1}" -f $k, $evictions[$k])
  }
}

Write-Host ''
Write-Host '--- acquire latency (mm_acquire_duration_seconds) ---' -ForegroundColor Cyan
Write-Host ("  total acquires sampled                  {0}" -f $acqCountVal)
if ($null -ne $meanAcquire) {
  Write-Host ("  mean acquire duration                   {0}s" -f $meanAcquire)
}

# Bucket-based P50/P95 estimate (linear approximation across the nearest bucket)
if ($acquireBkt.Count -gt 0 -and $acqCountVal -gt 0) {
  $buckets = @()
  foreach ($k in $acquireBkt.Keys) {
    if ($k -match 'le="([^"]+)"') {
      $le  = $matches[1]
      $val = $acquireBkt[$k]
      if ($le -ne '+Inf') {
        $buckets += [pscustomobject]@{ le = [double]$le; cumCount = $val }
      } else {
        $buckets += [pscustomobject]@{ le = [double]::PositiveInfinity; cumCount = $val }
      }
    }
  }
  $buckets = $buckets | Sort-Object le
  function Find-Percentile {
    param([array]$Buckets, [double]$Count, [double]$Pct)
    $target = $Count * $Pct
    foreach ($b in $Buckets) {
      if ($b.cumCount -ge $target) { return $b.le }
    }
    return [double]::PositiveInfinity
  }
  $p50 = Find-Percentile -Buckets $buckets -Count $acqCountVal -Pct 0.50
  $p95 = Find-Percentile -Buckets $buckets -Count $acqCountVal -Pct 0.95
  Write-Host ("  P50 (bucket upper bound)                {0}s" -f $p50)
  Write-Host ("  P95 (bucket upper bound)                {0}s" -f $p95)
  Write-Host ''
  Write-Host '  decision hint:' -ForegroundColor DarkGray
  Write-Host '    prod 实测 baseline (pool=0) mean ~62s, pool=1 warm mean ~35s.'
  Write-Host '    红线: mean acquire > 60s + hit_rate < 50% + prov_fail > 20% → 回滚 POOL_TARGET_SIZE=0'
}

# ---- save snapshot ---------------------------------------------------------
if (-not $NoSave) {
  # PS 5.1 `Join-Path` only takes 2 args. Use [System.IO.Path]::Combine for
  # portable multi-segment joining (works on PS 5.1 + PS 7+).
  $snapshotDir = [System.IO.Path]::Combine($PSScriptRoot, '..', 'tmp', 'pool-snapshots')
  if (-not (Test-Path $snapshotDir)) {
    New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null
  }
  $labelSlug = if ($Label) { '-' + ($Label -replace '[^a-zA-Z0-9_-]', '_') } else { '' }
  $snapshotFile = [System.IO.Path]::Combine($snapshotDir, "snapshot-$ts$labelSlug.json")

  $payload = [ordered]@{
    timestamp = $ts
    host      = $TargetHost
    label     = $Label
    summary   = [ordered]@{
      total_hits          = $totalHits
      total_misses        = $totalMisses
      hit_rate_pct        = $hitRate
      prov_success        = $provSuccess
      prov_failed         = $provFailed
      prov_fail_rate_pct  = $provFailRate
      mean_acquire_sec    = $meanAcquire
      total_acquires      = $acqCountVal
    }
    hits        = $hits
    misses      = $misses
    provisions  = $provisions
    evictions   = $evictions
    entries     = $entries
    acquire_bkt = $acquireBkt
  }

  $payload | ConvertTo-Json -Depth 6 | Set-Content -Path $snapshotFile -Encoding UTF8
  Write-Host ''
  Write-Host "[snapshot] saved $snapshotFile" -ForegroundColor Green
}

Write-Host ''
Write-Host '=== end snapshot ===' -ForegroundColor Yellow
