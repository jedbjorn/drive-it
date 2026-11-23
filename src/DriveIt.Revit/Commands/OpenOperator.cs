// Adapted from splash-it src/SplashIt.Revit/Commands/OpenSettings.cs (splash-it commit ad7796d, MIT,
// same owner). Changes: opens DriveIt.UI's operator window modeless (splash-it's settings window is
// modal); no log; TransactionMode.ReadOnly, since the window never changes the model.

using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using DriveIt.Revit.Theming;
using DriveIt.UI;

namespace DriveIt.Revit.Commands;

/// <summary>
/// The Drive-It ribbon button (<c>DriveIt.OpenOperator</c>): opens the operator window modeless,
/// owned by Revit's main window, in Revit's current theme. A second click brings the open window
/// forward. Available with no document open.
/// </summary>
[Transaction(TransactionMode.ReadOnly)]
public sealed class OpenOperator : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        try
        {
            OperatorLauncher.Show(commandData.Application.MainWindowHandle, RevitThemeDetector.Detect());
            return Result.Succeeded;
        }
        catch (Exception exception)
        {
            // Nothing in Revit changed; Revit shows this message.
            message = $"Drive-It could not open its window ({exception.GetType().Name}: {exception.Message}).";
            return Result.Failed;
        }
    }
}

/// <summary>Keeps the Drive-It button enabled everywhere, including with no document open.</summary>
public sealed class AlwaysAvailable : IExternalCommandAvailability
{
    public bool IsCommandAvailable(UIApplication applicationData, CategorySet selectedCategories) => true;
}
