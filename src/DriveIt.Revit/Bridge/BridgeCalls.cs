using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using DriveIt.Core.Bridge;

namespace DriveIt.Revit.Bridge;

/// <summary>A bridge call the script made wrongly or Revit refused; the script receives RevitError with it.</summary>
public sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;

    /// <summary>
    /// When Revit threw: the full names of its exception class and each base up to System.Exception, so the script's
    /// RevitError also matches the class it imported (except InvalidOperationException:).
    /// </summary>
    public IReadOnlyList<string>? Exceptions { get; init; }
}

/// <summary>A Revit API type named by a DB path, e.g. DB.XYZ or DB.Wall. Never handed to a script as a System.Type.</summary>
internal sealed record TypeReference(Type Type)
{
    public override string ToString() => Type.FullName ?? Type.Name;
}

/// <summary>A method's return value followed by its out parameters; crosses to the script as a tuple.</summary>
internal sealed record OutValues(IReadOnlyList<object?> Values);

/// <summary>A call's result and what each box the script passed (clr.Reference, StrongBox) holds after it, in argument order.</summary>
internal sealed record Boxed(object? Value, IReadOnlyList<object?> Boxes);

/// <summary>
/// A call's arguments as the script wrote them: positional, then named. A box is {"$ref": starting value or null}.
/// </summary>
internal sealed record Arguments(IReadOnlyList<JsonNode?> Values, IReadOnlyList<Overloads.Argument> Shape)
{
    public int Count => Values.Count;

    public static Arguments From(JsonObject call) => From(call["args"] as JsonArray ?? [], call["named"] as JsonObject);

    public static Arguments From(JsonArray positional, JsonObject? named = null)
    {
        var values = new List<JsonNode?>();
        var shape = new List<Overloads.Argument>();
        foreach (var node in positional)
        {
            values.Add(node);
            shape.Add(new Overloads.Argument(null, IsBox(node)));
        }
        foreach (var (name, node) in named ?? [])
        {
            values.Add(node);
            shape.Add(new Overloads.Argument(name, IsBox(node)));
        }
        return new Arguments(values, shape);
    }

    private static bool IsBox(JsonNode? node) => node is JsonObject box && box.ContainsKey("$ref");
}

/// <summary>
/// Resolves a script's bridge calls by reflection, on Revit's thread, against the run's handle table.
/// Numbers, strings, booleans and null cross by value; everything else is a handle that lasts for the run.
/// </summary>
internal sealed class BridgeCalls
{
    public const string RootNamespace = "Autodesk.Revit.DB";
    private const int DefaultChunk = 256;
    private const int MaximumChunk = 4096;
    private static readonly Assembly RevitApi = typeof(Document).Assembly;
    private static readonly HashSet<Type> OwnedByDriveIt = [typeof(Transaction), typeof(TransactionGroup), typeof(SubTransaction)];
    private static readonly Dictionary<string, Type?> TypeCache = new(StringComparer.Ordinal);

    /// <summary>Python operators and the .NET operator method each one calls.</summary>
    private static readonly Dictionary<string, string> OperatorSymbols = new(StringComparer.Ordinal)
    {
        ["op_Addition"] = "+", ["op_Subtraction"] = "-", ["op_Multiply"] = "*", ["op_Division"] = "/",
        ["op_UnaryNegation"] = "-", ["op_UnaryPlus"] = "+",
        ["op_LessThan"] = "<", ["op_LessThanOrEqual"] = "<=", ["op_GreaterThan"] = ">", ["op_GreaterThanOrEqual"] = ">=",
        ["op_BitwiseOr"] = "|", ["op_BitwiseAnd"] = "&", ["op_ExclusiveOr"] = "^", ["op_OnesComplement"] = "~",
    };

    private readonly Dictionary<long, object> objects = new();
    private readonly Dictionary<object, long> ids = new(ReferenceEqualityComparer.Instance);
    private long nextId;

    public int HandleCount => objects.Count;

    /// <summary>Notes for the receipt from the current call (an older API spelling accepted); the hold sends and clears them.</summary>
    public List<string> Notes { get; } = [];

    public void Clear()
    {
        objects.Clear();
        ids.Clear();
    }

    public JsonNode? Get(JsonObject call)
    {
        var member = RequireMember(call);
        var target = Target(call);
        if (target is TypeReference type)
            return Encode(StaticMember(type.Type, member));
        if (HasMethod(target.GetType(), member, BindingFlags.Instance))
            return new JsonObject { ["$method"] = member };
        if (IsIndexedOnly(target.GetType(), member))
            return new JsonObject { ["$indexed"] = member };
        return Encode(InstanceMember(target, member));
    }

    public JsonNode? Set(JsonObject call)
    {
        var member = RequireMember(call);
        var target = Target(call);
        var (type, flags, instance) = target is TypeReference reference
            ? (reference.Type, BindingFlags.Static, (object?)null)
            : (target.GetType(), BindingFlags.Instance, target);
        SetMember(type, flags, instance, member, call["value"]);
        return null;
    }

