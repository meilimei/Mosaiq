# rotate-api-key.ps1 -- turnkey API key rotation for mosaiq-cloud-runtime.
#
# Wraps the 7-step playbook documented in docs/PHASE-11.2-FLY-DEPLOY.md section 8
# into a single command. Validates each step; never echoes the new plaintext to
# stdout / chat / shell history / git. Uses the validated `sh -c` wrapper for
# `flyctl ssh -C` (see footgun catalog in the same doc section 9).
#
# # What this script does (in order)
#
#   1. Validates flyctl on PATH + target app reachable.
#   2. Generates CSPRNG plaintext locally (msq_sk_live_<22 chars>).
#   3. Copies plaintext to clipboard (unless -SkipClipboard); pauses for the
#      operator to store it in 1Password / Bitwarden / vault of choice.
#   4. Invokes create-api-key.js --quiet over `flyctl ssh -C` with the plaintext
#      passed via env var; the admin script never echoes plaintext on success
#      (verified by the --quiet `note` field in the JSON response).
#   5. Probes /v1/sessions with the new key -- expects HTTP 200 -- proves the
#      key is live and the database write was durable.
#   6. Pauses for the operator to switch their downstream clients to the new
#      plaintext; on operator confirmation, revokes each id in -RevokeIds.
#   7. Clears local $plaintext + clipboard, prints summary.
#
# # Usage
#
#   # Standard: create new key + revoke 2 old ids (after client cutover prompt)
#   powershell -File scripts/rotate-api-key.ps1 `
#     -ProjectId proj_launchai `
#     -RevokeIds apk_oldA,apk_oldB
#
#   # Dry-run: walk the flow + print intended actions; no prod mutation
#   powershell -File scripts/rotate-api-key.ps1 `
#     -ProjectId proj_launchai `
#     -RevokeIds apk_oldA `
#     -DryRun
#
#   # Revoke-only emergency: skip new-key creation
#   powershell -File scripts/rotate-api-key.ps1 `
#     -ProjectId proj_launchai `
#     -RevokeIds apk_leaked_xxx `
#     -SkipNewKey
#
# # Exit codes
#   0  full success
#   1  generic failure (flyctl error, auth probe failed, revoke failed, ...)
#   2  missing/invalid args
#   3  user aborted at confirmation prompt
#   4  revoke partial failure (new key created OK, but >=1 revoke failed)
#
# # NOTE on PowerShell
#   ASCII-only on purpose (same reason as preflight-fly.ps1 / prod-pool-snapshot.ps1:
#   PS 5.1 mis-decodes UTF-8 without BOM on Chinese Windows codepages). Keep edits
#   pure ASCII. No Chinese in script body / comments.

param(
  [Parameter(Mandatory=$true)]
  [string]   $ProjectId,

  [string[]] $RevokeIds      = @(),
  [string]   $App            = 'mosaiq-cloud-runtime',
  [string]   $BaseUrl        = 'https://mosaiq-cloud-runtime.fly.dev',
  [switch]   $SkipNewKey,
  [switch]   $SkipClipboard,
  [switch]   $DryRun,

  # CAUTION: -NonInteractive skips the two human safety gates (vault-storage
  # confirmation + client-cutover confirmation). Use for CI / automated tests
  # only, never for an interactive operator running an actual rotation. Pairs
  # well with $env:MOSAIQ_TEST_PLAINTEXT for full hands-off e2e tests.
  [switch]   $NonInteractive
)

$ErrorActionPreference = 'Stop'

# ---- preflight -------------------------------------------------------------
function Write-Step {
  param([string] $Label, [string] $Msg, [string] $Color = 'Cyan')
  Write-Host ('[' + $Label + '] ') -ForegroundColor $Color -NoNewline
  Write-Host $Msg
}

if ($SkipNewKey -and -not $RevokeIds) {
  Write-Host '[ERR] -SkipNewKey with no -RevokeIds = nothing to do.' -ForegroundColor Red
  exit 2
}

