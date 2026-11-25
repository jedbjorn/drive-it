using DriveIt.Core.Operator;

namespace DriveIt.Core.Tests;

public class OperatorLocatorTests
{
    private static readonly string Install = Path.Combine(Path.GetTempPath(), "DriveIt-locator", "DriveIt");
    private static readonly string App = Path.Combine(Install, "app");
    private static readonly string BundledNode = Path.Combine(App, "runtimes", "node", "node.exe");
    private static readonly string BundledScript = Path.Combine(App, "server", "operator.js");
    private static readonly string LocalAppData = Path.Combine(Path.GetTempPath(), "DriveIt-locator", "LocalAppData");

    private static OperatorHost Host(
        IEnumerable<string> files,
        Dictionary<string, string>? env = null,
        Dictionary<string, string>? contents = null,
        string? app = null)
    {
        var set = files.ToHashSet(StringComparer.Ordinal);
        if (contents is not null) set.UnionWith(contents.Keys);
        return new OperatorHost
        {
            AppDirectory = app ?? App,
            GetEnvironmentVariable = name => env is not null && env.TryGetValue(name, out var value) ? value : null,
            FileExists = set.Contains,
            ReadAllText = path => contents![path],
            LocalApplicationData = LocalAppData,
        };
    }

    private static string McpJson(string command, string server, string? dataDirectory) =>
        System.Text.Json.JsonSerializer.Serialize(new
        {
            theme = "dark",
            mcpServers = new Dictionary<string, object>
            {
                ["other"] = new { command = "other.exe" },
                ["drive-it"] = new
                {
                    command,
                    args = new[] { server },
                    env = dataDirectory is null ? new Dictionary<string, string>() : new() { ["DRIVE_IT_DATA_DIR"] = dataDirectory },
                },
            },
        });

    [Fact]
    public void InstalledLayout_UsesTheBundledNodeAndOperatorScript()
    {
        var launch = OperatorLocator.Locate(Host([BundledNode, BundledScript]));
        Assert.Equal(new OperatorLaunch(BundledNode, BundledScript, null), launch);
    }

    [Fact]
    public void ForAssemblyDirectory_IsTheAppAboveAYearsAddinOrTheOperator()
    {
        Assert.Equal(App, OperatorHost.ForAssemblyDirectory(Path.Combine(App, "addin", "2026")).AppDirectory);
        Assert.Equal(App, OperatorHost.ForAssemblyDirectory(Path.Combine(App, "addin", "2027") + Path.DirectorySeparatorChar).AppDirectory);
        Assert.Equal(App, OperatorHost.ForAssemblyDirectory(Path.Combine(App, "operator") + Path.DirectorySeparatorChar).AppDirectory);
    }

    [Fact]
    public void EnvironmentOverrides_WinAsInTheModule()
    {
        var node = Path.Combine(LocalAppData, "custom", "node.exe");
        var script = Path.Combine(LocalAppData, "custom", "operator-stub.mjs");
        var data = Path.Combine(LocalAppData, "state");
        var launch = OperatorLocator.Locate(Host([node, script, BundledNode, BundledScript], new()
        {
            [OperatorLocator.NodeVariable] = node,
            [OperatorLocator.ScriptVariable] = script,
            [OperatorLocator.DataDirectoryVariable] = data,
        }));
        Assert.Equal(new OperatorLaunch(node, script, data), launch);
    }

    [Fact]
    public void McpJsonBesideTheApp_SuppliesTheDataDirectory()
    {
        var mcp = Path.Combine(Install, "mcp.json");
        var launch = OperatorLocator.Locate(Host([BundledNode, BundledScript], contents: new()
        {
            [mcp] = McpJson(BundledNode, Path.Combine(App, "server", "index.js"), Install),
        }));
        Assert.Equal(Install, launch.DataDirectory);
        Assert.Equal(mcp, OperatorLocator.McpConfigurationPath(Host([mcp])));
    }

    [Fact]
    public void WithoutTheAppLayout_TheMcpEntryLocatesNodeAndTheScript()
    {
        var elsewhere = Path.Combine(LocalAppData, "DriveIt", "app");
        var node = Path.Combine(elsewhere, "runtimes", "node", "node.exe");
        var script = Path.Combine(elsewhere, "server", "operator.js");
        var mcp = Path.Combine(LocalAppData, "DriveIt", "mcp.json");
        var launch = OperatorLocator.Locate(Host([node, script], contents: new()
        {
            [mcp] = McpJson(node, Path.Combine(elsewhere, "server", "index.js"), null),
        }));
        Assert.Equal(new OperatorLaunch(node, script, null), launch);
    }

    [Fact]
    public void NodeOnPath_IsTheLastResort()
    {
        var bin = Path.Combine(LocalAppData, "bin");
        var node = Path.Combine(bin, "node.exe");
        var launch = OperatorLocator.Locate(Host([node, BundledScript], new()
        {
            ["PATH"] = string.Join(Path.PathSeparator, Path.Combine(LocalAppData, "nothing"), "\"" + bin + "\""),
        }));
        Assert.Equal(node, launch.Node);
    }

    [Fact]
    public void MissingNode_HasTheModulesMessage()
    {
        var error = Assert.Throws<OperatorException>(() => OperatorLocator.Locate(Host([BundledScript])));
        Assert.Equal("Drive-It could not locate its Node.js runtime.", error.Message);
    }

    [Fact]
    public void MissingScript_NamesTheExpectedPath()
    {
        var error = Assert.Throws<OperatorException>(() => OperatorLocator.Locate(Host([BundledNode])));
        Assert.Equal($"Drive-It operator runtime is not installed: {BundledScript}", error.Message);
    }

    [Fact]
    public void UnreadableMcpJson_IsIgnored()
    {
        var mcp = Path.Combine(Install, "mcp.json");
        var launch = OperatorLocator.Locate(Host([BundledNode, BundledScript], contents: new() { [mcp] = "{ not json" }));
        Assert.Null(launch.DataDirectory);
    }

    [Fact]
    public void ConfiguredMcpPath_IsUsed()
    {
        var mcp = Path.Combine(LocalAppData, "client.json");
        var host = Host([], new() { [OperatorLocator.McpConfigurationVariable] = mcp });
        Assert.Equal(mcp, OperatorLocator.McpConfigurationPath(host));
    }
}
