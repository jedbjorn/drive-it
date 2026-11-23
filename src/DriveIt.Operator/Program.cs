using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using DriveIt.Core.Theming;
using DriveIt.UI;
using DriveIt.UI.Theming;

namespace DriveIt.Operator;

/// <summary>
/// The Start Menu entry point: opens the operator window in the Windows app theme. A second
/// launch brings the open window forward instead. <c>--self-test [report.json]</c> opens and
/// closes the window in each theme against the installed operator.js and writes what it saw
/// (the installer tests use it; nothing waits for input).
/// </summary>
public static class Program
{
    private const string InstanceName = @"Local\DriveIt.Operator";

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--self-test")
            return SelfTest(args.Length > 1 ? args[1] : null);

        using var instance = new Mutex(initiallyOwned: true, InstanceName, out var first);
        if (!first)
        {
            BringExistingWindowForward();
            return 0;
        }

        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        app.DispatcherUnhandledException += (_, e) =>
        {
            MessageBox.Show("Drive-It stopped: " + e.Exception.Message, "Drive-It", MessageBoxButton.OK, MessageBoxImage.Error);
            e.Handled = true;
            app.Shutdown(1);
        };
        app.Startup += (_, _) =>
        {
            app.MainWindow = OperatorLauncher.Show(theme: WindowsTheme.Detect());
        };
        return app.Run();
    }

    private static int SelfTest(string? reportPath)
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var windows = new List<object>();
        string? failure = null;

        app.DispatcherUnhandledException += (_, e) =>
        {
            failure = e.Exception.ToString();
            e.Handled = true;
            Finish(app, reportPath, windows, failure);
        };
        app.Startup += async (_, _) =>
        {
            try
            {
                foreach (var theme in new[] { UiTheme.Light, UiTheme.Dark })
                {
                    DriveItTheme.Apply(theme);
                    var window = OperatorLauncher.Create(promptForMissingRoot: false);
                    window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
                    window.ShowActivated = false;
                    window.Show();
                    if (await Task.WhenAny(window.Ready, Task.Delay(TimeSpan.FromSeconds(90))) != window.Ready)
                        throw new TimeoutException("The operator window did not finish loading.");
                    window.UpdateLayout();
                    windows.Add(new
                    {
                        theme = theme.ToString(),
                        title = window.Title,
                        workspaceRoot = window.WorkspaceRoot,
                        pending = window.PendingCount,
                        history = window.HistoryCount,
                        error = window.ErrorMessage,
                    });
                    window.Close();
                }
            }
            catch (Exception exception)
            {
                failure = exception.ToString();
            }
            Finish(app, reportPath, windows, failure);
        };
        return app.Run();
    }

    private static bool _finished;

    private static void Finish(Application app, string? reportPath, List<object> windows, string? failure)
    {
        if (_finished) return;
        _finished = true;
        var report = JsonSerializer.Serialize(new { passed = failure is null, windows, failure }, new JsonSerializerOptions { WriteIndented = true });
        try
        {
            if (!string.IsNullOrEmpty(reportPath)) File.WriteAllText(reportPath, report);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            failure ??= exception.ToString();
        }
        app.Dispatcher.BeginInvoke(DispatcherPriority.Background, () => app.Shutdown(failure is null ? 0 : 1));
    }

    private static void BringExistingWindowForward()
    {
        using var current = Process.GetCurrentProcess();
        foreach (var other in Process.GetProcessesByName(current.ProcessName))
        {
            using (other)
            {
                if (other.Id == current.Id || other.MainWindowHandle == IntPtr.Zero) continue;
                if (IsIconic(other.MainWindowHandle)) ShowWindow(other.MainWindowHandle, RestoreWindow);
                SetForegroundWindow(other.MainWindowHandle);
                return;
            }
        }
    }

    private const int RestoreWindow = 9;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
}
