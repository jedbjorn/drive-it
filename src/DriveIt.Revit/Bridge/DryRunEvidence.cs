using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using DriveIt.Revit.Broker;

namespace DriveIt.Revit.Bridge;

/// <summary>
/// The element ids one document's committed transactions added, modified and deleted during a dry run, net: an element
/// created and deleted in the same dry run is neither, and a modified element that is later deleted is deleted.
/// </summary>
internal sealed class DryRunChanges(Document document)
{
    public Document Document { get; } = document;
    public string Title { get; } = document.Title;
    public string? Path { get; } = string.IsNullOrWhiteSpace(document.PathName) ? null : document.PathName;
    public HashSet<long> Added { get; } = [];
    public HashSet<long> Modified { get; } = [];
    public HashSet<long> Deleted { get; } = [];

    /// <summary>A committed transaction in the dry run reported a change to this document.</summary>
    public bool Changed { get; private set; }

    public void Record(ICollection<ElementId> added, ICollection<ElementId> modified, ICollection<ElementId> deleted)
    {
        Changed |= added.Count + modified.Count + deleted.Count > 0;
        foreach (var id in added)
            Added.Add(id.Value);
        foreach (var id in modified)
        {
            if (!Added.Contains(id.Value))
                Modified.Add(id.Value);
        }
        foreach (var id in deleted)
        {
            if (Added.Remove(id.Value))
                continue;
            Modified.Remove(id.Value);
            Deleted.Add(id.Value);
        }
    }
}

/// <summary>One view a dry run exported, or why it could not (spec #13 "What Comes Back").</summary>
public sealed class DryRunImage
{
    public string ViewId { get; set; } = "";
    public string? ViewUniqueId { get; set; }
    public string? ViewName { get; set; }
    public string? ViewType { get; set; }
    public DryRunDocument? Document { get; set; }
    public string? TargetPath { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    public string? FitDirection { get; set; }
    public long Ms { get; set; }
    public ErrorReceipt? Error { get; set; }
}

public sealed class DryRunDocument
{
    public string Title { get; set; } = "";
    public string? Path { get; set; }
    public string Kind { get; set; } = "";
}

/// <summary>
/// The images of a dry run (spec #13 "How It Works" step 3): exported after the script succeeded, with the run's
/// groups open and no transaction open, so they show the would-be state. The named views first, then views the
/// script created, one per staged target.
/// </summary>
internal static class DryRunImages
{
    public static List<DryRunImage> Export(UIApplication application, IReadOnlyList<DryRunChanges> changed, JsonObject export, DateTimeOffset deadline)
    {
        var targets = Strings(export["targets"]);
        var pixelSize = export["pixelSize"] is JsonValue size && size.TryGetValue<int>(out var pixels) ? pixels : 1024;
        var images = new List<DryRunImage>();
        foreach (var id in Strings(export["views"]))
        {
            if (images.Count >= targets.Count)
                break;
            images.Add(ExportOne(id, () => Named(application, changed, id), targets[images.Count], pixelSize, deadline));
        }
        if (export["createdViews"] is JsonValue created && created.TryGetValue<bool>(out var withCreated) && withCreated)
        {
            foreach (var (document, view) in CreatedViews(changed))
            {
                if (images.Count >= targets.Count)
                    break;
                images.Add(ExportOne(view.Id.Value.ToString(CultureInfo.InvariantCulture), () => (document, view), targets[images.Count], pixelSize, deadline));
            }
        }
        return images;
    }

