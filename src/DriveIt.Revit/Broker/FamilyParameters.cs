using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;

namespace DriveIt.Revit.Broker;

/// <summary>
/// Family primitives (spec #9 Phase C). get_family_parameters reads every family parameter per type
/// without changing CurrentType. set_family_parameters is a model change in the shared transaction:
/// validated before it starts, it sets values per type, reads each back, and restores the original
/// CurrentType before commit. edit_family opens a project's loadable family as the script's target
/// without modifying the project.
/// </summary>
public sealed partial class DocumentDispatcher
{
    private static JsonObject GetFamilyParameters(Document document)
    {
        RequireFamily(document, "get_family_parameters");
        var manager = document.FamilyManager;
        var types = FamilyTypes(manager);
        var parameters = manager.Parameters.Cast<FamilyParameter>()
            .OrderBy(parameter => parameter.Definition.Name, StringComparer.Ordinal)
            .ThenBy(parameter => parameter.Id.Value)
            .Select(parameter =>
            {
                var values = new JsonObject();
                foreach (var type in types)
                    values[type.Name] = new JsonObject
                    {
                        ["value"] = FamilyValue(type, parameter),
                        ["display"] = type.AsValueString(parameter),
                    };
                return (JsonNode)new JsonObject
                {
                    ["name"] = parameter.Definition.Name,
                    ["builtIn"] = BuiltInName(parameter.Definition),
                    ["guid"] = parameter.IsShared ? parameter.GUID.ToString() : null,
                    ["isInstance"] = parameter.IsInstance,
                    ["isShared"] = parameter.IsShared,
                    ["isReporting"] = parameter.IsReporting,
                    ["storageType"] = parameter.StorageType.ToString(),
                    ["formula"] = NullIfEmpty(parameter.Formula),
                    ["values"] = values,
                };
            }).ToArray();
        return new JsonObject
        {
            ["types"] = new JsonArray(types.Select(type => (JsonNode?)type.Name).ToArray()),
            ["currentType"] = manager.CurrentType?.Name,
            ["parameters"] = new JsonArray(parameters),
        };
    }

    /// <summary>Rejects the whole call before the transaction when any entry cannot be applied as asked.</summary>
    /// <param name="newTypes">Family types that create_family_type adds earlier in the same batch.</param>
    private static void ValidateFamilyParameterChanges(Document document, ModelChangeRequest change, IReadOnlySet<string> newTypes)
    {
        RequireFamily(document, change.Type);
        if (change.FamilyChanges is not { Count: > 0 } entries)
            throw new RequestRejectedException("invalid_arguments",
                "set_family_parameters requires changes, a non-empty list of {parameter, type | allTypes, value | valueString | formula}.");
        var manager = document.FamilyManager;
        var typeNames = FamilyTypes(manager).Select(type => type.Name).Concat(newTypes).ToHashSet(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            RequireFamilyEntryShape(entry);
            if (entry.Type is { } typeName && !typeNames.Contains(typeName))
                throw new RequestRejectedException("family_type_not_found",
                    $"'{document.Title}' has no family type named '{typeName}'. Types: {DescribeTypes(typeNames)}.");
            if (entry.AllTypes == true && typeNames.Count == 0)
                throw new RequestRejectedException("family_type_not_found",
                    $"'{document.Title}' has no family types, so allTypes sets nothing; create one with create_family_type first.");

            var parameter = manager.get_Parameter(entry.Parameter!)
                ?? throw new RequestRejectedException("parameter_not_found", $"'{document.Title}' has no family parameter named '{entry.Parameter}'.");
            if (entry.Formula is not null)
                continue;
            var name = parameter.Definition.Name;
            if (parameter.IsDeterminedByFormula)
                throw new RequestRejectedException("parameter_has_formula",
                    $"Family parameter '{name}' is driven by the formula '{parameter.Formula}', so it takes no value; change the formula, or clear it with formula \"\" in an earlier call.");
            if (parameter.IsReadOnly)
                throw new RequestRejectedException("parameter_read_only", $"Family parameter '{name}' is read-only.");
            if (ValueMismatch(document, parameter.Definition, parameter.StorageType, $"Family parameter '{name}'", entry.Value, entry.ValueString)
                is { } mismatch)
                throw new RequestRejectedException("value_type_mismatch", mismatch);
        }
    }

