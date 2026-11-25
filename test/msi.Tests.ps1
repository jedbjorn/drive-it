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
#   - with no supported Revit the launch condition blocks a first install, naming 2026 and 2027;
#   - with a stub Revit 2026 alone, then a stub Revit 2027 alone (C:\Program Files\Autodesk\
#     Revit <year>\Revit.exe), the MSI installs with 0 and registers BOTH years' add-ins (spec #22
#     "Install Rule": a Revit added later finds Drive-It), and /x removes both;
#   - with both stubs the lower version installs; this MSI upgrades it with 0 while Drive-It's own
#     node.exe and python.exe hold
#     files in the install folder (stopped by StopDriveItProcesses, not queued for a reboot),
#     and with DriveIt.Revit.dll on disk at a higher file version than this MSI's (as
#     alpha.1/alpha.2 shipped 1.0.0.0), which must still be replaced;
#   - one product and one Settings > Apps entry remain: DisplayName 'Drive-It', DisplayVersion =
#     this MSI's ProductVersion;
#   - in Addins\2026 and in Addins\2027, one .addin with Drive-It's ClientId, VendorId DSOS,
#     Name Drive-It, naming that year's build (app\addin\<year>), and nothing new under
#     %AppData%\RST (C6);
#   - the in-place registration (MCP clients, shortcut, operator window) as before;
#   - installing the lower version over this one is blocked and changes nothing (C3);
#   - /x /qn exits 0, again with node.exe and python.exe running, and removes registrations
#     (both years' add-ins) while user data is kept.
# A real Revit on the computer is never hidden: a case that needs that year absent is skipped.
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
# The supported Revit years (installer/Build-DriveItPackage.ps1); this test names them itself.
$revitYears = @('2026', '2027')
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

function Get-AddinPath([string]$Year) {
    return Join-Path ([Environment]::GetFolderPath('ApplicationData')) "Autodesk\Revit\Addins\$Year\DriveIt.addin"
}

function Assert-AddinsRegistered {
    # C6 for every supported year: Addins\<year> holds DriveIt.addin alone with Drive-It's
    # ClientId, VendorId DSOS and Name Drive-It, naming that year's build in the MSI install.
    param([string]$When)
    foreach ($year in $revitYears) {
        $addinPath = Get-AddinPath $year
        Assert-MsiTest ([IO.File]::Exists($addinPath)) "${When}: Addins\$year has no DriveIt.addin."
        $withClientId = @(Get-ChildItem -LiteralPath (Split-Path -Parent $addinPath) -Filter '*.addin' -File | Where-Object {
            (Get-Content -LiteralPath $_.FullName -Raw) -match [regex]::Escape($clientId)
        })
        Assert-MsiTest ($withClientId.Count -eq 1 -and $withClientId[0].Name -eq 'DriveIt.addin') "${When}: Addins\$year holds $($withClientId.Count) manifests with ClientId $clientId, expected DriveIt.addin alone."
        $manifest = ([xml](Get-Content -LiteralPath $addinPath -Raw)).RevitAddIns.AddIn
        $manifestIdNode = $manifest.SelectSingleNode('ClientId')
        if ($null -eq $manifestIdNode) {
            $manifestIdNode = $manifest.SelectSingleNode('AddInId')
        }
        $manifestId = if ($null -eq $manifestIdNode) { '' } else { $manifestIdNode.InnerText.Trim() }
        Assert-MsiTest ($manifestId -eq $clientId) "${When}: the Revit $year add-in ClientId is '$manifestId', expected $clientId."
        Assert-MsiTest ($manifest.VendorId -eq 'DSOS') "${When}: the Revit $year add-in VendorId is '$($manifest.VendorId)', expected DSOS."
        $manifestName = $manifest.SelectSingleNode('Name').InnerText
        Assert-MsiTest ($manifestName -ceq $productName) "${When}: the Revit $year add-in is named '$manifestName', expected '$productName'."
        $assembly = Join-Path $app "addin\$year\DriveIt.Revit.dll"
        Assert-MsiTest ($manifest.Assembly -eq $assembly) "${When}: Addins\$year\DriveIt.addin names '$($manifest.Assembly)', expected the MSI install's $year build $assembly."
        Assert-MsiTest ([IO.File]::Exists($assembly)) "${When}: the Revit $year build is not installed: $assembly."
    }
}

function Assert-AddinsRemoved {
    param([string]$When)
    foreach ($year in $revitYears) {
        Assert-MsiTest (-not [IO.File]::Exists((Get-AddinPath $year))) "${When}: the Revit $year add-in is still registered."
    }
}

