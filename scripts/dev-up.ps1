
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
node scripts/dev-up.js @args
exit $LASTEXITCODE
