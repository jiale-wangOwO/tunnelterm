[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]{1,48}$')][string]$ProfileName,[string]$NodePath)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskCli=Join-Path $taskRoot 'bin\tunnelterm.mjs'
$taskNode=if($NodePath){[IO.Path]::GetFullPath($NodePath)}else{(Get-Command node -CommandType Application | Select-Object -First 1).Source}
if(-not(Test-Path -LiteralPath $taskNode -PathType Leaf)){throw 'Installed Node executable is unavailable'}
$taskState=if($env:TUNNELTERM_HOME){[IO.Path]::GetFullPath($env:TUNNELTERM_HOME)}else{Join-Path $env:LOCALAPPDATA 'TunnelTerm'}
$taskServices=if($env:TUNNELTERM_SERVICE_HOME){[IO.Path]::GetFullPath($env:TUNNELTERM_SERVICE_HOME)}elseif($env:TUNNELTERM_HOME){Join-Path $taskState 'services'}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.tunnelterm\services'}
$taskConfig=Join-Path $taskServices ($ProfileName+'.json')
$taskLog=Join-Path $taskServices ($ProfileName+'.watch.log')
New-Item -ItemType Directory -Force -Path $taskServices | Out-Null
@{event='watcher_start';profile=$ProfileName;pid=$PID;state_dir=$taskState} | ConvertTo-Json -Compress | Add-Content -LiteralPath $taskLog
$taskHash=[Security.Cryptography.SHA256]::Create()
$taskBytes=$taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes("$taskState|$ProfileName".ToLowerInvariant()))
$taskName='Local\TunnelTerm-watch-'+([BitConverter]::ToString($taskBytes).Replace('-',''))
$taskMutex=New-Object Threading.Mutex($false,$taskName)
$taskAcquired=$false
try {
  try {$taskAcquired=$taskMutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$taskAcquired=$true}
  if(-not $taskAcquired){@{event='watcher_already_owned';profile=$ProfileName} | ConvertTo-Json -Compress | Add-Content -LiteralPath $taskLog;exit 0}
  $taskFailures=0
  $taskLastOpen=[datetime]::MinValue
  while($true){
    if(-not(Test-Path -LiteralPath $taskConfig)){
      $taskReadError=''
      try {[IO.File]::ReadAllText($taskConfig) | Out-Null} catch {$taskReadError=$_.Exception.GetType().Name+': '+$_.Exception.Message}
      @{event='profile_missing';profile=$ProfileName;path=$taskConfig;user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;files=@([IO.Directory]::GetFiles($taskServices) | ForEach-Object {[IO.Path]::GetFileName($_)});detail=$taskReadError} | ConvertTo-Json -Compress | Add-Content -LiteralPath $taskLog
      exit 0
    }
    $taskDesired=Get-Content -LiteralPath $taskConfig -Raw | ConvertFrom-Json
    $taskRaw=& $taskNode $taskCli service status --profile $ProfileName 2>$null
    $taskStatus=$null
    try {$taskStatus=$taskRaw | ConvertFrom-Json} catch {}
    # A live service may be draining. Never kill it or restart over its owner.
    if($taskStatus -and $taskStatus.phase -notin @('stopped','unreachable')){
      if($taskStatus.last_failure.code -eq 'BRIDGE_UNAVAILABLE' -and $taskDesired.owned_workspace_uri -and $taskDesired.vscode_cli -and
         (Test-Path -LiteralPath $taskDesired.vscode_cli -PathType Leaf) -and ((Get-Date)-$taskLastOpen).TotalSeconds -gt 300){
        $taskProviderOpen=$false
        foreach($taskStatusFile in @(Get-ChildItem -LiteralPath (Join-Path $taskState 'instances') -Filter status.json -Recurse -File -ErrorAction SilentlyContinue)){
          try {
            $taskBridge=Get-Content -LiteralPath $taskStatusFile.FullName -Raw | ConvertFrom-Json
            if($taskBridge.workspace -eq $taskDesired.owned_workspace_uri){
              $taskUiProcess=Get-Process -Id $taskBridge.pid -ErrorAction SilentlyContinue
              if($taskUiProcess -and $taskUiProcess.ProcessName -match '^Code( - Insiders)?$'){$taskProviderOpen=$true;break}
            }
          } catch {}
        }
        if(-not $taskProviderOpen){
          $taskLastOpen=Get-Date
          & $taskDesired.vscode_cli --new-window --folder-uri $taskDesired.owned_workspace_uri *>> $taskLog
        }
      }
      Start-Sleep -Seconds 10
      continue
    }
    if($taskDesired.enabled -eq $false){exit 0}
    if($taskCli -match '["\r\n]'){throw 'Unsupported service CLI path'}
    # Windows PowerShell treats native stderr as errors under Stop, even when
    # redirected. Service JSON events are normal stderr, not startup failures.
    $taskOut=Join-Path $taskServices ($ProfileName+'.daemon.out.log')
    $taskErr=Join-Path $taskServices ($ProfileName+'.daemon.err.log')
    $taskChild=Start-Process -FilePath $taskNode -ArgumentList @("`"$taskCli`"",'service','run','--profile',$ProfileName) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr
    $taskResult=$taskChild.ExitCode
    if($taskResult -eq 0){exit 0} # explicit stop/drain is intentional, not a crash
    $taskFailures=[Math]::Min(5,$taskFailures+1)
    Start-Sleep -Seconds ([Math]::Min(30,[Math]::Pow(2,$taskFailures)))
  }
} catch {
  @{event='watcher_error';profile=$ProfileName;type=$_.Exception.GetType().Name;message=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress | Add-Content -LiteralPath $taskLog
  throw
} finally {
  if($taskAcquired){$taskMutex.ReleaseMutex()}
  $taskMutex.Dispose();$taskHash.Dispose()
}
