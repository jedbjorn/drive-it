using System.Reflection;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;

namespace DriveIt.Revit.Bridge;

/// <summary>
/// revit.describe: the members and signatures of a Revit API type, read by reflection from the RevitAPI the
/// running Revit loaded. Needs no Revit thread and no hold.
/// </summary>
internal static class ApiDescription
{
    private const int MaximumSuggestions = 12;
    private static readonly Assembly RevitApi = typeof(Document).Assembly;
    private static readonly Lazy<Type[]> Exported = new(() => RevitApi.GetExportedTypes());

    public static JsonObject Describe(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new BridgeException("invalid_argument", "revit.describe takes a type name, e.g. \"FamilyItemFactory\" or \"DB.Structure.StructuralType\".");
        var type = Find(name.Trim());
        var flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static;
        var description = new JsonObject
        {
            ["name"] = FullName(type),
            ["kind"] = type.IsEnum ? "enum" : type.IsInterface ? "interface" : type.IsValueType ? "struct" : type.IsAbstract ? "abstract class" : "class",
            ["baseType"] = type.BaseType is { } baseType && baseType != typeof(object) && baseType != typeof(ValueType) && baseType != typeof(Enum)
                ? FullName(baseType)
                : null,
        };
        if (type.IsEnum)
        {
            description["values"] = new JsonArray(Enum.GetNames(type).Select(value => (JsonNode)value).ToArray());
            return description;
        }
        description["constructors"] = List(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            .Select(constructor => $"{type.Name}({Parameters(constructor)}){Obsolete(constructor)}"));
        description["properties"] = List(type.GetProperties(flags)
            .Select(property => $"{Static(property.GetMethod ?? property.SetMethod)}{Short(property.PropertyType)} {property.Name}"
                + (property.GetIndexParameters() is { Length: > 0 } index ? $"[{string.Join(", ", index.Select(Parameter))}]" : "")
                + $" {{ {(property.GetMethod?.IsPublic == true ? "get; " : "")}{(property.SetMethod?.IsPublic == true ? "set; " : "")}}}{Obsolete(property)}"));
        description["methods"] = List(type.GetMethods(flags)
            .Where(method => !method.IsSpecialName && method.DeclaringType != typeof(object))
            .Select(method => $"{Static(method)}{Short(method.ReturnType)} {method.Name}({Parameters(method)}){Obsolete(method)}"));
        description["fields"] = List(type.GetFields(flags)
            .Select(field => $"{(field.IsStatic ? "static " : "")}{Short(field.FieldType)} {field.Name}{Obsolete(field)}"));
        return description;
    }

    /// <summary>An exact full name, a name under Autodesk.Revit.DB, or a name every match ends with.</summary>
    private static Type Find(string name)
    {
        var key = name.StartsWith("DB.", StringComparison.Ordinal) ? name[3..] : name;
        var exact = Exported.Value.Where(type => FullName(type) == key || FullName(type) == $"{BridgeCalls.RootNamespace}.{key}").ToList();
        if (exact.Count == 1)
            return exact[0];
        var matches = Exported.Value.Where(type => FullName(type).EndsWith($".{key}", StringComparison.Ordinal)).ToList();
        if (matches.Count == 1)
            return matches[0];
        if (matches.Count > 1)
            throw new BridgeException("ambiguous_type",
                $"Several Revit API types are named {key}: {string.Join(", ", matches.Select(FullName).Order(StringComparer.Ordinal))}. Pass the full name.");
        var last = key[(key.LastIndexOf('.') + 1)..];
        var similar = Exported.Value.Where(type => type.Name.Contains(last, StringComparison.OrdinalIgnoreCase))
            .Select(FullName).Order(StringComparer.Ordinal).Take(MaximumSuggestions).ToList();
        throw new BridgeException("type_not_found", similar.Count == 0
            ? $"No Revit API type is named {key}."
            : $"No Revit API type is named {key}. Similar: {string.Join(", ", similar)}.");
    }

    private static JsonArray List(IEnumerable<string> lines) =>
        new(lines.Distinct().Order(StringComparer.Ordinal).Select(line => (JsonNode)line).ToArray());

    private static string Parameters(MethodBase method) => string.Join(", ", method.GetParameters().Select(Parameter));

    private static string Parameter(ParameterInfo parameter)
    {
        var type = parameter.ParameterType;
        var prefix = type.IsByRef ? parameter.IsOut ? "out " : "ref " : "";
        return $"{prefix}{Short(type.IsByRef ? type.GetElementType()! : type)} {parameter.Name}";
    }

    private static string Static(MethodBase? method) => method?.IsStatic == true ? "static " : "";

    private static string Obsolete(MemberInfo member) => member.IsDefined(typeof(ObsoleteAttribute), false) ? " [obsolete]" : "";

    private static string FullName(Type type) => (type.FullName ?? type.Name).Replace('+', '.');

    /// <summary>A type as a script writes it: Wall, IList&lt;ElementId&gt;, Structure.StructuralType.</summary>
    private static string Short(Type type)
    {
        if (type == typeof(void))
            return "void";
        if (type.IsArray)
            return $"{Short(type.GetElementType()!)}[]";
        if (type.IsGenericType)
        {
            var tick = type.Name.IndexOf('`');
            var name = tick < 0 ? type.Name : type.Name[..tick];
            return $"{name}<{string.Join(", ", type.GetGenericArguments().Select(Short))}>";
        }
        var full = FullName(type);
        return full.StartsWith(BridgeCalls.RootNamespace + ".", StringComparison.Ordinal)
            ? full[(BridgeCalls.RootNamespace.Length + 1)..]
            : type.Namespace == "System" ? type.Name : full;
    }
}
