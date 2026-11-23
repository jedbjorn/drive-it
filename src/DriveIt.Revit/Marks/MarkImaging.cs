using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace DriveIt.Revit.Marks;

/// <summary>
/// Reads the exported PNG and draws marks on it with WPF, the imaging stack already loaded in the
/// Revit process, so the installer gains no runtime dependency.
/// </summary>
internal static class MarkImaging
{
    private static readonly Color MarkRed = Color.FromRgb(0xD7, 0x1F, 0x1F);

    public static (int Width, int Height, byte[] Bgra) ReadBgra(string path)
    {
        using var stream = File.OpenRead(path);
        var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
        var frame = new FormatConvertedBitmap(decoder.Frames[0], PixelFormats.Bgra32, null, 0);
        var width = frame.PixelWidth;
        var height = frame.PixelHeight;
        var bytes = new byte[width * height * 4];
        frame.CopyPixels(bytes, width * 4, 0);
        return (width, height, bytes);
    }

    private static BitmapSource Source(int width, int height, byte[] bgra)
    {
        var source = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgra32, null, bgra, width * 4);
        source.Freeze();
        return source;
    }

    private static void Save(BitmapSource image, string path)
    {
        // Opaque 24-bit: the export has no transparency, and an alpha channel only adds bytes.
        var opaque = new FormatConvertedBitmap(image, PixelFormats.Bgr24, null, 0);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(opaque));
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
        encoder.Save(stream);
    }

    /// <summary>A red disc with a thin white edge and a white number, so it reads over red or dark lines.</summary>
    private static void DrawMark(DrawingContext context, double x, double y, int number, int radius, Typeface typeface)
    {
        var edge = Math.Max(1.0, radius / 8.0);
        context.DrawEllipse(new SolidColorBrush(MarkRed), new Pen(Brushes.White, edge), new Point(x, y), radius, radius);
        var text = number.ToString(CultureInfo.InvariantCulture);
        var size = text.Length switch { 1 => radius * 1.25, 2 => radius * 1.1, 3 => radius * 0.85, _ => radius * 0.7 };
        var formatted = new FormattedText(text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, typeface, size, Brushes.White, 1.0);
        context.DrawText(formatted, new Point(x - formatted.Width / 2, y - formatted.Height / 2));
    }

    /// <summary>Writes the export with its marks to a new file at path; the image size is unchanged.</summary>
    public static void DrawMarks(int width, int height, byte[] bgra, IReadOnlyList<(double X, double Y, int Number)> marks, int radius, string path)
    {
        var typeface = new Typeface(new FontFamily("Segoe UI"), FontStyles.Normal, FontWeights.Bold, FontStretches.Normal);
        var visual = new DrawingVisual();
        using (var context = visual.RenderOpen())
        {
            context.DrawImage(Source(width, height, bgra), new Rect(0, 0, width, height));
            foreach (var (x, y, number) in marks)
                DrawMark(context, x, y, number, radius, typeface);
        }
        var target = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        target.Render(visual);
        Save(target, path);
    }

    /// <summary>
    /// Verification only, never part of the tool result: when DRIVE_IT_MARKS_DIAGNOSTICS names an
    /// existing directory in Revit's environment, a marked capture also writes the unmarked export,
    /// a false-colour map of the element each pixel shows, and a report, so an image check can test
    /// every mark against the export. Failures here never affect the capture.
    /// </summary>
    public static void WriteDiagnostics(string? directory, string label, string exportPath, int width, int height, MarkOutcome outcome, JsonObject report)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathFullyQualified(directory) || !Directory.Exists(directory))
            return;
        try
        {
            var stem = Path.Combine(directory, string.Concat(label.Where(c => char.IsAsciiLetterOrDigit(c) || c == '-')));
            File.Copy(exportPath, stem + ".export.png", overwrite: true);
            var bytes = new byte[width * height * 4];
            for (var p = 0; p < outcome.Regions.Length; p++)
            {
                var id = outcome.Regions[p];
                byte r, g, b;
                if (id == -1)
                    r = g = b = 255;
                else if (id < 0)
                {
                    r = 255;
                    g = 0;
                    b = 255;
                }
                else
                {
                    var h = (uint)(id * 2654435761u);
                    r = (byte)(64 + (h & 0x7F));
                    g = (byte)(64 + ((h >> 8) & 0x7F));
                    b = (byte)(64 + ((h >> 16) & 0x7F));
                }
                bytes[p * 4] = b;
                bytes[p * 4 + 1] = g;
                bytes[p * 4 + 2] = r;
                bytes[p * 4 + 3] = 255;
            }
            if (File.Exists(stem + ".idmap.png"))
                File.Delete(stem + ".idmap.png");
            Save(Source(width, height, bytes), stem + ".idmap.png");
            File.WriteAllText(stem + ".report.json", report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception)
        {
            // Diagnostics are best effort.
        }
    }
}
