using System.Reflection;
using System.Runtime.InteropServices;
using DriveIt.Core.Bridge;

namespace DriveIt.Core.Tests;

/// <summary>The API bridge's overload matching and out values (spec #15), against stand-ins for Revit's signatures.</summary>
public class OverloadsTests
{
    public sealed class Mapping
    {
        public List<string> Curves { get; } = [];
    }

    public sealed class Roof;

    /// <summary>Stand-ins for Revit API methods; Revit's C++/CLI out parameters reflect as by-reference with the Out flag, and the callee reads what comes in.</summary>
    public sealed class Creation
    {
        /// <summary>Like Creation.Document.NewFootPrintRoof: the mapping is an out parameter Revit fills in place, refusing null.</summary>
        public Roof NewFootPrintRoof(string footprint, int level, string roofType, [In, Out] ref Mapping mapping)
        {
            ArgumentNullException.ThrowIfNull(mapping);
            mapping.Curves.Add(footprint);
            return new Roof();
        }

        /// <summary>Like Document.LoadFamily(path, out Family): the callee assigns the out value.</summary>
        public bool LoadFamily(string path, out string family)
        {
            family = Path.GetFileNameWithoutExtension(path);
            return true;
        }

        public void Measure(out double length, out double width)
        {
            length = 12;
            width = 56;
        }

        public string Pick(int value) => "int";

        public string Pick(double value) => "double";

        public string Pick(int value, ref int counter) => "ref";

        public string Pick(params int[] values) => "params";

        public int Offset(int value, int by = 7) => value + by;
    }

    private static readonly Func<Type, object?> RevitAllocates = type => type == typeof(Mapping) ? new Mapping() : null;

    /// <summary>Script arguments: an int converts to int (100) or double (70), a string to string (100).</summary>
    private static Overloads.ArgumentConverter Converter(object?[] arguments) =>
        (int index, Type type, out object? value, out int score) =>
        {
            value = arguments[index];
            score = 0;
            if (value is int number && type == typeof(double))
                (value, score) = ((double)number, 70);
            else if ((value is int && type == typeof(int)) || (value is string && type == typeof(string)))
                score = 100;
            return score > 0;
        };

    private static MethodBase? Select(string name, object?[] arguments, out object?[] converted) =>
        Overloads.Select(typeof(Creation).GetMethods().Where(method => method.Name == name), arguments.Length, Converter(arguments), out converted);

    private static IReadOnlyList<object?>? Call(string name, params object?[] arguments)
    {
        var method = Select(name, arguments, out var converted) ?? throw new MissingMethodException(nameof(Creation), name);
        Overloads.SupplyOutputs(method, converted, RevitAllocates);
        var result = method.Invoke(new Creation(), converted);
        return Overloads.Outputs(method, result, converted) ?? new[] { result };
    }

    [Fact]
    public void Select_MatchesTheInputs_AndLeavesTheOutSlotForTheBridge()
    {
        var method = Select("NewFootPrintRoof", ["footprint", 30, "Generic - 12\""], out var converted);

        Assert.NotNull(method);
        Assert.Equal(new object?[] { "footprint", 30, "Generic - 12\"", null }, converted);
    }

    [Fact]
    public void Select_RefusesAnArgumentForTheOutParameter()
    {
        Assert.Null(Select("NewFootPrintRoof", ["footprint", 30, "Generic", new Mapping()], out _));
    }

    [Fact]
    public void NewFootPrintRoof_ReturnsTheRoof_ThenTheMappingRevitFilled()
    {
        var values = Call("NewFootPrintRoof", "footprint", 30, "Generic");

        Assert.NotNull(values);
        Assert.Collection(values,
            roof => Assert.IsType<Roof>(roof),
            mapping => Assert.Equal(new[] { "footprint" }, Assert.IsType<Mapping>(mapping).Curves));
    }

    [Fact]
    public void AnOutSlotLeftNull_IsWhatRevitRefused_InTheTrial()
    {
        var method = Select("NewFootPrintRoof", ["footprint", 30, "Generic"], out var converted)!;

        var error = Assert.Throws<TargetInvocationException>(() => method.Invoke(new Creation(), converted));

        Assert.IsType<ArgumentNullException>(error.InnerException);
    }

    [Fact]
    public void SupplyOutputs_LeavesTypesNobodyAllocatesNull_AndTheCalleeAssignsThem()
    {
        var method = Select("LoadFamily", ["C:/families/Desk.rfa"], out var converted)!;

        Overloads.SupplyOutputs(method, converted, RevitAllocates);

        Assert.Null(converted[1]);
        Assert.Equal(new object?[] { true, "Desk" }, Call("LoadFamily", "C:/families/Desk.rfa"));
    }

    [Fact]
    public void Outputs_OfAVoidMethod_AreOnlyItsOutValues_InParameterOrder()
    {
        Assert.Equal(new object?[] { 12.0, 56.0 }, Call("Measure"));
    }

    [Fact]
    public void Outputs_AreNull_WhenTheMethodHasNoOutParameters()
    {
        var method = typeof(Creation).GetMethod(nameof(Creation.Offset))!;

        Assert.Null(Overloads.Outputs(method, 8, [1, 7]));
    }

    [Theory]
    [InlineData(new object[] { 3 }, "int")]
    [InlineData(new object[] { 3, 4 }, null)]
    public void Select_PrefersTheClosestInput_AndNeverMatchesRefOrParams(object[] arguments, string? expected)
    {
        var method = Select("Pick", arguments, out var converted);

        Assert.Equal(expected, method?.Invoke(new Creation(), converted));
    }

    [Fact]
    public void Select_FillsAnOmittedOptionalInput_WithItsDefault()
    {
        Assert.Equal(new object?[] { 10 }, Call("Offset", 3));
    }
}
