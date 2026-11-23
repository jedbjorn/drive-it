// The Windows app-theme read is splash-it's RevitThemeDetector.WindowsAppTheme
// (splash-it src/SplashIt.Revit/Theming/RevitThemeDetector.cs, commit ad7796d, MIT, same owner),
// with its high-contrast rule; used outside Revit, where there is no Revit theme to follow.

using System.Windows;
using DriveIt.Core.Theming;
using Microsoft.Win32;

namespace DriveIt.UI.Theming;

/// <summary>The theme for the window opened from the Start Menu: the Windows app mode, light when unreadable or in high contrast.</summary>
public static class WindowsTheme
{
    /// <summary>Never throws.</summary>
    public static UiTheme Detect()
    {
        try
        {
            if (SystemParameters.HighContrast) return UiTheme.Light;
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int light && light == 0 ? UiTheme.Dark : UiTheme.Light;
        }
        catch (Exception)
        {
            return UiTheme.Light;
        }
    }
}
