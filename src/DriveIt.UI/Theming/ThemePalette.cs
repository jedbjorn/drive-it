// Copied from splash-it src/SplashIt.UI/Theming/ThemePalette.cs (splash-it commit ad7796d, MIT, same owner).
// Changes: namespaces; comments say Drive-It; reads DriveItTheme where splash-it reads SplashItTheme. (splash-it copied it from gantt-it src/GanttIt.Revit/UI/Theming/ThemePalette.cs, commit aa83f35.)

using System.Windows;
using System.Windows.Media;
using DriveIt.Core.Theming;

namespace DriveIt.UI.Theming;

/// <summary>
/// The palette brushes for <see cref="DriveItTheme.Current"/>, merged first into
/// Theme.xaml so its styles and every view's <c>{StaticResource …Brush}</c> resolve
/// to the light or dark color. A new instance is built each time a Drive-It window
/// (or dialog) loads Theme.xaml, which is how the theme is applied per window open.
/// </summary>
public sealed class ThemePalette : ResourceDictionary
{
    public ThemePalette()
    {
        foreach (var (key, color) in UiPalette.For(DriveItTheme.Current))
            Add(key, Brush(color));

        if (!DriveItTheme.IsDark) return;

        // Dark only: the built-in WPF templates that draw with system colors (the
        // default focus rectangle, scroll viewer corners) pick these up instead of
        // the light Windows colors. Menu colors are not overridden: the Windows menu
        // keeps a fixed light background, so Theme.xaml replaces the menus instead.
        var palette = UiPalette.For(UiTheme.Dark);
        Add(SystemColors.WindowBrushKey, Brush(palette[UiPalette.Surface]));
        Add(SystemColors.WindowTextBrushKey, Brush(palette[UiPalette.Text]));
        Add(SystemColors.ControlBrushKey, Brush(palette[UiPalette.ScrollTrack]));
        Add(SystemColors.ControlTextBrushKey, Brush(palette[UiPalette.Text]));
        Add(SystemColors.GrayTextBrushKey, Brush(palette[UiPalette.MutedText]));
        Add(SystemColors.InfoBrushKey, Brush(palette[UiPalette.ToolTip]));
        Add(SystemColors.InfoTextBrushKey, Brush(palette[UiPalette.ToolTipText]));
    }

    private static SolidColorBrush Brush(UiColor c)
    {
        var brush = new SolidColorBrush(Color.FromArgb(c.A, c.R, c.G, c.B));
        brush.Freeze();
        return brush;
    }
}
