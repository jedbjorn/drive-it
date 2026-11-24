using System.Text.Json;

namespace DriveIt.Core.Operator;

/// <summary>The program, script and data directory one operator.js call runs with.</summary>
/// <param name="Node">The Node.js executable.</param>
/// <param name="Script">The installed <c>server/operator.js</c>.</param>
/// <param name="DataDirectory">
/// The <c>DRIVE_IT_DATA_DIR</c> to pass, or null to let operator.js use its default
/// (<c>%LOCALAPPDATA%\DriveIt</c>).
/// </param>
public sealed record OperatorLaunch(string Node, string Script, string? DataDirectory);

/// <summary>What the locator reads from the machine; tests substitute each part.</summary>
public sealed class OperatorHost
{
    /// <summary>The installed <c>app</c> directory (the parent of <c>addin</c> and <c>operator</c>), or null when unknown.</summary>
    public string? AppDirectory { get; init; }

    public Func<string, string?> GetEnvironmentVariable { get; init; } = Environment.GetEnvironmentVariable;

    public Func<string, bool> FileExists { get; init; } = File.Exists;

    public Func<string, string> ReadAllText { get; init; } = File.ReadAllText;

    /// <summary>%LOCALAPPDATA%.</summary>
    public string LocalApplicationData { get; init; } =
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    /// <summary>
    /// The installed layout around <paramref name="assemblyDirectory"/>: <c>app\operator</c>, or
    /// <c>app\addin\&lt;year&gt;</c>, one add-in build per supported Revit year.
    /// </summary>
    public static OperatorHost ForAssemblyDirectory(string? assemblyDirectory)
    {
        if (string.IsNullOrEmpty(assemblyDirectory)) return new();
        var parent = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(assemblyDirectory));
        if (parent is not null && string.Equals(Path.GetFileName(parent), "addin", StringComparison.OrdinalIgnoreCase))
            parent = Path.GetDirectoryName(parent);
        return new() { AppDirectory = parent };
    }
}

/// <summary>
/// Finds the Node.js runtime and <c>server/operator.js</c> the same way the PowerShell
/// operator module (<c>operator/DriveIt.Operator.psm1</c>) does, so both surfaces read and
/// write the same local state:
/// <list type="bullet">
/// <item>Node: <c>DRIVE_IT_OPERATOR_NODE</c>, else <c>app\runtimes\node\node.exe</c>; when that
/// file is missing, the <c>command</c> of the <c>drive-it</c> entry in mcp.json, then <c>node.exe</c> on PATH.</item>
/// <item>Script: <c>DRIVE_IT_OPERATOR_SCRIPT</c>, else <c>app\server\operator.js</c>; when missing,
/// <c>operator.js</c> next to the server named in mcp.json.</item>
/// <item>Data directory: <c>DRIVE_IT_DATA_DIR</c>, else the one mcp.json gives the MCP server, else
/// operator.js's default.</item>
/// </list>
/// mcp.json is <c>DRIVE_IT_MCP_CONFIG_PATH</c>, else the one in the install root (the parent of
/// <c>app</c>), else <c>%LOCALAPPDATA%\DriveIt\mcp.json</c>.
/// </summary>
public static class OperatorLocator
{
    public const string NodeVariable = "DRIVE_IT_OPERATOR_NODE";
    public const string ScriptVariable = "DRIVE_IT_OPERATOR_SCRIPT";
    public const string DataDirectoryVariable = "DRIVE_IT_DATA_DIR";
    public const string McpConfigurationVariable = "DRIVE_IT_MCP_CONFIG_PATH";
    public const string ServerName = "drive-it";

