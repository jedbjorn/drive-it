using System.ComponentModel;
using System.Windows;
using System.Windows.Threading;
using DriveIt.Core.Operator;
using DriveIt.UI.Theming;

namespace DriveIt.UI;

/// <summary>
/// One hold's status window: the run's name, "Revit is paused until this finishes", the time
/// elapsed and the limit, and Stop. Created, updated and closed only on <see cref="HoldStatus"/>'s
/// thread.
/// </summary>
public partial class HoldStatusWindow : Window
{
    private readonly DateTimeOffset _startedAt;
    private readonly TimeSpan _limit;
    private readonly Action _stop;
    private readonly DispatcherTimer _clock;
    private bool _closingByHost;

    public HoldStatusWindow(string? displayName, DateTimeOffset startedAt, TimeSpan limit, Action stop, bool dryRun = false)
    {
        InitializeComponent();
        DarkTitleBar.Attach(this);
        _startedAt = startedAt;
        _limit = limit;
        _stop = stop;
        // A dry run is labelled as one (spec #13 "How It Works"): its changes are rolled back whatever happens.
        Title = dryRun ? HoldText.DryRunWindowTitle : HoldText.WindowTitle;
        NameText.Text = HoldText.Name(displayName);
        PauseText.Text = dryRun ? HoldText.DryRunPauseSentence : HoldText.PauseSentence;
        StopButton.Content = HoldText.StopLabel;
        _clock = new DispatcherTimer(TimeSpan.FromMilliseconds(250), DispatcherPriority.Normal, (_, _) => Tick(), Dispatcher);
        Tick();
        _clock.Start();
    }

    /// <summary>True once the person has pressed Stop.</summary>
    public bool StopRequested { get; private set; }

    /// <summary>Closes the window because the hold ended; the only way it closes.</summary>
    public void CloseForHoldEnd()
    {
        _closingByHost = true;
        _clock.Stop();
        Close();
    }

    private void Tick() => ProgressText.Text = HoldText.Progress(DateTimeOffset.UtcNow - _startedAt, _limit);

    private void OnStop(object sender, RoutedEventArgs e)
    {
        if (StopRequested) return;
        StopRequested = true;
        StopButton.IsEnabled = false;
        StopButton.Content = HoldText.StoppingLabel;
        try
        {
            _stop();
        }
        catch (Exception exception)
        {
            // Stop must never take the window (or Revit) down; the hold still ends at its limit.
            System.Diagnostics.Trace.WriteLine($"Drive-It: Stop failed ({exception.GetType().Name}: {exception.Message}).");
        }
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        // The hold must stay visible while it lasts: the window closes when the hold ends.
        if (!_closingByHost) e.Cancel = true;
        base.OnClosing(e);
    }
}
