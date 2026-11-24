#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MsiPath,
    # The same package built with a lower ProductVersion (Build-DriveItMsi.ps1 -Version): the
    # previous release this MSI upgrades, and the downgrade this MSI must block.
    [Parameter(Mandatory)][string]$LowerMsiPath,
    [Parameter(Mandatory)][string]$LogDirectory
)

# The RST companion contract on real silent installs (rst-c companions/README.md C1-C7, and the
# companions leg of rst-c installer-bundle/ci-bundle-smoke.ps1), with the tray's command line
#   msiexec /i <msi> /qn /norestart MSIRESTARTMANAGERCONTROL=Disable
# where any exit but 0 is a failure (3010 = reboot needed):
#   - with no Revit 2026 the launch condition blocks a first install;
#   - with a stub Revit 2026 (C:\Program Files\Autodesk\Revit 2026\Revit.exe) the lower version
#     installs; this MSI upgrades it with 0 while Drive-It's own node.exe and python.exe hold
#     files in the install folder (stopped by StopDriveItProcesses, not queued for a reboot),
#     and with DriveIt.Revit.dll on disk at a higher file version than this MSI's (as
#     alpha.1/alpha.2 shipped 1.0.0.0), which must still be replaced;
#   - one product and one Settings > Apps entry remain: DisplayName 'Drive-It', DisplayVersion =
#     this MSI's ProductVersion;
#   - one .addin in Addins\2026 with Drive-It's ClientId, VendorId DSOS, Name Drive-It, and
#     nothing new under %AppData%\RST (C6);
#   - the in-place registration (MCP clients, shortcut, operator window) as before;
#   - installing the lower version over this one is blocked and changes nothing (C3);
#   - /x /qn exits 0, again with node.exe and python.exe running, and removes registrations
#     while user data is kept.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$msi = (Resolve-Path -LiteralPath $MsiPath).ProviderPath
$lowerMsi = (Resolve-Path -LiteralPath $LowerMsiPath).ProviderPath
$upgradeCode = '{6561188A-BD8D-43A9-B116-BA0894F8001B}'
$clientId = '297ec490-5eed-4e02-92c6-766c1f725deb'
$productName = 'Drive-It'
[IO.Directory]::CreateDirectory($LogDirectory) | Out-Null
$install = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt'
$app = Join-Path $install 'app'
$addinPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Autodesk\Revit\Addins\2026\DriveIt.addin'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Drive-It.lnk'
$previousShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Drive It.lnk'
$operatorExe = Join-Path $app 'operator\DriveIt.Operator.exe'
$mcpPath = Join-Path $install 'mcp.json'

function Assert-MsiTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

. (Join-Path $PSScriptRoot 'operator-self-test.ps1')

function Invoke-Msiexec {
    # The tray's command line exactly. Returns the exit code; -ExpectFailure inverts the check.
    param([string]$Operation, [string]$Package = $msi, [string]$Log, [switch]$ExpectFailure)
    $logPath = Join-Path $LogDirectory $Log
    $arguments = @($Operation, ('"' + $Package + '"'), '/qn', '/norestart', 'MSIRESTARTMANAGERCONTROL=Disable', '/l*v', ('"' + $logPath + '"'))
    Write-Host "msiexec $($arguments -join ' ')"
    # Waits on msiexec itself, never its process tree, with a hard timeout.
    $process = Start-Process -FilePath msiexec.exe -PassThru -ArgumentList $arguments
    $null = $process.Handle
    if (-not $process.WaitForExit(900000)) {
        $process | Stop-Process -Force -ErrorAction SilentlyContinue
        throw "msiexec $Operation $Package did not finish within 15 minutes; see $logPath"
    }
    $exitCode = $process.ExitCode
    Write-Host "  exit $exitCode"
    if ($ExpectFailure) {
        if ($exitCode -eq 0 -or $exitCode -eq 3010 -or $exitCode -eq 1641) {
            throw "msiexec $Operation $Package was expected to fail, but exited $exitCode; see $logPath"
        }
    } elseif ($exitCode -ne 0) {
        if ([IO.File]::Exists($logPath)) {
            Get-Content -LiteralPath $logPath -Tail 80 | Write-Host
        }
        throw "msiexec $Operation $Package exited $exitCode (the contract needs exactly 0: no failure, no reboot); see $logPath"
    }
    return $exitCode
}

function Get-ComProperty($Object, [string]$Name, [object[]]$Arguments = @()) {
    # The comma keeps an enumerable COM result (RelatedProducts' StringList) from unrolling.
    return , $Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::GetProperty, $null, $Object, $Arguments)
}

