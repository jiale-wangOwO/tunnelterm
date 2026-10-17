[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]{1,48}$')][string]$ProfileName,[switch]$StartNow,[string]$ServiceFolderUri,[string]$CodePath)
$ErrorActionPreference='Stop'
$taskStartup=[Environment]::GetFolderPath('Startup')
if(-not $taskStartup -or -not(Test-Path -LiteralPath $taskStartup -PathType Container)){throw 'Current-user Startup folder is unavailable'}
$taskTarget=[IO.Path]::GetFullPath((Join-Path $taskStartup "TunnelTerm-$ProfileName.lnk"))
if([IO.Path]::GetDirectoryName($taskTarget) -ne [IO.Path]::GetFullPath($taskStartup)){throw 'Shortcut escaped the current-user Startup folder'}
$taskScript=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-managed-service.ps1'))
$taskNodePath=(Get-Command node -CommandType Application | Select-Object -First 1).Source
$taskShellExe=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
if($taskScript -match '["\r\n]' -or $taskNodePath -match '["\r\n]'){throw 'Unsupported installer path'}
$taskArguments="-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$taskScript`" -ProfileName $ProfileName -NodePath `"$taskNodePath`""
if($ServiceFolderUri){
  if(-not $CodePath -or -not(Test-Path -LiteralPath $CodePath -PathType Leaf)){throw 'Explicit VS Code CLI required for the owned service workspace'}
  # VS Code remote authorities are not DNS hostnames (System.Uri rejects '+').
  if($ServiceFolderUri -notmatch '^(vscode-remote://tunnel(?:\+|%2[Bb])[A-Za-z0-9._-]+)(/[^?#]*)$'){
    throw 'Invalid owned VS Code Tunnel workspace URI'
  }
  $taskRemotePath=[uri]::UnescapeDataString($Matches[2])
  $taskCanonicalUri=($Matches[1] -replace 'tunnel\+','tunnel%2B')+$Matches[2]
  if($taskRemotePath -notmatch '/\.cache/tunnelterm/ssh-service(?:/isolated-[a-f0-9-]{36})?$'){
    throw 'Automatic window opening is limited to an explicitly selected dedicated cache workspace'
  }
  # Persist only ordinary window location/executable, never account data.
  $taskState=if($env:TUNNELTERM_HOME){[IO.Path]::GetFullPath($env:TUNNELTERM_HOME)}else{Join-Path $env:LOCALAPPDATA 'TunnelTerm'}
  $taskServices=if($env:TUNNELTERM_SERVICE_HOME){[IO.Path]::GetFullPath($env:TUNNELTERM_SERVICE_HOME)}elseif($env:TUNNELTERM_HOME){Join-Path $taskState 'services'}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.tunnelterm\services'}
  $taskConfigPath=Join-Path $taskServices ($ProfileName+'.json')
  $taskConfig=Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
  if($taskRemotePath -ne $taskConfig.target){throw 'Owned workspace does not match the service profile'}
  $taskConfig | Add-Member -NotePropertyName owned_workspace_uri -NotePropertyValue $taskCanonicalUri -Force
  $taskConfig | Add-Member -NotePropertyName vscode_cli -NotePropertyValue ([IO.Path]::GetFullPath($CodePath)) -Force
  $taskConfig | ConvertTo-Json | Set-Content -LiteralPath $taskConfigPath -Encoding utf8
}
$taskDescription="TunnelTerm managed service: $ProfileName"
$taskWsh=New-Object -ComObject WScript.Shell
$taskShortcut=$taskWsh.CreateShortcut($taskTarget)
if(Test-Path -LiteralPath $taskTarget){
  if($taskShortcut.Description -ne $taskDescription -or $taskShortcut.TargetPath -ne $taskShellExe -or $taskShortcut.Arguments -ne $taskArguments){throw 'An unverified shortcut occupies this name; refusing to overwrite it'}
}
$taskShortcut.TargetPath=$taskShellExe
$taskShortcut.Arguments=$taskArguments
$taskShortcut.WorkingDirectory=Split-Path -Parent $PSScriptRoot
$taskShortcut.Description=$taskDescription
$taskShortcut.WindowStyle=7
$taskShortcut.Save()
Write-Output "Installed current-user startup watcher for profile '$ProfileName'. No administrator service, credential or global execution-policy change."
$taskSchedulerInstalled=$false
$taskSchedulerName="TunnelTerm-$ProfileName"
try {
  $taskExisting=Get-ScheduledTask -TaskName $taskSchedulerName -ErrorAction SilentlyContinue
  if($taskExisting -and ($taskExisting.Description -ne $taskDescription -or $taskExisting.Actions.Execute -ne $taskShellExe -or $taskExisting.Actions.Arguments -ne $taskArguments)){
    throw 'Unverified scheduled task occupies the service name'
  }
  $taskUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskAction=New-ScheduledTaskAction -Execute $taskShellExe -Argument $taskArguments -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
  $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
  $taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
  $taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskSchedulerName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description $taskDescription -Force | Out-Null
  $taskSchedulerInstalled=$true
  $taskState=if($env:TUNNELTERM_HOME){[IO.Path]::GetFullPath($env:TUNNELTERM_HOME)}else{Join-Path $env:LOCALAPPDATA 'TunnelTerm'}
  $taskServices=if($env:TUNNELTERM_SERVICE_HOME){[IO.Path]::GetFullPath($env:TUNNELTERM_SERVICE_HOME)}elseif($env:TUNNELTERM_HOME){Join-Path $taskState 'services'}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.tunnelterm\services'}
  $taskConfigPath=Join-Path $taskServices ($ProfileName+'.json')
  $taskConfig=Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
  $taskConfig | Add-Member -NotePropertyName scheduler_task -NotePropertyValue $taskSchedulerName -Force
  $taskConfig | ConvertTo-Json | Set-Content -LiteralPath $taskConfigPath -Encoding utf8
  # Use one supervised logon path; keep the shortcut only as the no-task fallback.
  $taskOwnedShortcut=$taskWsh.CreateShortcut($taskTarget)
  if($taskOwnedShortcut.Description -eq $taskDescription -and $taskOwnedShortcut.Arguments -eq $taskArguments){Remove-Item -LiteralPath $taskTarget}
  Write-Output 'Installed limited current-user scheduled supervisor; no password or elevation required.'
} catch {
  if($taskExisting){throw}
  Write-Output 'Scheduled supervision unavailable; current-user Startup shortcut remains installed.'
}
if($StartNow){
  # Launch via the user's desktop shell, outside the initiating terminal/app's
  # process tree. Watcher mutex prevents duplicate supervisors.
  if($taskSchedulerInstalled){Start-ScheduledTask -TaskName $taskSchedulerName; Write-Output 'Started hidden scheduled watcher outside the caller process tree.'}
  else {
    $taskDesktop=New-Object -ComObject Shell.Application
    $taskDesktop.ShellExecute($taskShellExe,$taskArguments,(Split-Path -Parent $PSScriptRoot),'open',0)
    Write-Output 'Started hidden user-session watcher.'
  }
}
