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
    public ErrorReceipt? Error { get; set; }
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

public sealed class DocumentReceipt
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
