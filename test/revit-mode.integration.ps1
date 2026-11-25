# Live (Windows seat, Revit running): the add-in's outside-root check and the API bridge's refusals in
# the mode this install resolves (spec #10 "What Dev Mode Turns Off", the add-in and bridge rows).
# The standard and dev cases sit side by side; run it once on a standard install and once on a Dev
# Mode install. It talks to the add-in's pipe directly, as revit-broker.integration.ps1 does, with
# that script's in-root fixture templates. Printing is left to the acceptance run (AC-5).
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

# Set-StrictMode rejects absent properties; responses omit null fields.
function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Assert-Status($Response, [string]$Expected, [string]$Label) {
    Assert-True ($Response.status -eq $Expected) "${Label}: expected status $Expected but received $($Response.status): $($Response | ConvertTo-Json -Depth 12 -Compress)"
}

function Get-ErrorCode($Response) {
    return Get-Field (Get-Field $Response "error") "code"
}

# The mode as the installed Node resolver reads it from the two install-owned files; the add-in's
# DriveIt.Core resolver reads the same files under the same rule.
function Get-ResolvedMode {
    $app = Join-Path $env:LOCALAPPDATA "DriveIt\app"
    $output = & (Join-Path $app "runtimes\node\node.exe") (Join-Path $app "server\mode.js")
    return ($output | Out-String | ConvertFrom-Json).mode
}

function Read-Line($Reader, [int]$TimeoutMilliseconds = 120000) {
    $task = $Reader.ReadLineAsync()
    if (-not $task.Wait($TimeoutMilliseconds)) {
        throw "Timed out waiting for the Revit broker."
    }
    return $task.Result
}

function Open-Connection {
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
    Assert-True ($session.processId -eq $ProcessId) "The pipe greeting did not match the requested Revit process."
    return [pscustomobject]@{ Pipe = $pipe; Reader = $reader; Writer = $writer }
}

function Close-Connection($Connection) {
    if ($null -eq $Connection) { return }
    $Connection.Writer.Dispose()
    $Connection.Reader.Dispose()
    $Connection.Pipe.Dispose()
}

function Send-Request($Connection, [hashtable]$Request) {
    if (-not $Request.ContainsKey("id")) {
        $Request.id = [guid]::NewGuid().ToString("N")
    }
    $Connection.Writer.WriteLine(($Request | ConvertTo-Json -Depth 12 -Compress))
    return (Read-Line $Connection.Reader) | ConvertFrom-Json
}

# Spec #28: a write names the documents it changes; each request here works on the document it carries, or on one it
# creates itself, which needs no target.
function Model-Request([hashtable]$Document, [object[]]$Operations) {
    $targets = if ($null -ne $Document -and $Document.uniqueId) { @($Document.uniqueId) } else { @() }
    return @{ type = "model.execute"; workspaceRoot = $WorkspaceRoot; document = $Document; operations = $Operations; targets = @($targets) }
}

# One model.execute on its own connection, outside any hold.
function Invoke-Model([hashtable]$Document, [object[]]$Operations) {
    $connection = Open-Connection
    try {
        return Send-Request $connection (Model-Request $Document $Operations)
    }
    finally {
        Close-Connection $connection
    }
}

function Document-Target([string]$UniqueId) {
    return @{ uniqueId = $UniqueId; path = $null }
}

function Handle($Value) {
    return @{ '$h' = $Value.'$h' }
}

$script:hold = $null
function Invoke-Bridge([hashtable]$Call) {
    return Send-Request $script:hold @{ type = "bridge.call"; call = $Call }
}

function Begin-Hold([string]$Name) {
    $script:hold = Open-Connection
    # Every hold here works on the disposable model, its one target (spec #28).
    $begun = Send-Request $script:hold @{ id = "mode-$Name-$runId"; type = "hold.begin"; hold = @{ displayName = "Mode integration: $Name"; timeLimitMs = 120000; targets = @($documentId) } }
    Assert-Status $begun "held" "hold.begin $Name"
}

