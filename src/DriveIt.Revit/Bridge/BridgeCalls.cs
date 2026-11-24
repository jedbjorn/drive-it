using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using DriveIt.Core.Bridge;
using DriveIt.Core.Mode;

namespace DriveIt.Revit.Bridge;

/// <summary>A bridge call the script made wrongly or Revit refused; the script receives RevitError with it.</summary>
public sealed class BridgeException(string code, string message, Exception? cause = null) : Exception(message, cause)
{
    public string Code { get; } = code;
}

/// <summary>A Revit API type named by a DB path, e.g. DB.XYZ or DB.Wall. Never handed to a script as a System.Type.</summary>
internal sealed record TypeReference(Type Type)
{
    public override string ToString() => Type.FullName ?? Type.Name;
}

/// <summary>A method's return value followed by its out parameters; crosses to the script as a tuple.</summary>
internal sealed record OutValues(IReadOnlyList<object?> Values);

/// <summary>
/// Resolves a script's bridge calls by reflection, on Revit's thread, against the run's handle table.
/// Numbers, strings, booleans and null cross by value; everything else is a handle that lasts for the run.
/// </summary>
internal sealed class BridgeCalls(IHeldDocuments held, Func<bool> transactionOpen)
{
    public const string RootNamespace = "Autodesk.Revit.DB";
    private const int DefaultChunk = 256;
    private const int MaximumChunk = 4096;
    /// <summary>A System.DateTime on the wire, as Python's datetime.isoformat(timespec="microseconds") writes it without an offset.</summary>
    private const string DateTimeWire = "yyyy-MM-dd'T'HH:mm:ss.ffffff";
    private static readonly Assembly RevitApi = typeof(Document).Assembly;
    private static readonly HashSet<Type> OwnedByDriveIt = [typeof(Transaction), typeof(TransactionGroup), typeof(SubTransaction)];
    private static readonly Dictionary<string, Type?> TypeCache = new(StringComparer.Ordinal);

    /// <summary>The Python operators the bridge runs, by the .NET operator method Revit defines for each.</summary>
    private static readonly Dictionary<string, string> Operators = new(StringComparer.Ordinal)
    {
        ["op_Addition"] = "+", ["op_Subtraction"] = "-", ["op_Multiply"] = "*", ["op_Division"] = "/", ["op_UnaryNegation"] = "-",
    };

    private readonly Dictionary<long, object> objects = new();
    private readonly Dictionary<object, long> ids = new(ReferenceEqualityComparer.Instance);
    /// <summary>The Transaction, SubTransaction and TransactionGroup objects a Dev Mode script made, in the order it made them.</summary>
    private readonly List<object> scriptTransactions = [];
    private long nextId;

    public int HandleCount => objects.Count;

    /// <summary>True while a transaction or group a Dev Mode script made is still started.</summary>
    public bool ScriptTransactionOpen => scriptTransactions.Any(owned => Status(owned) == TransactionStatus.Started);

    public void Clear()
    {
        foreach (var owned in scriptTransactions)
            (owned as IDisposable)?.Dispose();
        scriptTransactions.Clear();
        objects.Clear();
        ids.Clear();
    }

    /// <summary>
    /// Rolls back every transaction and group a Dev Mode script left started, the last one made first, so the hold can
    /// close its own group (spec #10: a transaction the script leaves open is rolled back when the run ends).
    /// </summary>
    public void RollBackScriptTransactions()
    {
        for (var index = scriptTransactions.Count - 1; index >= 0; index--)
        {
            var owned = scriptTransactions[index];
            try
            {
                if (Status(owned) != TransactionStatus.Started)
                    continue;
                _ = owned switch
                {
                    Transaction transaction => transaction.RollBack(),
                    SubTransaction subTransaction => subTransaction.RollBack(),
                    TransactionGroup group => group.RollBack(),
                    _ => TransactionStatus.Uninitialized,
                };
            }
            catch (Exception exception)
            {
                System.Diagnostics.Trace.WriteLine($"Drive-It: rolling back a script's {owned.GetType().Name} failed ({exception.GetType().Name}: {exception.Message}).");
            }
        }
    }

    private static TransactionStatus Status(object owned)
    {
        try
        {
            return owned switch
            {
                Transaction { IsValidObject: true } transaction => transaction.GetStatus(),
                SubTransaction { IsValidObject: true } subTransaction => subTransaction.GetStatus(),
                TransactionGroup { IsValidObject: true } group => group.GetStatus(),
                _ => TransactionStatus.Uninitialized,
            };
        }
        catch (Exception exception) when (exception is InvalidOperationException or Autodesk.Revit.Exceptions.InvalidOperationException)
        {
            return TransactionStatus.Uninitialized;
        }
    }

