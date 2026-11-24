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

# Stop this install's own processes (an MCP client's node.exe and its python.exe worker, an open
# DriveIt.Operator.exe window) so their files can be removed without a reboot. The MSI does the
# same earlier, before InstallValidate (installer/Stop-DriveItProcesses.ps1); this covers script
# installs. Revit is never stopped.
$appPrefix = $app.TrimEnd('\') + '\'
$own = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($appPrefix, [StringComparison]::OrdinalIgnoreCase)
})
foreach ($process in $own) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
foreach ($process in $own) {
    Wait-Process -Id $process.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
}

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

# Every Revit year's DriveIt.addin that names this install's add-in (app\addin\<year>, or app\addin
# from builds before Revit 2027 support); a manifest pointing elsewhere is not ours to remove.
$addinPrefix = (Join-Path $app 'addin').TrimEnd('\') + '\'
$addins = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Autodesk\Revit\Addins'
if ([IO.Directory]::Exists($addins)) {
    foreach ($addinPath in @(Get-ChildItem -LiteralPath $addins -Directory | ForEach-Object { Join-Path $_.FullName 'DriveIt.addin' })) {
        if (-not [IO.File]::Exists($addinPath)) {
            continue
        }
        $assembly = [string]([xml](Get-Content -LiteralPath $addinPath -Raw)).RevitAddIns.AddIn.Assembly
        if ($assembly.StartsWith($addinPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $addinPath -Force
        }
    }
}

# 'Drive-It.lnk' opens the WPF window; 'Drive It.lnk' is the PowerShell window's shortcut from earlier builds.
foreach ($shortcutName in @('Drive-It.lnk', 'Drive It.lnk')) {
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName
    if ([IO.File]::Exists($shortcutPath)) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
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

# The install mode (spec #10): drop the launcher folder from the user's PATH and the user mode file,
# so a later fresh install starts standard; an elevated uninstall also deletes this user's admin
# marker. An unelevated one leaves the marker, which does nothing without the user file.
try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($null -ne $key) {
        try {
            $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $entries = @($current -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $app.TrimEnd('\') })
            $next = $entries -join ';'
            if ($next -cne $current) {
                $key.SetValue('Path', $next, $key.GetValueKind('Path'))
            }
        } finally {
            $key.Dispose()
        }
    }
    $userModeFile = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt\install-mode.json'
    if ([IO.File]::Exists($userModeFile)) {
        Remove-Item -LiteralPath $userModeFile -Force
    }
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $marker = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) "DriveIt\dev-mode\$sid.json"
        if ([IO.File]::Exists($marker)) {
            Remove-Item -LiteralPath $marker -Force
        }
    }
} catch {
    Write-Warning "Drive-It could not clear its install mode: $($_.Exception.Message)"
}

# The installer provisions .NET into the app directory only when no machine runtime exists.
$privateDotnet = Join-Path $app 'runtimes\dotnet'
if ([IO.Directory]::Exists($privateDotnet)) {
    Remove-Item -LiteralPath $privateDotnet -Recurse -Force
}