    /// <summary>
    /// Sets each entry for its types, reads each back, and names it in the receipt, then restores the
    /// CurrentType the family had before the call. Runs inside the model transaction.
    /// </summary>
    private static void ApplyFamilyParameterChanges(Document document, ModelChangeRequest change, BrokerResponse response)
    {
        var manager = document.FamilyManager;
        var original = manager.CurrentType;
        foreach (var entry in change.FamilyChanges!)
        {
            var parameter = manager.get_Parameter(entry.Parameter!)!;
            var name = parameter.Definition.Name;
            if (entry.Formula is { } formula)
            {
                // A Revit formula belongs to the parameter, so it drives every type whichever is current.
                if (entry.Type is { } typeName)
                    manager.CurrentType = FamilyTypes(manager).Single(type => type.Name == typeName);
                SetFormula(manager, parameter, formula);
                var formulaCheck = new CheckReceipt
                {
                    Name = "family_parameter_readback",
                    Passed = (parameter.Formula ?? "") == formula,
                    Observed = $"'{name}' formula = {(string.IsNullOrEmpty(parameter.Formula) ? "none" : $"'{parameter.Formula}'")}.",
                };
                response.Checks.Add(formulaCheck);
                if (!formulaCheck.Passed)
                    throw new InvalidOperationException($"The formula of '{name}' read back differently than requested: {formulaCheck.Observed}");
                var scope = entry.Type is { } named
                    ? $"from type '{named}'; a formula applies to every type"
                    : "for all types";
                response.Changes.Add(formula.Length == 0
                    ? $"Cleared the formula of '{name}' {scope}."
                    : $"Set the formula of '{name}' to '{formula}' {scope}.");
                continue;
            }

            List<FamilyType> targets = entry.AllTypes == true
                ? FamilyTypes(manager)
                : [FamilyTypes(manager).Single(type => type.Name == entry.Type)];
            foreach (var type in targets)
            {
                manager.CurrentType = type;
                if (entry.ValueString is { } text)
                    manager.SetValueString(parameter, text);
                else
                    SetFamilyValue(manager, parameter, entry.Value!);

                var check = FamilyReadback(document, type, parameter, entry);
                response.Checks.Add(check);
                if (!check.Passed)
                    throw new InvalidOperationException($"'{name}' for type '{type.Name}' read back a different value than requested: {check.Observed}");
                response.Changes.Add($"Set '{name}' for type '{type.Name}' to {FamilyDisplay(type, parameter)}.");
            }
        }
        if (original is not null)
            manager.CurrentType = original;
    }

    /// <summary>
    /// Opens a loadable family of the project for editing and returns its document state. The family
    /// document is an unsaved, in-memory copy; the project is not modified.
    /// </summary>
    private DocumentState EditFamily(DocumentState project, EditFamilyArguments arguments, BrokerResponse response)
    {
        var document = project.Document;
        if (document.IsFamilyDocument)
            throw new RequestRejectedException("wrong_document_kind", "edit_family requires an RVT document.");
        var id = arguments.FamilyId!.Value;
        var element = document.GetElement(new ElementId(id))
            ?? throw new RequestRejectedException("element_not_found", $"No element exists in '{document.Title}' with id {id}.");
        var refusal = element switch
        {
            not Family => "it is not a family; system families such as walls have none",
            Family { IsInPlace: true } => "it is an in-place family",
            Family { IsEditable: false } => "Revit marks it not editable",
            _ => null,
        };
        if (refusal is not null)
            throw new RequestRejectedException("family_not_editable",
                $"Element {id} ({element.Name}) is not an editable loadable family: {refusal}. Pass a familyId from find_elements or list_types.");
        var family = (Family)element;

        var modifiedBefore = document.IsModified;
        Document familyDocument;
        try
        {
            familyDocument = document.EditFamily(family);
        }
        catch (Autodesk.Revit.Exceptions.ApplicationException exception)
        {
            // Revit is the authority on states validation cannot see, such as a family already open for editing.
            throw new RequestRejectedException("family_not_editable",
                $"Revit refused to open family '{family.Name}' for editing: {exception.Message.Split('\r', '\n')[0]}");
        }

        var state = Register(familyDocument);
        response.Document = Snapshot(state);
        response.Changes.Add($"Opened family {family.Name} for editing.");
        response.Checks.Add(IdentityCheck(state));
        response.Checks.Add(new CheckReceipt
        {
            Name = "project_unmodified",
            Passed = document.IsModified == modifiedBefore,
            Observed = $"'{document.Title}' IsModified {modifiedBefore} before and {document.IsModified} after.",
        });
        return state;
    }

