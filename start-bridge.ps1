$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node build-p2p.js
node bridge.js
