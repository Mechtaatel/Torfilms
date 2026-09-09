param(
  [int]$Port = 18183,
  [string]$Cloudflared = (Join-Path $PSScriptRoot '.runtime/cloudflared.exe')
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$runtime = Split-Path -Parent $Cloudflared
if (-not (Test-Path -LiteralPath $runtime)) {
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
}

if (-not (Test-Path -LiteralPath $Cloudflared)) {
  $download = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Write-Host 'Скачиваю cloudflared из официального репозитория Cloudflare...'
  Invoke-WebRequest -Uri $download -OutFile $Cloudflared
}

Write-Host "Публикую локальный Torfilms backend: http://127.0.0.1:$Port"
Write-Host 'Адрес trycloudflare.com появится ниже. Не закрывайте это окно.'
& $Cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$Port"
