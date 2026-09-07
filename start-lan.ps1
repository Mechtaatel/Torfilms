param([string]$Address)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $Address) {
  $candidates = @(Get-NetIPConfiguration | Where-Object {
    $_.IPv4DefaultGateway -and $_.InterfaceAlias -notmatch 'VPN|tun|TAP'
  } | ForEach-Object { $_.IPv4Address.IPAddress })
  if ($candidates.Count -ne 1) { throw 'Укажите домашний IP: .\start-lan.ps1 -Address 192.168.0.122' }
  $Address = $candidates[0]
}
$env:TORFILMS_LAN_HOST = $Address
node lan.js
