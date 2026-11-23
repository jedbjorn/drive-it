using System.Globalization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace DriveIt.Revit.Broker;

/// <summary>
/// view.capture: exports one existing graphical view with Document.ExportImage, in Revit's API
/// context, into the empty staging directory the MCP server created for this capture. It starts no
/// transaction and creates no view; the server validates, hashes and publishes the PNG.
/// </summary>
public sealed partial class DocumentDispatcher
{
    public const string CaptureRequestType = "view.capture";
    public const string ReferenceImagesDirectoryName = "_reference-images";
    private const int MinimumPixelSize = 256;
    private const int MaximumPixelSize = 2048;
    // Per view type, so a large model's many plans cannot crowd its 3D views and sections out.
    private const int MaximumListedViewsPerType = 20;
    private const int MaximumOtherViewsPerType = 5;

    /// <summary>The graphical model views a capture accepts, in RVT and RFA documents alike.</summary>
    private static readonly HashSet<ViewType> CapturableViewTypes =
    [
        ViewType.ThreeD,
        ViewType.FloorPlan,
        ViewType.CeilingPlan,
        ViewType.EngineeringPlan,
        ViewType.Elevation,
        ViewType.Section,
        ViewType.Detail,
    ];

    /// <summary>Errors after which the agent most needs to know which views it can capture.</summary>
    private static readonly HashSet<string> ListViewsAfter = new(StringComparer.Ordinal)
    {
        "no_active_view", "view_not_found", "not_a_view", "view_is_template", "unsupported_view_type",
        "view_not_exportable",
    };

    private BrokerResponse Capture(UIApplication application, BrokerRequest request)
    {
        var response = new BrokerResponse { Id = request.Id, Type = CaptureRequestType };
        var capture = request.Capture!;
        string? stagingDirectory = null;
        Document? document = null;
        try
        {
            var target = ValidateCaptureTarget(capture.TargetPath);
            stagingDirectory = Path.GetDirectoryName(target)!;
            if (capture.PixelSize is < MinimumPixelSize or > MaximumPixelSize)
                throw new RequestRejectedException("invalid_pixel_size",
                    $"pixelSize must be an integer from {MinimumPixelSize} through {MaximumPixelSize}.");

            // Identity is checked here, in the API context, not when the request was queued.
            var state = ResolveCaptureDocument(application, request.Document);
            document = state.Document;
            response.Document = IdentitySnapshot(state);
            var view = SelectView(application, document, capture.ViewId);
            var receipt = new CaptureReceipt
            {
                ViewId = view.Id.Value.ToString(CultureInfo.InvariantCulture),
                ViewUniqueId = view.UniqueId,
                ViewName = view.Name,
                ViewType = view.ViewType.ToString(),
                PixelSize = capture.PixelSize,
                DocumentModifiedBefore = document.IsModified,
            };
            response.Capture = receipt;

            var fit = LongerSideFit(view);
            receipt.FitDirection = fit.ToString();
            var options = new ImageExportOptions
            {
                ExportRange = ExportRange.SetOfViews,
                ZoomType = ZoomFitType.FitToPage,
                FitDirection = fit,
                PixelSize = capture.PixelSize,
                HLRandWFViewsFileType = ImageFileType.PNG,
                ShadowViewsFileType = ImageFileType.PNG,
                ImageResolution = ImageResolution.DPI_72,
                // Revit appends the view name to this stem; the staging directory is empty, so the
                // one file it holds afterwards is the export.
                FilePath = Path.Combine(stagingDirectory, "export"),
            };
            options.SetViewsAndSheets(new List<ElementId> { view.Id });
            document.ExportImage(options);

            var produced = Directory.GetFiles(stagingDirectory);
            if (produced.Length != 1 || !string.Equals(Path.GetExtension(produced[0]), ".png", StringComparison.OrdinalIgnoreCase))
                throw new RequestRejectedException("export_output_unexpected",
                    $"Revit's image export produced {produced.Length} file(s) instead of one PNG.");
            File.Move(produced[0], target);
            receipt.OutputPath = target;
            receipt.DocumentModifiedAfter = document.IsModified;
            response.Status = "succeeded";
        }
        catch (RequestRejectedException exception)
        {
            Fail(response, exception.Code, exception.Message, document, stagingDirectory);
        }
        catch (Exception exception)
        {
            Fail(response, "export_failed", $"Revit could not export the view: {exception.Message}", document, stagingDirectory);
        }
        return response;
    }

