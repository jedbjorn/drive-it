#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MsiPath,
    # The same package at a lower ProductVersion (Build-DriveItMsi.ps1 -Version), so the install
    # below is a real MajorUpgrade that runs RemoveExistingProducts.
    [Parameter(Mandatory)][string]$LowerMsiPath,
    [Parameter(Mandatory)][string]$LogDirectory
)

# Install mode across a version upgrade (spec #10 "Mode Selection", AC-3): a refused upgrade
# leaves the existing install unchanged. The removal of an older version (RemoveExistingProducts)
# commits on its own, so the refusal must come first: CheckDriveItMode, before InstallValidate.
# Run elevated (the CI runner), on a clean user:
#   - the lower version installs in Dev Mode;
#   - this MSI over it with an invalid DRIVEIT_MODE fails in CheckDriveItMode, never reaches
#     RemoveExistingProducts, and the lower version, its app files, add-in, mcp.json, user mode
#     file and admin marker are exactly as before;
#   - this MSI over it with no mode upgrades and keeps Dev Mode; /x removes it.
# The unelevated refusals (recorded dev, DRIVEIT_MODE=dev) need a limited token, which the
# runner cannot give msiexec; the same action refuses them, proven live on W10C.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$msi = (Resolve-Path -LiteralPath $MsiPath).ProviderPath
$lowerMsi = (Resolve-Path -LiteralPath $LowerMsiPath).ProviderPath
$upgradeCode = '{6561188A-BD8D-43A9-B116-BA0894F8001B}'
[IO.Directory]::CreateDirectory($LogDirectory) | Out-Null
$install = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt'
$app = Join-Path $install 'app'
$addinPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Autodesk\Revit\Addins\2026\DriveIt.addin'
$userModeFile = Join-Path $install 'install-mode.json'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$marker = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) "DriveIt\dev-mode\$sid.json"

function Assert-ModeTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-Msiexec {
    # The tray's command line plus any properties. Returns the exit code.
    param([string]$Operation, [string]$Package, [string]$Log, [string[]]$Property = @())
    $logPath = Join-Path $LogDirectory $Log
    $arguments = @($Operation, ('"' + $Package + '"'), '/qn', '/norestart', 'MSIRESTARTMANAGERCONTROL=Disable') + $Property + @('/l*v', ('"' + $logPath + '"'))
    Write-Host "msiexec $($arguments -join ' ')"
    $process = Start-Process -FilePath msiexec.exe -PassThru -ArgumentList $arguments
    $null = $process.Handle
    if (-not $process.WaitForExit(900000)) {
        $process | Stop-Process -Force -ErrorAction SilentlyContinue
        throw "msiexec $Operation $Package did not finish within 15 minutes; see $logPath"
    }
    Write-Host "  exit $($process.ExitCode)"
    return $process.ExitCode
}

function Get-RelatedProduct {
    # "<ProductCode> <version>" for each installed product with Drive-It's UpgradeCode.
    $get = [Reflection.BindingFlags]::GetProperty
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $list = $installer.GetType().InvokeMember('RelatedProducts', $get, $null, $installer, @($upgradeCode))
    $count = $list.GetType().InvokeMember('Count', $get, $null, $list, @())
    $products = @()
    for ($index = 0; $index -lt $count; $index++) {
        $code = $list.GetType().InvokeMember('Item', $get, $null, $list, @($index))
        $version = $installer.GetType().InvokeMember('ProductInfo', $get, $null, $installer, @($code, 'VersionString'))
        $products += "$code $version"
    }
    return , $products
}

function Get-InstallState {
    # Everything a refused upgrade must leave as it was, one line per item.
    $lines = @(Get-RelatedProduct | ForEach-Object { "product $_" })
    foreach ($file in @(Get-ChildItem -LiteralPath $app -Recurse -File -Force | Sort-Object FullName)) {
        $lines += "app $($file.FullName.Substring($app.Length)) $((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
    }
    foreach ($file in @($addinPath, (Join-Path $install 'mcp.json'), $userModeFile, $marker)) {
        $hash = if ([IO.File]::Exists($file)) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash } else { 'missing' }
        $lines += "file $file $hash"
    }
    $owner = if ([IO.File]::Exists($marker)) { (Get-Acl -LiteralPath $marker).GetOwner([Security.Principal.SecurityIdentifier]).Value } else { 'none' }
    $lines += "marker owner $owner"
    return , $lines
}

