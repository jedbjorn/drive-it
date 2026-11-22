#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MsiPath,
    [Parameter(Mandatory)][string]$LogDirectory
)

# Installs the per-user MSI silently, checks the in-place registration, uninstalls it,
# and checks that registrations are removed while user data is kept.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$msi = (Resolve-Path -LiteralPath $MsiPath).ProviderPath
[IO.Directory]::CreateDirectory($LogDirectory) | Out-Null
$install = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt'
$app = Join-Path $install 'app'
$addinPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Autodesk\Revit\Addins\2026\DriveIt.addin'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Drive It.lnk'
$mcpPath = Join-Path $install 'mcp.json'

function Assert-MsiTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-Msiexec {
    param([string]$Operation, [string]$Log)
    $logPath = Join-Path $LogDirectory $Log
    $process = Start-Process -FilePath msiexec.exe -Wait -PassThru -ArgumentList @(
        $Operation, ('"' + $msi + '"'), '/qn', '/norestart', '/l*v', ('"' + $logPath + '"')
    )
    if ($process.ExitCode -ne 0) {
        throw "msiexec $Operation exited $($process.ExitCode); see $logPath"
    }
}

function Get-ArpEntry {
    Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Drive It' }
}

Invoke-Msiexec -Operation '/i' -Log 'install.log'

$node = Join-Path $app 'runtimes\node\node.exe'
$python = Join-Path $app 'runtimes\python\python.exe'
$server = Join-Path $app 'server\index.js'
Assert-MsiTest ([IO.File]::Exists($node)) 'The MSI did not install private Node.js.'
Assert-MsiTest ([IO.File]::Exists($python)) 'The MSI did not install private Python.'
Assert-MsiTest ($null -ne (Get-ArpEntry)) 'The MSI is not registered as a current-user product.'

$addin = [xml](Get-Content -LiteralPath $addinPath -Raw)
Assert-MsiTest ($addin.RevitAddIns.AddIn.Assembly -eq (Join-Path $app 'addin\DriveIt.Revit.dll')) 'The add-in manifest does not point at the MSI install.'
$configuration = Get-Content -LiteralPath $mcpPath -Raw | ConvertFrom-Json
Assert-MsiTest ($configuration.mcpServers.'drive-it'.command -eq $node) 'MCP configuration does not use the installed private Node.js.'
Assert-MsiTest ($configuration.mcpServers.'drive-it'.args[0] -eq $server) 'MCP configuration does not use the installed server.'
Assert-MsiTest ($configuration.mcpServers.'drive-it'.env.DRIVE_IT_PYTHON -eq $python) 'MCP configuration does not use the installed private Python.'
Assert-MsiTest ([IO.File]::Exists($shortcutPath)) 'The operator shortcut was not created.'
Assert-MsiTest (-not (Get-ChildItem -LiteralPath $install -Filter '.staging-*' -Force)) 'The in-place registration left a staging directory.'

$userData = Join-Path $install 'user-data.sentinel'
[IO.File]::WriteAllText($userData, 'keep')

Invoke-Msiexec -Operation '/x' -Log 'uninstall.log'

Assert-MsiTest ($null -eq (Get-ArpEntry)) 'The product is still registered after uninstall.'
Assert-MsiTest (-not [IO.File]::Exists($server)) 'Uninstall left the MCP server behind.'
Assert-MsiTest (-not [IO.File]::Exists($node)) 'Uninstall left private Node.js behind.'
Assert-MsiTest (-not [IO.File]::Exists($addinPath)) 'Uninstall left the Revit add-in registered.'
Assert-MsiTest (-not [IO.File]::Exists($shortcutPath)) 'Uninstall left the operator shortcut.'
Assert-MsiTest (-not [IO.File]::Exists($mcpPath)) 'Uninstall left the Drive It MCP configuration.'
Assert-MsiTest ([IO.File]::Exists($userData)) 'Uninstall removed user data.'
if ([IO.Directory]::Exists($app)) {
    $leftovers = Get-ChildItem -LiteralPath $app -Recurse -File -Force | Select-Object -First 20 -ExpandProperty FullName
    Assert-MsiTest (-not $leftovers) ("Uninstall left application files:`n" + ($leftovers -join "`n"))
}

Write-Output 'msi tests passed'