    private static List<string> Strings(JsonNode? node) =>
        node is JsonArray array ? array.Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) ? text : "").ToList() : [];

    private static DryRunImage ExportOne(string id, Func<(Document Document, View View)> resolve, string target, int pixelSize, DateTimeOffset deadline)
    {
        var image = new DryRunImage { ViewId = id, TargetPath = target };
        var timer = Stopwatch.StartNew();
        try
        {
            if (DateTimeOffset.Now >= deadline)
                throw new RequestRejectedException("time_limit_reached", "The run's time limit was reached before this view could be exported.");
            var (document, view) = resolve();
            image.ViewUniqueId = view.UniqueId;
            image.ViewName = view.Name;
            image.ViewType = view.ViewType.ToString();
            image.Document = new DryRunDocument
            {
                Title = document.Title,
                Path = string.IsNullOrWhiteSpace(document.PathName) ? null : document.PathName,
                Kind = document.IsFamilyDocument ? "rfa" : "rvt",
            };
            DocumentDispatcher.RequireCapturable(view);
            var (width, height, fit) = DocumentDispatcher.ExportForDryRun(document, view, pixelSize, target);
            image.Width = width;
            image.Height = height;
            image.FitDirection = fit;
        }
        catch (RequestRejectedException exception)
        {
            image.Error = new ErrorReceipt { Code = exception.Code, Message = exception.Message };
        }
        catch (Exception exception)
        {
            image.Error = new ErrorReceipt { Code = "export_failed", Message = $"Revit could not export the view: {exception.Message}" };
        }
        image.Ms = timer.ElapsedMilliseconds;
        return image;
    }

    /// <summary>A named view: looked up in the documents the dry run changed, then in the active document.</summary>
    private static (Document, View) Named(UIApplication application, IReadOnlyList<DryRunChanges> changed, string id)
    {
        if (!long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var raw) || raw <= 0)
            throw new RequestRejectedException("invalid_view_id", "A view id is a positive decimal Revit element id.");
        var documents = changed.Select(entry => entry.Document).ToList();
        if (application.ActiveUIDocument?.Document is { IsLinked: false } active)
            documents.Add(active);
        Element? other = null;
        foreach (var document in documents.Where(document => document.IsValidObject))
        {
            var element = document.GetElement(new ElementId(raw));
            if (element is View view)
                return (document, view);
            other ??= element;
        }
        if (other is not null)
            throw new RequestRejectedException("not_a_view", $"Element {id} is a {other.GetType().Name}, not a view.");
        throw new RequestRejectedException("view_not_found",
            $"No view {id} is in the documents this dry run changed or in the active document.");
    }

    private static IEnumerable<(Document, View)> CreatedViews(IReadOnlyList<DryRunChanges> changed)
    {
        foreach (var entry in changed)
        {
            foreach (var id in entry.Added.Order())
            {
                if (entry.Document.GetElement(new ElementId(id)) is View view && DocumentDispatcher.IsCapturable(view))
                    yield return (entry.Document, view);
            }
        }
    }
}

/// <summary>
/// The dry run actions (spec #13 "Dry Run Actions", decision #75): per document, what the script would create, modify
/// and delete. Created elements and the modified elements' would-be values are read with the groups open; after the
/// rollback the modified elements are read again for their values before, and the deleted ones are named from the
/// restored model. Values are compared as Revit displays them. Only parameters a person can set are compared, with the
/// element's location: an element whose only change is Revit's own (a wall re-cut by a window, a regenerated view,
/// a recomputed area) is counted under Also touched by Revit.
/// </summary>
internal sealed class DryRunActions
{
    public const int MaximumElements = 200;
    public const int MaximumValues = 20;

    private readonly List<DocumentActions> documents;
    private readonly DateTimeOffset deadline;
    private int budget = MaximumElements;

    public DryRunActions(IEnumerable<DryRunChanges> changed, DateTimeOffset deadline)
    {
        documents = changed.Where(entry => entry.Added.Count + entry.Modified.Count + entry.Deleted.Count > 0)
            .Select(entry => new DocumentActions(entry)).ToList();
        this.deadline = deadline;
    }

    /// <summary>With the groups open and no transaction open: the created elements, and the modified ones as they would be.</summary>
    public void ReadAfter()
    {
        foreach (var document in documents)
        {
            foreach (var id in document.Changes.Added.Order())
            {
                if (!Take())
                    break;
                document.Created.Add(Read(document.Changes.Document, id, values: false));
            }
            foreach (var id in document.Changes.Modified.Order())
            {
                if (!Take())
                    break;
                document.After.Add(Read(document.Changes.Document, id, values: true));
            }
        }
    }

