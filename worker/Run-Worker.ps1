param([switch]$Once)
$ErrorActionPreference = 'Stop'
$taskConfigDir = 'E:\breathmap\config\supabase-web'
$taskSettingsFile = Join-Path $taskConfigDir 'settings.json'
$taskKeyFile = Join-Path $taskConfigDir 'worker-key.dpapi'
if (!(Test-Path -LiteralPath $taskSettingsFile) -or !(Test-Path -LiteralPath $taskKeyFile)) { throw 'Run Configure-Worker.ps1 with your Supabase project URL first.' }
$taskSettings = Get-Content -Raw -LiteralPath $taskSettingsFile | ConvertFrom-Json
if ($taskSettings.saved_for_sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Use the same Windows account that configured this worker.' }
$taskSecureKey = Get-Content -Raw -LiteralPath $taskKeyFile | ConvertTo-SecureString
$taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureKey)
$taskPreviousUrl = $env:SUPABASE_URL
$taskPreviousKey = $env:SUPABASE_SECRET_KEY
try {
  $env:SUPABASE_URL = $taskSettings.project_url
  $env:SUPABASE_SECRET_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
  $taskPython = Join-Path $PSScriptRoot '..\..\BreathMap_local_20261027\.venv\Scripts\python.exe'
  if (!(Test-Path -LiteralPath $taskPython)) { throw 'The existing BreathMap Python environment was not found.' }
  $taskArguments = @('-B','-X','utf8',(Join-Path $PSScriptRoot 'breathmap_worker.py'))
  if ($Once) { $taskArguments += '--once' }
  & $taskPython @taskArguments
  $taskExit = $LASTEXITCODE
} finally {
  $env:SUPABASE_URL = $taskPreviousUrl
  $env:SUPABASE_SECRET_KEY = $taskPreviousKey
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
  $taskSecureKey.Dispose()
}
if ($taskExit -ne 0) { throw "The worker exited with code $taskExit. See its sanitized error code." }
