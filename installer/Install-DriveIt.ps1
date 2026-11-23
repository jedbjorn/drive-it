#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$SourcePath = $PSScriptRoot,
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt'),
    [string]$WorkspaceRoot,
    [string]$McpConfigPath,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'The Drive It alpha installer runs on Windows.'
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Path
    )

    $directory = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = Join-Path $directory ('.' + [IO.Path]::GetRandomFileName() + '.tmp')
    $backup = $temporary + '.bak'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($temporary, $Path, $backup)
            [IO.File]::Delete($backup)
        } else {
            [IO.File]::Move($temporary, $Path)
        }
    } finally {
        if ([IO.File]::Exists($temporary)) {
            [IO.File]::Delete($temporary)
        }
        if ([IO.File]::Exists($backup)) {
            [IO.File]::Delete($backup)
        }
    }
}

function Test-DotnetRuntime {
    param([Parameter(Mandatory)][string]$DotnetPath)

    # The Revit add-in runs in Revit; DriveIt.Operator.exe (the Start Menu window) is a
    # framework-dependent WPF app, so both the base and the Windows Desktop runtime 8+ are required.
    if (-not [IO.File]::Exists($DotnetPath)) {
        return $false
    }
    $runtimes = & $DotnetPath --list-runtimes 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $false
    }
    $hasCore = $false
    $hasDesktop = $false
    foreach ($line in $runtimes) {
        if ($line -match '^Microsoft\.NETCore\.App\s+(\d+)\.' -and [int]$Matches[1] -ge 8) {
            $hasCore = $true
        }
        if ($line -match '^Microsoft\.WindowsDesktop\.App\s+(\d+)\.' -and [int]$Matches[1] -ge 8) {
            $hasDesktop = $true
        }
    }
    return ($hasCore -and $hasDesktop)
}

function Install-DotnetRuntime {
    param([Parameter(Mandatory)][string]$Destination)

    # Returns the dotnet.exe whose runtimes satisfy Drive It. The machine location is what
    # DriveIt.Operator.exe's host finds on its own; any other one is passed to it explicitly.
    $machineDotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
    if (Test-DotnetRuntime -DotnetPath $machineDotnet) {
        return $machineDotnet
    }

    $command = Get-Command dotnet.exe -ErrorAction SilentlyContinue
    if ($null -ne $command -and (Test-DotnetRuntime -DotnetPath $command.Source)) {
        return $command.Source
    }

    $privateDotnet = Join-Path $Destination 'dotnet.exe'
    if (Test-DotnetRuntime -DotnetPath $privateDotnet) {
        return $privateDotnet
    }

    $download = Join-Path $Destination 'dotnet-install.ps1'
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $download
    foreach ($runtime in @('dotnet', 'windowsdesktop')) {
        & $download -Runtime $runtime -Channel 8.0 -InstallDir $Destination -NoPath | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Drive It could not provision the required .NET 8 runtime ($runtime)."
        }
    }
    if (-not (Test-DotnetRuntime -DotnetPath $privateDotnet)) {
        throw 'Drive It could not provision the required .NET 8 runtime.'
    }
    Remove-Item -LiteralPath $download -Force
    return $privateDotnet
}

function Get-OperatorLaunch {
    param(
        [Parameter(Mandatory)][string]$Application,
        [Parameter(Mandatory)][string]$Dotnet
    )

    # The Start Menu window. With the machine .NET it is the exe itself; with another
    # dotnet.exe the window's DLL runs through it, from a hidden PowerShell so no console shows.
    $exe = Join-Path $Application 'operator\DriveIt.Operator.exe'
    $machineDotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
    if ($Dotnet -ieq $machineDotnet) {
        return [pscustomobject]@{ FilePath = $exe; Arguments = '' }
    }
    $quote = { param($Text) "'" + $Text.Replace("'", "''") + "'" }
    $dll = Join-Path $Application 'operator\DriveIt.Operator.dll'
    return [pscustomobject]@{
        FilePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Arguments = '-NoProfile -WindowStyle Hidden -Command "& ' + (& $quote $Dotnet) + ' ' + (& $quote $dll) + '"'
    }
}

$source = (Resolve-Path -LiteralPath $SourcePath).ProviderPath
$install = [IO.Path]::GetFullPath($InstallRoot)
$app = Join-Path $install 'app'
$dataDirectory = $install
if ([string]::IsNullOrWhiteSpace($McpConfigPath)) {
    $McpConfigPath = Join-Path $install 'mcp.json'
} else {
    $McpConfigPath = [IO.Path]::GetFullPath($McpConfigPath)
}

