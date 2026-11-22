using System.Text.Json;
using System.Text.Json.Serialization;
using Autodesk.Revit.UI;

namespace DriveIt.Revit.Broker;

public sealed class RevitBroker
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly RevitRequestHandler handler;
    private readonly ExternalEvent externalEvent;

    public RevitBroker(UIControlledApplication application)
    {
        var dispatcher = new DocumentDispatcher();
        handler = new RevitRequestHandler(dispatcher);
        externalEvent = ExternalEvent.Create(handler);
    }

    public async Task<string> ExecuteAsync(string json, CancellationToken cancellationToken)
    {
        BrokerRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<BrokerRequest>(json, JsonOptions);
            if (request is null)
                return InvalidRequest("", "invalid_request", "A JSON request object is required.");
            if (string.IsNullOrWhiteSpace(request.Id) || request.Id.Length > 128)
                return InvalidRequest(request.Id, "invalid_request", "A request id of 1 to 128 characters is required.");
            if (request.Type != "model.execute")
                return InvalidRequest(request.Id, "unsupported_request", "The request type must be 'model.execute'.");
            if (request.Operations is null || request.Operations.Count == 0)
                return InvalidRequest(request.Id, "empty_batch", "At least one typed operation is required.");
        }
        catch (JsonException exception)
        {
            return InvalidRequest("", "invalid_request", exception.Message);
        }

        handler.Prepare(request);
        externalEvent.Raise();
        var response = await handler.Completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
        return JsonSerializer.Serialize(response, JsonOptions);
    }

    public static string InvalidRequest(string id, string code, string message)
    {
        return JsonSerializer.Serialize(new BrokerResponse
        {
            Id = id,
            Status = "failed",
            Error = new ErrorReceipt { Code = code, Message = message },
        }, JsonOptions);
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
