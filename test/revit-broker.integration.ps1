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

function Invoke-Broker([hashtable]$Request, [string]$Type = "model.execute") {
    if (-not $Request.ContainsKey("id")) {
        $Request.id = [guid]::NewGuid().ToString("N")
    }
    $Request.type = $Type
    if ($Type -eq "model.execute") {
        $Request.workspaceRoot = $WorkspaceRoot
    }
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

# view.capture mirrors the MCP server's file handoff: an empty staging directory under
# _reference-images\<session>, and the add-in exports the one view into it.
$captureRoot = Join-Path $WorkspaceRoot "_reference-images\integration-$runId"
$capturedViews = [System.Collections.Generic.List[string]]::new()
$rejectedViews = [System.Collections.Generic.List[string]]::new()

# Set-StrictMode rejects absent properties; responses omit null fields.
function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Invoke-Capture([string]$DocumentId, $ViewId, [int]$PixelSize = 512) {
    $staging = Join-Path $captureRoot (".tmp-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $staging | Out-Null
    $target = Join-Path $staging "capture.png"
    $viewValue = if ($null -eq $ViewId) { $null } else { [string]$ViewId }
    $response = Invoke-Broker @{
        document = Document-Target $DocumentId
        capture = @{ viewId = $viewValue; pixelSize = $PixelSize; targetPath = $target }
    } "view.capture"
    Assert-True ($response.type -eq "view.capture") "The capture response type was $($response.type)."
    $response | Add-Member -NotePropertyName stagingDirectory -NotePropertyValue $staging -Force
    return $response
}

function Assert-Captured($Response, [string]$Label) {
    Assert-Status $Response "succeeded"
    $path = $Response.capture.outputPath
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "${Label}: the exported PNG is missing."
    Assert-True (@(Get-ChildItem -LiteralPath $Response.stagingDirectory -Force).Count -eq 1) "${Label}: the staging directory holds more than the PNG."
    $bytes = [IO.File]::ReadAllBytes($path)
    $signature = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    for ($index = 0; $index -lt 8; $index++) {
        Assert-True ($bytes[$index] -eq $signature[$index]) "${Label}: the export is not a PNG."
    }
    Assert-True ($Response.capture.documentModifiedBefore -eq $Response.capture.documentModifiedAfter) "${Label}: the capture changed the document's modified state."
    Assert-True (-not $Response.capture.temporaryViewCreated -and -not $Response.capture.transactionStarted) "${Label}: the capture reported a temporary view or transaction."
    $width = [System.Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($bytes, 16))
    $height = [System.Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($bytes, 20))
    $capturedViews.Add("$Label $($Response.capture.viewType) '$($Response.capture.viewName)' ($($Response.capture.viewId)) ${width}x${height} $path")
}

function Assert-CaptureRejected($Response, [string]$Code, [string]$Label) {
    Assert-Status $Response "failed"
    $errorCode = Get-Field (Get-Field $Response "error") "code"
    Assert-True ($errorCode -eq $Code) "${Label}: expected $Code but received ${errorCode}: $(Get-Field (Get-Field $Response 'error') 'message')"
    Assert-True ($null -eq (Get-Field (Get-Field $Response "capture") "outputPath")) "${Label}: a rejected capture reported an output path."
    Assert-True (@(Get-ChildItem -LiteralPath $Response.stagingDirectory -Force).Count -eq 0) "${Label}: a rejected capture left a file."
    $rejectedViews.Add("$Label -> $Code")
}

function Test-ViewCaptures([string]$DocumentId, [string]$Kind, [string[]]$Required) {
    $noActive = Invoke-Capture $DocumentId $null
    Assert-CaptureRejected $noActive "no_active_view" "$Kind background document without viewId"
    $views = @($noActive.capture.availableViews)
    Assert-True ($views.Count -gt 0) "$Kind listed no capturable views."
    $types = @()
    foreach ($type in @("ThreeD", "FloorPlan", "CeilingPlan", "EngineeringPlan", "Elevation", "Section", "Detail")) {
        $view = $views | Where-Object { $_.type -eq $type } | Select-Object -First 1
        if ($null -eq $view) { continue }
        $shot = Invoke-Capture $DocumentId $view.id
        Assert-Captured $shot "$Kind $type"
        Assert-True ($shot.capture.viewId -eq $view.id) "$Kind ${type}: the receipt named another view."
        $types += $type
    }
    foreach ($type in $Required) {
        Assert-True ($types -contains $type) "$Kind has no capturable $type view (captured: $($types -join ', '))."
    }
    foreach ($view in @($noActive.capture.otherViews | Group-Object notCapturable | ForEach-Object { $_.Group[0] })) {
        Assert-CaptureRejected (Invoke-Capture $DocumentId $view.id) $view.notCapturable "$Kind $($view.type) '$($view.name)'"
    }
    Assert-CaptureRejected (Invoke-Capture $DocumentId "999999999") "view_not_found" "$Kind missing view"
    Assert-CaptureRejected (Invoke-Capture $DocumentId $views[0].id 100) "invalid_pixel_size" "$Kind pixelSize 100"
    return $views
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

    $rvtViews = @(Test-ViewCaptures $rvtId "RVT" @("FloorPlan"))
    Assert-CaptureRejected (Invoke-Capture $rvtId $level.id) "not_a_view" "RVT level element"

    # Element ids belong to one document: an RVT view id against an open RFA is not followed.
    $crossFamily = Invoke-Broker @{
        document = $null
        operations = @(@{ type = "create_document"; arguments = @{ kind = "rfa"; templatePath = $familyTemplate } })
    }
    Assert-Status $crossFamily "succeeded"
    $crossObserved = $null
    foreach ($view in $rvtViews) {
        $cross = Invoke-Capture $crossFamily.document.uniqueId $view.id
        if ((Get-Field (Get-Field $cross "error") "code") -eq "not_a_view") { continue }
        Assert-CaptureRejected $cross "view_in_other_document" "RVT view $($view.id) against the RFA"
        $crossObserved = $cross
        break
    }
    Assert-True ($null -ne $crossObserved) "No RVT view id was free in the RFA to prove cross-document rejection."
    Assert-Status (Invoke-Broker @{ document = Document-Target $crossFamily.document.uniqueId; operations = @(@{ type = "close_document"; arguments = @{} }) }) "succeeded"

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
    Assert-CaptureRejected (Invoke-Capture $rvtId $rvtViews[0].id) "stale_document_identity" "closed RVT"

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
    Test-ViewCaptures $familyId "RFA" @("ThreeD") | Out-Null
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
        captureDirectory = $captureRoot
        capturedViews = @($capturedViews)
        rejectedViews = @($rejectedViews)
        checks = @(
            "policy_required_preflight_and_junction_resolution",
            "approved_outside_root_save_and_delete",
            "dangling_file_symlink_denial_and_exact_grant",
            "rvt_create_read_identity_save_as",
            "model_rejection_commit_and_rollback",
            "rvt_save_close_reopen_observed_effects",
            "partial_delete_close_observation",
            "rvt_and_rfa_delete",
            "rfa_family_type_save_close_reopen",
            "view_capture_rvt_rfa_export_and_rejections"
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