function Get-RevitDirectory([string]$Year) {
    return Join-Path $env:ProgramW6432 "Autodesk\Revit $Year"
}

function Test-RevitInstalled([string]$Year) {
    # A real Revit: Revit.exe in the default folder, or its uninstall entry (the MSI's two searches).
    $uninstallKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{7346B4A0-$($Year.Substring(2))00-0510-0000-705C0D862004}"
    return [IO.File]::Exists((Join-Path (Get-RevitDirectory $Year) 'Revit.exe')) -or (Test-Path -LiteralPath $uninstallKey)
}

$script:stubs = @()
function Set-StubRevit {
    # Exactly these years present: the stub rst-c's bundle smoke uses (an empty Revit.exe in the
    # default folder) for each one not really installed, and this test's other stubs removed.
    param([string[]]$Years = @())
    foreach ($year in $revitYears) {
        $directory = Get-RevitDirectory $year
        $exe = Join-Path $directory 'Revit.exe'
        if ($Years -contains $year) {
            if ($realRevit -notcontains $year -and $script:stubs -notcontains $year) {
                [IO.Directory]::CreateDirectory($directory) | Out-Null
                [IO.File]::WriteAllText($exe, 'drive-it ci stub')
                $script:stubs += $year
            }
        } elseif ($script:stubs -contains $year) {
            Remove-Item -LiteralPath $exe -Force
            if (-not (Get-ChildItem -LiteralPath $directory -Force)) {
                Remove-Item -LiteralPath $directory -Force
            }
            $script:stubs = @($script:stubs | Where-Object { $_ -ne $year })
        }
    }
}

function Test-CaseRunnable([string[]]$Years = @()) {
    # A case can run when no Revit outside it is really installed.
    return @($realRevit | Where-Object { $Years -notcontains $_ }).Count -eq 0
}

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

$realRevit = @($revitYears | Where-Object { Test-RevitInstalled $_ })
if ($realRevit.Count) {
    Write-Output "Revit $($realRevit -join ' and ') is installed here; cases that need it absent are skipped."
}

# Neither: the launch condition blocks a first install, changes nothing, and names both years.
if (Test-CaseRunnable) {
    Set-StubRevit
    Invoke-Msiexec -Operation '/i' -Log 'install-no-revit.log' -ExpectFailure | Out-Null
    Assert-MsiTest ((Get-RelatedProduct).Count -eq 0) 'The MSI installed without Revit 2026 or 2027.'
    $noRevitLog = Get-Content -LiteralPath (Join-Path $LogDirectory 'install-no-revit.log') -Raw
    Assert-MsiTest ($noRevitLog.Contains('Drive-It needs Autodesk Revit 2026 or 2027')) 'The install without Revit 2026 or 2027 did not stop on the launch condition naming both.'
} else {
    Write-Output 'Skipping the no-Revit launch-condition case.'
}

# One year alone: the install succeeds and registers every year's add-in; uninstall removes them all.
foreach ($year in $revitYears) {
    if (-not (Test-CaseRunnable @($year))) {
        Write-Output "Skipping the Revit $year-only case."
        continue
    }
    Set-StubRevit @($year)
    Invoke-Msiexec -Operation '/i' -Log "install-$year-only.log" | Out-Null
    Assert-InstalledVersion -Version $version -When "After installing with Revit $year alone"
    Assert-AddinsRegistered -When "After installing with Revit $year alone"
    Invoke-Msiexec -Operation '/x' -Log "uninstall-$year-only.log" | Out-Null
    Assert-MsiTest ((Get-RelatedProduct).Count -eq 0) "After the Revit $year-only uninstall the product is still installed."
    Assert-AddinsRemoved -When "After the Revit $year-only uninstall"
}

# Both: the full cycle below (upgrade, the in-place registration, blocked downgrade, uninstall).
Set-StubRevit $revitYears
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
$revitDll = Join-Path $app 'addin\2026\DriveIt.Revit.dll'
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

# C6: one manifest carrying Drive-It's ClientId per supported year, and nothing under %AppData%\RST.
Assert-AddinsRegistered -When 'After the upgrade'
$rstNew = @((Get-RstFile) | Where-Object { $rstBefore -notcontains $_ })
Assert-MsiTest ($rstNew.Count -eq 0) ("The install wrote under %AppData%\RST:`n" + ($rstNew -join "`n"))

