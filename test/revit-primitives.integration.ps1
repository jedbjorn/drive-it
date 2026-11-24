# Live checks for the built-in read primitives (spec #9 Phase A, criteria 2-4) over the add-in's pipe.
# A document the broker creates is never active in Revit's window, so the run has three phases:
#   Prepare   - Revit open with no document: get_active_document fails with no_active_document; then
#               build the fixture (5 walls on two levels, a named 3D view), save it, and close it.
#   Active    - Revit restarted with the fixture as its active document: active-document targeting,
#               queries, paging, limits, model unchanged, the set/get selection round trip,
#               document_not_active for a background document, and outside-root policy for save,
#               delete, and save-as before get_active_document (ends with the fixture saved back
#               to its own path).
#   Selection - after a person (or windows-mcp) selects a wall in Revit's window: report what
#               get_selection returns, with each element's Length, so it can be matched to the click.
# Each phase prints one JSON summary and throws on the first failed assertion.
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [Parameter(Mandatory = $true)]
    [ValidateSet("Prepare", "Active", "Selection")]
    [string]$Phase,
    [Parameter(Mandatory = $true)]
    [string]$FixturePath,
    [string]$ProjectTemplate,
    [string]$WorkspaceRoot = "C:\DriveIt"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$expectationsPath = "$FixturePath.json"
$receiptLog = Join-Path $WorkspaceRoot "primitives-receipts-$Phase-$([guid]::NewGuid().ToString('N')).jsonl"
$checks = [System.Collections.Generic.List[string]]::new()

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Pass([string]$Name) { $checks.Add($Name) }

function Read-Line($Reader, [int]$TimeoutMilliseconds = 120000) {
    $task = $Reader.ReadLineAsync()
    if (-not $task.Wait($TimeoutMilliseconds)) { throw "Timed out waiting for the Revit broker." }
    return $task.Result
}

