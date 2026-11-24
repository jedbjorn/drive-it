using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace DriveIt.Revit.Broker;

/// <summary>
/// Built-in primitives that read the model or the UI selection (spec #9 Phase A). They carry no
/// policy paths and start no transaction. Reads put their output in the response's results array;
/// get_active_document and set_selection answer with the document and receipt lines instead.
/// </summary>
public sealed partial class DocumentDispatcher
{
    private const int DefaultPageLimit = 200;
    private const int MaximumPageLimit = 2000;
    private const int MaximumElementIds = 2000;
    private const int MaximumCategorySuggestions = 20;

    private static bool IsQuery(string type) =>
        type is "get_active_document" or "find_elements" or "get_parameters" or "list_types" or "list_views"
            or "get_selection" or "set_selection";

    /// <summary>Parses and bounds query arguments before any Revit call; a limit is rejected, never truncated.</summary>
    private static object PrepareQuery(TypedOperation operation)
    {
        switch (operation.Type)
        {
            case "find_elements":
                var find = Deserialize<FindElementsArguments>(operation.Arguments);
                RequireCategoryName(find.Category, operation.Type);
                find.Kind ??= "instance";
                if (find.Kind is not ("instance" or "type"))
                    throw new RequestRejectedException("invalid_arguments", "find_elements kind must be 'instance' or 'type'.");
                if (find.LevelId is not null && find.Kind == "type")
                    throw new RequestRejectedException("invalid_arguments", "find_elements levelId filters instances; it cannot be combined with kind 'type'.");
                if (find.LevelId is <= 0)
                    throw new RequestRejectedException("invalid_arguments", "find_elements levelId must be a positive element id.");
                find.Limit ??= DefaultPageLimit;
                find.Offset ??= 0;
                if (find.Limit > MaximumPageLimit)
                    throw new RequestRejectedException("limit_exceeded", $"find_elements limit is {find.Limit}; the maximum is {MaximumPageLimit}. Page with offset instead.");
                if (find.Limit < 1 || find.Offset < 0)
                    throw new RequestRejectedException("invalid_arguments", "find_elements limit must be at least 1 and offset at least 0.");
                return find;
            case "get_parameters":
                var parameters = Deserialize<GetParametersArguments>(operation.Arguments);
                parameters.ElementIds = RequireElementIds(parameters.ElementIds, operation.Type);
                return parameters;
            case "list_types":
                var types = Deserialize<ListTypesArguments>(operation.Arguments);
                RequireCategoryName(types.Category, operation.Type);
                return types;
            case "list_views":
                var views = Deserialize<ListViewsArguments>(operation.Arguments);
                ParseViewTypes(views.ViewTypes);
                return views;
            case "set_selection":
                var selection = Deserialize<SetSelectionArguments>(operation.Arguments);
                selection.ElementIds = RequireElementIds(selection.ElementIds, operation.Type);
                return selection;
            default:
                return Deserialize<NoArguments>(operation.Arguments);
        }
    }

    private DocumentState ExecuteQuery(UIApplication application, PreparedOperation operation, DocumentState? current,
        BrokerResponse response, int index)
    {
        if (operation.Type == "get_active_document")
            return ActiveDocument(application, response);

        var state = RequireDocument(current);
        var document = state.Document;
        JsonNode? output = operation.Query switch
        {
            FindElementsArguments find => FindElements(document, find),
            GetParametersArguments parameters => GetParameters(document, parameters),
            ListTypesArguments types => ListTypes(document, types),
            ListViewsArguments views => ListViewEntries(document, views),
            SetSelectionArguments selection => SetSelection(application, state, selection, response),
            _ => GetSelection(application, state),
        };
        response.Document ??= IdentitySnapshot(state);
        response.Results![index] = output;
        return state;
    }

