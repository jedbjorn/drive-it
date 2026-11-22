#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$SetRoot,
    [switch]$ShowConfiguration
)

Import-Module (Join-Path $PSScriptRoot 'DriveIt.Operator.psm1') -Force -DisableNameChecking

if (-not [string]::IsNullOrWhiteSpace($SetRoot)) {
    Set-DriveItWorkspace -Root $SetRoot | ConvertTo-Json -Depth 10
    return
}

if ($ShowConfiguration) {
    $configurationPath = Get-DriveItMcpConfigurationPath
    if (-not [IO.File]::Exists($configurationPath)) {
        throw "Drive It MCP configuration has not been installed: $configurationPath"
    }
    Get-Content -LiteralPath $configurationPath -Raw
    return
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = [Windows.Forms.Form]::new()
$form.Text = 'Drive It'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = [Drawing.Size]::new(900, 650)
$form.MinimumSize = [Drawing.Size]::new(920, 690)

$rootLabel = [Windows.Forms.Label]::new()
$rootLabel.Text = 'Workspace root'
$rootLabel.Location = [Drawing.Point]::new(12, 17)
$rootLabel.AutoSize = $true
$form.Controls.Add($rootLabel)

$rootText = [Windows.Forms.TextBox]::new()
$rootText.Location = [Drawing.Point]::new(115, 13)
$rootText.Size = [Drawing.Size]::new(555, 23)
$form.Controls.Add($rootText)

$browseButton = [Windows.Forms.Button]::new()
$browseButton.Text = 'Browse...'
$browseButton.Location = [Drawing.Point]::new(680, 11)
$browseButton.Size = [Drawing.Size]::new(95, 28)
$form.Controls.Add($browseButton)

$saveRootButton = [Windows.Forms.Button]::new()
$saveRootButton.Text = 'Save root'
$saveRootButton.Location = [Drawing.Point]::new(785, 11)
$saveRootButton.Size = [Drawing.Size]::new(95, 28)
$form.Controls.Add($saveRootButton)

$approvalsLabel = [Windows.Forms.Label]::new()
$approvalsLabel.Text = 'Outside-root requests'
$approvalsLabel.Location = [Drawing.Point]::new(12, 54)
$approvalsLabel.AutoSize = $true
$form.Controls.Add($approvalsLabel)

$requestList = [Windows.Forms.ListBox]::new()
$requestList.Location = [Drawing.Point]::new(12, 75)
$requestList.Size = [Drawing.Size]::new(300, 205)
$form.Controls.Add($requestList)

$requestDetails = [Windows.Forms.TextBox]::new()
$requestDetails.Multiline = $true
$requestDetails.ReadOnly = $true
$requestDetails.ScrollBars = 'Vertical'
$requestDetails.Font = [Drawing.Font]::new('Consolas', 9)
$requestDetails.Location = [Drawing.Point]::new(325, 75)
$requestDetails.Size = [Drawing.Size]::new(555, 205)
$form.Controls.Add($requestDetails)

$approveButton = [Windows.Forms.Button]::new()
$approveButton.Text = 'Approve this request'
$approveButton.Location = [Drawing.Point]::new(325, 290)
$approveButton.Size = [Drawing.Size]::new(145, 30)
$form.Controls.Add($approveButton)

$denyButton = [Windows.Forms.Button]::new()
$denyButton.Text = 'Deny this request'
$denyButton.Location = [Drawing.Point]::new(480, 290)
$denyButton.Size = [Drawing.Size]::new(140, 30)
$form.Controls.Add($denyButton)

$refreshButton = [Windows.Forms.Button]::new()
$refreshButton.Text = 'Refresh'
$refreshButton.Location = [Drawing.Point]::new(785, 290)
$refreshButton.Size = [Drawing.Size]::new(95, 30)
$form.Controls.Add($refreshButton)

$historyLabel = [Windows.Forms.Label]::new()
$historyLabel.Text = 'Run history'
$historyLabel.Location = [Drawing.Point]::new(12, 340)
$historyLabel.AutoSize = $true
$form.Controls.Add($historyLabel)

$historyList = [Windows.Forms.ListBox]::new()
$historyList.Location = [Drawing.Point]::new(12, 362)
$historyList.Size = [Drawing.Size]::new(300, 235)
$form.Controls.Add($historyList)

$historyDetails = [Windows.Forms.TextBox]::new()
$historyDetails.Multiline = $true
$historyDetails.ReadOnly = $true
$historyDetails.ScrollBars = 'Both'
$historyDetails.WordWrap = $false
$historyDetails.Font = [Drawing.Font]::new('Consolas', 9)
$historyDetails.Location = [Drawing.Point]::new(325, 362)
$historyDetails.Size = [Drawing.Size]::new(555, 235)
$form.Controls.Add($historyDetails)

$mcpLabel = [Windows.Forms.Label]::new()
$mcpLabel.Text = 'MCP configuration: ' + (Get-DriveItMcpConfigurationPath)
$mcpLabel.Location = [Drawing.Point]::new(12, 615)
$mcpLabel.Size = [Drawing.Size]::new(865, 20)
$form.Controls.Add($mcpLabel)

function Select-WorkspaceRoot {
    $dialog = [Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = 'Select the Drive It workspace root'
    $dialog.ShowNewFolderButton = $true
    if (-not [string]::IsNullOrWhiteSpace($rootText.Text) -and [IO.Directory]::Exists($rootText.Text)) {
        $dialog.SelectedPath = $rootText.Text
    }
    if ($dialog.ShowDialog($form) -eq [Windows.Forms.DialogResult]::OK) {
        $rootText.Text = $dialog.SelectedPath
    }
    $dialog.Dispose()
}

function Save-WorkspaceRoot {
    try {
        $configuration = Set-DriveItWorkspace -Root $rootText.Text
        $rootText.Text = $configuration.root
    } catch {
        [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Drive It workspace', 'OK', 'Error') | Out-Null
    }
}

function Update-RequestDetails {
    $requestDetails.Clear()
    if ($requestList.SelectedIndex -lt 0) {
        return
    }
    $request = $script:requests[$requestList.SelectedIndex]
    $lines = @("Request: $($request.id)", '')
    foreach ($operation in @($request.requests)) {
        $lines += "Operation: $($operation.operation)"
        foreach ($path in @($operation.paths)) {
            $lines += "Resolved path: $path"
        }
        $lines += ''
    }
    $requestDetails.Text = ($lines -join [Environment]::NewLine)
}

function Update-HistoryDetails {
    $historyDetails.Clear()
    if ($historyList.SelectedIndex -ge 0) {
        $historyDetails.Text = ($script:receipts[$historyList.SelectedIndex] | ConvertTo-Json -Depth 100)
    }
}

function Set-ApprovalDecision {
    param([string]$Decision)
    if ($requestList.SelectedIndex -lt 0) {
        return
    }
    $request = $script:requests[$requestList.SelectedIndex]
    try {
        Set-DriveItApprovalDecision -RequestId $request.id -Decision $Decision | Out-Null
        Update-OperatorData
    } catch {
        [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Drive It approval', 'OK', 'Error') | Out-Null
    }
}

function Update-OperatorData {
    $script:requests = @(Get-DriveItPendingApprovals)
    $requestList.Items.Clear()
    foreach ($request in $script:requests) {
        $requestList.Items.Add("$($request.id) ($((@($request.requests)).Count) operation(s))") | Out-Null
    }
    if ($requestList.Items.Count -gt 0) {
        $requestList.SelectedIndex = 0
    } else {
        $requestDetails.Clear()
    }

    $script:receipts = @(Get-DriveItRunHistory)
    $historyList.Items.Clear()
    foreach ($receipt in $script:receipts) {
        $historyList.Items.Add("$($receipt.runId) - $($receipt.status)") | Out-Null
    }
    if ($historyList.Items.Count -gt 0) {
        $historyList.SelectedIndex = 0
    } else {
        $historyDetails.Clear()
    }
}

$browseButton.Add_Click({ Select-WorkspaceRoot })
$saveRootButton.Add_Click({ Save-WorkspaceRoot })
$requestList.Add_SelectedIndexChanged({ Update-RequestDetails })
$historyList.Add_SelectedIndexChanged({ Update-HistoryDetails })
$approveButton.Add_Click({ Set-ApprovalDecision -Decision 'approved' })
$denyButton.Add_Click({ Set-ApprovalDecision -Decision 'denied' })
$refreshButton.Add_Click({ Update-OperatorData })
$form.Add_Shown({
    Update-OperatorData
    if ($null -eq (Get-DriveItWorkspace)) {
        Select-WorkspaceRoot
    }
})

$workspace = Get-DriveItWorkspace
if ($null -ne $workspace) {
    $rootText.Text = $workspace.root
}

[void]$form.ShowDialog()
$form.Dispose()
