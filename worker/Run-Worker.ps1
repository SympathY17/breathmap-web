param([switch]$Once,[switch]$CloudSmoke,[switch]$WithAI,
      [ValidateSet('prepare','link','login','login-password','set-password','cleanup')][string]$BrowserQA,[switch]$PrivateOutput)
$ErrorActionPreference = 'Stop'
if ($WithAI -and !$CloudSmoke) { throw 'WithAI is reserved for the explicit disposable synthetic cloud check.' }
if ($Once -and $CloudSmoke) { throw 'Choose worker single-job mode or cloud acceptance mode.' }
if ($BrowserQA -and ($CloudSmoke -or $Once -or $WithAI)) { throw 'Browser QA is a separate explicit action.' }
if ($PrivateOutput -and $BrowserQA -ne 'link') { throw 'Private output is reserved for the browser QA link action.' }
if ($BrowserQA -eq 'link' -and !$PrivateOutput) { throw 'Capture the link privately with PrivateOutput; never echo or save it.' }
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
  if ($BrowserQA) {
    $taskArguments = @('-B','-X','utf8',(Join-Path $PSScriptRoot 'prepare_browser_qa.py'),$BrowserQA)
    if ($PrivateOutput) { $taskArguments += '--private-output' }
  } elseif ($CloudSmoke) {
    $taskArguments = @('-B','-X','utf8',(Join-Path $PSScriptRoot 'cloud_smoke.py'),'--execute')
    if ($WithAI) { $taskArguments += '--with-ai' }
  } else {
    $taskArguments = @('-B','-X','utf8',(Join-Path $PSScriptRoot 'breathmap_worker.py'))
    if ($Once) { $taskArguments += '--once' }
  }
  & $taskPython @taskArguments
  $taskExit = $LASTEXITCODE
} finally {
  $env:SUPABASE_URL = $taskPreviousUrl
  $env:SUPABASE_SECRET_KEY = $taskPreviousKey
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
  $taskSecureKey.Dispose()
}
if ($taskExit -ne 0) { throw "The worker exited with code $taskExit. See its sanitized error code." }
