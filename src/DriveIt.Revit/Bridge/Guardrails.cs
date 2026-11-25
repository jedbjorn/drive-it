using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using DriveIt.Core.Mode;
using RevitApplication = Autodesk.Revit.ApplicationServices.Application;

namespace DriveIt.Revit.Bridge;

/// <summary>
/// What stays out of a script's reach through the bridge (spec #15 "Guardrails"): handles only for Revit model
/// API objects, the document calls that stay with built-in operations, and callbacks a script cannot write.
/// A guardrail, not a sandbox. In Dev Mode (spec #10) every guardrail here allows; the technical limits (callbacks a
/// script cannot write, the handle cap) stay in both modes.
/// </summary>
internal static class Guardrails
{
    /// <summary>The most handles one run may hold; past it a call fails rather than dropping any.</summary>
    public const int MaximumHandles = 100_000;

    private static readonly Assembly RevitApi = typeof(Document).Assembly;
    private static readonly ConcurrentDictionary<Type, bool> Allowed = new();
    private static readonly ConcurrentDictionary<Type, bool> Callbacks = new();
    private static readonly HashSet<string> CollectionNamespaces = ["System.Collections.Generic", "System.Collections.ObjectModel"];

    /// <summary>Calls that open, create, save or close documents; the built-in operation carries the policy and file receipt.</summary>
    private static readonly (Type Owner, string Member, string Instead)[] BuiltInOnly =
    [
        (typeof(Document), "Save", "save_document"),
        (typeof(Document), "SaveAs", "save_as_document"),
        (typeof(Document), "SaveAsCloud", "save_as_document"),
        (typeof(Document), "Close", "close_document"),
        (typeof(Document), "EditFamily", "edit_family"),
        (typeof(RevitApplication), "OpenDocumentFile", "open_document"),
        (typeof(RevitApplication), "OpenBuildingComponentDocument", "open_document"),
        (typeof(RevitApplication), "OpenCloudDocument", "open_document"),
        (typeof(RevitApplication), "NewProjectDocument", "create_document"),
        (typeof(RevitApplication), "NewProjectTemplateDocument", "create_document"),
        (typeof(RevitApplication), "NewFamilyDocument", "create_document"),
    ];

    /// <summary>
    /// Calls that leave the Revit session and cannot be rolled back: synchronize with central, reload latest and print
    /// (spec #16 "Calls Refused", flag #28). Every Revit 2026 and 2027 API member that does one of these.
    /// </summary>
    private static readonly (Type Owner, string Member, string Action)[] LeaveTheSession =
    [
        (typeof(Document), "SynchronizeWithCentral", "synchronize with central"),
        (typeof(Document), "ReloadLatest", "reload latest"),
        (typeof(Document), "Print", "print"),
        (typeof(View), "Print", "print"),
        (typeof(PrintManager), "SubmitPrint", "print"),
    ];

    /// <summary>
    /// Document calls that need the run's transaction group closed first, as the built-in save and close close it. Only a
    /// Dev Mode script reaches them directly; the bridge then keeps what the run did to that document before the call.
    /// </summary>
    private static readonly HashSet<string> CommitPoints = ["Save", "SaveAs", "SaveAsCloud", "Close", "SynchronizeWithCentral", "ReloadLatest"];

    /// <summary>Refuses a handle for anything but a Revit model API object or a standard collection of them; in Dev Mode any object gets one.</summary>
    public static void RequireAllowed(Type type)
    {
        if (!InstallMode.IsDev && !IsAllowed(type))
            throw new BridgeException("type_not_allowed",
                $"Drive-It gives a script handles only to Revit model API objects (Autodesk.Revit.DB and the collections it returns); a {BridgeCalls.TypeName(type)} is not one.");
    }

