#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt')
)

# Removes what Install-DriveIt.ps1 registered outside the MSI's file table.
# Workspace selection, receipts, and other data in the install root are kept.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$install = [IO.Path]::GetFullPath($InstallRoot)
$app = Join-Path $install 'app'

$node = Join-Path $app 'runtimes\node\node.exe'
$clientScript = Join-Path $app 'server\clients.js'
if ([IO.File]::Exists($node) -and [IO.File]::Exists($clientScript)) {
    $clientArguments = @(
        $clientScript, 'unregister',
        [Environment]::GetFolderPath('UserProfile'), [Environment]::GetFolderPath('ApplicationData')
    )
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        $clientArguments += $env:CODEX_HOME
    }
    & $node @clientArguments
}

$addinPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Autodesk\Revit\Addins\2026\DriveIt.addin'
if ([IO.File]::Exists($addinPath)) {
    $addin = [xml](Get-Content -LiteralPath $addinPath -Raw)
    if ([string]$addin.RevitAddIns.AddIn.Assembly -ieq (Join-Path $app 'addin\DriveIt.Revit.dll')) {
        Remove-Item -LiteralPath $addinPath -Force
    }
}

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Drive It.lnk'
if ([IO.File]::Exists($shortcutPath)) {
    Remove-Item -LiteralPath $shortcutPath -Force
}

$mcpPath = Join-Path $install 'mcp.json'
if ([IO.File]::Exists($mcpPath)) {
    $configuration = Get-Content -LiteralPath $mcpPath -Raw | ConvertFrom-Json
    $servers = $configuration.PSObject.Properties['mcpServers']
    if ($null -ne $servers -and $null -ne $servers.Value.PSObject.Properties['drive-it']) {
        $servers.Value.PSObject.Properties.Remove('drive-it')
    }
    if ($null -eq $servers -or @($servers.Value.PSObject.Properties).Count -eq 0) {
        Remove-Item -LiteralPath $mcpPath -Force
    } else {
        [IO.File]::WriteAllText($mcpPath, ($configuration | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    }
}

# The installer provisions .NET into the app directory only when no machine runtime exists.
$privateDotnet = Join-Path $app 'runtimes\dotnet'
if ([IO.Directory]::Exists($privateDotnet)) {
    Remove-Item -LiteralPath $privateDotnet -Recurse -Force
}