    /// <summary>
    /// The document shown in Revit's window, registered so later operations can target it, plus
    /// every open, non-linked document (each registered too). Changes nothing in Revit.
    /// </summary>
    private DocumentState ActiveDocument(UIApplication application, BrokerResponse response)
    {
        var open = OpenDocuments(application).Where(document => !document.IsLinked)
            .Select(document => (Document: document, State: Register(document))).ToList();
        var active = application.ActiveUIDocument?.Document;
        if (active is null || active.IsLinked)
        {
            var listed = open.Count == 0 ? "No document is open."
                : $"Open documents: {string.Join(", ", open.Select(item => $"'{item.Document.Title}' uniqueId {item.State.Id}"))}; pass document {{\"uniqueId\": ...}} to target one.";
            throw new RequestRejectedException("no_active_document", $"No document is active in Revit's window. {listed}");
        }

        var state = Register(active);
        var receipt = Snapshot<ActiveDocumentReceipt>(state);
        receipt.IsModified = active.IsModified;
        var view = active.ActiveView;
        receipt.ActiveView = view is null ? null : new JsonObject
        {
            ["id"] = view.Id.Value,
            ["name"] = view.Name,
            ["viewType"] = view.ViewType.ToString(),
        };
        receipt.OpenDocuments = open.Select(item => new OpenDocumentReceipt
        {
            UniqueId = item.State.Id,
            Title = item.Document.Title,
            Path = CanonicalDocumentPath(item.Document),
            Kind = DocumentKind(item.Document),
            IsActive = item.Document.Equals(active),
        }).ToList();
        response.Document = receipt;
        response.Checks.Add(IdentityCheck(state));
        return state;
    }

    private static JsonObject FindElements(Document document, FindElementsArguments arguments)
    {
        var category = ResolveCategory(document, arguments.Category!);
        var types = arguments.Kind == "type";
        var collector = new FilteredElementCollector(document).OfCategoryId(category.Id);
        IEnumerable<Element> elements = types ? collector.WhereElementIsElementType() : collector.WhereElementIsNotElementType();
        if (arguments.LevelId is { } levelId)
            elements = elements.Where(element => element.LevelId.Value == levelId);
        if (arguments.TypeName is { } typeName)
            elements = elements.Where(element => TypeOf(document, element, types)?.Name == typeName);
        var matches = elements.OrderBy(element => element.Id.Value).ToList();
        var offset = arguments.Offset!.Value;
        var page = matches.Skip(offset).Take(arguments.Limit!.Value)
            .Select(element => (JsonNode)ElementSummary(document, element, types)).ToArray();
        return new JsonObject
        {
            ["total"] = matches.Count,
            ["returned"] = page.Length,
            ["offset"] = offset,
            ["truncated"] = offset + page.Length < matches.Count,
            ["elements"] = new JsonArray(page),
        };
    }

    private static JsonObject ElementSummary(Document document, Element element, bool isType)
    {
        var type = TypeOf(document, element, isType);
        return new JsonObject
        {
            ["id"] = element.Id.Value,
            ["uniqueId"] = element.UniqueId,
            ["name"] = element.Name,
            ["category"] = element.Category?.Name,
            ["builtInCategory"] = BuiltInCategoryName(element.Category),
            ["typeId"] = isType ? null : OptionalId(element.GetTypeId()),
            ["typeName"] = type?.Name,
            ["familyName"] = NullIfEmpty(type?.FamilyName),
            ["familyId"] = OptionalId((type as FamilySymbol)?.Family?.Id),
            ["levelId"] = OptionalId(element.LevelId),
        };
    }