    /// <summary>
    /// Refuses the document calls that stay with Drive-It, naming the built-in to use; in Dev Mode they are callable.
    /// Events stay refused in both modes: a script cannot write the handler.
    /// </summary>
    public static void RequireCallable(Type type, string member)
    {
        if (!InstallMode.IsDev)
            RequireNotRefused(type, member);
        if (member.StartsWith("add_", StringComparison.Ordinal) || member.StartsWith("remove_", StringComparison.Ordinal))
        {
            if (type.GetEvent(member[(member.IndexOf('_') + 1)..]) is not null)
                throw new BridgeException("callback_not_supported",
                    $"{BridgeCalls.TypeName(type)}.{member[(member.IndexOf('_') + 1)..]} is an event; a script cannot subscribe to Revit events.");
        }
    }

    /// <summary>
    /// A dry run refuses, in both modes, the members with lasting effects a rollback cannot undo (spec #13 D13): the
    /// commit points (save, save-as, close, synchronize, reload latest) and printing. Opening documents stays allowed.
    /// </summary>
    public static void RequireNotLasting(Type type, string member)
    {
        var lasting = IsCommitPoint(type, member)
            || LeaveTheSession.Any(entry => entry.Member == member && entry.Owner.IsAssignableFrom(type));
        if (lasting)
            throw new BridgeException("not_allowed_in_dry_run",
                $"{BridgeCalls.TypeName(type)}.{member} has a lasting effect a rollback cannot undo, so it is not allowed in a dry run. Leave it out of the dry run; the real run, or the person in Revit, can do it.");
    }

    /// <summary>
    /// While Require dry run is on, in both modes and every run, the same members are refused (spec #13 D13), except
    /// closing a document with no unsaved changes, which loses nothing (D10).
    /// </summary>
    public static void RequireNotLastingWhileRequired(Type type, string member, object? target)
    {
        var lasting = IsCommitPoint(type, member)
            || LeaveTheSession.Any(entry => entry.Member == member && entry.Owner.IsAssignableFrom(type));
        if (!lasting || (member == "Close" && target is Document { IsModified: false }))
            return;
        var reason = member == "Close" && target is Document document
            ? $"{document.Title} has unsaved changes and closing it would discard them"
            : "it has a lasting effect a rollback cannot undo";
        throw new BridgeException(RequireDryRunRules.NotAllowed,
            RequireDryRunRules.NotAllowedMessage($"{BridgeCalls.TypeName(type)}.{member}", reason));
    }

    /// <summary>A member that makes a new document, as create_document and edit_family do (Dev Mode only).</summary>
    public static bool CreatesDocument(Type type, string member) =>
        BuiltInOnly.Any(entry => entry.Instead is ("create_document" or "edit_family") && entry.Member == member && entry.Owner.IsAssignableFrom(type));

    /// <summary>A member that opens a document by path, as open_document does (Dev Mode only).</summary>
    public static bool OpensDocument(Type type, string member) =>
        BuiltInOnly.Any(entry => entry.Instead == "open_document" && entry.Member == member && entry.Owner.IsAssignableFrom(type));

    /// <summary>True for a Document call that needs the run's group on that document closed first (Dev Mode only).</summary>
    public static bool IsCommitPoint(Type type, string member) => typeof(Document).IsAssignableFrom(type) && CommitPoints.Contains(member);

    private static void RequireNotRefused(Type type, string member)
    {
        foreach (var (owner, name, action) in LeaveTheSession)
        {
            if (name == member && owner.IsAssignableFrom(type))
                throw new BridgeException("member_not_allowed",
                    $"{owner.Name}.{member} leaves the Revit session and cannot be rolled back, so Drive-It does not run it. Ask the user to {action} in Revit.");
        }
        foreach (var (owner, name, instead) in BuiltInOnly)
        {
            if (name == member && owner.IsAssignableFrom(type))
                throw new BridgeException("member_not_allowed",
                    $"{owner.Name}.{member} stays with Drive-It's built-in operations, which apply the workspace policy and record the file in the receipt; call revit.{instead}(...) instead.");
        }
    }