    /// <summary>After the rollback: the modified elements as they were, compared, and the deleted elements named.</summary>
    public JsonArray ReadBefore()
    {
        var result = new JsonArray();
        foreach (var document in documents)
        {
            foreach (var after in document.After)
                document.Compare(after, Read(document.Changes.Document, after.Id, values: true));
            foreach (var id in document.Changes.Deleted.Order())
            {
                if (!Take())
                    break;
                document.Deleted.Add(Read(document.Changes.Document, id, values: false));
            }
            result.Add(document.ToJson());
        }
        return result;
    }

    private bool Take()
    {
        if (budget <= 0 || DateTimeOffset.Now >= deadline)
            return false;
        budget--;
        return true;
    }

    private static Snapshot Read(Document document, long id, bool values)
    {
        var snapshot = new Snapshot(id);
        try
        {
            var element = document.GetElement(new ElementId(id))
                ?? throw new InvalidOperationException($"No element has id {id} in {document.Title}.");
            snapshot.Category = element.Category?.Name;
            var type = element as ElementType ?? document.GetElement(element.GetTypeId()) as ElementType;
            snapshot.Family = string.IsNullOrWhiteSpace(type?.FamilyName) ? null : type!.FamilyName;
            snapshot.Type = type?.Name;
            var name = element.Name;
            if (!string.IsNullOrWhiteSpace(name) && name != snapshot.Type)
                snapshot.Name = name;
            if (values)
            {
                snapshot.Values = Values(element);
                snapshot.Location = Where(element);
            }
        }
        catch (Exception exception)
        {
            snapshot.ReadError = $"{exception.GetType().Name}: {exception.Message}";
        }
        return snapshot;
    }

    /// <summary>Each parameter a person can set, by its id, as Revit displays its value.</summary>
    private static Dictionary<long, (string Name, string? Value)> Values(Element element)
    {
        var values = new Dictionary<long, (string, string?)>();
        foreach (Parameter parameter in element.Parameters)
        {
            try
            {
                if (parameter.IsReadOnly || parameter.Definition is null)
                    continue;
                values[parameter.Id.Value] = (parameter.Definition.Name, Display(parameter));
            }
            catch (Exception)
            {
                // A parameter Revit cannot report is left out of the comparison.
            }
        }
        return values;
    }

    private static string? Display(Parameter parameter)
    {
        if (!parameter.HasValue)
            return null;
        return parameter.StorageType switch
        {
            StorageType.String => parameter.AsString(),
            StorageType.ElementId => parameter.AsValueString() ?? parameter.AsElementId().Value.ToString(CultureInfo.InvariantCulture),
            StorageType.Integer => parameter.AsValueString() ?? parameter.AsInteger().ToString(CultureInfo.InvariantCulture),
            StorageType.Double => parameter.AsValueString() ?? parameter.AsDouble().ToString("R", CultureInfo.InvariantCulture),
            _ => parameter.AsValueString(),
        };
    }

    /// <summary>The element's location as text, so a move is a difference; null for an element without one.</summary>
    private static string? Where(Element element)
    {
        switch (element.Location)
        {
            case LocationPoint point:
                double? rotation = null;
                try
                {
                    rotation = point.Rotation;
                }
                catch (Exception)
                {
                    // Not every point-based element has a rotation.
                }
                return $"{Point(point.Point)} {(rotation is { } angle ? Number(angle) : "-")}";
            case LocationCurve { Curve: { IsBound: true } curve }:
                return $"{Point(curve.GetEndPoint(0))} {Point(curve.GetEndPoint(1))}";
            default:
                return null;
        }
    }

    private static string Point(XYZ point) => $"{Number(point.X)},{Number(point.Y)},{Number(point.Z)}";

