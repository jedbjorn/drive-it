#requires -Version 7.3
[CmdletBinding()]
param(
    [string]$PackagePath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'artifacts\DriveIt-alpha'),
    [string]$OutputPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'artifacts\DriveIt-alpha.msi'),
    # MSI ProductVersion, numeric major.minor.patch. Default: package.json's version with any
    # prerelease suffix dropped. CI passes another one to build the lower-version MSI that
    # test/msi.Tests.ps1 upgrades from and tries to downgrade to.
    [string]$Version
)

# Wraps the package from Build-DriveItPackage.ps1 in a per-user MSI (signed afterwards on a tag
# release, see .github/workflows/_build.yml).
# WiX v5 is pinned: v6+ falls under the Open Source Maintenance Fee terms.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

$wixVersion = '5.0.2'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
$package = (Resolve-Path -LiteralPath $PackagePath).ProviderPath
if (-not [IO.File]::Exists((Join-Path $package 'drive-it-package.json'))) {
    throw "Not a Drive It installer package: $package"
}

$installed = & dotnet tool list --global | Select-String -Pattern "^wix\s+$([regex]::Escape($wixVersion))\s"
if ($null -eq $installed) {
    & dotnet tool update --global wix --version $wixVersion
}
$wix = Join-Path $HOME '.dotnet\tools\wix.exe'
& $wix extension add -g "WixToolset.Util.wixext/$wixVersion"

# MSI ProductVersion is numeric major.minor.build (at most 255.255.65535); a prerelease suffix is dropped.
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = ((Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json).version) -replace '-.*$', ''
}
$match = [regex]::Match($Version, '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
if (-not $match.Success -or [int64]$match.Groups[1].Value -gt 255 -or [int64]$match.Groups[2].Value -gt 255 -or [int64]$match.Groups[3].Value -gt 65535) {
    throw "MSI ProductVersion '$Version' is not a numeric major.minor.patch within 255.255.65535."
}

# The MSI runs Stop-DriveItProcesses.ps1 and Test-DriveItModeGate.ps1 before InstallValidate, when
# the install folder may still hold an older version without them, so they travel inside the MSI
# as encoded commands.
function ConvertTo-EncodedScript([string]$Name) {
    $lines = Get-Content -LiteralPath (Join-Path $PSScriptRoot $Name) |
        Where-Object { $_.Trim() -and -not $_.TrimStart().StartsWith('#') }
    return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(($lines -join "`n")))
}
$stopCommand = ConvertTo-EncodedScript 'Stop-DriveItProcesses.ps1'
$modeCheckCommand = ConvertTo-EncodedScript 'Test-DriveItModeGate.ps1'

# The supported Revit years, as the package built them (Build-DriveItPackage.ps1): DriveIt.wxs
# detects each one (REVIT<year>FOUND, from the year's last two digits) and installs when any is found.
$packageManifest = Get-Content -LiteralPath (Join-Path $package 'drive-it-package.json') -Raw | ConvertFrom-Json
$revitYears = @(if ($null -ne $packageManifest.PSObject.Properties['revitYears']) { $packageManifest.revitYears })
if ($revitYears.Count -eq 0 -or @($revitYears | Where-Object { $_ -notmatch '^20\d\d$' }).Count -ne 0) {
    throw "The package's revitYears ($($revitYears -join ', ')) is not a list of Revit years: $package"
}
$revitYearCodes = ($revitYears | ForEach-Object { $_.Substring(2) }) -join ';'
$revitFound = ($revitYears | ForEach-Object { "REVIT${_}FOUND" }) -join ' OR '
$revitYearNames = if ($revitYears.Count -eq 1) { $revitYears[0] } else { ($revitYears[0..($revitYears.Count - 2)] -join ', ') + ' or ' + $revitYears[-1] }

& $wix build (Join-Path $PSScriptRoot 'DriveIt.wxs') -arch x64 -ext WixToolset.Util.wixext `
    -bindpath "pkg=$package" -d "Version=$Version" -d "StopCommand=$stopCommand" `
    -d "ModeCheckCommand=$modeCheckCommand" -d "RevitYearCodes=$revitYearCodes" `
    -d "RevitFound=$revitFound" -d "RevitYearNames=$revitYearNames" -o $OutputPath

[ordered]@{ msi = [IO.Path]::GetFullPath($OutputPath); version = $Version; revitYears = $revitYears; wix = $wixVersion } | ConvertTo-Json