function End-Hold([string]$Outcome) {
    try {
        $ended = Send-Request $script:hold @{ type = "hold.end"; end = @{ outcome = $Outcome } }
        Assert-Status $ended "ended" "hold.end"
        return $ended.hold
    }
    finally {
        Close-Connection $script:hold
        $script:hold = $null
    }
}

function Level-Names([string]$UniqueId) {
    $read = Invoke-Model (Document-Target $UniqueId) @(@{ type = "read_document"; arguments = @{} })
    Assert-Status $read "succeeded" "read_document"
    return @(@(Get-Field $read.document "levels") | ForEach-Object { $_.name })
}

$mode = Get-ResolvedMode
Assert-True ($mode -in "standard", "dev") "The installed resolver returned the mode '$mode'."
$dev = $mode -eq "dev"
$runId = [guid]::NewGuid().ToString("N")
$projectTemplate = Join-Path $WorkspaceRoot "broker-project.rte"
$rvtPath = Join-Path $WorkspaceRoot "mode-$runId.rvt"
$outsideDirectory = Join-Path $env:TEMP "drive-it-mode-$runId"
$outsideRvt = Join-Path $outsideDirectory "mode-outside.rvt"
$directRvt = Join-Path $outsideDirectory "mode-direct.rvt"
$checks = [System.Collections.Generic.List[string]]::new()
Assert-True (Test-Path $projectTemplate -PathType Leaf) "Missing in-root project template $projectTemplate"
New-Item -ItemType Directory -Force $outsideDirectory | Out-Null
$documentId = $null

