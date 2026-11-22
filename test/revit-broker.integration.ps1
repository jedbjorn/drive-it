param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [string]$WorkspaceRoot = "C:\DriveIt\broker-fixtures"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Status($Response, [string]$Expected) {
    if ($Response.status -ne $Expected) {
        throw "Expected status $Expected but received $($Response.status): $($Response | ConvertTo-Json -Depth 12 -Compress)"
    }
}

function Read-Line($Reader, [int]$TimeoutMilliseconds = 120000) {
    $task = $Reader.ReadLineAsync()
    if (-not $task.Wait($TimeoutMilliseconds)) {
        throw "Timed out waiting for the Revit broker."
    }
    return $task.Result
}

function Read-BrokerSession {
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
        ".", "drive-it-$ProcessId",
        [System.IO.Pipes.PipeDirection]::InOut,
        [System.IO.Pipes.PipeOptions]::Asynchronous)
    $reader = $null
    try {
        $pipe.Connect(10000)
        $reader = [System.IO.StreamReader]::new($pipe, [System.Text.Encoding]::UTF8, $false, 8192, $true)
        $session = (Read-Line $reader 10000) | ConvertFrom-Json
        Assert-True ($session.processId -eq $ProcessId) "A session-only connection received the wrong process id."
        return $session
    }
    finally {
        if ($reader -ne $null) { $reader.Dispose() }
        $pipe.Dispose()
    }
}

$runId = [guid]::NewGuid().ToString("N")
$receiptLog = Join-Path $WorkspaceRoot "broker-receipts-$runId.jsonl"
$projectTemplate = Join-Path $WorkspaceRoot "broker-project.rte"
$familyTemplate = Join-Path $WorkspaceRoot "broker-family.rft"
$rvtPath = Join-Path $WorkspaceRoot "broker-$runId.rvt"
$rfaPath = Join-Path $WorkspaceRoot "broker-$runId.rfa"
$outsideDirectory = Join-Path $env:TEMP "drive-it-outside-$runId"
$junction = Join-Path $WorkspaceRoot "broker-link-$runId"
$outsideRvt = Join-Path $junction "broker-outside.rvt"
$canonicalOutsideRvt = Join-Path $outsideDirectory "broker-outside.rvt"
$danglingLink = Join-Path $WorkspaceRoot "broker-dangling-$runId.rvt"
$canonicalDanglingOutsideRvt = Join-Path $outsideDirectory "broker-dangling-outside.rvt"

function Invoke-Broker([hashtable]$Request) {
    if (-not $Request.ContainsKey("id")) {
        $Request.id = [guid]::NewGuid().ToString("N")
    }
    $Request.type = "model.execute"
    $Request.workspaceRoot = $WorkspaceRoot
    $json = $Request | ConvertTo-Json -Depth 12 -Compress
    $pipe = $null
    $reader = $null
    $writer = $null
    try {
        $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
            ".", "drive-it-$ProcessId",
            [System.IO.Pipes.PipeDirection]::InOut,
            [System.IO.Pipes.PipeOptions]::Asynchronous)
        $pipe.Connect(10000)
        $encoding = [System.Text.UTF8Encoding]::new($false)
        $reader = [System.IO.StreamReader]::new($pipe, $encoding, $false, 8192, $true)
        $writer = [System.IO.StreamWriter]::new($pipe, $encoding, 8192, $true)
        $writer.NewLine = "`n"
        $writer.AutoFlush = $true

        $session = (Read-Line $reader 10000) | ConvertFrom-Json
        $script:brokerSession = $session
        Assert-True ($session.processId -eq $ProcessId) "The pipe greeting did not match the requested Revit process."
        $writeTask = $writer.WriteLineAsync($json)
        if (-not $writeTask.Wait(30000)) {
            throw "Timed out sending the broker request."
        }
        $response = (Read-Line $reader) | ConvertFrom-Json
        Assert-True ($response.id -eq $Request.id) "The response id did not match the request."
        [ordered]@{ request = $Request; response = $response } |
            ConvertTo-Json -Depth 12 -Compress | Add-Content -Path $receiptLog -Encoding UTF8
        return $response
    }
    finally {
        if ($writer -ne $null) { $writer.Dispose() }
        if ($reader -ne $null) { $reader.Dispose() }
        if ($pipe -ne $null) { $pipe.Dispose() }
    }
}

function Document-Target([string]$UniqueId) {
    return @{ uniqueId = $UniqueId; path = $null }
}

