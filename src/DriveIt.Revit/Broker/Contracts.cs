using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace DriveIt.Revit.Broker;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class BrokerRequest
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public DocumentTarget? Document { get; set; }
    public string WorkspaceRoot { get; set; } = "";
    public List<TypedOperation> Operations { get; set; } = [];
    public OutsideRootApproval? OutsideRootApproval { get; set; }
    public CaptureRequest? Capture { get; set; }
    /// <summary>hold.begin only: the run's display name and the time it has left.</summary>
    public HoldRequest? Hold { get; set; }
    /// <summary>model.execute: present only while Require dry run is on for this real run (spec #13).</summary>
    public RequireDryRunGuard? RequireDryRun { get; set; }
}

/// <summary>Require dry run is on for a real run (spec #13): whether the server found an unused dry run of the same call.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class RequireDryRunGuard
{
    public bool Rehearsed { get; set; }
    /// <summary>A rehearsed run: the documents its dry run changed (D12). Any other document it did not create is refused.</summary>
    public List<RehearsedDocument>? Documents { get; set; }
}

/// <summary>A document a dry run changed, as its hold summary names it: title, and path when saved.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class RehearsedDocument
{
    public string Title { get; set; } = "";
    public string? Path { get; set; }
}

/// <summary>A hold.begin request's hold object. The add-in bounds the hold by the smaller of TimeLimitMs and its own limit.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class HoldRequest
{
    public string? DisplayName { get; set; }
    public int? TimeLimitMs { get; set; }
    /// <summary>A dry run (spec #13): never committed, refuses lasting operations, and labelled in the status window.</summary>
    public bool DryRun { get; set; }
    /// <summary>Present only while Require dry run is on for this real run (spec #13).</summary>
    public RequireDryRunGuard? RequireDryRun { get; set; }
}