    public JsonNode? Get(JsonObject call)
    {
        var member = RequireMember(call);
        var target = Target(call);
        if (target is TypeReference type)
            return Encode(StaticMember(type.Type, member));
        if (HasMethod(target.GetType(), member, BindingFlags.Instance))
            return new JsonObject { ["$method"] = member };
        return Encode(InstanceMember(target, member));
    }

    public JsonNode? Set(JsonObject call)
    {
        var member = RequireMember(call);
        var target = Target(call);
        var (type, flags, instance) = target is TypeReference reference
            ? (reference.Type, BindingFlags.Static, (object?)null)
            : (target.GetType(), BindingFlags.Instance, target);
        var property = FindProperty(type, member, flags);
        if (property is not null)
        {
            if (property.SetMethod is not { IsPublic: true })
                throw new BridgeException("member_read_only", $"{TypeName(type)}.{member} cannot be set.");
            if (!TryConvert(call["value"], property.PropertyType, out var value, out _))
                throw new BridgeException("invalid_argument",
                    $"{TypeName(type)}.{member} takes {TypeName(property.PropertyType)}; the value given does not convert to it.");
            Invoke(type, member, () => property.SetValue(instance, value), instance, [value]);
            return null;
        }
        var field = type.GetField(member, BindingFlags.Public | flags);
        if (field is null || field.IsInitOnly || field.IsLiteral)
            throw MemberNotFound(type, member, flags);
        if (!TryConvert(call["value"], field.FieldType, out var fieldValue, out _))
            throw new BridgeException("invalid_argument",
                $"{TypeName(type)}.{member} takes {TypeName(field.FieldType)}; the value given does not convert to it.");
        Invoke(type, member, () => field.SetValue(instance, fieldValue), instance, [fieldValue]);
        return null;
    }

