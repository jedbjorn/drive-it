using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using DriveIt.Core.Bridge;
using DriveIt.Revit.Broker;

namespace DriveIt.Revit.Bridge;

/// <summary>What the dispatcher asks of a hold while it serves built-in operations inside one.</summary>
internal interface IHeldDocuments
{
    /// <summary>Opens the run's transaction group on this document before its first transaction.</summary>
    void BeforeTransaction(Document document);

    /// <summary>
    /// A save, save-as or close: closes the document's group so what came before is kept. True when a group
    /// was closed, so the receipt can mark the commit point.
    /// </summary>
    bool CommitPoint(Document document);

    /// <summary>Revit's error messages from the last transaction it rolled back, or null.</summary>
    string? TakeErrors();

    /// <summary>The hold's key for a document, so the server can tell which document each effect belongs to.</summary>
    string DocumentKey(Document document);
}

public sealed class HoldSummary
{
    public string Outcome { get; set; } = "";
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset EndedAt { get; set; }
    public DateTimeOffset Deadline { get; set; }
    public long Ms { get; set; }
    public int Calls { get; set; }
    public List<HoldWarning> Warnings { get; set; } = [];
    public int WarningsOmitted { get; set; }
    public List<HoldDocument> Documents { get; set; } = [];
}

public sealed class HoldWarning
{
    public string Description { get; set; } = "";
    public string Severity { get; set; } = "";
    public List<long> ElementIds { get; set; } = [];
    public string Document { get; set; } = "";
    public string Transaction { get; set; } = "";
}

/// <summary>One document the run changed: "committed", "rolled_back", "commit_failed" or "rollback_failed".</summary>
public sealed class HoldDocument
{
    public string Title { get; set; } = "";
    public string? Path { get; set; }
    public string State { get; set; } = "";
    /// <summary>A save closed the run's group at least once, so changes before it are kept whatever the outcome.</summary>
    public bool CommitPoint { get; set; }
    public string? Message { get; set; }
}

/// <summary>
/// One run's hold. Revit's thread stays inside <see cref="Serve"/> from the run's first bridge call to its end,
/// serving the requests the pipe thread posts. The hold bounds itself: a deadline, Stop, or a dropped
/// connection rolls every document back and releases Revit without waiting to be told.
/// </summary>
internal sealed class HeldRun : IHeldDocuments
{
    private const int MaximumWarnings = 200;
    private const int MaximumTransactionIds = 1000;
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(200);

    private readonly BlockingCollection<Message> inbox = new();
    private readonly TaskCompletionSource<string> begun = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource ended = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object gate = new();
    private readonly BridgeCalls calls;
    private readonly List<GroupEntry> groups = [];
    private readonly Dictionary<long, (Transaction Transaction, Document Document)> transactions = new();
    private readonly List<HoldWarning> warnings = [];
    private readonly List<string> errors = [];
    private readonly TimeSpan requestedLimit;
    private int warningsOmitted;
    private long nextTransaction;
    private bool started;
    private bool cancelled;
    private bool isEnded;
    private volatile bool stopRequested;
    private HoldSummary? summary;
    private Committing? committing;
    private readonly List<(Document Document, string Key)> documentKeys = [];

    public HeldRun(string runId, string? displayName, int? timeLimitMs)
    {
        RunId = runId;
        calls = new BridgeCalls(this, AnyTransactionOpen);
        DisplayName = string.IsNullOrWhiteSpace(displayName) ? null : displayName.Trim();
        requestedLimit = timeLimitMs is > 0 ? TimeSpan.FromMilliseconds(timeLimitMs.Value) : TimeSpan.MaxValue;
    }

    public string RunId { get; }
    public string? DisplayName { get; }
    public DateTimeOffset StartedAt { get; private set; }
    public DateTimeOffset Deadline { get; private set; }
    public int Calls { get; private set; }

    /// <summary>The hold.begin reply, once Revit's thread has entered the hold (or refused it).</summary>
    public Task<string> Begun => begun.Task;

    /// <summary>Completes once the hold has ended and Revit is released.</summary>
    public Task Ended => ended.Task;

    public HoldSummary? Summary
    {
        get
        {
            lock (gate)
                return summary;
        }
    }

