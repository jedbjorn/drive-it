# Revit broker

The named-pipe protocol between the Drive-It server and the add-in.

The current-user named pipe `\\.\pipe\drive-it-<pid>` retains its session greeting. After reading the greeting, an execution client sends one newline-delimited JSON request and reads one JSON response on that connection:

```json
{
  "id": "<run uuid>",
  "type": "model.execute",
  "document": { "path": "<canonical path or null>", "uniqueId": "<broker-issued identity or null>" },
  "workspaceRoot": "<canonical root>",
  "targets": ["<broker-issued identity>"],
  "operations": [{ "type": "read_document", "arguments": {} }]
}
```

`targets` lists the documents the run may change; a change, save, save-as, close or delete of any other open document that the run did not open or create fails with `document_not_targeted`, and so does one from a `hold.begin` whose `hold.targets` does not name it. A `documents.list` request returns `openDocuments` and resolves a run's `targets`; the add-in waits at most its `waitMs` for Revit's thread and otherwise answers `busy`.

Built-in primitives are `get_active_document`, `find_elements`, `get_parameters`, `list_types`, `list_views`, `get_selection`, `set_selection`, `get_family_parameters`, and `edit_family`, which carry no policy paths and start no transaction, and `set_parameters` and `set_family_parameters`, typed model changes. Every `model.execute` response carries `results`, with one entry per operation in batch order: a read primitive's output, or `null` for any other operation and for every operation after a failure. Document operations are `open_document`, `create_document`, `read_document`, `save_document`, `save_as_document`, `close_document`, and `delete_document`. Typed model changes are `create_level`, `create_wall`, `create_3d_view`, `create_family_type`, `delete_element`, `set_parameters`, and `set_family_parameters`. `create_3d_view` creates an isometric 3D view (optional unique `name`) and returns it in `createdViews` as `{id, name, type}` (also collected on the `execute_script` receipt and in run history), so the id can go straight to `capture_revit_view`. An empty name or one with a character Revit forbids in names fails with `invalid_model_change`. A name already used by a 3D view (not a view template; names are case-sensitive, as in Revit) or repeated in the batch fails with `duplicate_view_name`; validation sees the document as it was before the batch, so deleting a view and reusing its name needs two calls. a family in which Revit allows no 3D view (for example an annotation family) fails with `view_creation_not_allowed` and the batch rolls back. Consecutive model changes run in one Revit transaction through `ExternalEvent`. The response's `document.uniqueId` remains bound to the same Revit document across save-as.

Responses have `succeeded`, `failed`, `partially_applied`, or `policy_required` status and list observed `changes`, `affectedFiles`, `affectedElements`, and `checks`. Before any mutation, the broker canonicalizes the complete batch, including links and junctions. An uncovered outside-root read or effect returns `policy_required` with `policyRequests`. Node can retry with an operator decision:

```json
{
  "outsideRootApproval": {
    "decisionId": "<node-generated decision>",
    "grants": [{ "operation": "save_as_document", "paths": ["<resolved path>"] }]
  }
}
```

Only the Node broker client may attach this payload; generated Python cannot approve its own request. Grants cover only the matching operation and canonical paths in that execution and are not persisted.

A bridge run keeps one connection for its hold: `"type": "hold.begin"` with `"hold": { "displayName", "timeLimitMs" }`, then `bridge.call` and `model.execute` requests one at a time, then `hold.end` with `"end": { "outcome": "commit" | "rollback" }`, whose reply carries the hold's summary. If the add-in ends a hold on its own (deadline, Stop, or a dropped connection), it rolls back, closes the connection, and keeps the summary for a `hold.result` request with the run id. The server checks absolute paths in bridge arguments against the outside-root policy before sending them. `"type": "api.describe"` with `"describe": { "type": "<name>" }` returns `revit.describe`'s answer without Revit's thread.

A capture uses `"type": "view.capture"` with no `operations` and a `capture` object `{ "viewId": "<decimal id or null>", "pixelSize": 256-2048, "targetPath": "<server-created path>" }`. The target lies in an empty staging folder the server created under `_reference-images\<session-id>`; the add-in exports there and returns the view's id, name, and type, the document's modified state before and after, and, when the selection fails, `availableViews` and `otherViews`. The server then validates and publishes the PNG. A marks request adds `"markCategories": ["OST_..."]`, `"markElementIds": ["<decimal id>", ...]`, or both to the `capture` object; the add-in then draws the marks on the staged PNG and returns `capture.marks` (`legend`, `notMarked`, `omitted`). A capture without marks sends neither field.