$manifestPath = Join-Path $source 'drive-it-package.json'
if (-not [IO.File]::Exists($manifestPath)) {
    throw "Not a Drive It installer package: $manifestPath is missing."
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) {
    throw "Unsupported Drive It installer package schema: $($manifest.schemaVersion)"
}

if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $resolvedWorkspace = Get-Item -LiteralPath $WorkspaceRoot -Force
    if (-not $resolvedWorkspace.PSIsContainer) {
        throw "Drive It workspace is not a directory: $WorkspaceRoot"
    }
    $WorkspaceRoot = $resolvedWorkspace.FullName
}

[IO.Directory]::CreateDirectory($install) | Out-Null
[IO.Directory]::CreateDirectory($dataDirectory) | Out-Null
$staging = Join-Path $install ('.staging-' + [Guid]::NewGuid().ToString('N'))
$backup = Join-Path $install ('.backup-' + [Guid]::NewGuid().ToString('N'))
$stagedApp = Join-Path $staging 'app'
$hadExistingApp = $false
# The MSI lays the package out in the install root itself; register those files in place.
$inPlace = [IO.Path]::GetFullPath((Join-Path $source 'app')).TrimEnd('\') -ieq $app.TrimEnd('\')

try {
    if ($inPlace) {
        $stagedApp = $app
    } else {
        [IO.Directory]::CreateDirectory($staging) | Out-Null
        Copy-Item -LiteralPath (Join-Path $source 'app') -Destination $stagedApp -Recurse
    }

    $node = Join-Path $stagedApp 'runtimes\node\node.exe'
    $python = Join-Path $stagedApp 'runtimes\python\python.exe'
    $server = Join-Path $stagedApp 'server\index.js'
    $smokeTest = Join-Path $stagedApp 'server\install-smoke.mjs'
    $addinTemplate = Join-Path $stagedApp 'addin\DriveIt.addin'
    $requiredFiles = @(
        $node, $python, $server, $smokeTest, $addinTemplate,
        (Join-Path $stagedApp 'addin\DriveIt.Revit.dll'),
        (Join-Path $stagedApp 'addin\DriveIt.UI.dll'),
        (Join-Path $stagedApp 'operator\DriveIt.Operator.exe')
    )
    foreach ($required in $requiredFiles) {
        if (-not [IO.File]::Exists($required)) {
            throw "The Drive It package is incomplete: $required is missing."
        }
    }

    $nodeVersion = (& $node --version).Trim()
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion.TrimStart('v') -lt [version]'22.0.0') {
        throw "The private Node.js runtime is not version 22 or newer: $nodeVersion"
    }
    & $python -I -c "import json, sys; assert sys.version_info >= (3, 12); print(sys.version)"
    if ($LASTEXITCODE -ne 0) {
        throw 'The private Python runtime failed its installation check.'
    }

    $dotnet = Install-DotnetRuntime -Destination (Join-Path $stagedApp 'runtimes\dotnet')

    $env:DRIVE_IT_DATA_DIR = $dataDirectory
    & $node $smokeTest $server $dataDirectory $python
    if ($LASTEXITCODE -ne 0) {
        throw 'The installed MCP server failed its stdio discovery check.'
    }

    if (-not $inPlace) {
        if ([IO.Directory]::Exists($app)) {
            Move-Item -LiteralPath $app -Destination $backup
            $hadExistingApp = $true
        }
        Move-Item -LiteralPath $stagedApp -Destination $app
    }

    $installedNode = Join-Path $app 'runtimes\node\node.exe'
    $installedPython = Join-Path $app 'runtimes\python\python.exe'
    $installedServer = Join-Path $app 'server\index.js'
    $addinDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Autodesk\Revit\Addins\2026'
    [IO.Directory]::CreateDirectory($addinDirectory) | Out-Null
    $addinPath = Join-Path $addinDirectory 'DriveIt.addin'
    $addin = [xml](Get-Content -LiteralPath (Join-Path $app 'addin\DriveIt.addin') -Raw)
    $addin.RevitAddIns.AddIn.Assembly = [string](Join-Path $app 'addin\DriveIt.Revit.dll')
    $addinTemporary = Join-Path $addinDirectory ('.DriveIt-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $addinBackup = $addinTemporary + '.bak'
    try {
        $addin.Save($addinTemporary)
        if ([IO.File]::Exists($addinPath)) {
            [IO.File]::Replace($addinTemporary, $addinPath, $addinBackup)
            [IO.File]::Delete($addinBackup)
        } else {
            [IO.File]::Move($addinTemporary, $addinPath)
        }
    } finally {
        if ([IO.File]::Exists($addinTemporary)) {
            [IO.File]::Delete($addinTemporary)
        }
        if ([IO.File]::Exists($addinBackup)) {
            [IO.File]::Delete($addinBackup)
        }
    }

    $serverEntry = [ordered]@{
        command = $installedNode
        args = @($installedServer)
        env = [ordered]@{
            DRIVE_IT_DATA_DIR = $dataDirectory
            DRIVE_IT_PYTHON = $installedPython
        }
    }
    if ([IO.File]::Exists($McpConfigPath)) {
        $configuration = Get-Content -LiteralPath $McpConfigPath -Raw | ConvertFrom-Json
        if ($null -eq $configuration.mcpServers) {
            $configuration | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
        }
        if ($null -eq $configuration.mcpServers.PSObject.Properties['drive-it']) {
            $configuration.mcpServers | Add-Member -NotePropertyName 'drive-it' -NotePropertyValue $serverEntry
        } else {
            $configuration.mcpServers.'drive-it' = $serverEntry
        }
    } else {
        $configuration = [ordered]@{ mcpServers = [ordered]@{'drive-it' = $serverEntry} }
    }
    Write-JsonAtomic -Value $configuration -Path $McpConfigPath
    $env:DRIVE_IT_MCP_CONFIG_PATH = $McpConfigPath

    # Add the same entry to the Claude Desktop, Claude Code, and Codex configurations found for this user.
    $clientArguments = @(
        (Join-Path $app 'server\clients.js'), 'register', $McpConfigPath,
        [Environment]::GetFolderPath('UserProfile'), [Environment]::GetFolderPath('ApplicationData')
    )
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        $clientArguments += $env:CODEX_HOME
    }
    $clientOutput = & $installedNode @clientArguments | Out-String
    $clients = $null
    if ($LASTEXITCODE -eq 0) {
        $clients = $clientOutput | ConvertFrom-Json
    } else {
        Write-Warning "Drive It could not update MCP client configurations; add the entry from $McpConfigPath manually."
    }

    Import-Module (Join-Path $app 'operator\DriveIt.Operator.psm1') -Force -DisableNameChecking
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
        Set-DriveItWorkspace -Root $WorkspaceRoot | Out-Null
    }

    # A private runtime provisioned while staging now lives under the installed app.
    if ($dotnet.StartsWith($stagedApp + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $dotnet = Join-Path $app $dotnet.Substring($stagedApp.Length + 1)
    }
    $launch = Get-OperatorLaunch -Application $app -Dotnet $dotnet
    $programs = [Environment]::GetFolderPath('Programs')
    [IO.Directory]::CreateDirectory($programs) | Out-Null
    $previousShortcut = Join-Path $programs 'Drive It.lnk'
    if ([IO.File]::Exists($previousShortcut)) {
        Remove-Item -LiteralPath $previousShortcut -Force
    }
    $shortcutPath = Join-Path $programs 'Drive-It.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launch.FilePath
    $shortcut.Arguments = $launch.Arguments
    $shortcut.WorkingDirectory = Join-Path $app 'operator'
    $shortcut.Description = 'Choose the workspace, approve requests, and review what the agent ran.'
    $shortcut.Save()

    if ([IO.Directory]::Exists($backup)) {
        Remove-Item -LiteralPath $backup -Recurse -Force
    }

    if (-not $NoLaunch) {
        if ([string]::IsNullOrEmpty($launch.Arguments)) {
            Start-Process -FilePath $launch.FilePath -WorkingDirectory (Join-Path $app 'operator')
        } else {
            Start-Process -FilePath $launch.FilePath -ArgumentList $launch.Arguments -WorkingDirectory (Join-Path $app 'operator')
        }
    }

    [ordered]@{
        installed = $true
        application = $app
        addin = $addinPath
        shortcut = $shortcutPath
        mcpConfiguration = $McpConfigPath
        mcpClients = $clients
        dataDirectory = $dataDirectory
    } | ConvertTo-Json -Depth 10
} catch {
    if ($hadExistingApp -and [IO.Directory]::Exists($backup) -and -not [IO.Directory]::Exists($app)) {
        Move-Item -LiteralPath $backup -Destination $app
    }
    throw
} finally {
    if ([IO.Directory]::Exists($staging)) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
