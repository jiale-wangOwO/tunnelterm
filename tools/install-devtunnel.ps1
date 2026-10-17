[CmdletBinding()]
param([string]$Directory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.tunnelterm\bin'))
$ErrorActionPreference = 'Stop'
$taskExe = Join-Path $Directory 'devtunnel.exe'
if (-not (Test-Path -LiteralPath $taskExe -PathType Leaf)) {
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri 'https://aka.ms/TunnelsCliDownload/win-x64' -OutFile $taskExe -UseBasicParsing
}
$taskSignature = Get-AuthenticodeSignature -LiteralPath $taskExe
if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notlike '*Microsoft Corporation*') {
  throw 'The devtunnel client does not have a valid Microsoft signature. It was not started.'
}
& $taskExe --version
if ($LASTEXITCODE -ne 0) {throw "The client exited with status $LASTEXITCODE"}
Write-Output "Verified client: $taskExe"
Write-Output "GitHub login: & `"$taskExe`" user login -g"
Write-Output "Microsoft login: & `"$taskExe`" user login"
