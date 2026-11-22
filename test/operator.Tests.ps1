#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StateDirectory,
    [Parameter(Mandatory)][string]$FixtureDirectory,
    [string]$ModulePath,
    [string]$NodePath,
    [string]$OperatorScript
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:DRIVE_IT_DATA_DIR = $StateDirectory
if ([string]::IsNullOrWhiteSpace($ModulePath)) {
    $ModulePath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'operator\DriveIt.Operator.psm1'
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
}
if ([string]::IsNullOrWhiteSpace($OperatorScript)) {
    $OperatorScript = Join-Path $FixtureDirectory 'operator-stub.mjs'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'operator-cli.stub') -Destination $OperatorScript
}
$env:DRIVE_IT_OPERATOR_NODE = $NodePath
$env:DRIVE_IT_OPERATOR_SCRIPT = $OperatorScript
Import-Module $ModulePath -Force -DisableNameChecking

$tokens = $null
$parseErrors = $null
$operatorUi = Join-Path (Split-Path -Parent $ModulePath) 'DriveIt.Operator.ps1'
[void][System.Management.Automation.Language.Parser]::ParseFile($operatorUi, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) {
    throw "Drive It operator UI has PowerShell syntax errors: $parseErrors"
}

function Assert-OperatorTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

$firstRoot = Join-Path $FixtureDirectory 'workspace-one'
$secondRoot = Join-Path $FixtureDirectory 'workspace-two'
[IO.Directory]::CreateDirectory($firstRoot) | Out-Null
[IO.Directory]::CreateDirectory($secondRoot) | Out-Null

$first = Set-DriveItWorkspace -Root $firstRoot
Assert-OperatorTest ($first.root -eq $firstRoot) 'The initial root was not saved.'
$second = Set-DriveItWorkspace -Root $secondRoot
Assert-OperatorTest ($second.root -eq $secondRoot) 'The root could not be changed.'
Remove-Module DriveIt.Operator
Import-Module $ModulePath -Force -DisableNameChecking
Assert-OperatorTest ((Get-DriveItWorkspace).root -eq $secondRoot) 'The root did not survive a module reload.'

$seed = [ordered]@{
    root = $secondRoot
    decisions = @(
        [ordered]@{
            id = 'request-1'
            runId = 'run-1'
            status = 'pending'
            createdAt = '2026-01-01T00:00:00.000Z'
            requests = @(
                [ordered]@{ operation = 'read'; paths = @('C:\outside\one.rvt') },
                [ordered]@{ operation = 'write'; paths = @('C:\outside\two.rvt') }
            )
        },
        [ordered]@{
            id = 'request-2'
            runId = 'run-2'
            status = 'pending'
            createdAt = '2026-01-01T00:00:01.000Z'
            requests = @([ordered]@{ operation = 'delete'; paths = @('C:\outside\three.rvt') })
        }
    )
    history = @(
        [ordered]@{ runId = 'run-1'; status = 'succeeded'; startedAt = '2026-01-01T00:00:00.000Z'; workspaceRoot = 'C:\old-root' },
        [ordered]@{ runId = 'run-2'; status = 'denied'; startedAt = '2026-01-01T00:00:01.000Z'; workspaceRoot = 'C:\new-root' }
    )
}
[IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
[IO.File]::WriteAllText((Join-Path $StateDirectory 'operator-stub.json'), ($seed | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))

Assert-OperatorTest (@(Get-DriveItPendingApprovals).Count -eq 2) 'The pending requests were not listed.'
$approval = Set-DriveItApprovalDecision -RequestId 'request-1' -Decision 'approved'
Assert-OperatorTest ($approval.status -eq 'approved') 'The approval was not recorded.'
Assert-OperatorTest (@(Get-DriveItPendingApprovals).Count -eq 1) 'A completed decision remained pending.'

$repeatFailed = $false
try {
    Set-DriveItApprovalDecision -RequestId 'request-1' -Decision 'denied' | Out-Null
} catch {
    $repeatFailed = $true
}
Assert-OperatorTest $repeatFailed 'An existing decision could be overwritten.'
$storedApproval = Set-DriveItApprovalDecision -RequestId 'request-2' -Decision 'denied'
Assert-OperatorTest ($storedApproval.status -eq 'denied') 'The denial was not recorded.'
Assert-OperatorTest ((Get-DriveItRunHistory -Limit 1).runId -eq 'run-2') 'Run history was not newest-first.'
Set-DriveItWorkspace -Root $firstRoot | Out-Null
Assert-OperatorTest (@(Get-DriveItRunHistory).Count -eq 2) 'Changing the root removed run history.'

Write-Output 'operator tests passed'
