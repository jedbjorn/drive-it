using System.Globalization;

namespace DriveIt.Core.Operator;

/// <summary>
/// The words of the hold status window (spec #15 "Status Window") and of held runs in run
/// history, kept apart from WPF so they are unit tested.
/// </summary>
public static class HoldText
{
    public const string WindowTitle = "Drive-It";

    public const string PauseSentence = "Revit is paused until this finishes";

    public const string StopLabel = "Stop";

    public const string StoppingLabel = "Stopping…";

    /// <summary>The run's name: its display name (decision #21), or a plain fallback for an unnamed run.</summary>
    public static string Name(string? displayName) => OperatorText.CleanName(displayName) ?? "A Drive-It script is running";

    /// <summary>
    /// "0:12 of 2:00": the time elapsed and the time limit, in minutes and seconds. Elapsed counts whole
    /// seconds like a clock; the limit is rounded, because a hold starts a little after its run, so a
    /// 20 second limit leaves the hold 19.8 seconds, and "of 0:19" would contradict the setting.
    /// </summary>
    public static string Progress(TimeSpan elapsed, TimeSpan limit) =>
        Clock(Math.Floor(elapsed.TotalSeconds)) + " of " + Clock(Math.Round(limit.TotalSeconds, MidpointRounding.AwayFromZero));

    /// <summary>A short duration for run history: "29 ms", "9.9 s", "12 s", "2 min 5 s".</summary>
    public static string Duration(TimeSpan duration)
    {
        var seconds = Math.Max(0, duration.TotalSeconds);
        if (seconds < 1) return ((int)(seconds * 1000)).ToString(CultureInfo.InvariantCulture) + " ms";
        if (seconds < 10) return seconds.ToString("0.0", CultureInfo.InvariantCulture) + " s";
        if (seconds < 60) return ((int)seconds).ToString(CultureInfo.InvariantCulture) + " s";
        var whole = (int)seconds;
        return $"{whole / 60} min {whole % 60} s";
    }

    private static string Clock(double seconds)
    {
        var whole = (int)Math.Max(0, seconds);
        return $"{whole / 60}:{whole % 60:00}";
    }
}
