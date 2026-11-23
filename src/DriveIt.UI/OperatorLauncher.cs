using System.IO;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using DriveIt.Core.Operator;
using DriveIt.Core.Theming;
using DriveIt.UI.Theming;

namespace DriveIt.UI;

/// <summary>
/// Opens the operator window for both hosts: the Revit add-in's Drive-It button (modeless,
/// owned by Revit's main window) and DriveIt.Operator.exe from the Start Menu. One window per
/// process: opening it again brings the open one forward.
/// </summary>
public static class OperatorLauncher
{
    private static OperatorWindow? _open;

    /// <summary>
    /// Shows the window without blocking and returns it; call on the UI thread.
    /// </summary>
    /// <param name="owner">Revit's main window handle (<c>UIApplication.MainWindowHandle</c>), or zero for none.</param>
    /// <param name="theme">The theme to open in; null keeps <see cref="DriveItTheme.Current"/>.</param>
    public static OperatorWindow Show(IntPtr owner = default, UiTheme? theme = null)
    {
        if (_open is { } existing)
        {
            if (existing.WindowState == WindowState.Minimized) existing.WindowState = WindowState.Normal;
            existing.Activate();
            return existing;
        }

        if (theme is { } t) DriveItTheme.Apply(t);
        var window = Create();
        if (owner != IntPtr.Zero)
        {
            _ = new WindowInteropHelper(window) { Owner = owner };
            window.ShowInTaskbar = false;
        }
        else
        {
            window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }
        window.Closed += (_, _) =>
        {
            if (ReferenceEquals(_open, window)) _open = null;
        };
        _open = window;
        window.Show();
        return window;
    }

    /// <summary>
    /// A new window wired to the installed operator.js (found from this assembly's folder,
    /// <c>app\addin</c> or <c>app\operator</c>), in <see cref="DriveItTheme.Current"/>.
    /// </summary>
    /// <param name="promptForMissingRoot">False keeps the folder picker closed when no root is selected (self-test).</param>
    public static OperatorWindow Create(bool promptForMissingRoot = true)
    {
        var host = OperatorHost.ForAssemblyDirectory(AssemblyDirectory());
        var client = new OperatorClient(new ProcessOperatorRunner(host));
        return new OperatorWindow(client, OperatorLocator.McpConfigurationPath(host), LoadIcon(host), promptForMissingRoot);
    }

    private static string? AssemblyDirectory() => Path.GetDirectoryName(typeof(OperatorLauncher).Assembly.Location);

    /// <summary>
    /// The window icon, <c>Resources\icons\drive_32.png</c> next to this assembly (the add-in folder)
    /// or in <c>app\addin</c> (for the exe); null while the icon files are not shipped.
    /// </summary>
    private static ImageSource? LoadIcon(OperatorHost host)
    {
        var candidates = new List<string>();
        if (AssemblyDirectory() is { } here) candidates.Add(Path.Combine(here, "Resources", "icons", "drive_32.png"));
        if (host.AppDirectory is { } app) candidates.Add(Path.Combine(app, "addin", "Resources", "icons", "drive_32.png"));
        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            try
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.UriSource = new Uri(path);
                image.CacheOption = BitmapCacheOption.OnLoad; // don't keep the file locked
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch (Exception exception) when (exception is IOException or NotSupportedException or UriFormatException)
            {
                // An unreadable icon leaves the default one.
            }
        }
        return null;
    }
}
