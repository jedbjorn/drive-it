using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;

namespace DriveIt.Revit.Broker;

/// <summary>
/// set_parameters (spec #9 Phase B): a model change in the shared "Drive It model batch"
/// transaction. Every entry is validated before the transaction starts, so a bad entry rejects the
/// whole call with nothing applied; each applied value is read back before commit.
/// </summary>
public sealed partial class DocumentDispatcher
{
    private const double ParameterReadbackTolerance = 1e-9;

    /// <summary>Rejects the whole call before the transaction when any entry cannot be applied as asked.</summary>
    private static void ValidateParameterChanges(Document document, ModelChangeRequest change)
    {
        if (change.Changes is not { Count: > 0 } entries)
            throw new RequestRejectedException("invalid_arguments", "set_parameters requires changes, a non-empty list of {elementId, parameter | builtIn | guid, value | valueString}.");
        foreach (var entry in entries)
            RequireEntryShape(entry);

        var missing = entries.Select(entry => entry.ElementId!.Value).Distinct()
            .Where(id => document.GetElement(new ElementId(id)) is null).ToList();
        if (missing.Count > 0)
            throw new RequestRejectedException("element_not_found",
                $"No element exists in '{document.Title}' with id {string.Join(", ", missing.Select(id => id.ToString(CultureInfo.InvariantCulture)))}.");

        foreach (var entry in entries)
            RequireSettable(document, ResolveParameter(document, entry), entry);
    }

    /// <summary>Sets each entry, reads it back, and names it in the receipt. Runs inside the model transaction.</summary>
    private static void ApplyParameterChanges(Document document, ModelChangeRequest change, BrokerResponse response)
    {
        foreach (var entry in change.Changes!)
        {
            var (element, parameter) = ResolveParameter(document, entry);
            var name = parameter.Definition.Name;
            var applied = entry.ValueString is { } text ? parameter.SetValueString(text) : SetValue(parameter, entry.Value!);
            if (!applied)
                throw new InvalidOperationException($"Revit refused the value for '{name}' on element {element.Id.Value}.");

            var check = Readback(document, parameter, entry, element.Id.Value);
            response.Checks.Add(check);
            if (!check.Passed)
                throw new InvalidOperationException($"'{name}' on element {element.Id.Value} read back a different value than requested: {check.Observed}");
            if (!response.AffectedElements.Contains(element.Id.Value))
                response.AffectedElements.Add(element.Id.Value);
            response.Changes.Add($"Set '{name}' on element {element.Id.Value} ({element.Name}) to {Display(parameter)}.");
        }
    }

    private static void RequireEntryShape(ParameterChange entry)
    {
        if (entry is null || entry.ElementId is null or <= 0)
            throw new RequestRejectedException("invalid_arguments", "Every set_parameters change requires elementId, a positive element id.");
        var identifiers = new[] { entry.Parameter, entry.BuiltIn, entry.Guid }.Count(value => value is not null);
        if (identifiers != 1)
            throw new RequestRejectedException("invalid_arguments",
                $"set_parameters change for element {entry.ElementId} needs exactly one of parameter, builtIn, or guid; it has {identifiers}.");
        if ((entry.Value is null) == (entry.ValueString is null))
            throw new RequestRejectedException("invalid_arguments",
                $"set_parameters change for element {entry.ElementId} needs exactly one of value or valueString.");
    }

