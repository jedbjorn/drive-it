using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.UI;

namespace DriveIt.Revit;

public sealed class App : IExternalApplication
{
    private CancellationTokenSource? stopping;
    private Task? listener;

    public Result OnStartup(UIControlledApplication application)
    {
        var session = new
        {
            processId = Environment.ProcessId,
            version = application.ControlledApplication.VersionNumber,
            build = application.ControlledApplication.VersionBuild
        };
        var message = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(session) + "\n");
        var pipe = new NamedPipeServerStream($"drive-it-{session.processId}", PipeDirection.InOut,
            1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

        stopping = new CancellationTokenSource();
        listener = ServeAsync(pipe, message, stopping.Token);
        return Result.Succeeded;
    }

    private static async Task ServeAsync(NamedPipeServerStream pipe, byte[] message, CancellationToken token)
    {
        using (pipe)
        {
            while (true)
            {
                await pipe.WaitForConnectionAsync(token).ConfigureAwait(false);
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                    timeout.CancelAfter(TimeSpan.FromSeconds(3));
                    await pipe.WriteAsync(message, timeout.Token).ConfigureAwait(false);
                    // Keep the pipe open until the reader consumes the message and closes.
                    await pipe.ReadAsync(new byte[1], timeout.Token).ConfigureAwait(false);
                }
                catch (IOException)
                {
                    // A client can disconnect at any point.
                }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                {
                    // Make the listener available again after a stalled client.
                }
                finally
                {
                    pipe.Disconnect();
                }
            }
        }
    }

    public Result OnShutdown(UIControlledApplication application)
    {
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
