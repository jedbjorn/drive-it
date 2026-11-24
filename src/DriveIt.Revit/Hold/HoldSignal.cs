using System.Diagnostics;
using System.Reflection;
using DriveIt.Core.Operator;
using DriveIt.UI;

namespace DriveIt.Revit.Hold;

/// <summary>One hold as the status window shows it: the run, its display name (decision #21), when it started and its bound.</summary>
public sealed record HoldInfo(string RunId, string? DisplayName, DateTimeOffset StartedAt, TimeSpan Limit);

/// <summary>
/// The hold's start/end signal for the status window and Stop (spec #15 "Status Window"), and
/// the Script time limit the add-in bounds every hold with ("Time Limit and Long Jobs"). The hold
/// calls <see cref="Started"/> at its first bridge call, checks the returned token at each call
/// boundary (cancelled = the person pressed Stop: roll back, release Revit, end the run with
/// <c>stopped_by_user</c>), and calls <see cref="Ended"/> however it ends. Neither call throws or
/// blocks Revit's thread.
/// </summary>
public static class HoldSignal
{
    private static readonly OperatorHost Host =
        OperatorHost.ForAssemblyDirectory(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location));

    /// <summary>
    /// The bound for a hold: the run's own limit when the server sent one below the Script time
    /// limit setting, else the setting. Read from the setting's file each time, so a change applies
    /// to the next run whatever the server or script asks.
    /// </summary>
    public static TimeSpan Limit(TimeSpan? requested)
    {
        var setting = TimeSpan.FromSeconds(ScriptTimeLimit.Read(Host));
        return requested is { } run && run > TimeSpan.Zero && run < setting ? run : setting;
    }

    /// <summary>A hold started. The token is cancelled when the person presses Stop.</summary>
    public static CancellationToken Started(HoldInfo hold)
    {
        var stop = new CancellationTokenSource();
        try
        {
            HoldStatus.Begin(hold.RunId, hold.DisplayName, hold.StartedAt, hold.Limit, stop.Cancel);
        }
        catch (Exception exception)
        {
            // No window means no Stop; the hold is still bounded by its limit.
            Trace.WriteLine($"Drive-It: the hold status window could not start ({exception.GetType().Name}: {exception.Message}).");
        }
        return stop.Token;
    }

    /// <summary>The hold ended, however it ended. Safe to call more than once.</summary>
    public static void Ended(string runId)
    {
        try
        {
            HoldStatus.End(runId);
        }
        catch (Exception exception)
        {
            Trace.WriteLine($"Drive-It: the hold status window could not close ({exception.GetType().Name}: {exception.Message}).");
        }
    }
}
