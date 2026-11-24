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

    public static RequestRejectedException Unrehearsed(Document document) => new(Required,
        $"Require dry run is on and this run was not rehearsed, so changing {document.Title} is refused: nothing was changed. "
        + "Dry-run the same call first (execute_script with dryRun: true), compare the result with the request, then run the same call again without dryRun.");

    public static string NotAllowedMessage(string operation, string reason) =>
        $"{operation} is not allowed while Require dry run is on: {reason}, and Drive-It leaves that to the person. "
        + "Do not retry it. Tell the user which documents have unsaved changes and ask them to save in Revit, or to turn Require dry run off in the Drive-It window if they want you to save.";

    /// <summary>D10: closing a document that has unsaved changes would discard them for good.</summary>
    public static RequestRejectedException CloseChanged(string operation, Document document) => new(NotAllowed,
        NotAllowedMessage(operation, $"{document.Title} has unsaved changes and closing it would discard them"));
}