    /// <summary>
    /// A callback Drive-It does not supply: a delegate, or a Revit interface no Revit class implements (Revit calls
    /// back into it). IFamilyLoadOptions and IDuplicateTypeNamesHandler come from the revit.options helpers.
    /// </summary>
    public static bool IsUnsupportedCallback(Type type) => Callbacks.GetOrAdd(type, candidate =>
        typeof(Delegate).IsAssignableFrom(candidate)
        || (candidate.IsInterface && candidate.Assembly == RevitApi
            && candidate != typeof(IFamilyLoadOptions) && candidate != typeof(IDuplicateTypeNamesHandler)
            && !RevitApi.GetExportedTypes().Any(implementation => implementation is { IsClass: true, IsAbstract: false } && candidate.IsAssignableFrom(implementation))));

    public static BridgeException CallbackNotSupported(Type owner, string member, Type callback) => new("callback_not_supported",
        $"{BridgeCalls.TypeName(owner)}.{member} needs a {BridgeCalls.TypeName(callback)}, an object Revit calls back into, and a script cannot write one. "
        + "Drive-It supplies two: revit.options.family_load(...) for IFamilyLoadOptions and revit.options.copy_paste(...) for CopyPasteOptions.");

    /// <summary>Builds the object a revit.options helper stands for, when the parameter takes it.</summary>
    public static bool TryOption(JsonObject settings, Type target, out object? value)
    {
        value = settings["$option"]?.GetValue<string>() switch
        {
            "family_load" when target.IsAssignableFrom(typeof(FamilyLoadOptions)) =>
                new FamilyLoadOptions(Flag(settings, "overwrite"), Flag(settings, "overwriteParameterValues")),
            "copy_paste" when target == typeof(CopyPasteOptions) => CopyPaste(settings),
            "copy_paste" when target.IsAssignableFrom(typeof(DuplicateTypeNames)) => new DuplicateTypeNames(DuplicateAction(settings)),
            _ => null,
        };
        return value is not null;
    }

    private static CopyPasteOptions CopyPaste(JsonObject settings)
    {
        var options = new CopyPasteOptions();
        options.SetDuplicateTypeNamesHandler(new DuplicateTypeNames(DuplicateAction(settings)));
        return options;
    }

    private static bool Flag(JsonObject settings, string name) =>
        settings[name] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    private static DuplicateTypeAction DuplicateAction(JsonObject settings) =>
        settings["duplicateTypes"] is JsonValue value && value.TryGetValue<string>(out var text) && text == "use_destination"
            ? DuplicateTypeAction.UseDestinationTypes
            : DuplicateTypeAction.Abort;

    private static bool IsAllowed(Type type) => Allowed.GetOrAdd(type, candidate =>
    {
        if (candidate.Assembly == RevitApi)
            return true;
        if (candidate.IsArray)
            return IsItem(candidate.GetElementType()!);
        return candidate.IsGenericType
            && candidate.Namespace is { } name && CollectionNamespaces.Contains(name)
            && candidate.GetGenericArguments().All(IsItem);
    });

    /// <summary>What a standard collection may hold: Revit objects, values that cross by value, or anything checked when it crosses.</summary>
    private static bool IsItem(Type type) =>
        type.IsPrimitive || type == typeof(string) || type == typeof(decimal) || type == typeof(Guid) || type == typeof(object) || IsAllowed(type);

    /// <summary>
    /// revit.options.family_load: "this family is already loaded; replace it?" Without overwrite the loaded family
    /// is kept, the choice that changes least.
    /// </summary>
    private sealed class FamilyLoadOptions(bool overwrite, bool overwriteParameterValues) : IFamilyLoadOptions
    {
        public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValuesOut)
        {
            overwriteParameterValuesOut = overwriteParameterValues;
            return overwrite;
        }

        public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValuesOut)
        {
            source = overwrite ? FamilySource.Family : FamilySource.Project;
            overwriteParameterValuesOut = overwriteParameterValues;
            return overwrite;
        }
    }

    /// <summary>revit.options.copy_paste: "a type with this name exists; use the destination's?" Abort unless asked.</summary>
    private sealed class DuplicateTypeNames(DuplicateTypeAction action) : IDuplicateTypeNamesHandler
    {
        public DuplicateTypeAction OnDuplicateTypeNamesFound(DuplicateTypeNamesHandlerArgs args) => action;
    }
}