    /// <summary>The MCP configuration file the window names (and reads the server entry from).</summary>
    public static string McpConfigurationPath(OperatorHost host)
    {
        var configured = host.GetEnvironmentVariable(McpConfigurationVariable);
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        if (host.AppDirectory is { } app && Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(app)) is { Length: > 0 } install)
        {
            var beside = Path.Combine(install, "mcp.json");
            if (host.FileExists(beside)) return beside;
        }
        return Path.Combine(host.LocalApplicationData, "DriveIt", "mcp.json");
    }

    /// <summary>Resolves one launch; throws <see cref="OperatorException"/> with the module's messages when a part is missing.</summary>
    public static OperatorLaunch Locate(OperatorHost host)
    {
        var entry = ReadServerEntry(host);

        var node = host.GetEnvironmentVariable(NodeVariable) is { } n && !string.IsNullOrWhiteSpace(n)
            ? n
            : host.AppDirectory is { } app ? Path.Combine(app, "runtimes", "node", "node.exe") : null;
        if (node is null || !host.FileExists(node))
        {
            node = entry?.Command is { } command && host.FileExists(command) ? command : FindOnPath(host, "node.exe");
            if (node is null) throw new OperatorException("Drive It could not locate its Node.js runtime.");
        }

        var script = host.GetEnvironmentVariable(ScriptVariable) is { } s && !string.IsNullOrWhiteSpace(s)
            ? s
            : host.AppDirectory is { } root ? Path.Combine(root, "server", "operator.js") : null;
        if (script is null || !host.FileExists(script))
        {
            var sibling = entry?.Server is { } server && Path.GetDirectoryName(server) is { Length: > 0 } directory
                ? Path.Combine(directory, "operator.js")
                : null;
            if (sibling is not null && host.FileExists(sibling)) script = sibling;
            else throw new OperatorException($"Drive It operator runtime is not installed: {script ?? "server\\operator.js"}");
        }

        var data = host.GetEnvironmentVariable(DataDirectoryVariable) is { } d && !string.IsNullOrWhiteSpace(d)
            ? d
            : entry?.DataDirectory;
        return new OperatorLaunch(node, script, string.IsNullOrWhiteSpace(data) ? null : data);
    }

    /// <summary>
    /// The data directory operator.js and the MCP server use: <c>DRIVE_IT_DATA_DIR</c>, else the one
    /// mcp.json gives the MCP server, else <c>%LOCALAPPDATA%\DriveIt</c> (server/store.js's default).
    /// </summary>
    public static string DataDirectory(OperatorHost host)
    {
        var configured = host.GetEnvironmentVariable(DataDirectoryVariable);
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        if (ReadServerEntry(host)?.DataDirectory is { } fromConfiguration && !string.IsNullOrWhiteSpace(fromConfiguration))
            return fromConfiguration;
        return Path.Combine(host.LocalApplicationData, "DriveIt");
    }

    private sealed record ServerEntry(string? Command, string? Server, string? DataDirectory);

    /// <summary>The <c>mcpServers.drive-it</c> entry of mcp.json; null when the file is missing or unreadable.</summary>
    private static ServerEntry? ReadServerEntry(OperatorHost host)
    {
        try
        {
            var path = McpConfigurationPath(host);
            if (!host.FileExists(path)) return null;
            using var document = JsonDocument.Parse(host.ReadAllText(path));
            if (!document.RootElement.TryGetProperty("mcpServers", out var servers)
                || servers.ValueKind != JsonValueKind.Object
                || !servers.TryGetProperty(ServerName, out var entry)
                || entry.ValueKind != JsonValueKind.Object)
                return null;
            var command = Json.String(entry, "command");
            string? server = null;
            if (entry.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array
                && args.GetArrayLength() > 0 && args[0].ValueKind == JsonValueKind.String)
                server = args[0].GetString();
            string? data = null;
            if (entry.TryGetProperty("env", out var env) && env.ValueKind == JsonValueKind.Object)
                data = Json.String(env, DataDirectoryVariable);
            return new ServerEntry(command, server, data);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private static string? FindOnPath(OperatorHost host, string fileName)
    {
        var path = host.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(path)) return null;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(directory.Trim('"'), fileName);
                if (host.FileExists(candidate)) return candidate;
            }
            catch (ArgumentException)
            {
                // A malformed PATH entry; skip it.
            }
        }
        return null;
    }
}
