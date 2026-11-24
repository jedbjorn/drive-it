using System.Text.Json;

namespace DriveIt.Core.Operator;

/// <summary>
/// Require dry run (spec #13 "Require Dry Run"): <c>requireDryRun</c> in <c>settings.json</c> in the Drive-It data
/// directory, written by <c>operator.js settings set-require-dry-run on|off</c> (server/settings.js, which holds the
/// same rule). Only a stored <c>true</c> is on; a missing, malformed or unreadable value is off. The add-in reads it
/// here to decide whether to open the window in Staged Actions mode after a dry run.
/// </summary>
public static class RequireDryRun
{
    public const string PropertyName = "requireDryRun";

    /// <summary>The drawer row's help text (spec #13 "The drawer row").</summary>
    public const string HelpText =
        "Extra protection against lasting changes. The agent must rehearse a script that changes your model, " +
        "and see the result, before it runs for real. The agent cannot save while this is on: you save in Revit. " +
        "Reading and opening files work as usual. Each change pauses Revit twice.";

    /// <summary>The setting in <paramref name="dataDirectory"/>.</summary>
    public static bool Read(string dataDirectory, Func<string, string>? readAllText = null)
    {
        try
        {
            var text = (readAllText ?? File.ReadAllText)(Path.Combine(dataDirectory, ScriptTimeLimit.FileName));
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty(PropertyName, out var value)
                && value.ValueKind == JsonValueKind.True;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            return false;
        }
    }

    /// <summary>The setting for the installed Drive-It this assembly belongs to (<see cref="OperatorLocator.DataDirectory"/>).</summary>
    public static bool Read(OperatorHost host) => Read(OperatorLocator.DataDirectory(host), host.ReadAllText);
}
