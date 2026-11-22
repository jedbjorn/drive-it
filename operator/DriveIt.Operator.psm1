Set-StrictMode -Version Latest

function Get-DriveItDataDirectory {
    if (-not [string]::IsNullOrWhiteSpace($env:DRIVE_IT_DATA_DIR)) {
        return [IO.Path]::GetFullPath($env:DRIVE_IT_DATA_DIR)
    }

    return Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt'
}

function Get-DriveItMcpConfigurationPath {
    if (-not [string]::IsNullOrWhiteSpace($env:DRIVE_IT_MCP_CONFIG_PATH)) {
        return [IO.Path]::GetFullPath($env:DRIVE_IT_MCP_CONFIG_PATH)
    }

    return Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt\mcp.json'
}

function Invoke-DriveItOperator {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $application = Split-Path -Parent $PSScriptRoot
    $operatorScript = if ([string]::IsNullOrWhiteSpace($env:DRIVE_IT_OPERATOR_SCRIPT)) {
        Join-Path $application 'server\operator.js'
    } else {
        $env:DRIVE_IT_OPERATOR_SCRIPT
    }
    $node = if ([string]::IsNullOrWhiteSpace($env:DRIVE_IT_OPERATOR_NODE)) {
        Join-Path $application 'runtimes\node\node.exe'
    } else {
        $env:DRIVE_IT_OPERATOR_NODE
    }
    if (-not [IO.File]::Exists($node)) {
        $command = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($null -eq $command) {
            throw 'Drive It could not locate its Node.js runtime.'
        }
        $node = $command.Source
    }
    if (-not [IO.File]::Exists($operatorScript)) {
        throw "Drive It operator runtime is not installed: $operatorScript"
    }

    $errorPath = [IO.Path]::GetTempFileName()
    try {
        $output = & $node $operatorScript @Arguments 2>$errorPath | Out-String
        $exitCode = $LASTEXITCODE
        $errorText = [IO.File]::ReadAllText($errorPath)
        if ($exitCode -ne 0) {
            throw "Drive It operator command failed ($exitCode): $errorText"
        }
        if ([string]::IsNullOrWhiteSpace($output)) {
            return $null
        }
        return $output | ConvertFrom-Json
    } finally {
        if ([IO.File]::Exists($errorPath)) {
            [IO.File]::Delete($errorPath)
        }
    }
}

function Get-DriveItWorkspace {
    try {
        return Invoke-DriveItOperator -Arguments @('workspace', 'get')
    } catch {
        if ($_.Exception.Message -match 'WORKSPACE_NOT_SELECTED') {
            return $null
        }
        throw
    }
}

function Set-DriveItWorkspace {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Root)

    return Invoke-DriveItOperator -Arguments @('workspace', 'set', $Root)
}

function Get-DriveItPendingApprovals {
    return @(Invoke-DriveItOperator -Arguments @('decisions', 'list')) |
        Where-Object { $_.status -eq 'pending' }
}

function Set-DriveItApprovalDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][ValidateSet('approved', 'denied')][string]$Decision
    )

    $action = if ($Decision -eq 'approved') { 'approve' } else { 'deny' }
    return Invoke-DriveItOperator -Arguments @('decisions', $action, $RequestId)
}

function Get-DriveItRunHistory {
    [CmdletBinding()]
    param([ValidateRange(1, 1000)][int]$Limit = 100)

    return @(Invoke-DriveItOperator -Arguments @('history', 'list')) |
        Select-Object -First $Limit
}

Export-ModuleMember -Function @(
    'Get-DriveItDataDirectory',
    'Get-DriveItMcpConfigurationPath',
    'Get-DriveItPendingApprovals',
    'Get-DriveItRunHistory',
    'Get-DriveItWorkspace',
    'Set-DriveItApprovalDecision',
    'Set-DriveItWorkspace'
)
