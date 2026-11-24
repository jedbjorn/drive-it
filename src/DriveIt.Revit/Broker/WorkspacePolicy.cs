using DriveIt.Core.Mode;

namespace DriveIt.Revit.Broker;

public static class WorkspacePolicy
{
    /// <summary>
    /// An outside-root path needs a person's decision (policy_required) in standard; in Dev Mode (spec #10) every path
    /// is allowed and the check is skipped.
    /// </summary>
    public static bool DecisionRequired => !InstallMode.IsDev;

    public static string CanonicalRoot(string? path)
    {
        var root = Canonicalize(path, "workspaceRoot");
        if (!Directory.Exists(root))
            throw new RequestRejectedException("workspace_root_not_found", $"The workspace root does not exist: {root}");
        return root;
    }

    public static string Canonicalize(string? path, string field)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new RequestRejectedException("invalid_path", $"{field} is required.");

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new RequestRejectedException("invalid_path", $"{field} is not a valid full path: {exception.Message}");
        }

        var root = Path.GetPathRoot(fullPath);
        if (string.IsNullOrEmpty(root))
            throw new RequestRejectedException("invalid_path", $"{field} must be an absolute path.");

        var current = root;
        var parts = fullPath[root.Length..].Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar,
            StringSplitOptions.RemoveEmptyEntries);
        foreach (var part in parts)
        {
            current = Path.Combine(current, part);
            var target = ResolveLink(current);
            if (target is not null)
                current = Path.GetFullPath(target);
        }

        return Path.TrimEndingDirectorySeparator(current);
    }

    public static bool IsInside(string root, string path)
    {
        if (string.Equals(root, path, StringComparison.OrdinalIgnoreCase))
            return true;
        var prefix = root + Path.DirectorySeparatorChar;
        return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsCovered(OutsideRootApproval? approval, string operation, string path)
    {
        if (approval is null || string.IsNullOrWhiteSpace(approval.DecisionId) || approval.Grants is null)
            return false;

        foreach (var grant in approval.Grants)
        {
            if (grant is null || grant.Paths is null ||
                !string.Equals(grant.Operation, operation, StringComparison.Ordinal))
                continue;
            foreach (var grantedPath in grant.Paths)
            {
                try
                {
                    if (string.Equals(Canonicalize(grantedPath, "outsideRootApproval.grants.paths"), path,
                            StringComparison.OrdinalIgnoreCase))
                        return true;
                }
                catch (RequestRejectedException)
                {
                }
            }
        }
        return false;
    }

    private static string? ResolveLink(string path)
    {
        FileAttributes attributes;
        try
        {
            attributes = File.GetAttributes(path);
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }

        if ((attributes & FileAttributes.ReparsePoint) == 0)
            return null;
        FileSystemInfo info = (attributes & FileAttributes.Directory) != 0
            ? new DirectoryInfo(path)
            : new FileInfo(path);
        return info.ResolveLinkTarget(true)?.FullName;
    }
}
