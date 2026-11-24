using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using DriveIt.Core.Mode;
using DriveIt.Core.Operator;
using DriveIt.UI.Theming;
using Microsoft.Win32;

namespace DriveIt.UI;

/// <summary>
/// The operator window, with the PowerShell window's behavior: on open it shows the selected
/// root, reads the Script time limit and refreshes both lists (selecting the first row of each),
/// then offers the folder picker when no root is selected yet. Save root, Approve and Deny call
/// operator.js; a decision refreshes the lists. Failures show in the banner instead of a message
/// box. In Dev Mode the "Dev Mode: no guardrails" banner stays shown and the outside-root
/// requests pane is hidden (spec #10 "Visibility").
/// <para>
/// Settings (spec #23) opens a drawer over the window's right edge with the rest dimmed and
/// inert. It re-reads <c>operator.js settings get</c> on every open and shows its own errors
/// next to the row they belong to, since it covers the banner. Close, Esc and a click on the
/// dimmed area close it; closing discards a typed, unsaved value and puts focus back on the
/// Settings button.
/// </para>
/// </summary>
public partial class OperatorWindow : Window
{
    private readonly OperatorClient _client;
    private readonly bool _promptForMissingRoot;
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _busy;
    private Task _settingsAction = Task.CompletedTask;

    public OperatorWindow(OperatorClient client, string mcpConfigurationPath, DriveItMode mode, ImageSource? icon = null, bool promptForMissingRoot = true)
    {
        InitializeComponent();
        DarkTitleBar.Attach(this);
        _client = client;
        _promptForMissingRoot = promptForMissingRoot;
        Mode = mode;
        if (mode == DriveItMode.Dev)
        {
            DevModePanel.Visibility = Visibility.Visible;
            RequestsPanel.Visibility = Visibility.Collapsed;
            RequestsRow.Height = new GridLength(0);
            RequestsRow.MinHeight = 0;
        }
        McpText.Text = "MCP configuration: " + mcpConfigurationPath;
        McpText.ToolTip = mcpConfigurationPath;
        TimeLimitHelp.Text = ScriptTimeLimit.HelpText;
        if (icon is not null) Icon = icon;
        Loaded += OnLoaded;
        PreviewKeyDown += OnPreviewKeyDown;
        UpdateButtons();
    }

    /// <summary>Completes once the first load (root and both lists) has finished, whether or not it failed.</summary>
    public Task Ready => _ready.Task;

    /// <summary>The install mode the window was opened in.</summary>
    public DriveItMode Mode { get; }

    /// <summary>True while the "Dev Mode: no guardrails" banner is shown.</summary>
    public bool DevModeBannerShown => DevModePanel.Visibility == Visibility.Visible;

    /// <summary>True while the outside-root requests pane is shown.</summary>
    public bool RequestsShown => RequestsPanel.Visibility == Visibility.Visible;

    /// <summary>The root operator.js reported, or null when none is selected.</summary>
    public string? WorkspaceRoot { get; private set; }

    /// <summary>The message in the error banner; null when it is hidden.</summary>
    public string? ErrorMessage => ErrorPanel.Visibility == Visibility.Visible ? ErrorText.Text : null;

    /// <summary>The Script time limit operator.js last reported, in seconds; null until it has been read.</summary>
    public int? ScriptTimeLimitSeconds { get; private set; }

    /// <summary>True while the settings drawer is open.</summary>
    public bool SettingsOpen => Drawer.Visibility == Visibility.Visible;

    /// <summary>True while the Settings button can be used.</summary>
    public bool SettingsButtonEnabled => SettingsButton.IsEnabled;

    /// <summary>The Script time limit box in the drawer, as shown.</summary>
    public string SettingsTimeLimitText => TimeLimitText.Text;

    /// <summary>The drawer's error next to the Script time limit; null when none is shown.</summary>
    public string? SettingsTimeLimitError => TimeLimitError.Visibility == Visibility.Visible ? TimeLimitError.Text : null;

