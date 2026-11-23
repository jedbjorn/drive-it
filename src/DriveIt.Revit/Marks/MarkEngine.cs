using System.Globalization;
using Autodesk.Revit.DB;
using DriveIt.Revit.Broker;

namespace DriveIt.Revit.Marks;

internal readonly struct V3(double x, double y, double z)
{
    public readonly double X = x, Y = y, Z = z;
    public static V3 Of(XYZ p) => new(p.X, p.Y, p.Z);
    public XYZ ToXyz() => new(X, Y, Z);
    public static V3 operator +(V3 a, V3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
    public static V3 operator -(V3 a, V3 b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
    public static V3 operator *(V3 a, double s) => new(a.X * s, a.Y * s, a.Z * s);
    public double Dot(V3 b) => X * b.X + Y * b.Y + Z * b.Z;
    public static V3 Lerp(V3 a, V3 b, double t) => a + (b - a) * t;
}

/// <summary>Keeps n·(p - o) ≥ 0. A cap plane is one the view cuts through, so a solid it cuts is capped.</summary>
internal sealed record ClipPlane(V3 Normal, V3 Origin, bool Cap)
{
    public double Distance(V3 p) => Normal.Dot(p - Origin);
}

/// <summary>
/// The view's outline mapping: a model point projected on View.Origin, RightDirection and
/// UpDirection, scaled by View.Outline times View.Scale to the image. Depth grows toward the viewer.
/// </summary>
internal sealed class Projection(V3 origin, V3 right, V3 up, V3 toward, double u0, double u1, double v0, double v1, int width, int height)
{
    public void Project(V3 p, out double x, out double y, out double depth)
    {
        var q = p - origin;
        x = (q.Dot(right) - u0) / (u1 - u0) * width;
        y = (v1 - q.Dot(up)) / (v1 - v0) * height;
        depth = q.Dot(toward);
    }
}

/// <summary>What a marked capture computed: the receipt, the circles to draw, and verification-only data.</summary>
internal sealed class MarkOutcome
{
    public MarksReceipt Receipt { get; init; } = new();
    public List<(double X, double Y, int Number)> Draw { get; init; } = [];
    public int Radius { get; init; }
    /// <summary>Per pixel, the index of the element the depth buffer says it shows, or a negative code.</summary>
    public int[] Regions { get; init; } = [];
    public List<string> Kinds { get; init; } = [];
    public List<double> Clearances { get; init; } = [];
    public Dictionary<string, int> Counts { get; init; } = [];
}

/// <summary>
/// Element marks for one exported view: which elements the image shows, and where a numbered circle
/// can name each one. Reads the document and view only; starts no transaction and creates no view.
/// Visibility is a software depth buffer at the image's own resolution over each element's view
/// geometry, clipped by the view's planes, then confirmed against the exported pixels.
/// </summary>
internal sealed class MarkEngine
{
    private const int Background = -1;
    private const int Ambiguous = -2;
    private const int OccluderOnly = -3;
    // A mark's centre needs this many pixels of the element around it.
    private const double MinimumClearance = 2.0;
    // Condition 4: a drawn pixel inside the element's region or within this many pixels of it.
    private const int ConfirmationRadius = 2;
    // A channel below this on every colour is drawn; Revit exports a white background.
    private const byte DrawnBelow = 245;
    // Placement tries at most this many of an element's pixels, most clearance first.
    private const int MaximumPlacementTries = 4000;

    private readonly Document document;
    private readonly View view;
    private readonly IReadOnlyList<long>? requested;
    private readonly HashSet<BuiltInCategory> categories;
    private readonly bool isPlan;
    private readonly bool isThreeD;
    private int width;
    private int height;
    private List<ClipPlane> planes = [];
    private Projection projection = null!;

    /// <summary>
    /// The scope is the union of the requested ids and the elements of the requested categories.
    /// Every element the view draws still occludes; only scope elements are placed or counted.
    /// </summary>
    public MarkEngine(Document document, View view, IReadOnlyList<long>? requested, IEnumerable<BuiltInCategory> categories)
    {
        this.document = document;
        this.view = view;
        this.requested = requested;
        this.categories = [.. categories];
        isPlan = view.ViewType is ViewType.FloorPlan or ViewType.CeilingPlan or ViewType.EngineeringPlan;
        isThreeD = view is View3D;
    }

    /// <summary>Why a view cannot carry marks, or null. Checked before the export.</summary>
    public static string? UnavailableReason(View view)
    {
        if (view is View3D { IsPerspective: true })
            return "it is a perspective 3D view, which has no fixed mapping from model points to image pixels; capture an orthographic 3D view, plan, elevation or section with marks, or capture this view without marks";
        if (view is ViewSection section && section.IsSplitSection())
            return "it is a split (segmented) section, which projects more than one plane; capture it without marks";
        try
        {
            var shape = view.GetCropRegionShapeManager();
            if (shape is not null && shape.Split)
                return "its crop region is split into offset regions; capture it without marks";
            if (shape is not null && view.CropBoxActive && shape.ShapeSet)
                return "it has a non-rectangular crop region; capture it without marks";
        }
        catch (Exception)
        {
            // Views without a crop shape manager (3D) have only the rectangular crop.
        }
        return null;
    }

    private static readonly HashSet<string> CategoryNames = [.. Enum.GetNames(typeof(BuiltInCategory))];

    /// <summary>
    /// Why a markCategories entry is refused, or null with its category: the name must be a
    /// BuiltInCategory member name, and a category never marked in any view is refused. Levels and
    /// grids are accepted; a 3D view just marks none of them.
    /// </summary>
    public static string? CategoryRefusal(Document document, string name, out BuiltInCategory category)
    {
        category = BuiltInCategory.INVALID;
        if (!name.StartsWith("OST_", StringComparison.Ordinal) || !CategoryNames.Contains(name)
            || !Enum.TryParse(name, ignoreCase: false, out category))
            return "it is not a BuiltInCategory member name; use the API name as a legend row's category returns it, such as OST_Walls or OST_Doors, not the display name";
        if (category is BuiltInCategory.OST_Levels or BuiltInCategory.OST_Grids)
            return null;
        Category? found;
        try
        {
            found = Category.GetCategory(document, category);
        }
        catch (Exception)
        {
            found = null;
        }
        if (NeverMarked(category) || category is BuiltInCategory.OST_CLines or BuiltInCategory.OST_RvtLinks
            || (found is not null && found.CategoryType != CategoryType.Model))
            return "elements of that category are never marked (annotations, rooms, areas, spaces, lines, reference planes and links get no marks)";
        return null;
    }

    /// <summary>Model categories that are never marked: spatial elements, lines, cameras, base points and the like.</summary>
    private static bool NeverMarked(BuiltInCategory category) =>
        category is BuiltInCategory.OST_Cameras or BuiltInCategory.OST_SectionBox
            or BuiltInCategory.OST_Rooms or BuiltInCategory.OST_Areas or BuiltInCategory.OST_MEPSpaces
            or BuiltInCategory.OST_RoomSeparationLines or BuiltInCategory.OST_AreaSchemeLines
            or BuiltInCategory.OST_SketchLines or BuiltInCategory.OST_Lines or BuiltInCategory.OST_PointClouds
            or BuiltInCategory.OST_ProjectBasePoint or BuiltInCategory.OST_SharedBasePoint
            or BuiltInCategory.OST_Viewers or BuiltInCategory.OST_Elev or BuiltInCategory.OST_MEPSpaceSeparationLines
            or BuiltInCategory.OST_HVAC_Zones or BuiltInCategory.OST_IOSModelGroups;

    /// <summary>In a family document a form (extrusion, blend, ...) has no category; it is the family's.</summary>
    private static Category? CategoryOf(Element element) =>
        element.Category ?? (element is GenericForm or FreeFormElement ? element.Document.OwnerFamily?.FamilyCategory : null);

    /// <summary>"model", "datum", or null for a kind that is never marked in this view.</summary>
    private string? KindOf(Element element)
    {
        if (element is Level or Grid)
            return isThreeD ? null : "datum";
        if (element is ElementType or View or Group or AssemblyInstance or SpatialElement or CurveElement
            or ReferencePlane or RevitLinkInstance or MultiSegmentGrid)
            return null;
        var category = CategoryOf(element);
        if (category is null || category.CategoryType != CategoryType.Model)
            return null;
        return NeverMarked(category.BuiltInCategory) ? null : "model";
    }

    private sealed class Candidate(Element element, string kind)
    {
        public Element Element { get; } = element;
        public string Kind { get; } = kind;
        public long Id => Element.Id.Value;
        public bool NoGeometry;
        public bool InFrame;
        public int Pixels;
        public bool Confirmed;
        public float MaxClear;
        public int MinX = int.MaxValue, MinY = int.MaxValue, MaxX = -1, MaxY = -1;
        public (double X, double Y)? Placed;
        public double PlacedClear;
        public string? Reason;
        public PixelBounds? Bounds => MaxX < 0 ? null : new PixelBounds { X = MinX, Y = MinY, Width = MaxX - MinX + 1, Height = MaxY - MinY + 1 };
    }

    public MarkOutcome Run(int imageWidth, int imageHeight, byte[] bgra)
    {
        width = imageWidth;
        height = imageHeight;
        planes = BuildPlanes();
        projection = BuildProjection();
        var radius = Math.Max(8, (int)Math.Round(Math.Max(width, height) / 90.0));

        // Candidates: what the view draws, less element and category hides.
        var model = new List<Candidate>();
        var datums = new List<Candidate>();
        var links = new List<Element>();
        var byId = new Dictionary<long, Candidate>();
        foreach (var element in new FilteredElementCollector(document, view.Id).WhereElementIsNotElementType().ToElements())
        {
            if (element is RevitLinkInstance)
            {
                links.Add(element);
                continue;
            }
            var kind = KindOf(element);
            if (kind is null || HiddenInView(element))
                continue;
            var candidate = new Candidate(element, kind);
            (kind == "datum" ? datums : model).Add(candidate);
            byId[candidate.Id] = candidate;
        }

        // The scope: elements of the requested categories, plus the requested ids. Requested ids the
        // view does not draw are answered now; the rest are placed below.
        var reasons = new Dictionary<long, string>();
        var wanted = new HashSet<long>(byId.Values
            .Where(c => categories.Contains(CategoryOf(c.Element)?.BuiltInCategory ?? BuiltInCategory.INVALID))
            .Select(c => c.Id));
        if (requested is not null)
        {
            foreach (var id in requested)
            {
                var element = document.GetElement(new ElementId(id));
                if (element is null)
                    reasons[id] = "not_found";
                else if (KindOf(element) is null)
                    reasons[id] = "not_markable";
                else if (!byId.ContainsKey(id))
                    reasons[id] = "not_in_view";
                else
                    wanted.Add(id);
            }
        }

        // Condition 3: every drawn model element occludes, whether or not it is to be marked.
        var ids = new int[width * height];
        Array.Fill(ids, Background);
        var depth = new float[width * height];
        Array.Fill(depth, float.NegativeInfinity);
        var geometryOptions = new Options { View = view, ComputeReferences = false, IncludeNonVisibleObjects = false };
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        void Count(string key) => counts[key] = counts.GetValueOrDefault(key) + 1;
        for (var index = 0; index < model.Count; index++)
        {
            var candidate = model[index];
            List<(V3, V3, V3)> triangles;
            var unreadable = false;
            try
            {
                triangles = Triangles(candidate.Element, geometryOptions);
            }
            catch (Exception)
            {
                triangles = [];
                unreadable = true;
                Count("geometryErrors");
            }
            if (triangles.Count > 0)
            {
                foreach (var triangle in triangles)
                    Rasterize(triangle, index, ids, depth, ref candidate.InFrame);
                continue;
            }
            candidate.NoGeometry = true;
            var box = BoxTriangles(candidate.Element.get_BoundingBox(view));
            // Plan rule: in plans, an element with no solids (a family that draws only symbols)
            // hides nothing. Geometry that cannot be read still hides what is behind its box.
            var occludes = (!isPlan || unreadable) && FallbackAllowed(candidate.Element);
            foreach (var triangle in box)
            {
                if (occludes)
                    Rasterize(triangle, OccluderOnly, ids, depth, ref candidate.InFrame);
                else
                    candidate.InFrame |= InFrame(triangle);
            }
            if (occludes && box.Count > 0)
                Count("fallbackOccluders");
        }
        foreach (var link in links)
        {
            var ignored = false;
            foreach (var triangle in BoxTriangles(link.get_BoundingBox(view)))
                Rasterize(triangle, OccluderOnly, ids, depth, ref ignored);
        }

        // Condition 4: a region counts only where the export draws something in or beside it.
        var drawn = DrawnNearby(bgra);
        var regions = Regions(ids);
        var confirmed = new bool[regions.Count];
        for (var p = 0; p < ids.Length; p++)
        {
            if (ids[p] >= 0 && drawn[p])
                confirmed[regions.Label[p]] = true;
        }
        var clear = DistanceTransform(ids);
        for (var p = 0; p < ids.Length; p++)
        {
            var id = ids[p];
            if (id < 0)
                continue;
            var candidate = model[id];
            candidate.Pixels++;
            if (!confirmed[regions.Label[p]])
                continue;
            candidate.Confirmed = true;
            if (clear[p] > candidate.MaxClear)
                candidate.MaxClear = clear[p];
            var x = p % width;
            var y = p / width;
            candidate.MinX = Math.Min(candidate.MinX, x);
            candidate.MaxX = Math.Max(candidate.MaxX, x);
            candidate.MinY = Math.Min(candidate.MinY, y);
            candidate.MaxY = Math.Max(candidate.MaxY, y);
        }

        var placed = new SpatialHash(radius * 2 + 2);
        PlaceModel(model, ids, clear, regions.Label, confirmed, radius, placed, wanted);
        foreach (var candidate in datums.Where(c => wanted.Contains(c.Id)))
            PlaceDatum(candidate, radius, placed, drawn);

        // Numbers run in reading order: rows of one mark diameter, top to bottom, then left to right.
        var band = radius * 2.0;
        var marked = model.Concat(datums).Where(c => c.Placed is not null)
            .OrderBy(c => Math.Floor(c.Placed!.Value.Y / band)).ThenBy(c => c.Placed!.Value.X).ToList();
        var receipt = new MarksReceipt();
        var draw = new List<(double X, double Y, int Number)>();
        var kinds = new List<string>();
        var clearances = new List<double>();
        foreach (var candidate in marked)
        {
            var number = draw.Count + 1;
            var (x, y) = candidate.Placed!.Value;
            draw.Add((x, y, number));
            kinds.Add(candidate.Kind);
            clearances.Add(Math.Round(candidate.PlacedClear, 1));
            var type = document.GetElement(candidate.Element.GetTypeId()) as ElementType;
            var category = CategoryOf(candidate.Element)?.BuiltInCategory ?? BuiltInCategory.INVALID;
            receipt.Legend.Add(new MarkLegendRow
            {
                Mark = number,
                ElementId = candidate.Id.ToString(CultureInfo.InvariantCulture),
                Category = category == BuiltInCategory.INVALID ? null : category.ToString(),
                FamilyName = type?.FamilyName,
                TypeName = type?.Name,
                X = (int)Math.Round(x),
                Y = (int)Math.Round(y),
                Bounds = candidate.Kind == "model" ? candidate.Bounds : null,
            });
        }

        if (requested is not null)
        {
            receipt.NotMarked = [];
            foreach (var id in requested)
            {
                if (reasons.TryGetValue(id, out var reason))
                {
                    receipt.NotMarked.Add(new MarkNotMarkedRow { ElementId = id.ToString(CultureInfo.InvariantCulture), Reason = reason });
                    continue;
                }
                var candidate = byId[id];
                if (candidate.Placed is not null)
                    continue;
                var why = candidate.Reason ?? "not_visible";
                receipt.NotMarked.Add(new MarkNotMarkedRow
                {
                    ElementId = id.ToString(CultureInfo.InvariantCulture),
                    Reason = why,
                    Bounds = why == "not_placed" && candidate.Kind == "model" ? candidate.Bounds : null,
                });
            }
        }

        // Omitted: may be visible but unmarked, because visibility could not be established or no
        // legible position was free. Elements established as covered or not drawn are not counted.
        receipt.Omitted = model.Concat(datums)
            .Count(c => wanted.Contains(c.Id) && c.Placed is null
                && (c.Reason == "not_placed" || (c.NoGeometry && c.InFrame)));

        counts["candidates"] = model.Count;
        counts["datumCandidates"] = datums.Count;
        counts["noGeometry"] = model.Count(c => c.NoGeometry);
        counts["unconfirmed"] = model.Count(c => c.Pixels > 0 && !c.Confirmed);
        counts["marked"] = marked.Count;
        return new MarkOutcome
        {
            Receipt = receipt,
            Draw = draw,
            Radius = radius,
            Regions = ids,
            Kinds = kinds,
            Clearances = clearances,
            Counts = counts,
        };
    }

    private bool HiddenInView(Element element)
    {
        try
        {
            if (element.IsHidden(view))
                return true;
            var category = CategoryOf(element);
            if (category is not null && view.GetCategoryHidden(category.Id))
                return true;
            if (category?.Parent is { } parent && view.GetCategoryHidden(parent.Id))
                return true;
            if (element is GenericForm { Subcategory: { } subcategory } && view.GetCategoryHidden(subcategory.Id))
                return true;
        }
        catch (Exception)
        {
            // Some categories cannot be queried; the collector's own answer stands.
        }
        return false;
    }

    // ---- view frame ------------------------------------------------------------------------

    private List<ClipPlane> BuildPlanes()
    {
        var list = new List<ClipPlane>();
        if (view is ViewPlan plan)
        {
            var range = plan.GetViewRange();
            // A reflected ceiling plan looks up: its cut keeps what is above and its far plane is the top.
            var lookingDown = plan.ViewType != ViewType.CeilingPlan;
            if (PlaneElevation(plan, range, PlanViewPlane.CutPlane) is { } cut)
                list.Add(new ClipPlane(new V3(0, 0, lookingDown ? -1 : 1), new V3(0, 0, cut), true));
            if (PlaneElevation(plan, range, lookingDown ? PlanViewPlane.ViewDepthPlane : PlanViewPlane.TopClipPlane) is { } back)
                list.Add(new ClipPlane(new V3(0, 0, lookingDown ? 1 : -1), new V3(0, 0, back), false));
        }
        if (view is ViewSection)
        {
            var box = view.CropBox;
            var transform = box.Transform;
            var basisZ = V3.Of(transform.BasisZ);
            list.Add(new ClipPlane(basisZ * -1, V3.Of(transform.OfPoint(new XYZ(0, 0, box.Max.Z))), true));
            var far = view.get_Parameter(BuiltInParameter.VIEWER_BOUND_FAR_CLIPPING)?.AsInteger() ?? 1;
            if (far != 0)
                list.Add(new ClipPlane(basisZ, V3.Of(transform.OfPoint(new XYZ(0, 0, box.Min.Z))), false));
        }
        if (view is View3D view3D)
        {
            if (view3D.IsSectionBoxActive)
            {
                var box = view3D.GetSectionBox();
                var t = box.Transform;
                var x = V3.Of(t.BasisX);
                var y = V3.Of(t.BasisY);
                var z = V3.Of(t.BasisZ);
                var min = V3.Of(t.OfPoint(box.Min));
                var max = V3.Of(t.OfPoint(box.Max));
                list.Add(new ClipPlane(x, min, true));
                list.Add(new ClipPlane(x * -1, max, true));
                list.Add(new ClipPlane(y, min, true));
                list.Add(new ClipPlane(y * -1, max, true));
                list.Add(new ClipPlane(z, min, true));
                list.Add(new ClipPlane(z * -1, max, true));
            }
            if ((view3D.get_Parameter(BuiltInParameter.VIEWER_BOUND_ACTIVE_FAR)?.AsInteger() ?? 0) != 0)
            {
                // Revit draws nothing beyond an active 3D far clip.
                var box = view3D.CropBox;
                var t = box.Transform;
                list.Add(new ClipPlane(V3.Of(t.BasisZ), V3.Of(t.OfPoint(new XYZ(0, 0, box.Min.Z))), false));
            }
        }
        if (view.CropBoxActive)
        {
            var box = view.CropBox;
            var t = box.Transform;
            var x = V3.Of(t.BasisX);
            var y = V3.Of(t.BasisY);
            var min = V3.Of(t.OfPoint(box.Min));
            var max = V3.Of(t.OfPoint(box.Max));
            list.Add(new ClipPlane(x, min, false));
            list.Add(new ClipPlane(x * -1, max, false));
            list.Add(new ClipPlane(y, min, false));
            list.Add(new ClipPlane(y * -1, max, false));
        }
        return list;
    }

    private double? PlaneElevation(ViewPlan plan, PlanViewRange range, PlanViewPlane which)
    {
        try
        {
            var levelId = range.GetLevelId(which);
            if (levelId == PlanViewRange.Unlimited || levelId == ElementId.InvalidElementId)
                return null;
            Level? level;
            if (levelId == PlanViewRange.Current)
                level = plan.GenLevel;
            else if (levelId == PlanViewRange.LevelAbove || levelId == PlanViewRange.LevelBelow)
            {
                var levels = new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>()
                    .OrderBy(l => l.ProjectElevation).ToList();
                var current = levels.FindIndex(l => l.Id == plan.GenLevel.Id);
                var other = levelId == PlanViewRange.LevelAbove ? current + 1 : current - 1;
                level = current < 0 || other < 0 || other >= levels.Count ? null : levels[other];
            }
            else
                level = document.GetElement(levelId) as Level;
            return level is null ? null : level.ProjectElevation + range.GetOffset(which);
        }
        catch (Exception)
        {
            // An unreadable view range leaves that side unclipped, which can only cost marks.
            return null;
        }
    }

    private Projection BuildProjection()
    {
        BoundingBoxUV outline;
        try
        {
            outline = view.Outline;
        }
        catch (Exception exception)
        {
            throw new RequestRejectedException("marks_unavailable",
                $"Marks are unavailable for view '{view.Name}': Revit reports no outline for it ({exception.Message}). Capture it without marks.");
        }
        var scale = view.Scale;
        // A reflected ceiling plan is drawn like a plan but seen from below: nearer is lower.
        var toward = view.ViewType == ViewType.CeilingPlan ? new V3(0, 0, -1) : V3.Of(view.ViewDirection);
        return new Projection(V3.Of(view.Origin), V3.Of(view.RightDirection), V3.Of(view.UpDirection), toward,
            outline.Min.U * scale, outline.Max.U * scale, outline.Min.V * scale, outline.Max.V * scale, width, height);
    }

    // ---- geometry ---------------------------------------------------------------------------

    private static IEnumerable<Solid> Solids(GeometryElement? geometry)
    {
        if (geometry is null)
            yield break;
        foreach (var item in geometry)
        {
            if (item is Solid { Faces.Size: > 0 } solid)
                yield return solid;
            else if (item is GeometryInstance instance)
            {
                foreach (var nested in Solids(instance.GetInstanceGeometry()))
                    yield return nested;
            }
        }
    }

    private static IEnumerable<Mesh> Meshes(GeometryElement? geometry)
    {
        if (geometry is null)
            yield break;
        foreach (var item in geometry)
        {
            if (item is Mesh mesh)
                yield return mesh;
            else if (item is GeometryInstance instance)
            {
                foreach (var nested in Meshes(instance.GetInstanceGeometry()))
                    yield return nested;
            }
        }
    }

    /// <summary>The element's view geometry as triangles; a solid cut by a cap plane is capped there.</summary>
    private List<(V3, V3, V3)> Triangles(Element element, Options geometryOptions)
    {
        var result = new List<(V3, V3, V3)>();
        var geometry = element.get_Geometry(geometryOptions);
        foreach (var original in Solids(geometry))
        {
            var solid = original;
            var cutAway = false;
            foreach (var plane in planes.Where(p => p.Cap))
            {
                if (!Straddles(solid, plane))
                    continue;
                try
                {
                    var cut = BooleanOperationsUtils.CutWithHalfSpace(solid, Plane.CreateByNormalAndOrigin(plane.Normal.ToXyz(), plane.Origin.ToXyz()));
                    cutAway = cut is null || cut.Faces.Size == 0;
                    if (cutAway)
                        break;
                    solid = cut!;
                }
                catch (Exception)
                {
                    // Uncapped, the solid still clips at the plane; only its cut face is missing.
                }
            }
            if (cutAway)
                continue;
            foreach (Face face in solid.Faces)
            {
                Mesh? mesh = null;
                try
                {
                    mesh = face.Triangulate(0.0);
                }
                catch (Exception)
                {
                    // Reported below.
                }
                if (mesh is null)
                    throw new InvalidOperationException("A face could not be triangulated.");
                AddMesh(mesh, result);
            }
        }
        foreach (var mesh in Meshes(geometry))
            AddMesh(mesh, result);
        return result;
    }

    /// <summary>Openings and curtain grids are voids or lines; their boxes must not hide anything.</summary>
    private static bool FallbackAllowed(Element element)
    {
        var name = CategoryOf(element)?.BuiltInCategory.ToString() ?? "";
        return !(name.Contains("Opening", StringComparison.Ordinal) || name.Contains("CurtainGrids", StringComparison.Ordinal) || name == "OST_Divisions");
    }

    private static List<(V3, V3, V3)> BoxTriangles(BoundingBoxXYZ? box)
    {
        var result = new List<(V3, V3, V3)>();
        if (box is null)
            return result;
        var t = box.Transform;
        V3 Corner(int i) => V3.Of(t.OfPoint(new XYZ(
            (i & 1) == 0 ? box.Min.X : box.Max.X, (i & 2) == 0 ? box.Min.Y : box.Max.Y, (i & 4) == 0 ? box.Min.Z : box.Max.Z)));
        int[][] faces = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
        foreach (var f in faces)
        {
            result.Add((Corner(f[0]), Corner(f[1]), Corner(f[2])));
            result.Add((Corner(f[0]), Corner(f[2]), Corner(f[3])));
        }
        return result;
    }

    private static void AddMesh(Mesh mesh, List<(V3, V3, V3)> result)
    {
        var vertices = mesh.Vertices.Select(V3.Of).ToArray();
        for (var i = 0; i < mesh.NumTriangles; i++)
        {
            var triangle = mesh.get_Triangle(i);
            result.Add((vertices[triangle.get_Index(0)], vertices[triangle.get_Index(1)], vertices[triangle.get_Index(2)]));
        }
    }

    private static bool Straddles(Solid solid, ClipPlane plane)
    {
        var box = solid.GetBoundingBox();
        var t = box.Transform;
        double min = double.MaxValue, max = double.MinValue;
        foreach (var x in new[] { box.Min.X, box.Max.X })
        foreach (var y in new[] { box.Min.Y, box.Max.Y })
        foreach (var z in new[] { box.Min.Z, box.Max.Z })
        {
            var d = plane.Distance(V3.Of(t.OfPoint(new XYZ(x, y, z))));
            min = Math.Min(min, d);
            max = Math.Max(max, d);
        }
        return min < -1e-6 && max > 1e-6;
    }

    // ---- raster -----------------------------------------------------------------------------

    private (double X, double Y, double Z)[]? Clipped((V3 A, V3 B, V3 C) triangle)
    {
        var polygon = new List<V3>(6) { triangle.A, triangle.B, triangle.C };
        foreach (var plane in planes)
        {
            polygon = ClipPolygon(polygon, plane);
            if (polygon.Count < 3)
                return null;
        }
        var projected = new (double X, double Y, double Z)[polygon.Count];
        for (var i = 0; i < polygon.Count; i++)
        {
            projection.Project(polygon[i], out var x, out var y, out var z);
            projected[i] = (x, y, z);
        }
        return projected;
    }

    private bool Overlaps((double X, double Y, double Z)[] projected) =>
        projected.Max(p => p.X) > 0 && projected.Min(p => p.X) < width && projected.Max(p => p.Y) > 0 && projected.Min(p => p.Y) < height;

    private bool InFrame((V3 A, V3 B, V3 C) triangle) => Clipped(triangle) is { } projected && Overlaps(projected);

    private void Rasterize((V3 A, V3 B, V3 C) triangle, int index, int[] ids, float[] depth, ref bool inFrame)
    {
        if (Clipped(triangle) is not { } projected || !Overlaps(projected))
            return;
        inFrame = true;
        for (var i = 1; i < projected.Length - 1; i++)
            Fill(projected[0], projected[i], projected[i + 1], index, ids, depth);
    }

    private static List<V3> ClipPolygon(List<V3> polygon, ClipPlane plane)
    {
        if (polygon.All(p => plane.Distance(p) >= 0))
            return polygon;
        var output = new List<V3>(polygon.Count + 2);
        for (var i = 0; i < polygon.Count; i++)
        {
            var current = polygon[i];
            var previous = polygon[(i + polygon.Count - 1) % polygon.Count];
            var dc = plane.Distance(current);
            var dp = plane.Distance(previous);
            if (dc >= 0)
            {
                if (dp < 0)
                    output.Add(V3.Lerp(previous, current, dp / (dp - dc)));
                output.Add(current);
            }
            else if (dp >= 0)
                output.Add(V3.Lerp(previous, current, dp / (dp - dc)));
        }
        return output;
    }

    private void Fill((double X, double Y, double Z) a, (double X, double Y, double Z) b, (double X, double Y, double Z) c, int index, int[] ids, float[] depth)
    {
        var area = (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
        if (Math.Abs(area) < 1e-9)
            return;
        var minX = Math.Max(0, (int)Math.Floor(Math.Min(a.X, Math.Min(b.X, c.X))));
        var maxX = Math.Min(width - 1, (int)Math.Ceiling(Math.Max(a.X, Math.Max(b.X, c.X))));
        var minY = Math.Max(0, (int)Math.Floor(Math.Min(a.Y, Math.Min(b.Y, c.Y))));
        var maxY = Math.Min(height - 1, (int)Math.Ceiling(Math.Max(a.Y, Math.Max(b.Y, c.Y))));
        if (minX > maxX || minY > maxY)
            return;
        var sign = area > 0 ? 1.0 : -1.0;
        const double epsilon = 0.002;
        for (var y = minY; y <= maxY; y++)
        {
            var py = y + 0.5;
            for (var x = minX; x <= maxX; x++)
            {
                var px = x + 0.5;
                var w0 = ((c.X - b.X) * (py - b.Y) - (c.Y - b.Y) * (px - b.X)) * sign;
                var w1 = ((a.X - c.X) * (py - c.Y) - (a.Y - c.Y) * (px - c.X)) * sign;
                var w2 = ((b.X - a.X) * (py - a.Y) - (b.Y - a.Y) * (px - a.X)) * sign;
                if (w0 < 0 || w1 < 0 || w2 < 0)
                    continue;
                var z = (w0 * a.Z + w1 * b.Z + w2 * c.Z) / (w0 + w1 + w2);
                var p = y * width + x;
                var current = depth[p];
                if (float.IsNegativeInfinity(current) || z > current + epsilon)
                {
                    depth[p] = (float)z;
                    ids[p] = index;
                }
                else if (z >= current - epsilon && ids[p] != index)
                {
                    // Coincident faces of two elements: neither is established as the one shown.
                    ids[p] = Ambiguous;
                    if (z > current)
                        depth[p] = (float)z;
                }
            }
        }
    }

    /// <summary>Pixels with a drawn pixel of the export within the confirmation radius.</summary>
    private bool[] DrawnNearby(byte[] bgra)
    {
        var drawn = new bool[width * height];
        for (var p = 0; p < drawn.Length; p++)
            drawn[p] = bgra[p * 4] < DrawnBelow || bgra[p * 4 + 1] < DrawnBelow || bgra[p * 4 + 2] < DrawnBelow;
        // Separable square dilation: rows, then columns.
        var rows = new bool[drawn.Length];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var any = false;
                for (var dx = -ConfirmationRadius; dx <= ConfirmationRadius && !any; dx++)
                {
                    var nx = x + dx;
                    any = nx >= 0 && nx < width && drawn[y * width + nx];
                }
                rows[y * width + x] = any;
            }
        }
        var result = new bool[drawn.Length];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var any = false;
                for (var dy = -ConfirmationRadius; dy <= ConfirmationRadius && !any; dy++)
                {
                    var ny = y + dy;
                    any = ny >= 0 && ny < height && rows[ny * width + x];
                }
                result[y * width + x] = any;
            }
        }
        return result;
    }

    /// <summary>Connected regions of one element's pixels (4-connected), labelled per pixel.</summary>
    private (int[] Label, int Count) Regions(int[] ids)
    {
        var label = new int[ids.Length];
        Array.Fill(label, -1);
        var count = 0;
        var stack = new Stack<int>();
        for (var start = 0; start < ids.Length; start++)
        {
            if (ids[start] < 0 || label[start] >= 0)
                continue;
            var id = ids[start];
            label[start] = count;
            stack.Push(start);
            while (stack.Count > 0)
            {
                var p = stack.Pop();
                var x = p % width;
                Span<int> neighbours = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width];
                foreach (var q in neighbours)
                {
                    if (q < 0 || q >= ids.Length || ids[q] != id || label[q] >= 0)
                        continue;
                    label[q] = count;
                    stack.Push(q);
                }
            }
            count++;
        }
        return (label, count);
    }

    /// <summary>Chamfer distance from each pixel to the nearest pixel showing anything else.</summary>
    private float[] DistanceTransform(int[] ids)
    {
        var d = new float[width * height];
        const float infinity = 1e9f;
        const float diagonal = 1.4142f;
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var p = y * width + x;
                var id = ids[p];
                if (id < 0 || x == 0 || y == 0 || x == width - 1 || y == height - 1)
                {
                    d[p] = 0;
                    continue;
                }
                var boundary = ids[p - 1] != id || ids[p + 1] != id || ids[p - width] != id || ids[p + width] != id;
                d[p] = boundary ? 0.5f : infinity;
            }
        }
        for (var y = 1; y < height - 1; y++)
        {
            for (var x = 1; x < width - 1; x++)
            {
                var p = y * width + x;
                if (d[p] == 0)
                    continue;
                var v = d[p];
                v = Math.Min(v, d[p - 1] + 1);
                v = Math.Min(v, d[p - width] + 1);
                v = Math.Min(v, d[p - width - 1] + diagonal);
                v = Math.Min(v, d[p - width + 1] + diagonal);
                d[p] = v;
            }
        }
        for (var y = height - 2; y >= 1; y--)
        {
            for (var x = width - 2; x >= 1; x--)
            {
                var p = y * width + x;
                if (d[p] == 0)
                    continue;
                var v = d[p];
                v = Math.Min(v, d[p + 1] + 1);
                v = Math.Min(v, d[p + width] + 1);
                v = Math.Min(v, d[p + width + 1] + diagonal);
                v = Math.Min(v, d[p + width - 1] + diagonal);
                d[p] = v;
            }
        }
        return d;
    }

    // ---- placement --------------------------------------------------------------------------

    private sealed class SpatialHash(double cell)
    {
        private readonly Dictionary<(int, int), List<(double X, double Y)>> cells = [];

        public bool Free(double x, double y, double minimum)
        {
            var cx = (int)Math.Floor(x / cell);
            var cy = (int)Math.Floor(y / cell);
            for (var oy = -1; oy <= 1; oy++)
            {
                for (var ox = -1; ox <= 1; ox++)
                {
                    if (!cells.TryGetValue((cx + ox, cy + oy), out var list))
                        continue;
                    foreach (var (px, py) in list)
                    {
                        if ((px - x) * (px - x) + (py - y) * (py - y) < minimum * minimum)
                            return false;
                    }
                }
            }
            return true;
        }

        public void Add(double x, double y)
        {
            var key = ((int)Math.Floor(x / cell), (int)Math.Floor(y / cell));
            if (!cells.TryGetValue(key, out var list))
                cells[key] = list = [];
            list.Add((x, y));
        }
    }

    /// <summary>
    /// The most legible elements first: each mark goes on a confirmed pixel the element owns with
    /// the clearance, inside the image, and never over another mark.
    /// </summary>
    private void PlaceModel(List<Candidate> model, int[] ids, float[] clear, int[] label, bool[] confirmed, int radius, SpatialHash placed, HashSet<long> wanted)
    {
        var counts = new int[model.Count];
        bool Usable(int p) => ids[p] >= 0 && clear[p] >= MinimumClearance && confirmed[label[p]];
        for (var p = 0; p < ids.Length; p++)
        {
            if (Usable(p))
                counts[ids[p]]++;
        }
        var offsets = new int[model.Count + 1];
        for (var i = 0; i < model.Count; i++)
            offsets[i + 1] = offsets[i] + counts[i];
        var slots = new int[offsets[model.Count]];
        var fill = (int[])offsets.Clone();
        for (var p = 0; p < ids.Length; p++)
        {
            if (Usable(p))
                slots[fill[ids[p]]++] = p;
        }

        var spacing = radius * 2 + 2;
        var order = Enumerable.Range(0, model.Count)
            .Where(i => wanted.Contains(model[i].Id))
            .OrderByDescending(i => model[i].MaxClear).ToList();
        foreach (var i in order)
        {
            var candidate = model[i];
            if (!candidate.InFrame && !candidate.NoGeometry)
            {
                candidate.Reason = "not_in_view";
                continue;
            }
            if (!candidate.Confirmed)
            {
                // Covered, cut away, or drawn as nothing in the export; or visibility not established.
                candidate.Reason = candidate.NoGeometry && !candidate.InFrame ? "not_in_view" : "not_visible";
                continue;
            }
            if (counts[i] == 0)
            {
                candidate.Reason = "not_placed";
                continue;
            }
            var slice = new ArraySegment<int>(slots, offsets[i], counts[i]).ToArray();
            var keys = slice.Select(p => -clear[p]).ToArray();
            Array.Sort(keys, slice);
            var tried = 0;
            foreach (var p in slice)
            {
                if (++tried > MaximumPlacementTries)
                    break;
                var x = p % width + 0.5;
                var y = p / width + 0.5;
                if (x < radius || y < radius || x > width - radius || y > height - radius)
                    continue;
                if (!placed.Free(x, y, spacing))
                    continue;
                placed.Add(x, y);
                candidate.Placed = (x, y);
                candidate.PlacedClear = clear[p];
                break;
            }
            if (candidate.Placed is null)
                candidate.Reason = "not_placed";
        }
    }

    /// <summary>
    /// A level or grid is marked on its drawn line near its bubble end, a few mark diameters in so
    /// the head and its name stay readable, then further along the line until a free spot is found.
    /// </summary>
    private void PlaceDatum(Candidate candidate, int radius, SpatialHash placed, bool[] drawn)
    {
        var datum = (DatumPlane)candidate.Element;
        IList<Curve> curves;
        bool bubbleAtEnd1;
        try
        {
            curves = datum.GetCurvesInView(DatumExtentType.ViewSpecific, view);
            bubbleAtEnd1 = datum.IsBubbleVisibleInView(DatumEnds.End1, view) && !datum.IsBubbleVisibleInView(DatumEnds.End0, view);
        }
        catch (Exception)
        {
            // Visibility not established: counted in omitted as possibly visible, like a model
            // element whose geometry cannot be read.
            candidate.NoGeometry = true;
            candidate.InFrame = true;
            candidate.Reason = "not_visible";
            return;
        }
        double[] diameters = [3, 4, 5.5, 7.5, 10];
        double[] fractions = [0.3, 0.5, 0.7, 0.85];
        var spacing = radius * 2 + 2;
        var seen = false;
        foreach (var curve in curves)
        {
            projection.Project(V3.Of(curve.GetEndPoint(0)), out var ax, out var ay, out _);
            projection.Project(V3.Of(curve.GetEndPoint(1)), out var bx, out var by, out _);
            var length = Math.Sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
            if (length < 1)
                continue;
            var steps = diameters.Select(d => d * 2 * radius / length).Where(t => t < 0.3).Concat(fractions);
            foreach (var step in steps)
            {
                var t = bubbleAtEnd1 ? 1 - step : step;
                var x = ax + (bx - ax) * t;
                var y = ay + (by - ay) * t;
                if (x < radius || y < radius || x > width - radius || y > height - radius)
                    continue;
                candidate.InFrame = true;
                if (!drawn[(int)y * width + (int)x])
                    continue;
                seen = true;
                if (!placed.Free(x, y, spacing))
                    continue;
                placed.Add(x, y);
                candidate.Placed = (x, y);
                candidate.Confirmed = true;
                return;
            }
        }
        candidate.Reason = seen ? "not_placed" : candidate.InFrame ? "not_visible" : "not_in_view";
    }
}
