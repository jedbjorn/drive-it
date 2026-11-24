using System.Text.Json;
using DriveIt.Core.Operator;

namespace DriveIt.Core.Tests;

/// <summary>Spec #13 "Require Dry Run" and "Staged Actions mode": the setting as the add-in reads it, the client calls, and the words the mode shows.</summary>
public class StagedActionsTests
{
    private sealed class FakeRunner : IOperatorRunner
    {
        public Dictionary<string, OperatorResult> Responses { get; } = new(StringComparer.Ordinal);

        public Task<OperatorResult> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken = default) =>
            Task.FromResult(Responses.TryGetValue(string.Join(' ', arguments), out var result) ? result : new OperatorResult(2, "", "Usage"));

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

    // The receipt fields staged get returns, shaped as the add-in's dry run actions (DryRunEvidence.cs).
    private const string Succeeded = """
        { "dryRun": {
            "runId": "dry-1", "displayName": "Renumber the level 2 doors", "completedAt": "2026-11-25T14:03:00.000Z",
            "status": "succeeded", "error": null, "document": { "title": "Tower", "path": "C:\\models\\Tower.rvt" },
            "rolledBack": true, "applied": true,
            "actions": [ {
              "document": "Tower", "path": "C:\\models\\Tower.rvt",
              "created": { "total": 3, "truncated": false, "groups": [
                { "category": "Walls", "family": "Basic Wall", "type": "Generic - 200mm", "count": 3,
                  "elements": [ { "id": 312045 }, { "id": 312046 }, { "id": 312047, "name": "North" } ] } ] },
              "modified": { "total": 2, "notCompared": 0, "truncated": false, "elements": [
                { "id": 1234, "category": "Doors", "family": "Single-Flush", "type": "0915 x 2134mm",
                  "values": [ { "name": "Mark", "before": "D12", "after": "D14" } ] },
                { "id": 1235, "category": "Doors", "family": "Single-Flush", "type": "0915 x 2134mm", "values": [], "moved": true } ] },
              "deleted": { "total": 1, "truncated": false, "groups": [
                { "category": "Windows", "family": "Fixed", "type": "0915 x 1220mm", "count": 1, "elements": [ { "id": 777 } ] } ] },
              "alsoTouched": { "total": 2, "categories": [ { "category": "Walls", "count": 2 } ] } } ],
            "images": [ { "viewId": "312", "name": "Level 2", "type": "FloorPlan", "path": "C:\\ref\\a.png", "error": null, "message": null },
                        { "viewId": "313", "name": "Sheet A1", "type": "DrawingSheet", "path": null, "error": "UNSUPPORTED_VIEW_TYPE", "message": "A sheet cannot be captured." } ],
            "worksharing": [ { "document": "Tower", "released": true }, { "document": "Annex", "released": false, "error": "central unreachable" } ] } }
        """;

    private static StagedDryRun Read(string json)
    {
        using var document = JsonDocument.Parse(json);
        return StagedDryRun.FromJson(document.RootElement, TimeZoneInfo.Utc)!;
    }

    [Fact]
    public void Setting_IsOnOnlyForAStoredTrue()
    {
        foreach (var (text, on) in new[]
                 {
                     ("""{ "requireDryRun": true }""", true), ("""{ "requireDryRun": false }""", false),
                     ("""{ "requireDryRun": "true" }""", false), ("""{ "requireDryRun": 1 }""", false),
                     ("{}", false), ("[true]", false), ("not json", false),
                 })
            Assert.Equal(on, RequireDryRun.Read("data", _ => text));
        Assert.False(RequireDryRun.Read("data", _ => throw new FileNotFoundException()));
    }

    [Fact]
    public async Task GetSettings_ReadsBoth_AndAnOlderServerReadsOff()
    {
        var client = new OperatorClient(new FakeRunner().Ok("settings get", """{ "scriptTimeLimitSeconds": 60, "requireDryRun": true }"""));
        Assert.Equal(new OperatorSettings(60, true), await client.GetSettingsAsync());
        var older = new OperatorClient(new FakeRunner().Ok("settings get", """{ "scriptTimeLimitSeconds": 60 }"""));
        Assert.Equal(new OperatorSettings(60, false), await older.GetSettingsAsync());
    }

    [Fact]
    public async Task SetRequireDryRun_SendsOnOrOff_AndReturnsWhatWasStored()
    {
        var runner = new FakeRunner()
            .Ok("settings set-require-dry-run on", """{ "requireDryRun": true }""")
            .Fail("settings set-require-dry-run off", "EACCES: permission denied\n");
        var client = new OperatorClient(runner);
        Assert.True(await client.SetRequireDryRunAsync(true));
        var error = await Assert.ThrowsAsync<OperatorException>(() => client.SetRequireDryRunAsync(false));
        Assert.Contains("EACCES", error.Message);
    }