function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Invoke-Broker([object[]]$Operations, $Document = $null, [string]$Root = $WorkspaceRoot, $Approval = $null) {
    $request = @{
        id = [guid]::NewGuid().ToString("N")
        type = "model.execute"
        workspaceRoot = $Root
        document = $Document
        operations = $Operations
    }
    if ($null -ne $Approval) { $request.outsideRootApproval = $Approval }
    $json = ConvertTo-Json -InputObject $request -Depth 12 -Compress
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(".", "drive-it-$ProcessId",
        [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    try {
        $pipe.Connect(10000)
        $encoding = [System.Text.UTF8Encoding]::new($false)
        $reader = [System.IO.StreamReader]::new($pipe, $encoding, $false, 8192, $true)
        $writer = [System.IO.StreamWriter]::new($pipe, $encoding, 8192, $true)
        $writer.NewLine = "`n"
        $writer.AutoFlush = $true
        $session = (Read-Line $reader 10000) | ConvertFrom-Json
        Assert-True ($session.processId -eq $ProcessId) "The pipe greeting did not match the requested Revit process."
        $writer.WriteLine($json)
        $line = Read-Line $reader
        $response = $line | ConvertFrom-Json
        Assert-True ($response.id -eq $request.id) "The response id did not match the request."
        [ordered]@{ request = $request; response = $response } | ConvertTo-Json -Depth 14 -Compress |
            Add-Content -Path $receiptLog -Encoding UTF8
        return $response
    }
    finally {
        $pipe.Dispose()
    }
}

function Op([string]$Type, [hashtable]$Arguments = @{}) { return @{ type = $Type; arguments = $Arguments } }

function Target([string]$UniqueId) { return @{ uniqueId = $UniqueId; path = $null } }

function Assert-Status($Response, [string]$Expected, [string]$Label) {
    if ($Response.status -ne $Expected) {
        throw "${Label}: expected $Expected, received $($Response.status): $($Response | ConvertTo-Json -Depth 12 -Compress)"
    }
}

function Assert-Failure($Response, [string]$Code, [string]$Label) {
    Assert-Status $Response "failed" $Label
    Assert-True ($Response.error.code -eq $Code) "${Label}: expected $Code, received $($Response.error.code): $($Response.error.message)"
}

# One read primitive against a document; returns its results entry.
function Read-Primitive([string]$DocumentId, [string]$Type, [hashtable]$Arguments = @{}) {
    $response = Invoke-Broker @(Op $Type $Arguments) (Target $DocumentId)
    Assert-Status $response "succeeded" $Type
    Assert-True (@($response.results).Count -eq 1) "$Type returned $(@($response.results).Count) results entries."
    Assert-True (@($response.changes).Count -eq 0) "$Type reported changes: $($response.changes -join '; ')"
    return $response.results[0]
}

function Get-Active {
    $response = Invoke-Broker @(Op "get_active_document") $null
    Assert-Status $response "succeeded" "get_active_document"
    Assert-True ($null -eq $response.results[0]) "get_active_document put an output in results."
    return $response
}

function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals([System.IO.Path]::GetFullPath($Left), [System.IO.Path]::GetFullPath($Right),
        [System.StringComparison]::OrdinalIgnoreCase)
}

if ($Phase -eq "Prepare") {
    Assert-True (-not [string]::IsNullOrWhiteSpace($ProjectTemplate)) "Prepare needs -ProjectTemplate (an .rte inside the workspace root)."

    # Criterion 2: no document is active, so get_active_document fails and lists what is open.
    $none = Invoke-Broker @(Op "get_active_document") $null
    Assert-Failure $none "no_active_document" "get_active_document with no active document"
    Assert-True ($null -eq $none.results[0]) "A failed get_active_document carried a result."
    Pass "no_active_document_without_open_model"

    $created = Invoke-Broker @(Op "create_document" @{ kind = "rvt"; templatePath = $ProjectTemplate }) $null
    Assert-Status $created "succeeded" "create fixture"
    $documentId = $created.document.uniqueId
    $levels = @($created.document.levels | Sort-Object elevation)
    Assert-True ($levels.Count -ge 2) "The project template has fewer than two levels."
    $lower = $levels[0]
    $upper = $levels[1]

    # Lengths 10, 20, 30 ft on the lower level and 12, 24 ft on the upper one tell the walls apart
    # in a plan and through their Length parameter.
    $walls = @(
        @{ level = $lower.id; length = 10.0; y = 0.0; height = 10.0 },
        @{ level = $lower.id; length = 20.0; y = 10.0; height = 10.0 },
        @{ level = $lower.id; length = 30.0; y = 20.0; height = 10.0 },
        @{ level = $upper.id; length = 12.0; y = 40.0; height = 8.0 },
        @{ level = $upper.id; length = 24.0; y = 50.0; height = 8.0 }
    )
    $operations = @($walls | ForEach-Object {
        Op "create_wall" @{
            baseLevelId = $_.level
            start = @{ x = 0.0; y = $_.y; z = 0.0 }
            end = @{ x = $_.length; y = $_.y; z = 0.0 }
            height = $_.height
        }
    })
    $operations += Op "create_3d_view" @{ name = "F8 Primitives 3D" }
    $built = Invoke-Broker $operations (Target $documentId)
    Assert-Status $built "succeeded" "build fixture"
    $wallIds = @($built.affectedElements | Select-Object -First $walls.Count)
    $viewId = [long]$built.createdViews[0].id

    $saved = Invoke-Broker @(Op "save_as_document" @{ destinationPath = $FixturePath; overwrite = $true }) (Target $documentId)
    Assert-Status $saved "succeeded" "save fixture"
    $closed = Invoke-Broker @(Op "close_document") (Target $documentId)
    Assert-Status $closed "succeeded" "close fixture"
    Pass "fixture_built_saved_closed"

    $expectations = [ordered]@{
        fixturePath = $FixturePath
        lowerLevelId = $lower.id
        upperLevelId = $upper.id
        walls = @(for ($i = 0; $i -lt $walls.Count; $i++) {
            [ordered]@{ id = $wallIds[$i]; levelId = $walls[$i].level; length = $walls[$i].length; height = $walls[$i].height }
        })
        viewId = $viewId
        viewName = "F8 Primitives 3D"
    }
    $expectations | ConvertTo-Json -Depth 6 | Set-Content -Path $expectationsPath -Encoding UTF8
    [ordered]@{ status = "succeeded"; phase = $Phase; processId = $ProcessId; receiptLog = $receiptLog; checks = @($checks); expectations = $expectations } |
        ConvertTo-Json -Depth 8
    return
}

$expected = Get-Content -Raw $expectationsPath | ConvertFrom-Json
$expectedIds = @($expected.walls | ForEach-Object { [long]$_.id } | Sort-Object)

if ($Phase -eq "Selection") {
    $active = Get-Active
    Assert-True (Same-Path $active.document.path $FixturePath) "The fixture is not the active document: $($active.document.path)"
    $selected = Read-Primitive $active.document.uniqueId "get_selection"
    $ids = @($selected | ForEach-Object { [long]$_.id })
    $lengths = @()
    if ($ids.Count -gt 0) {
        $parameters = Read-Primitive $active.document.uniqueId "get_parameters" @{ elementIds = $ids; names = @("Length"); includeType = $false }
        $lengths = @($parameters | ForEach-Object {
            $length = @($_.parameters | Where-Object { $_.name -eq "Length" }) | Select-Object -First 1
            [ordered]@{ id = $_.id; length = (Get-Field $length "value"); display = (Get-Field $length "display") }
        })
    }
    [ordered]@{
        status = "succeeded"; phase = $Phase; processId = $ProcessId; receiptLog = $receiptLog
        isModified = $active.document.isModified
        selection = @($selected)
        selectedFixtureWalls = @($ids | Where-Object { $expectedIds -contains $_ })
        lengths = $lengths
    } | ConvertTo-Json -Depth 8
    return
}

# --- Active: criterion 2 (pipe part), criterion 3, criterion 4 round trip and background refusal ---
Assert-True (-not [string]::IsNullOrWhiteSpace($ProjectTemplate)) "Active needs -ProjectTemplate for the background document."
$before = Get-Active
$document = $before.document
Assert-True (Same-Path $document.path $FixturePath) "get_active_document returned $($document.path), not the fixture."
Assert-True ($document.title -eq [System.IO.Path]::GetFileNameWithoutExtension($FixturePath)) "Unexpected active title $($document.title)."
Assert-True ($document.kind -eq "rvt") "The active fixture kind is $($document.kind)."
$listed = @($document.openDocuments | Where-Object { $_.uniqueId -eq $document.uniqueId })
Assert-True ($listed.Count -eq 1 -and $listed[0].isActive -eq $true) "openDocuments does not list the fixture as active."
Assert-True (@($document.openDocuments | Where-Object { $_.isActive }).Count -eq 1) "openDocuments marks more than one document active."
Assert-True ($null -ne $document.PSObject.Properties["activeView"]) "activeView is absent."
$documentId = $document.uniqueId
$modifiedBefore = $document.isModified
Pass "active_document_is_the_open_fixture"

# The same batch: find_elements with no document target reads the document get_active_document chose.
$batch = Invoke-Broker @((Op "get_active_document"), (Op "find_elements" @{ category = "Walls" })) $null
Assert-Status $batch "succeeded" "get_active_document then find_elements"
Assert-True ($null -eq $batch.results[0]) "get_active_document's results entry is not null."
Assert-True ($batch.results[1].total -eq $expectedIds.Count) "find_elements after get_active_document found $($batch.results[1].total) walls."
Pass "find_elements_follows_get_active_document"

# Criterion 3: totals, level split, OST_ names, paging, parameters, types, views.
$walls = Read-Primitive $documentId "find_elements" @{ category = "Walls" }
Assert-True ($walls.total -eq $expectedIds.Count -and $walls.returned -eq $expectedIds.Count -and -not $walls.truncated -and $walls.offset -eq 0) "find_elements Walls page: $($walls | ConvertTo-Json -Compress -Depth 4)"
$foundIds = @($walls.elements | ForEach-Object { [long]$_.id })
Assert-True ((Compare-Object $foundIds $expectedIds -SyncWindow 0) -eq $null) "find_elements ids $($foundIds -join ',') differ from the fixture's $($expectedIds -join ',') or are out of id order."
$first = $walls.elements[0]
foreach ($field in "id", "uniqueId", "name", "category", "builtInCategory", "typeId", "typeName", "familyName", "familyId", "levelId") {
    Assert-True ($null -ne $first.PSObject.Properties[$field]) "Element summary lacks $field."
}
Assert-True ($first.builtInCategory -eq "OST_Walls" -and $first.category -eq "Walls") "Wall category fields: $($first.category) / $($first.builtInCategory)."
Assert-True ($null -eq $first.familyId) "A system wall type reported familyId $($first.familyId)."
$byBuiltIn = Read-Primitive $documentId "find_elements" @{ category = "OST_Walls" }
Assert-True ($byBuiltIn.total -eq $expectedIds.Count) "OST_Walls found $($byBuiltIn.total)."
Pass "find_elements_total_and_fields"

$lowerIds = @($expected.walls | Where-Object { $_.levelId -eq $expected.lowerLevelId } | ForEach-Object { [long]$_.id } | Sort-Object)
$upperIds = @($expected.walls | Where-Object { $_.levelId -eq $expected.upperLevelId } | ForEach-Object { [long]$_.id } | Sort-Object)
$lowerFound = Read-Primitive $documentId "find_elements" @{ category = "Walls"; levelId = $expected.lowerLevelId }
$upperFound = Read-Primitive $documentId "find_elements" @{ category = "Walls"; levelId = $expected.upperLevelId }
Assert-True ((Compare-Object @($lowerFound.elements | ForEach-Object { [long]$_.id }) $lowerIds) -eq $null) "levelId lower split is wrong."
Assert-True ((Compare-Object @($upperFound.elements | ForEach-Object { [long]$_.id }) $upperIds) -eq $null) "levelId upper split is wrong."
Assert-True ($lowerFound.total + $upperFound.total -eq $expectedIds.Count) "The level split does not add up."
Pass "find_elements_level_split"

$paged = [System.Collections.Generic.List[long]]::new()
for ($offset = 0; $offset -lt $expectedIds.Count; $offset++) {
    $page = Read-Primitive $documentId "find_elements" @{ category = "Walls"; limit = 1; offset = $offset }
    Assert-True ($page.returned -eq 1 -and $page.offset -eq $offset -and $page.total -eq $expectedIds.Count) "Page $offset is malformed."
    Assert-True ($page.truncated -eq ($offset -lt $expectedIds.Count - 1)) "Page $offset truncated is $($page.truncated)."
    $paged.Add([long]$page.elements[0].id)
}
$past = Read-Primitive $documentId "find_elements" @{ category = "Walls"; limit = 1; offset = $expectedIds.Count }
Assert-True ($past.returned -eq 0 -and -not $past.truncated) "The page past the end is not empty."
Assert-True ((Compare-Object @($paged) $expectedIds -SyncWindow 0) -eq $null) "limit=1 paging visited $($paged -join ',')."
Pass "find_elements_limit_1_pages_every_id_once"

$typeId = [long]$first.typeId
$typeName = $first.typeName
$sameType = Read-Primitive $documentId "find_elements" @{ category = "Walls"; typeName = $typeName }
Assert-True ($sameType.total -eq $expectedIds.Count) "typeName '$typeName' found $($sameType.total)."
$wallTypes = Read-Primitive $documentId "find_elements" @{ category = "Walls"; kind = "type" }
Assert-True (@($wallTypes.elements | Where-Object { [long]$_.id -eq $typeId }).Count -eq 1) "kind=type does not list the wall type."
$types = @(Read-Primitive $documentId "list_types" @{ category = "Walls" })
Assert-True (@($types | Where-Object { [long]$_.id -eq $typeId -and $_.name -eq $typeName }).Count -eq 1) "list_types Walls lacks $typeName ($typeId)."
Pass "list_types_contains_the_wall_type"

$firstExpected = $expected.walls | Where-Object { [long]$_.id -eq [long]$first.id } | Select-Object -First 1
$parameters = @(Read-Primitive $documentId "get_parameters" @{ elementIds = @([long]$first.id) })
Assert-True ($parameters.Count -eq 1 -and [long]$parameters[0].id -eq [long]$first.id) "get_parameters returned $($parameters.Count) elements."
$height = @($parameters[0].parameters | Where-Object { $_.builtIn -eq "WALL_USER_HEIGHT_PARAM" }) | Select-Object -First 1
Assert-True ($null -ne $height) "get_parameters has no WALL_USER_HEIGHT_PARAM."
Assert-True ($height.storageType -eq "Double" -and [Math]::Abs([double]$height.value - [double]$firstExpected.height) -lt 1e-9) "Wall height is $($height.value), expected $($firstExpected.height) ft."
Assert-True (-not [string]::IsNullOrWhiteSpace($height.display)) "Wall height has no display string."
Assert-True ($height.hasValue -eq $true -and $height.readOnly -eq $false) "Wall height flags: $($height | ConvertTo-Json -Compress)"
Assert-True ($null -ne $parameters[0].type -and [long]$parameters[0].type.id -eq $typeId -and @($parameters[0].type.parameters).Count -gt 0) "get_parameters lacks the type's parameters."
$named = @(Read-Primitive $documentId "get_parameters" @{ elementIds = @([long]$first.id); names = @("Length"); includeType = $false })
Assert-True (@($named[0].parameters).Count -ge 1 -and @($named[0].parameters | Where-Object { $_.name -ne "Length" }).Count -eq 0) "names did not filter to Length."
Assert-True ($null -eq $named[0].type) "includeType=false still returned the type."
$heightDisplay = $height.display
Pass "get_parameters_height_value_and_display"

$views = @(Read-Primitive $documentId "list_views")
$fixtureView = @($views | Where-Object { [long]$_.id -eq [long]$expected.viewId }) | Select-Object -First 1
Assert-True ($null -ne $fixtureView -and $fixtureView.name -eq $expected.viewName -and $fixtureView.viewType -eq "ThreeD" -and $fixtureView.capturable -eq $true) "list_views does not mark '$($expected.viewName)' capturable: $($fixtureView | ConvertTo-Json -Compress)"
Assert-True (@($views | Where-Object { $_.isTemplate }).Count -eq 0) "list_views listed templates by default."
$threeD = @(Read-Primitive $documentId "list_views" @{ viewTypes = @("ThreeD") })
Assert-True ($threeD.Count -ge 1 -and @($threeD | Where-Object { $_.viewType -ne "ThreeD" }).Count -eq 0) "viewTypes did not filter to ThreeD."
Pass "list_views_marks_3d_view_capturable"

# Bad input fails with its code and no result. No document target: the error names the fix.
$untargeted = Invoke-Broker @(Op "find_elements" @{ category = "Walls" }) $null
Assert-Failure $untargeted "document_not_open" "find_elements with no document target"
Assert-True ($untargeted.error.message -match "revit\.get_active_document\(\)" -and $untargeted.error.message -match "document=") "document_not_open does not name the fix: $($untargeted.error.message)"
Assert-Failure (Invoke-Broker @(Op "find_elements" @{ category = "Wals" }) (Target $documentId)) "unknown_category" "unknown category"
$unknown = Invoke-Broker @(Op "list_types" @{ category = "OST_NotACategory" }) (Target $documentId)
Assert-Failure $unknown "unknown_category" "unknown OST_ category"
Assert-True ($unknown.error.message -match "Closest category names: ") "unknown_category lists no closest names."
$missing = Invoke-Broker @(Op "get_parameters" @{ elementIds = @([long]$first.id, 999999901, 999999902) }) (Target $documentId)
Assert-Failure $missing "element_not_found" "missing element"
Assert-True ($missing.error.message -match "999999901" -and $missing.error.message -match "999999902") "element_not_found does not name each missing id."
Assert-True ($null -eq $missing.results[0]) "A failed get_parameters returned a partial result."
Assert-Failure (Invoke-Broker @(Op "find_elements" @{ category = "Walls"; limit = 2001 }) (Target $documentId)) "limit_exceeded" "limit 2001"
$tooMany = @(1..2001 | ForEach-Object { [long]$_ })
Assert-Failure (Invoke-Broker @(Op "get_parameters" @{ elementIds = $tooMany }) (Target $documentId)) "limit_exceeded" "2001 ids"
Pass "document_not_open_unknown_category_element_not_found_limit_exceeded"

# Criterion 4: set_selection then get_selection, with the read-back check, no document change.
$pick = @($expectedIds[0], $expectedIds[2])
$set = Invoke-Broker @(Op "set_selection" @{ elementIds = $pick }) (Target $documentId)
Assert-Status $set "succeeded" "set_selection"
$readback = @($set.checks | Where-Object { $_.name -eq "selection_readback" }) | Select-Object -First 1
Assert-True ($null -ne $readback -and $readback.passed) "selection_readback did not pass: $($readback | ConvertTo-Json -Compress)"
Assert-True (@($set.changes | Where-Object { $_ -match "^Selected 2 element\(s\) in " }).Count -eq 1) "set_selection changes: $($set.changes -join '; ')"
Assert-True (@($set.affectedElements).Count -eq 0) "set_selection reported affected elements."
$selected = @(Read-Primitive $documentId "get_selection")
Assert-True ((Compare-Object @($selected | ForEach-Object { [long]$_.id }) $pick) -eq $null) "get_selection returned $(@($selected | ForEach-Object { $_.id }) -join ',') after selecting $($pick -join ',')."
Assert-True ($selected[0].category -eq "Walls" -and $selected[0].typeName -eq $typeName) "Selection entry fields: $($selected[0] | ConvertTo-Json -Compress)"
$refused = Invoke-Broker @(Op "set_selection" @{ elementIds = @($expectedIds[1], 999999903) }) (Target $documentId)
Assert-Failure $refused "element_not_found" "set_selection missing id"
$unchanged = @(Read-Primitive $documentId "get_selection")
Assert-True ((Compare-Object @($unchanged | ForEach-Object { [long]$_.id }) $pick) -eq $null) "A refused set_selection changed the selection."
$cleared = Invoke-Broker @(Op "set_selection" @{ elementIds = @() }) (Target $documentId)
Assert-Status $cleared "succeeded" "clear selection"
Assert-True (@(Read-Primitive $documentId "get_selection").Count -eq 0) "An empty set_selection did not clear the selection."
Pass "set_get_selection_round_trip"

# A background document: Revit keeps no selection for it.
$background = Invoke-Broker @(Op "create_document" @{ kind = "rvt"; templatePath = $ProjectTemplate }) $null
Assert-Status $background "succeeded" "background document"
$backgroundId = $background.document.uniqueId
Assert-Failure (Invoke-Broker @(Op "get_selection") (Target $backgroundId)) "document_not_active" "get_selection on a background document"
Assert-Failure (Invoke-Broker @(Op "set_selection" @{ elementIds = @() }) (Target $backgroundId)) "document_not_active" "set_selection on a background document"
$stillActive = Get-Active
Assert-True ($stillActive.document.uniqueId -eq $documentId) "The background document became active."
Assert-True (@($stillActive.document.openDocuments | Where-Object { $_.uniqueId -eq $backgroundId -and -not $_.isActive }).Count -eq 1) "openDocuments does not list the background document as inactive."
Assert-Status (Invoke-Broker @(Op "close_document") (Target $backgroundId)) "succeeded" "close background document"
Pass "background_document_not_active"

$after = Get-Active
Assert-True ($after.document.isModified -eq $modifiedBefore) "The fixture's IsModified changed from $modifiedBefore to $($after.document.isModified) across the queries and selection."
Pass "is_modified_unchanged"

# get_active_document retargets a later save or delete, so preflight authorizes the active
# document's path: under a root that excludes the fixture, the whole batch stops before any effect.
$fixtureFile = Get-Item -LiteralPath $document.path
$writtenBefore = $fixtureFile.LastWriteTimeUtc
$narrowRoot = Join-Path $WorkspaceRoot "f8-policy-root-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $narrowRoot | Out-Null
try {
    Assert-True (-not $document.path.StartsWith("$narrowRoot\", [System.StringComparison]::OrdinalIgnoreCase)) "The fixture lies inside the narrow root."
    $background = Invoke-Broker @(Op "create_document" @{ kind = "rvt"; templatePath = $ProjectTemplate }) $null
    Assert-Status $background "succeeded" "background document for the switched target"
    $backgroundId = $background.document.uniqueId
    try {
        $cases = @(
            @{ label = "save after get_active_document"; operation = "save_document"; target = $null },
            @{ label = "save after get_active_document switches from a background target"; operation = "save_document"; target = (Target $backgroundId) },
            @{ label = "delete after get_active_document"; operation = "delete_document"; target = $null }
        )
        foreach ($case in $cases) {
            $refused = Invoke-Broker @((Op "get_active_document"), (Op $case.operation)) $case.target $narrowRoot
            Assert-Status $refused "policy_required" $case.label
            $requests = @($refused.policyRequests | Where-Object { $_.operation -eq $case.operation })
            Assert-True ($requests.Count -eq 1 -and @($requests[0].paths).Count -eq 1 -and (Same-Path $requests[0].paths[0] $document.path)) "$($case.label): policyRequests $($refused.policyRequests | ConvertTo-Json -Compress -Depth 4)"
            Assert-True (@($refused.changes).Count -eq 0 -and @($refused.affectedFiles).Count -eq 0) "$($case.label) reported effects."
            Assert-True (Test-Path -LiteralPath $document.path -PathType Leaf) "$($case.label) removed the fixture."
            Assert-True ((Get-Item -LiteralPath $document.path).LastWriteTimeUtc -eq $writtenBefore) "$($case.label) wrote the fixture."
        }
        Assert-True ((Get-Active).document.uniqueId -eq $documentId) "A refused batch changed the active document."
        Pass "outside_root_save_delete_after_get_active_document_policy_required"

        $approval = @{ decisionId = "primitives-$([guid]::NewGuid().ToString('N'))"; grants = @(@{ operation = "save_document"; paths = @($document.path) }) }
        $approved = Invoke-Broker @((Op "get_active_document"), (Op "save_document")) (Target $backgroundId) $narrowRoot $approval
        Assert-Status $approved "succeeded" "approved save after get_active_document"
        Assert-True (@($approved.affectedFiles).Count -eq 1 -and (Same-Path $approved.affectedFiles[0] $document.path)) "Approved save affectedFiles: $($approved.affectedFiles -join ', ')"
        $inside = Invoke-Broker @((Op "get_active_document"), (Op "save_document")) $null
        Assert-Status $inside "succeeded" "inside-root save after get_active_document"
        Assert-True (@($inside.affectedFiles).Count -eq 1 -and (Same-Path $inside.affectedFiles[0] $document.path)) "Inside-root save affectedFiles: $($inside.affectedFiles -join ', ')"
        Pass "approved_and_inside_root_save_after_get_active_document"

        # save_as_document moves the document a later get_active_document selects, so preflight
        # authorizes that later save at the destination: approving exactly the emitted requests runs
        # the whole batch, and an inside-root destination requests nothing for the old path.
        $outsideCopy = Join-Path $WorkspaceRoot "f8-policy-save-as-$([guid]::NewGuid().ToString('N')).rvt"
        $insideCopy = Join-Path $narrowRoot "f8-policy-save-as.rvt"
        function SaveAs-Then-Save([string]$Destination) {
            return @((Op "save_as_document" @{ destinationPath = $Destination; overwrite = $true }), (Op "get_active_document"), (Op "save_document"))
        }
        $fixtureWritten = (Get-Item -LiteralPath $document.path).LastWriteTimeUtc
        $restored = $null
        try {
            $refused = Invoke-Broker (SaveAs-Then-Save $outsideCopy) (Target $documentId) $narrowRoot
            Assert-Status $refused "policy_required" "save-as, get_active_document, save"
            Assert-True (@($refused.policyRequests).Count -eq 2) "save-as batch policyRequests: $($refused.policyRequests | ConvertTo-Json -Compress -Depth 4)"
            foreach ($operation in "save_as_document", "save_document") {
                $requests = @($refused.policyRequests | Where-Object { $_.operation -eq $operation })
                Assert-True ($requests.Count -eq 1 -and @($requests[0].paths).Count -eq 1 -and (Same-Path $requests[0].paths[0] $outsideCopy)) "save-as batch $operation request: $($refused.policyRequests | ConvertTo-Json -Compress -Depth 4)"
            }
            Assert-True (@($refused.changes).Count -eq 0 -and @($refused.affectedFiles).Count -eq 0 -and -not (Test-Path -LiteralPath $outsideCopy)) "The refused save-as batch had effects."

            $grants = @($refused.policyRequests | ForEach-Object { @{ operation = $_.operation; paths = @($_.paths) } })
            $approval = @{ decisionId = "primitives-$([guid]::NewGuid().ToString('N'))"; grants = $grants }
            $approved = Invoke-Broker (SaveAs-Then-Save $outsideCopy) (Target $documentId) $narrowRoot $approval
            Assert-Status $approved "succeeded" "save-as, get_active_document, save with the emitted grants"
            Assert-True (@($approved.affectedFiles).Count -eq 2 -and @($approved.affectedFiles | Where-Object { Same-Path $_ $outsideCopy }).Count -eq 2) "Approved save-as batch affectedFiles: $($approved.affectedFiles -join ', ')"
            Assert-True ((Get-Item -LiteralPath $document.path).LastWriteTimeUtc -eq $fixtureWritten) "The save-as batch wrote the original fixture."
            Pass "save_as_then_get_active_document_save_succeeds_with_emitted_grants"

            $insideSaved = Invoke-Broker (SaveAs-Then-Save $insideCopy) (Target $documentId) $narrowRoot
            Assert-Status $insideSaved "succeeded" "inside-root save-as, get_active_document, save"
            Assert-True (@($insideSaved.affectedFiles).Count -eq 2 -and @($insideSaved.affectedFiles | Where-Object { Same-Path $_ $insideCopy }).Count -eq 2) "Inside-root save-as batch affectedFiles: $($insideSaved.affectedFiles -join ', ')"
            Pass "inside_root_save_as_then_get_active_document_save_requests_nothing"
        }
        finally {
            # Move the active document back to the fixture's path for the Selection phase and later runs.
            $restored = Invoke-Broker @(Op "save_as_document" @{ destinationPath = $document.path; overwrite = $true }) (Target $documentId)
            Get-ChildItem -LiteralPath $WorkspaceRoot -Filter "$([System.IO.Path]::GetFileNameWithoutExtension($outsideCopy))*.rvt" |
                Remove-Item -Force
        }
        Assert-Status $restored "succeeded" "save the active document back to the fixture path"
        Assert-True (Same-Path (Get-Active).document.path $document.path) "The active document did not return to the fixture path."
    }
    finally {
        Invoke-Broker @(Op "close_document") (Target $backgroundId) | Out-Null
    }
}
finally {
    Remove-Item -LiteralPath $narrowRoot -Recurse -Force
}

[ordered]@{
    status = "succeeded"
    phase = $Phase
    processId = $ProcessId
    receiptLog = $receiptLog
    fixture = $FixturePath
    activeDocument = [ordered]@{ title = $document.title; path = $document.path; uniqueId = $documentId; activeView = $document.activeView; isModifiedBefore = $modifiedBefore; isModifiedAfter = $after.document.isModified }
    wallIds = $expectedIds
    wallType = [ordered]@{ id = $typeId; name = $typeName }
    heightDisplay = $heightDisplay
    viewId = $expected.viewId
    checks = @($checks)
} | ConvertTo-Json -Depth 8
