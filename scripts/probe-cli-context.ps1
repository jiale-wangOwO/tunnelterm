[CmdletBinding()]
param([string]$NodePath)
$ErrorActionPreference='Stop'
$taskScript=Join-Path $PSScriptRoot 'probe-cli-context.mjs'
$taskNode=if($NodePath){[IO.Path]::GetFullPath($NodePath)}else{(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source}
$taskServices=if($env:TUNNELTERM_SERVICE_HOME){[IO.Path]::GetFullPath($env:TUNNELTERM_SERVICE_HOME)}elseif($env:TUNNELTERM_HOME){Join-Path $env:TUNNELTERM_HOME 'services'}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.tunnelterm\services'}
New-Item -ItemType Directory -Force -Path $taskServices | Out-Null
$taskOut=Join-Path $taskServices 'cli-context-probe.out.log'
$taskErr=Join-Path $taskServices 'cli-context-probe.err.log'
$taskChild=Start-Process -FilePath $taskNode -ArgumentList @("`"$taskScript`"") -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr
exit $taskChild.ExitCode
