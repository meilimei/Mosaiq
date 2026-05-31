# Fix broken npm publishes where workspace:* leaked into tarballs.
#
# Root cause: `npm publish` from package dirs does NOT rewrite workspace:*.
# Use `pnpm publish` so deps become real semver (persona-schema/sdk/cli chain).
#
# Prereq: @runova/persona-schema@0.10.0 on npm (already OK).
#
# Usage (repo root):
#   pnpm --filter @runova/sdk --filter @runova/cli build
#   .\scripts\npm-publish-runova-fix.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))

$env:NPM_CONFIG_PROVENANCE = 'false'

Write-Host "Publishing @runova/sdk@0.10.1 (fixes workspace:* on persona-schema)..." -ForegroundColor Cyan
pnpm --filter "@runova/sdk" publish --access public --no-git-checks --publish-branch main
if ($LASTEXITCODE -ne 0) { throw "sdk publish failed" }

Write-Host "`nPublishing @runova/cli@0.10.2 (depends on sdk@0.10.1)..." -ForegroundColor Cyan
pnpm --filter "@runova/cli" publish --access public --no-git-checks --publish-branch main
if ($LASTEXITCODE -ne 0) { throw "cli publish failed" }

Write-Host "`nVerify:" -ForegroundColor Green
npm view @runova/sdk@0.10.1 dependencies
npm view @runova/cli@0.10.2 dependencies