function Get-MsiProperty([string]$Package, [string]$Name) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.GetType().InvokeMember('OpenDatabase', [Reflection.BindingFlags]::InvokeMethod, $null, $installer, @($Package, 0))
    $view = $database.GetType().InvokeMember('OpenView', [Reflection.BindingFlags]::InvokeMethod, $null, $database,
        @("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$Name'"))
    $view.GetType().InvokeMember('Execute', [Reflection.BindingFlags]::InvokeMethod, $null, $view, @()) | Out-Null
    $record = $view.GetType().InvokeMember('Fetch', [Reflection.BindingFlags]::InvokeMethod, $null, $view, @())
    $value = if ($null -eq $record) { $null } else { Get-ComProperty $record 'StringData' @(1) }
    $view.GetType().InvokeMember('Close', [Reflection.BindingFlags]::InvokeMethod, $null, $view, @()) | Out-Null
    # Release the read handle on the package before msiexec opens it.
    foreach ($object in @($record, $view, $database, $installer)) {
        if ($null -ne $object) {
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($object)
        }
    }
    return $value
}

function Get-RelatedProduct {
    # Installed products with Drive-It's UpgradeCode, from Windows Installer itself.
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $list = Get-ComProperty $installer 'RelatedProducts' @($upgradeCode)
    $count = Get-ComProperty $list 'Count'
    $products = @()
    for ($index = 0; $index -lt $count; $index++) {
        $code = Get-ComProperty $list 'Item' @($index)
        $products += [pscustomobject]@{
            ProductCode = $code
            Name = Get-ComProperty $installer 'ProductInfo' @($code, 'ProductName')
            Version = Get-ComProperty $installer 'ProductInfo' @($code, 'VersionString')
        }
    }
    return , $products
}

function Get-ArpEntry {
    # Settings > Apps entries named like Drive-It (either spelling), from every Uninstall root.
    $entries = @()
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                       'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                       'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }
        foreach ($key in Get-ChildItem -LiteralPath $root) {
            $values = Get-ItemProperty -LiteralPath $key.PSPath
            $names = @($values.PSObject.Properties | ForEach-Object { $_.Name })
            if ($names -notcontains 'DisplayName' -or $values.DisplayName -notmatch '^Drive[ -]It$') {
                continue
            }
            $entries += [pscustomobject]@{
                Key = $key.Name
                DisplayName = $values.DisplayName
                DisplayVersion = if ($names -contains 'DisplayVersion') { $values.DisplayVersion } else { '' }
                SystemComponent = if ($names -contains 'SystemComponent') { [int]$values.SystemComponent } else { 0 }
            }
        }
    }
    return , $entries
}

function Start-Holder {
    # Drive-It's own runtimes running from the install folder, as an MCP client keeps them:
    # each holds its executable and DLLs open, so replacing or removing them needs them stopped.
    $holders = @(
        (Start-Process -FilePath (Join-Path $app 'runtimes\node\node.exe') -ArgumentList @('-e', '"setInterval(() => {}, 1000)"') -WindowStyle Hidden -PassThru),
        (Start-Process -FilePath (Join-Path $app 'runtimes\python\python.exe') -ArgumentList @('-I', '-c', '"import time; time.sleep(3600)"') -WindowStyle Hidden -PassThru)
    )
    Start-Sleep -Seconds 3
    foreach ($holder in $holders) {
        Assert-MsiTest (-not $holder.HasExited) "A file-holding process ($($holder.StartInfo.FileName)) exited before the test could use it."
    }
    return , $holders
}

function Assert-HoldersStopped {
    param([object[]]$Holders, [string]$When)
    foreach ($holder in $Holders) {
        if (-not $holder.HasExited) {
            $holder | Stop-Process -Force -ErrorAction SilentlyContinue
            throw "$When left Drive-It's process $($holder.Id) running."
        }
    }
}

function Assert-InstalledVersion {
    param([string]$Version, [string]$When)
    $related = Get-RelatedProduct
    Assert-MsiTest ($related.Count -eq 1) "${When}: $($related.Count) Drive-It products are installed, expected 1."
    Assert-MsiTest ($related[0].Version -eq $Version) "${When}: Windows Installer reports version $($related[0].Version), expected $Version."
    Assert-MsiTest ($related[0].Name -ceq $productName) "${When}: the installed product is named '$($related[0].Name)', expected '$productName'."
    $arp = @((Get-ArpEntry) | Where-Object { $_.SystemComponent -ne 1 })
    $arpText = ($arp | ForEach-Object { "$($_.Key) '$($_.DisplayName)' $($_.DisplayVersion)" }) -join '; '
    Assert-MsiTest ($arp.Count -eq 1) "${When}: $($arp.Count) visible Settings > Apps entries for Drive-It, expected 1 ($arpText)."
    Assert-MsiTest ($arp[0].DisplayName -ceq $productName) "${When}: Settings > Apps DisplayName is '$($arp[0].DisplayName)', expected '$productName'."
    Assert-MsiTest ($arp[0].DisplayVersion -eq $Version) "${When}: Settings > Apps DisplayVersion is '$($arp[0].DisplayVersion)', expected '$Version'."
}