    private string GroupName => $"Drive-It: {DisplayName ?? $"run {RunId[..Math.Min(8, RunId.Length)]}"}";

    public void RequestStop() => stopRequested = true;

    /// <summary>A revit.transaction, or a transaction a Dev Mode script made, is open somewhere in the run.</summary>
    private bool AnyTransactionOpen() => transactions.Count > 0 || calls.ScriptTransactionOpen;

    /// <summary>The client is gone. Before the hold starts this cancels it; during it, it ends it.</summary>
    public void Disconnect()
    {
        lock (gate)
        {
            if (isEnded)
                return;
            if (!started)
            {
                cancelled = true;
                return;
            }
        }
        inbox.TryAdd(Message.Disconnected);
    }

    /// <summary>Posts one request line from the held connection; the reply is its response line.</summary>
    public Task<string> Post(string line)
    {
        JsonObject request;
        try
        {
            request = JsonNode.Parse(line) as JsonObject ?? throw new JsonException("A JSON request object is required.");
        }
        catch (JsonException exception)
        {
            return Task.FromResult(Failure("", "hold", "invalid_request", exception.Message));
        }

        var message = new Message(request);
        lock (gate)
        {
            if (isEnded)
                return Task.FromResult(AfterEnd(message));
            inbox.Add(message);
        }
        return message.Reply.Task;
    }

    /// <summary>Runs on Revit's thread, inside the hold's ExternalEvent, until the hold ends.</summary>
    public void Serve(UIApplication application, DocumentDispatcher dispatcher)
    {
        lock (gate)
        {
            if (cancelled)
            {
                isEnded = true;
                summary = new HoldSummary { Outcome = "disconnected", StartedAt = DateTimeOffset.Now, EndedAt = DateTimeOffset.Now };
                begun.TrySetResult(Failure(RunId, "hold.begin", "hold_cancelled", "The client left before Revit was held."));
                ended.TrySetResult();
                return;
            }
            started = true;
        }

        StartedAt = DateTimeOffset.Now;
        var limit = HoldSignal.CurrentTimeLimit();
        Deadline = StartedAt + (requestedLimit < limit ? requestedLimit : limit);
        dispatcher.Held = this;
        application.Application.FailuresProcessing += OnFailuresProcessing;
        application.Application.DocumentChanged += OnDocumentChanged;
        HoldSignal.RaiseStarted(this);
        begun.TrySetResult(new JsonObject
        {
            ["id"] = RunId,
            ["type"] = "hold.begin",
            ["status"] = "held",
            ["hold"] = new JsonObject
            {
                ["startedAt"] = StartedAt.ToString("O"),
                ["deadline"] = Deadline.ToString("O"),
                ["timeLimitMs"] = (long)(Deadline - StartedAt).TotalMilliseconds,
            },
        }.ToJsonString());

        Message? endMessage = null;
        var reason = "rolled_back";
        try
        {
            reason = Loop(application, dispatcher, out endMessage);
        }
        catch (Exception exception)
        {
            Trace.WriteLine($"Drive-It: the hold for run {RunId} failed ({exception.GetType().Name}: {exception.Message}); rolling back.");
        }
        finally
        {
            var result = End(reason);
            try
            {
                application.Application.FailuresProcessing -= OnFailuresProcessing;
                application.Application.DocumentChanged -= OnDocumentChanged;
            }
            catch (Exception)
            {
                // Revit is shutting down; nothing left to unsubscribe from.
            }
            dispatcher.Held = null;
            calls.Clear();
            List<Message> drained;
            lock (gate)
            {
                summary = result;
                isEnded = true;
                drained = [.. inbox];
                while (inbox.TryTake(out _))
                {
                }
            }
            endMessage?.Reply.TrySetResult(EndReply(endMessage));
            foreach (var message in drained)
                message.Reply.TrySetResult(AfterEnd(message));
            var outcome = result.Documents.Any(document => document.State == "rollback_failed") ? "rollback_failed" : result.Outcome;
            HoldSignal.RaiseEnded(this, outcome);
            ended.TrySetResult();
        }
    }

