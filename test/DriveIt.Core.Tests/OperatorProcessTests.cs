using DriveIt.Core.Operator;

namespace DriveIt.Core.Tests;

/// <summary>The client against the real server/operator.js, through Node.js on PATH (CI installs Node 22).</summary>
public class OperatorProcessTests
{
    private static string? FindNode()
    {
        var names = OperatingSystem.IsWindows() ? new[] { "node.exe" } : ["node"];
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            foreach (var name in names)
            {
                var candidate = Path.Combine(directory, name);
                if (File.Exists(candidate)) return candidate;
            }
        return null;
    }

    private static string RepositoryRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "server", "operator.js"))) return dir.FullName;
        throw new InvalidOperationException("server/operator.js not found above " + AppContext.BaseDirectory);
    }

    [Fact]
    public async Task RealOperator_SelectsAWorkspace_AndListsEmptyState()
    {
        var node = FindNode();
        Assert.True(node is not null, "Node.js must be on PATH for this test.");
        var fixture = Directory.CreateTempSubdirectory("drive-it-core-");
        try
        {
            var data = Path.Combine(fixture.FullName, "data");
            var root = Directory.CreateDirectory(Path.Combine(fixture.FullName, "workspace with spaces é")).FullName;
            var host = new OperatorHost
            {
                AppDirectory = Path.Combine(fixture.FullName, "app"),
                LocalApplicationData = fixture.FullName,
                GetEnvironmentVariable = name => name switch
                {
                    OperatorLocator.NodeVariable => node,
                    OperatorLocator.ScriptVariable => Path.Combine(RepositoryRoot(), "server", "operator.js"),
                    OperatorLocator.DataDirectoryVariable => data,
                    _ => null,
                },
            };
            var client = new OperatorClient(new ProcessOperatorRunner(host));

            Assert.Null(await client.GetWorkspaceAsync());
            var saved = await client.SetWorkspaceAsync(root);
            // operator.js canonicalizes (on Windows that can expand 8.3 names in the temp path).
            Assert.EndsWith(Path.DirectorySeparatorChar + "workspace with spaces é", saved);
            Assert.Equal(saved, await client.GetWorkspaceAsync());
            Assert.Empty(await client.ListPendingAsync());
            Assert.Empty(await client.ListHistoryAsync());
            var error = await Assert.ThrowsAsync<OperatorException>(() => client.DecideAsync("missing", approve: true));
            Assert.Contains("Unknown outside-root decision: missing", error.Message);
        }
        finally
        {
            fixture.Delete(recursive: true);
        }
    }
}