    /// <summary>
    /// The one parameter an entry names on its element: by builtIn, by shared-parameter guid, or by
    /// name when exactly one parameter has that name. Never redirects an instance to its type.
    /// </summary>
    private static (Element Element, Parameter Parameter) ResolveParameter(Document document, ParameterChange entry)
    {
        var id = entry.ElementId!.Value;
        var element = document.GetElement(new ElementId(id))
            ?? throw new RequestRejectedException("element_not_found", $"No element exists in '{document.Title}' with id {id}.");

        if (entry.BuiltIn is { } builtInName)
        {
            var parameter = string.IsNullOrEmpty(builtInName) || !char.IsLetter(builtInName[0])
                || !Enum.TryParse<BuiltInParameter>(builtInName, false, out var builtIn) || !Enum.IsDefined(builtIn)
                ? null
                : element.get_Parameter(builtIn);
            return (element, parameter ?? throw new RequestRejectedException("parameter_not_found",
                $"Element {id} has no parameter with builtIn '{builtInName}'."));
        }

        if (entry.Guid is { } guidText)
        {
            if (!Guid.TryParse(guidText, out var guid))
                throw new RequestRejectedException("invalid_arguments", $"set_parameters guid '{guidText}' is not a GUID.");
            return (element, element.get_Parameter(guid) ?? throw new RequestRejectedException("parameter_not_found",
                $"Element {id} has no shared parameter with guid {guid}."));
        }

        var named = element.GetParameters(entry.Parameter!);
        if (named.Count == 0)
            throw new RequestRejectedException("parameter_not_found",
                $"Element {id} has no parameter named '{entry.Parameter}'. Type parameters are set on the type's id (get_parameters returns it as type.id).");
        if (named.Count > 1)
        {
            var candidates = named.Select(parameter =>
                $"builtIn {BuiltInName(parameter) ?? "null"}, guid {(parameter.IsShared ? parameter.GUID.ToString() : "null")}");
            throw new RequestRejectedException("ambiguous_parameter",
                $"Element {id} has {named.Count} parameters named '{entry.Parameter}': [{string.Join("; ", candidates)}]. Pass builtIn or guid to choose one.");
        }
        return (element, named[0]);
    }

    private static void RequireSettable(Document document, (Element Element, Parameter Parameter) target, ParameterChange entry)
    {
        var (element, parameter) = target;
        var name = parameter.Definition.Name;
        var id = element.Id.Value;
        if (parameter.IsReadOnly)
            throw new RequestRejectedException("parameter_read_only", $"'{name}' on element {id} is read-only.");
        if (ValueMismatch(document, parameter.Definition, parameter.StorageType, $"'{name}' on element {id}", entry.Value, entry.ValueString)
            is { } mismatch)
            throw new RequestRejectedException("value_type_mismatch", mismatch);
    }

    /// <summary>
    /// Why value or valueString cannot be stored in a parameter of this storage type, or null when it
    /// can. subject names the parameter in the message, such as "'Comments' on element 7".
    /// </summary>
    private static string? ValueMismatch(Document document, Definition definition, StorageType storageType, string subject,
        JsonNode? value, string? valueString)
    {
        if (valueString is not null)
        {
            var spec = definition.GetDataType();
            if (storageType != StorageType.Double || spec is null || spec.Empty() || !UnitUtils.IsMeasurableSpec(spec))
                return $"{subject} stores {storageType} without display units, so valueString does not apply; pass value.";
            return UnitFormatUtils.TryParse(document.GetUnits(), spec, valueString, out _)
                ? null
                : $"'{valueString}' is not a value of {subject} in this document's units.";
        }

        var expected = storageType switch
        {
            StorageType.Double => TryDouble(value!, out _) ? null : "a number in Revit internal units",
            StorageType.Integer => TryInteger(value!, out _) ? null : "an integer or boolean",
            StorageType.String => value!.GetValueKind() == JsonValueKind.String ? null : "a string",
            StorageType.ElementId => TryLong(value!, out _) ? null : "an integer element id",
            _ => "nothing: it stores no value",
        };
        return expected is null ? null : $"{subject} stores {storageType}, so value must be {expected}; received {value!.ToJsonString()}.";
    }

    /// <summary>A valueString read back: the request parsed and formatted in document units equals the stored display.</summary>
    private static bool DisplayMatches(Document document, Definition definition, string valueString, string? display)
    {
        var units = document.GetUnits();
        var spec = definition.GetDataType();
        return UnitFormatUtils.TryParse(units, spec, valueString, out var requested)
            && UnitFormatUtils.Format(units, spec, requested, false) == display;
    }

