# Run from an elevated PowerShell. Opens only the home interface/subnet.
$ErrorActionPreference = 'Stop'
if (-not (Get-NetFirewallRule -Name 'Torfilms-Hybrid-LAN-18184' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'Torfilms-Hybrid-LAN-18184' -DisplayName 'Torfilms Hybrid home LAN 18184' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 18184 -LocalAddress 192.168.0.122 -RemoteAddress LocalSubnet -InterfaceAlias Ethernet -Profile Private
}