try {
    # --- Add-in outside-root check (WorkspacePolicy.cs, DocumentDispatcher) ---
    $outside = Invoke-Model $null @(
        @{ type = "create_document"; arguments = @{ kind = "rvt"; templatePath = $projectTemplate } },
        @{ type = "save_as_document"; arguments = @{ destinationPath = $outsideRvt; overwrite = $true } }
    )
    if ($dev) {
        Assert-Status $outside "succeeded" "dev: outside-root save-as with no decision"
        Assert-True ($null -eq (Get-Field $outside "policyRequests")) "dev: the outside-root save-as asked for a decision."
        Assert-True (Test-Path $outsideRvt -PathType Leaf) "dev: the outside-root save-as did not create the file."
        $deleted = Invoke-Model (Document-Target $outside.document.uniqueId) @(@{ type = "delete_document"; arguments = @{} })
        Assert-Status $deleted "succeeded" "dev: outside-root delete with no decision"
        Assert-True (-not (Test-Path $outsideRvt)) "dev: the outside-root delete left the file."
        $checks.Add("dev_outside_root_save_and_delete_without_decision")
    }
    else {
        Assert-Status $outside "policy_required" "standard: outside-root save-as"
        Assert-True (-not (Test-Path $outsideRvt)) "standard: policy_required created the outside-root file."
        $checks.Add("standard_outside_root_policy_required")
    }

    # --- Bridge refusals, in one hold on a disposable in-root model ---
    $created = Invoke-Model $null @(
        @{ type = "create_document"; arguments = @{ kind = "rvt"; templatePath = $projectTemplate } },
        @{ type = "save_as_document"; arguments = @{ destinationPath = $rvtPath; overwrite = $true } }
    )
    Assert-Status $created "succeeded" "create the disposable model"
    $documentId = $created.document.uniqueId
    $kept = "Mode kept $runId"
    $committed = "Mode committed $runId"
    $leftOpen = "Mode left open $runId"

    Begin-Hold "refusals"
    $document = (Invoke-Bridge @{ op = "document"; document = @{ uniqueId = $documentId } }).value
    Assert-True ($null -ne (Get-Field $document '$h')) "The document did not come back as a handle."

    # RequireAllowed: a System.Type.
    $type = Invoke-Bridge @{ op = "call"; target = (Handle $document); member = "GetType"; args = @() }
    Assert-Status $type "succeeded" "GetType()"
    if ($dev) {
        Assert-True ($null -ne (Get-Field $type.value '$h')) "dev: GetType() did not return a handle: $($type.value | ConvertTo-Json -Compress)"
        $name = Invoke-Bridge @{ op = "get"; target = (Handle $type.value); member = "FullName" }
        Assert-True ($name.value -eq "Autodesk.Revit.DB.Document") "dev: the type handle's FullName was '$($name.value)'."
    }
    else {
        Assert-True ($null -ne (Get-Field $type.value '$type') -and $null -eq (Get-Field $type.value '$h')) "standard: GetType() did not answer with text."
    }
    $checks.Add("${mode}_require_allowed")

    # LeaveTheSession: reload latest (the model is not workshared, so Revit itself refuses it in dev).
    $options = Invoke-Bridge @{ op = "call"; target = @{ '$path' = "Autodesk.Revit.DB.ReloadLatestOptions" }; args = @() }
    Assert-Status $options "succeeded" "ReloadLatestOptions()"
    $reload = Invoke-Bridge @{ op = "call"; target = (Handle $document); member = "ReloadLatest"; args = @((Handle $options.value)) }
    Assert-Status $reload "failed" "ReloadLatest on a model that is not workshared"
    if ($dev) {
        Assert-True ((Get-ErrorCode $reload) -eq "revit_api_error") "dev: ReloadLatest was not passed to Revit: $(Get-ErrorCode $reload)."
    }
    else {
        Assert-True ((Get-ErrorCode $reload) -eq "member_not_allowed") "standard: ReloadLatest was not refused: $(Get-ErrorCode $reload)."
    }
    $checks.Add("${mode}_leave_the_session")

    # BuiltInOnly: Document.SaveAs straight to a path outside the root.
    $saveAs = Invoke-Bridge @{ op = "call"; target = (Handle $document); member = "SaveAs"; args = @($directRvt) }
    if ($dev) {
        Assert-Status $saveAs "succeeded" "dev: Document.SaveAs outside the root"
        Assert-True (Test-Path $directRvt -PathType Leaf) "dev: Document.SaveAs did not write the file."
    }
    else {
        Assert-True ((Get-ErrorCode $saveAs) -eq "member_not_allowed") "standard: Document.SaveAs was not refused: $(Get-ErrorCode $saveAs)."
        Assert-True (-not (Test-Path $directRvt)) "standard: the refused Document.SaveAs wrote the file."
    }
    $checks.Add("${mode}_built_in_only")

    # OwnedByDriveIt: a script-made Transaction.
    $transaction = Invoke-Bridge @{ op = "call"; target = @{ '$path' = "Autodesk.Revit.DB.Transaction" }; args = @((Handle $document), "Mode integration") }
    if (-not $dev) {
        Assert-True ((Get-ErrorCode $transaction) -eq "member_not_allowed") "standard: a script-made Transaction was not refused: $(Get-ErrorCode $transaction)."
        $summary = End-Hold "rollback"
        Assert-True ($summary.outcome -eq "rolled_back") "standard: the hold ended $($summary.outcome)."
        $checks.Add("standard_owned_by_drive_it")
    }
    else {
        # Committed by the script, then the run fails: the hold rolls it back. A second one is left open.
        Assert-Status $transaction "succeeded" "dev: construct a Transaction"
        function New-Level($Transaction, [string]$Name) {
            Assert-Status (Invoke-Bridge @{ op = "call"; target = (Handle $Transaction); member = "Start"; args = @() }) "succeeded" "dev: Transaction.Start"
            $level = Invoke-Bridge @{ op = "call"; target = @{ '$path' = "Autodesk.Revit.DB.Level.Create" }; args = @((Handle $document), 40) }
            Assert-Status $level "succeeded" "dev: Level.Create"
            Assert-Status (Invoke-Bridge @{ op = "set"; target = (Handle $level.value); member = "Name"; value = $Name }) "succeeded" "dev: name the level"
        }
        New-Level $transaction.value $committed
        Assert-Status (Invoke-Bridge @{ op = "call"; target = (Handle $transaction.value); member = "Commit"; args = @() }) "succeeded" "dev: Transaction.Commit"
        $open = Invoke-Bridge @{ op = "call"; target = @{ '$path' = "Autodesk.Revit.DB.Transaction" }; args = @((Handle $document), "Mode left open") }
        Assert-Status $open "succeeded" "dev: construct a second Transaction"
        New-Level $open.value $leftOpen
        $summary = End-Hold "rollback"
        Assert-True ($summary.outcome -eq "rolled_back") "dev: the hold ended $($summary.outcome)."
        Assert-True (@($summary.documents | Where-Object { $_.state -eq "rollback_failed" }).Count -eq 0) "dev: a rollback failed: $($summary | ConvertTo-Json -Depth 6 -Compress)"
        $names = Level-Names $documentId
        Assert-True (-not ($names -contains $committed) -and -not ($names -contains $leftOpen)) "dev: the failed run kept a script transaction's level: $($names -join ', ')."
        $checks.Add("dev_script_transactions_roll_back_with_the_hold")

        # A direct save after a script transaction keeps the run's changes before it, as save_document does.
        Begin-Hold "commit-point"
        $document = (Invoke-Bridge @{ op = "document"; document = @{ uniqueId = $documentId } }).value
        $transaction = Invoke-Bridge @{ op = "call"; target = @{ '$path' = "Autodesk.Revit.DB.Transaction" }; args = @((Handle $document), "Mode kept") }
        Assert-Status $transaction "succeeded" "dev: construct a Transaction to keep"
        New-Level $transaction.value $kept
        Assert-Status (Invoke-Bridge @{ op = "call"; target = (Handle $transaction.value); member = "Commit"; args = @() }) "succeeded" "dev: Transaction.Commit before the save"
        Assert-Status (Invoke-Bridge @{ op = "call"; target = (Handle $document); member = "Save"; args = @() }) "succeeded" "dev: Document.Save after a script transaction"
        $summary = End-Hold "rollback"
        Assert-True (@($summary.documents | Where-Object { $_.commitPoint }).Count -eq 1) "dev: the direct save was not a commit point: $($summary | ConvertTo-Json -Depth 6 -Compress)"
        Assert-True ((Level-Names $documentId) -contains $kept) "dev: the direct save did not keep the level made before it."
        $checks.Add("dev_direct_save_is_a_commit_point")

        # A direct save while a script transaction is open is refused, and the run's group stays the hold's:
        # the failed run still rolls back the level committed before the refused save.
        $before = "Mode before refused save $runId"
        $during = "Mode during refused save $runId"
        Begin-Hold "save-while-open"
        $document = (Invoke-Bridge @{ op = "document"; document = @{ uniqueId = $documentId } }).value
        $transaction = Invoke-Bridge @{ op = "call"; target = @{ '$path' = "Autodesk.Revit.DB.Transaction" }; args = @((Handle $document), "Mode before") }
        Assert-Status $transaction "succeeded" "dev: construct a Transaction before the refused save"
        New-Level $transaction.value $before
        Assert-Status (Invoke-Bridge @{ op = "call"; target = (Handle $transaction.value); member = "Commit"; args = @() }) "succeeded" "dev: Transaction.Commit before the refused save"
        $open = Invoke-Bridge @{ op = "call"; target = @{ '$path' = "Autodesk.Revit.DB.Transaction" }; args = @((Handle $document), "Mode during") }
        Assert-Status $open "succeeded" "dev: construct a Transaction left open over the save"
        New-Level $open.value $during
        $save = Invoke-Bridge @{ op = "call"; target = (Handle $document); member = "Save"; args = @() }
        Assert-Status $save "failed" "dev: Document.Save while a script transaction is open"
        Assert-True ((Get-ErrorCode $save) -eq "transaction_open") "dev: the save over an open script transaction was not refused as transaction_open: $(Get-ErrorCode $save)."
        $summary = End-Hold "rollback"
        Assert-True ($summary.outcome -eq "rolled_back") "dev: the hold ended $($summary.outcome)."
        Assert-True (@($summary.documents | Where-Object { $_.commitPoint }).Count -eq 0) "dev: the refused save was marked a commit point: $($summary | ConvertTo-Json -Depth 6 -Compress)"
        Assert-True (@($summary.documents | Where-Object { $_.state -eq "rolled_back" }).Count -eq 1) "dev: the document was not rolled back: $($summary | ConvertTo-Json -Depth 6 -Compress)"
        $names = Level-Names $documentId
        Assert-True (-not ($names -contains $before) -and -not ($names -contains $during)) "dev: the failed run kept a level across the refused save: $($names -join ', ')."
        $checks.Add("dev_save_refused_while_a_script_transaction_is_open")

        # A transaction started again after a direct save runs inside a fresh run group: kept before the save,
        # rolled back after it.
        $keptAgain = "Mode kept before reuse $runId"
        $reused = "Mode reused after save $runId"
        Begin-Hold "reuse-after-save"
        $document = (Invoke-Bridge @{ op = "document"; document = @{ uniqueId = $documentId } }).value
        $transaction = Invoke-Bridge @{ op = "call"; target = @{ '$path' = "Autodesk.Revit.DB.Transaction" }; args = @((Handle $document), "Mode reused") }
        Assert-Status $transaction "succeeded" "dev: construct a Transaction to reuse"
        New-Level $transaction.value $keptAgain
        Assert-Status (Invoke-Bridge @{ op = "call"; target = (Handle $transaction.value); member = "Commit"; args = @() }) "succeeded" "dev: Transaction.Commit before the save"
        Assert-Status (Invoke-Bridge @{ op = "call"; target = (Handle $document); member = "Save"; args = @() }) "succeeded" "dev: Document.Save between the two uses"
        New-Level $transaction.value $reused
        Assert-Status (Invoke-Bridge @{ op = "call"; target = (Handle $transaction.value); member = "Commit"; args = @() }) "succeeded" "dev: Transaction.Commit after the save"
        $summary = End-Hold "rollback"
        Assert-True ($summary.outcome -eq "rolled_back") "dev: the hold ended $($summary.outcome)."
        Assert-True (@($summary.documents | Where-Object { $_.state -eq "rolled_back" -and $_.commitPoint }).Count -eq 1) "dev: the reused transaction did not run inside a rolled-back run group: $($summary | ConvertTo-Json -Depth 6 -Compress)"
        $names = Level-Names $documentId
        Assert-True ($names -contains $keptAgain) "dev: the direct save did not keep the level made before it."
        Assert-True (-not ($names -contains $reused)) "dev: the failed run kept the level from the transaction reused after the save."
        $checks.Add("dev_reused_transaction_after_save_rolls_back")
    }

    [ordered]@{ status = "succeeded"; mode = $mode; processId = $ProcessId; checks = @($checks) } | ConvertTo-Json -Depth 4
}
finally {
    if ($null -ne $script:hold) {
        Close-Connection $script:hold
    }
    if ($null -ne $documentId) {
        # In dev the model may now be outside the root; there delete_document needs no decision.
        try {
            Invoke-Model (Document-Target $documentId) @(@{ type = "delete_document"; arguments = @{} }) | Out-Null
        }
        catch {
            Write-Warning "Could not delete the disposable model: $_"
        }
    }
    [System.IO.File]::Delete($rvtPath)
    if (Test-Path $outsideDirectory) {
        Remove-Item $outsideDirectory -Recurse -Force
    }
}
