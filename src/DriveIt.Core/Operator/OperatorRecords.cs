using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace DriveIt.Core.Operator;

/// <summary>
/// One client's Detect agents result: <see cref="Status"/> is <c>added</c>, <c>already</c>,
/// <c>not_installed</c> or <c>failed</c>; <see cref="Message"/> is the plain line the drawer shows.
/// </summary>
public sealed record AgentResult(string Client, string Status, string Message)
{
    public override string ToString() => Message;
}

/// <summary>One operation of an outside-root request and the canonical paths it resolved to.</summary>
public sealed record RequestedOperation(string Operation, IReadOnlyList<string> Paths);

/// <summary>
/// A pending outside-root decision from <c>decisions list</c>. <see cref="DisplayName"/> is the
/// model-written line for the run (decision 21); older rows have none and are named by their run.
/// </summary>
public sealed class PendingRequest
{
    public required string Id { get; init; }

    public string? RunId { get; init; }

    public string? DisplayName { get; init; }

    public IReadOnlyList<RequestedOperation> Operations { get; init; } = [];

    /// <summary>The list row: "displayName — operation path", with "(+N more)" when the request names more paths.</summary>
    public string Label => OperatorText.PendingLabel(this);

    /// <summary>The details pane: the name, request and run ids, then each operation and its resolved paths.</summary>
    public string Details => OperatorText.PendingDetails(this);

    public override string ToString() => Label;

    /// <summary>Reads one row; null when it has no id (it could not be decided).</summary>
    public static PendingRequest? FromJson(JsonElement row)
    {
        if (Json.String(row, "id") is not { Length: > 0 } id) return null;
        var operations = new List<RequestedOperation>();
        if (row.TryGetProperty("requests", out var requests) && requests.ValueKind == JsonValueKind.Array)
        {
            foreach (var request in requests.EnumerateArray())
            {
                var paths = new List<string>();
                if (request.ValueKind == JsonValueKind.Object
                    && request.TryGetProperty("paths", out var list) && list.ValueKind == JsonValueKind.Array)
                    paths.AddRange(list.EnumerateArray().Where(p => p.ValueKind == JsonValueKind.String).Select(p => p.GetString()!));
                operations.Add(new RequestedOperation(Json.String(request, "operation") ?? "", paths));
            }
        }
        return new PendingRequest
        {
            Id = id,
            RunId = Json.String(row, "runId"),
            DisplayName = OperatorText.CleanName(Json.String(row, "displayName")),
            Operations = operations,
        };
    }
}

/// <summary>A retained run receipt from <c>history list</c>, kept whole for the details pane.</summary>
public sealed class RunRecord
{
    public string? RunId { get; init; }

    public string? Status { get; init; }

    public string? DisplayName { get; init; }

    public DateTimeOffset? StartedAt { get; init; }

    /// <summary>How long the run held Revit (the receipt's <c>held.ms</c>); null for a run that never used the bridge.</summary>
    public TimeSpan? Held { get; init; }

    /// <summary>The receipt as operator.js printed it, every field included.</summary>
    public required JsonElement Receipt { get; init; }

    /// <summary>The zone <see cref="Label"/> shows <see cref="StartedAt"/> in; the machine's by default.</summary>
    public TimeZoneInfo TimeZone { get; init; } = TimeZoneInfo.Local;

    /// <summary>The list row: "displayName · status · local time".</summary>
    public string Label => OperatorText.HistoryLabel(this);

    /// <summary>The row's first line: the display name, or the run ID for older receipts.</summary>
    public string Title => DisplayName ?? RunId ?? "(unnamed run)";

    /// <summary>The row's second line: "status · held Revit 12 s · local time" (the middle part only for a held run).</summary>
    public string Meta => OperatorText.HistoryMeta(this);

    /// <summary>The details pane: the receipt as indented JSON.</summary>
    public string Details => OperatorText.PrettyJson(Receipt);

    public override string ToString() => Label;

