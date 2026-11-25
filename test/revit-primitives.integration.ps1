# Live checks for the built-in primitives (spec #9 Phase A criteria 2-4, Phase B criterion 5, Phase C
# criteria 6-7) over the add-in's pipe.
# A document the broker creates is never active in Revit's window, so the run has phases:
#   Prepare   - Revit open with no document: get_active_document fails with no_active_document; then
#               build the fixture (5 walls on two levels, a named 3D view), save it, and close it.
#   Active    - Revit restarted with the fixture as its active document: active-document targeting,
#               queries, paging, limits, model unchanged, the set/get selection round trip,
#               document_not_active for a background document, and outside-root policy for save,
#               delete, and save-as before get_active_document (ends with the fixture saved back
#               to its own path).
#   Selection - after a person (or windows-mcp) selects a wall in Revit's window: report what
#               get_selection returns, with each element's Length, so it can be matched to the click.
#   Parameters - the fixture active again (criterion 5, Phase B): set_parameters commits Comments and
#               wall heights (value and valueString) with parameter_readback checks, sets a type
#               parameter on the type id only, and every rejection (read-only, ambiguous, missing,
#               type mismatch) leaves every value unchanged. The commit is left unsaved for undo.
#   Families  - any open Revit (criteria 6 and 7, Phase C), on documents the phase creates itself:
#               a Generic Model family with two types made by create_family_type gets Manufacturer
#               per type and for all types, a formula, and every rejection, with CurrentType
#               restored; then a project from the default template has its first editable loadable
#               family opened with edit_family, read, and saved into the workspace, with the project
#               unmodified, and a system family refused. Everything it opens it closes.
# Each phase prints one JSON summary and throws on the first failed assertion.
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [Parameter(Mandatory = $true)]
    [ValidateSet("Prepare", "Active", "Selection", "Parameters", "Families")]
    [string]$Phase,
    [Parameter(Mandatory = $true)]
    [string]$FixturePath,
    [string]$ProjectTemplate,
    [string]$FamilyTemplate,
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