    [Fact]
    public async Task GetStaged_IsNull_WhenNoDryRunHasCompleted()
    {
        var client = new OperatorClient(new FakeRunner().Ok("staged get", """{ "dryRun": null }"""));
        Assert.Null(await client.GetStagedDryRunAsync());
    }

    [Fact]
    public void Succeeded_ReadsAsGroupsAndValues_WithNoJson()
    {
        var run = Read(Succeeded);
        Assert.Equal("dry-1", run.RunId);
        Assert.Equal("Renumber the level 2 doors", run.Title);
        Assert.Equal("2026-11-25 14:03 · Tower · Succeeded", run.Meta);
        Assert.True(run.Applied);
        Assert.False(run.Failed);
        Assert.Null(run.NothingChanged);

        var document = Assert.Single(run.Documents);
        Assert.Equal("Tower", document.Title);
        Assert.Equal(["Created (3)", "Modified (2)", "Deleted (1)"], document.Groups.Select(group => group.Heading));
        var created = Assert.Single(document.Groups[0].Lines);
        Assert.Equal("Walls · Basic Wall: Generic - 200mm × 3", created.Text);
        Assert.Equal(["312045, 312046, 312047 North"], created.Details);
        Assert.Equal("Doors · Single-Flush: 0915 x 2134mm 1234", document.Groups[1].Lines[0].Text);
        Assert.Equal(["Mark: D12 → D14"], document.Groups[1].Lines[0].Details);
        Assert.Equal(["Moved"], document.Groups[1].Lines[1].Details);
        Assert.Equal("Windows · Fixed: 0915 x 1220mm", document.Groups[2].Lines[0].Text);
        Assert.Equal("Also touched by Revit: 2 elements", document.AlsoTouched);
        Assert.Equal(["Walls: 2"], document.AlsoTouchedLines);

        Assert.Equal(new StagedImage("Level 2 (FloorPlan)", @"C:\ref\a.png", null), run.Images[0]);
        Assert.Equal(new StagedImage("Sheet A1 (DrawingSheet)", null, "A sheet cannot be captured."), run.Images[1]);
        Assert.StartsWith("Borrowed elements in Tower were released", run.Worksharing[0]);
        Assert.StartsWith("Borrowed elements in Annex could not be released. Use Relinquish All Mine", run.Worksharing[1]);

        var shown = new[] { run.Title, run.Meta }
            .Concat(run.Documents.SelectMany(entry => entry.Groups.SelectMany(group => group.Lines.SelectMany(line => line.Details.Prepend(line.Text)).Prepend(group.Heading))))
            .Concat(run.Worksharing);
        Assert.DoesNotContain(shown, line => line.Contains('{') || line.Contains('"'));
    }

    [Fact]
    public void Failed_ShowsItsErrorInPlaceOfTheLists()
    {
        var run = Read("""
            { "dryRun": { "runId": "dry-2", "displayName": "Wrong wall", "completedAt": "2026-11-25T15:00:00Z", "status": "failed",
              "error": { "code": "stopped_by_user", "message": "Stopped from the Drive-It window." }, "applied": false,
              "actions": [], "images": [], "worksharing": [] } }
            """);
        Assert.True(run.Failed);
        Assert.Equal("Stopped", run.Outcome);
        Assert.Equal("Stopped from the Drive-It window.", run.ErrorText);
        Assert.Empty(run.Documents);
        Assert.Null(run.NothingChanged);
        Assert.EndsWith("· Stopped", run.Meta);
    }

    [Fact]
    public void PastTheCaps_SaysHowManyAreNotListed()
    {
        var run = Read("""
            { "dryRun": { "runId": "dry-3", "status": "succeeded", "actions": [ {
              "document": "Tower",
              "created": { "total": 250, "truncated": true, "groups": [ { "category": "Walls", "count": 200, "elements": [ { "id": 1 }, { "id": 2 } ] } ] },
              "modified": { "total": 5, "notCompared": 4, "truncated": true, "elements": [
                { "id": 9, "category": "Doors", "values": [ { "name": "Mark", "before": null, "after": "D1" } ], "changedValues": 23, "truncated": true } ] },
              "deleted": { "total": 0, "groups": [] }, "alsoTouched": { "total": 0, "categories": [] } } ] } }
            """);
        var document = Assert.Single(run.Documents);
        Assert.Equal(["Created (250)", "Modified (5)"], document.Groups.Select(group => group.Heading));
        Assert.Equal("and 248 more not listed", document.Groups[0].Lines[^1].Text);
        Assert.Equal(["Mark: (empty) → D1", "and 22 more values"], document.Groups[1].Lines[0].Details);
        Assert.Equal("and 4 more not listed", document.Groups[1].Lines[^1].Text);
        Assert.Null(document.AlsoTouched);
        Assert.Equal("Dry run", run.Title);
    }

    [Fact]
    public void NoChange_SaysSoInOneLine()
    {
        var run = Read("""
            { "dryRun": { "runId": "dry-4", "status": "succeeded", "actions": [] } }
            """);
        Assert.Equal(StagedText.NothingChanged, run.NothingChanged);
    }
}
