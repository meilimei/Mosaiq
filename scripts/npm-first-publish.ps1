# First manual npm publish (v0.10 lock-step trio + v0.11 cloud-sdk).
# All packages under npm org "runova" (@runova/*). @mosaiq scope is taken on npm.
# Prerequisites: npm login + 2FA; @mosaiq org registered; packages built.
#
# Use pnpm publish for sdk/cli (rewrites workspace:*). persona-schema/cloud-sdk: npm ok.
# Provenance disabled locally (see packages/*/publishConfig or NPM_CONFIG_PROVENANCE).
#
# Usage (from repo root):
#   pnpm --filter "@runova/persona-schema" --filter "@runova/sdk" --filter "@runova/cli" build
#   pnpm --filter "@runova/cloud-sdk" build
#   .\scripts\npm-first-publish.ps1

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

$Order = @(
  'persona-schema',
  'sdk',
  'cli',
  'cloud-sdk'
)

$env:NPM_CONFIG_PROVENANCE = 'false'

foreach ($dir in $Order) {
  Write-Host "`n=== publishing packages/$dir ===" -ForegroundColor Cyan
  if ($dir -eq 'sdk' -or $dir -eq 'cli') {
    pnpm --filter "@runova/$dir" publish --access public --no-git-checks --publish-branch main
  } else {
    Push-Location (Join-Path $Root "packages\$dir")
    npm publish --access public --provenance=false
    Pop-Location
  }
  if ($LASTEXITCODE -ne 0) { throw "publish failed: $dir" }
}

Write-Host "`nDone. Verify:" -ForegroundColor Green
npm view @runova/persona-schema version
npm view @runova/sdk version
npm view @runova/cli version
npm view @runova/cloud-sdk version