New-Item -ItemType Directory -Force $outsideDirectory | Out-Null
New-Item -ItemType Junction -Path $junction -Target $outsideDirectory | Out-Null
& cmd.exe /c mklink $danglingLink $canonicalDanglingOutsideRvt | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create the dangling file symbolic link."
}
Assert-True (([System.IO.File]::GetAttributes($danglingLink) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) "The dangling destination is not a reparse point."
Assert-True (Test-Path $projectTemplate -PathType Leaf) "Missing in-root project template $projectTemplate"
Assert-True (Test-Path $familyTemplate -PathType Leaf) "Missing in-root family template $familyTemplate"

try {
    1..3 | ForEach-Object {
        Read-BrokerSession | Out-Null
        Start-Sleep -Milliseconds 250
    }

    $outsideRequest = @{
        document = $null
        operations = @(
            @{ type = "create_document"; arguments = @{ kind = "rvt"; templatePath = $projectTemplate } },
            @{ type = "save_as_document"; arguments = @{ destinationPath = $outsideRvt; overwrite = $true } }
        )
    }
    $policy = Invoke-Broker $outsideRequest
    Assert-Status $policy "policy_required"
    Assert-True ($policy.changes.Count -eq 0) "policy_required reported changes."
    Assert-True (-not (Test-Path $canonicalOutsideRvt)) "policy_required created the outside-root file."
    $savePolicy = $policy.policyRequests | Where-Object { $_.operation -eq "save_as_document" } | Select-Object -First 1
    Assert-True ($null -ne $savePolicy) "save_as_document was not included in policyRequests."
    Assert-True ($savePolicy.paths[0] -eq $canonicalOutsideRvt) "The junction destination was not resolved outside the root."

    $outsideRequest.outsideRootApproval = @{
        decisionId = "integration-$runId"
        grants = @(@{ operation = "save_as_document"; paths = @($canonicalOutsideRvt) })
    }
    $outsideSaved = Invoke-Broker $outsideRequest
    Assert-Status $outsideSaved "succeeded"
    Assert-True (Test-Path $canonicalOutsideRvt -PathType Leaf) "The approved outside-root save did not create the resolved file."
    $outsideId = $outsideSaved.document.uniqueId
    $outsideDelete = @{
        document = Document-Target $outsideId
        operations = @(@{ type = "delete_document"; arguments = @{} })
        outsideRootApproval = @{
            decisionId = "integration-delete-$runId"
            grants = @(@{ operation = "delete_document"; paths = @($canonicalOutsideRvt) })
        }
    }
    $outsideDeleted = Invoke-Broker $outsideDelete
    Assert-Status $outsideDeleted "succeeded"
    Assert-True (-not (Test-Path $canonicalOutsideRvt)) "The approved outside-root delete did not remove the file."

    $danglingRequest = @{
        document = $null
        operations = @(
            @{ type = "create_document"; arguments = @{ kind = "rvt"; templatePath = $projectTemplate } },
            @{ type = "save_as_document"; arguments = @{ destinationPath = $danglingLink; overwrite = $true } }
        )
    }
    $danglingPolicy = Invoke-Broker $danglingRequest
    Assert-Status $danglingPolicy "policy_required"
    Assert-True ($danglingPolicy.changes.Count -eq 0) "The dangling-link policy denial reported changes."
    Assert-True (-not (Test-Path $canonicalDanglingOutsideRvt)) "The dangling-link policy denial created the outside-root file."
    $danglingSavePolicy = $danglingPolicy.policyRequests | Where-Object { $_.operation -eq "save_as_document" } | Select-Object -First 1
    Assert-True ($null -ne $danglingSavePolicy) "The dangling-link save was not included in policyRequests."
    Assert-True ($danglingSavePolicy.paths[0] -eq $canonicalDanglingOutsideRvt) "The dangling-link destination was not resolved outside the root."

    $danglingRequest.outsideRootApproval = @{
        decisionId = "integration-dangling-$runId"
        grants = @(@{ operation = "save_as_document"; paths = @($canonicalDanglingOutsideRvt) })
    }
    $danglingSaved = Invoke-Broker $danglingRequest
    Assert-Status $danglingSaved "succeeded"
    Assert-True (Test-Path $canonicalDanglingOutsideRvt -PathType Leaf) "The approved dangling-link save did not create the resolved file."
    Assert-True ($danglingSaved.affectedFiles -contains $canonicalDanglingOutsideRvt) "The dangling-link receipt omitted the resolved affected path."
    Assert-True ($danglingSaved.document.path -eq $canonicalDanglingOutsideRvt) "The dangling-link document receipt did not retain the resolved path."
    $danglingClosed = Invoke-Broker @{
        document = Document-Target $danglingSaved.document.uniqueId
        operations = @(@{ type = "close_document"; arguments = @{} })
    }
    Assert-Status $danglingClosed "succeeded"

    $created = Invoke-Broker @{
        document = $null
        operations = @(@{ type = "create_document"; arguments = @{ kind = "rvt"; templatePath = $projectTemplate } })
    }
    Assert-Status $created "succeeded"
    Assert-True ($created.document.kind -eq "rvt") "The created project was not identified as RVT."
    $rvtId = $created.document.uniqueId

    $read = Invoke-Broker @{ document = Document-Target $rvtId; operations = @(@{ type = "read_document"; arguments = @{} }) }
    Assert-Status $read "succeeded"
    Assert-True ($read.document.uniqueId -eq $rvtId) "The project identity changed during read."
    Assert-True ($read.document.levels.Count -gt 0) "The project template has no level for wall verification."
    $level = $read.document.levels | Select-Object -First 1
    $initialWalls = $read.document.wallCount

    $savedAs = Invoke-Broker @{
        document = Document-Target $rvtId
        operations = @(@{ type = "save_as_document"; arguments = @{ destinationPath = $rvtPath; overwrite = $true } })
    }
    Assert-Status $savedAs "succeeded"
    Assert-True ($savedAs.document.uniqueId -eq $rvtId) "The project identity changed during save-as."
    Assert-True (Test-Path $rvtPath -PathType Leaf) "The project save-as file is absent."

    $rejected = Invoke-Broker @{
        document = Document-Target $rvtId
        operations = @(
            @{ type = "create_level"; arguments = @{ name = "Drive It Rejected"; elevation = 3.0 } },
            @{ type = "create_wall"; arguments = @{ baseLevelId = $level.id; height = 10.0; start = @{ x = 0; y = 0; z = 0 }; end = $null } }
        )
    }
    Assert-Status $rejected "failed"
    Assert-True ($rejected.changes.Count -eq 0) "A rejected model batch reported changes."
    Assert-True ($rejected.affectedElements.Count -eq 0) "A rejected model batch reported affected elements."

    $model = Invoke-Broker @{
        document = Document-Target $rvtId
        operations = @(
            @{ type = "create_level"; arguments = @{ name = "Drive It Level"; elevation = 4.5 } },
            @{ type = "create_wall"; arguments = @{ baseLevelId = $level.id; height = 10.0; start = @{ x = 0; y = 0; z = 0 }; end = @{ x = 5; y = 0; z = 0 } } }
        )
    }
    Assert-Status $model "succeeded"
    Assert-True ($model.document.wallCount -eq ($initialWalls + 1)) "The committed wall was not observed in the project."
    Assert-True ($model.document.levels.name -contains "Drive It Level") "The committed level was not observed in the project."
    Assert-True ($model.affectedElements.Count -eq 2) "The successful RVT batch did not identify both affected elements."

    $rollback = Invoke-Broker @{
        document = Document-Target $rvtId
        operations = @(
            @{ type = "create_level"; arguments = @{ name = "Drive It Rollback"; elevation = 6.0 } },
            @{ type = "create_wall"; arguments = @{ baseLevelId = $level.id; height = 10.0; start = @{ x = 0; y = 0; z = 0 }; end = @{ x = 0; y = 0; z = 5 } } }
        )
    }
    Assert-Status $rollback "failed"
    $rollbackCheck = $rollback.checks | Where-Object { $_.name -eq "transaction_rollback" } | Select-Object -First 1
    Assert-True ($null -ne $rollbackCheck -and $rollbackCheck.passed) "Revit did not confirm rollback of the failed model batch."
    Assert-True ($rollback.changes.Count -eq 0) "The rolled-back model batch retained reported changes."
    Assert-True ($rollback.document.levels.name -notcontains "Drive It Rollback") "The first change survived transaction rollback."

    $saved = Invoke-Broker @{ document = Document-Target $rvtId; operations = @(@{ type = "save_document"; arguments = @{} }) }
    Assert-Status $saved "succeeded"
    $closed = Invoke-Broker @{ document = Document-Target $rvtId; operations = @(@{ type = "close_document"; arguments = @{} }) }
    Assert-Status $closed "succeeded"

    $reopened = Invoke-Broker @{
        document = $null
        operations = @(@{ type = "open_document"; arguments = @{ path = $rvtPath; kind = "rvt" } })
    }
    Assert-Status $reopened "succeeded"
    Assert-True ($reopened.document.wallCount -eq ($initialWalls + 1)) "The saved wall did not survive reopen."
    Assert-True ($reopened.document.levels.name -contains "Drive It Level") "The saved level did not survive reopen."
    $rvtId = $reopened.document.uniqueId

    $file = Get-Item $rvtPath
    $file.IsReadOnly = $true
    $partial = Invoke-Broker @{ document = Document-Target $rvtId; operations = @(@{ type = "delete_document"; arguments = @{} }) }
    Assert-Status $partial "partially_applied"
    Assert-True (($partial.changes -join "`n") -match "Closed") "The partial delete did not report the completed close."
    Assert-True (Test-Path $rvtPath -PathType Leaf) "The partial delete removed or lost the read-only file."
    $file = Get-Item $rvtPath
    $file.IsReadOnly = $false

    $reopenedForDelete = Invoke-Broker @{
        document = $null
        operations = @(@{ type = "open_document"; arguments = @{ path = $rvtPath; kind = "rvt" } })
    }
    Assert-Status $reopenedForDelete "succeeded"
    $deleted = Invoke-Broker @{
        document = Document-Target $reopenedForDelete.document.uniqueId
        operations = @(@{ type = "delete_document"; arguments = @{} })
    }
    Assert-Status $deleted "succeeded"
    Assert-True (-not (Test-Path $rvtPath)) "The project delete left the file behind."

    $family = Invoke-Broker @{
        document = $null
        operations = @(@{ type = "create_document"; arguments = @{ kind = "rfa"; templatePath = $familyTemplate } })
    }
    Assert-Status $family "succeeded"
    Assert-True ($family.document.kind -eq "rfa") "The created family was not identified as RFA."
    $familyId = $family.document.uniqueId
    $familyEdit = Invoke-Broker @{
        document = Document-Target $familyId
        operations = @(@{ type = "create_family_type"; arguments = @{ name = "Drive It Type" } })
    }
    Assert-Status $familyEdit "succeeded"
    Assert-True ($familyEdit.document.familyTypes -contains "Drive It Type") "The new family type was not observed."
    $familySaved = Invoke-Broker @{
        document = Document-Target $familyId
        operations = @(@{ type = "save_as_document"; arguments = @{ destinationPath = $rfaPath; overwrite = $true } })
    }
    Assert-Status $familySaved "succeeded"
    Assert-True ($familySaved.document.uniqueId -eq $familyId) "The family identity changed during save-as."
    $familyClosed = Invoke-Broker @{ document = Document-Target $familyId; operations = @(@{ type = "close_document"; arguments = @{} }) }
    Assert-Status $familyClosed "succeeded"

    $familyReopened = Invoke-Broker @{
        document = $null
        operations = @(@{ type = "open_document"; arguments = @{ path = $rfaPath; kind = "rfa" } })
    }
    Assert-Status $familyReopened "succeeded"
    Assert-True ($familyReopened.document.familyTypes -contains "Drive It Type") "The family type did not survive reopen."
    $familyDeleted = Invoke-Broker @{
        document = Document-Target $familyReopened.document.uniqueId
        operations = @(@{ type = "delete_document"; arguments = @{} })
    }
    Assert-Status $familyDeleted "succeeded"
    Assert-True (-not (Test-Path $rfaPath)) "The family delete left the file behind."

    $revit = Get-Process -Id $ProcessId
    Assert-True $revit.Responding "Revit stopped responding after the broker workflows."
    [ordered]@{
        status = "succeeded"
        processId = $ProcessId
        revitVersion = $script:brokerSession.version
        revitBuild = $script:brokerSession.build
        revitWindowTitle = $revit.MainWindowTitle
        receiptLog = $receiptLog
        checks = @(
            "policy_required_preflight_and_junction_resolution",
            "approved_outside_root_save_and_delete",
            "dangling_file_symlink_denial_and_exact_grant",
            "rvt_create_read_identity_save_as",
            "model_rejection_commit_and_rollback",
            "rvt_save_close_reopen_observed_effects",
            "partial_delete_close_observation",
            "rvt_and_rfa_delete",
            "rfa_family_type_save_close_reopen"
        )
    } | ConvertTo-Json -Depth 6
}
finally {
    [System.IO.File]::Delete($danglingLink)
    if (Test-Path $junction) {
        [System.IO.Directory]::Delete($junction)
    }
    if (Test-Path $outsideDirectory) {
        Remove-Item $outsideDirectory -Recurse -Force
    }
}