function Get-RstFile {
    $rst = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'RST'
    if (-not [IO.Directory]::Exists($rst)) {
        return , @()
    }
    return , @(Get-ChildItem -LiteralPath $rst -Recurse -File -Force | ForEach-Object { $_.FullName })
}

$version = Get-MsiProperty $msi 'ProductVersion'
$lowerVersion = Get-MsiProperty $lowerMsi 'ProductVersion'
Write-Output "MSI under test: $msi ($version); lower version: $lowerMsi ($lowerVersion)"
Assert-MsiTest ([version]$lowerVersion -lt [version]$version) "The lower MSI ($lowerVersion) is not below the MSI under test ($version)."
Assert-MsiTest ((Get-RelatedProduct).Count -eq 0) 'Drive-It is already installed on this computer; the test needs a clean user.'

# Launch condition: with no Revit 2026 a first install is blocked and changes nothing.
$revitDirectory = Join-Path $env:ProgramW6432 'Autodesk\Revit 2026'
$revitExe = Join-Path $revitDirectory 'Revit.exe'
$revitUninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{7346B4A0-2600-0510-0000-705C0D862004}'
$stubRevit = $false
if (-not [IO.File]::Exists($revitExe) -and -not (Test-Path -LiteralPath $revitUninstallKey)) {
    Invoke-Msiexec -Operation '/i' -Log 'install-no-revit.log' -ExpectFailure | Out-Null
    Assert-MsiTest ((Get-RelatedProduct).Count -eq 0) 'The MSI installed without Revit 2026.'
    $noRevitLog = Get-Content -LiteralPath (Join-Path $LogDirectory 'install-no-revit.log') -Raw
    Assert-MsiTest ($noRevitLog.Contains('Drive-It needs Autodesk Revit 2026')) 'The install without Revit 2026 did not stop on the launch condition.'
    # The stub rst-c's bundle smoke uses: an empty Revit.exe in the default folder.
    [IO.Directory]::CreateDirectory($revitDirectory) | Out-Null
    [IO.File]::WriteAllText($revitExe, 'drive-it ci stub')
    $stubRevit = $true
} else {
    Write-Output 'Revit 2026 is present; skipping the no-Revit launch-condition case.'
}
$rstBefore = Get-RstFile

