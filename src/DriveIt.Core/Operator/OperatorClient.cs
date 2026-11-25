using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace DriveIt.Core.Operator;

/// <summary>An operator.js command failed or Drive It is not installed; the message is shown to the user.</summary>
public sealed class OperatorException(string message) : Exception(message);

/// <summary>One finished operator.js process.</summary>
public sealed record OperatorResult(int ExitCode, string StandardOutput, string StandardError);

/// <summary>Runs <c>node server/operator.js &lt;arguments&gt;</c>. The window uses <see cref="ProcessOperatorRunner"/>; tests fake it.</summary>
public interface IOperatorRunner
{
    Task<OperatorResult> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken = default);
}

/// <summary>Starts the installed Node.js on operator.js, hidden, and collects its output (UTF-8).</summary>
public sealed class ProcessOperatorRunner(OperatorHost host) : IOperatorRunner
{
    /// <summary>Long enough for a cold Node start on a busy workstation; operator commands only touch small JSON files.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    public OperatorHost Host { get; } = host;

    public async Task<OperatorResult> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken = default)
    {
        var launch = OperatorLocator.Locate(Host);
        var start = new ProcessStartInfo(launch.Node)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        start.ArgumentList.Add(launch.Script);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        if (launch.DataDirectory is { } data) start.Environment[OperatorLocator.DataDirectoryVariable] = data;

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);
        Process process;
        try
        {
            process = Process.Start(start) ?? throw new OperatorException($"Drive-It could not start {launch.Node}.");
        }
        catch (System.ComponentModel.Win32Exception exception)
        {
            throw new OperatorException($"Drive-It could not start {launch.Node}: {exception.Message}");
        }
        using (process)
        {
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = process.StandardError.ReadToEndAsync(timeout.Token);
            try
            {
                await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                return new OperatorResult(process.ExitCode, await output.ConfigureAwait(false), await error.ConfigureAwait(false));
            }
            catch (OperationCanceledException)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                }
                catch (InvalidOperationException)
                {
                    // Already exited.
                }
                if (cancellationToken.IsCancellationRequested) throw;
                throw new OperatorException($"Drive-It operator command timed out after {Timeout.TotalSeconds:0} seconds: {string.Join(' ', arguments)}");
            }
        }
    }
}

/// <summary>
/// The operator.js contract the window uses, with the PowerShell module's behavior
/// (<c>operator/DriveIt.Operator.psm1</c>): <c>workspace get|set</c>, <c>decisions list|approve|deny</c>
/// (only <c>pending</c> rows are listed), <c>history list</c> (newest first, at most 100),
/// <c>settings get|set-time-limit|set-require-dry-run</c> (the Script time limit and Require dry run),
/// <c>staged get</c> (the dry run Staged Actions mode shows) and <c>clients detect</c> (Detect agents).
/// </summary>
public sealed class OperatorClient(IOperatorRunner runner)
{
    /// <summary>The module's default history limit.</summary>
    public const int DefaultHistoryLimit = 100;

    /// <summary>The selected workspace root, or null when none has been selected yet.</summary>
    public async Task<string?> GetWorkspaceAsync(CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(["workspace", "get"], cancellationToken).ConfigureAwait(false);
        if (result.ExitCode != 0 && result.StandardError.Contains("WORKSPACE_NOT_SELECTED", StringComparison.Ordinal))
            return null;
        return ReadRoot(Parse(result));
    }