    private void SetMember(Type type, BindingFlags flags, object? instance, string member, JsonNode? valueNode)
    {
        var property = FindProperty(type, member, flags);
        if (property is not null)
        {
            if (property.SetMethod is not { IsPublic: true })
                throw new BridgeException("member_read_only", $"{TypeName(type)}.{member} cannot be set.");
            if (!TryConvert(valueNode, property.PropertyType, out var value, out _))
                throw new BridgeException("invalid_argument",
                    $"{TypeName(type)}.{member} takes {TypeName(property.PropertyType)}; the value given does not convert to it.");
            Invoke(() => property.SetValue(instance, value));
            return;
        }
        var field = type.GetField(member, BindingFlags.Public | flags);
        if (field is null || field.IsInitOnly || field.IsLiteral)
            throw MemberNotFound(type, member, flags);
        if (!TryConvert(valueNode, field.FieldType, out var fieldValue, out _))
            throw new BridgeException("invalid_argument",
                $"{TypeName(type)}.{member} takes {TypeName(field.FieldType)}; the value given does not convert to it.");
        Invoke(() => field.SetValue(instance, fieldValue));
    }

    /// <summary>
    /// A method call on a handle, a static method on a DB type (target path with member), or a constructor
    /// (target path naming a type, no member).
    /// </summary>
    public JsonNode? Call(JsonObject call)
    {
        var arguments = Arguments.From(call);
        var member = call["member"]?.GetValue<string>();
        if (string.IsNullOrEmpty(member) && call["target"] is JsonObject reference && reference["$path"] is { } pathNode)
            return CallPath(pathNode.GetValue<string>(), arguments);
        var target = Target(call);
        if (target is TypeReference type)
        {
            if (string.IsNullOrEmpty(member))
                return Encode(Construct(type.Type, arguments));
            return Encode(InvokeMethod(type.Type, null, member, arguments, BindingFlags.Static));
        }
        if (string.IsNullOrEmpty(member))
            throw new BridgeException("not_callable", $"A {TypeName(target.GetType())} handle cannot be called; call one of its methods.");
        return Encode(InvokeMethod(target.GetType(), target, member, arguments, BindingFlags.Instance));
    }

    /// <summary>DB.XYZ(0, 0, 0) constructs; DB.Level.Create(doc, 10.0) calls a static method; a method on a static value calls it.</summary>
    private JsonNode? CallPath(string path, Arguments arguments)
    {
        object resolved;
        try
        {
            resolved = ResolvePath(path);
        }
        catch (BridgeException exception) when (exception.Code is "member_is_method" or "member_not_found" && path.LastIndexOf('.') > RootNamespace.Length)
        {
            var dot = path.LastIndexOf('.');
            var name = path[(dot + 1)..];
            if (Accessor(path[..dot], name, arguments) is { } accessed)
                return accessed.Value;
            var owner = ResolvePath(path[..dot]);
            return owner is TypeReference ownerType
                ? Encode(InvokeMethod(ownerType.Type, null, name, arguments, BindingFlags.Static))
                : Encode(InvokeMethod(owner.GetType(), owner, name, arguments, BindingFlags.Instance));
        }
        if (resolved is TypeReference type)
            return Encode(Construct(type.Type, arguments));
        throw new BridgeException("not_callable", $"{path[(RootNamespace.Length - 2)..]} is a value, not a type or method.");
    }

    public JsonNode? Index(JsonObject call)
    {
        var target = Instance(call);
        var key = call["key"];
        if (target is Array array)
        {
            if (!TryConvert(key, typeof(int), out var position, out _))
                throw new BridgeException("invalid_argument", "An array index must be an integer.");
            return Encode(Invoke(() => array.GetValue((int)position!)));
        }
        if (!HasMethod(target.GetType(), "get_Item", BindingFlags.Instance))
            throw new BridgeException("not_indexable", $"A {TypeName(target.GetType())} cannot be indexed.");
        return Encode(InvokeMethod(target.GetType(), target, "get_Item", Arguments.From([key?.DeepClone()]), BindingFlags.Instance));
    }

    /// <summary>Starts walking a collection: the first chunk of items, and an iterator handle while more remain.</summary>
    public JsonNode Iterate(JsonObject call)
    {
        var target = Instance(call);
        if (target is string || target is not IEnumerable enumerable)
            throw new BridgeException("not_iterable", $"A {TypeName(target.GetType())} is not a collection.");
        var enumerator = Invoke(() => enumerable.GetEnumerator())!;
        return Chunk((IEnumerator)enumerator, Count(call));
    }

    public JsonNode Next(JsonObject call)
    {
        var id = call["iterator"]?.GetValue<long>() ?? throw new BridgeException("invalid_call", "next requires an iterator.");
        if (Lookup(id) is not IEnumerator enumerator)
            throw new BridgeException("invalid_handle", "The iterator is not valid in this run.");
        return Chunk(enumerator, Count(call));
    }

    public JsonNode? Length(JsonObject call)
    {
        var target = Instance(call);
        return target switch
        {
            Array array => array.Length,
            ICollection collection => collection.Count,
            _ => Invoke(() => (FindProperty(target.GetType(), "Count", BindingFlags.Instance)
                    ?? FindProperty(target.GetType(), "Size", BindingFlags.Instance)
                    ?? throw new BridgeException("no_length", $"A {TypeName(target.GetType())} has no length."))
                .GetValue(target)) is { } count
                ? JsonValue.Create(Convert.ToInt64(count, CultureInfo.InvariantCulture))
                : null,
        };
    }