    private string Loop(UIApplication application, DocumentDispatcher dispatcher, out Message? endMessage)
    {
        endMessage = null;
        while (true)
        {
            if (stopRequested)
                return "stopped_by_user";
            var remaining = Deadline - DateTimeOffset.Now;
            if (remaining <= TimeSpan.Zero)
                return "timed_out";
            if (!inbox.TryTake(out var message, remaining < Poll ? remaining : Poll))
                continue;
            if (ReferenceEquals(message, Message.Disconnected))
                return "disconnected";
            var type = message.Type;
            if (type == "hold.end")
            {
                endMessage = message;
                return message.Request["end"]?["outcome"]?.GetValue<string>() == "commit" ? "committed" : "rolled_back";
            }
            Calls++;
            message.Reply.TrySetResult(type switch
            {
                "bridge.call" => BridgeCall(application, dispatcher, message),
                "model.execute" => ModelExecute(application, dispatcher, message),
                _ => Failure(message.Id, type, "unsupported_request",
                    "A held connection takes bridge.call, model.execute and hold.end requests."),
            });
        }
    }

    private string BridgeCall(UIApplication application, DocumentDispatcher dispatcher, Message message)
    {
        if (message.Request["call"] is not JsonObject call)
            return Failure(message.Id, "bridge.call", "invalid_call", "A bridge.call request carries a call object.");
        try
        {
            var op = call["op"]?.GetValue<string>();
            JsonNode? value = op switch
            {
                "get" => calls.Get(call),
                "set" => calls.Set(call),
                "call" => calls.Call(call),
                "index" => calls.Index(call),
                "iter" => calls.Iterate(call),
                "next" => calls.Next(call),
                "len" => calls.Length(call),
                "eq" => calls.Equal(call),
                "str" => calls.Text(call),
                "operator" => calls.Operator(call),
                "document" => calls.Handle(ResolveDocument(application, dispatcher, call["document"])),
                "element" => Element(application, dispatcher, call),
                "tx.start" => StartTransaction(application, dispatcher, call),
                "tx.commit" => CommitTransaction(call),
                "tx.rollback" => RollBackTransaction(call),
                "describe" => BridgeCalls.Describe(call),
                _ => throw new BridgeException("invalid_call", $"Unknown bridge operation '{op}'."),
            };
            return new JsonObject
            {
                ["id"] = message.Id,
                ["type"] = "bridge.call",
                ["status"] = "succeeded",
                ["value"] = value,
            }.ToJsonString();
        }
        catch (BridgeException exception)
        {
            return Failure(message.Id, "bridge.call", exception.Code, exception.Message);
        }
        catch (RequestRejectedException exception)
        {
            return Failure(message.Id, "bridge.call", exception.Code, exception.Message);
        }
        catch (Exception exception) when (exception is InvalidOperationException or FormatException or JsonException)
        {
            return Failure(message.Id, "bridge.call", "invalid_call", exception.Message);
        }
    }

    private string ModelExecute(UIApplication application, DocumentDispatcher dispatcher, Message message)
    {
        BrokerRequest? request;
        try
        {
            request = message.Request.Deserialize<BrokerRequest>(RevitBroker.JsonOptions);
        }
        catch (JsonException exception)
        {
            return Failure(message.Id, "model.execute", "invalid_request", exception.Message);
        }
        var invalid = RevitBroker.Validate(request);
        if (invalid is not null)
            return invalid;
        BrokerResponse response;
        try
        {
            response = dispatcher.Dispatch(application, request!);
        }
        catch (Exception exception)
        {
            response = new BrokerResponse
            {
                Id = request!.Id,
                WorkspaceRoot = request.WorkspaceRoot,
                Status = "failed",
                Error = new ErrorReceipt { Code = "revit_operation_failed", Message = exception.Message },
            };
        }
        return JsonSerializer.Serialize(response, RevitBroker.JsonOptions);
    }

    private Document ResolveDocument(UIApplication application, DocumentDispatcher dispatcher, JsonNode? node)
    {
        if (node is JsonObject handle && handle["$h"] is { } id)
            return calls.Lookup(id.GetValue<long>()) as Document
                ?? throw new BridgeException("invalid_argument", "document= takes a document from a receipt or a Document handle.");
        if (node is JsonObject target)
        {
            return dispatcher.ResolveForBridge(application, new DocumentTarget
            {
                Path = target["path"]?.GetValue<string>(),
                UniqueId = target["uniqueId"]?.GetValue<string>(),
            });
        }
        return dispatcher.ResolveForBridge(application, null);
    }

