# drive-it

Drive It connects an MCP client to Autodesk Revit on the same Windows workstation. Its first tool, `get_revit_session`, returns the process ID, version, and build of a running Revit instance. It works with the Revit home screen or an open model.

## Run locally

Install Revit 2026, the .NET 8 SDK, and Node.js 22 or newer. From the repository root, run these commands in PowerShell with Revit closed.

```powershell
npm ci
dotnet build src/DriveIt.Revit -c Release

$build = "src/DriveIt.Revit/bin/Release/net8.0-windows"
$addins = Join-Path $env:APPDATA "Autodesk/Revit/Addins/2026"
New-Item -ItemType Directory -Force "$addins/DriveIt" | Out-Null
Copy-Item "$build/DriveIt.Revit.dll" "$addins/DriveIt/"
Copy-Item "$build/DriveIt.addin" "$addins/"
```

Start Revit and allow the add-in to load. Configure your MCP client to launch the server over stdio, replacing the example path with your checkout.

```json
{
  "mcpServers": {
    "drive-it": {
      "command": "node",
      "args": ["C:\\Repos\\drive-it\\server\\index.js"]
    }
  }
}
```

Run `Get-Process Revit | Select-Object Id, MainWindowTitle` in PowerShell. Ask your MCP client to call `get_revit_session` with the desired `processId`. Each Revit instance has its own named pipe, restricted to the current Windows user.

## Development

- `server/index.js` registers the tool with the MCP SDK and reads session metadata from the named pipe.
- `src/DriveIt.Revit/App.cs` captures version information during Revit startup. Its pipe listener only serves that snapshot. Future tools that access a live document should schedule that work in a Revit API context using an external event.
- `npm test` starts the MCP server, discovers the tool, and checks the disconnected response. On Windows it also calls the tool against a test pipe. To verify the add-in inside Revit, follow the local setup above.

This repository is private during early development. The open-source license will be selected before public release.
