using System.Reflection;

namespace DriveIt.Core.Bridge;

/// <summary>
/// How the API bridge (spec #15 "What a Script Sees", spec #16 "The API in Python") picks a Revit API overload
/// and hands back its out parameters, with no Revit reference so it is unit-tested on any OS. The add-in's
/// BridgeCalls supplies the argument conversion and the objects Revit expects in out parameters.
/// </summary>
public static class Overloads
{
    /// <summary>Converts the script's argument at that position to a parameter type; a higher score is a closer match.</summary>
    public delegate bool ArgumentConverter(int argument, Type parameterType, out object? value, out int score);

    /// <summary>
    /// One argument as the script wrote it: positional (no name) or named, and whether it is a box
    /// (clr.Reference[T]() or clr.StrongBox[T]()) that only an out or ref parameter takes.
    /// </summary>
    public readonly record struct Argument(string? Name, bool IsBox);

    /// <summary>An output by-reference parameter: it takes no argument and comes back with the result.</summary>
    public static bool IsOut(ParameterInfo parameter) => parameter.ParameterType.IsByRef && parameter.IsOut;

    private static bool IsRef(ParameterInfo parameter) => parameter.ParameterType.IsByRef && !parameter.IsOut;

    /// <summary>
    /// The closest overload for these arguments, given positionally to the inputs. Out parameters take no argument;
    /// ref (input/output) parameters and params arrays are not supported, so those overloads never match.
    /// <paramref name="converted"/> holds one slot per parameter, out slots null.
    /// </summary>
    public static MethodBase? Select(IEnumerable<MethodBase> candidates, int argumentCount, ArgumentConverter convert, out object?[] converted) =>
        Select(candidates, Enumerable.Repeat(new Argument(null, false), argumentCount).ToArray(), convert, out converted, out _);

    /// <summary>
    /// The closest overload for these arguments. Positional arguments fill the inputs in order; an out parameter
    /// takes no argument unless the next one is a box, and a ref parameter takes only a box. Named arguments fill
    /// the parameter of that name. Params arrays never match. <paramref name="converted"/> holds one slot per
    /// parameter; <paramref name="slots"/> gives, for each argument, the parameter position it filled.
    /// </summary>
    public static MethodBase? Select(IEnumerable<MethodBase> candidates, IReadOnlyList<Argument> arguments, ArgumentConverter convert,
        out object?[] converted, out int[] slots)
    {
        MethodBase? best = null;
        var bestScore = int.MinValue;
        converted = [];
        slots = [];
        foreach (var candidate in candidates.OrderBy(method => method.GetParameters().Length))
        {
            var parameters = candidate.GetParameters();
            if (parameters.Any(parameter => parameter.IsDefined(typeof(ParamArrayAttribute))))
                continue;
            var map = Bind(parameters, arguments);
            if (map is null)
                continue;
            var values = new object?[parameters.Length];
            var score = 0;
            var matches = true;
            for (var index = 0; index < parameters.Length && matches; index++)
            {
                var argument = map[index];
                if (argument < 0)
                {
                    if (IsOut(parameters[index]))
                        continue;
                    if (IsRef(parameters[index]) || !parameters[index].IsOptional)
                    {
                        matches = false;
                        continue;
                    }
                    values[index] = parameters[index].HasDefaultValue ? parameters[index].DefaultValue : Type.Missing;
                    continue;
                }
                matches = convert(argument, parameters[index].ParameterType, out values[index], out var argumentScore);
                score += argumentScore;
            }
            if (!matches || score <= bestScore)
                continue;
            best = candidate;
            bestScore = score;
            converted = values;
            slots = new int[arguments.Count];
            for (var index = 0; index < map.Length; index++)
            {
                if (map[index] >= 0)
                    slots[map[index]] = index;
            }
        }
        return best;
    }

    /// <summary>For each parameter, the argument that fills it (-1 for none), or null when the arguments cannot fit.</summary>
    private static int[]? Bind(ParameterInfo[] parameters, IReadOnlyList<Argument> arguments)
    {
        var map = Enumerable.Repeat(-1, parameters.Length).ToArray();
        var next = 0;
        for (var index = 0; index < parameters.Length && next < arguments.Count && arguments[next].Name is null; index++)
        {
            var byReference = parameters[index].ParameterType.IsByRef;
            if (byReference && !arguments[next].IsBox)
            {
                if (IsOut(parameters[index]))
                    continue;
                return null;
            }
            if (!byReference && arguments[next].IsBox)
                return null;
            map[index] = next++;
        }
        if (next < arguments.Count && arguments[next].Name is null)
            return null;
        for (; next < arguments.Count; next++)
        {
            var argument = arguments[next];
            if (argument.Name is null)
                return null;
            var position = Array.FindIndex(parameters, parameter => parameter.Name == argument.Name);
            if (position < 0 || map[position] >= 0 || parameters[position].ParameterType.IsByRef != argument.IsBox)
                return null;
            map[position] = next;
        }
        return map;
    }

    /// <summary>
    /// Fills each out slot still empty with what <paramref name="supply"/> gives for the parameter's type (null leaves
    /// it null); a slot a box filled with a starting value keeps it. Revit's API is C++/CLI and some of its out
    /// parameters are filled in place: NewFootPrintRoof(footprint, level, roofType, out ModelCurveArray) throws
    /// ArgumentNullException unless the caller passes a ModelCurveArray in.
    /// </summary>
    public static void SupplyOutputs(MethodBase method, object?[] arguments, Func<Type, object?> supply)
    {
        foreach (var parameter in method.GetParameters().Where(IsOut))
            arguments[parameter.Position] ??= supply(parameter.ParameterType.GetElementType()!);
    }

    /// <summary>
    /// After the call: null when the method has no out parameters; otherwise its return value (unless void)
    /// followed by each out value in parameter order.
    /// </summary>
    public static IReadOnlyList<object?>? Outputs(MethodBase method, object? result, object?[] arguments) =>
        Outputs(method, result, arguments, new HashSet<int>());

    /// <summary>
    /// As above, leaving out the parameters a box filled (<paramref name="boxed"/> positions): their value goes back
    /// in the box, as IronPython does, so a call whose only out parameter took a box returns just its result.
    /// </summary>
    public static IReadOnlyList<object?>? Outputs(MethodBase method, object? result, object?[] arguments, IReadOnlySet<int> boxed)
    {
        var outs = method.GetParameters().Where(parameter => IsOut(parameter) && !boxed.Contains(parameter.Position)).ToList();
        if (outs.Count == 0)
            return null;
        var values = new List<object?>();
        if (method is MethodInfo { ReturnType: var returnType } && returnType != typeof(void))
            values.Add(result);
        values.AddRange(outs.Select(parameter => arguments[parameter.Position]));
        return values;
    }
}
