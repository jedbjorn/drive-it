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
/// <c>--detect-agents</c> adds AC-11: it presses Detect agents, which writes the current user's MCP
/// client configurations, so run it only with stand-in or throwaway client files; then it presses it
/// in a window naming a missing mcp.json, whose failure shows by the row. With <c>--screenshots</c> it
/// also saves the drawer with the results (<c>light-agents.png</c>, …).
/// <c>--staged-actions</c> adds spec #13 AC-18's window half: it turns Require dry run on and off through the
/// drawer's switch, fails a save, and writes dry-run receipts into run history for Staged Actions mode, so run it
/// only against a throwaway data directory. With <c>--screenshots</c> it saves the mode (<c>light-staged.png</c>,
/// <c>light-staged-failed.png</c>, …).
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
                detectAgents: args.Contains("--detect-agents"),
                stagedActions: args.Contains("--staged-actions"),
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

    private static int SelfTest(string? reportPath, bool drawerWrites, bool detectAgents, bool stagedActions, string? screenshots)
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
                    var agents = detectAgents ? await DetectAgents(window, screenshots, theme.ToString().ToLowerInvariant()) : null;
                    var staged = stagedActions ? await StagedActions(window, screenshots, theme.ToString().ToLowerInvariant()) : null;
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
                        agents,
                        staged,
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

    /// <summary>
    /// AC-11: Detect agents lists one result per client with the button disabled while it runs; a
    /// second window naming a missing mcp.json shows the command's failure by the row.
    /// </summary>
    private static async Task<object> DetectAgents(OperatorWindow window, string? screenshots, string theme)
    {
        await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
        var running = window.ClickDetectAgentsAsync();
        var disabledWhileRunning = !window.DetectAgentsEnabled;
        await Within(running, "Detect agents did not finish.");
        var results = window.AgentResultRows.Select(row => new { client = row.Client, status = row.Status, message = row.Message }).ToList();
        var error = window.AgentsErrorMessage;
        var enabledAfter = window.DetectAgentsEnabled;
        var rows = window.SettingsRowNames;
        if (screenshots is not null) Capture(window, Path.Combine(screenshots, theme + "-agents.png"));
        window.CloseSettingsBy(SettingsCloseRoute.CloseButton);

        var host = OperatorLauncher.InstalledHost();
        var missing = Path.Combine(Path.GetTempPath(), "drive-it-self-test-" + Guid.NewGuid().ToString("N"), "mcp.json");
        var broken = new OperatorWindow(new OperatorClient(new ProcessOperatorRunner(host)), missing, window.Mode, promptForMissingRoot: false)
        {
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            ShowActivated = false,
        };
        broken.Show();
        object failure;
        try
        {
            await Within(broken.Ready, "The second operator window did not finish loading.");
            await Within(broken.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
            await Within(broken.ClickDetectAgentsAsync(), "Detect agents did not finish.");
            broken.UpdateLayout();
            failure = new { error = broken.AgentsErrorMessage, results = broken.AgentResultRows.Count, enabledAfter = broken.DetectAgentsEnabled };
        }
        finally
        {
            broken.Close();
        }

        return new { rows, disabledWhileRunning, results, error, enabledAfter, failure };
    }

    /// <summary>
    /// Spec #13 AC-18 (the window's half) and the drawer row: Require dry run off shows no switcher; the switch saves on;
    /// Staged Actions mode says there is no dry run, then shows one as readable lines with no JSON, keeps it across
    /// Home and back, adds Applied once the same call ran for real, is replaced by a newer failed dry run showing its
    /// error, and waits for a dry run the add-in names; a failed save puts the switch back; off hides the switcher and
    /// returns to Home. The receipts it writes are this self-test's own, in a throwaway data directory.
    /// </summary>
    private static async Task<object> StagedActions(OperatorWindow window, string? screenshots, string theme)
    {
        var host = OperatorLauncher.InstalledHost();
        var data = OperatorLocator.DataDirectory(host);
        var runs = Path.Combine(data, "runs");
        var settingsFile = Path.Combine(data, ScriptTimeLimit.FileName);
        var client = new OperatorClient(new ProcessOperatorRunner(host));
        var root = await client.GetWorkspaceAsync()
            ?? await client.SetWorkspaceAsync(Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "drive-it-self-test-root")).FullName);
        Directory.CreateDirectory(runs);
        foreach (var old in Directory.GetFiles(runs, "self-test-*.json")) File.Delete(old);
        var clock = DateTimeOffset.UtcNow;
        string Receipt(string runId, bool dryRun, string status, object? error = null, object? actions = null)
        {
            clock = clock.AddSeconds(1);
            const string call = """{"codeHash":"self-test","script":null,"arguments":{},"processId":1,"document":null}""";
            var receipt = new Dictionary<string, object?>
            {
                ["runId"] = runId,
                ["displayName"] = dryRun ? "Renumber the level 2 doors" : "Renumber the level 2 doors for real",
                ["idempotencyKey"] = runId,
                ["fingerprint"] = dryRun ? call[..^1] + ""","dryRun":{"views":[],"createdViews":false,"pixelSize":1024}}""" : call,
                ["dryRun"] = dryRun,
                ["status"] = status,
                ["session"] = new { processId = 1 },
                ["document"] = new { title = "Tower", path = @"C:\models\Tower.rvt" },
                ["workspaceRoot"] = root,
                ["error"] = error,
                ["startedAt"] = clock.ToString("O"),
                ["completedAt"] = clock.AddMilliseconds(500).ToString("O"),
            };
            if (dryRun) receipt["rolledBack"] = true;
            if (actions is not null) receipt["actions"] = actions;
            if (dryRun && status == "succeeded") receipt["worksharing"] = new[] { new { document = "Tower", released = true } };
            File.WriteAllText(Path.Combine(runs, runId + ".json"), JsonSerializer.Serialize(receipt));
            return runId;
        }
        var actions = new[]
        {
            new Dictionary<string, object>
            {
                ["document"] = "Tower",
                ["created"] = new { total = 3, truncated = false, groups = new[] { new { category = "Walls", family = "Basic Wall", type = "Generic - 200mm", count = 3, elements = new[] { new { id = 312045 }, new { id = 312046 }, new { id = 312047 } } } } },
                ["modified"] = new { total = 2, truncated = false, elements = new object[] {
                    new { id = 1234, category = "Doors", family = "Single-Flush", type = "0915 x 2134mm", values = new[] { new { name = "Mark", before = "D12", after = "D14" } } },
                    new { id = 1235, category = "Doors", family = "Single-Flush", type = "0915 x 2134mm", values = Array.Empty<object>(), moved = true } } },
                ["deleted"] = new { total = 1, truncated = false, groups = new[] { new { category = "Windows", family = "Fixed", type = "0915 x 1220mm", count = 1, elements = new[] { new { id = 777 } } } } },
                ["alsoTouched"] = new { total = 1, categories = new[] { new { category = "Walls", count = 1 } } },
            },
        };

        if (window.RequireDryRunOn)
        {
            await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
            await Within(window.ClickRequireDryRunAsync(), "The Require dry run switch did not finish saving.");
            window.CloseSettingsBy(SettingsCloseRoute.CloseButton);
        }
        var off = new { switcherShown = window.ModeSwitcherShown, mode = window.CurrentMode.ToString() };

        await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
        var rows = window.SettingsRowNames;
        var switchBefore = window.RequireDryRunSwitchOn;
        await Within(window.ClickRequireDryRunAsync(), "The Require dry run switch did not finish saving.");
        var turnedOn = new { switchBefore, rows, switchOn = window.RequireDryRunSwitchOn, error = window.RequireDryRunError, stored = RequireDryRun.Read(data) };
        if (screenshots is not null) Capture(window, Path.Combine(screenshots, theme + "-settings-require.png"));
        window.CloseSettingsBy(SettingsCloseRoute.CloseButton);
        var on = new { switcherShown = window.ModeSwitcherShown, mode = window.CurrentMode.ToString() };

        await Within(window.ClickModeAsync(WindowMode.StagedActions), "Staged Actions mode did not finish reading.");
        var none = new { mode = window.CurrentMode.ToString(), noneShown = window.StagedNoneShown, error = window.StagedErrorMessage };

        var dry = Receipt("self-test-dry-" + theme, dryRun: true, "succeeded", actions: actions);
        await Within(window.ClickModeAsync(WindowMode.StagedActions), "Staged Actions mode did not finish reading.");
        var shown = window.StagedTextShown;
        var first = new
        {
            runId = window.StagedRun?.RunId,
            applied = window.AppliedShown,
            text = shown,
            noJson = !shown.Any(line => line.Contains('{') || line.Contains('"')),
            error = window.StagedErrorMessage,
        };
        if (screenshots is not null) Capture(window, Path.Combine(screenshots, theme + "-staged.png"));
        await Within(window.ClickModeAsync(WindowMode.Home), "Home did not show.");
        var home = window.CurrentMode.ToString();
        await Within(window.ClickModeAsync(WindowMode.StagedActions), "Staged Actions mode did not finish reading.");
        var back = window.StagedRun?.RunId;

        Receipt("self-test-real-" + theme, dryRun: false, "succeeded");
        await Within(window.ClickModeAsync(WindowMode.StagedActions), "Staged Actions mode did not finish reading.");
        var applied = new { runId = window.StagedRun?.RunId, applied = window.AppliedShown };

        var failedId = Receipt("self-test-failed-" + theme, dryRun: true, "failed",
            error: new { code = "SCRIPT_FAILED", message = "The door schedule has no level 2 doors." });
        await Within(window.ClickModeAsync(WindowMode.StagedActions), "Staged Actions mode did not finish reading.");
        var failed = new { runId = window.StagedRun?.RunId, failed = window.StagedRun?.Failed, text = window.StagedTextShown, applied = window.AppliedShown };
        if (screenshots is not null) Capture(window, Path.Combine(screenshots, theme + "-staged-failed.png"));

        // The add-in opens the window as the hold ends, before the server has written the receipt: it waits for it.
        var laterId = "self-test-later-" + theme;
        var writeLater = Task.Run(async () =>
        {
            await Task.Delay(1500);
            Receipt(laterId, dryRun: true, "succeeded", actions: actions);
        });
        await Within(window.ShowStagedAsync(laterId), "Staged Actions mode did not wait for the named dry run.");
        await writeLater;
        var waited = window.StagedRun?.RunId;

        // A save that fails puts the switch back to the stored value and shows the error by the row.
        object failedSave;
        var aside = settingsFile + ".self-test";
        File.Move(settingsFile, aside, overwrite: true);
        Directory.CreateDirectory(settingsFile);
        try
        {
            await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
            await Within(window.ClickRequireDryRunAsync(), "The Require dry run switch did not finish saving.");
            failedSave = new { error = window.RequireDryRunError, switchOn = window.RequireDryRunSwitchOn, switcherShown = window.ModeSwitcherShown };
        }
        finally
        {
            Directory.Delete(settingsFile);
            File.Move(aside, settingsFile);
        }
        window.CloseSettingsBy(SettingsCloseRoute.CloseButton);

        await Within(window.ClickSettingsAsync(), "The settings drawer did not finish reading the settings.");
        await Within(window.ClickRequireDryRunAsync(), "The Require dry run switch did not finish saving.");
        var turnedOff = new { switchOn = window.RequireDryRunSwitchOn, error = window.RequireDryRunError, stored = RequireDryRun.Read(data) };
        window.CloseSettingsBy(SettingsCloseRoute.CloseButton);
        var offAgain = new { switcherShown = window.ModeSwitcherShown, mode = window.CurrentMode.ToString() };

        return new { off, turnedOn, on, none, dry, first, home, back, applied, failedId, failed, laterId, waited, failedSave, turnedOff, offAgain };
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
