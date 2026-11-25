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
    /// <summary>The longest a documents.list waits for Revit's thread: a run's whole time limit at most (decision #53).</summary>
    private const int MaximumDocumentsWaitMs = 600_000;

    private readonly RevitRequestHandler handler;
    private readonly ExternalEvent externalEvent;
    private readonly HoldHandler holdHandler;
    private readonly ExternalEvent holdEvent;
    private readonly LinkedList<HeldRun> recent = new();
    private readonly DocumentsHandler documentsHandler;
    private readonly ExternalEvent documentsEvent;

    public RevitBroker(UIControlledApplication application)
    {
        var dispatcher = new DocumentDispatcher();
        handler = new RevitRequestHandler(dispatcher);
        externalEvent = ExternalEvent.Create(handler);
        holdHandler = new HoldHandler(dispatcher);
        holdEvent = ExternalEvent.Create(holdHandler);
        documentsHandler = new DocumentsHandler(dispatcher);
        documentsEvent = ExternalEvent.Create(documentsHandler);
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
        var type = RequestType(json);
        if (type == "api.describe")
            return Describe(json);
        if (type == DocumentsRequestType)
            return await ListDocumentsAsync(json, cancellationToken).ConfigureAwait(false);
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

        var run = new HeldRun(request.Id, request.Hold.DisplayName, request.Hold.TimeLimitMs, request.Hold.DryRun, request.Hold.RequireDryRun,
            request.Hold.Targets);
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

    internal const string DocumentsRequestType = "documents.list";

    /// <summary>
    /// Spec #28 "Open Documents": the open documents, read on Revit's thread, with a run's targets resolved. The wait for
    /// Revit's thread is bounded by the request's waitMs: past it the reply is busy and the pipe is free again, so a dialog
    /// open in Revit never holds it (flag #15). The read stays queued and serves the next documents.list once Revit is free.
    /// </summary>
    private async Task<string> ListDocumentsAsync(string json, CancellationToken cancellationToken)
    {
        string id;
        DocumentsRequest request;
        try
        {
            var node = JsonNode.Parse(json)!.AsObject();
            id = node["id"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";
            request = node["documents"]?.Deserialize<DocumentsRequest>(JsonOptions) ?? new DocumentsRequest();
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException)
        {
            return InvalidRequest("", "invalid_request", exception.Message, DocumentsRequestType);
        }
        if (string.IsNullOrWhiteSpace(id) || id.Length > 128)
            return InvalidRequest(id, "invalid_request", "A request id of 1 to 128 characters is required.", DocumentsRequestType);

        var reply = documentsHandler.Prepare(id, request);
        var raised = documentsEvent.Raise();
        if (raised is not (ExternalEventRequest.Accepted or ExternalEventRequest.Pending))
            return Busy(id);
        var wait = TimeSpan.FromMilliseconds(Math.Clamp(request.WaitMs ?? MaximumDocumentsWaitMs, 1, MaximumDocumentsWaitMs));
        var answered = await Task.WhenAny(reply, Task.Delay(wait, cancellationToken)).ConfigureAwait(false);
        return answered == reply ? await reply.ConfigureAwait(false) : Busy(id);
    }

    private static string Busy(string id) => new JsonObject
    {
        ["id"] = id,
        ["type"] = DocumentsRequestType,
        ["status"] = "busy",
    }.ToJsonString();

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

    /// <summary>
    /// documents.list on Revit's thread, with its own ExternalEvent so a read left waiting never takes another request's
    /// place. Only the latest read is served: one that timed out is replaced by the next, and nobody waits on it.
    /// </summary>
    private sealed class DocumentsHandler(DocumentDispatcher dispatcher) : IExternalEventHandler
    {
        private readonly object gate = new();
        private (string Id, DocumentsRequest Request, TaskCompletionSource<string> Reply)? next;

        public Task<string> Prepare(string id, DocumentsRequest request)
        {
            var reply = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (gate)
                next = (id, request, reply);
            return reply.Task;
        }

        public void Execute(UIApplication application)
        {
            (string Id, DocumentsRequest Request, TaskCompletionSource<string> Reply)? taken;
            lock (gate)
            {
                taken = next;
                next = null;
            }
            if (taken is not { } item)
                return;
            try
            {
                item.Reply.TrySetResult(dispatcher.ListDocuments(application, item.Id, item.Request).ToJsonString());
            }
            catch (RequestRejectedException exception)
            {
                item.Reply.TrySetResult(InvalidRequest(item.Id, exception.Code, exception.Message, DocumentsRequestType));
            }
            catch (Exception exception)
            {
                item.Reply.TrySetResult(InvalidRequest(item.Id, "revit_operation_failed", exception.Message, DocumentsRequestType));
            }
        }

        public string GetName() => "Drive It open documents";
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