    private static void RequireFamilyEntryShape(FamilyParameterChange entry)
    {
        if (entry is null || string.IsNullOrEmpty(entry.Parameter))
            throw new RequestRejectedException("invalid_arguments", "Every set_family_parameters change requires parameter, a family parameter name.");
        if (entry.AllTypes == false)
            throw new RequestRejectedException("invalid_arguments",
                $"set_family_parameters change for '{entry.Parameter}' has allTypes false; pass allTypes true or a type name.");
        if ((entry.Type is null) == (entry.AllTypes is null))
            throw new RequestRejectedException("invalid_arguments",
                $"set_family_parameters change for '{entry.Parameter}' needs exactly one of type or allTypes.");
        var values = new object?[] { entry.Value, entry.ValueString, entry.Formula }.Count(value => value is not null);
        if (values != 1)
            throw new RequestRejectedException("invalid_arguments",
                $"set_family_parameters change for '{entry.Parameter}' needs exactly one of value, valueString, or formula; it has {values}.");
    }

    private static void SetFormula(FamilyManager manager, FamilyParameter parameter, string formula)
    {
        try
        {
            manager.SetFormula(parameter, formula.Length == 0 ? null : formula);
        }
        catch (Autodesk.Revit.Exceptions.ApplicationException exception)
        {
            throw new RequestRejectedException("invalid_formula",
                $"Revit rejected the formula '{formula}' for '{parameter.Definition.Name}': {exception.Message.Split('\r', '\n')[0]}");
        }
    }

    private static void SetFamilyValue(FamilyManager manager, FamilyParameter parameter, JsonNode value)
    {
        switch (parameter.StorageType)
        {
            case StorageType.Double when TryDouble(value, out var number):
                manager.Set(parameter, number);
                break;
            case StorageType.Integer when TryInteger(value, out var integer):
                manager.Set(parameter, integer);
                break;
            case StorageType.String:
                manager.Set(parameter, value.GetValue<string>());
                break;
            case StorageType.ElementId when TryLong(value, out var id):
                manager.Set(parameter, new ElementId(id));
                break;
            default:
                throw new InvalidOperationException("Validated family parameter value became unsupported.");
        }
    }

    /// <summary>family_parameter_readback: the type's stored value against the request, as parameter_readback compares.</summary>
    private static CheckReceipt FamilyReadback(Document document, FamilyType type, FamilyParameter parameter, FamilyParameterChange entry)
    {
        bool passed;
        if (entry.ValueString is { } text)
        {
            passed = DisplayMatches(document, parameter.Definition, text, type.AsValueString(parameter));
        }
        else
        {
            var value = entry.Value!;
            passed = parameter.StorageType switch
            {
                StorageType.Double => TryDouble(value, out var number) && type.AsDouble(parameter) is { } stored
                    && Math.Abs(stored - number) <= ParameterReadbackTolerance,
                StorageType.Integer => TryInteger(value, out var integer) && type.AsInteger(parameter) == integer,
                StorageType.String => (type.AsString(parameter) ?? "") == value.GetValue<string>(),
                StorageType.ElementId => TryLong(value, out var id) && type.AsElementId(parameter)?.Value == id,
                _ => false,
            };
        }
        return new CheckReceipt
        {
            Name = "family_parameter_readback",
            Passed = passed,
            Observed = $"Type '{type.Name}' '{parameter.Definition.Name}' = {FamilyDisplay(type, parameter)} (stored {FamilyValue(type, parameter)?.ToJsonString() ?? "none"}).",
        };
    }

    /// <summary>The type's raw value: doubles in Revit internal units, element ids as integers, null when unset.</summary>
    private static JsonNode? FamilyValue(FamilyType type, FamilyParameter parameter)
    {
        if (!type.HasValue(parameter))
            return null;
        return parameter.StorageType switch
        {
            StorageType.Double => type.AsDouble(parameter) is { } number && double.IsFinite(number) ? number : null,
            StorageType.Integer => type.AsInteger(parameter),
            StorageType.String => type.AsString(parameter),
            StorageType.ElementId => type.AsElementId(parameter)?.Value,
            _ => null,
        };
    }

    private static string FamilyDisplay(FamilyType type, FamilyParameter parameter) =>
        type.AsValueString(parameter) is { Length: > 0 } display ? display
        : parameter.StorageType == StorageType.String ? $"'{type.AsString(parameter) ?? ""}'"
        : FamilyValue(type, parameter)?.ToJsonString() ?? "none";

    /// <summary>The family's types in name order.</summary>
    private static List<FamilyType> FamilyTypes(FamilyManager manager) =>
        manager.Types.Cast<FamilyType>().OrderBy(type => type.Name, StringComparer.Ordinal).ToList();

    private static string DescribeTypes(IEnumerable<string> names)
    {
        var listed = names.Order(StringComparer.Ordinal).Select(name => $"'{name}'").ToList();
        return listed.Count == 0 ? "none" : string.Join(", ", listed);
    }

    private static void RequireFamily(Document document, string operation)
    {
        if (!document.IsFamilyDocument)
            throw new RequestRejectedException("wrong_document_kind", $"{operation} requires an RFA document.");
    }
}