function Get-ResolvedMode {
    $output = & (Join-Path $app 'runtimes\node\node.exe') (Join-Path $app 'server\mode.js')
    return ($output | Out-String | ConvertFrom-Json).mode
}

Assert-ModeTest ((Get-RelatedProduct).Count -eq 0) 'Drive-It is already installed on this computer; the test needs a clean user.'

# A first install needs Revit 2026: the same stub as msi.Tests.ps1 when it is absent.
$revitDirectory = Join-Path $env:ProgramW6432 'Autodesk\Revit 2026'
$revitExe = Join-Path $revitDirectory 'Revit.exe'
$stubRevit = -not [IO.File]::Exists($revitExe)
if ($stubRevit) {
    [IO.Directory]::CreateDirectory($revitDirectory) | Out-Null
    [IO.File]::WriteAllText($revitExe, 'drive-it ci stub')
}

try {
    Assert-ModeTest ((Invoke-Msiexec -Operation '/i' -Package $lowerMsi -Log 'mode-lower-dev.log' -Property @('DRIVEIT_MODE=dev')) -eq 0) 'The lower version did not install in Dev Mode.'
    $lower = Get-RelatedProduct
    Assert-ModeTest ($lower.Count -eq 1) "After the lower install, $($lower.Count) Drive-It products are installed, expected 1."
    Assert-ModeTest ((Get-ResolvedMode) -eq 'dev') 'The lower version did not resolve Dev Mode.'
    $before = Get-InstallState

    # Refused upgrade: case-sensitive, so 'Dev' is invalid.
    $code = Invoke-Msiexec -Operation '/i' -Package $msi -Log 'mode-upgrade-invalid.log' -Property @('DRIVEIT_MODE=Dev')
    Assert-ModeTest ($code -ne 0 -and $code -ne 3010 -and $code -ne 1641) "The upgrade with DRIVEIT_MODE=Dev was expected to fail, but exited $code."
    $log = Get-Content -LiteralPath (Join-Path $LogDirectory 'mode-upgrade-invalid.log') -Raw
    Assert-ModeTest ($log.Contains("must be 'standard' or 'dev', not 'Dev'")) 'The refused upgrade did not fail on the invalid mode.'
    Assert-ModeTest ($log -match 'Action start [^\r\n]*: CheckDriveItMode\.') 'The refused upgrade did not run CheckDriveItMode.'
    Assert-ModeTest ($log -notmatch 'Action start [^\r\n]*: (RemoveExistingProducts|InstallValidate)\.') 'The refused upgrade reached InstallValidate or RemoveExistingProducts.'
    $after = Get-InstallState
    $changed = @(Compare-Object -ReferenceObject $before -DifferenceObject $after | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" })
    Assert-ModeTest ($changed.Count -eq 0) ("The refused upgrade changed the existing install:`n" + (($changed | Select-Object -First 20) -join "`n"))
    Assert-ModeTest ((Get-ResolvedMode) -eq 'dev') 'After the refused upgrade the install no longer resolves Dev Mode.'

    # Elevated upgrade with no mode keeps the recorded Dev Mode.
    Assert-ModeTest ((Invoke-Msiexec -Operation '/i' -Package $msi -Log 'mode-upgrade-dev.log') -eq 0) 'The elevated upgrade of a Dev Mode install failed.'
    $log = Get-Content -LiteralPath (Join-Path $LogDirectory 'mode-upgrade-dev.log') -Raw
    Assert-ModeTest ($log -match 'Drive-It mode check: dev \(recorded\),[^\r\n]*elevated administrator True') 'CheckDriveItMode did not read the recorded Dev Mode from the installed version.'
    $upgraded = Get-RelatedProduct
    Assert-ModeTest ($upgraded.Count -eq 1 -and $upgraded[0] -ne $lower[0]) "The upgrade did not replace the lower version: $($upgraded -join '; ')."
    Assert-ModeTest ((Get-ResolvedMode) -eq 'dev' -and [IO.File]::Exists($marker)) 'The elevated upgrade did not keep Dev Mode.'

    Assert-ModeTest ((Invoke-Msiexec -Operation '/x' -Package $msi -Log 'mode-uninstall.log') -eq 0) 'The uninstall failed.'
    Assert-ModeTest ((Get-RelatedProduct).Count -eq 0) 'The product is still installed after uninstall.'
} finally {
    if ($stubRevit) {
        Remove-Item -LiteralPath $revitDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'msi mode tests passed'
