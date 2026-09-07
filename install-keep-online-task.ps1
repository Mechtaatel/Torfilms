$ErrorActionPreference = 'Stop'
$tfAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'start-online.ps1') + '"') -WorkingDirectory $PSScriptRoot
$tfTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$tfSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$tfUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$tfPrincipal = New-ScheduledTaskPrincipal -UserId $tfUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Torfilms-KeepOnline' -Action $tfAction -Trigger $tfTrigger -Settings $tfSettings -Principal $tfPrincipal -Description 'Restart Torfilms home supervisor if absent; localhost guard prevents duplicates.' -Force
Start-ScheduledTask -TaskName 'Torfilms-KeepOnline'
