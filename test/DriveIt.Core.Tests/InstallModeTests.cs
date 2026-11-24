using DriveIt.Core.Mode;

namespace DriveIt.Core.Tests;

public class InstallModeTests
{
    private const string Sid = "S-1-5-21-1-2-3-1001";
    private const string DevFile = """{ "mode": "dev" }""";
    private const string StandardFile = """{ "mode": "standard" }""";

    private static MarkerCheck Marker(string? owner = "S-1-5-32-544", string? text = null) =>
        new(Sid, owner, text ?? $$"""{ "mode": "dev", "sid": "{{Sid}}" }""");

    [Theory]
    [InlineData("S-1-5-32-544")]
    [InlineData("S-1-5-18")]
    public void DevNeedsTheDevUserFileAndThisUsersAdminOwnedMarker(string owner)
    {
        Assert.Equal(DriveItMode.Dev, InstallMode.Decide(DevFile, Marker(owner)).Mode);
    }

    public static TheoryData<string, string?, MarkerCheck?> StandardCases() => new()
    {
        { "no user file", null, Marker() },
        { "user file says standard", StandardFile, Marker() },
        { "user file is not JSON", "{dev", Marker() },
        { "user file is an array", """["dev"]""", Marker() },
        { "user file mode is a different case", """{ "mode": "Dev" }""", Marker() },
        { "marker not checked", DevFile, null },
        { "no marker (a hand-written user file)", DevFile, new MarkerCheck(Sid, null, null) },
        { "marker owned by the user", DevFile, Marker(owner: Sid) },
        { "marker owned by Users", DevFile, Marker(owner: "S-1-5-32-545") },
        { "marker for another user", DevFile, Marker(text: """{ "mode": "dev", "sid": "S-1-5-21-9" }""") },
        { "marker says standard", DevFile, Marker(text: $$"""{ "mode": "standard", "sid": "{{Sid}}" }""") },
        { "marker is not JSON", DevFile, Marker(text: "dev") },
    };

    [Theory]
    [MemberData(nameof(StandardCases))]
    public void EveryOtherCombinationIsStandard(string name, string? userFile, MarkerCheck? marker)
    {
        var (mode, reason) = InstallMode.Decide(userFile, marker);
        Assert.True(mode == DriveItMode.Standard, name);
        Assert.False(string.IsNullOrEmpty(reason), name);
    }

    [Fact]
    public void ResolveReadsTheTwoFilesAndChecksTheMarkerOnlyForADevUserFile()
    {
        var inspected = new List<string>();
        var read = new List<string>();
        ModeHost Host(string? userFile) => new()
        {
            LocalApplicationData = "L",
            ProgramData = "P",
            ReadText = path => { read.Add(path); return userFile; },
            InspectMarker = directory => { inspected.Add(directory); return Marker(); },
        };

        Assert.Equal(DriveItMode.Dev, InstallMode.Resolve(Host(DevFile)).Mode);
        Assert.Equal([Path.Combine("L", "DriveIt", "install-mode.json")], read);
        Assert.Equal([Path.Combine("P", "DriveIt", "dev-mode")], inspected);

        inspected.Clear();
        Assert.Equal(DriveItMode.Standard, InstallMode.Resolve(Host(StandardFile)).Mode);
        Assert.Equal(DriveItMode.Standard, InstallMode.Resolve(Host(null)).Mode);
        Assert.Empty(inspected);
    }

    [Fact]
    public void AFailedMarkerCheckIsStandard()
    {
        var host = new ModeHost
        {
            ReadText = _ => DevFile,
            InspectMarker = _ => throw new UnauthorizedAccessException("denied"),
        };
        var (mode, reason) = InstallMode.Resolve(host);
        Assert.Equal(DriveItMode.Standard, mode);
        Assert.Contains("denied", reason);
    }

    [Fact]
    public void NamesMatchTheServer()
    {
        Assert.Equal("dev", InstallMode.Name(DriveItMode.Dev));
        Assert.Equal("standard", InstallMode.Name(DriveItMode.Standard));
    }

    [Fact]
    public void OnWindowsTheMarkerCheckReadsThisUsersSidAndTheMarkersOwner()
    {
        if (!OperatingSystem.IsWindows()) return;
        var directory = Directory.CreateTempSubdirectory("drive-it-marker-").FullName;
        try
        {
            var inspect = new ModeHost().InspectMarker;
            var missing = inspect(directory);
            Assert.NotNull(missing);
            Assert.StartsWith("S-1-5-21-", missing.Sid);
            Assert.Null(missing.Owner);
            Assert.Null(missing.Text);

            var text = $$"""{ "mode": "dev", "sid": "{{missing.Sid}}" }""";
            File.WriteAllText(Path.Combine(directory, missing.Sid + ".json"), text);
            var found = inspect(directory);
            Assert.NotNull(found);
            Assert.StartsWith("S-1-5-", found.Owner);
            Assert.Equal(text, found.Text);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
