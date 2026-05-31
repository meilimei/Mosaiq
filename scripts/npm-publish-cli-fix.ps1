# Deprecated: use npm-publish-runova-fix.ps1 (sdk@0.10.1 + cli@0.10.2).
# CLI-only republish fails global install if @runova/sdk@0.10.0 still has workspace:*.
#
# Usage:
#   .\scripts\npm-publish-runova-fix.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))

Write-Host "Redirecting to npm-publish-runova-fix.ps1 ..." -ForegroundColor Yellow
& (Join-Path $PSScriptRoot 'npm-publish-runova-fix.ps1')