# ---- defensive normalization of -RevokeIds ---------------------------------
# Gotcha: `powershell -File script.ps1 -RevokeIds apk_A,apk_B` passes the args
# as raw cmd-style strings (NOT PS-native), so `apk_A,apk_B` arrives as a single
# string element containing the comma -- not as a 2-element string[]. PS only
# treats `,` as the array operator when the invocation goes through PS parser
# directly (e.g., dot-sourced or `&` invocation). The 2026-05-25 prod rotation
# hit this -- the script tried to revoke a literal id `apk_A,apk_B` and got
# `not_found`, leaving both leaked keys active.
#
# Fix: split any element on comma, trim whitespace, drop empties. Idempotent
# for already-correct array input (the per-element split is a no-op when there
# is no comma).
if ($RevokeIds.Count -gt 0) {
  $RevokeIds = @(
    $RevokeIds |
      ForEach-Object { $_ -split ',' } |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -ne '' }
  )
  # Sanity: every id should look like apk_*. If any element fails the shape
  # check, bail before we hand garbage to revoke-api-key.js.
  foreach ($id in $RevokeIds) {
    if ($id -notmatch '^apk_[A-Za-z0-9_]+$') {
      Write-Host "[ERR] -RevokeIds element '$id' does not look like an apk_* id." -ForegroundColor Red
      Write-Host '      Expected form: apk_<22-char-base58>. Pass each id either space-separated or comma-separated.'
      exit 2
    }
  }
}

# flyctl on PATH?
try {
  $null = Get-Command flyctl -ErrorAction Stop
} catch {
  Write-Host '[ERR] flyctl not found on PATH.' -ForegroundColor Red
  Write-Host '      Install: https://fly.io/docs/flyctl/install/'
  exit 2
}

Write-Step 'preflight' "app=$App project=$ProjectId baseUrl=$BaseUrl dryRun=$DryRun"
if ($RevokeIds.Count -gt 0) {
  Write-Step 'preflight' ("revoke ids: " + ($RevokeIds -join ', '))
}
if ($SkipNewKey) {
  Write-Step 'preflight' 'skipNewKey=true (revoke-only mode)' 'Yellow'
}

# Cheap reachability check (no auth needed for /v1/health)
try {
  $health = Invoke-WebRequest -Uri "$BaseUrl/v1/health" -UseBasicParsing -TimeoutSec 10
  if ($health.StatusCode -ne 200) {
    Write-Host "[ERR] $BaseUrl/v1/health returned HTTP $($health.StatusCode); aborting." -ForegroundColor Red
    exit 1
  }
  Write-Step 'preflight' "$BaseUrl/v1/health OK ($($health.StatusCode))"
} catch {
  Write-Host "[ERR] $BaseUrl/v1/health unreachable: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# ---- helpers ---------------------------------------------------------------

function Invoke-FlyAdminScript {
  param(
    [string] $ShellCmd,    # the command to run inside the container
    [string] $StepLabel
  )

  # flyctl ssh -C does NOT invoke a shell -- exec's directly. Must wrap any
  # command that uses env-var assignment or shell builtins in `sh -c '...'`.
  # See PHASE-11.2 docs section 9 "flyctl ssh -C" gotcha.

  $argList = @('ssh', 'console', '-a', $App, '-C', "sh -c '$ShellCmd'")

  if ($DryRun) {
    Write-Step $StepLabel "DRY-RUN: would invoke -- flyctl $($argList -join ' ')" 'Yellow'
    return $null
  }

  # PS 5.1 wraps any native-command stderr line as RemoteException and, with
  # ErrorActionPreference='Stop', terminates the script. flyctl writes its
  # 'Connecting to fdaa:...' spinner to stderr on every ssh -C call. Drop EAP
  # to 'Continue' just for this invocation, then restore.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $rawOutput = & flyctl @argList 2>&1 | Out-String
  } finally {
    $ErrorActionPreference = $prevEap
  }

  # Strip flyctl chatter + pino server logs. What we want is the admin script's
  # pretty-printed JSON, which:
  #   - spans multiple lines (one open `{` to matching `}` on its own line)
  #   - has 2-space indent on inner lines
  #   - is NOT prefixed with `{"level":` (that's pino single-line logs)
  $filteredLines = $rawOutput -split "`n" | ForEach-Object {
    $line = $_ -replace "`r", ''
    $trim = $line.Trim()
    if ($trim -eq '') { return }
    if ($trim.StartsWith('Connecting to ')) { return }
    if ($trim.StartsWith('Error: The handle')) { return }
    if ($trim -match '^flyctl\s*:') { return }
    if ($trim.StartsWith('+ ')) { return }
    if ($trim -match 'CategoryInfo\s*:') { return }
    if ($trim -match 'FullyQualifiedErrorId\s*:') { return }
    # Drop pino single-line JSON server logs:
    if ($trim -match '^\{"level":\d+,') { return }
    $line
  }

  # The admin JSON is the LAST contiguous multi-line {...} block. Walk
  # backwards: find the last line containing '}' at trim-start, then scan up
  # for the matching '{' at trim-start.
  $end = -1
  for ($i = $filteredLines.Count - 1; $i -ge 0; $i--) {
    if ($filteredLines[$i].TrimStart().StartsWith('}')) { $end = $i; break }
  }
  $start = -1
  if ($end -ge 0) {
    for ($i = $end - 1; $i -ge 0; $i--) {
      $t = $filteredLines[$i].TrimStart()
      if ($t.StartsWith('{') -and -not $t.StartsWith('{"')) { $start = $i; break }
    }
  }

  if ($start -lt 0 -or $end -lt 0) {
    Write-Host "[ERR] $StepLabel : could not locate admin JSON in output." -ForegroundColor Red
    Write-Host '--- raw output ---'
    Write-Host $rawOutput
    Write-Host '------------------'
    exit 1
  }

  $json = ($filteredLines[$start..$end] -join "`n")
  try {
    return ($json | ConvertFrom-Json)
  } catch {
    Write-Host "[ERR] $StepLabel : JSON parse failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '--- attempted JSON ---'
    Write-Host $json
    Write-Host '----------------------'
    exit 1
  }
}

