using System.Diagnostics;
using System.Windows.Threading;

namespace DriveIt.UI;

/// <summary>
/// Shows the hold status window (spec #15 "Status Window") on a thread of its own, so it stays
/// live while Revit's thread is held. <see cref="Begin"/> and <see cref="End"/> never block the
/// caller beyond starting that thread once: they queue work onto it. The window appears once
/// the hold has lasted <see cref="ShowAfter"/>, so short runs do not flash it, and closes when
/// the hold ends. One hold at a time (Revit runs one); a new Begin replaces an earlier one.
/// </summary>
public static class HoldStatus
{
    public static readonly TimeSpan ShowAfter = TimeSpan.FromSeconds(1);

    private static readonly object Gate = new();
    private static Dispatcher? _dispatcher;

    // Touched only on the status thread.
    private static string? _runId;
    private static DispatcherTimer? _pending;
    private static HoldStatusWindow? _window;

    /// <summary>A hold started: show the window once it has lasted <see cref="ShowAfter"/>. <paramref name="stop"/> runs on the status thread when the person presses Stop.</summary>
    public static void Begin(string runId, string? displayName, DateTimeOffset startedAt, TimeSpan limit, Action stop)
    {
        var dispatcher = StatusDispatcher();
        dispatcher.InvokeAsync(() =>
        {
            CloseCurrent();
            _runId = runId;
            var delay = ShowAfter - (DateTimeOffset.UtcNow - startedAt);
            if (delay < TimeSpan.Zero) delay = TimeSpan.Zero;
            // This DispatcherTimer constructor starts the timer.
            _pending = new DispatcherTimer(delay, DispatcherPriority.Normal, (sender, _) =>
            {
                ((DispatcherTimer)sender!).Stop();
                _pending = null;
                if (_runId != runId) return;
                _window = new HoldStatusWindow(displayName, startedAt, limit, stop);
                _window.Show();
            }, dispatcher);
        });
    }

    /// <summary>The hold ended, however it ended: close its window, or never show it.</summary>
    public static void End(string runId)
    {
        StatusDispatcher().InvokeAsync(() =>
        {
            if (_runId == runId) CloseCurrent();
        });
    }

    private static void CloseCurrent()
    {
        _pending?.Stop();
        _pending = null;
        _window?.CloseForHoldEnd();
        _window = null;
        _runId = null;
    }

    private static Dispatcher StatusDispatcher()
    {
        lock (Gate)
        {
            if (_dispatcher is { HasShutdownStarted: false } running) return running;

            using var ready = new ManualResetEventSlim();
            Dispatcher? created = null;
            var thread = new Thread(() =>
            {
                created = Dispatcher.CurrentDispatcher;
                // Nothing on this thread may reach Revit: a failure is traced and the thread keeps running.
                created.UnhandledException += (_, e) =>
                {
                    Trace.WriteLine($"Drive-It: hold status window failed ({e.Exception.GetType().Name}: {e.Exception.Message}).");
                    e.Handled = true;
                };
                SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(created));
                ready.Set();
                Dispatcher.Run();
            })
            {
                IsBackground = true,
                Name = "Drive-It hold status",
            };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            ready.Wait();
            _dispatcher = created!;
            return _dispatcher;
        }
    }
}
