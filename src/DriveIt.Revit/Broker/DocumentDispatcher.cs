using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace DriveIt.Revit.Broker;

public sealed partial class DocumentDispatcher
{
    private static readonly JsonSerializerOptions ArgumentJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly Dictionary<string, DocumentState> documents = new(StringComparer.Ordinal);

    public BrokerResponse Dispatch(UIApplication application, BrokerRequest request)
    {
        if (request.Type == CaptureRequestType)
            return Capture(application, request);

        var response = new BrokerResponse
        {
            Id = request.Id,
            WorkspaceRoot = request.WorkspaceRoot,
            Results = request.Operations.Select(_ => (JsonNode?)null).ToList(),
        };

        try
        {
            var root = WorkspacePolicy.CanonicalRoot(request.WorkspaceRoot);
            response.WorkspaceRoot = root;
            var prepared = PrepareOperations(application, request);
            var policyRequests = OutsideRootRequests(root, prepared);
            if (policyRequests.Count > 0 && !AllCovered(request.OutsideRootApproval, policyRequests))
            {
                response.Status = "policy_required";
                response.PolicyRequests = policyRequests;
                response.Error = new ErrorReceipt
                {
                    Code = "policy_required",
                    Message = "The complete batch requires an explicit outside-root decision before execution.",
                };
                return response;
            }

            Execute(application, request, prepared, response);
            if (string.IsNullOrEmpty(response.Status))
                response.Status = "succeeded";
        }
        catch (RequestRejectedException exception)
        {
            response.Status = HasEffects(response) ? "partially_applied" : "failed";
            response.Error = new ErrorReceipt { Code = exception.Code, Message = exception.Message };
        }
        catch (Exception exception)
        {
            response.Status = HasEffects(response) ? "partially_applied" : "failed";
            response.Error = new ErrorReceipt { Code = "revit_operation_failed", Message = exception.Message };
        }

        return response;
    }

    private List<PreparedOperation> PrepareOperations(UIApplication application, BrokerRequest request)
    {
        string? currentPath = null;
        if (!string.IsNullOrWhiteSpace(request.Document?.UniqueId))
        {
            var state = Resolve(application, request.Document);
            currentPath = CanonicalDocumentPath(state.Document);
        }
        else if (!string.IsNullOrWhiteSpace(request.Document?.Path))
        {
            currentPath = WorkspacePolicy.Canonicalize(request.Document.Path, "document.path");
        }

        var prepared = new List<PreparedOperation>();
        foreach (var operation in request.Operations)
        {
            if (operation is null || string.IsNullOrWhiteSpace(operation.Type))
                throw new RequestRejectedException("invalid_operation", "Every operation requires a type.");
            var item = new PreparedOperation(operation.Type);
            if (IsQuery(operation.Type))
            {
                // Queries and selection carry no policy paths and never change currentPath.
                item.Query = PrepareQuery(operation);
                prepared.Add(item);
                continue;
            }
            if (IsModelChange(operation.Type))
            {
                item.ModelChange = Deserialize<ModelChangeRequest>(operation.Arguments);
                item.ModelChange.Type = operation.Type;
                prepared.Add(item);
                continue;
            }

            item.DocumentArguments = Deserialize<DocumentOperationArguments>(operation.Arguments);
            switch (operation.Type)
            {
                case "open_document":
                    item.DocumentArguments.Path = WorkspacePolicy.Canonicalize(item.DocumentArguments.Path, "open_document.path");
                    item.PolicyPaths.Add(item.DocumentArguments.Path);
                    currentPath = item.DocumentArguments.Path;
                    break;
                case "create_document":
                    item.DocumentArguments.TemplatePath = WorkspacePolicy.Canonicalize(item.DocumentArguments.TemplatePath,
                        "create_document.templatePath");
                    item.PolicyPaths.Add(item.DocumentArguments.TemplatePath);
                    currentPath = null;
                    break;
                case "save_document":
                case "delete_document":
                    if (currentPath is not null)
                        item.PolicyPaths.Add(currentPath);
                    break;
                case "save_as_document":
                    item.DocumentArguments.DestinationPath = WorkspacePolicy.Canonicalize(
                        item.DocumentArguments.DestinationPath, "save_as_document.destinationPath");
                    item.PolicyPaths.Add(item.DocumentArguments.DestinationPath);
                    currentPath = item.DocumentArguments.DestinationPath;
                    break;
                case "close_document":
                    currentPath = null;
                    break;
                case "read_document":
                    break;
                default:
                    throw new RequestRejectedException("unsupported_operation", $"Unsupported operation '{operation.Type}'.");
            }
            prepared.Add(item);
        }
        return prepared;
    }

