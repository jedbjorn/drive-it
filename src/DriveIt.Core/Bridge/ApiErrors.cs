namespace DriveIt.Core.Bridge;

/// <summary>
/// The message of a <c>revit_api_error</c> (spec #16 "An API error names the member"): the type and member called,
/// then the exception Revit threw and its own message. Every place the add-in raises that error builds it here.
/// </summary>
public static class ApiErrors
{
    /// <summary>"<paramref name="type"/>.<paramref name="member"/>: ExceptionType: message".</summary>
    public static string Message(string type, string member, Exception exception) =>
        $"{type}.{member}: {exception.GetType().Name}: {exception.Message}";
}