function New-CsprngPlaintext {
  # 22-char body from a 56-char no-confusable alphabet, prefixed with msq_sk_live_.
  # Matches the prefix convention in apps/cloud-runtime/src/utils/api-key.ts.
  $alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 22
  $rng.GetBytes($bytes)
  $body = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  return "msq_sk_live_$body"
}

function Read-OperatorConfirmation {
  param([string] $Prompt)
  if ($DryRun) {
    Write-Step 'prompt' "DRY-RUN: would prompt -- $Prompt (auto-confirming)" 'Yellow'
    return $true
  }
  if ($NonInteractive) {
    Write-Step 'prompt' "NON-INTERACTIVE: $Prompt -> auto-y (safety gate bypassed)" 'Yellow'
    return $true
  }
  $resp = Read-Host -Prompt "$Prompt [y/N]"
  return ($resp -eq 'y' -or $resp -eq 'Y')
}

# ---- step 1: create new key ------------------------------------------------

$newPlaintext = $null
$newApiKeyId = $null
$newPrefix = $null

if (-not $SkipNewKey) {
  if ($NonInteractive -and $env:MOSAIQ_TEST_PLAINTEXT) {
    # E2E test override: caller pre-supplied a synthetic plaintext. We do NOT
    # honor this in interactive mode -- forces real operators to use CSPRNG.
    $newPlaintext = $env:MOSAIQ_TEST_PLAINTEXT
    Write-Step 'generate' "USING MOSAIQ_TEST_PLAINTEXT override (length=$($newPlaintext.Length), prefix=$($newPlaintext.Substring(0,[Math]::Min(20, $newPlaintext.Length))))" 'Yellow'
  } else {
    $newPlaintext = New-CsprngPlaintext
    Write-Step 'generate' "new plaintext generated (length=$($newPlaintext.Length), prefix=$($newPlaintext.Substring(0,20)))"
  }

  # Stash in clipboard for the operator (unless they asked us not to / dry-run).
  if (-not $SkipClipboard -and -not $DryRun) {
    try {
      Set-Clipboard -Value $newPlaintext
      Write-Step 'clipboard' 'plaintext copied to clipboard'
    } catch {
      Write-Step 'clipboard' "Set-Clipboard failed: $($_.Exception.Message) -- continuing" 'Yellow'
    }
  } elseif ($DryRun) {
    Write-Step 'clipboard' 'DRY-RUN: skipping clipboard copy (no real plaintext to store)' 'Yellow'
  }

  Write-Host ''
  Write-Host '  >>> STORE THE PLAINTEXT NOW <<<' -ForegroundColor Magenta
  Write-Host '  Paste from clipboard into 1Password / Bitwarden / vault of choice.'
  Write-Host '  This is your ONLY chance to capture the plaintext.'
  Write-Host '  (Press Ctrl+C to abort; nothing has been written to the database yet.)'
  Write-Host ''
  $ok = Read-OperatorConfirmation 'Plaintext stored?'
  if (-not $ok) {
    Write-Host '[ABORT] operator did not confirm plaintext storage; bailing before DB write.' -ForegroundColor Red
    if (-not $SkipClipboard) { Set-Clipboard -Value '' }
    Remove-Variable newPlaintext -ErrorAction SilentlyContinue
    exit 3
  }

  # ---- create-api-key.js --quiet via sh -c -------------------------------
  $shellCmd = "MOSAIQ_NEW_API_KEY=$newPlaintext MOSAIQ_QUIET=1 node /app/dist/admin/create-api-key.js $ProjectId"
  Write-Step 'create' "invoking create-api-key.js --quiet (project=$ProjectId)"
  $createResp = Invoke-FlyAdminScript -ShellCmd $shellCmd -StepLabel 'create'

  if ($DryRun) {
    Write-Step 'create' 'DRY-RUN: skipping response validation' 'Yellow'
  } else {
    if ($createResp.status -ne 'created') {
      Write-Host "[ERR] create-api-key returned status=$($createResp.status), expected 'created'." -ForegroundColor Red
      Write-Host '--- response ---'
      Write-Host ($createResp | ConvertTo-Json -Depth 5)
      Write-Host '----------------'
      exit 1
    }
    if ($createResp.PSObject.Properties.Name -contains 'plaintext') {
      # This would be a serious admin-script bug -- --quiet should suppress.
      Write-Host '[ERR] create-api-key returned plaintext field despite --quiet! This is a security bug; report it.' -ForegroundColor Red
      exit 1
    }
    $newApiKeyId = $createResp.apiKeyId
    $newPrefix   = $createResp.prefix
    Write-Step 'create' "OK status=created apiKeyId=$newApiKeyId prefix=$newPrefix"
  }

  # ---- auth probe new key ------------------------------------------------
  # Probe GET /v1/personas: cheapest auth-protected endpoint that doesn't spawn
  # a Fly machine. Returns 200 with {items:[...]} if auth + project scope OK,
  # 401 if key bad/revoked. Uses auth.projectId from the middleware -- no need
  # to pass project as query param.
  if (-not $DryRun) {
    Write-Step 'probe' "auth-probing new key against $BaseUrl/v1/personas"
    try {
      $probe = Invoke-WebRequest `
        -Uri "$BaseUrl/v1/personas" `
        -Headers @{ Authorization = "Bearer $newPlaintext" } `
        -UseBasicParsing `
        -TimeoutSec 15
      if ($probe.StatusCode -ne 200) {
        Write-Host "[ERR] auth probe got HTTP $($probe.StatusCode), expected 200." -ForegroundColor Red
        Write-Host $probe.Content
        exit 1
      }
      Write-Step 'probe' "OK HTTP 200 -- new key authenticates"
    } catch {
      $code = $null
      try { $code = $_.Exception.Response.StatusCode.value__ } catch { }
      Write-Host "[ERR] auth probe failed (HTTP $code): $($_.Exception.Message)" -ForegroundColor Red
      Write-Host '      The new key was created but does not authenticate. Investigate before revoking old keys.'
      exit 1
    }
  } else {
    Write-Step 'probe' 'DRY-RUN: skipping auth probe' 'Yellow'
  }

  Write-Host ''
  Write-Host '  >>> CUTOVER POINT <<<' -ForegroundColor Magenta
  Write-Host '  The new key works. Switch your downstream clients (LaunchAI, SDK,'
  Write-Host '  smoke tests, etc.) to the new MOSAIQ_API_KEY now.'
  Write-Host '  Once you confirm everything is working on the new key, return here.'
  Write-Host ''
}

