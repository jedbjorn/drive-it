// Copied from splash-it src/SplashIt.UI/Theming/SplashItTheme.cs (splash-it commit ad7796d, MIT, same owner).
// Changes: renamed DriveItTheme; namespaces; comments say Drive-It. Inside Revit the add-in passes Revit's detected theme; DriveIt.Operator.exe passes the Windows app theme (WindowsTheme).

using DriveIt.Core.Theming;

namespace DriveIt.UI.Theming;

/// <summary>
/// Which palette Drive-It's windows use: Revit's UI theme, as detected by the Revit side
/// (splash-it decision #4) and passed in through <see cref="Apply"/>. It is
/// read when a window loads Theme.xaml (each load builds a new <see cref="ThemePalette"/>),
/// so a window keeps the theme it opened with, as in gantt-it.
/// </summary>
public static class DriveItTheme
{
    /// <summary>The theme of the next window to open (and its dialogs). Light until the first <see cref="Apply"/>.</summary>
    public static UiTheme Current { get; private set; } = UiTheme.Light;

    public static bool IsDark => Current == UiTheme.Dark;

    /// <summary>
    /// Sets the theme for the windows opened from now on. The Revit side calls it with its
    /// detected theme before opening the operator window (gantt-it's rules: light for high
    /// contrast or anything unreadable). UI thread only.
    /// </summary>
    public static void Apply(UiTheme theme) => Current = theme;
}