    public static RunRecord FromJson(JsonElement row, TimeZoneInfo? timeZone = null)
    {
        DateTimeOffset? started = null;
        if (Json.String(row, "startedAt") is { } text
            && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed))
            started = parsed;
        return new RunRecord
        {
            RunId = Json.String(row, "runId"),
            Status = Json.String(row, "status"),
            DisplayName = OperatorText.CleanName(Json.String(row, "displayName")),
            StartedAt = started,
            Held = ReadHeld(row),
            Receipt = row.Clone(),
            TimeZone = timeZone ?? TimeZoneInfo.Local,
        };
    }

    /// <summary>The receipt's <c>held: {ms, calls}</c> (spec #15 "What Comes Back"); null when absent, null or malformed.</summary>
    private static TimeSpan? ReadHeld(JsonElement row)
    {
        if (row.ValueKind != JsonValueKind.Object
            || !row.TryGetProperty("held", out var held) || held.ValueKind != JsonValueKind.Object
            || !held.TryGetProperty("ms", out var ms) || ms.ValueKind != JsonValueKind.Number
            || !ms.TryGetDouble(out var milliseconds) || milliseconds < 0)
            return null;
        return TimeSpan.FromMilliseconds(milliseconds);
    }
}

/// <summary>The window's list labels and detail text, kept apart from WPF so they are unit tested.</summary>
public static class OperatorText
{
    public const string HistorySeparator = " · ";
    public const string PendingSeparator = " — ";
    public const string TimeFormat = "yyyy-MM-dd HH:mm";

    private static readonly JsonSerializerOptions Indented = new()
    {
        WriteIndented = true,
        // Paths and names are shown as typed, not as \u escapes; this text is only displayed.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>A display name on one line; null when blank.</summary>
    public static string? CleanName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        return string.Join(' ', name.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    public static string HistoryLabel(RunRecord run)
    {
        var meta = HistoryMeta(run);
        return meta.Length == 0 ? run.Title : run.Title + HistorySeparator + meta;
    }

    public static string HistoryMeta(RunRecord run)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(run.Status)) parts.Add(run.Status!);
        if (run.Held is { } held) parts.Add("held Revit " + HoldText.Duration(held));
        if (run.StartedAt is { } started)
            parts.Add(TimeZoneInfo.ConvertTime(started, run.TimeZone).ToString(TimeFormat, CultureInfo.InvariantCulture));
        return string.Join(HistorySeparator, parts);
    }

    public static string PendingLabel(PendingRequest request)
    {
        var name = request.DisplayName ?? request.RunId ?? request.Id;
        var first = request.Operations.FirstOrDefault(o => o.Paths.Count > 0) ?? request.Operations.FirstOrDefault();
        if (first is null) return name;
        var target = first.Paths.Count > 0 ? $"{first.Operation} {first.Paths[0]}".Trim() : first.Operation;
        var more = request.Operations.Sum(o => Math.Max(o.Paths.Count, 1)) - 1;
        return name + PendingSeparator + target + (more > 0 ? $" (+{more} more)" : "");
    }

    /// <summary>The operation and resolved path lines of the PowerShell window, under the name and ids.</summary>
    public static string PendingDetails(PendingRequest request)
    {
        var text = new StringBuilder();
        if (request.DisplayName is { } name) text.AppendLine(name).AppendLine();
        text.AppendLine($"Request: {request.Id}");
        if (!string.IsNullOrEmpty(request.RunId)) text.AppendLine($"Run: {request.RunId}");
        text.AppendLine();
        foreach (var operation in request.Operations)
        {
            text.AppendLine($"Operation: {operation.Operation}");
            foreach (var path in operation.Paths) text.AppendLine($"Resolved path: {path}");
            text.AppendLine();
        }
        return text.ToString().TrimEnd();
    }

    public static string PrettyJson(JsonElement element) => JsonSerializer.Serialize(element, Indented);
}
