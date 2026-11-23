# Stops every process whose image is under %LOCALAPPDATA%\DriveIt\app: the private node.exe an
# MCP client keeps running, its python.exe worker, and DriveIt.Operator.exe. Nothing else (Revit
# is never touched). Run by the MSI before InstallValidate so an upgrade or uninstall under
# MSIRESTARTMANAGERCONTROL=Disable never meets a file in use (exit 3010). Build-DriveItMsi.ps1
# embeds it as an -EncodedCommand with comment lines removed, so keep it short and self-contained,
# and keep '#' to whole-line comments. Uninstall-DriveIt.ps1 runs the same step for script installs.
$ErrorActionPreference = 'SilentlyContinue'
$app = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt\app').TrimEnd('\') + '\'
$own = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($app, [StringComparison]::OrdinalIgnoreCase)
})
foreach ($process in $own) {
    Write-Output "Stopping $($process.Name) ($($process.ProcessId)): $($process.ExecutablePath)"
    Stop-Process -Id $process.ProcessId -Force
}
foreach ($process in $own) {
    Wait-Process -Id $process.ProcessId -Timeout 15
}
exit 0
