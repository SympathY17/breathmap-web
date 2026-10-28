param([switch]$Execute,[switch]$WithAI)
$ErrorActionPreference = 'Stop'
if (!$Execute) { throw 'Use -Execute to run disposable synthetic cloud acceptance. No real account is used.' }
& (Join-Path $PSScriptRoot 'Run-Worker.ps1') -CloudSmoke -WithAI:$WithAI
