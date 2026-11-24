using System.Reflection;
using System.Runtime.InteropServices;
using DriveIt.Core.Bridge;

namespace DriveIt.Core.Tests;

/// <summary>Spec #16 "The API in Python": named arguments and clr.Reference / StrongBox boxes for out and ref parameters.</summary>
public class OverloadsBindingTests
{
    public sealed class Mapping
    {
        public List<string> Curves { get; } = [];
    }

    public sealed class Creation
    {
        public string NewFootPrintRoof(string footprint, int level, string roofType, [In, Out] ref Mapping mapping)
        {
            ArgumentNullException.ThrowIfNull(mapping);
            mapping.Curves.Add(footprint);
            return "roof";
        }

        public bool LoadFamily(string path, out string family)
        {
            family = Path.GetFileNameWithoutExtension(path);
            return true;
        }

        public string Place(double x, double y, string name = "desk") => $"{name}@{x},{y}";

        public void Bump(ref int counter) => counter++;
    }

    /// <summary>A box is a Box(start) value; the converter unwraps it for a by-reference parameter, as BridgeCalls does.</summary>
    private sealed record Box(object? Start);

    private static Overloads.ArgumentConverter Converter(object?[] values) =>
        (int index, Type type, out object? value, out int score) =>
        {
            value = values[index];
            score = 0;
            if (type.IsByRef)
            {
                if (value is not Box box)
                    return false;
                value = box.Start;
                type = type.GetElementType()!;
                if (value is null)
                {
                    score = 100;
                    return true;
                }
            }
            if (value is int number && type == typeof(double))
                (value, score) = ((double)number, 70);
            else if (value is not null && type.IsInstanceOfType(value))
                score = 100;
            return score > 0;
        };

    private static (MethodBase? Method, object?[] Converted, int[] Slots) Select(string name, params (string? Name, object? Value)[] arguments)
    {
        var shape = arguments.Select(argument => new Overloads.Argument(argument.Name, argument.Value is Box)).ToArray();
        var method = Overloads.Select(typeof(Creation).GetMethods().Where(method => method.Name == name), shape,
            Converter(arguments.Select(argument => argument.Value).ToArray()), out var converted, out var slots);
        return (method, converted, slots);
    }

    [Fact]
    public void NamedArguments_FillTheParameterOfThatName_InAnyOrder()
    {
        var (method, converted, slots) = Select("Place", (null, 1), ("name", "chair"), ("y", 2));

        Assert.NotNull(method);
        Assert.Equal(new object?[] { 1.0, 2.0, "chair" }, converted);
        Assert.Equal(new[] { 0, 2, 1 }, slots);
    }

    [Theory]
    [InlineData("z")]
    [InlineData("x")]
    public void A_NamedArgument_ThatNamesNoParameter_OrOneAlreadyGiven_DoesNotMatch(string name)
    {
        Assert.Null(Select("Place", (null, 1), (null, 2), (name, 3)).Method);
    }

    [Fact]
    public void A_PositionalArgument_AfterANamedOne_DoesNotMatch()
    {
        Assert.Null(Select("Place", ("x", 1), (null, 2)).Method);
    }

    [Fact]
    public void An_EmptyBox_TakesTheOutParameter_AndItsValueStaysOutOfTheTuple()
    {
        var (method, converted, slots) = Select("LoadFamily", (null, "C:/families/Desk.rfa"), (null, new Box(null)));

        Assert.NotNull(method);
        Assert.Equal(1, slots[1]);
        var result = method!.Invoke(new Creation(), converted);
        Assert.Equal("Desk", converted[1]);
        Assert.Null(Overloads.Outputs(method, result, converted, new HashSet<int> { 1 }));
    }

    [Fact]
    public void A_BoxWithAStartingValue_IsWhatTheCalleeFills()
    {
        var mapping = new Mapping();
        var (method, converted, _) = Select("NewFootPrintRoof", (null, "footprint"), (null, 30), (null, "Generic"), (null, new Box(mapping)));

        Overloads.SupplyOutputs(method!, converted, _ => new Mapping());
        Assert.Equal("roof", method!.Invoke(new Creation(), converted));

        Assert.Same(mapping, converted[3]);
        Assert.Equal(new[] { "footprint" }, mapping.Curves);
    }

    [Fact]
    public void An_EmptyBox_ForAnOutRevitFillsInPlace_GetsTheSuppliedObject()
    {
        var (method, converted, _) = Select("NewFootPrintRoof", (null, "footprint"), (null, 30), (null, "Generic"), ("mapping", new Box(null)));

        Overloads.SupplyOutputs(method!, converted, _ => new Mapping());
        method!.Invoke(new Creation(), converted);

        Assert.Equal(new[] { "footprint" }, Assert.IsType<Mapping>(converted[3]).Curves);
    }

    [Fact]
    public void A_RefParameter_TakesOnlyABox()
    {
        Assert.Null(Select("Bump", (null, 4)).Method);
        var (method, converted, _) = Select("Bump", (null, new Box(4)));

        method!.Invoke(new Creation(), converted);

        Assert.Equal(5, converted[0]);
    }

    [Fact]
    public void A_Box_ForAnInputParameter_DoesNotMatch()
    {
        Assert.Null(Select("Place", (null, new Box(1)), (null, 2)).Method);
    }
}
