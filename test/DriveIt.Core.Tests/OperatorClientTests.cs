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
        Assert.Equal("Drive-It could not finish that. EACCES: permission denied", error.Message);
        // The catch-all code says nothing a person can use; with no reason at all, the exit code is what there is.
        Assert.Equal("Drive-It could not finish that. mcp.json does not exist; reinstall Drive-It",
            OperatorText.CommandFailed(1, "OPERATOR_COMMAND_FAILED: mcp.json does not exist; reinstall Drive-It\n"));
        Assert.Equal("Drive-It could not finish that (exit code 2).", OperatorText.CommandFailed(2, " "));
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
        Assert.Equal("Renumber level 2 doors", run.Title);
        Assert.Equal("succeeded · 2026-11-23 10:05", run.Meta);
    }

    [Fact]
    public void HistoryMeta_LabelsAHeldRun_WithHowLongItHeldRevit()
    {
        var zone = TimeZoneInfo.CreateCustomTimeZone("Test+0", TimeSpan.Zero, "Test+0", "Test+0");
        using var json = JsonDocument.Parse("""
            { "runId": "r", "status": "stopped", "startedAt": "2026-11-24T08:05:00.000Z", "displayName": "Place desks",
              "held": { "ms": 20412, "calls": 310 } }
            """);
        var run = RunRecord.FromJson(json.RootElement, zone);

        Assert.Equal(TimeSpan.FromMilliseconds(20412), run.Held);
        Assert.Equal("stopped · held Revit 20 s · 2026-11-24 08:05", run.Meta);
    }

    [Theory]
    [InlineData("""{ "runId": "r", "status": "succeeded", "held": null }""")]
    [InlineData("""{ "runId": "r", "status": "succeeded" }""")]
    [InlineData("""{ "runId": "r", "status": "succeeded", "held": { "ms": "20" } }""")]
    public void HistoryMeta_DoesNotLabelARunThatNeverHeldRevit(string receipt)
    {
        using var json = JsonDocument.Parse(receipt);
        var run = RunRecord.FromJson(json.RootElement);
        Assert.Null(run.Held);
        Assert.Equal("succeeded", run.Meta);
    }

    [Fact]
    public void HistoryMeta_LabelsADryRun_First()
    {
        var zone = TimeZoneInfo.CreateCustomTimeZone("Test+0", TimeSpan.Zero, "Test+0", "Test+0");
        using var json = JsonDocument.Parse("""
            { "runId": "r", "status": "succeeded", "startedAt": "2026-11-24T08:05:00.000Z", "displayName": "Delete the old stair",
              "dryRun": true, "rolledBack": true, "held": { "ms": 1200, "calls": 40 } }
            """);
        var run = RunRecord.FromJson(json.RootElement, zone);

        Assert.True(run.DryRun);
        Assert.Equal("Dry run · succeeded · held Revit 1.2 s · 2026-11-24 08:05", run.Meta);
        // The row shows the label as a badge and the rest beside it.
        Assert.Equal("succeeded · held Revit 1.2 s · 2026-11-24 08:05", run.Detail);
        Assert.Equal("Delete the old stair · Dry run · succeeded · held Revit 1.2 s · 2026-11-24 08:05", run.Label);
    }

    [Theory]
    [InlineData("""{ "runId": "r", "status": "succeeded", "dryRun": false, "rehearsedBy": null }""")]
    [InlineData("""{ "runId": "r", "status": "succeeded" }""")]
    [InlineData("""{ "runId": "r", "status": "succeeded", "dryRun": "true" }""")]
    public void HistoryMeta_DoesNotLabelARealRun(string receipt)
    {
        using var json = JsonDocument.Parse(receipt);
        var run = RunRecord.FromJson(json.RootElement);
        Assert.False(run.DryRun);
        Assert.Equal("succeeded", run.Meta);
    }

    [Fact]
    public void HoldText_LabelsADryRun()
    {
        Assert.Equal("Drive-It · Dry run", HoldText.DryRunWindowTitle);
        Assert.Equal("Dry run", HoldText.DryRunLabel);
        Assert.Contains("rolled back", HoldText.DryRunNote);
    }

    [Fact]
    public async Task ScriptTimeLimit_IsReadAndSavedThroughOperator()
    {
        var runner = new FakeRunner()
            .Ok("settings get", """{ "scriptTimeLimitSeconds": 120 }""")
            .Ok("settings set-time-limit 20", """{ "scriptTimeLimitSeconds": 20 }""");
        var client = new OperatorClient(runner);

        Assert.Equal(120, await client.GetScriptTimeLimitAsync());
        Assert.Equal(20, await client.SetScriptTimeLimitAsync(20));
        Assert.Equal(["settings get", "settings set-time-limit 20"], runner.Calls);
    }

    [Fact]
    public async Task ScriptTimeLimit_OutOfRange_IsRejectedWithoutCallingOperator()
    {
        var runner = new FakeRunner();
        var error = await Assert.ThrowsAsync<OperatorException>(() => new OperatorClient(runner).SetScriptTimeLimitAsync(5));
        Assert.Contains("10 to 600", error.Message);
        Assert.Empty(runner.Calls);
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
    public async Task DetectAgents_PassesMcpJsonAndListsOneLinePerClient()
    {
        var runner = new FakeRunner().Ok(@"clients detect C:\DriveIt\mcp.json", """
            [ { "client": "claude-desktop", "name": "Claude Desktop", "status": "added", "message": "Claude Desktop: Added. Restart Claude Desktop to use Drive-It." },
              { "client": "claude-code", "name": "Claude Code", "status": "already", "message": "Claude Code: Already set up." },
              { "client": "codex", "name": "ChatGPT and Codex", "status": "failed", "reason": "x", "message": "ChatGPT and Codex: Could not add. x" } ]
            """);
        var rows = await new OperatorClient(runner).DetectAgentsAsync(@"C:\DriveIt\mcp.json");
        Assert.Equal(new[] { "added", "already", "failed" }, rows.Select(row => row.Status).ToArray());
        Assert.Equal("Claude Code: Already set up.", rows[1].Message);
        Assert.Equal("claude-desktop", rows[0].Client);
    }

    [Fact]
    public async Task DetectAgents_FailureCarriesTheReason()
    {
        var runner = new FakeRunner().Fail(@"clients detect C:\DriveIt\mcp.json", "OPERATOR_COMMAND_FAILED: C:\\DriveIt\\mcp.json does not exist; reinstall Drive-It\n");
        var error = await Assert.ThrowsAsync<OperatorException>(() => new OperatorClient(runner).DetectAgentsAsync(@"C:\DriveIt\mcp.json"));
        Assert.Contains("does not exist; reinstall Drive-It", error.Message);
    }

    [Fact]
    public async Task DetectAgents_WithNoRows_IsAnError()
    {
        var runner = new FakeRunner().Ok(@"clients detect C:\m.json", "[]");
        await Assert.ThrowsAsync<OperatorException>(() => new OperatorClient(runner).DetectAgentsAsync(@"C:\m.json"));
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
