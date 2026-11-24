using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Autodesk.Revit.UI;
using DriveIt.Revit.Bridge;

namespace DriveIt.Revit.Broker;

public sealed class RevitBroker
{
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private const int RecentHolds = 32;

    private readonly RevitRequestHandler handler;
    private readonly ExternalEvent externalEvent;
    private readonly HoldHandler holdHandler;
    private readonly ExternalEvent holdEvent;
    private readonly LinkedList<HeldRun> recent = new();

    public RevitBroker(UIControlledApplication application)
    {
        var dispatcher = new DocumentDispatcher();
        handler = new RevitRequestHandler(dispatcher);
        externalEvent = ExternalEvent.Create(handler);
        holdHandler = new HoldHandler(dispatcher);
        holdEvent = ExternalEvent.Create(holdHandler);
    }

    /// <summary>
    /// Serves one pipe connection from its first request line. A hold.begin keeps the connection for the
    /// run; every other request is answered once.
    /// </summary>
    internal async Task ServeConnectionAsync(string json, PipeLineReader reader, Stream pipe, CancellationToken cancellationToken)
    {
        if (RequestType(json) == "hold.begin")
        {
            await ServeHoldAsync(json, reader, pipe, cancellationToken).ConfigureAwait(false);
            return;
        }
        await WriteLineAsync(pipe, await ExecuteAsync(json, cancellationToken).ConfigureAwait(false), cancellationToken).ConfigureAwait(false);
    }

    public async Task<string> ExecuteAsync(string json, CancellationToken cancellationToken)
    {
        if (RequestType(json) == "api.describe")
            return Describe(json);
        BrokerRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<BrokerRequest>(json, JsonOptions);
        }
        catch (JsonException exception)
        {
            return InvalidRequest("", "invalid_request", exception.Message);
        }
        if (request?.Type == "hold.result")
            return HoldResult(request.Id);
        var invalid = Validate(request);
        if (invalid is not null)
            return invalid;

