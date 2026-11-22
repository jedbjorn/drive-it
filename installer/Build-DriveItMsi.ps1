#requires -Version 7.3
[CmdletBinding()]
param(
    [string]$PackagePath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'artifacts\DriveIt-alpha'),
    [string]$OutputPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'artifacts\DriveIt-alpha.msi')
)

# Wraps the package from Build-DriveItPackage.ps1 in an unsigned per-user MSI.
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

# MSI ProductVersion is numeric major.minor.build; a prerelease suffix is dropped.
$version = ((Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json).version) -replace '-.*$', ''
& $wix build (Join-Path $PSScriptRoot 'DriveIt.wxs') -arch x64 -ext WixToolset.Util.wixext `
    -bindpath "pkg=$package" -d "Version=$version" -o $OutputPath

[ordered]@{ msi = [IO.Path]::GetFullPath($OutputPath); version = $version; wix = $wixVersion } | ConvertTo-Json
