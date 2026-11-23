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

# The MSI runs Stop-DriveItProcesses.ps1 before InstallValidate, when the install folder may still
# hold an older version without it, so the script travels inside the MSI as an encoded command.
$stopLines = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Stop-DriveItProcesses.ps1') |
    Where-Object { $_.Trim() -and -not $_.TrimStart().StartsWith('#') }
$stopCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(($stopLines -join "`n")))

& $wix build (Join-Path $PSScriptRoot 'DriveIt.wxs') -arch x64 -ext WixToolset.Util.wixext `
    -bindpath "pkg=$package" -d "Version=$Version" -d "StopCommand=$stopCommand" -o $OutputPath

[ordered]@{ msi = [IO.Path]::GetFullPath($OutputPath); version = $Version; wix = $wixVersion } | ConvertTo-Json