        handler.Prepare(request!);
        externalEvent.Raise();
        var response = await handler.Completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
        return JsonSerializer.Serialize(response, JsonOptions);
    }

    /// <summary>The checks every model.execute and view.capture request passes, held or not; null when valid.</summary>
    internal static string? Validate(BrokerRequest? request)
    {
        if (request is null)
            return InvalidRequest("", "invalid_request", "A JSON request object is required.");
        if (string.IsNullOrWhiteSpace(request.Id) || request.Id.Length > 128)
            return InvalidRequest(request.Id, "invalid_request", "A request id of 1 to 128 characters is required.");
        if (request.Hold is not null)
            return InvalidRequest(request.Id, "invalid_request", "Only a hold.begin request carries a hold object.");
        if (request.Type == DocumentDispatcher.CaptureRequestType)
        {
            if (request.Capture is null || request.Operations is { Count: > 0 })
                return InvalidRequest(request.Id, "invalid_request", "A view.capture request carries a capture object and no operations.", request.Type);
        }
        else if (request.Type != "model.execute")
            return InvalidRequest(request.Id, "unsupported_request", "The request type must be 'model.execute' or 'view.capture'.");
        else if (request.Capture is not null)
            return InvalidRequest(request.Id, "invalid_request", "A model.execute request cannot carry a capture object.");
        else if (request.Operations is null || request.Operations.Count == 0)
            return InvalidRequest(request.Id, "empty_batch", "At least one typed operation is required.");
        return null;
    }

    /// <summary>
    /// A run's hold: Revit's thread enters it through its own ExternalEvent and serves the connection's requests
    /// until hold.end, the connection drops, the deadline passes, or Stop. A hold that ends on its own closes
    /// the connection, so the pipe is free again; the client reads the outcome with hold.result.
    /// </summary>
    private async Task ServeHoldAsync(string json, PipeLineReader reader, Stream pipe, CancellationToken cancellationToken)
    {
        BrokerRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<BrokerRequest>(json, JsonOptions);
        }
        catch (JsonException exception)
        {
            await WriteLineAsync(pipe, InvalidRequest("", "invalid_request", exception.Message, "hold.begin"), cancellationToken).ConfigureAwait(false);
            return;
        }
        if (request is null || string.IsNullOrWhiteSpace(request.Id) || request.Id.Length > 128 || request.Hold is null
            || request.Operations is { Count: > 0 } || request.Capture is not null)
        {
            await WriteLineAsync(pipe, InvalidRequest(request?.Id ?? "", "invalid_request",
                "A hold.begin request carries a run id of 1 to 128 characters and a hold object.", "hold.begin"), cancellationToken).ConfigureAwait(false);
            return;
        }

        var run = new HeldRun(request.Id, request.Hold.DisplayName, request.Hold.TimeLimitMs, request.Hold.DryRun, request.Hold.RequireDryRun);
        Remember(run);
        holdHandler.Prepare(run);
        var raised = holdEvent.Raise();
        if (raised != ExternalEventRequest.Accepted)
        {
            run.Disconnect();
            await WriteLineAsync(pipe, InvalidRequest(request.Id, "hold_refused", $"Revit did not accept the hold ({raised}).", "hold.begin"), cancellationToken).ConfigureAwait(false);
            return;
        }

        // The client sends nothing until it is held, so a read that completes first is the client leaving.
        var read = reader.ReadLineAsync(cancellationToken);
        if (await Task.WhenAny((Task)run.Begun, read).ConfigureAwait(false) != run.Begun)
        {
            run.Disconnect();
            return;
        }
        await WriteLineAsync(pipe, await run.Begun.ConfigureAwait(false), cancellationToken).ConfigureAwait(false);
        if (run.Ended.IsCompleted)
            return;

        try
        {
            while (true)
            {
                if (await Task.WhenAny(read, run.Ended).ConfigureAwait(false) != read)
                    return;
                var line = await read.ConfigureAwait(false);
                if (line is null)
                {
                    run.Disconnect();
                    return;
                }
                var reply = await run.Post(line).ConfigureAwait(false);
                await WriteLineAsync(pipe, reply, cancellationToken).ConfigureAwait(false);
                if (run.Ended.IsCompleted)
                    return;
                read = reader.ReadLineAsync(cancellationToken);
            }
        }
        catch (Exception exception) when (exception is IOException or InvalidDataException or OperationCanceledException)
        {
            run.Disconnect();
            throw;
        }
    }

    private void Remember(HeldRun run)
    {
        lock (recent)
        {
            recent.AddFirst(run);
            while (recent.Count > RecentHolds)
                recent.RemoveLast();
        }
    }

    /// <summary>The outcome of a recent hold, read without Revit's thread.</summary>
    private string HoldResult(string runId)
    {
        HeldRun? run;
        lock (recent)
            run = recent.FirstOrDefault(candidate => candidate.RunId == runId);
        var summary = run?.Summary;
        return new JsonObject
        {
            ["id"] = runId,
            ["type"] = "hold.result",
            ["status"] = summary is null ? (run is null ? "unknown" : "held") : "ended",
            ["hold"] = summary is null ? null : JsonSerializer.SerializeToNode(summary, JsonOptions),
        }.ToJsonString(JsonOptions);
    }

    /// <summary>revit.describe outside a hold: reflection over the loaded RevitAPI, without Revit's thread.</summary>
    private static string Describe(string json)
    {
        var request = JsonNode.Parse(json)!.AsObject();
        var id = request["id"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";
        try
        {
            var name = request["describe"]?["type"] is JsonValue type && type.TryGetValue<string>(out var typeName) ? typeName : null;
            return new JsonObject
            {
                ["id"] = id,
                ["type"] = "api.describe",
                ["status"] = "succeeded",
                ["value"] = ApiDescription.Describe(name),
            }.ToJsonString();
        }
        catch (BridgeException exception)
        {
            return InvalidRequest(id, exception.Code, exception.Message, "api.describe");
        }
    }

    private static string? RequestType(string json)
    {
        try
        {
            return JsonNode.Parse(json) is JsonObject request && request["type"] is JsonValue type && type.TryGetValue<string>(out var name)
                ? name
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal static Task WriteLineAsync(Stream pipe, string line, CancellationToken cancellationToken) =>
        pipe.WriteAsync(Encoding.UTF8.GetBytes(line + "\n"), cancellationToken).AsTask();

    public static string InvalidRequest(string id, string code, string message, string type = "model.execute")
    {
        return JsonSerializer.Serialize(new BrokerResponse
        {
            Id = id,
            Type = type,
            Status = "failed",
            Error = new ErrorReceipt { Code = code, Message = message },
        }, JsonOptions);
    }

    private sealed class HoldHandler(DocumentDispatcher dispatcher) : IExternalEventHandler
    {
        private HeldRun? run;

        public void Prepare(HeldRun next) => run = next;

        public void Execute(UIApplication application)
        {
            var next = run;
            run = null;
            next?.Serve(application, dispatcher);
        }

        public string GetName() => "Drive It hold";
    }

    private sealed class RevitRequestHandler(DocumentDispatcher dispatcher) : IExternalEventHandler
    {
        private BrokerRequest? request;

        public TaskCompletionSource<BrokerResponse> Completion { get; private set; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void Prepare(BrokerRequest nextRequest)
        {
            request = nextRequest;
            Completion = new TaskCompletionSource<BrokerResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public void Execute(UIApplication application)
        {
            if (request is null)
                return;

            try
            {
                Completion.SetResult(dispatcher.Dispatch(application, request));
            }
            catch (Exception exception)
            {
                Completion.SetResult(new BrokerResponse
                {
                    Id = request.Id,
                    Type = request.Type == DocumentDispatcher.CaptureRequestType ? request.Type : "model.execute",
                    WorkspaceRoot = request.WorkspaceRoot,
                    Status = "failed",
                    Error = new ErrorReceipt { Code = "revit_operation_failed", Message = exception.Message },
                });
            }
            finally
            {
                request = null;
            }
        }

        public string GetName() => "Drive It typed Revit operations";
    }
}

/// <summary>Reads newline-terminated requests from the pipe, keeping bytes after a line for the next read.</summary>
internal sealed class PipeLineReader(Stream stream, int maximumBytes)
{
    private readonly byte[] buffer = new byte[8192];
    private readonly MemoryStream pending = new();

    /// <summary>The next line without its terminator, or null when the client closed the connection.</summary>
    public async Task<string?> ReadLineAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            var bytes = pending.GetBuffer();
            var length = checked((int)pending.Length);
            var end = Array.IndexOf(bytes, (byte)'\n', 0, length);
            if (end >= 0)
            {
                if (end > maximumBytes)
                    throw new InvalidDataException("The request exceeds the 1 MiB limit.");
                var lineLength = end > 0 && bytes[end - 1] == (byte)'\r' ? end - 1 : end;
                var line = Encoding.UTF8.GetString(bytes, 0, lineLength);
                var rest = bytes.AsSpan(end + 1, length - end - 1).ToArray();
                pending.SetLength(0);
                pending.Write(rest);
                return line;
            }
            if (length > maximumBytes)
                throw new InvalidDataException("The request exceeds the 1 MiB limit.");
            var count = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (count == 0)
                return null;
            pending.Write(buffer, 0, count);
        }
    }
}
