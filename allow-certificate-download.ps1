# Run from an elevated PowerShell. Only the existing home-network HTTP port.
$ErrorActionPreference = 'Stop'
if (-not (Get-NetFirewallRule -Name 'Torfilms-Home-HTTP-18182' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'Torfilms-Home-HTTP-18182' -DisplayName 'Torfilms home HTTP certificate download' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 18182 -LocalAddress 192.168.0.122 -RemoteAddress LocalSubnet -InterfaceAlias Ethernet -Profile Private
}
Write-Host 'Download: http://192.168.0.122:18182/p2p/torfilms-home-ca.crt'
Write-Host 'This also permits access to the existing Torfilms HTTP interface on this port.'
Write-Host 'To remove later: Remove-NetFirewallRule -Name Torfilms-Home-HTTP-18182'
