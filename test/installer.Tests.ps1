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

. (Join-Path $PSScriptRoot 'operator-self-test.ps1')

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

# Every supported year's add-in is registered whatever Revit is installed (spec #22 "Install Rule").
$revitYears = @('2026', '2027')
function Get-AddinPath([string]$Year) {
    return Join-Path ([Environment]::GetFolderPath('ApplicationData')) "Autodesk\Revit\Addins\$Year\DriveIt.addin"
}
function Get-AddinHash {
    return (@($revitYears | ForEach-Object { (Get-FileHash -LiteralPath (Get-AddinPath $_) -Algorithm SHA256).Hash }) -join ',')
}
foreach ($year in $revitYears) {
    Assert-InstallerTest ([IO.File]::Exists((Get-AddinPath $year))) "The current-user Revit $year add-in was not registered."
}
$shortcutPath = Join-Path $programs 'Drive-It.lnk'
$operatorExe = Join-Path $InstallRoot 'app\operator\DriveIt.Operator.exe'
Assert-InstallerTest ([IO.File]::Exists($shortcutPath)) 'The Drive-It operator shortcut was not installed.'
Assert-InstallerTest (-not [IO.File]::Exists($previousShortcut)) 'The earlier Drive It shortcut was left in the Start Menu.'
Assert-InstallerTest ([IO.File]::Exists($operatorExe)) 'The operator window was not installed.'
Assert-InstallerTest (-not [IO.File]::Exists((Join-Path $InstallRoot 'app\operator\DriveIt.Operator.ps1'))) 'The PowerShell operator window is still installed.'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
Assert-InstallerTest ($shortcut.TargetPath -eq $operatorExe) "The shortcut does not open the operator window: [$($shortcut.TargetPath) $($shortcut.Arguments)]."
foreach ($year in $revitYears) {
    $build = Join-Path $InstallRoot "app\addin\$year"
    Assert-InstallerTest ([IO.File]::Exists((Join-Path $build 'DriveIt.UI.dll'))) "The Revit $year add-in folder is missing the operator window library."
    $addin = [xml](Get-Content -LiteralPath (Get-AddinPath $year) -Raw)
    Assert-InstallerTest ($addin.RevitAddIns.AddIn.Assembly -eq (Join-Path $build 'DriveIt.Revit.dll')) "The Revit $year add-in manifest points to the wrong assembly: [$($addin.RevitAddIns.AddIn.Assembly)]."
    $addinName = $addin.RevitAddIns.AddIn.SelectSingleNode('Name').InnerText
    Assert-InstallerTest ($addinName -ceq 'Drive-It') "The Revit $year add-in manifest is named '$addinName', not 'Drive-It'."
}
$addinHash = Get-AddinHash

$env:DRIVE_IT_DATA_DIR = $InstallRoot
Import-Module (Join-Path $InstallRoot 'app\operator\DriveIt.Operator.psm1') -Force -DisableNameChecking
Assert-InstallerTest ((Get-DriveItWorkspace).root -eq $workspace) 'The selected root was not persisted.'
$selfTest = Invoke-OperatorSelfTest -Exe $operatorExe -Report (Join-Path $FixtureDirectory 'operator-self-test.json')
foreach ($window in @($selfTest.windows)) {
    Assert-InstallerTest ($window.workspaceRoot -eq $workspace) "The operator window did not show the selected root: [$($window.workspaceRoot)]."
    Assert-InstallerTest ($window.scriptTimeLimitSeconds -eq 120) "The operator window did not show the default script time limit: [$($window.scriptTimeLimitSeconds)]."
}

# Spec #23 AC-2 and AC-6: the settings drawer saves and re-reads the limit, against a throwaway data
# directory so the install's own settings are untouched.
$drawerData = Join-Path $FixtureDirectory 'drawer-data'
[IO.Directory]::CreateDirectory($drawerData) | Out-Null
$env:DRIVE_IT_DATA_DIR = $drawerData
try {
    Invoke-OperatorSelfTest -Exe $operatorExe -Report (Join-Path $FixtureDirectory 'operator-self-test-drawer.json') -DrawerWrites -StagedActions | Out-Null
} finally {
    $env:DRIVE_IT_DATA_DIR = $InstallRoot
}
$drawerSettings = Get-Content -LiteralPath (Join-Path $drawerData 'settings.json') -Raw | ConvertFrom-Json
Assert-InstallerTest ($drawerSettings.scriptTimeLimitSeconds -eq 90) "The drawer self-test left settings.json at [$($drawerSettings.scriptTimeLimitSeconds)], not the 90 operator.js set last."
Assert-InstallerTest ((Get-DriveItWorkspace).root -eq $workspace) 'The drawer self-test changed the install''s selected root.'