    private void Execute(UIApplication application, BrokerRequest request, List<PreparedOperation> prepared,
        BrokerResponse response)
    {
        DocumentState? current = TryResolveInitial(application, request.Document);
        for (var index = 0; index < prepared.Count; index++)
        {
            var operation = prepared[index];
            if (IsQuery(operation.Type))
            {
                current = ExecuteQuery(application, operation, current, response, index);
                continue;
            }
            if (IsModelChange(operation.Type))
            {
                current = RequireDocument(current);
                var changes = new List<ModelChangeRequest>();
                while (index < prepared.Count && IsModelChange(prepared[index].Type))
                {
                    changes.Add(prepared[index].ModelChange!);
                    index++;
                }
                index--;
                if (!ApplyModelBatch(current, changes, response))
                    return;
                continue;
            }

            var arguments = operation.DocumentArguments;
            switch (operation.Type)
            {
                case "open_document":
                    current = Open(application, arguments, response);
                    break;
                case "create_document":
                    current = Create(application, arguments, response);
                    break;
                case "read_document":
                    current = RequireDocument(current);
                    response.Document = Snapshot(current);
                    response.Checks.Add(IdentityCheck(current));
                    break;
                case "save_document":
                    current = RequireDocument(current);
                    Save(current, response);
                    break;
                case "save_as_document":
                    current = RequireDocument(current);
                    SaveAs(current, arguments, response);
                    break;
                case "close_document":
                    current = RequireDocument(current);
                    Close(current, response);
                    current = null;
                    break;
                case "delete_document":
                    current = RequireDocument(current);
                    Delete(current, response);
                    current = null;
                    break;
            }
        }
    }

    private DocumentState Open(UIApplication application, DocumentOperationArguments arguments, BrokerResponse response)
    {
        var path = arguments.Path!;
        ValidateExtension(path, ExpectedKind(arguments.Kind, path));
        if (!File.Exists(path))
            throw new RequestRejectedException("file_not_found", $"The model file does not exist: {path}");

        var existing = OpenDocuments(application).FirstOrDefault(document => PathsEqual(document.PathName, path));
        var state = existing is null ? Register(application.Application.OpenDocumentFile(path)) : Register(existing);
        response.Document = Snapshot(state);
        if (existing is null)
            response.Changes.Add($"Opened {path}.");
        response.Checks.Add(IdentityCheck(state));
        return state;
    }

    private DocumentState Create(UIApplication application, DocumentOperationArguments arguments, BrokerResponse response)
    {
        if (arguments.Kind is not ("rvt" or "rfa"))
            throw new RequestRejectedException("invalid_document_kind", "create_document requires kind 'rvt' or 'rfa'.");
        var template = arguments.TemplatePath!;
        var expectedExtension = arguments.Kind == "rvt" ? ".rte" : ".rft";
        if (!string.Equals(Path.GetExtension(template), expectedExtension, StringComparison.OrdinalIgnoreCase))
            throw new RequestRejectedException("invalid_template", $"A {arguments.Kind} document requires a {expectedExtension} template.");
        if (!File.Exists(template))
            throw new RequestRejectedException("template_not_found", $"The template does not exist: {template}");

        var document = arguments.Kind == "rvt"
            ? application.Application.NewProjectDocument(template)
            : application.Application.NewFamilyDocument(template);
        var state = Register(document, true);
        response.Document = Snapshot(state);
        response.Changes.Add($"Created unsaved {arguments.Kind} document {document.Title}.");
        response.Checks.Add(new CheckReceipt
        {
            Name = "document_kind",
            Passed = DocumentKind(document) == arguments.Kind,
            Observed = DocumentKind(document),
        });
        response.Checks.Add(IdentityCheck(state));
        return state;
    }