    private static string Number(double value) => Math.Round(value, 6).ToString("R", CultureInfo.InvariantCulture);

    private sealed class Snapshot(long id)
    {
        public long Id { get; } = id;
        public string? Category { get; set; }
        public string? Family { get; set; }
        public string? Type { get; set; }
        public string? Name { get; set; }
        public Dictionary<long, (string Name, string? Value)>? Values { get; set; }
        public string? Location { get; set; }
        public string? ReadError { get; set; }

        public JsonObject Describe()
        {
            var json = new JsonObject { ["id"] = Id };
            if (ReadError is not null)
            {
                json["readError"] = ReadError;
                return json;
            }
            json["category"] = Category;
            json["family"] = Family;
            json["type"] = Type;
            if (Name is not null)
                json["name"] = Name;
            return json;
        }
    }

    private sealed class DocumentActions(DryRunChanges changes)
    {
        public DryRunChanges Changes { get; } = changes;
        public List<Snapshot> Created { get; } = [];
        public List<Snapshot> After { get; } = [];
        public List<Snapshot> Deleted { get; } = [];
        private readonly List<JsonObject> modified = [];
        private readonly Dictionary<string, int> touched = new(StringComparer.Ordinal);
        private int touchedTotal;

        public void Compare(Snapshot after, Snapshot before)
        {
            if (after.ReadError is not null || before.ReadError is not null)
            {
                var failed = (after.ReadError is null ? before : after).Describe();
                failed["id"] = after.Id;
                modified.Add(failed);
                return;
            }
            var keys = after.Values!.Keys.Union(before.Values!.Keys);
            var changed = keys
                .Select(key => (Name: (after.Values.TryGetValue(key, out var a) ? a : before.Values[key]).Name,
                    Before: before.Values.TryGetValue(key, out var b) ? b.Value : null,
                    After: after.Values.TryGetValue(key, out var c) ? c.Value : null))
                .Where(value => !string.Equals(value.Before, value.After, StringComparison.Ordinal))
                .OrderBy(value => value.Name, StringComparer.CurrentCultureIgnoreCase)
                .ToList();
            var moved = after.Location is not null && before.Location is not null && after.Location != before.Location;
            if (changed.Count == 0 && !moved)
            {
                var category = before.Category ?? after.Category ?? "(no category)";
                touched[category] = touched.GetValueOrDefault(category) + 1;
                touchedTotal++;
                return;
            }
            var entry = before.Describe();
            entry["values"] = new JsonArray(changed.Take(MaximumValues).Select(value => (JsonNode)new JsonObject
            {
                ["name"] = value.Name,
                ["before"] = value.Before,
                ["after"] = value.After,
            }).ToArray());
            if (moved)
                entry["moved"] = true;
            if (changed.Count > MaximumValues)
            {
                entry["changedValues"] = changed.Count;
                entry["truncated"] = true;
            }
            modified.Add(entry);
        }

        public JsonObject ToJson()
        {
            var notCompared = Changes.Modified.Count - After.Count;
            return new JsonObject
            {
                ["document"] = Changes.Title,
                ["path"] = Changes.Path,
                ["created"] = Groups(Created, Changes.Added.Count),
                ["modified"] = new JsonObject
                {
                    ["total"] = modified.Count,
                    ["notCompared"] = notCompared,
                    ["truncated"] = notCompared > 0 || modified.Any(entry => entry["truncated"] is not null),
                    ["elements"] = new JsonArray(modified.Select(entry => (JsonNode)entry).ToArray()),
                },
                ["deleted"] = Groups(Deleted, Changes.Deleted.Count),
                ["alsoTouched"] = new JsonObject
                {
                    ["total"] = touchedTotal,
                    ["categories"] = new JsonArray(touched.OrderBy(pair => pair.Key, StringComparer.CurrentCultureIgnoreCase)
                        .Select(pair => (JsonNode)new JsonObject { ["category"] = pair.Key, ["count"] = pair.Value }).ToArray()),
                },
            };
        }

