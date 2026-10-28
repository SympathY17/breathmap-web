param(
  [Parameter(Mandatory=$true)][string]$ProjectUrl,
  [string]$SandboxRoot = 'E:\breathmap'
)
$ErrorActionPreference = 'Stop'
if ($ProjectUrl -notmatch '^https://[a-z0-9]+\.supabase\.co/?$') { throw 'Enter the exact Supabase project HTTPS URL.' }
$taskRoot = [IO.Path]::GetFullPath($SandboxRoot)
if ($taskRoot.TrimEnd('\') -ne 'E:\breathmap') { throw 'This launcher is restricted to the approved E:\breathmap runtime sandbox.' }
$configDir = Join-Path $taskRoot 'config\supabase-web'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$taskAcl = New-Object System.Security.AccessControl.DirectorySecurity
$taskAcl.SetAccessRuleProtection($true,$false)
$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$taskRule = New-Object System.Security.AccessControl.FileSystemAccessRule($taskSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$taskAcl.AddAccessRule($taskRule)
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$taskAcl.AddAccessRule($systemRule)
Set-Acl -LiteralPath $configDir -AclObject $taskAcl
Write-Host 'Paste the Supabase server secret key (sb_secret_...). Input is hidden. Do not paste a publishable key.'
$taskSecureKey = Read-Host 'Supabase secret key' -AsSecureString
if ($taskSecureKey.Length -lt 20) { throw 'The key is incomplete; nothing was saved.' }
$taskEncrypted = ConvertFrom-SecureString $taskSecureKey
[IO.File]::WriteAllText((Join-Path $configDir 'worker-key.dpapi'),$taskEncrypted,[Text.UTF8Encoding]::new($false))
@{project_url=$ProjectUrl.TrimEnd('/');saved_for_sid=$taskSid.Value} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configDir 'settings.json') -Encoding utf8
$taskSecureKey.Dispose()
Write-Host 'Saved with Windows encryption for the current Windows account. The key was not printed.'