    private void Fail(BrokerResponse response, string code, string message, Document? document, string? stagingDirectory)
    {
        response.Status = "failed";
        response.Error = new ErrorReceipt { Code = code, Message = message };
        if (document is not null && ListViewsAfter.Contains(code))
        {
            response.Capture ??= new CaptureReceipt();
            try
            {
                var (available, other) = ListViews(document);
                response.Capture.AvailableViews = available;
                response.Capture.OtherViews = other;
            }
            catch (Exception)
            {
                // The list is a convenience; the error stands without it.
            }
        }
        if (response.Capture is not null)
            response.Capture.OutputPath = null;
        RemoveStagedFiles(stagingDirectory);
    }

    /// <summary>
    /// The server's target is &lt;launch root&gt;\_reference-images\&lt;session&gt;\&lt;staging&gt;\&lt;capture&gt;.png
    /// in a fresh, empty staging directory that is a real directory, not a link.
    /// </summary>
    private static string ValidateCaptureTarget(string? targetPath)
    {
        if (string.IsNullOrWhiteSpace(targetPath) || !Path.IsPathFullyQualified(targetPath)
            || !string.Equals(Path.GetExtension(targetPath), ".png", StringComparison.OrdinalIgnoreCase))
            throw new RequestRejectedException("invalid_capture_target", "capture.targetPath must be an absolute .png path.");
        var target = Path.GetFullPath(targetPath);
        var staging = Path.GetDirectoryName(target);
        var session = staging is null ? null : Path.GetDirectoryName(staging);
        var references = session is null ? null : Path.GetDirectoryName(session);
        if (references is null || !string.Equals(Path.GetFileName(references), ReferenceImagesDirectoryName, StringComparison.OrdinalIgnoreCase))
            throw new RequestRejectedException("invalid_capture_target",
                $"capture.targetPath must lie in a staging directory under {ReferenceImagesDirectoryName}\\<session>.");
        if (!Directory.Exists(staging))
            throw new RequestRejectedException("invalid_capture_target", "The capture staging directory does not exist.");
        if ((File.GetAttributes(staging!) & FileAttributes.ReparsePoint) != 0)
            throw new RequestRejectedException("invalid_capture_target", "The capture staging directory is a link.");
        if (Directory.EnumerateFileSystemEntries(staging!).Any())
            throw new RequestRejectedException("invalid_capture_target", "The capture staging directory is not empty.");
        return target;
    }

    private DocumentState ResolveCaptureDocument(UIApplication application, DocumentTarget? target)
    {
        if (!string.IsNullOrWhiteSpace(target?.UniqueId) || !string.IsNullOrWhiteSpace(target?.Path))
        {
            return TryResolveInitial(application, target) ??
                throw new RequestRejectedException("document_not_open", "The selected document is not open in this Revit session.");
        }
        var active = application.ActiveUIDocument?.Document ??
            throw new RequestRejectedException("no_active_document",
                "No document is active in Revit's window; pass document.uniqueId from an execute_script receipt.");
        return Register(active);
    }

    private View SelectView(UIApplication application, Document document, string? viewId)
    {
        View view;
        if (string.IsNullOrWhiteSpace(viewId))
        {
            // Only this document's own active view; never another document's or an arbitrary view.
            view = document.ActiveView ?? throw new RequestRejectedException("no_active_view",
                $"'{document.Title}' has no active view (it is not the document shown in Revit's window, for example one Drive It opened in the background). Pass viewId; capturable views (up to 20 per view type) are listed in availableViews.");
        }
        else
        {
            if (!long.TryParse(viewId, NumberStyles.None, CultureInfo.InvariantCulture, out var raw) || raw <= 0)
                throw new RequestRejectedException("invalid_view_id", "viewId must be a positive decimal Revit element id.");
            var element = document.GetElement(new ElementId(raw));
            if (element is null)
            {
                var owner = OtherDocumentWithView(application, document, raw);
                if (owner is not null)
                    throw new RequestRejectedException("view_in_other_document",
                        $"View {viewId} is not in '{document.Title}'; a view with that id is in open document '{owner.Title}'. Element ids belong to one document: pass that document's identity, or a view id from '{document.Title}'.");
                throw new RequestRejectedException("view_not_found",
                    $"No element {viewId} exists in '{document.Title}' (it may have been deleted). Capturable views are listed in availableViews.");
            }
            view = element as View ?? throw new RequestRejectedException("not_a_view",
                $"Element {viewId} in '{document.Title}' is a {element.GetType().Name}, not a view.");
        }

        if (view.IsTemplate)
            throw new RequestRejectedException("view_is_template",
                $"View '{view.Name}' ({view.Id.Value}) is a view template, which has no graphics to export.");
        if (!CapturableViewTypes.Contains(view.ViewType))
            throw new RequestRejectedException("unsupported_view_type",
                $"View '{view.Name}' ({view.Id.Value}) is a {view.ViewType} view. Only 3D, floor plan, ceiling plan, structural plan, elevation, section and detail views can be captured; sheets, schedules, legends, drafting and other views cannot.");
        if (!view.CanBePrinted)
            throw new RequestRejectedException("view_not_exportable",
                $"Revit reports that view '{view.Name}' ({view.Id.Value}) cannot be printed or exported.");
        return view;
    }