    private JsonNode? Element(UIApplication application, DocumentDispatcher dispatcher, JsonObject call)
    {
        var document = ResolveDocument(application, dispatcher, call["document"]);
        var id = call["id"]?.GetValue<long>() ?? throw new BridgeException("invalid_argument", "revit.element takes an integer element id.");
        var element = document.GetElement(new ElementId(id))
            ?? throw new BridgeException("element_not_found", $"No element has id {id} in {document.Title}.");
        return calls.Handle(element);
    }

    private JsonNode StartTransaction(UIApplication application, DocumentDispatcher dispatcher, JsonObject call)
    {
        var document = ResolveDocument(application, dispatcher, call["document"]);
        var name = call["name"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(name))
            throw new BridgeException("invalid_argument", "revit.transaction takes a name.");
        if (transactions.Values.Any(open => SameDocument(open.Document, document)))
            throw new BridgeException("transaction_open",
                $"A revit.transaction is already open on {document.Title}; Revit allows one at a time for each document.");
        BeforeTransaction(document);
        var transaction = new Transaction(document, name.Trim());
        TransactionStatus status;
        try
        {
            status = transaction.Start();
        }
        catch (Exception exception)
        {
            transaction.Dispose();
            throw new BridgeException("revit_api_error", ApiErrors.Message(nameof(Transaction), nameof(Transaction.Start), exception));
        }
        if (status != TransactionStatus.Started)
        {
            transaction.Dispose();
            throw new BridgeException("transaction_failed", $"Revit did not start the transaction ({status}).");
        }
        var id = ++nextTransaction;
        transactions[id] = (transaction, document);
        return id;
    }

    /// <summary>Commits a revit.transaction; the reply names what Revit reported as added, changed and deleted.</summary>
    private JsonNode CommitTransaction(JsonObject call)
    {
        var (id, transaction) = OpenTransaction(call);
        var name = transaction.GetName();
        var document = transactions[id].Document;
        errors.Clear();
        TransactionStatus status;
        var changed = committing = new Committing(document);
        try
        {
            status = transaction.Commit();
        }
        catch (Exception exception)
        {
            RollBackQuietly(transaction);
            throw new BridgeException("revit_api_error", ApiErrors.Message(nameof(Transaction), nameof(Transaction.Commit), exception));
        }
        finally
        {
            committing = null;
            transactions.Remove(id);
            transaction.Dispose();
        }
        if (status != TransactionStatus.Committed)
            throw new BridgeException("transaction_failed",
                $"Revit rolled back the transaction '{name}': {TakeErrors() ?? $"status {status}"}");
        return new JsonObject
        {
            ["name"] = name,
            ["document"] = document.Title,
            ["documentKey"] = DocumentKey(document),
            ["added"] = Ids(changed.Added),
            ["changed"] = Ids(changed.Modified),
            ["deleted"] = Ids(changed.Deleted),
            ["totals"] = new JsonObject
            {
                ["added"] = changed.Added.Count,
                ["changed"] = changed.Modified.Count,
                ["deleted"] = changed.Deleted.Count,
            },
            ["truncated"] = new[] { changed.Added, changed.Modified, changed.Deleted }.Any(list => list.Count > MaximumTransactionIds),
        };
    }

    private static JsonArray Ids(List<long> ids) => new(ids.Take(MaximumTransactionIds).Select(id => (JsonNode)id).ToArray());

    /// <summary>Revit raises DocumentChanged as a transaction commits; the one being committed keeps its element ids.</summary>
    private void OnDocumentChanged(object? sender, DocumentChangedEventArgs e)
    {
        if (committing is null || e.Operation != UndoOperation.TransactionCommitted || !SameDocument(e.GetDocument(), committing.Document))
            return;
        committing.Added.AddRange(e.GetAddedElementIds().Select(element => element.Value));
        committing.Modified.AddRange(e.GetModifiedElementIds().Select(element => element.Value));
        committing.Deleted.AddRange(e.GetDeletedElementIds().Select(element => element.Value));
    }

    private JsonNode? RollBackTransaction(JsonObject call)
    {
        var (id, transaction) = OpenTransaction(call);
        try
        {
            RollBackQuietly(transaction);
        }
        finally
        {
            transactions.Remove(id);
            transaction.Dispose();
        }
        return null;
    }