    public JsonNode Equal(JsonObject call)
    {
        var target = Target(call);
        if (!TryConvert(call["other"], typeof(object), out var other, out _))
            return false;
        if (target is TypeReference reference)
            return other is TypeReference otherReference && reference.Type == otherReference.Type;
        return Invoke(() => target.Equals(other)) is true;
    }

    public JsonNode? Text(JsonObject call) => Target(call) switch
    {
        TypeReference reference => reference.ToString(),
        var target => (string?)Invoke(() => target.ToString()),
    };

    /// <summary>
    /// A Python operator on Revit values: the .NET operator either operand's type defines (XYZ + XYZ, xyz * 2, -xyz),
    /// then | &amp; ^ ~ on enum values of one type, then comparison through IComparable.
    /// </summary>
    public JsonNode? Operator(JsonObject call)
    {
        var name = call["operator"]?.GetValue<string>();
        if (name is null || !OperatorSymbols.TryGetValue(name, out var symbol))
            throw new BridgeException("invalid_call", $"'{name}' is not an operator the bridge runs.");
        var arguments = Arguments.From(call["args"] as JsonArray ?? []);
        var operands = arguments.Values.Select(Operand).ToList();
        var candidates = operands.Where(operand => operand is not null and not TypeReference).Select(operand => operand!.GetType()).Distinct()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy))
            .Where(method => method.Name == name && method.GetParameters().Length == operands.Count)
            .Distinct()
            .ToList();
        if (candidates.Count > 0 && SelectOverload(candidates, arguments, out var converted, out _) is { } method)
            return Encode(Invoke(() => method.Invoke(null, converted)));
        if (EnumOperator(name, operands) is { } combined)
            return Encode(combined);
        if (Compare(name, operands) is { } compared)
            return compared;
        throw new BridgeException("operator_not_supported",
            $"Revit defines no {symbol} for {string.Join(" and ", operands.Select(Describe))}. Use a member that does it, or compare values such as .Value or .Name.");
    }

    /// <summary>isinstance(value, DB.Wall): true for a wall and its subtypes.</summary>
    public JsonNode IsInstance(JsonObject call)
    {
        var type = TypeOf(call["type"]);
        var target = Target(call);
        return target is not TypeReference && type.IsInstanceOfType(target);
    }

    /// <summary>issubclass(DB.Wall, DB.Element), also for el.GetType().</summary>
    public JsonNode IsSubclass(JsonObject call) => TypeOf(call["base"]).IsAssignableFrom(TypeOf(call["type"]));

    /// <summary>int() on an enum value: its number.</summary>
    public JsonNode Integer(JsonObject call) => Target(call) switch
    {
        Enum value => JsonValue.Create(Convert.ToInt64(value, CultureInfo.InvariantCulture)),
        TypeReference reference => throw new BridgeException("no_integer_value", $"{reference} is a type; int() takes an enum value."),
        var other => throw new BridgeException("no_integer_value",
            $"A {TypeName(other.GetType())} has no integer value; int() takes an enum value. For an element id, read its .Value."),
    };

    /// <summary>revit.describe inside a hold; outside one the broker answers it without Revit's thread.</summary>
    public static JsonNode Describe(JsonObject call) => ApiDescription.Describe(call["type"]?.GetValue<string>());

    /// <summary>Hands the script a handle to an object the add-in resolved (a document or an element).</summary>
    public JsonNode? Handle(object value) => Encode(value);

    public object Lookup(long id) => objects.TryGetValue(id, out var value)
        ? value
        : throw new BridgeException("invalid_handle",
            "This handle is not valid in this run. Handles last for one run; carry an element to the next run by its integer id.");

    private JsonObject Chunk(IEnumerator enumerator, int count)
    {
        var items = new JsonArray();
        var done = false;
        Invoke(() =>
        {
            while (items.Count < count)
            {
                if (!enumerator.MoveNext())
                {
                    done = true;
                    break;
                }
                items.Add(Encode(enumerator.Current));
            }
            return null;
        });
        var chunk = new JsonObject { ["items"] = items, ["done"] = done };
        if (!done)
            chunk["$iter"] = Add(enumerator);
        else
            Forget(enumerator);
        return chunk;
    }

    private static int Count(JsonObject call)
    {
        var count = call["count"]?.GetValue<int>() ?? DefaultChunk;
        return Math.Clamp(count, 1, MaximumChunk);
    }

    private object Target(JsonObject call)
    {
        var node = call["target"] ?? throw new BridgeException("invalid_call", "The call names no target.");
        if (node is JsonObject reference && reference["$path"] is { } path)
            return ResolvePath(path.GetValue<string>());
        if (node is JsonObject handle && handle["$h"] is { } id)
            return Lookup(id.GetValue<long>());
        throw new BridgeException("invalid_call", "A call target is a handle or a DB path.");
    }

    private object Instance(JsonObject call) => Target(call) is TypeReference reference
        ? throw new BridgeException("invalid_call", $"{reference} is a type; use one of its members.")
        : Target(call);

    private static string RequireMember(JsonObject call)
    {
        var member = call["member"]?.GetValue<string>();
        return string.IsNullOrWhiteSpace(member) ? throw new BridgeException("invalid_call", "The call names no member.") : member;
    }

    private long Add(object value)
    {
        if (ids.TryGetValue(value, out var id))
            return id;
        if (objects.Count >= Guardrails.MaximumHandles)
            throw new BridgeException("limit_exceeded",
                $"This run already holds {Guardrails.MaximumHandles} handles, the most one run may hold. Filter the collector to what you need, or carry element ids and split the work into more runs.");
        id = ++nextId;
        objects[id] = value;
        ids[value] = id;
        return id;
    }

    private void Forget(object value)
    {
        if (ids.Remove(value, out var id))
            objects.Remove(id);
    }

    private JsonNode? Encode(object? value)
    {
        switch (value)
        {
            case null:
                return null;
            case string text:
                return text;
            case bool flag:
                return flag;
            case char character:
                return character.ToString();
            case byte or sbyte or short or ushort or int or uint or long:
                return JsonValue.Create(Convert.ToInt64(value, CultureInfo.InvariantCulture));
            case ulong unsigned:
                return JsonValue.Create(unsigned);
            case float or double or decimal:
                var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                return double.IsFinite(number) ? JsonValue.Create(number) : number.ToString(CultureInfo.InvariantCulture);
            case Guid guid:
                return guid.ToString();
            case OutValues tuple:
                return new JsonObject { ["$tuple"] = new JsonArray(tuple.Values.Select(Encode).ToArray()) };
            case Boxed boxed:
                return new JsonObject { ["$boxes"] = new JsonArray(boxed.Boxes.Select(Encode).ToArray()), ["value"] = Encode(boxed.Value) };
            case Type type:
                // el.GetType() and any API that returns a type: its name as text, never a handle to a System.Type.
                return new JsonObject { ["$type"] = TypeName(type) };
        }
        if (value is not TypeReference)
            Guardrails.RequireAllowed(value.GetType());
        return new JsonObject
        {
            ["$h"] = Add(value),
            ["type"] = value is TypeReference reference ? $"type {reference}" : TypeName(value.GetType()),
        };
    }

    /// <summary>
    /// A DB path, e.g. Autodesk.Revit.DB.Structure.StructuralType.NonStructural: the longest prefix that names a
    /// Revit API type, then static members of it and members of what they return.
    /// </summary>
    private object ResolvePath(string path)
    {
        if (path != RootNamespace && !path.StartsWith(RootNamespace + ".", StringComparison.Ordinal))
            throw new BridgeException("invalid_call", $"'{path}' is not under DB.");
        var parts = path.Split('.');
        for (var length = parts.Length; length > 3; length--)
        {
            var type = FindType(string.Join('.', parts, 0, length));
            if (type is null)
                continue;
            object current = new TypeReference(type);
            for (var index = length; index < parts.Length; index++)
            {
                current = current switch
                {
                    TypeReference reference when reference.Type.GetNestedType(parts[index], BindingFlags.Public) is { } nested =>
                        new TypeReference(nested),
                    TypeReference reference => StaticMember(reference.Type, parts[index])
                        ?? throw new BridgeException("null_value", $"{reference}.{parts[index]} is null."),
                    var value => InstanceMember(value, parts[index])
                        ?? throw new BridgeException("null_value", $"{string.Join('.', parts, 0, index + 1)} is null."),
                };
            }
            return current;
        }
        throw RemovedMembers.RemovedType(path)
            ?? new BridgeException("member_not_found", $"'{path}' does not name a Revit API type or member.");
    }

    private static Type? FindType(string name)
    {
        lock (TypeCache)
        {
            if (!TypeCache.TryGetValue(name, out var type))
                TypeCache[name] = type = RevitApi.GetType(name, false) is { IsPublic: true } found ? found : null;
            return type;
        }
    }

    private static object? StaticMember(Type type, string member)
    {
        if (FindReadable(type, member, BindingFlags.Static) is { } property)
            return Invoke(() => property.GetValue(null));
        if (FindProperty(type, member, BindingFlags.Static) is not null)
            throw WriteOnly(type, member);
        if (type.GetField(member, BindingFlags.Public | BindingFlags.Static) is { } field)
            return Invoke(() => field.GetValue(null));
        if (HasMethod(type, member, BindingFlags.Static))
            throw new BridgeException("member_is_method", $"{TypeName(type)}.{member} is a method; call it.");
        throw MemberNotFound(type, member, BindingFlags.Static);
    }

    private object? InstanceMember(object target, string member)
    {
        var type = target.GetType();
        if (FindReadable(type, member, BindingFlags.Instance) is { } property)
            return Invoke(() => property.GetValue(target));
        if (FindProperty(type, member, BindingFlags.Instance) is not null)
            throw WriteOnly(type, member);
        if (type.GetField(member, BindingFlags.Public | BindingFlags.Instance) is { } field)
            return Invoke(() => field.GetValue(target));
        if (RemovedMembers.Accept(target, member) is { } accepted)
        {
            Notes.Add(accepted.Note);
            return Invoke(accepted.Read);
        }
        throw MemberNotFound(type, member, BindingFlags.Instance);
    }

    /// <summary>
    /// The property a read goes through: the most derived of that name with a public getter. Revit declares some
    /// properties only to set them on a subtype (ElementType.Name), hiding the base's getter; reading through that
    /// declaration threw "Property Get method was not found".
    /// </summary>
    private static PropertyInfo? FindReadable(Type type, string name, BindingFlags flags)
    {
        for (var current = type; current is not null; current = current.BaseType)
        {
            var declared = current.GetProperties(BindingFlags.Public | BindingFlags.DeclaredOnly | flags)
                .FirstOrDefault(property => property.Name == name && property.GetIndexParameters().Length == 0 && property.GetMethod is { IsPublic: true });
            if (declared is not null)
                return declared;
        }
        return null;
    }

    private static BridgeException WriteOnly(Type type, string member) => new("member_write_only",
        $"{TypeName(type)}.{member} can be set but not read in Revit's API. Read the value another way, for example a parameter with get_Parameter(...).");

    /// <summary>An indexed property such as Element.Parameter: el.Parameter[bip] calls get_Parameter(bip).</summary>
    private static bool IsIndexedOnly(Type type, string member) =>
        FindProperty(type, member, BindingFlags.Instance) is null
        && type.GetField(member, BindingFlags.Public | BindingFlags.Instance) is null
        && type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Any(property => property.Name == member && property.GetIndexParameters().Length > 0);

    /// <summary>
    /// The IronPython spelling of a property read or write through its type, Element.Name.GetValue(el) or
    /// Element.Name.SetValue(el, value) (the script's __get__ and __set__ arrive as these). Null when the path is not one.
    /// </summary>
    private Accessed? Accessor(string ownerPath, string name, Arguments arguments)
    {
        if (name is not ("GetValue" or "SetValue"))
            return null;
        var dot = ownerPath.LastIndexOf('.');
        if (dot <= RootNamespace.Length || FindType(ownerPath[..dot]) is not { } type)
            return null;
        var member = ownerPath[(dot + 1)..];
        if (FindProperty(type, member, BindingFlags.Instance) is null && FindReadable(type, member, BindingFlags.Instance) is null)
            return null;
        var expected = name == "GetValue" ? 1 : 2;
        if (arguments.Count != expected || arguments.Shape.Any(argument => argument.Name is not null || argument.IsBox))
            throw new BridgeException("invalid_argument", name == "GetValue"
                ? $"{type.Name}.{member}.GetValue takes the object to read, e.g. {type.Name}.{member}.GetValue(element)."
                : $"{type.Name}.{member}.SetValue takes the object and the value, e.g. {type.Name}.{member}.SetValue(element, value).");
        if (!TryConvert(arguments.Values[0], type, out var instance, out _) || instance is null)
            throw new BridgeException("invalid_argument", $"{type.Name}.{member}.{name} takes a {TypeName(type)} first.");
        if (name == "GetValue")
            return new Accessed(Encode(InstanceMember(instance, member)));
        SetMember(instance.GetType(), BindingFlags.Instance, instance, member, arguments.Values[1]);
        return new Accessed(null);
    }

    private sealed record Accessed(JsonNode? Value);

    /// <summary>The most derived public, non-indexed property of that name (a derived type may hide a base one).</summary>
    private static PropertyInfo? FindProperty(Type type, string name, BindingFlags flags) =>
        type.GetProperties(BindingFlags.Public | flags)
            .Where(property => property.Name == name && property.GetIndexParameters().Length == 0)
            .OrderByDescending(property => Depth(property.DeclaringType))
            .FirstOrDefault();

    private static bool HasMethod(Type type, string name, BindingFlags flags) =>
        type.GetMethods(BindingFlags.Public | flags).Any(method => method.Name == name);

    private object Construct(Type type, Arguments arguments)
    {
        if (OwnedByDriveIt.Contains(type))
            throw new BridgeException("member_not_allowed",
                $"Drive-It owns every transaction; a script cannot create a {type.Name}. Put Revit changes inside `with revit.transaction(\"name\"):`.");
        if (type.IsAbstract)
            throw new BridgeException("not_constructible", $"{TypeName(type)} is abstract and cannot be constructed.");
        var constructor = SelectOverload(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance), arguments, out var converted, out var slots)
            ?? throw NoMatch(type, ".ctor", type.GetConstructors(BindingFlags.Public | BindingFlags.Instance), arguments);
        var created = Invoke(() => ((ConstructorInfo)constructor).Invoke(converted))!;
        return Boxes(arguments, slots, converted) is { } boxes ? new Boxed(created, boxes) : created;
    }

    private object? InvokeMethod(Type type, object? target, string name, Arguments arguments, BindingFlags flags)
    {
        Guardrails.RequireCallable(type, name);
        var candidates = type.GetMethods(BindingFlags.Public | flags)
            .Where(method => method.Name == name && !method.ContainsGenericParameters)
            .ToList();
        if (candidates.Count == 0)
            throw MemberNotFound(type, name, flags);
        var method = SelectOverload(candidates, arguments, out var converted, out var slots)
            ?? throw NoMatch(type, name, candidates, arguments);
        Overloads.SupplyOutputs(method, converted, Output);
        var result = Invoke(() => method.Invoke(target, converted));
        // Out parameters come back after the return value, as a Python tuple; a single value comes back as itself.
        // One the script gave a box for goes back in the box instead.
        var boxes = Boxes(arguments, slots, converted);
        var boxed = boxes is null ? new HashSet<int>() : arguments.Shape.Select((argument, index) => (argument, index))
            .Where(entry => entry.argument.IsBox).Select(entry => slots[entry.index]).ToHashSet();
        var value = Overloads.Outputs(method, result, converted, boxed) switch
        {
            null => result,
            [var single] => single,
            { } values => new OutValues(values),
        };
        return boxes is null ? value : new Boxed(value, boxes);
    }

    /// <summary>What each box argument holds after the call, in argument order; null when the script passed none.</summary>
    private static List<object?>? Boxes(Arguments arguments, int[] slots, object?[] converted)
    {
        if (!arguments.Shape.Any(argument => argument.IsBox))
            return null;
        return arguments.Shape.Select((argument, index) => (argument, index))
            .Where(entry => entry.argument.IsBox)
            .Select(entry => converted[slots[entry.index]])
            .ToList();
    }

    /// <summary>
    /// What an out parameter starts as when the script gave no starting value: a new Revit API object when its type is
    /// one Drive-It can construct with no arguments (Revit fills NewFootPrintRoof's ModelCurveArray in place and
    /// refuses null), otherwise null. A box with a starting value (StrongBox[T](value)) passes that value instead.
    /// </summary>
    private static object? Output(Type type) =>
        type.Assembly == RevitApi && type is { IsClass: true, IsAbstract: false } && !OwnedByDriveIt.Contains(type)
            && type.GetConstructor(Type.EmptyTypes) is { } constructor
            ? Invoke(() => constructor.Invoke(null))
            : null;

    private static bool IsOut(ParameterInfo parameter) => Overloads.IsOut(parameter);

    /// <summary>No overload fits: a callback Revit asks for is named, otherwise every signature is listed.</summary>
    private static BridgeException NoMatch(Type type, string name, IEnumerable<MethodBase> candidates, Arguments arguments)
    {
        var callback = candidates
            .Select(method => method.GetParameters().Where(parameter => !IsOut(parameter)).ToArray())
            .Where(inputs => inputs.Length >= arguments.Count)
            .SelectMany(inputs => inputs.Select((parameter, index) => (parameter.ParameterType, index)))
            .FirstOrDefault(entry => Guardrails.IsUnsupportedCallback(entry.ParameterType)
                && (entry.index >= arguments.Count || arguments.Values[entry.index] is not JsonObject { } given || given["$option"] is null));
        return callback.ParameterType is not null
            ? Guardrails.CallbackNotSupported(type, name, callback.ParameterType)
            : NoOverload(type, name, candidates, arguments);
    }

    private MethodBase? SelectOverload(IEnumerable<MethodBase> candidates, Arguments arguments, out object?[] converted, out int[] slots) =>
        Overloads.Select(candidates, arguments.Shape,
            (int index, Type parameterType, out object? value, out int score) => TryConvert(arguments.Values[index], parameterType, out value, out score),
            out converted, out slots);

    /// <summary>Converts one script value to a parameter type; a higher score is a closer match.</summary>
    private bool TryConvert(JsonNode? node, Type target, out object? value, out int score)
    {
        value = null;
        score = 0;
        if (target.IsByRef)
            return TryBox(node, target.GetElementType()!, out value, out score);
        var underlying = Nullable.GetUnderlyingType(target);
        if (node is null)
        {
            score = 1;
            return !target.IsValueType || underlying is not null;
        }
        target = underlying ?? target;
        switch (node)
        {
            case JsonObject reference when reference["$h"] is { } id:
                return TryObject(Lookup(id.GetValue<long>()), target, out value, out score);
            case JsonObject reference when reference["$path"] is { } path:
                return TryObject(ResolvePath(path.GetValue<string>()), target, out value, out score);
            case JsonObject option when option["$option"] is not null:
                score = 100;
                return Guardrails.TryOption(option, target, out value);
            case JsonObject:
                return false;
            case JsonArray array:
                return TryCollection(array, target, out value, out score);
        }

        var element = node.GetValue<JsonElement>();
        switch (element.ValueKind)
        {
            case JsonValueKind.True or JsonValueKind.False:
                value = element.GetBoolean();
                score = target == typeof(bool) ? 100 : 10;
                return target == typeof(bool) || target == typeof(object);
            case JsonValueKind.String:
                var text = element.GetString()!;
                if (target == typeof(string))
                {
                    value = text;
                    score = 100;
                    return true;
                }
                if (target == typeof(char) && text.Length == 1)
                {
                    value = text[0];
                    score = 60;
                    return true;
                }
                if (target == typeof(Guid) && Guid.TryParse(text, out var guid))
                {
                    value = guid;
                    score = 90;
                    return true;
                }
                value = text;
                score = 10;
                return target == typeof(object);
            case JsonValueKind.Number:
                return TryNumber(element, target, out value, out score);
        }
        return false;
    }

    /// <summary>A box for an out or ref parameter: its starting value converted to the parameter's type, or empty.</summary>
    private bool TryBox(JsonNode? node, Type type, out object? value, out int score)
    {
        value = null;
        score = 0;
        if (node is not JsonObject box || !box.ContainsKey("$ref"))
            return false;
        if (box["$ref"] is not { } start)
        {
            value = type.IsValueType ? Activator.CreateInstance(type) : null;
            score = 100;
            return true;
        }
        return TryConvert(start, type, out value, out score);
    }

    private static bool TryNumber(JsonElement element, Type target, out object? value, out int score)
    {
        value = null;
        score = 0;
        var raw = element.GetRawText();
        var integral = raw.IndexOfAny(['.', 'e', 'E']) < 0 && element.TryGetInt64(out _);
        try
        {
            if (integral)
            {
                var whole = element.GetInt64();
                (value, score) = Type.GetTypeCode(target) switch
                {
                    TypeCode.Int64 => (whole, 100),
                    TypeCode.Int32 => ((object)checked((int)whole), 100),
                    TypeCode.Int16 => (checked((short)whole), 80),
                    TypeCode.Byte => (checked((byte)whole), 80),
                    TypeCode.SByte => (checked((sbyte)whole), 80),
                    TypeCode.UInt16 => (checked((ushort)whole), 80),
                    TypeCode.UInt32 => (checked((uint)whole), 80),
                    TypeCode.UInt64 => (checked((ulong)whole), 80),
                    TypeCode.Double => ((double)whole, 70),
                    TypeCode.Single => ((float)whole, 60),
                    TypeCode.Decimal => ((decimal)whole, 60),
                    _ => (target == typeof(object) ? whole : null, target == typeof(object) ? 10 : 0),
                };
                return value is not null;
            }
            var real = element.GetDouble();
            (value, score) = Type.GetTypeCode(target) switch
            {
                TypeCode.Double => ((object)real, 100),
                TypeCode.Single => ((float)real, 80),
                TypeCode.Decimal => ((decimal)real, 80),
                _ => (target == typeof(object) ? real : null, target == typeof(object) ? 10 : 0),
            };
            return value is not null;
        }
        catch (OverflowException)
        {
            return false;
        }
    }

    private static bool TryObject(object source, Type target, out object? value, out int score)
    {
        value = null;
        score = 0;
        if (source is TypeReference reference)
        {
            if (target == typeof(Type))
            {
                value = reference.Type;
                score = 100;
                return true;
            }
            if (target != typeof(object))
                return false;
            value = reference;
            score = 10;
            return true;
        }
        if (!target.IsInstanceOfType(source))
            return false;
        value = source;
        if (target == typeof(object))
            score = 10;
        else if (target.IsInterface)
            score = 50;
        else
            score = Math.Max(20, 100 - 5 * (Depth(source.GetType()) - Depth(target)));
        return true;
    }

    /// <summary>A Python list becomes the array, list or set the parameter expects.</summary>
    private bool TryCollection(JsonArray array, Type target, out object? value, out int score)
    {
        value = null;
        score = 0;
        Type? item;
        Func<IList, object> build;
        if (target.IsArray)
        {
            item = target.GetElementType()!;
            build = items =>
            {
                var result = Array.CreateInstance(item, items.Count);
                items.CopyTo(result, 0);
                return result;
            };
        }
        else if (target.IsGenericType && target.GetGenericArguments().Length == 1)
        {
            item = target.GetGenericArguments()[0];
            var definition = target.GetGenericTypeDefinition();
            if (definition == typeof(ISet<>) || definition == typeof(HashSet<>))
                build = items => Activator.CreateInstance(typeof(HashSet<>).MakeGenericType(item), items)!;
            else if (definition == typeof(IList<>) || definition == typeof(ICollection<>) || definition == typeof(IEnumerable<>)
                || definition == typeof(List<>) || definition == typeof(IReadOnlyList<>) || definition == typeof(IReadOnlyCollection<>))
                build = items => items;
            else
                return false;
        }
        else
        {
            return false;
        }

        var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(item))!;
        var lowest = 100;
        foreach (var entry in array)
        {
            if (!TryConvert(entry, item, out var converted, out var entryScore))
                return false;
            list.Add(converted);
            lowest = Math.Min(lowest, entryScore);
        }
        value = build(list);
        score = lowest;
        return true;
    }

    /// <summary>Runs a reflected member and surfaces what Revit threw, by its own message.</summary>
    private static object? Invoke(Func<object?> action)
    {
        try
        {
            return action();
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            throw Translate(exception.InnerException);
        }
        catch (Exception exception) when (exception is not BridgeException)
        {
            throw Translate(exception);
        }
    }

    private static void Invoke(Action action) => Invoke(() =>
    {
        action();
        return null;
    });

    private static BridgeException Translate(Exception exception)
    {
        if (exception is BridgeException bridge)
            return bridge;
        if (exception is Autodesk.Revit.Exceptions.ModificationOutsideTransactionException)
            return new BridgeException("modification_outside_transaction",
                $"{exception.Message} Put Revit changes inside `with revit.transaction(\"name\"):`.") { Exceptions = Chain(exception) };
        return new BridgeException("revit_api_error", $"{exception.GetType().Name}: {exception.Message}") { Exceptions = Chain(exception) };
    }

    /// <summary>An exception's class and its bases, most derived first, stopping before System.Exception.</summary>
    private static List<string> Chain(Exception exception)
    {
        var names = new List<string>();
        for (var type = exception.GetType(); type is not null && type != typeof(Exception); type = type.BaseType)
            names.Add(type.FullName ?? type.Name);
        return names;
    }

    private static BridgeException MemberNotFound(Type type, string member, BindingFlags flags)
    {
        if (RemovedMembers.Redirect(type, member) is { } removed)
            return removed;
        var properties = type.GetProperties(BindingFlags.Public | flags).Where(property => property.GetIndexParameters().Length == 0)
            .Select(property => property.Name).ToHashSet(StringComparer.Ordinal);
        var methods = type.GetMethods(BindingFlags.Public | flags).Select(method => method.Name)
            .Where(name => !name.StartsWith("op_", StringComparison.Ordinal) && !name.StartsWith("add_", StringComparison.Ordinal)
                && !name.StartsWith("remove_", StringComparison.Ordinal)
                && !((name.StartsWith("get_", StringComparison.Ordinal) || name.StartsWith("set_", StringComparison.Ordinal)) && properties.Contains(name[4..])));
        var fields = type.GetFields(BindingFlags.Public | flags).Select(field => field.Name);
        var names = properties.Concat(methods).Concat(fields).Distinct().Order(StringComparer.Ordinal);
        var kind = flags.HasFlag(BindingFlags.Static) ? "static member" : "member";
        return new BridgeException("member_not_found",
            $"{TypeName(type)} has no {kind} '{member}'. Its {kind}s are: {string.Join(", ", names)}.");
    }

    private static BridgeException NoOverload(Type type, string name, IEnumerable<MethodBase> candidates, Arguments arguments)
    {
        var signatures = candidates.Select(method =>
            $"{(name == ".ctor" ? TypeName(type) : name)}({string.Join(", ", method.GetParameters().Select(Signature))})");
        var outs = candidates.Any(method => method.GetParameters().Any(IsOut))
            ? " Pass no argument for an out parameter; its value comes back after the return value, as a tuple. Or pass clr.Reference[T]() and read its .Value."
            : "";
        var named = arguments.Shape.Where(argument => argument.Name is not null).Select(argument => argument.Name!).ToList();
        if (named.Count > 0)
            outs += $" Named arguments ({string.Join(", ", named)}) must match a parameter name shown.";
        return new BridgeException("no_matching_overload",
            $"No {TypeName(type)}.{(name == ".ctor" ? "constructor" : name)} takes these {arguments.Count} argument(s). It has: {string.Join("; ", signatures)}.{outs}");
    }

    /// <summary>A parameter as revit.describe writes by-reference ones: out ModelCurveArray mapping, not ModelCurveArray&amp;.</summary>
    private static string Signature(ParameterInfo parameter) => parameter.ParameterType.IsByRef
        ? $"{(IsOut(parameter) ? "out" : "ref")} {TypeName(parameter.ParameterType.GetElementType()!)} {parameter.Name}"
        : $"{TypeName(parameter.ParameterType)} {parameter.Name}";

    /// <summary>An operand as an object, to find the operator its type defines.</summary>
    private object? Operand(JsonNode? node) => node is null
        ? null
        : TryConvert(node, typeof(object), out var value, out _) ? value : throw new BridgeException("invalid_argument", "An operand is not a value the bridge knows.");

    private static string Describe(object? operand) => operand switch
    {
        null => "None",
        TypeReference reference => $"the type {reference}",
        _ => TypeName(operand.GetType()),
    };

    /// <summary>| &amp; ^ ~ on flag enum values of one type, which .NET does not define as operator methods.</summary>
    private static object? EnumOperator(string name, List<object?> operands)
    {
        if (operands.Count == 0 || operands.Any(operand => operand is not Enum) || operands.Select(operand => operand!.GetType()).Distinct().Count() != 1)
            return null;
        var type = operands[0]!.GetType();
        var values = operands.Select(operand => Convert.ToInt64(operand, CultureInfo.InvariantCulture)).ToList();
        long? combined = (name, values.Count) switch
        {
            ("op_BitwiseOr", 2) => values[0] | values[1],
            ("op_BitwiseAnd", 2) => values[0] & values[1],
            ("op_ExclusiveOr", 2) => values[0] ^ values[1],
            ("op_OnesComplement", 1) => ~values[0],
            _ => null,
        };
        return combined is { } number ? Enum.ToObject(type, number) : null;
    }

    /// <summary>&lt; &lt;= &gt; &gt;= through IComparable when the type defines no operator, for two values of one type.</summary>
    private static JsonNode? Compare(string name, List<object?> operands)
    {
        if (operands is not [IComparable left, { } right] || left.GetType() != right.GetType())
            return null;
        var order = Invoke(() => left.CompareTo(right)) is int compared ? compared : 0;
        return name switch
        {
            "op_LessThan" => order < 0,
            "op_LessThanOrEqual" => order <= 0,
            "op_GreaterThan" => order > 0,
            "op_GreaterThanOrEqual" => order >= 0,
            _ => null,
        };
    }

    private Type TypeOf(JsonNode? node) =>
        node is JsonObject reference && reference["$path"] is { } path && ResolvePath(path.GetValue<string>()) is TypeReference type
            ? type.Type
            : throw new BridgeException("invalid_argument", "isinstance and issubclass take a Revit API type, for example DB.Wall.");

    private static int Depth(Type? type)
    {
        var depth = 0;
        for (; type is not null; type = type.BaseType)
            depth++;
        return depth;
    }

    internal static string TypeName(Type type)
    {
        if (!type.IsGenericType)
            return type.FullName ?? type.Name;
        var name = type.GetGenericTypeDefinition().FullName ?? type.Name;
        return $"{name[..name.IndexOf('`')]}<{string.Join(", ", type.GetGenericArguments().Select(TypeName))}>";
    }
}