    private static JsonArray GetParameters(Document document, GetParametersArguments arguments)
    {
        var elements = RequireElements(document, arguments.ElementIds!);
        var names = arguments.Names is null ? null : new HashSet<string>(arguments.Names, StringComparer.Ordinal);
        var includeType = arguments.IncludeType ?? true;
        var result = new JsonArray();
        foreach (var element in elements)
        {
            var typeId = element.GetTypeId();
            var type = includeType ? TypeOf(document, element, false) : null;
            result.Add(new JsonObject
            {
                ["id"] = element.Id.Value,
                ["uniqueId"] = element.UniqueId,
                ["typeId"] = OptionalId(typeId),
                ["parameters"] = ParameterEntries(element, names),
                ["type"] = type is null ? null : new JsonObject
                {
                    ["id"] = type.Id.Value,
                    ["parameters"] = ParameterEntries(type, names),
                },
            });
        }
        return result;
    }

    private static JsonArray ParameterEntries(Element element, HashSet<string>? names)
    {
        var parameters = element.Parameters.Cast<Parameter>()
            .Where(parameter => parameter.Definition is not null && (names is null || names.Contains(parameter.Definition.Name)))
            .OrderBy(parameter => parameter.Definition.Name, StringComparer.Ordinal)
            .ThenBy(parameter => parameter.Id.Value)
            .Select(parameter => (JsonNode)ParameterEntry(parameter)).ToArray();
        return new JsonArray(parameters);
    }

    private static JsonObject ParameterEntry(Parameter parameter)
    {
        var builtIn = (parameter.Definition as InternalDefinition)?.BuiltInParameter ?? BuiltInParameter.INVALID;
        JsonNode? value = parameter.StorageType switch
        {
            StorageType.Double => double.IsFinite(parameter.AsDouble()) ? parameter.AsDouble() : null,
            StorageType.Integer => parameter.AsInteger(),
            StorageType.String => parameter.AsString(),
            StorageType.ElementId => parameter.AsElementId().Value,
            _ => null,
        };
        return new JsonObject
        {
            ["name"] = parameter.Definition.Name,
            ["builtIn"] = builtIn == BuiltInParameter.INVALID ? null : builtIn.ToString(),
            ["guid"] = parameter.IsShared ? parameter.GUID.ToString() : null,
            ["storageType"] = parameter.StorageType.ToString(),
            ["value"] = value,
            ["display"] = parameter.AsValueString(),
            ["readOnly"] = parameter.IsReadOnly,
            ["hasValue"] = parameter.HasValue,
        };
    }