    private (long Id, Transaction Transaction) OpenTransaction(JsonObject call)
    {
        var id = call["transaction"]?.GetValue<long>() ?? 0;
        return transactions.TryGetValue(id, out var open)
            ? (id, open.Transaction)
            : throw new BridgeException("invalid_handle", "That revit.transaction is not open.");
    }

    public void BeforeTransaction(Document document)
    {
        if (groups.Any(entry => entry.Group is not null && SameDocument(entry.Document, document)))
            return;
        var entry = groups.FirstOrDefault(candidate => SameDocument(candidate.Document, document));
        if (entry is null)
        {
            entry = new GroupEntry(document);
            groups.Add(entry);
        }
        var group = new TransactionGroup(document, GroupName);
        if (group.Start() != TransactionStatus.Started)
        {
            group.Dispose();
            throw new RequestRejectedException("transaction_failed", $"Revit did not start the run's transaction group on {document.Title}.");
        }
        entry.Group = group;
    }

    public bool CommitPoint(Document document)
    {
        if (transactions.Values.Any(open => SameDocument(open.Document, document)))
            throw new RequestRejectedException("transaction_open",
                $"Leave the revit.transaction on {document.Title} before saving or closing it.");
        var entry = groups.FirstOrDefault(candidate => candidate.Group is not null && SameDocument(candidate.Document, document));
        if (entry is null)
            return false;
        var group = entry.Group!;
        entry.Group = null;
        var status = group.Assimilate();
        group.Dispose();
        if (status != TransactionStatus.Committed)
            throw new RequestRejectedException("commit_failed", $"Revit did not keep the run's changes to {document.Title} before the save ({status}).");
        entry.CommitPoint = true;
        entry.State = "committed";
        return true;
    }

    public string DocumentKey(Document document)
    {
        foreach (var (known, key) in documentKeys)
        {
            if (SameDocument(known, document))
                return key;
        }
        var next = $"d{documentKeys.Count + 1}";
        documentKeys.Add((document, next));
        return next;
    }

    public string? TakeErrors()
    {
        if (errors.Count == 0)
            return null;
        var text = string.Join(" ", errors);
        errors.Clear();
        return text;
    }

    /// <summary>Ends every transaction and closes every group: one undo entry each on commit, restored otherwise.</summary>
    private HoldSummary End(string reason)
    {
        var commit = reason == "committed";
        // A Dev Mode script's own transactions first (innermost), then the revit.transaction ones, then once more for a
        // script group that was around a revit.transaction and can close only after it.
        calls.RollBackScriptTransactions();
        foreach (var (transaction, _) in transactions.Values)
        {
            RollBackQuietly(transaction);
            transaction.Dispose();
        }
        transactions.Clear();
        calls.RollBackScriptTransactions();

        foreach (var entry in groups)
        {
            if (entry.Group is not { } group)
                continue;
            entry.Group = null;
            try
            {
                var status = commit ? group.Assimilate() : group.RollBack();
                entry.State = commit
                    ? status == TransactionStatus.Committed ? "committed" : "commit_failed"
                    : status == TransactionStatus.RolledBack ? "rolled_back" : "rollback_failed";
                if (entry.State.EndsWith("_failed", StringComparison.Ordinal))
                    entry.Message = $"Revit returned {status}.";
            }
            catch (Exception exception)
            {
                entry.State = commit ? "commit_failed" : "rollback_failed";
                entry.Message = $"{exception.GetType().Name}: {exception.Message}";
            }
            finally
            {
                group.Dispose();
            }
        }

        var endedAt = DateTimeOffset.Now;
        return new HoldSummary
        {
            Outcome = reason,
            StartedAt = StartedAt,
            EndedAt = endedAt,
            Deadline = Deadline,
            Ms = (long)(endedAt - StartedAt).TotalMilliseconds,
            Calls = Calls,
            Warnings = [.. warnings],
            WarningsOmitted = warningsOmitted,
            Documents = groups.Select(entry => new HoldDocument
            {
                Title = entry.Title,
                Path = entry.Path,
                State = entry.State,
                CommitPoint = entry.CommitPoint,
                Message = entry.Message,
            }).ToList(),
        };
    }

