using System.Text.Json;
using DriveIt.Core.Operator;

namespace DriveIt.Core.Tests;

public class ScriptTimeLimitTests
{
    private static readonly string Data = Path.Combine(Path.GetTempPath(), "DriveIt-limit", "data");
    private static readonly string Settings = Path.Combine(Data, ScriptTimeLimit.FileName);

    private static Func<string, string> Files(Dictionary<string, string> contents) =>
        path => contents.TryGetValue(path, out var text) ? text : throw new FileNotFoundException(path);

    [Theory]
    [InlineData("""{ "scriptTimeLimitSeconds": 20 }""", 20)]
    [InlineData("""{ "scriptTimeLimitSeconds": 600, "other": true }""", 600)]
    [InlineData("""{ "scriptTimeLimitSeconds": 9 }""", 120)]
    [InlineData("""{ "scriptTimeLimitSeconds": 601 }""", 120)]
    [InlineData("""{ "scriptTimeLimitSeconds": 20.5 }""", 120)]
    [InlineData("""{ "scriptTimeLimitSeconds": "20" }""", 120)]
    [InlineData("""{ }""", 120)]
    [InlineData("""[20]""", 120)]
    [InlineData("""not json""", 120)]
    public void Read_IsTheStoredLimit_OrTheDefault(string json, int expected)
    {
        Assert.Equal(expected, ScriptTimeLimit.Read(Data, Files(new() { [Settings] = json })));
    }

    [Fact]
    public void Read_IsTheDefault_WhenTheFileIsMissing()
    {
        Assert.Equal(ScriptTimeLimit.DefaultSeconds, ScriptTimeLimit.Read(Data, Files([])));
    }

    [Fact]
    public void Read_FollowsTheDataDirectoryTheServerUses()
    {
        var configured = Path.Combine(Path.GetTempPath(), "DriveIt-limit", "configured");
        var host = new OperatorHost
        {
            GetEnvironmentVariable = name => name == OperatorLocator.DataDirectoryVariable ? configured : null,
            FileExists = _ => false,
            ReadAllText = Files(new() { [Path.Combine(configured, ScriptTimeLimit.FileName)] = """{ "scriptTimeLimitSeconds": 45 }""" }),
        };
        Assert.Equal(45, ScriptTimeLimit.Read(host));
    }

    [Fact]
    public void DataDirectory_IsTheVariable_ThenMcpJson_ThenLocalAppData()
    {
        var local = Path.Combine(Path.GetTempPath(), "DriveIt-limit", "LocalAppData");
        var mcp = Path.Combine(local, "DriveIt", "mcp.json");
        var fromConfig = Path.Combine(Path.GetTempPath(), "DriveIt-limit", "from-config");
        var json = JsonSerializer.Serialize(new
        {
            mcpServers = new Dictionary<string, object>
            {
                ["drive-it"] = new { command = "node.exe", args = new[] { "index.js" }, env = new Dictionary<string, string> { ["DRIVE_IT_DATA_DIR"] = fromConfig } },
            },
        });
        OperatorHost Host(string? variable, bool withConfig) => new()
        {
            GetEnvironmentVariable = name => name == OperatorLocator.DataDirectoryVariable ? variable : null,
            FileExists = path => withConfig && path == mcp,
            ReadAllText = Files(new() { [mcp] = json }),
            LocalApplicationData = local,
        };

        Assert.Equal("D:\\data", OperatorLocator.DataDirectory(Host("D:\\data", withConfig: true)));
        Assert.Equal(fromConfig, OperatorLocator.DataDirectory(Host(null, withConfig: true)));
        Assert.Equal(Path.Combine(local, "DriveIt"), OperatorLocator.DataDirectory(Host(" ", withConfig: false)));
    }

    private static readonly DateTimeOffset Now = new(2026, 11, 24, 6, 30, 0, TimeSpan.Zero);

    private static TimeSpan HoldLimit(string json) =>
        ScriptTimeLimit.HoldLimit(Data, Now, Files(new() { [Settings] = json }));