    private static bool SetValue(Parameter parameter, JsonNode value) => parameter.StorageType switch
    {
        StorageType.Double => TryDouble(value, out var number) && parameter.Set(number),
        StorageType.Integer => TryInteger(value, out var integer) && parameter.Set(integer),
        StorageType.String => parameter.Set(value.GetValue<string>()),
        StorageType.ElementId => TryLong(value, out var id) && parameter.Set(new ElementId(id)),
        _ => false,
    };

    /// <summary>
    /// parameter_readback: a value compares with the stored value (doubles within 1e-9 internal
    /// units); a valueString compares by display string with the request parsed in document units.
    /// </summary>
    private static CheckReceipt Readback(Document document, Parameter parameter, ParameterChange entry, long elementId)
    {
        bool passed;
        if (entry.ValueString is { } text)
        {
            passed = DisplayMatches(document, parameter.Definition, text, parameter.AsValueString());
        }
        else
        {
            var value = entry.Value!;
            passed = parameter.StorageType switch
            {
                StorageType.Double => TryDouble(value, out var number) && Math.Abs(parameter.AsDouble() - number) <= ParameterReadbackTolerance,
                StorageType.Integer => TryInteger(value, out var integer) && parameter.AsInteger() == integer,
                StorageType.String => (parameter.AsString() ?? "") == value.GetValue<string>(),
                StorageType.ElementId => TryLong(value, out var id) && parameter.AsElementId().Value == id,
                _ => false,
            };
        }
        return new CheckReceipt
        {
            Name = "parameter_readback",
            Passed = passed,
            Observed = $"Element {elementId} '{parameter.Definition.Name}' = {Display(parameter)} (stored {StoredValue(parameter)}).",
        };
    }

    private static string Display(Parameter parameter) =>
        parameter.AsValueString() is { Length: > 0 } display ? display
        : parameter.StorageType == StorageType.String ? $"'{parameter.AsString() ?? ""}'"
        : StoredValue(parameter);

    private static string StoredValue(Parameter parameter) => parameter.StorageType switch
    {
        StorageType.Double => parameter.AsDouble().ToString("R", CultureInfo.InvariantCulture),
        StorageType.Integer => parameter.AsInteger().ToString(CultureInfo.InvariantCulture),
        StorageType.String => JsonSerializer.Serialize(parameter.AsString()),
        StorageType.ElementId => parameter.AsElementId().Value.ToString(CultureInfo.InvariantCulture),
        _ => "none",
    };

    private static string? BuiltInName(Parameter parameter) => BuiltInName(parameter.Definition);

    private static string? BuiltInName(Definition definition)
    {
        var builtIn = (definition as InternalDefinition)?.BuiltInParameter ?? BuiltInParameter.INVALID;
        return builtIn == BuiltInParameter.INVALID ? null : builtIn.ToString();
    }

    private static bool TryDouble(JsonNode value, out double number)
    {
        number = 0;
        return value.GetValueKind() == JsonValueKind.Number && value.AsValue().TryGetValue(out number) && double.IsFinite(number);
    }

    /// <summary>An integral JSON number in Int32 range, or a boolean as 1 or 0.</summary>
    private static bool TryInteger(JsonNode value, out int integer)
    {
        integer = 0;
        switch (value.GetValueKind())
        {
            case JsonValueKind.True:
                integer = 1;
                return true;
            case JsonValueKind.False:
                return true;
            case JsonValueKind.Number:
                return value.AsValue().TryGetValue(out integer);
            default:
                return false;
        }
    }

    private static bool TryLong(JsonNode value, out long number)
    {
        number = 0;
        return value.GetValueKind() == JsonValueKind.Number && value.AsValue().TryGetValue(out number);
    }
}
