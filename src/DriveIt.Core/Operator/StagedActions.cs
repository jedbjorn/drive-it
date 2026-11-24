using System.Globalization;
using System.Text.Json;

namespace DriveIt.Core.Operator;

/// <summary>One readable line of Staged Actions mode, with the lines under it (ids, changed values).</summary>
public sealed record StagedLine(string Text, IReadOnlyList<string> Details);

/// <summary>Created, Modified or Deleted in one document: a heading with its count, then its lines.</summary>
public sealed record StagedGroup(string Heading, IReadOnlyList<StagedLine> Lines);

/// <summary>One document a dry run changed: its groups, then "Also touched by Revit" as one collapsed line.</summary>
public sealed record StagedDocument(string Title, IReadOnlyList<StagedGroup> Groups, string? AlsoTouched, IReadOnlyList<string> AlsoTouchedLines);

/// <summary>One image the dry run exported, or the reason it could not be.</summary>
public sealed record StagedImage(string Caption, string? Path, string? Error);

/// <summary>
/// The dry run Staged Actions mode shows (spec #13 "The dry run shown"), from <c>operator.js staged get</c>: the last
/// dry run that completed in this workspace, whatever its outcome, with Applied once the same call ran for real and
/// succeeded. Everything here is plain words for the person; the receipt itself stays in run history.
/// </summary>
public sealed class StagedDryRun
{
    public required string RunId { get; init; }

    /// <summary>The dry run's display name (decision #21), or a plain fallback.</summary>
    public required string Title { get; init; }

    /// <summary>"2026-11-25 14:03 · Tower · Succeeded": time, document and outcome.</summary>
    public required string Meta { get; init; }

    /// <summary>Succeeded, Failed, Stopped, Timed out or Denied.</summary>
    public required string Outcome { get; init; }

    /// <summary>The dry run did not succeed: <see cref="ErrorText"/> shows in place of the lists.</summary>
    public bool Failed { get; init; }

    public string? ErrorText { get; init; }

    /// <summary>The same call has since run for real and succeeded.</summary>
    public bool Applied { get; init; }

    public IReadOnlyList<StagedDocument> Documents { get; init; } = [];

    /// <summary>One line when a succeeded dry run would change no element.</summary>
    public string? NothingChanged { get; init; }

    public IReadOnlyList<StagedImage> Images { get; init; } = [];

    /// <summary>One line per workshared document: borrowed elements released, or what to do when they were not.</summary>
    public IReadOnlyList<string> Worksharing { get; init; } = [];

