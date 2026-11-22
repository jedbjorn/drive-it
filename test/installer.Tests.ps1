#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$FixtureDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$package = (Resolve-Path -LiteralPath $PackagePath).ProviderPath
$operatorScript = Join-Path $package 'app\server\operator.js'
if (-not [IO.File]::Exists($operatorScript)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'operator-cli.stub') -Destination $operatorScript
}
[IO.Directory]::CreateDirectory($FixtureDirectory) | Out-Null
$FixtureDirectory = (Get-Item -LiteralPath $FixtureDirectory -Force).FullName
$workspace = Join-Path $FixtureDirectory 'workspace'
[IO.Directory]::CreateDirectory($workspace) | Out-Null
$mcpPath = Join-Path $FixtureDirectory 'client.json'

function Assert-InstallerTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

$originalNode = Get-Command node.exe -ErrorAction SilentlyContinue
$originalNodePath = if ($null -eq $originalNode) { $null } else { $originalNode.Source }
$originalDotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
$originalDotnetVersion = if ($null -eq $originalDotnet) { $null } else { & $originalDotnet.Source --version }

[IO.File]::WriteAllText($mcpPath, '{"theme":"dark","mcpServers":{"existing":{"command":"existing.exe","args":[]}}}', [Text.UTF8Encoding]::new($false))
$installer = Join-Path $package 'Install-DriveIt.ps1'
& $installer -SourcePath $package -InstallRoot $InstallRoot -WorkspaceRoot $workspace -McpConfigPath $mcpPath -NoLaunch | Out-Null
$InstallRoot = (Get-Item -LiteralPath $InstallRoot -Force).FullName

$node = Join-Path $InstallRoot 'app\runtimes\node\node.exe'
$python = Join-Path $InstallRoot 'app\runtimes\python\python.exe'
$server = Join-Path $InstallRoot 'app\server\index.js'
Assert-InstallerTest ([IO.File]::Exists($node)) 'Private Node.js was not installed.'
Assert-InstallerTest ([IO.File]::Exists($python)) 'Private Python was not installed.'
Assert-InstallerTest ([version](& $node --version).TrimStart('v') -ge [version]'22.0.0') 'Private Node.js is too old.'

$configuration = Get-Content -LiteralPath $mcpPath -Raw | ConvertFrom-Json
Assert-InstallerTest ($configuration.theme -eq 'dark') 'Existing client configuration was not preserved.'
Assert-InstallerTest ($configuration.mcpServers.existing.command -eq 'existing.exe') 'Another MCP server was removed.'
Assert-InstallerTest ($configuration.mcpServers.'drive-it'.command -eq $node) "MCP configuration does not use private Node.js. Expected [$node], actual [$($configuration.mcpServers.'drive-it'.command)]."
Assert-InstallerTest ($configuration.mcpServers.'drive-it'.args[0] -eq $server) 'MCP configuration does not use the installed server.'
Assert-InstallerTest ($configuration.mcpServers.'drive-it'.env.DRIVE_IT_DATA_DIR -eq $InstallRoot) 'MCP configuration has the wrong data directory.'
Assert-InstallerTest ($configuration.mcpServers.'drive-it'.env.DRIVE_IT_PYTHON -eq $python) 'MCP configuration does not use private Python.'

$addinPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Autodesk\Revit\Addins\2026\DriveIt.addin'
Assert-InstallerTest ([IO.File]::Exists($addinPath)) 'The current-user Revit add-in was not registered.'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Drive It.lnk'
Assert-InstallerTest ([IO.File]::Exists($shortcutPath)) 'The Drive It operator shortcut was not installed.'
Assert-InstallerTest ([IO.File]::Exists((Join-Path $InstallRoot 'app\operator\DriveIt.Operator.ps1'))) 'The operator surface was not installed.'
$addin = [xml](Get-Content -LiteralPath $addinPath -Raw)
Assert-InstallerTest ($addin.RevitAddIns.AddIn.Assembly -eq (Join-Path $InstallRoot 'app\addin\DriveIt.Revit.dll')) 'The add-in manifest points to the wrong assembly.'
$addinHash = (Get-FileHash -LiteralPath $addinPath -Algorithm SHA256).Hash

$env:DRIVE_IT_DATA_DIR = $InstallRoot
Import-Module (Join-Path $InstallRoot 'app\operator\DriveIt.Operator.psm1') -Force -DisableNameChecking
Assert-InstallerTest ((Get-DriveItWorkspace).root -eq $workspace) 'The selected root was not persisted.'

& $installer -SourcePath $package -InstallRoot $InstallRoot -McpConfigPath $mcpPath -NoLaunch | Out-Null
Assert-InstallerTest ((Get-DriveItWorkspace).root -eq $workspace) 'An idempotent retry changed the selected root.'
Assert-InstallerTest ((Get-FileHash -LiteralPath $addinPath -Algorithm SHA256).Hash -eq $addinHash) 'An idempotent retry changed the add-in registration.'

$currentNode = Get-Command node.exe -ErrorAction SilentlyContinue
$currentNodePath = if ($null -eq $currentNode) { $null } else { $currentNode.Source }
Assert-InstallerTest ($currentNodePath -eq $originalNodePath) 'Installation changed the global Node.js toolchain.'
if ($null -ne $originalDotnet) {
    $currentDotnet = Get-Command dotnet.exe -ErrorAction Stop
    Assert-InstallerTest ((& $currentDotnet.Source --version) -eq $originalDotnetVersion) 'Installation changed the global .NET SDK.'
}

$failedRoot = Join-Path $FixtureDirectory 'failed-install'
$failedMcp = Join-Path $FixtureDirectory 'failed-client.json'
$missingNode = Join-Path $package 'app\runtimes\node\node.exe'
Move-Item -LiteralPath $missingNode -Destination "$missingNode.missing"
try {
    $failed = $false
    try {
        & $installer -SourcePath $package -InstallRoot $failedRoot -McpConfigPath $failedMcp -NoLaunch | Out-Null
    } catch {
        $failed = $true
    }
    Assert-InstallerTest $failed 'An incomplete package reported success.'
    Assert-InstallerTest (-not [IO.File]::Exists($failedMcp)) 'A failed prerequisite emitted MCP configuration.'
    Assert-InstallerTest ((Get-FileHash -LiteralPath $addinPath -Algorithm SHA256).Hash -eq $addinHash) 'A failed prerequisite changed add-in registration.'
} finally {
    Move-Item -LiteralPath "$missingNode.missing" -Destination $missingNode
}

Write-Output 'installer tests passed'