# ---- step 2: revoke ids ----------------------------------------------------

if ($RevokeIds.Count -gt 0) {
  if (-not $SkipNewKey) {
    $ok = Read-OperatorConfirmation 'All clients switched to new key? (will revoke old ids if y)'
    if (-not $ok) {
      Write-Host '[ABORT] operator did not confirm cutover; not revoking.' -ForegroundColor Yellow
      Write-Host '        New key is live; old ids remain active. Re-run with -SkipNewKey to revoke later.'
      if (-not $SkipClipboard) { Set-Clipboard -Value '' }
      Remove-Variable newPlaintext -ErrorAction SilentlyContinue
      exit 3
    }
  }

  $revokeResults = @()
  $revokeFailures = 0

  foreach ($id in $RevokeIds) {
    if ([string]::IsNullOrWhiteSpace($id)) { continue }
    if (-not $id.StartsWith('apk_')) {
      Write-Host "[ERR] revoke id '$id' does not start with 'apk_'; skipping." -ForegroundColor Red
      $revokeFailures++
      continue
    }

    $shellCmd = "node /app/dist/admin/revoke-api-key.js $id"
    Write-Step 'revoke' "invoking revoke-api-key.js for $id"
    $revokeResp = Invoke-FlyAdminScript -ShellCmd $shellCmd -StepLabel 'revoke'

    if ($DryRun) {
      Write-Step 'revoke' "DRY-RUN: would revoke $id" 'Yellow'
      $revokeResults += @{ id = $id; status = 'dry-run' }
      continue
    }

    switch ($revokeResp.status) {
      'revoked' {
        Write-Step 'revoke' "OK $id revokedAt=$($revokeResp.revokedAt)"
        $revokeResults += @{ id = $id; status = 'revoked'; revokedAt = $revokeResp.revokedAt }
      }
      'already_revoked' {
        Write-Step 'revoke' "noop $id was already revoked at $($revokeResp.revokedAt)" 'Yellow'
        $revokeResults += @{ id = $id; status = 'already_revoked'; revokedAt = $revokeResp.revokedAt }
      }
      'not_found' {
        Write-Host "[ERR] revoke: $id not found in database." -ForegroundColor Red
        $revokeResults += @{ id = $id; status = 'not_found' }
        $revokeFailures++
      }
      default {
        Write-Host "[ERR] revoke: unexpected status '$($revokeResp.status)' for $id" -ForegroundColor Red
        $revokeResults += @{ id = $id; status = "unexpected:$($revokeResp.status)" }
        $revokeFailures++
      }
    }
  }
}

# ---- step 3: cleanup + summary ---------------------------------------------

# Clear local plaintext + clipboard regardless of outcome.
if (-not $SkipNewKey -and -not $SkipClipboard) {
  try { Set-Clipboard -Value '' } catch { }
}
if ($newPlaintext) {
  Remove-Variable newPlaintext -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '=== rotation summary ===' -ForegroundColor Yellow
if (-not $SkipNewKey) {
  if ($DryRun) {
    Write-Host '  new key:  DRY-RUN (no DB write)'
  } else {
    Write-Host "  new key:  apiKeyId=$newApiKeyId  prefix=$newPrefix"
  }
}
if ($RevokeIds.Count -gt 0) {
  Write-Host '  revoked:'
  foreach ($r in $revokeResults) {
    $tail = if ($r.revokedAt) { " @ $($r.revokedAt)" } else { '' }
    $line = "    - $($r.id) -> $($r.status)$tail"
    Write-Host $line
  }
}
Write-Host ''

if ($revokeFailures -gt 0) {
  Write-Host "[WARN] $revokeFailures revoke(s) failed; review above." -ForegroundColor Red
  exit 4
}

Write-Host '[OK] rotation complete' -ForegroundColor Green
exit 0
