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

function Invoke-OperatorSelfTest {
    # Opens and closes the installed WPF window in both themes against the installed operator.js.
    param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Report)
    if ([IO.File]::Exists($Report)) {
        Remove-Item -LiteralPath $Report -Force
    }
    $process = Start-Process -FilePath $Exe -ArgumentList @('--self-test', ('"' + $Report + '"')) -PassThru
    if (-not $process.WaitForExit(180000)) {
        $process.Kill()
        throw 'The operator window self-test did not finish.'
    }
    $text = if ([IO.File]::Exists($Report)) { [IO.File]::ReadAllText($Report) } else { '(no report)' }
    if ($process.ExitCode -ne 0) {
        throw "The operator window self-test failed ($($process.ExitCode)): $text"
    }
    $result = $text | ConvertFrom-Json
    if (-not $result.passed -or @($result.windows).Count -ne 2) {
        throw "The operator window self-test did not open both themes: $text"
    }
    foreach ($window in @($result.windows)) {
        if ($window.title -ne 'Drive-It' -or $null -ne $window.error) {
            throw "The operator window reported a problem: $text"
        }
    }
    return $result
}

$originalNode = Get-Command node.exe -ErrorAction SilentlyContinue
$originalNodePath = if ($null -eq $originalNode) { $null } else { $originalNode.Source }
$originalDotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
$originalDotnetVersion = if ($null -eq $originalDotnet) { $null } else { & $originalDotnet.Source --version }

[IO.File]::WriteAllText($mcpPath, '{"theme":"dark","mcpServers":{"existing":{"command":"existing.exe","args":[]}}}', [Text.UTF8Encoding]::new($false))
# A shortcut left by an earlier build (the PowerShell window) is replaced by Drive-It.lnk.
$programs = [Environment]::GetFolderPath('Programs')
[IO.Directory]::CreateDirectory($programs) | Out-Null
$previousShortcut = Join-Path $programs 'Drive It.lnk'
[IO.File]::WriteAllText($previousShortcut, 'stale')
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
$launchRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Drive-It'
Assert-InstallerTest ($configuration.mcpServers.'drive-it'.env.DRIVE_IT_LAUNCH_ROOT -eq $launchRoot) "MCP configuration has the wrong launch root: [$($configuration.mcpServers.'drive-it'.env.DRIVE_IT_LAUNCH_ROOT)]."
Assert-InstallerTest ([IO.Directory]::Exists($launchRoot)) 'The reference-image launch root was not created.'

$addinPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Autodesk\Revit\Addins\2026\DriveIt.addin'
Assert-InstallerTest ([IO.File]::Exists($addinPath)) 'The current-user Revit add-in was not registered.'
$shortcutPath = Join-Path $programs 'Drive-It.lnk'
$operatorExe = Join-Path $InstallRoot 'app\operator\DriveIt.Operator.exe'
Assert-InstallerTest ([IO.File]::Exists($shortcutPath)) 'The Drive-It operator shortcut was not installed.'
Assert-InstallerTest (-not [IO.File]::Exists($previousShortcut)) 'The earlier Drive It shortcut was left in the Start Menu.'
Assert-InstallerTest ([IO.File]::Exists($operatorExe)) 'The operator window was not installed.'
Assert-InstallerTest (-not [IO.File]::Exists((Join-Path $InstallRoot 'app\operator\DriveIt.Operator.ps1'))) 'The PowerShell operator window is still installed.'
Assert-InstallerTest ([IO.File]::Exists((Join-Path $InstallRoot 'app\addin\DriveIt.UI.dll'))) 'The add-in folder is missing the operator window library.'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
Assert-InstallerTest ($shortcut.TargetPath -eq $operatorExe) "The shortcut does not open the operator window: [$($shortcut.TargetPath) $($shortcut.Arguments)]."
$addin = [xml](Get-Content -LiteralPath $addinPath -Raw)
Assert-InstallerTest ($addin.RevitAddIns.AddIn.Assembly -eq (Join-Path $InstallRoot 'app\addin\DriveIt.Revit.dll')) 'The add-in manifest points to the wrong assembly.'
$addinName = $addin.RevitAddIns.AddIn.SelectSingleNode('Name').InnerText
Assert-InstallerTest ($addinName -ceq 'Drive-It') "The add-in manifest is named '$addinName', not 'Drive-It'."
$addinHash = (Get-FileHash -LiteralPath $addinPath -Algorithm SHA256).Hash

$env:DRIVE_IT_DATA_DIR = $InstallRoot
Import-Module (Join-Path $InstallRoot 'app\operator\DriveIt.Operator.psm1') -Force -DisableNameChecking
Assert-InstallerTest ((Get-DriveItWorkspace).root -eq $workspace) 'The selected root was not persisted.'
$selfTest = Invoke-OperatorSelfTest -Exe $operatorExe -Report (Join-Path $FixtureDirectory 'operator-self-test.json')
foreach ($window in @($selfTest.windows)) {
    Assert-InstallerTest ($window.workspaceRoot -eq $workspace) "The operator window did not show the selected root: [$($window.workspaceRoot)]."
}

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