# Spec #28: a write names the documents it changes; by default the one the batch carries. $Targets names them when the
# batch reaches another one, as get_active_document does.
function Invoke-Broker([object[]]$Operations, $Document = $null, [string]$Root = $WorkspaceRoot, $Approval = $null, [object[]]$Targets = $null) {
    if ($null -eq $Targets) {
        $Targets = if ($null -ne $Document -and $Document.uniqueId) { @($Document.uniqueId) } else { @() }
    }
    $request = @{
        id = [guid]::NewGuid().ToString("N")
        type = "model.execute"
        workspaceRoot = $Root
        document = $Document
        operations = $Operations
        targets = @($Targets)
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

if ($Phase -eq "Families") {
    Assert-True (-not [string]::IsNullOrWhiteSpace($ProjectTemplate)) "Families needs -ProjectTemplate (an .rte inside the workspace root)."
    Assert-True (-not [string]::IsNullOrWhiteSpace($FamilyTemplate)) "Families needs -FamilyTemplate (Generic Model.rft inside the workspace root)."
    $folder = Split-Path -Parent $FixturePath
    $projectPath = Join-Path $folder "f8-families.rvt"
    $observed = [ordered]@{}

    # --- Criterion 6: family parameters per type ---
    $family = Invoke-Broker @(Op "create_document" @{ kind = "rfa"; templatePath = $FamilyTemplate }) $null
    Assert-Status $family "succeeded" "create family"
    $familyId = $family.document.uniqueId
    $typeA = "F8 Type A"
    $typeB = "F8 Type B"
    $typed = Invoke-Broker @((Op "create_family_type" @{ name = $typeA }), (Op "create_family_type" @{ name = $typeB })) (Target $familyId)
    Assert-Status $typed "succeeded" "create two family types"

    function Family-Read { return Read-Primitive $familyId "get_family_parameters" }
    function Family-Parameter($Read, [string]$Name) { return @($Read.parameters | Where-Object { $_.name -eq $Name }) | Select-Object -First 1 }
    function Family-Value($Read, [string]$Name, [string]$Type) { return Get-Field (Get-Field (Family-Parameter $Read $Name).values $Type) "value" }
    function Assert-FamilyRejected([object[]]$Changes, [string]$Code, [string]$Label) {
        $response = Invoke-Broker @(Op "set_family_parameters" @{ changes = $Changes }) (Target $familyId)
        Assert-Failure $response $Code $Label
        Assert-True (@($response.changes).Count -eq 0) "${Label}: reported changes."
        Assert-True (@($response.checks | Where-Object { $_.name -in "family_parameter_readback", "transaction_commit" }).Count -eq 0) "${Label}: a transaction ran."
        return $response
    }

    $read = Family-Read
    $original = $read.currentType
    Assert-True ((Compare-Object @($read.types) @($typeA, $typeB)) -eq $null) "get_family_parameters types: $($read.types -join ', ')"
    Assert-True ($original -in $typeA, $typeB) "currentType is '$original'."
    $manufacturer = Family-Parameter $read "Manufacturer"
    Assert-True ($null -ne $manufacturer) "No Manufacturer family parameter among: $(@($read.parameters | ForEach-Object name) -join ', ')"
    Assert-True ($manufacturer.storageType -eq "String" -and $null -eq $manufacturer.formula) "Manufacturer entry: $($manufacturer | ConvertTo-Json -Compress -Depth 6)"
    foreach ($type in $typeA, $typeB) {
        Assert-True ($null -ne (Get-Field $manufacturer.values $type)) "Manufacturer has no values entry for '$type'."
    }
    Assert-True ((Family-Read).currentType -eq $original) "Reading changed currentType."
    $observed.parameterNames = @($read.parameters | ForEach-Object name)
    $observed.manufacturerEntry = $manufacturer
    Pass "get_family_parameters_lists_types_and_identity_data_without_changing_current_type"

    # Per type. The current type is set first, so the other one is current last and the restore shows.
    $other = if ($original -eq $typeA) { $typeB } else { $typeA }
    $tag = [guid]::NewGuid().ToString("N").Substring(0, 6)
    $perType = Invoke-Broker @(Op "set_family_parameters" @{ changes = @(
        @{ parameter = "Manufacturer"; type = $original; value = "F8 $tag $original" },
        @{ parameter = "Manufacturer"; type = $other; value = "F8 $tag $other" }
    ) }) (Target $familyId)
    Assert-Status $perType "succeeded" "set_family_parameters per type"
    $readbacks = @($perType.checks | Where-Object { $_.name -eq "family_parameter_readback" })
    Assert-True ($readbacks.Count -eq 2 -and @($readbacks | Where-Object { -not $_.passed }).Count -eq 0) "family_parameter_readback: $($readbacks | ConvertTo-Json -Compress)"
    Assert-True (@($perType.checks | Where-Object { $_.name -eq "transaction_commit" -and $_.passed }).Count -eq 1) "No committed transaction."
    Assert-True (@($perType.changes).Count -eq 2) "Expected two changes lines: $($perType.changes -join '; ')"
    Assert-True (@($perType.results).Count -eq 1 -and $null -eq $perType.results[0]) "set_family_parameters put an output in results."
    $read = Family-Read
    foreach ($type in $typeA, $typeB) {
        Assert-True ((Family-Value $read "Manufacturer" $type) -eq "F8 $tag $type") "Manufacturer for '$type' re-read as '$(Family-Value $read 'Manufacturer' $type)'."
    }
    Assert-True ($read.currentType -eq $original) "currentType after the per-type call is '$($read.currentType)', not '$original'."
    $observed.perType = [ordered]@{ changes = @($perType.changes); readbacks = $readbacks; currentType = $read.currentType }
    Pass "per_type_values_read_back_and_current_type_restored"

    $all = Invoke-Broker @(Op "set_family_parameters" @{ changes = @(@{ parameter = "Manufacturer"; allTypes = $true; value = "F8 $tag all" }) }) (Target $familyId)
    Assert-Status $all "succeeded" "set_family_parameters allTypes"
    Assert-True (@($all.checks | Where-Object { $_.name -eq "family_parameter_readback" -and $_.passed }).Count -eq 2) "allTypes readback: $($all.checks | ConvertTo-Json -Compress)"
    $read = Family-Read
    foreach ($type in $typeA, $typeB) {
        Assert-True ((Family-Value $read "Manufacturer" $type) -eq "F8 $tag all") "allTypes: Manufacturer for '$type' re-read as '$(Family-Value $read 'Manufacturer' $type)'."
    }
    Assert-True ($read.currentType -eq $original) "currentType after allTypes is '$($read.currentType)'."
    $observed.allTypes = [ordered]@{ changes = @($all.changes); currentType = $read.currentType }
    Pass "all_types_values_read_back_and_current_type_restored"

    # A formula: the first parameter among these that Revit accepts one for. Then a value on it is
    # refused with parameter_has_formula, a bad formula with invalid_formula, the per-type shape sets
    # one, and "" clears it.
    $formulaTarget = $null
    $attempts = @()
    foreach ($candidate in @(@{ name = "Cost"; formula = "2 * 60" }, @{ name = "Manufacturer"; formula = "`"F8 formula`"" }, @{ name = "Model"; formula = "`"F8 formula`"" })) {
        if ($null -eq (Family-Parameter (Family-Read) $candidate.name)) { continue }
        $response = Invoke-Broker @(Op "set_family_parameters" @{ changes = @(@{ parameter = $candidate.name; allTypes = $true; formula = $candidate.formula }) }) (Target $familyId)
        $attempts += [ordered]@{ parameter = $candidate.name; formula = $candidate.formula; status = $response.status; error = (Get-Field $response "error"); checks = @($response.checks) }
        if ($response.status -eq "succeeded") { $formulaTarget = $candidate; break }
        Assert-True ($response.status -eq "failed") "A refused formula on $($candidate.name) left status $($response.status)."
    }
    $observed.formulaAttempts = $attempts
    Assert-True ($null -ne $formulaTarget) "No candidate parameter accepted a formula: $($attempts | ConvertTo-Json -Compress -Depth 6)"
    $read = Family-Read
    $withFormula = Family-Parameter $read $formulaTarget.name
    Assert-True ($withFormula.formula -eq $formulaTarget.formula) "$($formulaTarget.name) formula re-read as '$($withFormula.formula)'."
    Assert-True ($read.currentType -eq $original) "currentType after the formula is '$($read.currentType)'."
    $valueForFormula = if ($withFormula.storageType -eq "String") { "x" } else { 5 }
    $hasFormula = Assert-FamilyRejected @(@{ parameter = $formulaTarget.name; type = $typeA; value = $valueForFormula }) "parameter_has_formula" "value on a formula-driven parameter"
    $invalid = Invoke-Broker @(Op "set_family_parameters" @{ changes = @(@{ parameter = $formulaTarget.name; allTypes = $true; formula = "1 +* (" }) }) (Target $familyId)
    Assert-Failure $invalid "invalid_formula" "malformed formula"
    Assert-True (@($invalid.changes).Count -eq 0) "invalid_formula reported changes."
    Assert-True ((Family-Parameter (Family-Read) $formulaTarget.name).formula -eq $formulaTarget.formula) "invalid_formula changed the formula."
    # The spec's per-type shape: a formula with type A (not the current type) sets the parameter's
    # formula, reads it back, names the type in the receipt, and restores the current type.
    $perTypeFormula = if ($withFormula.storageType -eq "String") { "`"F8 per type`"" } else { "3 * 40" }
    $typed = Invoke-Broker @(Op "set_family_parameters" @{ changes = @(@{ parameter = $formulaTarget.name; type = $typeA; formula = $perTypeFormula }) }) (Target $familyId)
    Assert-Status $typed "succeeded" "set_family_parameters formula for one type"
    Assert-True (@($typed.checks | Where-Object { $_.name -eq "family_parameter_readback" -and $_.passed }).Count -eq 1) "per-type formula readback: $($typed.checks | ConvertTo-Json -Compress)"
    Assert-True ((@($typed.changes) -join "`n") -match [regex]::Escape("from type '$typeA'")) "per-type formula receipt: $(@($typed.changes) -join ' | ')"
    $read = Family-Read
    Assert-True ((Family-Parameter $read $formulaTarget.name).formula -eq $perTypeFormula) "$($formulaTarget.name) per-type formula re-read as '$((Family-Parameter $read $formulaTarget.name).formula)'."
    Assert-True ($read.currentType -eq $original) "currentType after the per-type formula is '$($read.currentType)'."
    $cleared = Invoke-Broker @(Op "set_family_parameters" @{ changes = @(@{ parameter = $formulaTarget.name; type = $typeB; formula = "" }) }) (Target $familyId)
    Assert-Status $cleared "succeeded" "clear the formula for one type"
    $read = Family-Read
    Assert-True ($null -eq (Family-Parameter $read $formulaTarget.name).formula) "The formula did not clear."
    Assert-True ($read.currentType -eq $original) "currentType after clearing the formula is '$($read.currentType)'."
    $observed.formula = [ordered]@{ parameter = $formulaTarget.name; formula = $formulaTarget.formula; hasFormulaError = $hasFormula.error; invalidFormula = [ordered]@{ error = $invalid.error; checks = @($invalid.checks) }; perType = [ordered]@{ formula = $perTypeFormula; changes = @($typed.changes); checks = @($typed.checks) }; cleared = @($cleared.changes) }
    Pass "formula_set_per_type_and_all_types_has_formula_and_invalid_formula_refused_then_cleared"

    $before = Family-Read
    $notFound = Assert-FamilyRejected @(
        @{ parameter = "Manufacturer"; type = $typeA; value = "must not apply" },
        @{ parameter = "Manufacturer"; type = "No Such Type F8"; value = "x" }
    ) "family_type_not_found" "missing family type"
    Assert-FamilyRejected @(@{ parameter = "No Such Parameter F8"; allTypes = $true; value = "x" }) "parameter_not_found" "missing family parameter" | Out-Null
    Assert-FamilyRejected @(@{ parameter = "Manufacturer"; allTypes = $true; value = 5 }) "value_type_mismatch" "number for a String" | Out-Null
    Assert-FamilyRejected @(@{ parameter = "Manufacturer"; type = $typeA; allTypes = $true; value = "x" }) "invalid_arguments" "type and allTypes" | Out-Null
    $after = Family-Read
    foreach ($type in $typeA, $typeB) {
        Assert-True ((Family-Value $after "Manufacturer" $type) -eq (Family-Value $before "Manufacturer" $type)) "A rejected call changed Manufacturer for '$type'."
    }
    Assert-True ($after.currentType -eq $original) "A rejected call changed currentType."
    $observed.familyTypeNotFound = $notFound.error
    Pass "family_type_not_found_and_validation_failures_change_nothing"

    # --- Criterion 7: edit_family on a project created from the default template ---
    $project = Invoke-Broker @(Op "create_document" @{ kind = "rvt"; templatePath = $ProjectTemplate }) $null
    Assert-Status $project "succeeded" "create project"
    $created = $project.document.uniqueId
    Assert-Status (Invoke-Broker @(Op "save_as_document" @{ destinationPath = $projectPath; overwrite = $true }) (Target $created)) "succeeded" "save project"
    Assert-Status (Invoke-Broker @(Op "close_document") (Target $created)) "succeeded" "close project"
    # Reopened, the project starts unmodified, so project_unmodified observes a real false -> false.
    $opened = Invoke-Broker @(Op "open_document" @{ path = $projectPath }) $null
    Assert-Status $opened "succeeded" "open project"
    $projectId = $opened.document.uniqueId
    $projectBefore = $opened.document

    $wrongKind = Invoke-Broker @(Op "get_family_parameters") (Target $projectId)
    Assert-Failure $wrongKind "wrong_document_kind" "get_family_parameters on an RVT"

    # The first loadable family find_elements returns, by category; the first one Revit lets us edit.
    $edited = $null
    $tried = @()
    foreach ($category in "OST_Doors", "OST_Windows", "OST_Furniture", "OST_GenericModel", "OST_TitleBlocks", "OST_LevelHeads", "OST_SectionHeads", "OST_GridHeads") {
        $page = Read-Primitive $projectId "find_elements" @{ category = $category; kind = "type"; limit = 2000 }
        foreach ($element in @($page.elements | Where-Object { $null -ne $_.familyId })) {
            $batch = Invoke-Broker @((Op "edit_family" @{ familyId = [long]$element.familyId }), (Op "get_family_parameters")) (Target $projectId)
            $tried += [ordered]@{ category = $category; familyId = $element.familyId; familyName = $element.familyName; status = $batch.status; error = (Get-Field $batch "error") }
            if ($batch.status -eq "succeeded") { $edited = [ordered]@{ element = $element; response = $batch }; break }
            Assert-Failure $batch "family_not_editable" "edit_family on $($element.familyName)"
        }
        if ($null -ne $edited) { break }
    }
    $observed.editAttempts = $tried
    Assert-True ($null -ne $edited) "No loadable family in the project could be opened for editing."
    $response = $edited.response
    $familyDocument = $response.document
    Assert-True ($familyDocument.kind -eq "rfa") "edit_family returned a $($familyDocument.kind) document."
    Assert-True ($familyDocument.uniqueId -ne $projectId) "edit_family returned the project's identity."
    Assert-True (@($response.changes) -contains "Opened family $($edited.element.familyName) for editing.") "edit_family changes: $($response.changes -join '; ')"
    $unmodified = @($response.checks | Where-Object { $_.name -eq "project_unmodified" }) | Select-Object -First 1
    Assert-True ($null -ne $unmodified -and $unmodified.passed -and $unmodified.observed -match "IsModified False before and False after") "project_unmodified: $($unmodified | ConvertTo-Json -Compress)"
    Assert-True ($null -eq $response.results[0]) "edit_family put an output in results."
    $familyRead = $response.results[1]
    Assert-True ($null -ne $familyRead -and $null -ne $familyRead.parameters -and @($familyRead.parameters).Count -gt 0) "get_family_parameters after edit_family in the same batch read nothing: $($familyRead | ConvertTo-Json -Compress -Depth 4)"
    $observed.edited = [ordered]@{ category = $edited.element.category; familyId = $edited.element.familyId; familyName = $edited.element.familyName; document = $familyDocument; changes = @($response.changes); projectUnmodified = $unmodified; types = @($familyRead.types); currentType = $familyRead.currentType; parameterCount = @($familyRead.parameters).Count }
    Pass "edit_family_opens_rfa_and_next_get_family_parameters_reads_it"

    $projectAfter = Invoke-Broker @(Op "read_document") (Target $projectId)
    Assert-Status $projectAfter "succeeded" "read project after edit_family"
    Assert-True ($projectAfter.document.wallCount -eq $projectBefore.wallCount -and @($projectAfter.document.levels).Count -eq @($projectBefore.levels).Count) "The project's snapshot changed after edit_family."
    Pass "project_unmodified"

    $rfaPath = Join-Path $folder "f8-edited-family.rfa"
    if (Test-Path -LiteralPath $rfaPath) { Remove-Item -LiteralPath $rfaPath -Force }
    $savedFamily = Invoke-Broker @(Op "save_as_document" @{ destinationPath = $rfaPath }) (Target $familyDocument.uniqueId)
    Assert-Status $savedFamily "succeeded" "save the edited family"
    Assert-True (Test-Path -LiteralPath $rfaPath) "The family file was not written: $rfaPath"
    Assert-True (@($savedFamily.checks | Where-Object { $_.name -eq "file_saved" -and $_.passed }).Count -eq 1) "file_saved: $($savedFamily.checks | ConvertTo-Json -Compress)"
    $observed.savedFamily = [ordered]@{ path = $rfaPath; bytes = (Get-Item -LiteralPath $rfaPath).Length; document = $savedFamily.document }
    Pass "save_as_document_writes_the_rfa_into_the_workspace"

    # A second edit_family of the same, still-open family: recorded as Revit answers it.
    $again = Invoke-Broker @(Op "edit_family" @{ familyId = [long]$edited.element.familyId }) (Target $projectId)
    $observed.secondEdit = [ordered]@{ status = $again.status; error = (Get-Field $again "error"); document = (Get-Field $again "document") }

    $wallTypes = Read-Primitive $projectId "list_types" @{ category = "Walls" }
    $systemType = @($wallTypes)[0]
    $system = Invoke-Broker @(Op "edit_family" @{ familyId = [long]$systemType.id }) (Target $projectId)
    Assert-Failure $system "family_not_editable" "edit_family on a system family type"
    $missing = Invoke-Broker @(Op "edit_family" @{ familyId = 999999901 }) (Target $projectId)
    Assert-Failure $missing "element_not_found" "edit_family on a missing id"
    $onFamily = Invoke-Broker @(Op "edit_family" @{ familyId = [long]$edited.element.familyId }) (Target $familyDocument.uniqueId)
    Assert-Failure $onFamily "wrong_document_kind" "edit_family on an RFA"
    $observed.refusals = [ordered]@{ systemFamily = [ordered]@{ id = $systemType.id; name = $systemType.name; error = $system.error }; missing = $missing.error; onFamily = $onFamily.error; getFamilyParametersOnProject = $wrongKind.error }
    Pass "family_not_editable_element_not_found_wrong_document_kind"

    foreach ($id in @($familyDocument.uniqueId, $(if ($again.status -eq "succeeded" -and $again.document.uniqueId -ne $familyDocument.uniqueId) { $again.document.uniqueId }), $projectId, $familyId)) {
        if ($id) { Invoke-Broker @(Op "close_document") (Target $id) | Out-Null }
    }

    [ordered]@{
        status = "succeeded"; phase = $Phase; processId = $ProcessId; receiptLog = $receiptLog
        familyTypes = @($typeA, $typeB); originalCurrentType = $original
        observed = $observed
        checks = @($checks)
    } | ConvertTo-Json -Depth 10
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

if ($Phase -eq "Parameters") {
    # Criterion 5 (Phase B): set_parameters on the active fixture. The committed batch is left
    # unsaved, so its "Drive It model batch" entry stays in Revit's undo list for inspection.
    $active = Get-Active
    Assert-True (Same-Path $active.document.path $FixturePath) "The fixture is not the active document: $($active.document.path)"
    $documentId = $active.document.uniqueId
    $wallA = [long]$expected.walls[0].id
    $wallB = [long]$expected.walls[1].id

    function Read-Values([long[]]$Ids) {
        $read = Read-Primitive $documentId "get_parameters" @{ elementIds = $Ids; includeType = $false }
        $values = @{}
        foreach ($element in @($read)) {
            $entry = @{}
            foreach ($parameter in @($element.parameters)) {
                if ($parameter.builtIn -in "ALL_MODEL_INSTANCE_COMMENTS", "WALL_USER_HEIGHT_PARAM", "CURVE_ELEM_LENGTH") {
                    $entry[$parameter.builtIn] = [ordered]@{ value = $parameter.value; display = $parameter.display }
                }
            }
            $values["$($element.id)"] = $entry  # string keys: ConvertTo-Json needs them
        }
        return $values
    }

    function Assert-Rejected([object[]]$Changes, [string]$Code, [string]$Label) {
        $response = Invoke-Broker @(Op "set_parameters" @{ changes = $Changes }) (Target $documentId)
        Assert-Failure $response $Code $Label
        Assert-True (@($response.changes).Count -eq 0 -and @($response.affectedElements).Count -eq 0) "${Label}: reported effects."
        Assert-True (@($response.checks | Where-Object { $_.name -in "parameter_readback", "transaction_commit" }).Count -eq 0) "${Label}: a transaction ran."
        return $response
    }

    $original = Read-Values @($wallA, $wallB)
    Assert-True ([Math]::Abs($original["$wallA"]["WALL_USER_HEIGHT_PARAM"].value - $expected.walls[0].height) -lt 1e-9) "Wall A does not start at the fixture height."

    # Committed: Comments by name, height by builtIn with value, height by name with valueString.
    $comment = "F8 set_parameters $([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $committed = Invoke-Broker @(Op "set_parameters" @{ changes = @(
        @{ elementId = $wallA; parameter = "Comments"; value = $comment },
        @{ elementId = $wallA; builtIn = "WALL_USER_HEIGHT_PARAM"; value = 12.0 },
        @{ elementId = $wallB; parameter = "Unconnected Height"; valueString = "9' 6`"" }
    ) }) (Target $documentId)
    Assert-Status $committed "succeeded" "set_parameters commit"
    $readbacks = @($committed.checks | Where-Object { $_.name -eq "parameter_readback" })
    Assert-True ($readbacks.Count -eq 3 -and @($readbacks | Where-Object { -not $_.passed }).Count -eq 0) "parameter_readback: $($readbacks | ConvertTo-Json -Compress)"
    Assert-True (@($committed.checks | Where-Object { $_.name -eq "transaction_commit" -and $_.passed }).Count -eq 1) "No committed transaction."
    Assert-True (@($committed.changes).Count -eq 3) "Expected three changes lines: $($committed.changes -join '; ')"
    Assert-True ((Compare-Object @($committed.affectedElements | ForEach-Object { [long]$_ }) @($wallA, $wallB)) -eq $null) "affectedElements: $($committed.affectedElements -join ',')"
    Assert-True (@($committed.results).Count -eq 1 -and $null -eq $committed.results[0]) "set_parameters put an output in results."
    Pass "set_parameters_commits_with_readback"

    $after = Read-Values @($wallA, $wallB)
    Assert-True ($after["$wallA"]["ALL_MODEL_INSTANCE_COMMENTS"].value -eq $comment) "Comments re-read as $($after["$wallA"]['ALL_MODEL_INSTANCE_COMMENTS'].value)."
    Assert-True ([Math]::Abs($after["$wallA"]["WALL_USER_HEIGHT_PARAM"].value - 12.0) -le 1e-9) "Wall A height re-read as $($after["$wallA"]['WALL_USER_HEIGHT_PARAM'].value)."
    Assert-True ([Math]::Abs($after["$wallB"]["WALL_USER_HEIGHT_PARAM"].value - 9.5) -le 1e-9) "Wall B height re-read as $($after["$wallB"]['WALL_USER_HEIGHT_PARAM'].value)."
    Pass "re_read_shows_new_values"

    # A type parameter is set on the type's id; the instance id is never redirected to its type.
    $typed = Read-Primitive $documentId "get_parameters" @{ elementIds = @($wallA); names = @("Type Comments") }
    $typeId = [long]$typed[0].type.id
    Assert-Rejected @(@{ elementId = $wallA; parameter = "Type Comments"; value = "on the instance" }) "parameter_not_found" "type parameter on an instance id" | Out-Null
    $typeComment = "F8 type $([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $typeSet = Invoke-Broker @(Op "set_parameters" @{ changes = @(@{ elementId = $typeId; parameter = "Type Comments"; value = $typeComment }) }) (Target $documentId)
    Assert-Status $typeSet "succeeded" "set_parameters on the type id"
    $typeRead = Read-Primitive $documentId "get_parameters" @{ elementIds = @($typeId); names = @("Type Comments"); includeType = $false }
    Assert-True ($typeRead[0].parameters[0].value -eq $typeComment) "Type Comments re-read as $($typeRead[0].parameters[0].value)."
    Pass "type_parameter_set_on_type_id_only"

    # All or nothing: a writable change beside a read-only one applies neither.
    $readOnly = Assert-Rejected @(
        @{ elementId = $wallB; parameter = "Comments"; value = "must not apply" },
        @{ elementId = $wallA; builtIn = "CURVE_ELEM_LENGTH"; value = 99.0 }
    ) "parameter_read_only" "read-only parameter in the batch"
    $unchanged = Read-Values @($wallA, $wallB)
    foreach ($id in $wallA, $wallB) {
        foreach ($name in "ALL_MODEL_INSTANCE_COMMENTS", "WALL_USER_HEIGHT_PARAM", "CURVE_ELEM_LENGTH") {
            Assert-True ("$($unchanged["$id"][$name].value)" -eq "$($after["$id"][$name].value)") "$name on $id changed after a rejected batch."
        }
    }
    Pass "read_only_rejects_whole_batch_unchanged"

    # ambiguous_parameter needs one element with two parameters of the same name. Find one among
    # the fixture's walls, their type, levels, views and project information.
    $candidates = [System.Collections.Generic.List[long]]::new()
    $candidates.AddRange([long[]]@($wallA, $typeId, $expected.lowerLevelId, $expected.upperLevelId))
    foreach ($view in @(Read-Primitive $documentId "list_views" @{ includeTemplates = $true })) { $candidates.Add([long]$view.id) }
    foreach ($info in @((Read-Primitive $documentId "find_elements" @{ category = "OST_ProjectInformation" }).elements)) { $candidates.Add([long]$info.id) }
    $duplicate = $null
    foreach ($element in @(Read-Primitive $documentId "get_parameters" @{ elementIds = @($candidates | Select-Object -Unique); includeType = $false })) {
        $group = @($element.parameters | Group-Object name | Where-Object { $_.Count -gt 1 }) | Select-Object -First 1
        if ($group) { $duplicate = [ordered]@{ id = [long]$element.id; name = $group.Name; builtIns = @($group.Group | ForEach-Object { $_.builtIn }) }; break }
    }
    Assert-True ($null -ne $duplicate) "No element among $($candidates.Count) candidates has two parameters with one name, so ambiguous_parameter could not be exercised."
    $ambiguous = Assert-Rejected @(@{ elementId = $duplicate.id; parameter = $duplicate.name; value = "x" }) "ambiguous_parameter" "duplicate parameter name"
    Assert-True ($ambiguous.error.message -match "builtIn" -and $ambiguous.error.message -match "guid") "ambiguous_parameter does not list builtIn and guid: $($ambiguous.error.message)"
    Pass "ambiguous_parameter_lists_candidates"

    Assert-Rejected @(@{ elementId = 999999901; parameter = "Comments"; value = "x" }, @{ elementId = $wallA; parameter = "Comments"; value = "x" }) "element_not_found" "missing element" | Out-Null
    Assert-Rejected @(@{ elementId = $wallA; parameter = "No Such Parameter F8"; value = "x" }) "parameter_not_found" "missing parameter" | Out-Null
    Assert-Rejected @(@{ elementId = $wallA; builtIn = "NOT_A_BUILTIN_F8"; value = "x" }) "parameter_not_found" "unknown builtIn" | Out-Null
    Assert-Rejected @(@{ elementId = $wallA; parameter = "Comments"; value = 5 }) "value_type_mismatch" "number for a String" | Out-Null
    Assert-Rejected @(@{ elementId = $wallA; builtIn = "WALL_USER_HEIGHT_PARAM"; value = "tall" }) "value_type_mismatch" "string for a Double" | Out-Null
    Assert-Rejected @(@{ elementId = $wallA; parameter = "Comments"; valueString = "1200 mm" }) "value_type_mismatch" "valueString for a String" | Out-Null
    Assert-Rejected @(@{ elementId = $wallA; builtIn = "WALL_USER_HEIGHT_PARAM"; valueString = "not a length" }) "value_type_mismatch" "unparsable valueString" | Out-Null
    Assert-Rejected @(@{ elementId = $wallA; parameter = "Comments"; builtIn = "ALL_MODEL_INSTANCE_COMMENTS"; value = "x" }) "invalid_arguments" "two identifiers" | Out-Null
    $final = Read-Values @($wallA, $wallB)
    Assert-True ($final["$wallA"]["ALL_MODEL_INSTANCE_COMMENTS"].value -eq $comment -and [Math]::Abs($final["$wallA"]["WALL_USER_HEIGHT_PARAM"].value - 12.0) -le 1e-9) "A rejected call changed wall A."
    Pass "validation_failures_change_nothing"

    [ordered]@{
        status = "succeeded"; phase = $Phase; processId = $ProcessId; receiptLog = $receiptLog
        isModified = (Get-Active).document.isModified
        committedChanges = @($committed.changes)
        readbacks = $readbacks
        before = $original; after = $after
        typeComment = [ordered]@{ typeId = $typeId; value = $typeComment }
        readOnlyError = $readOnly.error
        ambiguous = [ordered]@{ element = $duplicate; error = $ambiguous.error }
        checks = @($checks)
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
# Spec #28: the fix it names is targets on the call, or a document the script opens or creates.
Assert-True ($untargeted.error.message -match "Pass targets on the execute_script call" -and $untargeted.error.message -match "open or create a document") "document_not_open does not name the fix: $($untargeted.error.message)"
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
            $refused = Invoke-Broker @((Op "get_active_document"), (Op $case.operation)) $case.target $narrowRoot $null @($documentId)
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
        $approved = Invoke-Broker @((Op "get_active_document"), (Op "save_document")) (Target $backgroundId) $narrowRoot $approval @($documentId)
        Assert-Status $approved "succeeded" "approved save after get_active_document"
        Assert-True (@($approved.affectedFiles).Count -eq 1 -and (Same-Path $approved.affectedFiles[0] $document.path)) "Approved save affectedFiles: $($approved.affectedFiles -join ', ')"
        $inside = Invoke-Broker @((Op "get_active_document"), (Op "save_document")) $null $WorkspaceRoot $null @($documentId)
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
