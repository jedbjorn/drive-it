using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Windows.Media.Imaging;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using DriveIt.Core.Theming;
using DriveIt.Revit.Broker;
using DriveIt.Revit.Commands;
using DriveIt.Revit.Theming;
using DriveIt.UI.Theming;

namespace DriveIt.Revit;

/// <summary>
/// Revit entry point: starts the current-user named-pipe broker, then adds the "Drive-It" panel
/// to the built-in Add-Ins tab with one button that opens the operator window. The ribbon is
/// adapted from splash-it src/SplashIt.Revit/App.cs (splash-it commit ad7796d): its icons follow
/// Revit's theme, and a ribbon failure never stops the broker or Revit's startup.
/// </summary>
public sealed class App : IExternalApplication
{
    public const string PanelName = "Drive-It";

    /// <summary>The button's permanent name; RST keys on it.</summary>
    public const string OpenOperatorButtonName = "DriveIt.OpenOperator";

    public const string OpenOperatorToolTip = "Choose the workspace, approve requests, and review what the agent ran.";

    private const int MaximumRequestBytes = 1024 * 1024;
    private CancellationTokenSource? stopping;
    private Task? listener;
    private PushButton? operatorButton;

    public Result OnStartup(UIControlledApplication application)
    {
        var session = new
        {
            processId = Environment.ProcessId,
            version = application.ControlledApplication.VersionNumber,
            build = application.ControlledApplication.VersionBuild
        };
        var message = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(session) + "\n");
        var broker = new RevitBroker(application);

        stopping = new CancellationTokenSource();
        listener = ServeAsync($"drive-it-{session.processId}", message, broker, stopping.Token);

        AddRibbon(application);
        return Result.Succeeded;
    }

    private void AddRibbon(UIControlledApplication application)
    {
        try
        {
            // CreateRibbonPanel without a tab name targets the built-in Add-Ins tab.
            var panel = application.CreateRibbonPanel(PanelName);
            var data = new PushButtonData(
                OpenOperatorButtonName,
                "Drive-It",
                Assembly.GetExecutingAssembly().Location,
                typeof(OpenOperator).FullName)
            {
                ToolTip = OpenOperatorToolTip,
                AvailabilityClassName = typeof(AlwaysAvailable).FullName,
            };
            operatorButton = panel.AddItem(data) as PushButton;
            OnTheme(RevitThemeDetector.Detect());
            application.ThemeChanged += OnThemeChanged;
        }
        catch (Exception exception)
        {
            Trace.WriteLine($"Drive-It: adding the ribbon panel failed ({exception.GetType().Name}: {exception.Message}).");
        }
    }

    private void OnThemeChanged(object? sender, ThemeChangedEventArgs e)
    {
        try
        {
            if (e.ThemeChangedType == ThemeType.UITheme) OnTheme(RevitThemeDetector.Detect());
        }
        catch (Exception exception)
        {
            Trace.WriteLine($"Drive-It: swapping the ribbon icons failed ({exception.GetType().Name}).");
        }
    }

    /// <summary>The ribbon icons follow the theme, and the next operator window opens in it.</summary>
    private void OnTheme(UiTheme theme)
    {
        DriveItTheme.Apply(theme);
        if (operatorButton is null) return;
        var suffix = theme == UiTheme.Dark ? "_dark" : "";
        // A missing dark icon falls back to the light one; with neither, the button has no icon.
        operatorButton.LargeImage = LoadIcon($"drive_32{suffix}.png") ?? LoadIcon("drive_32.png");
        operatorButton.Image = LoadIcon($"drive_16{suffix}.png") ?? LoadIcon("drive_16.png");
    }

    /// <summary>Loads an icon shipped next to the DLL (<c>Resources\icons</c>); null when the file is missing.</summary>
    private static BitmapImage? LoadIcon(string fileName)
    {
        var directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? "";
        var path = Path.Combine(directory, "Resources", "icons", fileName);
        if (!File.Exists(path)) return null;

        var image = new BitmapImage();
        image.BeginInit();
        image.UriSource = new Uri(path);
        image.CacheOption = BitmapCacheOption.OnLoad; // don't keep the file locked
        image.EndInit();
        image.Freeze();
        return image;
    }

    private static async Task ServeAsync(string pipeName, byte[] session, RevitBroker broker,
        CancellationToken token)
    {
        while (true)
        {
            using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut,
                1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.WaitForConnectionAsync(token).ConfigureAwait(false);
            try
            {
                using var handshakeTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                handshakeTimeout.CancelAfter(TimeSpan.FromSeconds(5));
                await pipe.WriteAsync(session, handshakeTimeout.Token).ConfigureAwait(false);
                var request = await ReadRequestAsync(pipe, handshakeTimeout.Token).ConfigureAwait(false);
                if (request is null)
                    continue;

                var response = await broker.ExecuteAsync(request, token).ConfigureAwait(false);
                var bytes = Encoding.UTF8.GetBytes(response + "\n");
                await pipe.WriteAsync(bytes, token).ConfigureAwait(false);
            }
            catch (InvalidDataException exception)
            {
                var response = RevitBroker.InvalidRequest("", "invalid_request", exception.Message);
                var bytes = Encoding.UTF8.GetBytes(response + "\n");
                await pipe.WriteAsync(bytes, token).ConfigureAwait(false);
            }
            catch (IOException)
            {
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
            }
            finally
            {
                try
                {
                    if (pipe.IsConnected)
                        pipe.Disconnect();
                }
                catch (IOException)
                {
                }
                catch (InvalidOperationException)
                {
                }
            }
        }
    }

    private static async Task<string?> ReadRequestAsync(NamedPipeServerStream pipe, CancellationToken token)
    {
        var buffer = new byte[8192];
        using var message = new MemoryStream();
        while (message.Length <= MaximumRequestBytes)
        {
            var count = await pipe.ReadAsync(buffer, token).ConfigureAwait(false);
            if (count == 0)
                return null;

            message.Write(buffer, 0, count);
            var bytes = message.GetBuffer();
            var length = checked((int)message.Length);
            for (var index = 0; index < length; index++)
            {
                if (bytes[index] != (byte)'\n')
                    continue;
                if (index > MaximumRequestBytes)
                    throw new InvalidDataException("The request exceeds the 1 MiB limit.");
                var requestLength = index > 0 && bytes[index - 1] == (byte)'\r' ? index - 1 : index;
                return Encoding.UTF8.GetString(bytes, 0, requestLength);
            }
        }

        throw new InvalidDataException("The request exceeds the 1 MiB limit.");
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        try
        {
            application.ThemeChanged -= OnThemeChanged;
        }
        catch (Exception)
        {
            // Revit is closing; nothing left to unsubscribe from.
        }
        stopping?.Cancel();
        try
        {
            listener?.GetAwaiter().GetResult();
        }
        catch (OperationCanceledException) when (stopping?.IsCancellationRequested == true)
        {
        }
        finally
        {
            stopping?.Dispose();
        }
        return Result.Succeeded;
    }
}