        /// <summary>Created or deleted elements grouped by category, family and type, with counts; total is Revit's own count.</summary>
        private static JsonObject Groups(List<Snapshot> read, int total) => new()
        {
            ["total"] = total,
            ["truncated"] = read.Count < total,
            ["groups"] = new JsonArray(read
                .GroupBy(snapshot => (snapshot.ReadError is null ? snapshot.Category : null, snapshot.ReadError is null ? snapshot.Family : null, snapshot.ReadError is null ? snapshot.Type : null))
                .OrderBy(group => group.Key.Item1 ?? "￿", StringComparer.CurrentCultureIgnoreCase)
                .ThenBy(group => group.Key.Item2 ?? "", StringComparer.CurrentCultureIgnoreCase)
                .ThenBy(group => group.Key.Item3 ?? "", StringComparer.CurrentCultureIgnoreCase)
                .Select(group => (JsonNode)new JsonObject
                {
                    ["category"] = group.Key.Item1,
                    ["family"] = group.Key.Item2,
                    ["type"] = group.Key.Item3,
                    ["count"] = group.Count(),
                    ["elements"] = new JsonArray(group.Select(snapshot =>
                    {
                        var element = new JsonObject { ["id"] = snapshot.Id };
                        if (snapshot.Name is not null)
                            element["name"] = snapshot.Name;
                        if (snapshot.ReadError is not null)
                            element["readError"] = snapshot.ReadError;
                        return (JsonNode)element;
                    }).ToArray()),
                }).ToArray()),
        };
    }
}

/// <summary>
/// Spec #13 "Workshared Models" (D17, decision #78): after the rollback of a dry run that changed a workshared document,
/// release the person's borrowed elements with RelinquishOwnership, checked-out elements only, never worksets. Revit
/// has no per-element release, so unmodified elements the person had borrowed before are released too; elements they
/// changed and have not synchronized stay theirs. A failed release is reported, and the dry run still stands.
/// </summary>
internal static class DryRunRelease
{
    private const int MaximumIds = 1000;

    public static JsonArray? Release(IEnumerable<DryRunChanges> changed)
    {
        JsonArray? results = null;
        foreach (var entry in changed)
        {
            var document = entry.Document;
            bool workshared;
            try
            {
                workshared = entry.Changed && document.IsValidObject && document.IsWorkshared && !document.IsFamilyDocument;
            }
            catch (Exception)
            {
                continue;
            }
            if (!workshared)
                continue;
            var touched = entry.Modified.Concat(entry.Deleted).ToHashSet();
            var borrowed = new List<long>();
            foreach (var id in touched.Order())
            {
                try
                {
                    if (WorksharingUtils.GetCheckoutStatus(document, new ElementId(id)) == CheckoutStatus.OwnedByCurrentUser)
                        borrowed.Add(id);
                }
                catch (Exception)
                {
                    // An id Revit cannot check is not listed.
                }
            }
            var result = new JsonObject { ["document"] = entry.Title, ["path"] = entry.Path };
            try
            {
                var items = WorksharingUtils.RelinquishOwnership(document, new RelinquishOptions(false) { CheckedOutElements = true },
                    new TransactWithCentralOptions());
                var released = items.GetRelinquishedElements().Select(id => id.Value).Order().ToList();
                result["released"] = true;
                result["borrowedIds"] = Ids(borrowed);
                result["releasedIds"] = Ids(released);
                result["alsoReleasedIds"] = Ids(released.Where(id => !touched.Contains(id)).ToList());
            }
            catch (Exception exception)
            {
                result["released"] = false;
                result["error"] = $"{exception.GetType().Name}: {exception.Message}";
                result["borrowedIds"] = Ids(borrowed);
            }
            (results ??= []).Add(result);
        }
        return results;
    }

    private static JsonArray Ids(List<long> ids) => new(ids.Take(MaximumIds).Select(id => (JsonNode)id).ToArray());
}