    /// <summary>Selects <paramref name="root"/> for future operations; returns the canonical root operator.js stored.</summary>
    public async Task<string> SetWorkspaceAsync(string root, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(root)) throw new OperatorException("Choose a workspace folder first.");
        var result = await runner.RunAsync(["workspace", "set", root.Trim()], cancellationToken).ConfigureAwait(false);
        return ReadRoot(Parse(result)) ?? throw new OperatorException("Drive-It did not report the saved workspace root.");
    }

    /// <summary>The outside-root requests still waiting for a decision, oldest first.</summary>
    public async Task<IReadOnlyList<PendingRequest>> ListPendingAsync(CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(["decisions", "list"], cancellationToken).ConfigureAwait(false);
        using var document = Parse(result);
        var rows = new List<PendingRequest>();
        if (document?.RootElement is { ValueKind: JsonValueKind.Array } array)
            foreach (var row in array.EnumerateArray())
                if (Json.String(row, "status") == "pending" && PendingRequest.FromJson(row) is { } request)
                    rows.Add(request);
        return rows;
    }

    /// <summary>Records a one-time approval or denial; returns the decision's new status.</summary>
    public async Task<string?> DecideAsync(string requestId, bool approve, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(requestId)) throw new OperatorException("Choose a request first.");
        var result = await runner.RunAsync(["decisions", approve ? "approve" : "deny", requestId], cancellationToken)
            .ConfigureAwait(false);
        using var document = Parse(result);
        return document is null ? null : Json.String(document.RootElement, "status");
    }

    /// <summary>Retained run receipts, newest first (operator.js's order), at most <paramref name="limit"/>.</summary>
    public async Task<IReadOnlyList<RunRecord>> ListHistoryAsync(int limit = DefaultHistoryLimit, CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(["history", "list"], cancellationToken).ConfigureAwait(false);
        using var document = Parse(result);
        var rows = new List<RunRecord>();
        if (document?.RootElement is { ValueKind: JsonValueKind.Array } array)
            foreach (var row in array.EnumerateArray())
            {
                if (rows.Count >= limit) break;
                if (row.ValueKind == JsonValueKind.Object) rows.Add(RunRecord.FromJson(row));
            }
        return rows;
    }

    /// <summary>The Script time limit in seconds (<see cref="ScriptTimeLimit"/>).</summary>
    public async Task<int> GetScriptTimeLimitAsync(CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(["settings", "get"], cancellationToken).ConfigureAwait(false);
        using var document = Parse(result);
        return ReadTimeLimit(document);
    }

    /// <summary>Both settings from one <c>settings get</c>: the Script time limit and Require dry run.</summary>
    public async Task<OperatorSettings> GetSettingsAsync(CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(["settings", "get"], cancellationToken).ConfigureAwait(false);
        using var document = Parse(result);
        var requireDryRun = document?.RootElement is { ValueKind: JsonValueKind.Object } root
            && root.TryGetProperty(RequireDryRun.PropertyName, out var value) && value.ValueKind == JsonValueKind.True;
        return new OperatorSettings(ReadTimeLimit(document), requireDryRun);
    }

    /// <summary>Turns Require dry run on or off for runs that start after it (spec #13); returns the value operator.js stored.</summary>
    public async Task<bool> SetRequireDryRunAsync(bool on, CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(["settings", "set-require-dry-run", on ? "on" : "off"], cancellationToken).ConfigureAwait(false);
        using var document = Parse(result);
        if (document?.RootElement is { ValueKind: JsonValueKind.Object } root
            && root.TryGetProperty(RequireDryRun.PropertyName, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
            return value.GetBoolean();
        throw new OperatorException("Drive-It did not report the Require dry run setting.");
    }

    /// <summary>The last dry run that completed in this workspace (spec #13 "The dry run shown"), or null when there is none.</summary>
    public async Task<StagedDryRun?> GetStagedDryRunAsync(CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(["staged", "get"], cancellationToken).ConfigureAwait(false);
        using var document = Parse(result);
        return document is null ? null : StagedDryRun.FromJson(document.RootElement);
    }

    /// <summary>Saves the Script time limit for future runs; returns the value operator.js stored.</summary>
    public async Task<int> SetScriptTimeLimitAsync(int seconds, CancellationToken cancellationToken = default)
    {
        if (!ScriptTimeLimit.IsValid(seconds))
            throw new OperatorException($"The script time limit must be a whole number of seconds from {ScriptTimeLimit.MinimumSeconds} to {ScriptTimeLimit.MaximumSeconds}.");
        var result = await runner.RunAsync(
            ["settings", "set-time-limit", seconds.ToString(System.Globalization.CultureInfo.InvariantCulture)], cancellationToken)
            .ConfigureAwait(false);
        using var document = Parse(result);
        return ReadTimeLimit(document);
    }

    /// <summary>
    /// Detect agents (spec #23): <c>operator.js clients detect &lt;mcp.json&gt;</c> adds the install's
    /// <c>drive-it</c> entry to each MCP client installed for this Windows user. One result per client,
    /// in operator.js's order; a command that could not run is an <see cref="OperatorException"/>.
    /// </summary>
    public async Task<IReadOnlyList<AgentResult>> DetectAgentsAsync(string mcpConfigurationPath, CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(["clients", "detect", mcpConfigurationPath], cancellationToken).ConfigureAwait(false);
        using var document = Parse(result);
        var rows = new List<AgentResult>();
        if (document?.RootElement is { ValueKind: JsonValueKind.Array } array)
            foreach (var row in array.EnumerateArray())
                if (Json.String(row, "message") is { Length: > 0 } message)
                    rows.Add(new AgentResult(Json.String(row, "client") ?? "", Json.String(row, "status") ?? "", message));
        if (rows.Count == 0) throw new OperatorException("Drive-It did not report any agents.");
        return rows;
    }

    private static int ReadTimeLimit(JsonDocument? document)
    {
        if (document?.RootElement is { ValueKind: JsonValueKind.Object } root
            && root.TryGetProperty(ScriptTimeLimit.PropertyName, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var seconds))
            return seconds;
        throw new OperatorException("Drive-It did not report the script time limit.");
    }

    /// <summary>The command's JSON, or null for empty output; a non-zero exit is an <see cref="OperatorException"/>.</summary>
    private static JsonDocument? Parse(OperatorResult result)
    {
        if (result.ExitCode != 0)
            throw new OperatorException(OperatorText.CommandFailed(result.ExitCode, result.StandardError));
        if (string.IsNullOrWhiteSpace(result.StandardOutput)) return null;
        try
        {
            return JsonDocument.Parse(result.StandardOutput);
        }
        catch (JsonException exception)
        {
            throw new OperatorException($"Drive-It operator returned unreadable output: {exception.Message}");
        }
    }

    private static string? ReadRoot(JsonDocument? document)
    {
        using (document)
            return document is null ? null : Json.String(document.RootElement, "root");
    }
}

/// <summary>The stored settings the drawer shows.</summary>
public sealed record OperatorSettings(int ScriptTimeLimitSeconds, bool RequireDryRun);

/// <summary>Tolerant reads of operator.js JSON: unknown fields are ignored and wrong types read as absent.</summary>
internal static class Json
{
    public static string? String(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