    private static void Save(DocumentState state, BrokerResponse response)
    {
        if (string.IsNullOrWhiteSpace(state.Document.PathName))
            throw new RequestRejectedException("save_as_required", "An unsaved document requires save_as_document with destinationPath.");

        state.Document.Save();
        var path = WorkspacePolicy.Canonicalize(state.Document.PathName, "document.path");
        response.Changes.Add($"Saved {path}.");
        response.AffectedFiles.Add(path);
        response.Document = Snapshot(state);
        var check = FileCheck(path, true);
        response.Checks.Add(check);
        if (!check.Passed)
            throw new IOException($"Revit returned from save, but the file observation failed: {path}");
    }

    private static void SaveAs(DocumentState state, DocumentOperationArguments arguments, BrokerResponse response)
    {
        var destination = arguments.DestinationPath!;
        ValidateExtension(destination, DocumentKind(state.Document));
        if (!Directory.Exists(Path.GetDirectoryName(destination)))
            throw new RequestRejectedException("directory_not_found", "The destination directory does not exist.");
        if (File.Exists(destination) && !arguments.Overwrite)
            throw new RequestRejectedException("file_exists", "The destination exists; set overwrite to true to replace it.");

        state.Document.SaveAs(destination, new SaveAsOptions { OverwriteExistingFile = arguments.Overwrite });
        response.Changes.Add($"Saved as {destination}.");
        response.AffectedFiles.Add(destination);
        response.Document = Snapshot(state);
        var check = FileCheck(destination, true);
        response.Checks.Add(check);
        response.Checks.Add(IdentityCheck(state));
        if (!check.Passed)
            throw new IOException($"Revit returned from save-as, but the file observation failed: {destination}");
    }

    private void Close(DocumentState state, BrokerResponse response)
    {
        response.Document = Snapshot(state);
        var title = state.Document.Title;
        if (!state.Document.Close(false))
            throw new InvalidOperationException($"Revit did not close {title}.");
        documents.Remove(state.Id);
        response.Changes.Add($"Closed {title} without saving additional changes.");
    }

    private void Delete(DocumentState state, BrokerResponse response)
    {
        if (string.IsNullOrWhiteSpace(state.Document.PathName))
            throw new RequestRejectedException("saved_file_required", "delete_document requires a saved document.");
        var path = WorkspacePolicy.Canonicalize(state.Document.PathName, "document.path");
        if (!File.Exists(path))
            throw new RequestRejectedException("file_not_found", $"The model file does not exist: {path}");

        response.Document = Snapshot(state);
        var title = state.Document.Title;
        if (!state.Document.Close(false))
            throw new InvalidOperationException($"Revit did not close {title}.");
        documents.Remove(state.Id);
        response.Changes.Add($"Closed {title} without saving additional changes.");
        File.Delete(path);
        var check = FileCheck(path, false);
        response.Checks.Add(check);
        if (!check.Passed)
            throw new IOException($"Revit returned from delete, but the file still exists: {path}");
        response.Changes.Add($"Deleted {path}.");
        response.AffectedFiles.Add(path);
    }

