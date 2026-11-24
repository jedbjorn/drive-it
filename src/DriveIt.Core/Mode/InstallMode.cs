using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace DriveIt.Core.Mode;

/// <summary>The two install modes (spec #10): standard (every guardrail on) and dev (every guardrail off).</summary>
public enum DriveItMode
{
    Standard,
    Dev,
}

/// <summary>This Windows user's admin marker as found: <see cref="Owner"/> and <see cref="Text"/> are null when it does not exist.</summary>
public sealed record MarkerCheck(string Sid, string? Owner, string? Text);

/// <summary>What the resolver reads from the machine; tests substitute each part.</summary>
public sealed class ModeHost
{
    /// <summary>%LOCALAPPDATA%, the folder of the user mode file's <c>DriveIt</c> directory.</summary>
    public string LocalApplicationData { get; init; } =
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    /// <summary>%ProgramData%, the folder of the admin marker's <c>DriveIt\dev-mode</c> directory.</summary>
    public string ProgramData { get; init; } =
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);

    /// <summary>The text of a file, or null when it is missing or unreadable.</summary>
    public Func<string, string?> ReadText { get; init; } = ReadTextOrNull;

    /// <summary>The current user's marker in a directory, or null when it cannot be checked (not Windows, no SID).</summary>
    public Func<string, MarkerCheck?> InspectMarker { get; init; } = InspectWindowsMarker;

    private static string? ReadTextOrNull(string path)
    {
        try
        {
            return File.ReadAllText(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    private static MarkerCheck? InspectWindowsMarker(string directory)
    {
        if (!OperatingSystem.IsWindows()) return null;
        var sid = WindowsIdentity.GetCurrent().User?.Value;
        if (string.IsNullOrEmpty(sid)) return null;
        var path = Path.Combine(directory, sid + ".json");
        if (!File.Exists(path)) return new MarkerCheck(sid, null, null);
        var owner = new FileInfo(path).GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier))?.Value;
        return new MarkerCheck(sid, owner, File.ReadAllText(path));
    }
}

/// <summary>
/// The install mode: the .NET one mode resolver, shared by the Revit add-in and the Drive-It window.
/// server/mode.js is its Node twin; both read the same two install-owned files under the same rule:
/// <list type="number">
/// <item>the user mode file <c>%LOCALAPPDATA%\DriveIt\install-mode.json</c> (<c>{ "mode": "dev" | "standard" }</c>),
/// written by every install;</item>
/// <item>the admin marker <c>%ProgramData%\DriveIt\dev-mode\&lt;user-SID&gt;.json</c> (<c>{ "mode": "dev", "sid": … }</c>),
/// written only by an elevated dev install and owned by Administrators.</item>
/// </list>
/// The mode is <see cref="DriveItMode.Dev"/> only when the user file says dev and this user's marker
/// exists, is owned by SYSTEM or Administrators, and names this user's SID. Anything else, any
/// failure included, is <see cref="DriveItMode.Standard"/>. No request, argument, script or
/// environment variable is consulted. A guardrail checks <see cref="IsDev"/> at its own site.
/// </summary>
public static class InstallMode
{
    public const string UserFileName = "install-mode.json";
    public const string StandardName = "standard";
    public const string DevName = "dev";

    /// <summary>SYSTEM and BUILTIN\Administrators: the owners an elevated install leaves on the marker.</summary>
    public static readonly IReadOnlyList<string> TrustedMarkerOwners = ["S-1-5-18", "S-1-5-32-544"];

    private static readonly Lazy<DriveItMode> Resolved = new(() => Resolve(new ModeHost()).Mode);

    /// <summary>This process's mode, resolved once: it changes only by reinstalling.</summary>
    public static DriveItMode Current => Resolved.Value;

    /// <summary>True when this process runs in Dev Mode; a guardrail then allows.</summary>
    public static bool IsDev => Current == DriveItMode.Dev;

    /// <summary>"dev" or "standard", as the server and receipts spell it.</summary>
    public static string Name(DriveItMode mode) => mode == DriveItMode.Dev ? DevName : StandardName;

    public static string UserFilePath(ModeHost host) => Path.Combine(host.LocalApplicationData, "DriveIt", UserFileName);

    public static string MarkerDirectory(ModeHost host) => Path.Combine(host.ProgramData, "DriveIt", "dev-mode");

    /// <summary>Resolves the mode on <paramref name="host"/>; never throws.</summary>
    public static (DriveItMode Mode, string Reason) Resolve(ModeHost host)
    {
        try
        {
            var userFileText = host.ReadText(UserFilePath(host));
            // The marker is checked only when the user file asks for dev.
            if (UserFileRefusal(userFileText) is { } refusal) return (DriveItMode.Standard, refusal);
            return Decide(userFileText, host.InspectMarker(MarkerDirectory(host)));
        }
        catch (Exception exception)
        {
            return (DriveItMode.Standard, "the mode could not be resolved: " + exception.Message);
        }
    }

    /// <summary>The rule itself, with no I/O; <paramref name="marker"/> is null when it was not or could not be checked.</summary>
    public static (DriveItMode Mode, string Reason) Decide(string? userFileText, MarkerCheck? marker)
    {
        if (UserFileRefusal(userFileText) is { } refusal) return (DriveItMode.Standard, refusal);
        if (marker is null || string.IsNullOrEmpty(marker.Sid)) return (DriveItMode.Standard, "the admin marker could not be checked");
        if (marker.Text is null) return (DriveItMode.Standard, $"no admin marker for {marker.Sid}");
        if (marker.Owner is null || !TrustedMarkerOwners.Contains(marker.Owner))
            return (DriveItMode.Standard, $"the admin marker is owned by {marker.Owner ?? "nobody"}, not SYSTEM or Administrators");
        if (!(ReadString(marker.Text, "mode") == DevName && ReadString(marker.Text, "sid") == marker.Sid))
            return (DriveItMode.Standard, $"the admin marker is not a dev marker for {marker.Sid}");
        return (DriveItMode.Dev, $"the user mode file and the admin marker for {marker.Sid} say dev");
    }

    private static string? UserFileRefusal(string? userFileText)
    {
        if (userFileText is null) return "no user mode file";
        if (!IsObject(userFileText)) return "the user mode file is not a JSON object";
        var mode = ReadString(userFileText, "mode");
        return mode == DevName ? null : $"the user mode file says {(mode is null ? "null" : JsonSerializer.Serialize(mode))}";
    }

    private static bool IsObject(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static string? ReadString(string text, string property)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty(property, out var value)
                && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