    /// <summary>True when the window's focus is inside the drawer.</summary>
    public bool FocusInSettings => FocusManager.GetFocusedElement(this) is DependencyObject focused
        && (ReferenceEquals(focused, Drawer) || Drawer.IsAncestorOf(focused));

    /// <summary>True when the window's focus is on the Settings button.</summary>
    public bool FocusOnSettingsButton => ReferenceEquals(FocusManager.GetFocusedElement(this), SettingsButton);

    /// <summary>The headings of the sections shown in the main window, top to bottom.</summary>
    public IReadOnlyList<string> MainWindowSections => SectionHeadings(MainContent);

    /// <summary>True while the MCP configuration path is shown under the lists.</summary>
    public bool McpPathShown => McpText.IsVisible && McpText.Text.Length > 0;

    /// <summary>The headings of the drawer's rows, top to bottom.</summary>
    public IReadOnlyList<string> SettingsRowNames => SectionHeadings(SettingsRows);

    public int PendingCount => RequestList.Items.Count;

    public int HistoryCount => HistoryList.Items.Count;

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        try
        {
            var found = false;
            await RunAsync(async () =>
            {
                WorkspaceRoot = await _client.GetWorkspaceAsync();
                RootText.Text = WorkspaceRoot ?? "";
                found = true;
                ShowTimeLimit(await _client.GetScriptTimeLimitAsync());
                await RefreshListsAsync();
            });
            if (found && WorkspaceRoot is null && _promptForMissingRoot && BrowseForRoot()) await SaveRootAsync();
        }
        finally
        {
            _ready.TrySetResult();
        }
    }

    // Picking a folder chooses it; Save root remains for a path typed into the box.
    private async void OnBrowse(object sender, RoutedEventArgs e)
    {
        if (BrowseForRoot()) await SaveRootAsync();
    }

    private bool BrowseForRoot()
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Select the Drive-It workspace root",
            Multiselect = false,
        };
        try
        {
            var current = RootText.Text.Trim();
            if (current.Length > 0 && Directory.Exists(current)) dialog.InitialDirectory = current;
            if (dialog.ShowDialog(this) != true) return false;
            RootText.Text = dialog.FolderName;
            return true;
        }
        catch (Exception exception)
        {
            ShowError("Drive-It could not open the folder picker: " + exception.Message);
            return false;
        }
    }

    private async void OnSaveRoot(object sender, RoutedEventArgs e) => await SaveRootAsync();

    private Task SaveRootAsync() => RunAsync(async () =>
    {
        WorkspaceRoot = await _client.SetWorkspaceAsync(RootText.Text);
        RootText.Text = WorkspaceRoot;
    });

    private void OnOpenSettings(object sender, RoutedEventArgs e) => _settingsAction = OpenSettingsAsync();

    /// <summary>
    /// Opens the drawer over the dimmed, inert window, moves focus into it and reads the stored
    /// settings: the other host's window or the command line may have changed them.
    /// </summary>
    private async Task OpenSettingsAsync()
    {
        if (_busy || SettingsOpen) return;
        ShowTimeLimitError(null);
        MainContent.IsEnabled = false;
        DrawerScrim.Visibility = Visibility.Visible;
        Drawer.Visibility = Visibility.Visible;
        MoveFocus(Drawer);
        await RunAsync(async () => ShowTimeLimit(await _client.GetScriptTimeLimitAsync()), ShowTimeLimitError);
        if (SettingsOpen) MoveFocus(TimeLimitText);
    }

    private void OnCloseSettings(object sender, RoutedEventArgs e) => CloseSettings();

    private void OnScrimClicked(object sender, MouseButtonEventArgs e)
    {
        e.Handled = true;
        CloseSettings();
    }

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Escape || !SettingsOpen) return;
        e.Handled = true;
        CloseSettings();
    }

    /// <summary>Closes the drawer, discarding a typed value that was not saved; not while a drawer command runs.</summary>
    private void CloseSettings()
    {
        if (_busy || !SettingsOpen) return;
        Drawer.Visibility = Visibility.Collapsed;
        DrawerScrim.Visibility = Visibility.Collapsed;
        MainContent.IsEnabled = true;
        ShowStoredTimeLimit();
        ShowTimeLimitError(null);
        MoveFocus(SettingsButton);
    }

    private void OnSaveTimeLimit(object sender, RoutedEventArgs e) => _settingsAction = SaveTimeLimitAsync();

    private Task SaveTimeLimitAsync() => RunAsync(async () =>
    {
        var seconds = ScriptTimeLimit.Parse(TimeLimitText.Text, out var error)
            ?? throw new OperatorException(error!);
        ShowTimeLimit(await _client.SetScriptTimeLimitAsync(seconds));
    }, ShowTimeLimitError);

    private void ShowTimeLimit(int seconds)
    {
        ScriptTimeLimitSeconds = seconds;
        ShowStoredTimeLimit();
    }

    private void ShowStoredTimeLimit() =>
        TimeLimitText.Text = ScriptTimeLimitSeconds?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "";

    /// <summary>A failed read or save shows next to the row and leaves the stored value in the box.</summary>
    private void ShowTimeLimitError(string? message)
    {
        TimeLimitError.Text = message ?? "";
        TimeLimitError.Visibility = string.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
        if (!string.IsNullOrEmpty(message)) ShowStoredTimeLimit();
    }

    /// <summary>Logical focus always; keyboard focus too when the window is active.</summary>
    private void MoveFocus(IInputElement element)
    {
        FocusManager.SetFocusedElement(this, element);
        Keyboard.Focus(element);
    }

    private static List<string> SectionHeadings(DependencyObject root)
    {
        var headings = new List<string>();
        Collect(root);
        return headings;

        void Collect(DependencyObject node)
        {
            if (node is TextBlock { IsVisible: true } text
                && ReferenceEquals(text.Style, text.TryFindResource("SectionText")))
                headings.Add(text.Text);
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(node); i++)
                Collect(VisualTreeHelper.GetChild(node, i));
        }
    }

    private async void OnApprove(object sender, RoutedEventArgs e) => await DecideAsync(approve: true);

    private async void OnDeny(object sender, RoutedEventArgs e) => await DecideAsync(approve: false);

    private async void OnRefresh(object sender, RoutedEventArgs e) => await RunAsync(RefreshListsAsync);

    private async Task DecideAsync(bool approve)
    {
        if (RequestList.SelectedItem is not PendingRequest request) return;
        await RunAsync(async () =>
        {
            await _client.DecideAsync(request.Id, approve);
            await RefreshListsAsync();
        });
    }

    private async Task RefreshListsAsync()
    {
        var pending = await _client.ListPendingAsync();
        var history = await _client.ListHistoryAsync();

        RequestList.ItemsSource = pending;
        if (pending.Count > 0) RequestList.SelectedIndex = 0;
        else RequestDetails.Clear();
        NoRequestsText.Visibility = pending.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        HistoryList.ItemsSource = history;
        if (history.Count > 0) HistoryList.SelectedIndex = 0;
        else HistoryDetails.Clear();
        NoHistoryText.Visibility = history.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnRequestSelected(object sender, SelectionChangedEventArgs e)
    {
        RequestDetails.Text = RequestList.SelectedItem is PendingRequest request ? request.Details : "";
        RequestDetails.ScrollToHome();
        UpdateButtons();
    }

    private void OnHistorySelected(object sender, SelectionChangedEventArgs e)
    {
        HistoryDetails.Text = HistoryList.SelectedItem is RunRecord run ? run.Details : "";
        HistoryDetails.ScrollToHome();
    }

    /// <summary>
    /// Runs one action with the buttons disabled, then shows its failure (or clears it) through
    /// <paramref name="showError"/>: the banner, or a drawer row's error line.
    /// Inside Revit the window is modeless and its handlers can run without WPF's synchronization
    /// context, so one is installed first: the awaits must come back to this window's thread.
    /// </summary>
    private async Task RunAsync(Func<Task> action, Action<string?>? showError = null)
    {
        showError ??= ShowError;
        if (SynchronizationContext.Current is not DispatcherSynchronizationContext)
            SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher));
        if (_busy) return;
        _busy = true;
        UpdateButtons();
        try
        {
            await action();
            showError(null);
        }
        catch (OperatorException exception)
        {
            showError(exception.Message);
        }
        catch (Exception exception)
        {
            // Never let a failure escape an async void handler: inside Revit it would reach Revit's dispatcher.
            showError("Drive-It could not run the operator command: " + exception.Message);
        }
        finally
        {
            _busy = false;
            UpdateButtons();
        }
    }

    private void ShowError(string? message)
    {
        ErrorText.Text = message ?? "";
        ErrorPanel.Visibility = string.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
    }

    private void UpdateButtons()
    {
        var selected = RequestList.SelectedItem is PendingRequest;
        ApproveButton.IsEnabled = !_busy && selected;
        DenyButton.IsEnabled = !_busy && selected;
        SaveRootButton.IsEnabled = !_busy;
        BrowseButton.IsEnabled = !_busy;
        RefreshButton.IsEnabled = !_busy;
        SettingsButton.IsEnabled = !_busy;
        TimeLimitText.IsEnabled = !_busy;
        SaveTimeLimitButton.IsEnabled = !_busy;
        CloseSettingsButton.IsEnabled = !_busy;
    }

    // The self-test's route in (DriveIt.Operator --self-test): each raises the control's own event,
    // so the drawer is driven through the handlers a click or key press runs.

    /// <summary>Clicks Settings and completes once the drawer has read the stored settings.</summary>
    public Task ClickSettingsAsync()
    {
        _settingsAction = Task.CompletedTask;
        SettingsButton.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, SettingsButton));
        return _settingsAction;
    }

    /// <summary>Types <paramref name="text"/> into the drawer's time limit box without saving it.</summary>
    public void TypeTimeLimit(string text) => TimeLimitText.Text = text;

    /// <summary>Types <paramref name="text"/> into the time limit box, clicks Save limit and completes once the save has finished.</summary>
    public Task SaveTimeLimitAsync(string text)
    {
        TypeTimeLimit(text);
        _settingsAction = Task.CompletedTask;
        SaveTimeLimitButton.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, SaveTimeLimitButton));
        return _settingsAction;
    }

    /// <summary>Closes the drawer the way a person would: its Close button, Esc, or a click on the dimmed area.</summary>
    public void CloseSettingsBy(SettingsCloseRoute route)
    {
        switch (route)
        {
            case SettingsCloseRoute.CloseButton:
                CloseSettingsButton.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, CloseSettingsButton));
                break;
            case SettingsCloseRoute.Escape:
                var source = PresentationSource.FromVisual(this) ?? throw new InvalidOperationException("The window is not shown.");
                var target = FocusManager.GetFocusedElement(this) as UIElement ?? this;
                target.RaiseEvent(new KeyEventArgs(Keyboard.PrimaryDevice, source, 0, Key.Escape) { RoutedEvent = Keyboard.PreviewKeyDownEvent });
                break;
            case SettingsCloseRoute.OutsideClick:
                DrawerScrim.RaiseEvent(new MouseButtonEventArgs(Mouse.PrimaryDevice, 0, MouseButton.Left) { RoutedEvent = MouseLeftButtonDownEvent });
                break;
        }
    }
}

/// <summary>How the settings drawer was closed.</summary>
public enum SettingsCloseRoute
{
    CloseButton,
    Escape,
    OutsideClick,
}
