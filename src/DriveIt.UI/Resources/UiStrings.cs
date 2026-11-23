// Adapted from splash-it src/SplashIt.UI/Resources/UiStrings.cs (splash-it commit ad7796d, MIT, same owner).
// Changes: only the strings Theme.xaml needs (the text box menu), as English constants
// instead of a .resx lookup; the operator window's own text is in its XAML.

namespace DriveIt.UI.Resources;

/// <summary>
/// English strings Theme.xaml binds with <c>{x:Static res:UiStrings.Key}</c>. Fixed English,
/// as in splash-it: WPF's built-in command text would follow WPF's culture, not Revit's language.
/// </summary>
public static class UiStrings
{
    public static string Edit_Cut => "Cut";

    public static string Edit_Copy => "Copy";

    public static string Edit_Paste => "Paste";
}