    /// <summary>Reads <c>staged get</c>'s output; null when no dry run has completed in this workspace.</summary>
    public static StagedDryRun? FromJson(JsonElement root, TimeZoneInfo? timeZone = null)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("dryRun", out var dry) || dry.ValueKind != JsonValueKind.Object)
            return null;
        var status = Json.String(dry, "status") ?? "";
        var error = Object(dry, "error");
        var code = error is { } e ? Json.String(e, "code") : null;
        var outcome = StagedText.Outcome(status, code);
        var failed = status != "succeeded";
        var document = Object(dry, "document") is { } d ? Json.String(d, "title") ?? FileName(Json.String(d, "path")) : null;
        var parts = new List<string>();
        if (Json.String(dry, "completedAt") is { } text
            && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var completed))
            parts.Add(TimeZoneInfo.ConvertTime(completed, timeZone ?? TimeZoneInfo.Local).ToString(OperatorText.TimeFormat, CultureInfo.InvariantCulture));
        if (document is not null) parts.Add(document);
        parts.Add(outcome);

        var documents = failed ? [] : Array(dry, "actions").Select(ReadDocument).ToList();
        return new StagedDryRun
        {
            RunId = Json.String(dry, "runId") ?? "",
            Title = OperatorText.CleanName(Json.String(dry, "displayName")) ?? "Dry run",
            Meta = string.Join(OperatorText.HistorySeparator, parts),
            Outcome = outcome,
            Failed = failed,
            ErrorText = failed ? (error is { } message ? Json.String(message, "message") : null) ?? StagedText.NoError : null,
            Applied = dry.TryGetProperty("applied", out var applied) && applied.ValueKind == JsonValueKind.True,
            Documents = documents,
            NothingChanged = !failed && documents.All(entry => entry.Groups.Count == 0 && entry.AlsoTouched is null) ? StagedText.NothingChanged : null,
            Images = failed ? [] : Array(dry, "images").Select(ReadImage).ToList(),
            Worksharing = Array(dry, "worksharing").Select(ReadRelease).ToList(),
        };
    }

    private static StagedDocument ReadDocument(JsonElement entry)
    {
        var groups = new List<StagedGroup>();
        AddGroup(groups, StagedText.Created, Object(entry, "created"), GroupedLines);
        AddGroup(groups, StagedText.Modified, Object(entry, "modified"), ModifiedLines);
        AddGroup(groups, StagedText.Deleted, Object(entry, "deleted"), GroupedLines);
        string? touched = null;
        var touchedLines = new List<string>();
        if (Object(entry, "alsoTouched") is { } also && Int(also, "total") is int total && total > 0)
        {
            touched = StagedText.AlsoTouched(total);
            touchedLines.AddRange(Array(also, "categories").Select(category =>
                $"{Json.String(category, "category") ?? StagedText.NoCategory}: {Int(category, "count") ?? 0}"));
        }
        return new StagedDocument(Json.String(entry, "document") ?? FileName(Json.String(entry, "path")) ?? "Document", groups, touched, touchedLines);
    }

    private static void AddGroup(List<StagedGroup> groups, string name, JsonElement? group, Func<JsonElement, List<StagedLine>> read)
    {
        if (group is not { } value || Int(value, "total") is not int total || total <= 0) return;
        var lines = read(value);
        var listed = name == StagedText.Modified ? lines.Count : CountListed(value);
        if (total > listed) lines.Add(new StagedLine(StagedText.NotListed(total - listed), []));
        groups.Add(new StagedGroup($"{name} ({total})", lines));
    }

    private static int CountListed(JsonElement group) => Array(group, "groups").Sum(entry => Array(entry, "elements").Count());

    // Created and Deleted: one line per category and type with its count, then the elements under it.
    private static List<StagedLine> GroupedLines(JsonElement group) => Array(group, "groups").Select(entry =>
    {
        var elements = Array(entry, "elements").Select(element =>
        {
            var id = Id(element);
            if (Json.String(element, "readError") is { } readError) return $"{id}: {StagedText.CouldNotRead} ({readError})";
            return Json.String(element, "name") is { Length: > 0 } name ? $"{id} {name}" : id;
        }).ToList();
        var label = Label(entry);
        var count = Int(entry, "count") ?? elements.Count;
        return new StagedLine(count > 1 ? $"{label} × {count}" : label, elements.Count > 0 ? [string.Join(", ", elements)] : []);
    }).ToList();

    // Modified: one line per element, then each changed value as "Mark: D12 → D14", and Moved.
    private static List<StagedLine> ModifiedLines(JsonElement group) => Array(group, "elements").Select(element =>
    {
        var details = new List<string>();
        if (Json.String(element, "readError") is { } readError) details.Add($"{StagedText.CouldNotRead} ({readError})");
        details.AddRange(Array(element, "values").Select(value =>
            StagedText.Change(Json.String(value, "name") ?? "", Text(value, "before"), Text(value, "after"))));
        if (element.TryGetProperty("moved", out var moved) && moved.ValueKind == JsonValueKind.True) details.Add(StagedText.Moved);
        var listed = Array(element, "values").Count();
        if (Int(element, "changedValues") is int changed && changed > listed) details.Add(StagedText.MoreValues(changed - listed));
        return new StagedLine($"{Label(element)} {Id(element)}", details);
    }).ToList();

    private static StagedImage ReadImage(JsonElement image)
    {
        var name = Json.String(image, "name") ?? $"View {Id(image, "viewId")}";
        var caption = Json.String(image, "type") is { Length: > 0 } type ? $"{name} ({type})" : name;
        var error = Json.String(image, "error");
        return new StagedImage(caption, error is null ? Json.String(image, "path") : null,
            error is null ? null : Json.String(image, "message") ?? error);
    }

    private static string ReadRelease(JsonElement entry)
    {
        var document = Json.String(entry, "document") ?? FileName(Json.String(entry, "path")) ?? "the model";
        return entry.TryGetProperty("released", out var released) && released.ValueKind == JsonValueKind.True
            ? StagedText.Released(document)
            : StagedText.NotReleased(document);
    }

    /// <summary>"Doors · Single-Flush: 0915 x 2134mm": category, then family and type as Revit names them.</summary>
    private static string Label(JsonElement element)
    {
        var category = Json.String(element, "category");
        var familyType = string.Join(": ", new[] { Json.String(element, "family"), Json.String(element, "type") }.Where(part => !string.IsNullOrWhiteSpace(part)));
        var parts = new[] { category, familyType }.Where(part => !string.IsNullOrWhiteSpace(part)).ToList();
        return parts.Count > 0 ? string.Join(OperatorText.HistorySeparator, parts) : StagedText.NoCategory;
    }

    private static string Id(JsonElement element, string name = "id") =>
        element.TryGetProperty(name, out var id) ? id.ValueKind == JsonValueKind.String ? id.GetString() ?? "" : id.GetRawText() : "";

    private static string Text(JsonElement element, string name) =>
        !element.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null ? StagedText.Empty
        : value.ValueKind == JsonValueKind.String ? (value.GetString() is { Length: > 0 } text ? text : StagedText.Empty)
        : value.GetRawText();

    private static JsonElement? Object(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object ? value : null;

    private static IEnumerable<JsonElement> Array(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.Object).ToList()
            : [];

    private static int? Int(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var number) ? number : null;

    private static string? FileName(string? path) => string.IsNullOrWhiteSpace(path) ? null : System.IO.Path.GetFileName(path);
}

