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
    public ErrorReceipt? Error { get; set; }
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