    // server/settings.js writes earlierLimitUntil with Date.toISOString() when the limit is lowered.
    [Theory]
    [InlineData("""{ "scriptTimeLimitSeconds": 20 }""", 20)]
    [InlineData("""{ "scriptTimeLimitSeconds": 10, "earlierLimitUntil": "2026-11-24T06:31:55.000Z" }""", 115)]
    [InlineData("""{ "scriptTimeLimitSeconds": 10, "earlierLimitUntil": "2026-11-24T06:30:05.000Z" }""", 10)]
    [InlineData("""{ "scriptTimeLimitSeconds": 10, "earlierLimitUntil": "2026-11-24T06:29:00.000Z" }""", 10)]
    [InlineData("""{ "scriptTimeLimitSeconds": 10, "earlierLimitUntil": "2026-11-25T06:30:00.000Z" }""", 600)]
    [InlineData("""{ "scriptTimeLimitSeconds": 10, "earlierLimitUntil": "tomorrow" }""", 10)]
    [InlineData("""{ "scriptTimeLimitSeconds": 10, "earlierLimitUntil": 1764000000000 }""", 10)]
    [InlineData("""{ "scriptTimeLimitSeconds": 9, "earlierLimitUntil": "2026-11-24T06:31:00.000Z" }""", 120)]
    [InlineData("""not json""", 120)]
    public void HoldLimit_IsTheSetting_OrLonger_WhileARunStartedUnderAnEarlierLimitMayStillRun(string json, int expectedSeconds)
    {
        Assert.Equal(TimeSpan.FromSeconds(expectedSeconds), HoldLimit(json));
    }

    [Fact]
    public void HoldLimit_IsTheDefault_WhenTheFileIsMissing()
    {
        Assert.Equal(TimeSpan.FromSeconds(ScriptTimeLimit.DefaultSeconds), ScriptTimeLimit.HoldLimit(Data, Now, Files([])));
    }

    [Fact]
    public void Read_IgnoresTheEarlierLimitRecord()
    {
        Assert.Equal(10, ScriptTimeLimit.Read(Data, Files(new() { [Settings] = """{ "scriptTimeLimitSeconds": 10, "earlierLimitUntil": "2026-11-24T06:31:55.000Z" }""" })));
    }

    [Theory]
    [InlineData("20", 20)]
    [InlineData(" 600 ", 600)]
    [InlineData("10", 10)]
    public void Parse_AcceptsWholeSecondsInRange(string text, int expected)
    {
        Assert.Equal(expected, ScriptTimeLimit.Parse(text, out var error));
        Assert.Null(error);
    }

    [Theory]
    [InlineData("9")]
    [InlineData("601")]
    [InlineData("20.5")]
    [InlineData("-20")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("twenty")]
    public void Parse_RejectsAnythingElse_AndSaysWhatIsAccepted(string? text)
    {
        Assert.Null(ScriptTimeLimit.Parse(text, out var error));
        Assert.Equal("The script time limit must be a whole number of seconds from 10 to 600.", error);
    }

    [Fact]
    public void HelpText_SaysWhatTheLimitTrades()
    {
        Assert.Contains("lets one script do more, and pauses Revit for longer", ScriptTimeLimit.HelpText);
    }
}

public class HoldTextTests
{
    [Theory]
    [InlineData(0, 120, "0:00 of 2:00")]
    [InlineData(12.9, 120, "0:12 of 2:00")]
    [InlineData(75, 600, "1:15 of 10:00")]
    [InlineData(6.2, 19.86, "0:06 of 0:20")] // a 20 s limit, as the hold sees it on W10C-Testing
    [InlineData(5, 59.8, "0:05 of 1:00")]
    public void Progress_IsElapsedOfLimit(double elapsed, double limit, string expected)
    {
        Assert.Equal(expected, HoldText.Progress(TimeSpan.FromSeconds(elapsed), TimeSpan.FromSeconds(limit)));
    }

    [Theory]
    [InlineData(29, "29 ms")]
    [InlineData(400, "400 ms")]
    [InlineData(1000, "1.0 s")]
    [InlineData(9949, "9.9 s")]
    [InlineData(12300, "12 s")]
    [InlineData(125000, "2 min 5 s")]
    public void Duration_IsShort(double milliseconds, string expected)
    {
        Assert.Equal(expected, HoldText.Duration(TimeSpan.FromMilliseconds(milliseconds)));
    }

    [Fact]
    public void Name_IsTheCleanDisplayName_OrAFallback()
    {
        Assert.Equal("Place desks", HoldText.Name("  Place\n desks "));
        Assert.Equal("A Drive-It script is running", HoldText.Name(" "));
        Assert.Equal("A Drive-It script is running", HoldText.Name(null));
    }
}