& $installer -SourcePath $package -InstallRoot $InstallRoot -McpConfigPath $mcpPath -NoLaunch | Out-Null
Assert-InstallerTest ((Get-DriveItWorkspace).root -eq $workspace) 'An idempotent retry changed the selected root.'
Assert-InstallerTest ((Get-AddinHash) -eq $addinHash) 'An idempotent retry changed the add-in registration.'

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
    Assert-InstallerTest ((Get-AddinHash) -eq $addinHash) 'A failed prerequisite changed add-in registration.'
} finally {
    Move-Item -LiteralPath "$missingNode.missing" -Destination $missingNode
}

# Spec #10: the default workspace and the two install modes. A second install with no root starts in
# C:\DriveIt\default; then dev and back to standard. CI runners are elevated administrators, so
# the dev install passes the gate here; the unelevated gate is proven live on W10C (AC-3).
$userModeFile = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt\install-mode.json'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$marker = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) "DriveIt\dev-mode\$sid.json"
$modeRoot = Join-Path $FixtureDirectory 'mode-install'
$modeMcp = Join-Path $FixtureDirectory 'mode-client.json'
$modeApp = Join-Path $modeRoot 'app'
function Get-UserPath {
    return [string](Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}
function Test-OnUserPath {
    param([string]$Directory)
    return @((Get-UserPath) -split ';' | Where-Object { $_.TrimEnd('\') -ieq $Directory.TrimEnd('\') }).Count -gt 0
}
function Invoke-ModeInstall {
    # The installer's JSON result; the Python check's version line precedes it on the output.
    param([hashtable]$Extra = @{})
    $output = @(& $installer -SourcePath $package -InstallRoot $modeRoot -McpConfigPath $modeMcp -NoLaunch @Extra)
    return @($output | Where-Object { "$_".TrimStart().StartsWith('{') })[-1] | ConvertFrom-Json
}
function Get-ResolvedMode {
    return (& $node (Join-Path $modeApp 'server\mode.js') | ConvertFrom-Json).mode
}
function Get-SshExample {
    # The commented drive-it-ssh entry a dev install adds to mcp.json, or $null.
    $property = (Get-Content -LiteralPath $modeMcp -Raw | ConvertFrom-Json).PSObject.Properties['//drive-it-ssh']
    if ($null -eq $property) { return $null }
    return $property.Value
}

$standard = Invoke-ModeInstall
$env:DRIVE_IT_DATA_DIR = $modeRoot
Assert-InstallerTest ($standard.mode -eq 'standard') "A default install reported mode [$($standard.mode)]."
Assert-InstallerTest ((Get-Content -LiteralPath $userModeFile -Raw | ConvertFrom-Json).mode -eq 'standard') 'A default install did not record standard.'
Assert-InstallerTest (-not [IO.File]::Exists($marker)) 'A standard install left an admin marker.'
Assert-InstallerTest ([IO.File]::Exists((Join-Path $modeApp 'drive-it-stdio.cmd'))) 'A standard install has no drive-it-stdio.cmd.'
Assert-InstallerTest (-not (Test-OnUserPath $modeApp)) 'A standard install put drive-it-stdio.cmd on PATH.'
Assert-InstallerTest ((Get-DriveItWorkspace).root -eq 'C:\DriveIt\default') "A fresh install did not start in C:\DriveIt\default: [$((Get-DriveItWorkspace).root)]."
Assert-InstallerTest ((Get-ResolvedMode) -eq 'standard') 'The resolver did not say standard.'
Assert-InstallerTest ($null -eq (Get-SshExample)) 'A standard install wrote the drive-it-ssh example to mcp.json.'

$chosen = Join-Path $FixtureDirectory 'chosen'
[IO.Directory]::CreateDirectory($chosen) | Out-Null
Set-DriveItWorkspace -Root $chosen | Out-Null
$dev = Invoke-ModeInstall @{ Mode = 'dev' }
Assert-InstallerTest ($dev.mode -eq 'dev') "A dev install reported mode [$($dev.mode)]."
Assert-InstallerTest ((Get-DriveItWorkspace).root -eq $chosen) 'An upgrade replaced the chosen workspace with the default.'
Assert-InstallerTest ((Get-Content -LiteralPath $userModeFile -Raw | ConvertFrom-Json).mode -eq 'dev') 'A dev install did not record dev.'
$markerContent = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
Assert-InstallerTest ($markerContent.mode -eq 'dev' -and $markerContent.sid -eq $sid) 'The admin marker does not name this user.'
$acl = Get-Acl -LiteralPath $marker
Assert-InstallerTest ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-544') "The admin marker is owned by $($acl.Owner)."
Assert-InstallerTest ($acl.AreAccessRulesProtected) 'The admin marker inherits access rules.'
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$change = [Security.AccessControl.FileSystemRights]'Write, Delete, ChangePermissions, TakeOwnership'
$writers = @($rules | Where-Object { ($_.FileSystemRights -band $change) -ne 0 } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
Assert-InstallerTest (($writers -join ',') -eq 'S-1-5-18,S-1-5-32-544') "Not only SYSTEM and Administrators may change the admin marker: [$($writers -join ',')]."
Assert-InstallerTest (@($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-545' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read }).Count -eq 1) 'Users cannot read the admin marker.'

Assert-InstallerTest (Test-OnUserPath $modeApp) 'A dev install did not put drive-it-stdio.cmd on PATH.'
Assert-InstallerTest ((Get-ResolvedMode) -eq 'dev') 'The resolver did not say dev after a dev install.'
$sshExample = Get-SshExample
Assert-InstallerTest ($null -ne $sshExample -and $sshExample.command -eq 'ssh' -and (@($sshExample.args) -join ' ') -eq '-T <user>@<host> drive-it-stdio') 'A dev install did not add the commented drive-it-ssh example to mcp.json.'
Assert-InstallerTest ($null -eq (Get-Content -LiteralPath $modeMcp -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties['drive-it-ssh']) 'The drive-it-ssh example is a live server entry.'

$kept = Invoke-ModeInstall
Assert-InstallerTest ($kept.mode -eq 'dev') 'A repair without a mode did not keep dev.'

$invalid = $false
try {
    Invoke-ModeInstall @{ Mode = 'developer' } | Out-Null
} catch {
    $invalid = $_.Exception.Message -match "must be 'standard' or 'dev'"
}
Assert-InstallerTest $invalid 'An invalid mode did not fail with a clear error.'
Assert-InstallerTest ((Get-ResolvedMode) -eq 'dev') 'A failed install changed the mode.'

$back = Invoke-ModeInstall @{ Mode = 'standard' }
Assert-InstallerTest ($back.mode -eq 'standard') 'A standard install did not leave Dev Mode.'
Assert-InstallerTest (-not [IO.File]::Exists($marker)) 'An elevated standard install did not delete the admin marker.'
Assert-InstallerTest (-not (Test-OnUserPath $modeApp)) 'Leaving Dev Mode left drive-it-stdio.cmd on PATH.'
Assert-InstallerTest ((Get-ResolvedMode) -eq 'standard') 'The resolver did not say standard after leaving Dev Mode.'
Assert-InstallerTest ($null -eq (Get-SshExample)) 'Leaving Dev Mode left the drive-it-ssh example in mcp.json.'

# Uninstall-DriveIt.ps1 removes every year's manifest that names its own install, and no other: the
# manifests now name the mode install, so uninstalling the first install leaves them.
$uninstaller = Join-Path $package 'Uninstall-DriveIt.ps1'
& $uninstaller -InstallRoot $InstallRoot | Out-Null
foreach ($year in $revitYears) {
    Assert-InstallerTest ([IO.File]::Exists((Get-AddinPath $year))) "Uninstalling another install removed the Revit $year add-in."
}
& $uninstaller -InstallRoot $modeRoot | Out-Null
foreach ($year in $revitYears) {
    Assert-InstallerTest (-not [IO.File]::Exists((Get-AddinPath $year))) "Uninstall left the Revit $year add-in registered."
}

Write-Output 'installer tests passed'

