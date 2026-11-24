using System.Reflection;

namespace DriveIt.Core.Bridge;

/// <summary>
/// How the API bridge (spec #15 "What a Script Sees") picks a Revit API overload and hands back its out
/// parameters, with no Revit reference so it is unit-tested on any OS. The add-in's BridgeCalls supplies the
/// argument conversion and the objects Revit expects in out parameters.
/// </summary>
public static class Overloads
{
    /// <summary>Converts the script's argument at that position to a parameter type; a higher score is a closer match.</summary>
    public delegate bool ArgumentConverter(int argument, Type parameterType, out object? value, out int score);

    /// <summary>An output by-reference parameter: it takes no argument and comes back with the result.</summary>
    public static bool IsOut(ParameterInfo parameter) => parameter.ParameterType.IsByRef && parameter.IsOut;

    /// <summary>
    /// The closest overload for these arguments, given positionally to the inputs. Out parameters take no argument;
    /// ref (input/output) parameters and params arrays are not supported, so those overloads never match.
    /// <paramref name="converted"/> holds one slot per parameter, out slots null.
    /// </summary>
    public static MethodBase? Select(IEnumerable<MethodBase> candidates, int argumentCount, ArgumentConverter convert, out object?[] converted)
    {
        MethodBase? best = null;
        var bestScore = int.MinValue;
        converted = [];
        foreach (var candidate in candidates.OrderBy(method => method.GetParameters().Length))
        {
            var parameters = candidate.GetParameters();
            if (parameters.Any(parameter => (parameter.ParameterType.IsByRef && !IsOut(parameter)) || parameter.IsDefined(typeof(ParamArrayAttribute))))
                continue;
            var inputs = parameters.Count(parameter => !IsOut(parameter));
            var required = parameters.Count(parameter => !IsOut(parameter) && !parameter.IsOptional);
            if (argumentCount < required || argumentCount > inputs)
                continue;
            var values = new object?[parameters.Length];
            var score = 0;
            var matches = true;
            var next = 0;
            for (var index = 0; index < parameters.Length && matches; index++)
            {
                if (IsOut(parameters[index]))
                    continue;
                if (next >= argumentCount)
                {
                    values[index] = parameters[index].HasDefaultValue ? parameters[index].DefaultValue : Type.Missing;
                    continue;
                }
                matches = convert(next++, parameters[index].ParameterType, out values[index], out var argumentScore);
                score += argumentScore;
            }
            if (!matches || score <= bestScore)
                continue;
            best = candidate;
            bestScore = score;
            converted = values;
        }
        return best;
    }

    /// <summary>
    /// Fills each out slot with what <paramref name="supply"/> gives for the parameter's type (null leaves it null).
    /// Revit's API is C++/CLI and some of its out parameters are filled in place: NewFootPrintRoof(footprint, level,
    /// roofType, out ModelCurveArray) throws ArgumentNullException unless the caller passes a ModelCurveArray in.
    /// </summary>
    public static void SupplyOutputs(MethodBase method, object?[] arguments, Func<Type, object?> supply)
    {
        foreach (var parameter in method.GetParameters().Where(IsOut))
            arguments[parameter.Position] = supply(parameter.ParameterType.GetElementType()!);
    }

    /// <summary>
    /// After the call: null when the method has no out parameters; otherwise its return value (unless void)
    /// followed by each out value in parameter order.
    /// </summary>
    public static IReadOnlyList<object?>? Outputs(MethodBase method, object? result, object?[] arguments)
    {
        var outs = method.GetParameters().Where(IsOut).ToList();
        if (outs.Count == 0)
            return null;
        var values = new List<object?>();
        if (method is MethodInfo { ReturnType: var returnType } && returnType != typeof(void))
            values.Add(result);
        values.AddRange(outs.Select(parameter => arguments[parameter.Position]));
        return values;
    }
}
