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
$annotationTemplate = Join-Path $WorkspaceRoot "broker-annotation.rft"
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

function Invoke-Capture([string]$DocumentId, $ViewId, [int]$PixelSize = 512, [hashtable]$Marks = $null) {
    $staging = Join-Path $captureRoot (".tmp-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $staging | Out-Null
    $target = Join-Path $staging "capture.png"
    $viewValue = if ($null -eq $ViewId) { $null } else { [string]$ViewId }
    $capture = @{ viewId = $viewValue; pixelSize = $PixelSize; targetPath = $target }
    if ($null -ne $Marks) {
        foreach ($key in $Marks.Keys) { $capture[$key] = $Marks[$key] }
    }
    $response = Invoke-Broker @{
        document = Document-Target $DocumentId
        capture = $capture
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
    Assert-True ([Math]::Max($width, $height) -le 514) "${Label}: ${width}x${height} exceeds pixelSize 512 on its longer side."
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

function Get-PngSize([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    return "$([System.Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($bytes, 16)))x$([System.Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($bytes, 20)))"
}

$markedViews = [System.Collections.Generic.List[string]]::new()

# Element marks: a marked capture keeps the export's size and returns a well-formed legend, a
# capture without marks returns none, requested ids get reasons, and a malformed id or a view kind
# without marks fails with no file left. $NotMarkable is an existing id of a kind never marked here.
function Test-Marks([string]$DocumentId, [string]$Kind, [object[]]$Views, [string]$NotMarkable) {
    foreach ($type in @("FloorPlan", "ThreeD", "Elevation", "Section")) {
        $view = $Views | Where-Object { $_.type -eq $type } | Select-Object -First 1
        if ($null -eq $view) { continue }
        $plain = Invoke-Capture $DocumentId $view.id
        Assert-Captured $plain "$Kind $type without marks"
        Assert-True ($null -eq (Get-Field $plain.capture "marks")) "$Kind ${type}: a capture without marks returned marks."
        $shot = Invoke-Capture $DocumentId $view.id 512 @{ marks = $true }
        Assert-Captured $shot "$Kind $type marked"
        Assert-True ((Get-PngSize $shot.capture.outputPath) -eq (Get-PngSize $plain.capture.outputPath)) "$Kind ${type}: the marked image changed size."
        $marks = Get-Field $shot.capture "marks"
        Assert-True ($null -ne $marks) "$Kind ${type}: a marked capture returned no marks."
        Assert-True ($null -eq (Get-Field $marks "notMarked")) "$Kind ${type}: notMarked without markElementIds."
        Assert-True ([int]$marks.omitted -ge 0) "$Kind ${type}: omitted is missing."
        $number = 0
        foreach ($row in @(Get-Field $marks "legend")) {
            $number++
            Assert-True ($row.mark -eq $number -and $row.elementId -match '^[1-9][0-9]*$') "$Kind ${type}: legend row $number is malformed."
            $bounds = Get-Field $row "bounds"
            if ($null -ne $bounds) {
                Assert-True ($row.x -ge $bounds.x -and $row.x -le $bounds.x + $bounds.width -and $row.y -ge $bounds.y -and $row.y -le $bounds.y + $bounds.height) "$Kind ${type}: mark $number lies outside its bounds."
            }
        }
        $markedViews.Add("$Kind $type '$($view.name)' marks=$number omitted=$($marks.omitted)")
    }
    $view = $Views | Where-Object { $_.type -eq "ThreeD" } | Select-Object -First 1
    $requested = Invoke-Capture $DocumentId $view.id 512 @{ markElementIds = @("999999999", $NotMarkable, "999999999") }
    Assert-Captured $requested "$Kind 3D markElementIds"
    $reasons = @{}
    foreach ($row in @($requested.capture.marks.notMarked)) { $reasons[$row.elementId] = $row.reason }
    Assert-True ($reasons["999999999"] -eq "not_found" -and $reasons[$NotMarkable] -eq "not_markable" -and $reasons.Count -eq 2) "$Kind markElementIds reasons were $($reasons | ConvertTo-Json -Compress)."
    Assert-True (@($requested.capture.marks.legend).Count -eq 0) "$Kind markElementIds marked an element that was not requested."
    Assert-CaptureRejected (Invoke-Capture $DocumentId $view.id 512 @{ markElementIds = @("12a") }) "invalid_element_id" "$Kind malformed mark id"
}

$modelRejections = [System.Collections.Generic.List[string]]::new()

# A rejected or rolled-back model batch reports its code and keeps no effects.
function Assert-ModelRejected($Response, [string]$Code, [string]$Label) {
    Assert-Status $Response "failed"
    $errorCode = Get-Field (Get-Field $Response "error") "code"
    Assert-True ($errorCode -eq $Code) "${Label}: expected $Code but received ${errorCode}: $(Get-Field (Get-Field $Response 'error') 'message')"
    Assert-True (@($Response.changes).Count -eq 0 -and @($Response.affectedElements).Count -eq 0 -and $null -eq (Get-Field $Response "createdViews")) "${Label}: the rejection reported effects."
    $modelRejections.Add("$Label -> $Code")
}

function Invoke-Create3DView([string]$DocumentId, [object[]]$Names) {
    $operations = @($Names | ForEach-Object { if ($null -eq $_) { @{ type = "create_3d_view"; arguments = @{} } } else { @{ type = "create_3d_view"; arguments = @{ name = $_ } } } })
    return Invoke-Broker @{ document = Document-Target $DocumentId; operations = $operations }
}

# create_3d_view: a named and an unnamed isometric view, a duplicate-name rejection, and a
# capture of the created view by the id the receipt returned.
function Test-Create3DView([string]$DocumentId, [string]$Kind) {
    $name = "Drive It 3D $Kind"
    $created = Invoke-Broker @{ document = Document-Target $DocumentId; operations = @(@{ type = "create_3d_view"; arguments = @{ name = $name } }) }
    Assert-Status $created "succeeded"
    $views = @(Get-Field $created "createdViews")
    Assert-True ($views.Count -eq 1) "$Kind create_3d_view returned $($views.Count) created views."
    $view = $views[0]
    Assert-True ($view.id -is [string] -and $view.id -match '^[1-9][0-9]*$') "$Kind create_3d_view returned a non-string view id: $($view.id)."
    Assert-True ($view.name -eq $name -and $view.type -eq "ThreeD") "$Kind create_3d_view returned '$($view.name)' ($($view.type))."
    Assert-True ($created.affectedElements -contains [long]$view.id) "$Kind create_3d_view did not list the view in affectedElements."
    $duplicate = Invoke-Broker @{ document = Document-Target $DocumentId; operations = @(@{ type = "create_3d_view"; arguments = @{ name = $name } }) }
    Assert-Status $duplicate "failed"
    Assert-True ((Get-Field (Get-Field $duplicate "error") "code") -eq "duplicate_view_name") "$Kind duplicate 3D view name was not rejected as duplicate_view_name."
    Assert-True ($duplicate.changes.Count -eq 0 -and $null -eq (Get-Field $duplicate "createdViews")) "$Kind duplicate 3D view rejection reported effects."
    Assert-ModelRejected (Invoke-Create3DView $DocumentId @("Drive It Twin $Kind", "Drive It Twin $Kind")) "duplicate_view_name" "$Kind in-batch duplicate name"
    Assert-ModelRejected (Invoke-Create3DView $DocumentId @("")) "invalid_model_change" "$Kind empty name"
    Assert-ModelRejected (Invoke-Create3DView $DocumentId @("Drive It {3D} $Kind")) "invalid_model_change" "$Kind name with a character Revit forbids"
    $twin = Invoke-Create3DView $DocumentId @("Drive It Twin $Kind")
    Assert-Status $twin "succeeded"
    Assert-True (@(Get-Field $twin "createdViews")[0].name -eq "Drive It Twin $Kind") "$Kind a name from a rejected batch was not free afterwards."
    $unnamed = Invoke-Broker @{ document = Document-Target $DocumentId; operations = @(@{ type = "create_3d_view"; arguments = @{} }) }
    Assert-Status $unnamed "succeeded"
    $unnamedView = @(Get-Field $unnamed "createdViews")[0]
    Assert-True (-not [string]::IsNullOrWhiteSpace($unnamedView.name) -and $unnamedView.id -ne $view.id) "$Kind unnamed create_3d_view returned no distinct named view."
    $shot = Invoke-Capture $DocumentId $view.id
    Assert-Captured $shot "$Kind created 3D"
    Assert-True ($shot.capture.viewId -eq $view.id -and $shot.capture.viewType -eq "ThreeD") "$Kind created 3D: the capture named another view."
    return $view
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
Assert-True (Test-Path $annotationTemplate -PathType Leaf) "Missing in-root annotation family template $annotationTemplate"

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

    Test-Create3DView $rvtId "RVT" | Out-Null
    $rvtViews = @(Test-ViewCaptures $rvtId "RVT" @("FloorPlan", "ThreeD"))
    Assert-CaptureRejected (Invoke-Capture $rvtId $level.id) "not_a_view" "RVT level element"
    # Levels are not marked in 3D views.
    Test-Marks $rvtId "RVT" $rvtViews ([string]$level.id)

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
    # With two documents open, a bare viewId is ambiguous and must name its document.
    Assert-CaptureRejected (Invoke-Capture $null $rvtViews[0].id) "document_required" "viewId without document, two documents open"
    Assert-Status (Invoke-Broker @{ document = Document-Target $crossFamily.document.uniqueId; operations = @(@{ type = "close_document"; arguments = @{} }) }) "succeeded"

    $rollback = Invoke-Broker @{
        document = Document-Target $rvtId
        operations = @(
            @{ type = "create_3d_view"; arguments = @{ name = "Drive It Rollback 3D" } },
            @{ type = "create_level"; arguments = @{ name = "Drive It Rollback"; elevation = 6.0 } },
            @{ type = "create_wall"; arguments = @{ baseLevelId = $level.id; height = 10.0; start = @{ x = 0; y = 0; z = 0 }; end = @{ x = 0; y = 0; z = 5 } } }
        )
    }
    Assert-Status $rollback "failed"
    $rollbackCheck = $rollback.checks | Where-Object { $_.name -eq "transaction_rollback" } | Select-Object -First 1
    Assert-True ($null -ne $rollbackCheck -and $rollbackCheck.passed) "Revit did not confirm rollback of the failed model batch."
    Assert-True ($rollback.changes.Count -eq 0) "The rolled-back model batch retained reported changes."
    Assert-True ($null -eq (Get-Field $rollback "createdViews")) "The rolled-back model batch retained a created view."
    Assert-True ($rollback.affectedElements.Count -eq 0) "The rolled-back model batch retained affected elements."
    Assert-True ($rollback.document.levels.name -notcontains "Drive It Rollback") "The first change survived transaction rollback."
    # The rolled-back view is gone from the document: its name is free again.
    $recreated = Invoke-Create3DView $rvtId @("Drive It Rollback 3D")
    Assert-Status $recreated "succeeded"
    Assert-True (@(Get-Field $recreated "createdViews")[0].name -eq "Drive It Rollback 3D") "The rolled-back 3D view name could not be re-created."

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
    Test-Create3DView $familyId "RFA" | Out-Null
    $familyViews = @(Test-ViewCaptures $familyId "RFA" @("ThreeD"))
    # A view is never marked.
    Test-Marks $familyId "RFA" $familyViews ([string]$familyViews[0].id)
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

    # Revit allows no 3D view in an annotation family; the batch rolls back with a specific code.
    $annotation = Invoke-Broker @{
        document = $null
        operations = @(@{ type = "create_document"; arguments = @{ kind = "rfa"; templatePath = $annotationTemplate } })
    }
    Assert-Status $annotation "succeeded"
    $annotationRefused = Invoke-Create3DView $annotation.document.uniqueId @("Drive It Annotation 3D")
    Assert-ModelRejected $annotationRefused "view_creation_not_allowed" "annotation family"
    $annotationRollback = $annotationRefused.checks | Where-Object { $_.name -eq "transaction_rollback" } | Select-Object -First 1
    Assert-True ($null -ne $annotationRollback -and $annotationRollback.passed) "Revit did not confirm rollback of the refused annotation-family view."
    Assert-Status (Invoke-Broker @{ document = Document-Target $annotation.document.uniqueId; operations = @(@{ type = "close_document"; arguments = @{} }) }) "succeeded"

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
        markedViews = @($markedViews)
        modelRejections = @($modelRejections)
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
            "view_capture_rvt_rfa_export_and_rejections",
            "create_3d_view_rvt_rfa_duplicate_rollback_capture",
            "create_3d_view_name_rules_rollback_recreate_annotation_refusal",
            "element_marks_legend_reasons_and_failures"
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
