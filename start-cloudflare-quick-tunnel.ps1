param(
  [int]$Port = 18183,
  [string]$Cloudflared
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Cloudflared)) {
  $Cloudflared = Join-Path $PSScriptRoot '.runtime\cloudflared.exe'
}
$runtime = Split-Path -Parent $Cloudflared
if (-not (Test-Path -LiteralPath $runtime)) {
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
}

if (-not (Test-Path -LiteralPath $Cloudflared)) {
  $download = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Write-Host 'Downloading cloudflared from the official Cloudflare release...'
  Invoke-WebRequest -Uri $download -OutFile $Cloudflared
}

Write-Host "Publishing the local Torfilms backend: http://127.0.0.1:$Port"
Write-Host 'The trycloudflare.com address will appear below. Keep this window open.'
& $Cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$Port"
