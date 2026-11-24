using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using DriveIt.Core.Mode;
using DriveIt.Core.Operator;
using DriveIt.Core.Theming;
using DriveIt.UI;
using DriveIt.UI.Theming;

namespace DriveIt.Operator;

/// <summary>
/// The Start Menu entry point: opens the operator window in the Windows app theme. A second
/// launch brings the open window forward instead. <c>--self-test [report.json]</c> opens and
/// closes the window in each theme against the installed operator.js and writes what it saw
/// and the .NET version it ran on (the installer tests use it; nothing waits for input). In each
/// theme it also opens the settings drawer three times, closing it by its Close button, by Esc
/// and by a click on the dimmed area (spec #23 AC-1). <c>--drawer-writes</c> adds AC-2 and AC-6:
/// it saves limits through the drawer and changes one through operator.js, so run it only
/// against a throwaway data directory (<c>DRIVE_IT_DATA_DIR</c>). <c>--screenshots &lt;dir&gt;</c> saves
/// the window and the open drawer in each theme as PNGs (<c>light-main.png</c>, <c>light-settings.png</c>, …).
/// </summary>
public static class Program
{
    private const string InstanceName = @"Local\DriveIt.Operator";

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--self-test")
            return SelfTest(
                args.Length > 1 && !args[1].StartsWith("--", StringComparison.Ordinal) ? args[1] : null,
                drawerWrites: args.Contains("--drawer-writes"),
                screenshots: ValueAfter(args, "--screenshots"));

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

    private static string? ValueAfter(string[] args, string option)
    {
        var index = Array.IndexOf(args, option);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static int SelfTest(string? reportPath, bool drawerWrites, string? screenshots)
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
                    // The limit the window read when it opened, before the drawer reads or saves one.
                    var scriptTimeLimitSeconds = window.ScriptTimeLimitSeconds;
                    if (screenshots is not null) await Screenshots(window, screenshots, theme.ToString().ToLowerInvariant());
                    var drawer = await DrawerOpenAndClose(window);
                    var writes = drawerWrites ? await DrawerWrites(window) : null;
                    windows.Add(new
                    {
                        theme = theme.ToString(),
                        title = window.Title,
                        workspaceRoot = window.WorkspaceRoot,
                        scriptTimeLimitSeconds,
                        pending = window.PendingCount,
                        history = window.HistoryCount,
                        error = window.ErrorMessage,
                        mode = InstallMode.Name(window.Mode),
                        devModeBanner = window.DevModeBannerShown,
                        requestsShown = window.RequestsShown,
                        mainWindowSections = window.MainWindowSections,
                        mcpPathShown = window.McpPathShown,
                        drawer,
                        drawerWrites = writes,
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

    /// <summary>AC-1: open the drawer, read it, and close it each way a person can.</summary>
    private static async Task<List<object>> DrawerOpenAndClose(OperatorWindow window)
    {
        var cycles = new List<object>();
        foreach (var route in Enum.GetValues<SettingsCloseRoute>())
        {
            var buttonEnabled = window.SettingsButtonEnabled;
            await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
            window.UpdateLayout();
            var opened = window.SettingsOpen;
            var rows = window.SettingsRowNames;
            var focusInDrawer = window.FocusInSettings;
            var shownLimit = window.SettingsTimeLimitText;
            var error = window.SettingsTimeLimitError;
            window.CloseSettingsBy(route);
            window.UpdateLayout();
            cycles.Add(new
            {
                closedBy = JsonNamingPolicy.CamelCase.ConvertName(route.ToString()),
                settingsButtonEnabled = buttonEnabled,
                opened,
                rows,
                focusInDrawer,
                shownLimit,
                error,
                closed = !window.SettingsOpen,
                focusOnSettingsButton = window.FocusOnSettingsButton,
            });
        }
        return cycles;
    }

    /// <summary>
    /// AC-2 and AC-6, against the data directory the window uses: save 60; try 5 and abc (an error
    /// in the drawer, nothing written); a typed value is discarded on close; a limit changed by
    /// operator.js while the drawer is closed shows when it opens again.
    /// </summary>
    private static async Task<object> DrawerWrites(OperatorWindow window)
    {
        var host = OperatorLauncher.InstalledHost();
        var dataDirectory = OperatorLocator.DataDirectory(host);
        var settingsFile = Path.Combine(dataDirectory, ScriptTimeLimit.FileName);
        string? Stored() => File.Exists(settingsFile) ? File.ReadAllText(settingsFile) : null;

        await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
        await Within(window.SaveTimeLimitAsync("60"), "The settings drawer did not finish saving.");
        var saved = new
        {
            text = "60",
            shown = window.SettingsTimeLimitText,
            error = window.SettingsTimeLimitError,
            stored = ScriptTimeLimit.Read(dataDirectory),
        };

        var rejected = new List<object>();
        foreach (var text in new[] { "5", "abc" })
        {
            var before = Stored();
            await Within(window.SaveTimeLimitAsync(text), "The settings drawer did not finish saving.");
            rejected.Add(new
            {
                text,
                error = window.SettingsTimeLimitError,
                shown = window.SettingsTimeLimitText,
                unchanged = Stored() == before,
                stored = ScriptTimeLimit.Read(dataDirectory),
            });
        }

        window.TypeTimeLimit("77");
        window.CloseSettingsBy(SettingsCloseRoute.CloseButton);
        await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
        var typed = new { text = "77", shownOnReopen = window.SettingsTimeLimitText, stored = ScriptTimeLimit.Read(dataDirectory) };
        window.CloseSettingsBy(SettingsCloseRoute.Escape);

        var setByCommandLine = await new OperatorClient(new ProcessOperatorRunner(host)).SetScriptTimeLimitAsync(90);
        await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
        var reread = new { setByCommandLine, shownOnReopen = window.SettingsTimeLimitText, error = window.SettingsTimeLimitError };
        window.CloseSettingsBy(SettingsCloseRoute.Escape);

        return new { saved, rejected, typed, reread, closed = !window.SettingsOpen };
    }

    /// <summary>The window, then the window with the drawer open, as PNGs (spec #23 AC-3 and AC-7).</summary>
    private static async Task Screenshots(OperatorWindow window, string directory, string theme)
    {
        Directory.CreateDirectory(directory);
        Capture(window, Path.Combine(directory, theme + "-main.png"));
        await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
        Capture(window, Path.Combine(directory, theme + "-settings.png"));
        window.CloseSettingsBy(SettingsCloseRoute.CloseButton);
    }

    /// <summary>Renders the window's client area (its content's size, from the top left) to a PNG.</summary>
    private static void Capture(OperatorWindow window, string path)
    {
        window.UpdateLayout();
        var content = (FrameworkElement)window.Content;
        var bitmap = new RenderTargetBitmap(
            (int)Math.Ceiling(content.ActualWidth), (int)Math.Ceiling(content.ActualHeight), 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(window);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var file = File.Create(path);
        encoder.Save(file);
    }

    private static async Task Within(Task task, string message)
    {
        if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(90))) != task) throw new TimeoutException(message);
        await task;
    }

    private static bool _finished;

    private static void Finish(Application app, string? reportPath, List<object> windows, string? failure)
    {
        if (_finished) return;
        _finished = true;
        // runtime: the .NET version the window ran on (test/operator-runtime.Tests.ps1 checks it is 10 when 8 is absent).
        var report = JsonSerializer.Serialize(new { passed = failure is null, runtime = Environment.Version.ToString(), windows, failure }, new JsonSerializerOptions { WriteIndented = true });
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
