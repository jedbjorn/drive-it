using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using DriveIt.Core.Operator;
using DriveIt.UI.Theming;
using Microsoft.Win32;

namespace DriveIt.UI;

/// <summary>
/// The operator window, with the PowerShell window's behavior: on open it shows the selected
/// root and refreshes both lists (selecting the first row of each), then offers the folder
/// picker when no root is selected yet. Save root, Approve and Deny call operator.js; a
/// decision refreshes the lists. Failures show in the banner instead of a message box.
/// </summary>
public partial class OperatorWindow : Window
{
    private readonly OperatorClient _client;
    private readonly bool _promptForMissingRoot;
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _busy;

    public OperatorWindow(OperatorClient client, string mcpConfigurationPath, ImageSource? icon = null, bool promptForMissingRoot = true)
    {
        InitializeComponent();
        DarkTitleBar.Attach(this);
        _client = client;
        _promptForMissingRoot = promptForMissingRoot;
        McpText.Text = "MCP configuration: " + mcpConfigurationPath;
        McpText.ToolTip = mcpConfigurationPath;
        if (icon is not null) Icon = icon;
        Loaded += OnLoaded;
        UpdateButtons();
    }

    /// <summary>Completes once the first load (root and both lists) has finished, whether or not it failed.</summary>
    public Task Ready => _ready.Task;

    /// <summary>The root operator.js reported, or null when none is selected.</summary>
    public string? WorkspaceRoot { get; private set; }

    /// <summary>The message in the error banner; null when it is hidden.</summary>
    public string? ErrorMessage => ErrorPanel.Visibility == Visibility.Visible ? ErrorText.Text : null;

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
                await RefreshListsAsync();
            });
            if (found && WorkspaceRoot is null && _promptForMissingRoot) BrowseForRoot();
        }
        finally
        {
            _ready.TrySetResult();
        }
    }

    private void OnBrowse(object sender, RoutedEventArgs e) => BrowseForRoot();

    private void BrowseForRoot()
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
            if (dialog.ShowDialog(this) == true) RootText.Text = dialog.FolderName;
        }
        catch (Exception exception)
        {
            ShowError("Drive-It could not open the folder picker: " + exception.Message);
        }
    }

    private async void OnSaveRoot(object sender, RoutedEventArgs e) => await RunAsync(async () =>
    {
        WorkspaceRoot = await _client.SetWorkspaceAsync(RootText.Text);
        RootText.Text = WorkspaceRoot;
    });

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
    /// Runs one action with the buttons disabled, then shows its failure (or clears the banner).
    /// Inside Revit the window is modeless and its handlers can run without WPF's synchronization
    /// context, so one is installed first: the awaits must come back to this window's thread.
    /// </summary>
    private async Task RunAsync(Func<Task> action)
    {
        if (SynchronizationContext.Current is not DispatcherSynchronizationContext)
            SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher));
        if (_busy) return;
        _busy = true;
        UpdateButtons();
        try
        {
            await action();
            ShowError(null);
        }
        catch (OperatorException exception)
        {
            ShowError(exception.Message);
        }
        catch (Exception exception)
        {
            // Never let a failure escape an async void handler: inside Revit it would reach Revit's dispatcher.
            ShowError("Drive-It could not run the operator command: " + exception.Message);
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
    }
}