    /// <summary>
    /// A method call on a handle, a static method on a DB type (target path with member), or a constructor
    /// (target path naming a type, no member).
    /// </summary>
    public JsonNode? Call(JsonObject call)
    {
        var arguments = call["args"] as JsonArray ?? [];
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
    private JsonNode? CallPath(string path, JsonArray arguments)
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
            return Encode(Invoke(array.GetType(), "GetValue", () => array.GetValue((int)position!)));
        }
        if (!HasMethod(target.GetType(), "get_Item", BindingFlags.Instance))
            throw new BridgeException("not_indexable", $"A {TypeName(target.GetType())} cannot be indexed.");
        return Encode(InvokeMethod(target.GetType(), target, "get_Item", [key?.DeepClone()], BindingFlags.Instance));
    }

    /// <summary>Starts walking a collection: the first chunk of items, and an iterator handle while more remain.</summary>
    public JsonNode Iterate(JsonObject call)
    {
        var target = Instance(call);
        if (target is string || target is not IEnumerable enumerable)
            throw new BridgeException("not_iterable", $"A {TypeName(target.GetType())} is not a collection.");
        var enumerator = Invoke(target.GetType(), "GetEnumerator", () => enumerable.GetEnumerator())!;
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
            _ => Invoke(target.GetType(), "Count", () => (FindProperty(target.GetType(), "Count", BindingFlags.Instance)
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
        return Invoke(target.GetType(), "Equals", () => target.Equals(other)) is true;
    }

    public JsonNode? Text(JsonObject call) => Target(call) switch
    {
        TypeReference reference => reference.ToString(),
        var target => (string?)Invoke(target.GetType(), "ToString", () => target.ToString()),
    };

    /// <summary>
    /// A Python operator on Revit values (p2 - p1, p * 2, -p): Revit's own operator method that either operand's type
    /// defines for these operands. The worker does no arithmetic of its own.
    /// </summary>
    public JsonNode? Operator(JsonObject call)
    {
        var name = call["operator"]?.GetValue<string>();
        if (name is null || !Operators.TryGetValue(name, out var symbol))
            throw new BridgeException("invalid_call", $"'{name}' is not an operator the bridge runs.");
        var arguments = call["args"] as JsonArray ?? [];
        var operands = arguments.Select(node => TryConvert(node, typeof(object), out var value, out _)
            ? value
            : throw new BridgeException("invalid_argument", "An operand is not a value that crosses to Revit.")).ToList();
        var candidates = operands.Where(operand => operand is not null and not TypeReference).Select(operand => operand!.GetType()).Distinct()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static))
            .Where(method => method.Name == name && method.GetParameters().Length == arguments.Count)
            .Distinct()
            .ToList();
        if (SelectOverload(candidates, arguments, out var converted) is { } method)
            return Encode(Invoke(method.DeclaringType!, name, () => method.Invoke(null, converted), null, converted));
        throw new BridgeException("operator_not_supported",
            $"Revit defines no {symbol} for {string.Join(" and ", operands.Select(Operand))}.");
    }

    private static string Operand(object? operand) => operand switch
    {
        null => "None",
        TypeReference reference => $"the type {reference}",
        string => "a string",
        bool => "a boolean",
        long or double => "a number",
        _ => TypeName(operand.GetType()),
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
        Invoke(enumerator.GetType(), "MoveNext", () =>
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
            case DateTime moment:
                return new JsonObject
                {
                    ["$datetime"] = moment.ToString(DateTimeWire, CultureInfo.InvariantCulture),
                    ["utc"] = moment.Kind == DateTimeKind.Utc,
                };
            case OutValues tuple:
                return new JsonObject { ["$tuple"] = new JsonArray(tuple.Values.Select(Encode).ToArray()) };
            case Type type when !InstallMode.IsDev:
                // el.GetType(), or any member that returns a type: its names as text, never a handle to a System.Type.
                // In Dev Mode a type gets a handle like any other object (spec #10).
                return new JsonObject
                {
                    ["$type"] = new JsonObject { ["Name"] = type.Name, ["FullName"] = TypeName(type), ["Namespace"] = type.Namespace },
                };
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
        throw new BridgeException("member_not_found", $"'{path}' does not name a Revit API type or member.");
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

    private object? StaticMember(Type type, string member)
    {
        if (FindReadable(type, member, BindingFlags.Static) is { } property)
            return Invoke(type, member, () => property.GetValue(null));
        if (FindProperty(type, member, BindingFlags.Static) is not null)
            throw WriteOnly(type, member);
        if (type.GetField(member, BindingFlags.Public | BindingFlags.Static) is { } field)
            return Invoke(type, member, () => field.GetValue(null));
        if (HasMethod(type, member, BindingFlags.Static))
            throw new BridgeException("member_is_method", $"{TypeName(type)}.{member} is a method; call it.");
        throw MemberNotFound(type, member, BindingFlags.Static);
    }

    private object? InstanceMember(object target, string member)
    {
        var type = target.GetType();
        if (FindReadable(type, member, BindingFlags.Instance) is { } property)
            return Invoke(type, member, () => property.GetValue(target), target);
        if (FindProperty(type, member, BindingFlags.Instance) is not null)
            throw WriteOnly(type, member);
        if (type.GetField(member, BindingFlags.Public | BindingFlags.Instance) is { } field)
            return Invoke(type, member, () => field.GetValue(target), target);
        throw MemberNotFound(type, member, BindingFlags.Instance);
    }

    /// <summary>
    /// The property a read goes through: the most derived declaration of that name with a public getter, as C# reads
    /// wallType.Name. Revit declares some properties on a subtype only to set them (ElementType.Name,
    /// SpatialElement.Name), and reading through that declaration threw "Property Get method was not found".
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
        $"{type.Name}.{member} cannot be read: Revit's API only sets it. Read the value another way, for example a parameter with get_Parameter(...).");

    /// <summary>The most derived public, non-indexed property of that name (a derived type may hide a base one).</summary>
    private static PropertyInfo? FindProperty(Type type, string name, BindingFlags flags) =>
        type.GetProperties(BindingFlags.Public | flags)
            .Where(property => property.Name == name && property.GetIndexParameters().Length == 0)
            .OrderByDescending(property => Depth(property.DeclaringType))
            .FirstOrDefault();

    private static bool HasMethod(Type type, string name, BindingFlags flags) =>
        type.GetMethods(BindingFlags.Public | flags).Any(method => method.Name == name);

    private object Construct(Type type, JsonArray arguments)
    {
        var owned = OwnedByDriveIt.Contains(type);
        if (owned && !InstallMode.IsDev)
            throw new BridgeException("member_not_allowed",
                $"Drive-It owns every transaction; a script cannot create a {type.Name}. Put Revit changes inside `with revit.transaction(\"name\"):`.");
        if (type.IsAbstract)
            throw new BridgeException("not_constructible", $"{TypeName(type)} is abstract and cannot be constructed.");
        var constructor = SelectOverload(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance), arguments, out var converted)
            ?? throw NoMatch(type, ".ctor", type.GetConstructors(BindingFlags.Public | BindingFlags.Instance), arguments);
        // A Dev Mode script's transaction runs inside the run's group on its document, so a failed run still rolls it back.
        if (owned)
            held.BeforeTransaction(converted.OfType<Document>().First());
        var made = Invoke(type, "constructor", () => ((ConstructorInfo)constructor).Invoke(converted), null, converted)!;
        if (owned)
            scriptTransactions.Add(made);
        return made;
    }

    private object? InvokeMethod(Type type, object? target, string name, JsonArray arguments, BindingFlags flags)
    {
        Guardrails.RequireCallable(type, name);
        var candidates = type.GetMethods(BindingFlags.Public | flags)
            .Where(method => method.Name == name && !method.ContainsGenericParameters)
            .ToList();
        if (candidates.Count == 0)
            throw MemberNotFound(type, name, flags);
        var method = SelectOverload(candidates, arguments, out var converted)
            ?? throw NoMatch(type, name, candidates, arguments);
        // Reached only in Dev Mode (standard refuses these calls): keep the run's changes before a direct save or close, as the built-in does.
        if (target is Document document && Guardrails.IsCommitPoint(type, name))
            held.CommitPoint(document);
        Overloads.SupplyOutputs(method, converted, Output);
        var result = Invoke(type, name, () => method.Invoke(target, converted), target, converted);
        // Out parameters come back after the return value, as a Python tuple; a single value comes back as itself.
        return Overloads.Outputs(method, result, converted) switch
        {
            null => result,
            [var single] => single,
            { } values => new OutValues(values),
        };
    }

    /// <summary>
    /// What an out parameter starts as: a new Revit API object when its type is one Drive-It can construct with no
    /// arguments (Revit fills NewFootPrintRoof's ModelCurveArray in place and refuses null), otherwise null.
    /// Nothing the script gives goes in; ref parameters stay unsupported.
    /// </summary>
    private object? Output(Type type) =>
        type.Assembly == RevitApi && type is { IsClass: true, IsAbstract: false } && !OwnedByDriveIt.Contains(type)
            && type.GetConstructor(Type.EmptyTypes) is { } constructor
            ? Invoke(type, "constructor", () => constructor.Invoke(null))
            : null;

    private static bool IsOut(ParameterInfo parameter) => Overloads.IsOut(parameter);

    /// <summary>No overload fits: a callback Revit asks for is named, otherwise every signature is listed.</summary>
    private static BridgeException NoMatch(Type type, string name, IEnumerable<MethodBase> candidates, JsonArray arguments)
    {
        var callback = candidates
            .Select(method => method.GetParameters().Where(parameter => !IsOut(parameter)).ToArray())
            .Where(inputs => inputs.Length >= arguments.Count)
            .SelectMany(inputs => inputs.Select((parameter, index) => (parameter.ParameterType, index)))
            .FirstOrDefault(entry => Guardrails.IsUnsupportedCallback(entry.ParameterType)
                && (entry.index >= arguments.Count || arguments[entry.index] is not JsonObject { } given || given["$option"] is null));
        return callback.ParameterType is not null
            ? Guardrails.CallbackNotSupported(type, name, callback.ParameterType)
            : NoOverload(type, name, candidates, arguments);
    }

    private MethodBase? SelectOverload(IEnumerable<MethodBase> candidates, JsonArray arguments, out object?[] converted) =>
        Overloads.Select(candidates, arguments.Count,
            (int index, Type parameterType, out object? value, out int score) => TryConvert(arguments[index], parameterType, out value, out score),
            out converted);

    /// <summary>Converts one script value to a parameter type; a higher score is a closer match.</summary>
    private bool TryConvert(JsonNode? node, Type target, out object? value, out int score)
    {
        value = null;
        score = 0;
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
            case JsonObject moment when moment["$datetime"] is { } text:
                return TryDateTime(text.GetValue<string>(), moment["utc"]?.GetValue<bool>() == true, target, out value, out score);
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

    /// <summary>
    /// A Python datetime as a System.DateTime: an aware one arrives in UTC and is marked Utc, a naive one Local
    /// (Python's own reading of a naive datetime; Revit refuses Unspecified, W10C 2026-11-24),
    /// so whether a value Revit returned was UTC survives the trip. Microseconds, Python's precision.
    /// </summary>
    private static bool TryDateTime(string text, bool utc, Type target, out object? value, out int score)
    {
        value = null;
        score = 0;
        if (target != typeof(DateTime) && target != typeof(object))
            return false;
        if (!DateTime.TryParseExact(text, DateTimeWire, CultureInfo.InvariantCulture, DateTimeStyles.None, out var moment))
            return false;
        value = DateTime.SpecifyKind(moment, utc ? DateTimeKind.Utc : DateTimeKind.Local);
        score = target == typeof(DateTime) ? 100 : 10;
        return true;
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

    /// <summary>
    /// Runs a reflected member of owner and surfaces what Revit threw, by its own message, after the type and member
    /// called (spec #16 "An API error names the member"). The target and arguments say which documents the call changes.
    /// </summary>
    private object? Invoke(Type owner, string member, Func<object?> action, object? target = null, object?[]? arguments = null)
    {
        try
        {
            return action();
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            throw Translate(exception.InnerException, owner, member, target, arguments);
        }
        catch (Exception exception) when (exception is not BridgeException)
        {
            throw Translate(exception, owner, member, target, arguments);
        }
    }

    private void Invoke(Type owner, string member, Action action, object? target = null, object?[]? arguments = null) =>
        Invoke(owner, member, () =>
        {
            action();
            return null;
        }, target, arguments);

    private BridgeException Translate(Exception exception, Type owner, string member, object? target, object?[]? arguments)
    {
        if (exception is BridgeException bridge)
            return bridge;
        var called = $"{owner.Name}.{member}";
        if (exception is Autodesk.Revit.Exceptions.ModificationOutsideTransactionException || ForbiddenOutsideTransaction(exception, target, arguments))
            return new BridgeException("modification_outside_transaction",
                $"{called}: {exception.Message} Put Revit changes inside `with revit.transaction(\"name\"):`.", exception);
        return new BridgeException("revit_api_error", ApiErrors.Message(owner.Name, member, exception), exception);
    }

    /// <summary>
    /// Revit's other refusal of a change with no transaction open: an InvalidOperationException, "Modification of the
    /// document is forbidden". It counts only when no transaction is open on the document the call changes (the
    /// target's or an argument's); when the call names no document, when the run has no transaction open at all.
    /// With one open, Revit forbade the change for another reason and the error stays revit_api_error.
    /// </summary>
    private bool ForbiddenOutsideTransaction(Exception exception, object? target, object?[]? arguments)
    {
        if (exception is not (InvalidOperationException or Autodesk.Revit.Exceptions.InvalidOperationException)
            || !exception.Message.Contains("Modification of the document is forbidden", StringComparison.Ordinal))
            return false;
        var documents = (arguments ?? []).Prepend(target).Select(DocumentOf).OfType<Document>().ToList();
        return documents.Count > 0 ? documents.Any(document => !document.IsModifiable) : !transactionOpen();
    }

    private static Document? DocumentOf(object? value) => value switch
    {
        Document document => document,
        Element element => element.Document,
        Parameter { Element: { } element } => element.Document,
        _ => null,
    };

    private static BridgeException MemberNotFound(Type type, string member, BindingFlags flags)
    {
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

    private static BridgeException NoOverload(Type type, string name, IEnumerable<MethodBase> candidates, JsonArray arguments)
    {
        var signatures = candidates.Select(method =>
            $"{(name == ".ctor" ? TypeName(type) : name)}({string.Join(", ", method.GetParameters().Select(Signature))})");
        var outs = candidates.Any(method => method.GetParameters().Any(IsOut))
            ? " Pass no argument for an out parameter; its value comes back after the return value, as a tuple."
            : "";
        return new BridgeException("no_matching_overload",
            $"No {TypeName(type)}.{(name == ".ctor" ? "constructor" : name)} takes these {arguments.Count} argument(s). It has: {string.Join("; ", signatures)}.{outs}");
    }

    /// <summary>A parameter as revit.describe writes by-reference ones: out ModelCurveArray mapping, not ModelCurveArray&amp;.</summary>
    private static string Signature(ParameterInfo parameter) => parameter.ParameterType.IsByRef
        ? $"{(IsOut(parameter) ? "out" : "ref")} {TypeName(parameter.ParameterType.GetElementType()!)} {parameter.Name}"
        : $"{TypeName(parameter.ParameterType)} {parameter.Name}";

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
