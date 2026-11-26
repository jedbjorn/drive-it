# Dev Mode

Installing, limits and remote use of Dev Mode.

Dev Mode is the same app with every guardrail off. It is for driving Revit on a disposable, snapshot-backed Windows VM from agents running elsewhere, such as a Linux host, over SSH.

> [!CAUTION]
> In Dev Mode, scripts run whatever the agent writes with the signed-in Windows user's full rights. There are no refusals and no approvals. A script can import any module, install packages, start processes, and read, write, or delete any file the user can. Through the bridge it can save anywhere, synchronize with central, reload latest, and print. **Synchronizing to a real central model or printing to a real printer is not refused or undone.** Use Dev Mode only on a machine you can reset to a snapshot. It is never offered in the installer's UI, and RST never installs it.

**Install.** Use the same MSI or script installer with the mode on the command line, from an **elevated administrator** prompt:

```powershell
msiexec /i DriveIt-<version>.msi /qn /norestart MSIRESTARTMANAGERCONTROL=Disable DRIVEIT_MODE=dev
.\Install-DriveIt.ps1 -Mode dev
```

Without elevation, the install fails with "Dev Mode must be installed from an elevated administrator prompt" and leaves any existing install unchanged. Upgrades and repairs keep Dev Mode, and they must also be elevated. To leave Dev Mode, install again with `DRIVEIT_MODE=standard` (`-Mode standard`); no elevation is needed, and an elevated standard install also removes the administrator's marker. Only these two install-owned files set the mode. A tool argument, environment variable or script cannot.

**What is off.** In the worker: the module allowlist, the process, thread and native-loading block, the package-install block, and file mediation, so `open`, `os.*` and `files.*` are plain Python I/O. Outside-root decisions are off in the server and the add-in: every path is allowed, and no decision rows are written. The bridge's refusals (`type_not_allowed`, `member_not_allowed`) are off too, and `x.GetType()` returns a handle to the `System.Type`, so a script can reflect on it (`GetProperty`, `GetMethods`) and pass it back to Revit.

**What stays.** Receipts, run history, idempotent replay and `displayName` all stay. So do the hold, the rollback of a failed run, and the Stop window, and the time limit, the handle cap, and the built-in operations. Scripts still cannot write event or callback implementations. `get_revit_session` and every receipt report `"mode": "dev"`, and the server instructions tell the agent there are no refusals or approvals.

**Limits found in testing.**

- The bundled Python has no `pip`. Bootstrap it once with `get-pip.py` (which needs the network) before `python -m pip install`; packages then install into the bundled Python's `Lib\site-packages`, and an upgrade that replaces the app folder removes them.
- After a script calls `Document.SaveAs` itself, pass `document=doc` to later `revit.transaction`, `revit.document`, `revit.element` and built-in calls in that run. Without it they still target the old path and fail with `document_identity_mismatch`.
- `Document.Print` and `View.Print` work only on the document that is active in Revit's window; documents Drive-It opens or creates are not active. Microsoft Print to PDF ignores print-to-file and opens a save dialog, which blocks Drive-It until someone closes it.
- Processes a script starts keep running after the run ends, including after a time-out or Stop.
- Each process reads the mode once: after reinstalling into or out of Dev Mode, restart Revit and the MCP clients.

**Connect from the host.** Every install places `drive-it-stdio.cmd` in `%LOCALAPPDATA%\DriveIt\app`, and Dev Mode puts it on the user's `PATH`. It runs the same stdio server, with nothing listening on a port. Revit must already be running in the user's desktop session on the VM, and the SSH login must be that same Windows user. Register it on the host with your existing SSH key and host entry:

```bash
claude mcp add drive-it -- ssh -T <user>@<vm> drive-it-stdio
```

Any other stdio MCP client is registered the same way:

```json
{ "mcpServers": { "drive-it": { "command": "ssh", "args": ["-T", "<user>@<vm>", "drive-it-stdio"] } } }
```

In Dev Mode, `%LOCALAPPDATA%\DriveIt\mcp.json` also carries this as a commented example under the `//drive-it-ssh` key. Each client session starts its own server in the VM, and Revit serializes the work of several sessions.
