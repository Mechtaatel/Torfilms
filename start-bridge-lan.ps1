param([string]$Address = '192.168.0.122', [string]$Certificate, [string]$Key)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:TORFILMS_LAN_HOST = $Address
if (-not $Certificate -and -not $Key -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.local-tls/server.pem'))) {
  $Certificate = Join-Path $PSScriptRoot '.local-tls/server.pem'
  $Key = Join-Path $PSScriptRoot '.local-tls/server-key.pem'
}
if ($Certificate) { $env:TORFILMS_TLS_CERT = $Certificate }
if ($Key) { $env:TORFILMS_TLS_KEY = $Key }
node bridge-lan.js
