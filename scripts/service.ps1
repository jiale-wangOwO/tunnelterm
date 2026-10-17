[CmdletBinding()]
param(
  [Parameter(Position=0)][ValidateSet('status','recover','restart','start','check','refresh','stop','drain')][string]$Action='recover',
  [Parameter(Position=1)][ValidatePattern('^[a-zA-Z0-9_-]{1,48}$')][string]$ProfileName='default'
)
$ErrorActionPreference='Stop'
$taskCli=Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\tunnelterm.mjs'
$taskNode=(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $taskNode $taskCli service $Action --profile $ProfileName
exit $LASTEXITCODE