    private static JsonArray ListTypes(Document document, ListTypesArguments arguments)
    {
        var category = ResolveCategory(document, arguments.Category!);
        var types = new FilteredElementCollector(document).OfCategoryId(category.Id).WhereElementIsElementType()
            .Cast<Element>()
            .Select(element => (Element: element, Type: element as ElementType))
            .OrderBy(item => item.Type?.FamilyName ?? "", StringComparer.OrdinalIgnoreCase)
            .ThenBy(item => item.Element.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(item => item.Element.Id.Value)
            .Select(item => (JsonNode)new JsonObject
            {
                ["id"] = item.Element.Id.Value,
                ["uniqueId"] = item.Element.UniqueId,
                ["name"] = item.Element.Name,
                ["familyName"] = NullIfEmpty(item.Type?.FamilyName),
                ["familyId"] = OptionalId((item.Element as FamilySymbol)?.Family?.Id),
                ["category"] = item.Element.Category?.Name,
            }).ToArray();
        return new JsonArray(types);
    }

    private static JsonArray ListViewEntries(Document document, ListViewsArguments arguments)
    {
        var wanted = ParseViewTypes(arguments.ViewTypes);
        var includeSheets = arguments.IncludeSheets ?? true;
        var includeTemplates = arguments.IncludeTemplates ?? false;
        var views = new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>()
            .Where(view => view.ViewType is not (ViewType.Internal or ViewType.ProjectBrowser
                or ViewType.SystemBrowser or ViewType.Undefined))
            .Where(view => includeTemplates || !view.IsTemplate)
            .Where(view => includeSheets || view.ViewType != ViewType.DrawingSheet)
            .Where(view => wanted is null || wanted.Contains(view.ViewType))
            .OrderBy(view => view.Id.Value)
            .Select(view => (JsonNode)new JsonObject
            {
                ["id"] = view.Id.Value,
                ["uniqueId"] = view.UniqueId,
                ["name"] = view.Name,
                ["viewType"] = view.ViewType.ToString(),
                ["isTemplate"] = view.IsTemplate,
                ["sheetNumber"] = (view as ViewSheet)?.SheetNumber,
                ["levelId"] = OptionalId(view.GenLevel?.Id),
                // The same test capture_revit_view applies, so an entry marked capturable can be captured.
                ["capturable"] = !view.IsTemplate && CapturableViewTypes.Contains(view.ViewType) && view.CanBePrinted,
            }).ToArray();
        return new JsonArray(views);
    }

    private static JsonArray GetSelection(UIApplication application, DocumentState state)
    {
        var selection = RequireActive(application, state, "get_selection").Selection;
        var document = state.Document;
        var entries = selection.GetElementIds().OrderBy(id => id.Value)
            .Select(id => document.GetElement(id))
            .OfType<Element>()
            .Select(element => (JsonNode)new JsonObject
            {
                ["id"] = element.Id.Value,
                ["uniqueId"] = element.UniqueId,
                ["name"] = element.Name,
                ["category"] = element.Category?.Name,
                ["typeName"] = TypeOf(document, element, false)?.Name,
            }).ToArray();
        return new JsonArray(entries);
    }

    /// <summary>
    /// Replaces the active document's UI selection. No transaction, no document change, no undo
    /// entry, and no zoom or view change; nothing is changed when validation fails.
    /// </summary>
    private static JsonNode? SetSelection(UIApplication application, DocumentState state, SetSelectionArguments arguments,
        BrokerResponse response)
    {
        var uiDocument = RequireActive(application, state, "set_selection");
        var elements = RequireElements(state.Document, arguments.ElementIds!);
        var requested = elements.Select(element => element.Id.Value).ToHashSet();
        uiDocument.Selection.SetElementIds(elements.Select(element => element.Id).ToList());
        var observed = uiDocument.Selection.GetElementIds().Select(id => id.Value).ToHashSet();
        response.Changes.Add($"Selected {requested.Count} element(s) in {state.Document.Title}.");
        response.Checks.Add(new CheckReceipt
        {
            Name = "selection_readback",
            Passed = observed.SetEquals(requested),
            Observed = observed.Count == 0 ? "No elements selected."
                : $"Selected: {string.Join(", ", observed.Order().Select(id => id.ToString(CultureInfo.InvariantCulture)))}.",
        });
        return null;
    }

    private static UIDocument RequireActive(UIApplication application, DocumentState state, string operation)
    {
        var uiDocument = application.ActiveUIDocument;
        if (uiDocument is null || !uiDocument.Document.Equals(state.Document))
            throw new RequestRejectedException("document_not_active",
                $"{operation} needs the active document, and '{state.Document.Title}' is not the document shown in Revit's window; Revit keeps a selection only for that document. Call revit.get_active_document() to target it.");
        return uiDocument;
    }

    /// <summary>Distinct ids in request order; at most MaximumElementIds, each a positive integer.</summary>
    private static List<long> RequireElementIds(List<long>? ids, string operation)
    {
        if (ids is null)
            throw new RequestRejectedException("invalid_arguments", $"{operation} requires elementIds, a list of element ids.");
        if (ids.Count > MaximumElementIds)
            throw new RequestRejectedException("limit_exceeded", $"{operation} received {ids.Count} element ids; the maximum is {MaximumElementIds} per call.");
        if (ids.Any(id => id <= 0))
            throw new RequestRejectedException("invalid_arguments", $"{operation} elementIds must be positive element ids.");
        return ids.Distinct().ToList();
    }

    /// <summary>Every requested element, or element_not_found naming each missing id; never a partial result.</summary>
    private static List<Element> RequireElements(Document document, List<long> ids)
    {
        var elements = ids.Select(id => (Id: id, Element: document.GetElement(new ElementId(id)))).ToList();
        var missing = elements.Where(item => item.Element is null).Select(item => item.Id).ToList();
        if (missing.Count > 0)
            throw new RequestRejectedException("element_not_found",
                $"No element exists in '{document.Title}' with id {string.Join(", ", missing.Select(id => id.ToString(CultureInfo.InvariantCulture)))}.");
        return elements.Select(item => item.Element).ToList();
    }

    private static void RequireCategoryName(string? category, string operation)
    {
        if (string.IsNullOrWhiteSpace(category))
            throw new RequestRejectedException("invalid_arguments", $"{operation} requires a category, such as \"Walls\" or \"OST_Walls\".");
    }

    /// <summary>A BuiltInCategory member name ("OST_Walls") or a category name as this document shows it ("Walls").</summary>
    private static Category ResolveCategory(Document document, string name)
    {
        var categories = document.Settings.Categories.Cast<Category>().ToList();
        if (name.StartsWith("OST_", StringComparison.Ordinal))
        {
            if (Enum.TryParse<BuiltInCategory>(name, false, out var builtIn) && Enum.IsDefined(builtIn)
                && Category.GetCategory(document, builtIn) is { } category)
                return category;
        }
        else if ((categories.FirstOrDefault(category => category.Name == name)
                  ?? categories.FirstOrDefault(category => string.Equals(category.Name, name, StringComparison.OrdinalIgnoreCase)))
                 is { } named)
        {
            return named;
        }

        var wanted = (name.StartsWith("OST_", StringComparison.Ordinal) ? name[4..] : name).ToLowerInvariant();
        var closest = categories.Select(category => category.Name).Distinct(StringComparer.Ordinal)
            .OrderBy(candidate => EditDistance(wanted, candidate.ToLowerInvariant()))
            .ThenBy(candidate => candidate, StringComparer.Ordinal)
            .Take(MaximumCategorySuggestions);
        throw new RequestRejectedException("unknown_category",
            $"'{name}' is not a category in '{document.Title}'. Closest category names: {string.Join(", ", closest)}.");
    }

    private static int EditDistance(string left, string right)
    {
        var previous = Enumerable.Range(0, right.Length + 1).ToArray();
        for (var i = 1; i <= left.Length; i++)
        {
            var current = new int[right.Length + 1];
            current[0] = i;
            for (var j = 1; j <= right.Length; j++)
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1),
                    previous[j - 1] + (left[i - 1] == right[j - 1] ? 0 : 1));
            previous = current;
        }
        return previous[right.Length];
    }

    /// <summary>ViewType member names, or null for every type.</summary>
    private static HashSet<ViewType>? ParseViewTypes(List<string>? names)
    {
        if (names is null)
            return null;
        var types = new HashSet<ViewType>();
        foreach (var name in names)
        {
            if (string.IsNullOrEmpty(name) || !char.IsLetter(name[0])
                || !Enum.TryParse<ViewType>(name, false, out var type) || !Enum.IsDefined(type))
                throw new RequestRejectedException("invalid_arguments",
                    $"list_views viewTypes holds '{name}', which is not a Revit ViewType. Valid names: {string.Join(", ", Enum.GetNames<ViewType>())}.");
            types.Add(type);
        }
        return types;
    }

    /// <summary>The element itself when it is a type; otherwise the type it uses, if any.</summary>
    private static ElementType? TypeOf(Document document, Element element, bool isType) =>
        isType ? element as ElementType : document.GetElement(element.GetTypeId()) as ElementType;

    private static string? BuiltInCategoryName(Category? category) =>
        category is null || category.BuiltInCategory == BuiltInCategory.INVALID ? null : category.BuiltInCategory.ToString();

    private static long? OptionalId(ElementId? id) =>
        id is null || id == ElementId.InvalidElementId ? null : id.Value;

    private static string? NullIfEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;
}