/// <summary>The words of Staged Actions mode and its switcher (spec #13 "Staged Actions mode"), kept apart from WPF so they are unit tested.</summary>
public static class StagedText
{
    public const string StagedActionsMode = "Staged Actions";
    public const string HomeMode = "Home";
    public const string AppliedBadge = "Applied";
    public const string Created = "Created";
    public const string Modified = "Modified";
    public const string Deleted = "Deleted";
    public const string Moved = "Moved";
    public const string CouldNotRead = "could not be read";
    public const string NoCategory = "Element";
    public const string Empty = "(empty)";
    public const string NoError = "The dry run did not say why.";
    public const string NoneYet = "No dry run has completed in this workspace yet. When the agent rehearses a script, it shows here.";
    public const string NothingChanged = "This dry run would change no elements.";
    public const string IdsNote = "Ids are from the dry run: every change was rolled back, so those elements no longer exist.";

    public static string Outcome(string status, string? code) => (status, code) switch
    {
        ("succeeded", _) => "Succeeded",
        (_, "stopped_by_user") => "Stopped",
        ("timed_out", _) or (_, "RUN_TIMEOUT") => "Timed out",
        ("denied", _) => "Denied",
        _ => "Failed",
    };

    /// <summary>"Mark: D12 → D14".</summary>
    public static string Change(string name, string before, string after) => $"{name}: {before} → {after}";

    public static string AlsoTouched(int total) => $"Also touched by Revit: {total} {(total == 1 ? "element" : "elements")}";

    public static string NotListed(int count) => $"and {count} more not listed";

    public static string MoreValues(int count) => $"and {count} more {(count == 1 ? "value" : "values")}";

    public static string Released(string document) =>
        $"Borrowed elements in {document} were released after the dry run, including unmodified ones you had borrowed before.";

    public static string NotReleased(string document) =>
        $"Borrowed elements in {document} could not be released. Use Relinquish All Mine or Synchronize with Central in Revit.";
}
