[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Target,
  [ValidateRange(1024,65535)][int]$Port = 22222,
  [switch]$Trace
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$taskScript = Join-Path $taskRoot 'bin\tunnelterm.mjs'
$taskState = if ($env:TUNNELTERM_HOME) {$env:TUNNELTERM_HOME} else {Join-Path $env:LOCALAPPDATA 'TunnelTerm'}
New-Item -ItemType Directory -Force -Path $taskState | Out-Null
$taskRecord = Join-Path $taskState "stream-forward-$Port.json"
$taskListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($taskListener) {
  if (Test-Path -LiteralPath $taskRecord) {
    $taskSaved = Get-Content -LiteralPath $taskRecord -Raw | ConvertFrom-Json
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskSaved.pid)"
    if ($taskProcess -and $taskProcess.CreationDate.ToUniversalTime().Ticks -eq ([datetimeoffset]$taskSaved.created).UtcDateTime.Ticks -and
        $taskProcess.CommandLine -eq $taskSaved.commandLine -and $taskSaved.target -eq $Target -and
        $taskListener.OwningProcess -eq $taskSaved.pid -and $taskListener.LocalAddress -eq '127.0.0.1') {
      Write-Output "Already running: 127.0.0.1:$Port (PID $($taskSaved.pid))"
      exit 0
    }
  }
  throw "Port $Port is occupied by a different or unverified listener. This launcher never stops unrelated processes."
}
# Start-Process on Windows joins ArgumentList, so explicitly quote and reject
# shell/argument delimiters in paths and targets before constructing the line.
if ($Target -match '["\r\n]' -or $taskScript -match '"') {throw 'Target/script cannot contain quotes or newlines'}
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskOut = Join-Path $taskState "stream-forward-$Port-$taskStamp.out.log"
$taskErr = Join-Path $taskState "stream-forward-$Port-$taskStamp.err.log"
$taskArgs=@("`"$taskScript`"",'forward','--target',"`"$Target`"",'--port',"$Port")
if($Trace){$taskArgs+='--trace'}
$taskChild = Start-Process -FilePath $taskNode -ArgumentList $taskArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr
$taskInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskChild.Id)"
if (-not $taskInfo) {throw "Forward failed to launch; inspect $taskErr"}
$taskInfoRecord = @{pid=$taskChild.Id;created=$taskInfo.CreationDate.ToUniversalTime().ToString('o');commandLine=$taskInfo.CommandLine;target=$Target;port=$Port;log=$taskErr}
$taskInfoRecord | ConvertTo-Json | Set-Content -LiteralPath $taskRecord -Encoding utf8
$taskDeadline=(Get-Date).AddSeconds(45)
while ((Get-Date) -lt $taskDeadline) {
  $taskChild.Refresh()
  if ($taskChild.HasExited) {throw "Forward failed; inspect $taskErr"}
  $taskReady = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.OwningProcess -eq $taskChild.Id -and $_.LocalAddress -eq '127.0.0.1'}
  if ($taskReady) {
    # Metadata is a generated runtime artifact, not a source edit.
    Write-Output "Ready: 127.0.0.1:$Port (PID $($taskChild.Id)); log: $taskErr"
    exit 0
  }
  Start-Sleep -Milliseconds 200
}
$taskCurrent=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskChild.Id)"
if($taskCurrent -and $taskCurrent.CreationDate.ToUniversalTime().Ticks -eq $taskInfo.CreationDate.ToUniversalTime().Ticks -and $taskCurrent.CommandLine -eq $taskInfo.CommandLine){Stop-Process -Id $taskChild.Id}
throw "Forward did not become ready within 45 seconds; only its verified startup process was stopped. Inspect $taskErr."
