#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'artifacts\DriveIt-alpha')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$nodeVersion = '22.16.0'
$pythonVersion = '3.12.9'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
$package = [IO.Path]::GetFullPath($OutputPath)
$archive = "$package.zip"

if ([IO.Directory]::Exists($package)) {
    Remove-Item -LiteralPath $package -Recurse -Force
}
if ([IO.File]::Exists($archive)) {
    Remove-Item -LiteralPath $archive -Force
}

$app = Join-Path $package 'app'
$downloads = Join-Path $package '.downloads'
[IO.Directory]::CreateDirectory($app) | Out-Null
[IO.Directory]::CreateDirectory($downloads) | Out-Null

try {
    Copy-Item -LiteralPath (Join-Path $repository 'server') -Destination (Join-Path $app 'server') -Recurse
    Copy-Item -LiteralPath (Join-Path $repository 'operator') -Destination (Join-Path $app 'operator') -Recurse
    Copy-Item -LiteralPath (Join-Path $repository 'package.json') -Destination (Join-Path $app 'package.json')
    Copy-Item -LiteralPath (Join-Path $repository 'package-lock.json') -Destination (Join-Path $app 'package-lock.json')
    Copy-Item -LiteralPath (Join-Path $repository 'installer\Install-DriveIt.ps1') -Destination (Join-Path $package 'Install-DriveIt.ps1')

    Push-Location $app
    try {
        & npm.cmd ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw 'npm could not assemble the production dependencies.'
        }
    } finally {
        Pop-Location
    }

    $projectPath = Join-Path $repository 'src\DriveIt.Revit\DriveIt.Revit.csproj'
    & dotnet restore $projectPath --source 'https://api.nuget.org/v3/index.json'
    if ($LASTEXITCODE -ne 0) {
        throw 'dotnet could not restore the Drive It Revit add-in.'
    }
    & dotnet publish $projectPath -c Release --no-self-contained --no-restore -o (Join-Path $app 'addin')
    if ($LASTEXITCODE -ne 0) {
        throw 'dotnet could not build the Drive It Revit add-in.'
    }

    $nodeArchive = Join-Path $downloads 'node.zip'
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $nodeArchive
    $nodeExtract = Join-Path $downloads 'node'
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
    $nodeDirectory = Join-Path $app 'runtimes\node'
    [IO.Directory]::CreateDirectory((Split-Path -Parent $nodeDirectory)) | Out-Null
    Move-Item -LiteralPath (Join-Path $nodeExtract "node-v$nodeVersion-win-x64") -Destination $nodeDirectory

    $pythonArchive = Join-Path $downloads 'python.zip'
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-embed-amd64.zip" -OutFile $pythonArchive
    $pythonDirectory = Join-Path $app 'runtimes\python'
    Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonDirectory
    $pythonZip = Get-ChildItem -LiteralPath $pythonDirectory -Filter 'python*.zip' | Select-Object -First 1
    $pythonPathFile = Get-ChildItem -LiteralPath $pythonDirectory -Filter 'python*._pth' | Select-Object -First 1
    if ($null -eq $pythonZip -or $null -eq $pythonPathFile) {
        throw 'The bundled Python layout is not recognized.'
    }
    [IO.Directory]::CreateDirectory((Join-Path $pythonDirectory 'Lib\site-packages')) | Out-Null
    [IO.File]::WriteAllLines($pythonPathFile.FullName, @($pythonZip.Name, '.', 'Lib\site-packages', 'import site'), [Text.UTF8Encoding]::new($false))

    $requirements = Join-Path $repository 'requirements.txt'
    if ([IO.File]::Exists($requirements) -and -not [string]::IsNullOrWhiteSpace([IO.File]::ReadAllText($requirements))) {
        & python -m pip install --disable-pip-version-check --no-input --target (Join-Path $pythonDirectory 'Lib\site-packages') --requirement $requirements
        if ($LASTEXITCODE -ne 0) {
            throw 'pip could not bundle the fixed Python dependencies.'
        }
    }

    $project = Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json
    $manifest = [ordered]@{
        schemaVersion = 1
        name = 'drive-it'
        version = $project.version
        nodeVersion = $nodeVersion
        pythonVersion = $pythonVersion
    }
    [IO.File]::WriteAllText((Join-Path $package 'drive-it-package.json'), ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
} finally {
    if ([IO.Directory]::Exists($downloads)) {
        Remove-Item -LiteralPath $downloads -Recurse -Force
    }
}

Compress-Archive -Path (Join-Path $package '*') -DestinationPath $archive
[ordered]@{
    package = $package
    archive = $archive
    nodeVersion = $nodeVersion
    pythonVersion = $pythonVersion
} | ConvertTo-Json -Depth 10
