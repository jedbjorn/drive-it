using System.Globalization;
using System.Text.Json;

namespace DriveIt.Core.Operator;

/// <summary>
/// The Script time limit (spec #15 "Time Limit and Long Jobs"): the longest any single
/// execute_script run may take, and so the longest Revit can be held at a stretch. It is
/// <c>scriptTimeLimitSeconds</c> in <c>settings.json</c> in the Drive-It data directory, written by
/// <c>operator.js settings set-time-limit</c> (server/settings.js, which holds the same rules).
/// The add-in reads it here, so its hold is bounded by it whatever the server or script asks.
/// </summary>
public static class ScriptTimeLimit
{
    public const int DefaultSeconds = 120;
    public const int MinimumSeconds = 10;
    public const int MaximumSeconds = 600;
    public const string FileName = "settings.json";
    public const string PropertyName = "scriptTimeLimitSeconds";

    /// <summary>The setting's help text: what a higher limit trades.</summary>
    public const string HelpText =
        "The longest one script may run, and so the longest Revit can be paused at a stretch. " +
        "A higher limit lets one script do more, and pauses Revit for longer. " +
        "Long tasks run as many scripts, with Revit free between them. 10 to 600 seconds; applies to future runs.";

    public static bool IsValid(int seconds) => seconds is >= MinimumSeconds and <= MaximumSeconds;

    /// <summary>
    /// A whole number of seconds typed by the person, or null with <paramref name="error"/> saying
    /// what is accepted.
    /// </summary>
    public static int? Parse(string? text, out string? error)
    {
        error = null;
        if (int.TryParse(text?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var seconds) && IsValid(seconds))
            return seconds;
        error = $"The script time limit must be a whole number of seconds from {MinimumSeconds} to {MaximumSeconds}.";
        return null;
    }

    /// <summary>
    /// Written by server/settings.js when the limit is lowered: the latest moment a run that started
    /// under the earlier, higher limit can still be running.
    /// </summary>
    public const string EarlierLimitUntilName = "earlierLimitUntil";

    /// <summary>The setting in <paramref name="dataDirectory"/>; the default when the file or value is missing, unreadable or out of range.</summary>
    public static int Read(string dataDirectory, Func<string, string>? readAllText = null) =>
        ReadStored(dataDirectory, readAllText).Seconds;

    /// <summary>The setting for the installed Drive-It this assembly belongs to (<see cref="OperatorLocator.DataDirectory"/>).</summary>
    public static int Read(OperatorHost host) => Read(OperatorLocator.DataDirectory(host), host.ReadAllText);

    /// <summary>
    /// The add-in's bound on a hold that starts at <paramref name="now"/>: the setting, or longer while
    /// a run started under an earlier, higher limit may still be running. The setting applies to future
    /// runs, and a hold begins at a run's first bridge call, after the run started; this keeps a lowered
    /// setting from shortening a run already in progress. The server asks for the run's own remaining
    /// time, and the hold takes the shorter of the two.
    /// </summary>
    public static TimeSpan HoldLimit(string dataDirectory, DateTimeOffset now, Func<string, string>? readAllText = null)
    {
        var (seconds, earlierUntil) = ReadStored(dataDirectory, readAllText);
        var limit = TimeSpan.FromSeconds(seconds);
        var earlier = earlierUntil is { } until ? until - now : TimeSpan.Zero;
        var longest = TimeSpan.FromSeconds(MaximumSeconds);
        if (earlier > longest) earlier = longest; // a hand-edited moment far ahead never lifts the cap
        return earlier > limit ? earlier : limit;
    }

    /// <summary>The hold limit for the installed Drive-It this assembly belongs to (<see cref="OperatorLocator.DataDirectory"/>).</summary>
    public static TimeSpan HoldLimit(OperatorHost host, DateTimeOffset now) =>
        HoldLimit(OperatorLocator.DataDirectory(host), now, host.ReadAllText);

    private static (int Seconds, DateTimeOffset? EarlierUntil) ReadStored(string dataDirectory, Func<string, string>? readAllText)
    {
        try
        {
            var text = (readAllText ?? File.ReadAllText)(Path.Combine(dataDirectory, FileName));
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return (DefaultSeconds, null);
            var seconds = root.TryGetProperty(PropertyName, out var value)
                && value.ValueKind == JsonValueKind.Number
                && value.TryGetInt32(out var stored)
                && IsValid(stored) ? stored : DefaultSeconds;
            DateTimeOffset? earlierUntil = root.TryGetProperty(EarlierLimitUntilName, out var until)
                && until.ValueKind == JsonValueKind.String
                && DateTimeOffset.TryParse(until.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var moment)
                ? moment : null;
            return (seconds, earlierUntil);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            // Missing or unreadable: the default, as the server reads it.
            return (DefaultSeconds, null);
        }
    }
}
