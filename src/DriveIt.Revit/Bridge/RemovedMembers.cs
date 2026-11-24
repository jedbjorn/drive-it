using Autodesk.Revit.DB;

namespace DriveIt.Revit.Bridge;

/// <summary>
/// Members older Revit examples use that Revit 2026's API no longer has (spec #16 "The API in Python"). Where an
/// exact equivalent exists the old spelling is read through it and the receipt gets a note; otherwise
/// member_not_found names the replacement. Each entry was confirmed against the running Revit 2026 on W10C-Testing:
/// the old name absent and the replacement present.
/// </summary>
internal static class RemovedMembers
{
    /// <summary>A read of a removed property that has an exact equivalent, and the note the receipt gets.</summary>
    public sealed record Accepted(Func<object?> Read, string Note);

    private static readonly Dictionary<(string Type, string Member), string> Replaced = new()
    {
        [("Autodesk.Revit.DB.Definition", "ParameterType")] = "Definition.GetDataType()",
        [("Autodesk.Revit.DB.Definition", "ParameterGroup")] = "Definition.GetGroupTypeId()",
        [("Autodesk.Revit.DB.Parameter", "DisplayUnitType")] = "Parameter.GetUnitTypeId()",
        [("Autodesk.Revit.DB.FormatOptions", "DisplayUnits")] = "FormatOptions.GetUnitTypeId()",
        [("Autodesk.Revit.Creation.Document", "NewLevel")] = "Level.Create(doc, elevation)",
        [("Autodesk.Revit.Creation.Document", "NewWall")] = "Wall.Create(doc, curve, levelId, structural)",
        [("Autodesk.Revit.Creation.Document", "NewFloor")] = "Floor.Create(doc, curveLoops, floorTypeId, levelId)",
        [("Autodesk.Revit.Creation.Document", "NewTextNote")] = "TextNote.Create(doc, viewId, position, text, typeId)",
        [("Autodesk.Revit.Creation.Document", "NewViewSheet")] = "ViewSheet.Create(doc, titleBlockTypeId)",
        [("Autodesk.Revit.Creation.Document", "NewViewPlan")] = "ViewPlan.Create(doc, viewFamilyTypeId, levelId)",
        [("Autodesk.Revit.Creation.Document", "NewView3D")] = "View3D.CreateIsometric(doc, viewFamilyTypeId)",
        [("Autodesk.Revit.Creation.Document", "NewGrid")] = "Grid.Create(doc, line)",
    };

    private static readonly Dictionary<string, string> ReplacedTypes = new(StringComparer.Ordinal)
    {
        ["Autodesk.Revit.DB.BuiltInParameterGroup"] = "GroupTypeId, for example GroupTypeId.Geometry",
        ["Autodesk.Revit.DB.ParameterType"] = "SpecTypeId, for example SpecTypeId.Length or SpecTypeId.String.Text",
        ["Autodesk.Revit.DB.DisplayUnitType"] = "UnitTypeId, for example UnitTypeId.Millimeters",
        ["Autodesk.Revit.DB.UnitType"] = "SpecTypeId, for example SpecTypeId.Length",
    };

    /// <summary>ElementId.IntegerValue reads ElementId.Value; Floor.SlabShapeEditor and RoofBase.SlabShapeEditor call GetSlabShapeEditor().</summary>
    public static Accepted? Accept(object target, string member) => (target, member) switch
    {
        (ElementId id, "IntegerValue") => new Accepted(() => id.Value,
            "ElementId.IntegerValue is not in Revit 2026's API; Drive-It read ElementId.Value, which replaces it."),
        (Floor floor, "SlabShapeEditor") => new Accepted(floor.GetSlabShapeEditor,
            "Floor.SlabShapeEditor is not in Revit 2026's API; Drive-It called Floor.GetSlabShapeEditor(), which replaces it."),
        (RoofBase roof, "SlabShapeEditor") => new Accepted(roof.GetSlabShapeEditor,
            "RoofBase.SlabShapeEditor is not in Revit 2026's API; Drive-It called RoofBase.GetSlabShapeEditor(), which replaces it."),
        _ => null,
    };

    /// <summary>member_not_found naming the replacement, when the type or a base had this member before Revit 2026.</summary>
    public static BridgeException? Redirect(Type type, string member)
    {
        for (var current = type; current is not null; current = current.BaseType)
        {
            if (Replaced.TryGetValue((current.FullName ?? current.Name, member), out var replacement))
                return new BridgeException("member_not_found",
                    $"{(current.FullName ?? current.Name).Replace("Autodesk.Revit.", "")}.{member} is not in Revit 2026's API; use {replacement} instead.");
        }
        return null;
    }

    /// <summary>member_not_found naming the replacement for a DB path through a removed type, e.g. DB.BuiltInParameterGroup.PG_GEOMETRY.</summary>
    public static BridgeException? RemovedType(string path)
    {
        foreach (var (name, replacement) in ReplacedTypes)
        {
            if (path == name || path.StartsWith(name + ".", StringComparison.Ordinal))
                return new BridgeException("member_not_found",
                    $"{name[(name.LastIndexOf('.') + 1)..]} is not in Revit 2026's API; use {replacement} instead.");
        }
        return null;
    }
}
