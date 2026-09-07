Option Explicit
Dim shell, files, directory, powershell, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
directory = files.GetParentFolderName(WScript.ScriptFullName)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powershell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & directory & "\start-online.ps1"""
' A GUI host starts PowerShell hidden from creation, before it can flash a console.
' Wait for the launcher so Task Scheduler receives its actual exit code.
result = shell.Run(command, 0, True)
WScript.Quit result