/// <summary>
/// A view.capture request: export one existing view to a PNG at a server-created target inside
/// an empty staging directory. viewId is a decimal ElementId string so no precision is lost.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class CaptureRequest
{
    public string? ViewId { get; set; }
    public int PixelSize { get; set; }
    public string TargetPath { get; set; } = "";
    /// <summary>Marks the elements of these BuiltInCategory member names (1 to 5). With MarkElementIds, the union.</summary>
    public List<string>? MarkCategories { get; set; }
    /// <summary>Marks these decimal element ids. Either scope turns marks on; neither leaves the capture unmarked.</summary>
    public List<string>? MarkElementIds { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class DocumentTarget
{
    public string? Path { get; set; }
    public string? UniqueId { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class TypedOperation
{
    public string Type { get; set; } = "";
    public JsonObject? Arguments { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class DocumentOperationArguments
{
    public string? Path { get; set; }
    public string? DestinationPath { get; set; }
    public string? TemplatePath { get; set; }
    public string? Kind { get; set; }
    public bool Overwrite { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class ModelChangeRequest
{
    public string Type { get; set; } = "";
    public string? Name { get; set; }
    public double? Elevation { get; set; }
    public long? BaseLevelId { get; set; }
    public long? ElementId { get; set; }
    public double? Height { get; set; }
    public PointRequest? Start { get; set; }
    public PointRequest? End { get; set; }
    /// <summary>set_parameters entries, validated together before the model transaction.</summary>
    public List<ParameterChange>? Changes { get; set; }
    /// <summary>set_family_parameters entries, parsed from that operation's own arguments shape.</summary>
    [JsonIgnore]
    public List<FamilyParameterChange>? FamilyChanges { get; set; }
}

/// <summary>The arguments of set_family_parameters.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class FamilyParameterArguments
{
    public List<FamilyParameterChange>? Changes { get; set; }
}

/// <summary>
/// One set_family_parameters entry: a family parameter by name, exactly one of Type (a type name) or
/// AllTypes true, and exactly one of Value (raw, in Revit internal units), ValueString (document
/// display units), or Formula. A formula belongs to the parameter, not a type, so it takes AllTypes.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class FamilyParameterChange
{
    public string? Parameter { get; set; }
    public string? Type { get; set; }
    public bool? AllTypes { get; set; }
    public JsonNode? Value { get; set; }
    public string? ValueString { get; set; }
    public string? Formula { get; set; }
}

/// <summary>
/// One set_parameters entry: exactly one of Parameter (name), BuiltIn, or Guid, and exactly one of
/// Value (raw, in Revit internal units) or ValueString (document display units).
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class ParameterChange
{
    public long? ElementId { get; set; }
    public string? Parameter { get; set; }
    public string? BuiltIn { get; set; }
    public string? Guid { get; set; }
    public JsonNode? Value { get; set; }
    public string? ValueString { get; set; }
}

/// <summary>Arguments of get_active_document, get_selection, and get_family_parameters, which take none.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class NoArguments { }

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class FindElementsArguments
{
    public string? Category { get; set; }
    public string? Kind { get; set; }
    public long? LevelId { get; set; }
    public string? TypeName { get; set; }
    public int? Limit { get; set; }
    public int? Offset { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class GetParametersArguments
{
    public List<long>? ElementIds { get; set; }
    public List<string>? Names { get; set; }
    public bool? IncludeType { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class ListTypesArguments
{
    public string? Category { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class ListViewsArguments
{
    public List<string>? ViewTypes { get; set; }
    public bool? IncludeSheets { get; set; }
    public bool? IncludeTemplates { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class EditFamilyArguments
{
    public long? FamilyId { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class SetSelectionArguments
{
    public List<long>? ElementIds { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class PointRequest
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class OutsideRootApproval
{
    public string DecisionId { get; set; } = "";
    public List<PolicyPathGrant> Grants { get; set; } = [];
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class PolicyPathGrant
{
    public string Operation { get; set; } = "";
    public List<string> Paths { get; set; } = [];
}

public sealed class BrokerResponse
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "model.execute";
    public string Status { get; set; } = "";
    public string? WorkspaceRoot { get; set; }
    public DocumentReceipt? Document { get; set; }
    public List<string> Changes { get; set; } = [];
    public List<string> AffectedFiles { get; set; } = [];
    public List<long> AffectedElements { get; set; } = [];
    public List<CheckReceipt> Checks { get; set; } = [];
    public List<PolicyPathGrant>? PolicyRequests { get; set; }
    public CaptureReceipt? Capture { get; set; }
    public List<ViewSummary>? CreatedViews { get; set; }
    /// <summary>
    /// One entry per model.execute operation in batch order: a read primitive's output, null for
    /// every other operation and for every operation after a failure.
    /// </summary>
    public List<JsonNode?>? Results { get; set; }
    /// <summary>
    /// Held runs only: each save, close or delete in this batch that kept the run's changes to its document.
    /// Document is the hold's key for that document; the counts say how many of this response's effects came
    /// up to and including it. That document's effects after it, and other documents' effects, stay provisional.
    /// </summary>
    public List<EffectPosition>? CommitPoints { get; set; }
    /// <summary>
    /// Held runs only: after each operation, the hold's key for the document it acted on and the response's
    /// effect counts so far, so every effect can be matched to its document's commit points.
    /// </summary>
    public List<EffectPosition>? EffectDocuments { get; set; }
    public ErrorReceipt? Error { get; set; }
}

public sealed class EffectPosition
{
    public string? Document { get; set; }
    public int Changes { get; set; }
    public int AffectedElements { get; set; }
    public int CreatedViews { get; set; }
}

public sealed class CaptureReceipt
{
    public string? ViewId { get; set; }
    public string? ViewUniqueId { get; set; }
    public string? ViewName { get; set; }
    public string? ViewType { get; set; }
    public int? PixelSize { get; set; }
    public string? FitDirection { get; set; }
    public string? OutputPath { get; set; }
    public bool? DocumentModifiedBefore { get; set; }
    public bool? DocumentModifiedAfter { get; set; }
    public bool TemporaryViewCreated { get; set; }
    public bool TransactionStarted { get; set; }
    public MarksReceipt? Marks { get; set; }
    public List<ViewSummary>? AvailableViews { get; set; }
    public List<ViewSummary>? OtherViews { get; set; }
    public int? AvailableViewsTotal { get; set; }
    public int? OtherViewsTotal { get; set; }
    public int? ViewsListedPerType { get; set; }
    public int? OtherViewsListedPerType { get; set; }
}

/// <summary>
/// The marks drawn on a capture: one legend row per mark in mark order, the requested ids that got
/// no mark (only with markElementIds), and the count of elements that may be visible but got none.
/// </summary>
public sealed class MarksReceipt
{
    public List<MarkLegendRow> Legend { get; set; } = [];
    public List<MarkNotMarkedRow>? NotMarked { get; set; }
    public int Omitted { get; set; }
}

public sealed class MarkLegendRow
{
    public int Mark { get; set; }
    public string ElementId { get; set; } = "";
    public string? Category { get; set; }
    public string? FamilyName { get; set; }
    public string? TypeName { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
    public PixelBounds? Bounds { get; set; }
}

public sealed class MarkNotMarkedRow
{
    public string ElementId { get; set; } = "";
    public string Reason { get; set; } = "";
    public PixelBounds? Bounds { get; set; }
}

public sealed class PixelBounds
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}

public sealed class ViewSummary
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public string? NotCapturable { get; set; }
}

[JsonDerivedType(typeof(ActiveDocumentReceipt))]
public class DocumentReceipt
{
    public string UniqueId { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Path { get; set; }
    public string Kind { get; set; } = "";
    public bool IsReadOnly { get; set; }
    public int? WallCount { get; set; }
    public List<LevelReceipt>? Levels { get; set; }
    public List<string>? FamilyTypes { get; set; }
}

/// <summary>
/// get_active_document's snapshot: the standard receipt plus the active document's state and every
/// open, non-linked document. Serialized as itself through the base-typed response property.
/// </summary>
public sealed class ActiveDocumentReceipt : DocumentReceipt
{
    public bool IsModified { get; set; }
    /// <summary>{id, name, viewType}, or JSON null when the document has no active view.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public JsonObject? ActiveView { get; set; }
    public List<OpenDocumentReceipt> OpenDocuments { get; set; } = [];
}

public sealed class OpenDocumentReceipt
{
    public string UniqueId { get; set; } = "";
    public string Title { get; set; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Path { get; set; }
    public string Kind { get; set; } = "";
    public bool IsActive { get; set; }
}

public sealed class LevelReceipt
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public double Elevation { get; set; }
}

public sealed class CheckReceipt
{
    public string Name { get; set; } = "";
    public bool Passed { get; set; }
    public string Observed { get; set; } = "";
}

public sealed class ErrorReceipt
{
    public string Code { get; set; } = "";
    public string Message { get; set; } = "";
}

public sealed class RequestRejectedException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
