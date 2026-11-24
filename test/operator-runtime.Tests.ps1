#requires -Version 5.1
[CmdletBinding()]
param(
    # The package from installer/Build-DriveItPackage.ps1; its window runs against its own operator.js.
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][string]$WorkDirectory
)

# Spec #22 R6: the Drive-It window starts on .NET 10 alone, as on a computer with Revit 2027 and no
# Revit 2026. The .NET 10 base and Windows Desktop runtimes, and nothing else, go in a private
# folder; the packaged window's self-test runs through that folder's dotnet.exe (the launch
# Install-DriveIt.ps1 uses for a private runtime), and must report that it ran on .NET 10. A
# private dotnet.exe resolves frameworks only from its own folder, so the runner's .NET 8 cannot
# serve the window: it starts only by rolling forward (RollForward=Major in DriveIt.Operator.csproj).
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-RuntimeTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

. (Join-Path $PSScriptRoot 'operator-self-test.ps1')

$package = (Resolve-Path -LiteralPath $PackagePath).ProviderPath
$app = Join-Path $package 'app'
$window = Join-Path $app 'operator\DriveIt.Operator.dll'
Assert-RuntimeTest ([IO.File]::Exists($window)) "The package has no operator window: $window"
[IO.Directory]::CreateDirectory($WorkDirectory) | Out-Null
$WorkDirectory = (Resolve-Path -LiteralPath $WorkDirectory).ProviderPath

$runtime = Join-Path $WorkDirectory 'dotnet10'
$installScript = Join-Path $WorkDirectory 'dotnet-install.ps1'
Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installScript
foreach ($name in @('dotnet', 'windowsdesktop')) {
    & $installScript -Runtime $name -Channel 10.0 -InstallDir $runtime -NoPath | Out-Host
}
$dotnet = Join-Path $runtime 'dotnet.exe'
$frameworks = @(& $dotnet --list-runtimes)
Write-Output "Private runtimes:`n$($frameworks -join "`n")"
$majors = @($frameworks | ForEach-Object { if ($_ -match '^\S+\s+(\d+)\.') { [int]$Matches[1] } } | Sort-Object -Unique)
Assert-RuntimeTest (($majors -join ',') -eq '10') "The private folder must hold .NET 10 alone, not majors [$($majors -join ', ')]."
Assert-RuntimeTest (@($frameworks | Where-Object { $_ -like 'Microsoft.WindowsDesktop.App 10.*' }).Count -ge 1) 'The private folder has no Windows Desktop runtime 10.'

# Isolated state: a data directory of its own, with a workspace so the window has nothing to report.
$data = Join-Path $WorkDirectory 'data'
$workspace = Join-Path $WorkDirectory 'workspace'
[IO.Directory]::CreateDirectory($workspace) | Out-Null
$env:DRIVE_IT_DATA_DIR = $data
$env:DRIVE_IT_MCP_CONFIG_PATH = Join-Path $WorkDirectory 'mcp.json'
& (Join-Path $app 'runtimes\node\node.exe') (Join-Path $app 'server\operator.js') workspace set $workspace | Out-Host
Assert-RuntimeTest ($LASTEXITCODE -eq 0) 'Could not select the test workspace.'

$result = Invoke-OperatorSelfTest -Exe $window -Dotnet $dotnet -Report (Join-Path $WorkDirectory 'operator-self-test-net10.json')
Assert-RuntimeTest ("$($result.runtime)" -like '10.*') "The window ran on .NET $($result.runtime), expected 10."
foreach ($opened in @($result.windows)) {
    Assert-RuntimeTest ($opened.workspaceRoot -eq $workspace) "The window on .NET 10 did not show the workspace: [$($opened.workspaceRoot)]."
}

Write-Output "operator runtime tests passed: the window started on .NET $($result.runtime) alone"