$configuration = Get-Content -LiteralPath $mcpPath -Raw | ConvertFrom-Json
Assert-MsiTest ($configuration.mcpServers.'drive-it'.command -eq $node) 'MCP configuration does not use the installed private Node.js.'
Assert-MsiTest ($configuration.mcpServers.'drive-it'.args[0] -eq $server) 'MCP configuration does not use the installed server.'
Assert-MsiTest ($configuration.mcpServers.'drive-it'.env.DRIVE_IT_PYTHON -eq $python) 'MCP configuration does not use the installed private Python.'
Assert-MsiTest ([IO.File]::Exists($shortcutPath)) 'The operator shortcut was not created.'
Assert-MsiTest ((New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath).TargetPath -eq $operatorExe) 'The shortcut does not open the operator window.'
# The window finds the install's Node.js, operator.js, and data directory from its own folder and mcp.json.
# Spec #23 AC-10 and AC-11 against the stand-ins: Claude Desktop as if installed after Drive-It (its
# file without the entry, with a setting of its own). Detect agents adds it back in the first theme;
# the second theme's run, and Claude Code and Codex already registered by the install, change nothing.
$desktopWithout = '{"preferences":{"keep":true},"mcpServers":{}}'
[IO.File]::WriteAllText($claudeDesktop, $desktopWithout)
$codeBefore = [IO.File]::ReadAllText($claudeCode)
$codexBefore = [IO.File]::ReadAllText($codex)
$selfTest = Invoke-OperatorSelfTest -Exe $operatorExe -Report (Join-Path $LogDirectory 'operator-self-test.json') -Screenshots (Join-Path $LogDirectory 'window-screens\standard') -DetectAgents
$windows = @($selfTest.windows)
$agents = [ordered]@{}
foreach ($client in @('claude-desktop', 'claude-code', 'codex')) {
    $agents[$client] = (@($windows | ForEach-Object { (Get-OperatorAgentStatus -Window $_ -Client $client) -join ',' }) -join ' then ')
}
Assert-MsiTest ($agents['claude-desktop'] -eq 'added then already' -and $agents['claude-code'] -eq 'already then already' -and $agents['codex'] -eq 'already then already') "Detect agents reported $($agents | ConvertTo-Json -Compress)."
Assert-MsiTest ((@($windows[0].agents.results) | Where-Object { $_.client -eq 'claude-desktop' }).message -match 'Restart Claude Desktop') 'Detect agents did not say to restart Claude Desktop.'
$desktopAfter = Get-Content -LiteralPath $claudeDesktop -Raw | ConvertFrom-Json
Assert-MsiTest ($desktopAfter.preferences.keep -eq $true -and [IO.File]::ReadAllText("$claudeDesktop.drive-it.bak") -eq $desktopWithout) 'Detect agents lost a Claude Desktop setting or wrote no backup.'
Assert-MsiTest ([IO.File]::ReadAllText($claudeCode) -eq $codeBefore -and [IO.File]::ReadAllText($codex) -eq $codexBefore) 'Detect agents changed a client that was already set up.'
# Standard (spec #10 "Visibility"): no Dev Mode banner, and the outside-root requests pane is shown.
# msi-mode.Tests.ps1 holds the Dev Mode case.
foreach ($window in @($selfTest.windows)) {
    Assert-MsiTest ($window.mode -eq 'standard' -and -not $window.devModeBanner -and $window.requestsShown) "The standard install's window is not in standard mode: $($window | ConvertTo-Json -Compress)"
}
# Spec #13 AC-18: the Require dry run switch and Staged Actions mode in a standard install, against a throwaway data
# directory so the install's own settings and history stay untouched; screenshots beside the window's.
$stagedData = Join-Path $LogDirectory 'staged-data-standard'
[IO.Directory]::CreateDirectory($stagedData) | Out-Null
$savedData = $env:DRIVE_IT_DATA_DIR
$env:DRIVE_IT_DATA_DIR = $stagedData
try {
    Invoke-OperatorSelfTest -Exe $operatorExe -Report (Join-Path $LogDirectory 'operator-self-test-staged-standard.json') -Screenshots (Join-Path $LogDirectory 'window-screens\standard') -StagedActions | Out-Null
} finally {
    $env:DRIVE_IT_DATA_DIR = $savedData
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
Assert-AddinsRegistered -When 'After the blocked downgrade'

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
Assert-AddinsRemoved -When 'After uninstall'
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

Set-StubRevit

Write-Output 'msi tests passed'
