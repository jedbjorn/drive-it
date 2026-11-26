# How it works

Document targets, the workspace boundary with run history, and how a Revit session is selected. For the overview of the server, named pipe and add-in, see [How it works in the README](../README.md#how-it-works).

## Document targets

A task is tied to the documents it starts with. When you name what to work on, the agent reads the open documents, tells you their titles, and names them as `targets` on every run of the task, so switching windows in Revit while it works does not move the task to another model. A run changes only its targets and the documents it opens or creates: a change, save or close of any other open document is refused with `document_not_targeted`, and that document is left as it was. Run history in the Drive-It window shows each run's target titles.

## Workspace and outside-root decisions

Every install starts with the workspace `C:\DriveIt\default`, created and selected when no workspace is set yet; an existing choice is kept on upgrade, and the folder is left in place on uninstall. Select a different workspace in the Drive-It window (Start Menu, or **Add-Ins › Drive-It** in Revit) at any time. During development, the equivalent direct commands are:

```powershell
node server/operator.js workspace set C:\DriveIt
node server/operator.js workspace get
```

Reads, creates, overwrites, renames, moves, and deletes inside the canonical root do not produce a Drive-It prompt. Reading Revit's own installed content also needs no prompt: reading files and folders, opening documents, and using a file as a template under `%ProgramData%\Autodesk\RVT <version>\Templates`, `Family Templates`, and `Libraries`, for the selected session's Revit version (`RVT 2026` or `RVT 2027`). Writing there still needs a decision. Links and junctions are resolved at the point of use. An outside-root request returns a `pending` receipt and changes nothing in the requested batch. List the request and make a one-time decision:

```powershell
node server/operator.js decisions list
node server/operator.js decisions approve <decision-id>
node server/operator.js decisions deny <decision-id>
```

After approval, retry the same execution with the same idempotency key. The grant is consumed by that execution and is not reused. Denial returns a `denied` receipt. Changing the workspace affects future operations; existing receipts retain their originating root.

Run history remains local to the Windows user and is available after a root change:

```powershell
node server/operator.js history list
node server/operator.js history get <run-id>
```

Completed idempotent requests return their original receipt without repeating effects. Receipts distinguish pending, denied, failed, timed-out, partially applied, and succeeded runs.

## Use

`get_revit_session` and `execute_script` find the running Revit on their own when only one Revit has the Drive-It add-in loaded. With several Revit windows open, including Revit 2026 and 2027 side by side, the agent is told which process IDs are running with their Revit versions and asks which to use; it then passes that `processId`. When a run needs an outside-root approval, the tool tells the agent to ask you to decide in the Drive-It window and to resume with the same `idempotencyKey`.

A successful session response contains the selected Revit process and its version information (`"2026"` or `"2027"`):

```json
{
  "processId": 12345,
  "version": "2026",
  "build": "26.4.10.51"
}
```

If the connection fails, check that the process ID belongs to Revit and that the Drive-It add-in loaded successfully.
