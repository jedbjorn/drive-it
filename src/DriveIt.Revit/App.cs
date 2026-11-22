using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.UI;
using DriveIt.Revit.Broker;

namespace DriveIt.Revit;

public sealed class App : IExternalApplication
{
    private const int MaximumRequestBytes = 1024 * 1024;
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
        var broker = new RevitBroker(application);

        stopping = new CancellationTokenSource();
        listener = ServeAsync(pipe, message, broker, stopping.Token);
        return Result.Succeeded;
    }

    private static async Task ServeAsync(NamedPipeServerStream pipe, byte[] session, RevitBroker broker,
        CancellationToken token)
    {
        using (pipe)
        {
            while (true)
            {
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
                    if (pipe.IsConnected)
                        pipe.Disconnect();
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