    private static void RollBackQuietly(Transaction transaction)
    {
        try
        {
            if (transaction.IsValidObject && transaction.GetStatus() == TransactionStatus.Started)
                transaction.RollBack();
        }
        catch (Exception exception)
        {
            Trace.WriteLine($"Drive-It: rolling back a transaction failed ({exception.GetType().Name}: {exception.Message}).");
        }
    }

    /// <summary>During a hold no failure reaches a dialog: warnings go to the receipt, errors roll the transaction back.</summary>
    private void OnFailuresProcessing(object? sender, FailuresProcessingEventArgs e)
    {
        var accessor = e.GetFailuresAccessor();
        var messages = accessor.GetFailureMessages();
        if (messages.Count == 0)
            return;
        var rollBack = false;
        foreach (var message in messages)
        {
            var severity = message.GetSeverity();
            var description = message.GetDescriptionText();
            if (severity == FailureSeverity.Warning)
            {
                if (warnings.Count < MaximumWarnings)
                {
                    warnings.Add(new HoldWarning
                    {
                        Description = description,
                        Severity = "warning",
                        ElementIds = message.GetFailingElementIds().Select(id => id.Value).ToList(),
                        Document = accessor.GetDocument().Title,
                        Transaction = accessor.GetTransactionName(),
                    });
                }
                else
                {
                    warningsOmitted++;
                }
                accessor.DeleteWarning(message);
                continue;
            }
            rollBack = true;
            errors.Add(description);
        }
        if (!rollBack)
        {
            e.SetProcessingResult(FailureProcessingResult.Continue);
            return;
        }
        var options = accessor.GetFailureHandlingOptions();
        options.SetClearAfterRollback(true);
        accessor.SetFailureHandlingOptions(options);
        e.SetProcessingResult(FailureProcessingResult.ProceedWithRollBack);
    }

    private string EndReply(Message message) => new JsonObject
    {
        ["id"] = message.Id,
        ["type"] = "hold.end",
        ["status"] = "ended",
        ["hold"] = JsonSerializer.SerializeToNode(Summary, RevitBroker.JsonOptions),
    }.ToJsonString();

    private string AfterEnd(Message message) => message.Type == "hold.end"
        ? EndReply(message)
        : Failure(message.Id, message.Type, Summary?.Outcome is { } outcome and not ("committed" or "rolled_back") ? outcome : "hold_ended",
            $"Revit is no longer held for this run ({Summary?.Outcome ?? "ended"}); every change after the last save was rolled back.");

    private static string Failure(string id, string type, string code, string message) => new JsonObject
    {
        ["id"] = id,
        ["type"] = type,
        ["status"] = "failed",
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    }.ToJsonString();

    private static bool SameDocument(Document left, Document right)
    {
        if (ReferenceEquals(left, right))
            return true;
        try
        {
            return left.IsValidObject && right.IsValidObject && (left.Equals(right)
                || (left.Title == right.Title && left.PathName == right.PathName && left.IsFamilyDocument == right.IsFamilyDocument));
        }
        catch (Exception)
        {
            return false;
        }
    }

    private sealed class Committing(Document document)
    {
        public Document Document { get; } = document;
        public List<long> Added { get; } = [];
        public List<long> Modified { get; } = [];
        public List<long> Deleted { get; } = [];
    }

    private sealed class GroupEntry(Document document)
    {
        public Document Document { get; } = document;
        public string Title { get; } = document.Title;
        public string? Path { get; } = string.IsNullOrWhiteSpace(document.PathName) ? null : document.PathName;
        public TransactionGroup? Group { get; set; }
        public bool CommitPoint { get; set; }
        public string State { get; set; } = "committed";
        public string? Message { get; set; }
    }

    private sealed class Message
    {
        public static readonly Message Disconnected = new(new JsonObject { ["type"] = "disconnected" });

        public Message(JsonObject request)
        {
            Request = request;
            Id = request["id"] is JsonValue id && id.TryGetValue<string>(out var text) ? text : "";
            Type = request["type"] is JsonValue type && type.TryGetValue<string>(out var name) ? name : "";
        }

        public JsonObject Request { get; }
        public string Id { get; }
        public string Type { get; }
        public TaskCompletionSource<string> Reply { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
