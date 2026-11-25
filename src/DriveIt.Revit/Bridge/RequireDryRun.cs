using Autodesk.Revit.DB;
using DriveIt.Revit.Broker;

namespace DriveIt.Revit.Bridge;

/// <summary>
/// Require dry run (spec #13 "Require Dry Run"): what a real run may do while the setting is on. The server decides
/// whether the run was rehearsed and says so on the hold and on each built-in batch; the add-in refuses a model change in
/// an unrehearsed run at the first transaction on a document, and refuses the lasting operations in every run.
/// </summary>
internal static class RequireDryRunRules
{
    public const string Required = "dry_run_required";
    public const string NotAllowed = "not_allowed_while_dry_run_required";

    /// <summary>The built-in operations refused in every run while the setting is on (D3, D9), and what makes each lasting.</summary>
    public static readonly IReadOnlyDictionary<string, string> Lasting = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["save_document"] = "a save writes the model to disk",
        ["save_as_document"] = "a save-as writes the model to disk",
        ["delete_document"] = "deleting removes the file",
    };

    /// <summary>
    /// A real run's first transaction on a document while the setting is on (D12). An unrehearsed run changes nothing; a
    /// rehearsed one changes only the documents its dry run changed and the documents it created itself (D8).
    /// </summary>
    public static void RequireRehearsed(RequireDryRunGuard guard, string runId, Document document)
    {
        if (!guard.Rehearsed)
            throw Unrehearsed(document);
        if (RunDocuments.IsOwn(runId, document))
            return;
        var path = string.IsNullOrWhiteSpace(document.PathName) ? null : document.PathName;
        if (guard.Documents?.Any(rehearsed => rehearsed.Title == document.Title
                && string.Equals(rehearsed.Path, path, StringComparison.OrdinalIgnoreCase)) == true)
            return;
        throw new RequestRejectedException(Required,
            $"Require dry run is on and this run's dry run did not change {document.Title}, so changing it is refused: {document.Title} was not changed. "
            + "A dry run rehearses only the documents it changed. Check which document the call reaches (it may not be the one shown in Revit's window now), "
            + "dry-run the same call on it, compare the result with the request, then run the same call again without dryRun.");
    }

    public static RequestRejectedException Unrehearsed(Document document) => new(Required,
        $"Require dry run is on and this run was not rehearsed, so changing {document.Title} is refused: nothing was changed. "
        + "Dry-run the same call first (execute_script with dryRun: true), compare the result with the request, then run the same call again without dryRun.");

    public static string NotAllowedMessage(string operation, string reason) =>
        $"{operation} is not allowed while Require dry run is on: {reason}, and Drive-It leaves that to the person. "
        + "Do not retry it. Tell the user which documents have unsaved changes and ask them to save in Revit, or to turn Require dry run off in the Drive-It window's Settings if they want you to save.";

    /// <summary>D10: closing a document that has unsaved changes would discard them for good.</summary>
    public static RequestRejectedException CloseChanged(string operation, Document document) => new(NotAllowed,
        NotAllowedMessage(operation, $"{document.Title} has unsaved changes and closing it would discard them"));
}

/// <summary>
/// The documents a run made its own: created (create_document, edit_family and their Dev Mode members), which a rehearsed
/// run under Require dry run may change whatever its dry run changed (spec #13 D8), and opened by path (open_document and
/// its Dev Mode members), which with the created ones a run may change without naming them (spec #28 "The Rule"). Kept
/// per run id, the most recent few only.
/// </summary>
internal static class RunDocuments
{
    private const int Kept = 256;
    private static readonly List<(string RunId, Document Document, bool Created)> Own = [];

    public static void Add(string runId, Document document, bool created)
    {
        lock (Own)
        {
            Own.Add((runId, document, created));
            if (Own.Count > Kept)
                Own.RemoveAt(0);
        }
    }

    /// <summary>Spec #13 D8: the run created this document.</summary>
    public static bool IsOwn(string runId, Document document)
    {
        lock (Own)
            return Own.Any(entry => entry.Created && entry.RunId == runId && Same(entry.Document, document));
    }

    /// <summary>Spec #28: the run created this document or opened it by path.</summary>
    public static bool BelongsTo(string runId, Document document)
    {
        lock (Own)
            return Own.Any(entry => entry.RunId == runId && Same(entry.Document, document));
    }

    private static bool Same(Document left, Document right)
    {
        if (ReferenceEquals(left, right))
            return true;
        try
        {
            return left.IsValidObject && right.IsValidObject && left.Equals(right);
        }
        catch (Exception)
        {
            return false;
        }
    }
}