    private static bool ApplyModelBatch(DocumentState state, List<ModelChangeRequest> changes, BrokerResponse response)
    {
        ValidateChanges(state.Document, changes);
        response.Document = Snapshot(state);
        var initialChangeCount = response.Changes.Count;
        var initialElementCount = response.AffectedElements.Count;
        var initialViewCount = response.CreatedViews?.Count ?? 0;

        using var transaction = new Transaction(state.Document, "Drive It model batch");
        transaction.Start();
        try
        {
            foreach (var change in changes)
            {
                switch (change.Type)
                {
                    case "create_level":
                        var level = Level.Create(state.Document, change.Elevation!.Value);
                        level.Name = change.Name!;
                        response.AffectedElements.Add(level.Id.Value);
                        response.Changes.Add($"Created level '{level.Name}' ({level.Id.Value}).");
                        break;
                    case "create_wall":
                        var wall = CreateWall(state.Document, change);
                        response.AffectedElements.Add(wall.Id.Value);
                        response.Changes.Add($"Created wall {wall.Id.Value}.");
                        break;
                    case "create_3d_view":
                        var view = Create3DView(state.Document, change);
                        response.AffectedElements.Add(view.Id.Value);
                        (response.CreatedViews ??= new List<ViewSummary>()).Add(new ViewSummary
                        {
                            Id = view.Id.Value.ToString(CultureInfo.InvariantCulture),
                            Name = view.Name,
                            Type = view.ViewType.ToString(),
                        });
                        response.Changes.Add($"Created 3D view '{view.Name}' ({view.Id.Value}).");
                        break;
                    case "create_family_type":
                        var familyType = state.Document.FamilyManager.NewType(change.Name!);
                        response.Changes.Add($"Created family type '{familyType.Name}'.");
                        break;
                    case "delete_element":
                        var deleted = state.Document.Delete(new ElementId(change.ElementId!.Value));
                        foreach (var id in deleted)
                            response.AffectedElements.Add(id.Value);
                        response.Changes.Add($"Deleted element {change.ElementId.Value} and {Math.Max(0, deleted.Count - 1)} dependent element(s).");
                        break;
                    default:
                        throw new InvalidOperationException("Validated model change became unsupported.");
                }
            }

            var status = transaction.Commit();
            if (status != TransactionStatus.Committed)
                throw new InvalidOperationException($"Revit returned transaction status {status}.");
            response.Checks.Add(new CheckReceipt
            {
                Name = "transaction_commit",
                Passed = true,
                Observed = status.ToString(),
            });
            response.Document = Snapshot(state);
            return true;
        }
        catch (Exception exception)
        {
            bool rolledBack;
            string rollbackObservation;
            try
            {
                if (transaction.GetStatus() == TransactionStatus.Started)
                    transaction.RollBack();
                rolledBack = transaction.GetStatus() == TransactionStatus.RolledBack;
                rollbackObservation = transaction.GetStatus().ToString();
            }
            catch (Exception rollbackException)
            {
                rolledBack = false;
                rollbackObservation = rollbackException.Message;
            }

            response.Checks.Add(new CheckReceipt
            {
                Name = "transaction_rollback",
                Passed = rolledBack,
                Observed = rollbackObservation,
            });
            response.Error = new ErrorReceipt
            {
                Code = !rolledBack ? "model_batch_rollback_failed"
                    : exception is RequestRejectedException rejected ? rejected.Code : "model_batch_failed",
                Message = exception.Message,
            };
            if (rolledBack)
            {
                response.Changes.RemoveRange(initialChangeCount, response.Changes.Count - initialChangeCount);
                response.AffectedElements.RemoveRange(initialElementCount, response.AffectedElements.Count - initialElementCount);
                if (response.CreatedViews is not null)
                {
                    response.CreatedViews.RemoveRange(initialViewCount, response.CreatedViews.Count - initialViewCount);
                    if (response.CreatedViews.Count == 0)
                        response.CreatedViews = null;
                }
            }

            response.Status = HasEffects(response) ? "partially_applied" : "failed";
            response.Document = Snapshot(state);
            return false;
        }
    }

