using System.Diagnostics;

namespace DriveIt.Revit.Bridge;

/// <summary>A hold has begun: Revit is paused for this run until <see cref="Deadline"/> at the latest.</summary>
public sealed record HoldStarted(string RunId, string? DisplayName, DateTimeOffset StartedAt, DateTimeOffset Deadline, bool DryRun = false);

/// <summary>
/// A hold has ended. Outcome is "committed", "rolled_back", "timed_out", "stopped_by_user", "disconnected",
/// or "rollback_failed" when a document could not be restored.
/// </summary>
public sealed record HoldEnded(string RunId, string Outcome, DateTimeOffset EndedAt, int Calls, bool DryRun = false);

/// <summary>
/// The add-in's in-process view of the hold, for the status window and the time limit setting.
/// Handlers run on Revit's blocked thread: they must return at once (marshal to your own dispatcher)
/// and must not throw; an exception is traced and ignored.
/// </summary>
public static class HoldSignal
{
    private static readonly object Gate = new();
    private static HeldRun? active;

    /// <summary>Raised on Revit's thread when a hold begins, before its first call is served.</summary>
    public static event Action<HoldStarted>? Started;

    /// <summary>Raised on Revit's thread after the commit or rollback, just before Revit is released.</summary>
    public static event Action<HoldEnded>? Ended;

    /// <summary>
    /// The add-in's own bound on every hold, whatever the server or script asks. The default is 120 seconds,
    /// today's maximum run time; the Script time limit setting replaces it.
    /// </summary>
    public static Func<TimeSpan> TimeLimit { get; set; } = () => TimeSpan.FromSeconds(120);

    /// <summary>
    /// The cap on a hold's time limit, whatever TimeLimit returns: the top of the Script time limit setting's
    /// 10 to 600 second range (spec #15). The limit is checked between Revit calls, so a hold can run past it;
    /// capture_revit_view waits until the pipe frees rather than for this long (server/capture.js).
    /// </summary>
    public static readonly TimeSpan MaximumTimeLimit = TimeSpan.FromSeconds(600);

    /// <summary>
    /// Thread-safe. Returns true when runId is the active hold. The hold ends at the next call boundary
    /// (a call already in progress finishes first): everything is rolled back, Revit is released, and
    /// the outcome is "stopped_by_user".
    /// </summary>
    public static bool RequestStop(string runId)
    {
        lock (Gate)
        {
            if (active is null || active.RunId != runId)
                return false;
            active.RequestStop();
            return true;
        }
    }

    internal static TimeSpan CurrentTimeLimit()
    {
        try
        {
            var limit = TimeLimit();
            if (limit <= TimeSpan.Zero)
                return TimeSpan.FromSeconds(120);
            return limit < MaximumTimeLimit ? limit : MaximumTimeLimit;
        }
        catch (Exception exception)
        {
            Trace.WriteLine($"Drive-It: reading the hold time limit failed ({exception.GetType().Name}); using 120 s.");
            return TimeSpan.FromSeconds(120);
        }
    }

    internal static void RaiseStarted(HeldRun run)
    {
        lock (Gate)
            active = run;
        Raise(Started, new HoldStarted(run.RunId, run.DisplayName, run.StartedAt, run.Deadline, run.DryRun));
    }

    internal static void RaiseEnded(HeldRun run, string outcome)
    {
        lock (Gate)
        {
            if (ReferenceEquals(active, run))
                active = null;
        }
        Raise(Ended, new HoldEnded(run.RunId, outcome, DateTimeOffset.Now, run.Calls, run.DryRun));
    }

    private static void Raise<T>(Action<T>? handlers, T value)
    {
        if (handlers is null)
            return;
        foreach (var handler in handlers.GetInvocationList().Cast<Action<T>>())
        {
            try
            {
                handler(value);
            }
            catch (Exception exception)
            {
                Trace.WriteLine($"Drive-It: a hold signal handler failed ({exception.GetType().Name}: {exception.Message}).");
            }
        }
    }
}