    private static Document? OtherDocumentWithView(UIApplication application, Document document, long raw)
    {
        foreach (var candidate in OpenDocuments(application))
        {
            if (candidate.Equals(document))
                continue;
            if (candidate.GetElement(new ElementId(raw)) is View)
                return candidate;
        }
        return null;
    }

    /// <summary>pixelSize sizes the longer side, so a tall section is not exported taller than requested.</summary>
    private static FitDirectionType LongerSideFit(View view)
    {
        try
        {
            var outline = view.Outline;
            var width = outline.Max.U - outline.Min.U;
            var height = outline.Max.V - outline.Min.V;
            return height > width ? FitDirectionType.Vertical : FitDirectionType.Horizontal;
        }
        catch (Exception)
        {
            return FitDirectionType.Horizontal;
        }
    }

    /// <summary>
    /// Capturable views, and the document's other views with the reason they cannot be captured,
    /// so a failed selection tells the agent what it can pick instead.
    /// </summary>
    private static (List<ViewSummary> Available, List<ViewSummary> Other) ListViews(Document document)
    {
        var available = new List<ViewSummary>();
        var other = new List<ViewSummary>();
        var listed = new Dictionary<string, int>(StringComparer.Ordinal);
        var views = new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>()
            .Where(view => view.ViewType is not (ViewType.Internal or ViewType.ProjectBrowser
                or ViewType.SystemBrowser or ViewType.Undefined))
            .OrderBy(view => view.ViewType.ToString(), StringComparer.Ordinal)
            .ThenBy(view => view.Name, StringComparer.CurrentCultureIgnoreCase);
        foreach (var view in views)
        {
            var reason = view.IsTemplate ? "view_is_template"
                : !CapturableViewTypes.Contains(view.ViewType) ? "unsupported_view_type"
                : !view.CanBePrinted ? "view_not_exportable"
                : null;
            var key = $"{reason}:{view.ViewType}";
            var count = listed.GetValueOrDefault(key);
            if (count >= (reason is null ? MaximumListedViewsPerType : MaximumOtherViewsPerType))
                continue;
            listed[key] = count + 1;
            (reason is null ? available : other).Add(new ViewSummary
            {
                Id = view.Id.Value.ToString(CultureInfo.InvariantCulture),
                Name = view.Name,
                Type = view.ViewType.ToString(),
                NotCapturable = reason,
            });
        }
        return (available, other);
    }

    private static DocumentReceipt IdentitySnapshot(DocumentState state) => new()
    {
        UniqueId = state.Id,
        Title = state.Document.Title,
        Path = CanonicalDocumentPath(state.Document),
        Kind = DocumentKind(state.Document),
        IsReadOnly = state.Document.IsReadOnly,
    };

    /// <summary>Removes only plain files in the validated staging directory; the server removes the directory.</summary>
    private static void RemoveStagedFiles(string? stagingDirectory)
    {
        if (stagingDirectory is null || !Directory.Exists(stagingDirectory))
            return;
        try
        {
            if ((File.GetAttributes(stagingDirectory) & FileAttributes.ReparsePoint) != 0)
                return;
            foreach (var file in Directory.GetFiles(stagingDirectory))
                File.Delete(file);
        }
        catch (Exception)
        {
            // Best effort; the server removes what is left.
        }
    }
}
