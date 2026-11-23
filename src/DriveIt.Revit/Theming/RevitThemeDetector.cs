// Copied from splash-it src/SplashIt.Revit/Theming/RevitThemeDetector.cs (splash-it commit ad7796d, MIT, same owner),
// which splash-it adapted from gantt-it src/GanttIt.Revit/UI/Theming/GanttItTheme.cs (gantt-it commit aa83f35).
// Changes: namespaces; the Debug-only override reads DRIVEIT_THEME; comments say Drive-It.

using System.Windows;
using Autodesk.Revit.UI;
using Microsoft.Win32;
using DriveIt.Core.Theming;

namespace DriveIt.Revit.Theming;

/// <summary>
/// Revit's effective UI theme as plain light or dark (splash-it decision #4). The ribbon icon
/// and the operator window (through DriveItTheme.Apply) use it.
/// </summary>
public static class RevitThemeDetector
{
    /// <summary>
    /// Revit's effective UI theme. With Revit's "Use system setting" option on
    /// (<see cref="UIThemeManager.FollowSystemColorTheme"/>) the Windows app theme is read
    /// directly, so the result is right whether or not <see cref="UIThemeManager.CurrentTheme"/>
    /// resolves the system setting itself. Anything unreadable falls back to light, and so
    /// does Windows high contrast. Never throws.
    /// </summary>
    public static UiTheme Detect()
    {
#if DEBUG
        // Debug builds only: DRIVEIT_THEME=dark|light forces a theme for quick captures.
        switch (Environment.GetEnvironmentVariable("DRIVEIT_THEME")?.Trim().ToLowerInvariant())
        {
            case "dark": return UiTheme.Dark;
            case "light": return UiTheme.Light;
        }
#endif
        try
        {
            if (SystemParameters.HighContrast) return UiTheme.Light;
            if (UIThemeManager.FollowSystemColorTheme && WindowsAppTheme() is { } system) return system;
            return UIThemeManager.CurrentTheme == UITheme.Dark ? UiTheme.Dark : UiTheme.Light;
        }
        catch (Exception)
        {
            return UiTheme.Light;
        }
    }

    /// <summary>The Windows "app mode" (Settings › Personalization › Colors), or null when it can't be read.</summary>
    private static UiTheme? WindowsAppTheme()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int light ? (light == 0 ? UiTheme.Dark : UiTheme.Light) : null;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