    private static Wall CreateWall(Document document, ModelChangeRequest change)
    {
        var level = (Level)document.GetElement(new ElementId(change.BaseLevelId!.Value));
        var wall = Wall.Create(document, Line.CreateBound(ToXyz(change.Start!), ToXyz(change.End!)), level.Id, false);
        var height = wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM);
        if (height is null || height.IsReadOnly)
            throw new InvalidOperationException("The wall height parameter is unavailable or read-only.");
        height.Set(change.Height!.Value);
        return wall;
    }

    private static View3D Create3DView(Document document, ModelChangeRequest change)
    {
        View3D view;
        try
        {
            view = View3D.CreateIsometric(document, ThreeDimensionalViewType(document)!.Id);
        }
        catch (Autodesk.Revit.Exceptions.ArgumentException exception)
        {
            // Revit refuses some families outright, e.g. "3D view creation is not allowed in this family."
            // for annotation families; the batch rolls back with this code.
            throw new RequestRejectedException("view_creation_not_allowed", exception.Message.Split('\r', '\n')[0]);
        }
        if (change.Name is null)
            return view;
        try
        {
            view.Name = change.Name;
        }
        catch (Autodesk.Revit.Exceptions.ApplicationException exception)
        {
            // Revit is the authority on view-name conflicts that validation cannot see.
            throw new RequestRejectedException("duplicate_view_name",
                $"Revit refused the 3D view name '{change.Name}': {exception.Message.Split('\r', '\n')[0]}");
        }
        return view;
    }

    private static ViewFamilyType? ThreeDimensionalViewType(Document document) =>
        new FilteredElementCollector(document).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
            .Where(type => type.ViewFamily == ViewFamily.ThreeDimensional)
            .OrderBy(type => type.Id.Value)
            .FirstOrDefault();

    private static void ValidateChanges(Document document, List<ModelChangeRequest> changes)
    {
        var newViewNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var change in changes)
        {
            switch (change.Type)
            {
                case "create_level":
                    RequireProject(document, change.Type);
                    if (string.IsNullOrWhiteSpace(change.Name) || !double.IsFinite(change.Elevation ?? double.NaN))
                        throw new RequestRejectedException("invalid_model_change", "create_level requires a name and finite elevation.");
                    break;
                case "create_wall":
                    RequireProject(document, change.Type);
                    if (change.BaseLevelId is null or <= 0 || document.GetElement(new ElementId(change.BaseLevelId.Value)) is not Level)
                        throw new RequestRejectedException("invalid_model_change", "create_wall requires the element id of an existing level.");
                    if (change.Start is null || change.End is null || !double.IsFinite(change.Height ?? double.NaN) || change.Height <= 0)
                        throw new RequestRejectedException("invalid_model_change", "create_wall requires start, end, and a positive finite height.");
                    if (!IsFinite(change.Start) || !IsFinite(change.End) || ToXyz(change.Start).DistanceTo(ToXyz(change.End)) < 1e-9)
                        throw new RequestRejectedException("invalid_model_change", "create_wall requires finite, distinct endpoints.");
                    break;
                case "create_3d_view":
                    if (change.Name is not null && string.IsNullOrWhiteSpace(change.Name))
                        throw new RequestRejectedException("invalid_model_change", "create_3d_view name must not be empty; omit it to let Revit name the view.");
                    if (change.Name is not null && !NamingUtils.IsValidName(change.Name))
                        throw new RequestRejectedException("invalid_model_change",
                            $"create_3d_view name '{change.Name}' contains a character Revit does not allow in names: \\ : {{ }} [ ] | ; < > ? ` ~");
                    if (ThreeDimensionalViewType(document) is null)
                        throw new RequestRejectedException("view_type_not_found",
                            $"This {DocumentKind(document)} document has no 3D view family type, so a 3D view cannot be created.");
                    if (change.Name is not null && (!newViewNames.Add(change.Name) ||
                        new FilteredElementCollector(document).OfClass(typeof(View3D)).Cast<View3D>()
                            .Any(view => !view.IsTemplate && view.Name == change.Name)))
                        throw new RequestRejectedException("duplicate_view_name", $"A 3D view named '{change.Name}' already exists or is created earlier in this batch.");
                    break;
                case "create_family_type":
                    if (!document.IsFamilyDocument)
                        throw new RequestRejectedException("wrong_document_kind", "create_family_type requires an RFA document.");
                    if (string.IsNullOrWhiteSpace(change.Name))
                        throw new RequestRejectedException("invalid_model_change", "create_family_type requires a name.");
                    if (document.FamilyManager.Types.Cast<FamilyType>().Any(type => type.Name == change.Name))
                        throw new RequestRejectedException("duplicate_family_type", $"Family type '{change.Name}' already exists.");
                    break;
                case "delete_element":
                    if (change.ElementId is null or <= 0 || document.GetElement(new ElementId(change.ElementId.Value)) is null)
                        throw new RequestRejectedException("invalid_model_change", "delete_element requires the element id of an existing element.");
                    break;
                default:
                    throw new RequestRejectedException("unsupported_model_change", $"Unsupported model change '{change.Type}'.");
            }
        }
    }

    private DocumentState? TryResolveInitial(UIApplication application, DocumentTarget? target)
    {
        if (target is null)
            return null;
        if (!string.IsNullOrWhiteSpace(target.UniqueId))
            return Resolve(application, target);
        if (string.IsNullOrWhiteSpace(target.Path))
            return null;

        var path = WorkspacePolicy.Canonicalize(target.Path, "document.path");
        var document = OpenDocuments(application).FirstOrDefault(candidate => PathsEqual(candidate.PathName, path));
        return document is null ? null : Register(document);
    }

    private DocumentState Resolve(UIApplication application, DocumentTarget? target)
    {
        if (target is null || string.IsNullOrWhiteSpace(target.UniqueId))
            throw new RequestRejectedException("document_identity_required", "A broker-issued document.uniqueId is required for this operation.");
        if (!documents.TryGetValue(target.UniqueId, out var state))
            throw new RequestRejectedException("stale_document_identity", "The selected document identity is no longer open in this Revit session.");
        var matches = OpenDocuments(application).Where(document => SameDocument(state.Document, document)).ToList();
        if (matches.Count == 0)
            throw new RequestRejectedException("stale_document_identity", "The selected document identity is no longer open in this Revit session.");
        if (matches.Count > 1)
            throw new RequestRejectedException("ambiguous_document_identity", "More than one open document matches the selected identity.");
        state.Document = matches[0];
        if (!string.IsNullOrWhiteSpace(target.Path))
        {
            var path = WorkspacePolicy.Canonicalize(target.Path, "document.path");
            if (!PathsEqual(state.Document.PathName, path))
                throw new RequestRejectedException("document_identity_mismatch", "The supplied path does not match the selected document identity.");
        }
        return state;
    }

    private static DocumentState RequireDocument(DocumentState? state) => state ??
        throw new RequestRejectedException("document_not_open", "The requested operation requires an open selected document, and this script has none. Call revit.get_active_document() first to use the model open in Revit's window, or pass document= with a uniqueId from an earlier receipt.");

    private DocumentState Register(Document document, bool created = false)
    {
        if (!created)
        {
            var matches = documents.Values.Where(state => SameDocument(state.Document, document)).ToList();
            if (matches.Count > 1)
                throw new RequestRejectedException("ambiguous_document_identity", "More than one registered document matches this Revit document.");
            if (matches.Count == 1)
            {
                matches[0].Document = document;
                return matches[0];
            }
        }

        var state = new DocumentState(Guid.NewGuid().ToString("N"), document);
        documents.Add(state.Id, state);
        return state;
    }

    private static DocumentReceipt Snapshot(DocumentState state) => Snapshot<DocumentReceipt>(state);

    private static T Snapshot<T>(DocumentState state) where T : DocumentReceipt, new()
    {
        var document = state.Document;
        var receipt = new T
        {
            UniqueId = state.Id,
            Title = document.Title,
            Path = string.IsNullOrWhiteSpace(document.PathName) ? null : WorkspacePolicy.Canonicalize(document.PathName, "document.path"),
            Kind = DocumentKind(document),
            IsReadOnly = document.IsReadOnly,
        };
        if (document.IsFamilyDocument)
        {
            receipt.FamilyTypes = document.FamilyManager.Types.Cast<FamilyType>().Select(type => type.Name).Order().ToList();
        }
        else
        {
            receipt.WallCount = new FilteredElementCollector(document).OfClass(typeof(Wall)).GetElementCount();
            receipt.Levels = new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>()
                .Select(level => new LevelReceipt { Id = level.Id.Value, Name = level.Name, Elevation = level.Elevation })
                .OrderBy(level => level.Id).ToList();
        }
        return receipt;
    }

    private static List<PolicyPathGrant> OutsideRootRequests(string root, List<PreparedOperation> operations)
    {
        return operations
            .SelectMany(operation => operation.PolicyPaths
                .Where(path => !WorkspacePolicy.IsInside(root, path))
                .Select(path => new { operation.Type, Path = WorkspacePolicy.Canonicalize(path, "operation.path") }))
            .GroupBy(item => item.Type)
            .Select(group => new PolicyPathGrant
            {
                Operation = group.Key,
                Paths = group.Select(item => item.Path).Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
            }).ToList();
    }

    private static bool AllCovered(OutsideRootApproval? approval, List<PolicyPathGrant> requests)
    {
        return requests.All(request => request.Paths.All(path => WorkspacePolicy.IsCovered(approval, request.Operation, path)));
    }

    private static bool HasEffects(BrokerResponse response) =>
        response.Changes.Count > 0 || response.AffectedFiles.Count > 0 || response.AffectedElements.Count > 0;

    private static bool IsModelChange(string type) =>
        type is "create_level" or "create_wall" or "create_3d_view" or "create_family_type" or "delete_element";

    private static T Deserialize<T>(System.Text.Json.Nodes.JsonObject? arguments)
    {
        try
        {
            return (arguments ?? new System.Text.Json.Nodes.JsonObject()).Deserialize<T>(ArgumentJsonOptions) ??
                throw new RequestRejectedException("invalid_arguments", "Operation arguments must be a JSON object.");
        }
        catch (JsonException exception)
        {
            throw new RequestRejectedException("invalid_arguments", exception.Message);
        }
    }

    private static string DocumentKind(Document document) => document.IsFamilyDocument ? "rfa" : "rvt";

    private static IEnumerable<Document> OpenDocuments(UIApplication application)
    {
        foreach (Document document in application.Application.Documents)
            yield return document;
    }

    private static bool SameDocument(Document expected, Document candidate)
    {
        if (ReferenceEquals(expected, candidate))
            return true;
        try
        {
            if (expected.Title != candidate.Title || DocumentKind(expected) != DocumentKind(candidate))
                return false;
            if (string.IsNullOrWhiteSpace(expected.PathName) || string.IsNullOrWhiteSpace(candidate.PathName))
                return string.IsNullOrWhiteSpace(expected.PathName) && string.IsNullOrWhiteSpace(candidate.PathName);
            return PathsEqual(expected.PathName, WorkspacePolicy.Canonicalize(candidate.PathName, "document.path"));
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static string? CanonicalDocumentPath(Document document) => string.IsNullOrWhiteSpace(document.PathName)
        ? null
        : WorkspacePolicy.Canonicalize(document.PathName, "document.path");

    private static CheckReceipt IdentityCheck(DocumentState state) => new()
    {
        Name = "document_identity",
        Passed = !string.IsNullOrEmpty(state.Id),
        Observed = state.Id,
    };

    private static CheckReceipt FileCheck(string path, bool shouldExist) => new()
    {
        Name = shouldExist ? "file_saved" : "file_deleted",
        Passed = File.Exists(path) == shouldExist,
        Observed = File.Exists(path) ? path : $"Absent: {path}",
    };

    private static void RequireProject(Document document, string changeType)
    {
        if (document.IsFamilyDocument)
            throw new RequestRejectedException("wrong_document_kind", $"{changeType} requires an RVT document.");
    }

    private static string ExpectedKind(string? requestedKind, string path)
    {
        if (requestedKind is not null and not ("rvt" or "rfa"))
            throw new RequestRejectedException("invalid_document_kind", "Document kind must be 'rvt' or 'rfa'.");
        return requestedKind ?? (string.Equals(Path.GetExtension(path), ".rfa", StringComparison.OrdinalIgnoreCase) ? "rfa" : "rvt");
    }

    private static void ValidateExtension(string path, string kind)
    {
        var expected = kind == "rvt" ? ".rvt" : ".rfa";
        if (!string.Equals(Path.GetExtension(path), expected, StringComparison.OrdinalIgnoreCase))
            throw new RequestRejectedException("invalid_document_kind", $"A {kind} operation requires a {expected} path.");
    }

    private static bool PathsEqual(string? left, string right)
    {
        if (string.IsNullOrWhiteSpace(left))
            return false;
        return string.Equals(WorkspacePolicy.Canonicalize(left, "document.path"), right, StringComparison.OrdinalIgnoreCase);
    }

    private static XYZ ToXyz(PointRequest point) => new(point.X, point.Y, point.Z);

    private static bool IsFinite(PointRequest point) =>
        double.IsFinite(point.X) && double.IsFinite(point.Y) && double.IsFinite(point.Z);

    private sealed class PreparedOperation(string type)
    {
        public string Type { get; } = type;
        public DocumentOperationArguments DocumentArguments { get; set; } = new();
        public ModelChangeRequest? ModelChange { get; set; }
        /// <summary>The parsed, bounded arguments of a query or selection operation.</summary>
        public object? Query { get; set; }
        public List<string> PolicyPaths { get; } = [];
    }

    private sealed class DocumentState(string id, Document document)
    {
        public string Id { get; } = id;
        public Document Document { get; set; } = document;
    }
}