# Stand-in client configurations so install and uninstall register with all three clients.
$userProfile = [Environment]::GetFolderPath('UserProfile')
$claudeDesktop = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Claude\claude_desktop_config.json'
$claudeCode = Join-Path $userProfile '.claude.json'
$codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { Join-Path $userProfile '.codex' } else { $env:CODEX_HOME }
$codex = Join-Path $codexHome 'config.toml'
foreach ($file in @($claudeDesktop, $claudeCode, $codex)) {
    Assert-MsiTest (-not [IO.File]::Exists($file)) "Refusing to overwrite an existing client configuration: $file"
}
[IO.Directory]::CreateDirectory((Split-Path -Parent $claudeDesktop)) | Out-Null
[IO.Directory]::CreateDirectory($codexHome) | Out-Null
[IO.File]::WriteAllText($claudeCode, '{"numStartups":1,"mcpServers":{"other":{"type":"stdio","command":"other.exe","args":[]}}}')
[IO.File]::WriteAllText($codex, "model = `"gpt-5`"`r`n")

# The previous release, then this one over it while Drive-It's runtimes hold files open.
Invoke-Msiexec -Operation '/i' -Package $lowerMsi -Log 'install-lower.log' | Out-Null
Assert-InstalledVersion -Version $lowerVersion -When 'After installing the lower version'
# Stand in for a previous release whose add-in DLL had a higher file version: any system DLL
# with a high version will do. Without REINSTALLMODE=amus the upgrade skips the "older" new
# file, removes the old one with the old version, and fails with nothing installed.
$revitDll = Join-Path $app 'addin\DriveIt.Revit.dll'
$packagedHash = (Get-FileHash -LiteralPath $revitDll -Algorithm SHA256).Hash
Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\msi.dll') -Destination $revitDll -Force
$higher = [Diagnostics.FileVersionInfo]::GetVersionInfo($revitDll)
Assert-MsiTest ($higher.FileMajorPart -ge 1) "The stand-in DLL has file version $($higher.FileVersion), expected 1.0 or higher."
$holders = Start-Holder
Invoke-Msiexec -Operation '/i' -Log 'upgrade.log' | Out-Null
Assert-HoldersStopped -Holders $holders -When 'The upgrade'
Assert-InstalledVersion -Version $version -When 'After the upgrade'
Assert-MsiTest ([IO.File]::Exists($revitDll) -and (Get-FileHash -LiteralPath $revitDll -Algorithm SHA256).Hash -eq $packagedHash) 'The upgrade did not replace a DriveIt.Revit.dll that had a higher file version.'

$node = Join-Path $app 'runtimes\node\node.exe'
$python = Join-Path $app 'runtimes\python\python.exe'
$server = Join-Path $app 'server\index.js'
Assert-MsiTest ([IO.File]::Exists($node)) 'The MSI did not install private Node.js.'
Assert-MsiTest ([IO.File]::Exists($python)) 'The MSI did not install private Python.'

# C6: one manifest carrying Drive-It's ClientId in Addins\2026, and nothing under %AppData%\RST.
$addinDirectory = Split-Path -Parent $addinPath
$withClientId = @(Get-ChildItem -LiteralPath $addinDirectory -Filter '*.addin' -File | Where-Object {
    (Get-Content -LiteralPath $_.FullName -Raw) -match [regex]::Escape($clientId)
})
Assert-MsiTest ($withClientId.Count -eq 1 -and $withClientId[0].Name -eq 'DriveIt.addin') "Addins\2026 holds $($withClientId.Count) manifests with ClientId $clientId, expected DriveIt.addin alone."
$manifest = ([xml](Get-Content -LiteralPath $addinPath -Raw)).RevitAddIns.AddIn
$manifestIdNode = $manifest.SelectSingleNode('ClientId')
if ($null -eq $manifestIdNode) {
    $manifestIdNode = $manifest.SelectSingleNode('AddInId')
}
$manifestId = if ($null -eq $manifestIdNode) { '' } else { $manifestIdNode.InnerText.Trim() }
Assert-MsiTest ($manifestId -eq $clientId) "The add-in ClientId is '$manifestId', expected $clientId."
Assert-MsiTest ($manifest.VendorId -eq 'DSOS') "The add-in VendorId is '$($manifest.VendorId)', expected DSOS."
$manifestName = $manifest.SelectSingleNode('Name').InnerText
Assert-MsiTest ($manifestName -ceq $productName) "The add-in is named '$manifestName', expected '$productName'."
$rstNew = @((Get-RstFile) | Where-Object { $rstBefore -notcontains $_ })
Assert-MsiTest ($rstNew.Count -eq 0) ("The install wrote under %AppData%\RST:`n" + ($rstNew -join "`n"))

$addin = [xml](Get-Content -LiteralPath $addinPath -Raw)
Assert-MsiTest ($addin.RevitAddIns.AddIn.Assembly -eq (Join-Path $app 'addin\DriveIt.Revit.dll')) 'The add-in manifest does not point at the MSI install.'
$configuration = Get-Content -LiteralPath $mcpPath -Raw | ConvertFrom-Json
Assert-MsiTest ($configuration.mcpServers.'drive-it'.command -eq $node) 'MCP configuration does not use the installed private Node.js.'
Assert-MsiTest ($configuration.mcpServers.'drive-it'.args[0] -eq $server) 'MCP configuration does not use the installed server.'
Assert-MsiTest ($configuration.mcpServers.'drive-it'.env.DRIVE_IT_PYTHON -eq $python) 'MCP configuration does not use the installed private Python.'
Assert-MsiTest ([IO.File]::Exists($shortcutPath)) 'The operator shortcut was not created.'
Assert-MsiTest ((New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath).TargetPath -eq $operatorExe) 'The shortcut does not open the operator window.'
# The window finds the install's Node.js, operator.js, and data directory from its own folder and mcp.json.
$selfTest = Invoke-OperatorSelfTest -Exe $operatorExe -Report (Join-Path $LogDirectory 'operator-self-test.json')
# Standard (spec #10 "Visibility"): no Dev Mode banner, and the outside-root requests pane is shown.
# msi-mode.Tests.ps1 holds the Dev Mode case.
foreach ($window in @($selfTest.windows)) {
    Assert-MsiTest ($window.mode -eq 'standard' -and -not $window.devModeBanner -and $window.requestsShown) "The standard install's window is not in standard mode: $($window | ConvertTo-Json -Compress)"
}
Assert-MsiTest (-not (Get-ChildItem -LiteralPath $install -Filter '.staging-*' -Force)) 'The in-place registration left a staging directory.'

Assert-MsiTest ((Get-Content -LiteralPath $claudeDesktop -Raw | ConvertFrom-Json).mcpServers.'drive-it'.command -eq $node) 'Claude Desktop was not registered.'
$codeConfig = Get-Content -LiteralPath $claudeCode -Raw | ConvertFrom-Json
Assert-MsiTest ($codeConfig.mcpServers.'drive-it'.type -eq 'stdio' -and $codeConfig.mcpServers.'drive-it'.command -eq $node) 'Claude Code was not registered.'
Assert-MsiTest ($codeConfig.mcpServers.other.command -eq 'other.exe') 'Claude Code lost another MCP server.'
$codexText = Get-Content -LiteralPath $codex -Raw
Assert-MsiTest ($codexText.Contains('[mcp_servers.drive-it]') -and $codexText.Contains($node.Replace('\', '\\'))) 'Codex was not registered.'

# C3: the lower version over this one is blocked and changes nothing.
Invoke-Msiexec -Operation '/i' -Package $lowerMsi -Log 'downgrade.log' -ExpectFailure | Out-Null
Assert-MsiTest ((Get-Content -LiteralPath (Join-Path $LogDirectory 'downgrade.log') -Raw).Contains('A newer version of Drive-It is already installed')) 'The downgrade was not blocked by the downgrade check.'
Assert-InstalledVersion -Version $version -When 'After the blocked downgrade'
Assert-MsiTest ([IO.File]::Exists($addinPath)) 'The blocked downgrade removed the add-in registration.'

$userData = Join-Path $install 'user-data.sentinel'
[IO.File]::WriteAllText($userData, 'keep')
# An earlier build's shortcut is removed by uninstall as well.
[IO.File]::WriteAllText($previousShortcut, 'stale')

$holders = Start-Holder
Invoke-Msiexec -Operation '/x' -Log 'uninstall.log' | Out-Null
Assert-HoldersStopped -Holders $holders -When 'The uninstall'

Assert-MsiTest ((Get-RelatedProduct).Count -eq 0) 'The product is still installed after uninstall.'
Assert-MsiTest ((Get-ArpEntry).Count -eq 0) 'The product is still in Settings > Apps after uninstall.'
Assert-MsiTest (-not [IO.File]::Exists($server)) 'Uninstall left the MCP server behind.'
Assert-MsiTest (-not [IO.File]::Exists($node)) 'Uninstall left private Node.js behind.'
Assert-MsiTest (-not [IO.File]::Exists($addinPath)) 'Uninstall left the Revit add-in registered.'
Assert-MsiTest (-not [IO.File]::Exists($shortcutPath)) 'Uninstall left the operator shortcut.'
Assert-MsiTest (-not [IO.File]::Exists($previousShortcut)) 'Uninstall left the earlier operator shortcut.'
Assert-MsiTest (-not [IO.File]::Exists($mcpPath)) 'Uninstall left the Drive It MCP configuration.'
Assert-MsiTest ([IO.File]::Exists($userData)) 'Uninstall removed user data.'
Assert-MsiTest ($null -eq (Get-Content -LiteralPath $claudeDesktop -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties['drive-it']) 'Uninstall left Drive It in Claude Desktop.'
$codeConfig = Get-Content -LiteralPath $claudeCode -Raw | ConvertFrom-Json
Assert-MsiTest ($null -eq $codeConfig.mcpServers.PSObject.Properties['drive-it']) 'Uninstall left Drive It in Claude Code.'
Assert-MsiTest ($codeConfig.mcpServers.other.command -eq 'other.exe' -and $codeConfig.numStartups -eq 1) 'Uninstall changed other Claude Code settings.'
Assert-MsiTest ((Get-Content -LiteralPath $codex -Raw) -eq "model = `"gpt-5`"`r`n") 'Uninstall did not restore the Codex configuration.'
if ([IO.Directory]::Exists($app)) {
    $leftovers = Get-ChildItem -LiteralPath $app -Recurse -File -Force | Select-Object -First 20 -ExpandProperty FullName
    Assert-MsiTest (-not $leftovers) ("Uninstall left application files:`n" + ($leftovers -join "`n"))
}

if ($stubRevit) {
    Remove-Item -LiteralPath $revitDirectory -Recurse -Force
}

Write-Output 'msi tests passed'
