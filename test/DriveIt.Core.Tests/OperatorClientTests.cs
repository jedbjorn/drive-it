using System.Text.Json;
using DriveIt.Core.Operator;

namespace DriveIt.Core.Tests;

public class OperatorClientTests
{
    /// <summary>Answers each operator.js command from a table and records the calls.</summary>
    private sealed class FakeRunner : IOperatorRunner
    {
        public Dictionary<string, OperatorResult> Responses { get; } = new(StringComparer.Ordinal);

        public List<string> Calls { get; } = [];

        public Task<OperatorResult> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken = default)
        {
            var key = string.Join(' ', arguments);
            Calls.Add(key);
            return Task.FromResult(Responses.TryGetValue(key, out var result)
                ? result
                : new OperatorResult(2, "", "Usage: node server/operator.js ..."));
        }

        public FakeRunner Ok(string command, string json)
        {
            Responses[command] = new OperatorResult(0, json, "");
            return this;
        }

        public FakeRunner Fail(string command, string error)
        {
            Responses[command] = new OperatorResult(1, "", error);
            return this;
        }
    }

    [Fact]
    public async Task GetWorkspace_ReadsTheRoot()
    {
        var runner = new FakeRunner().Ok("workspace get", """{ "root": "C:\\DriveIt" }""");
        Assert.Equal(@"C:\DriveIt", await new OperatorClient(runner).GetWorkspaceAsync());
    }

    [Fact]
    public async Task GetWorkspace_IsNull_WhenNoneIsSelected()
    {
        var runner = new FakeRunner().Fail("workspace get",
            "WORKSPACE_NOT_SELECTED: Select a Drive It workspace root before executing scripts.\n");
        Assert.Null(await new OperatorClient(runner).GetWorkspaceAsync());
    }

    [Fact]
    public async Task OtherFailures_CarryTheExitCodeAndError()
    {
        var runner = new FakeRunner().Fail("workspace get", "EACCES: permission denied\n");
        var error = await Assert.ThrowsAsync<OperatorException>(() => new OperatorClient(runner).GetWorkspaceAsync());
        Assert.Equal("Drive It operator command failed (1): EACCES: permission denied", error.Message);
    }

    [Fact]
    public async Task SetWorkspace_PassesThePathAsOneArgument_AndReturnsTheCanonicalRoot()
    {
        var runner = new FakeRunner().Ok(@"workspace set C:\My Projects\Drive", """{ "root": "C:\\My Projects\\Drive" }""");
        var root = await new OperatorClient(runner).SetWorkspaceAsync(@" C:\My Projects\Drive ");
        Assert.Equal(@"C:\My Projects\Drive", root);
        Assert.Equal([@"workspace set C:\My Projects\Drive"], runner.Calls);
    }

    [Fact]
    public async Task SetWorkspace_RejectsABlankRoot_WithoutCallingOperator()
    {
        var runner = new FakeRunner();
        await Assert.ThrowsAsync<OperatorException>(() => new OperatorClient(runner).SetWorkspaceAsync("  "));
        Assert.Empty(runner.Calls);
    }

    [Fact]
    public async Task ListPending_KeepsOnlyPendingRows_AndToleratesUnknownFields()
    {
        var runner = new FakeRunner().Ok("decisions list", """
            [
              { "id": "d-1", "runId": "run-1", "status": "approved", "requests": [] },
              { "id": "d-2", "runId": "run-2", "status": "pending", "fingerprint": "x", "createdAt": "2026-01-01T00:00:00.000Z",
                "displayName": "Export door schedule", "somethingNew": { "nested": true },
                "requests": [ { "operation": "write_file", "paths": [ "D:\\out\\doors.csv" ] } ] },
              { "status": "pending", "requests": [] },
              { "id": "d-3", "runId": "run-3", "status": "pending",
                "requests": [ { "operation": "read", "paths": [ "D:\\a.rvt", "D:\\b.rvt" ] }, { "operation": "delete", "paths": [ "D:\\c" ] } ] }
            ]
            """);
        var pending = await new OperatorClient(runner).ListPendingAsync();

        Assert.Equal(["d-2", "d-3"], pending.Select(p => p.Id));
        Assert.Equal(@"Export door schedule — write_file D:\out\doors.csv", pending[0].Label);
        Assert.Equal(@"run-3 — read D:\a.rvt (+2 more)", pending[1].Label);
    }

    [Fact]
    public async Task ListPending_IsEmpty_ForAnEmptyList()
    {
        var runner = new FakeRunner().Ok("decisions list", "[]\n");
        Assert.Empty(await new OperatorClient(runner).ListPendingAsync());
    }

    [Theory]
    [InlineData(true, "decisions approve d-2", "approved")]
    [InlineData(false, "decisions deny d-2", "denied")]
    public async Task Decide_SendsApproveOrDeny(bool approve, string command, string status)
    {
        var runner = new FakeRunner().Ok(command, $$"""{ "id": "d-2", "status": "{{status}}" }""");
        Assert.Equal(status, await new OperatorClient(runner).DecideAsync("d-2", approve));
        Assert.Equal([command], runner.Calls);
    }

    [Fact]
    public async Task Decide_ReportsAnAlreadyDecidedRequest()
    {
        var runner = new FakeRunner().Fail("decisions deny d-1", "OPERATOR_COMMAND_FAILED: Decision d-1 is approved.");
        var error = await Assert.ThrowsAsync<OperatorException>(() => new OperatorClient(runner).DecideAsync("d-1", approve: false));
        Assert.Contains("Decision d-1 is approved.", error.Message);
    }

    [Fact]
    public async Task ListHistory_KeepsOrder_AndStopsAtTheLimit()
    {
        var rows = string.Join(",", Enumerable.Range(0, 120).Select(i =>
            $$"""{ "runId": "run-{{i}}", "status": "succeeded", "startedAt": "2026-01-01T00:00:00.000Z" }"""));
        var runner = new FakeRunner().Ok("history list", $"[{rows}]");

        var history = await new OperatorClient(runner).ListHistoryAsync();

        Assert.Equal(OperatorClient.DefaultHistoryLimit, history.Count);
        Assert.Equal("run-0", history[0].RunId);
        Assert.Equal("run-99", history[^1].RunId);
    }

    [Fact]
    public async Task UnreadableOutput_IsAnOperatorError()
    {
        var runner = new FakeRunner().Ok("history list", "not json");
        await Assert.ThrowsAsync<OperatorException>(() => new OperatorClient(runner).ListHistoryAsync());
    }

    [Fact]
    public void HistoryLabel_UsesTheDisplayName_StatusAndLocalTime()
    {
        var zone = TimeZoneInfo.CreateCustomTimeZone("Test+2", TimeSpan.FromHours(2), "Test+2", "Test+2");
        using var json = JsonDocument.Parse("""
            { "runId": "7f3c", "status": "succeeded", "startedAt": "2026-11-23T08:05:00.000Z",
              "displayName": "  Renumber\n level 2 doors ", "extra": [1, 2] }
            """);
        var run = RunRecord.FromJson(json.RootElement, zone);

        Assert.Equal("Renumber level 2 doors · succeeded · 2026-11-23 10:05", run.Label);
    }

    [Fact]
    public void HistoryLabel_FallsBackToTheRunId()
    {
        using var json = JsonDocument.Parse("""{ "runId": "7f3c", "status": "denied", "displayName": " " }""");
        Assert.Equal("7f3c · denied", RunRecord.FromJson(json.RootElement).Label);
    }

    [Fact]
    public void HistoryDetails_IsTheWholeReceiptIndented_WithPathsUnescaped()
    {
        using var json = JsonDocument.Parse("""{"runId":"r","workspaceRoot":"C:\\Café","checks":[{"passed":true}]}""");
        var details = RunRecord.FromJson(json.RootElement).Details;

        Assert.Contains("\"workspaceRoot\": \"C:\\\\Café\"", details);
        Assert.Contains("\"passed\": true", details);
        Assert.Contains("\n", details);
    }

    [Fact]
    public void PendingDetails_ListsNameIdsOperationsAndPaths()
    {
        using var json = JsonDocument.Parse("""
            { "id": "d-9", "runId": "run-9", "status": "pending", "displayName": "Copy families",
              "requests": [ { "operation": "read", "paths": [ "E:\\lib\\a.rfa", "E:\\lib\\b.rfa" ] }, { "operation": "write_file", "paths": [] } ] }
            """);
        var request = PendingRequest.FromJson(json.RootElement)!;
        var lines = request.Details.Split(Environment.NewLine);

        Assert.Equal(
            ["Copy families", "", "Request: d-9", "Run: run-9", "",
             "Operation: read", @"Resolved path: E:\lib\a.rfa", @"Resolved path: E:\lib\b.rfa", "",
             "Operation: write_file"],
            lines);
        Assert.Equal(@"Copy families — read E:\lib\a.rfa (+2 more)", request.Label);
    }

    [Fact]
    public void PendingLabel_WithoutOperations_IsTheName()
    {
        using var json = JsonDocument.Parse("""{ "id": "d-1", "status": "pending" }""");
        Assert.Equal("d-1", PendingRequest.FromJson(json.RootElement)!.Label);
    }
}
