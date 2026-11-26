# Scripting

The Python environment that `execute_script` runs in, and the built-in primitives a script can call.

## Python environment

Generated Python receives `args`, `files`, `revit`, `checks`, and `units`, and through the [Revit API bridge](api-bridge.md) `DB` and handles to Revit objects; read [Safety and ability](../README.md#safety-and-ability) before using it. Typed model operations use the Drive-It add-in's current-user named pipe and execute in Revit's API context. In a standard install, the worker uses Python isolated mode, blocks package installation, process execution, native loading, and thread creation, and records observed effects and checks in a durable run receipt. Scripts can import only the modules in `ALLOWED_MODULES` in `server/worker.py` (in-memory data, text, math, and date utilities plus `os`/`pathlib` for mediated file access); every other import or module load is denied. Text in the encodings Python ships, such as `open(path, encoding="utf-16")` for Revit's shared parameter files, works without importing anything. This is a guardrail for generated code, not an operating-system sandbox. An administrator can install [Dev Mode](dev-mode.md) instead, which turns these guardrails off.

## Built-in primitives

Common Revit work is one line in a script. The primitives ship with the add-in and are the same in every workspace; `get_api_reference` lists each one with its arguments, returned shape, effects, and an example.

```python
revit.get_active_document()                      # the model or family open in Revit's window
walls = revit.find_elements(category="Walls")    # {total, returned, offset, truncated, elements}
params = revit.get_parameters([w["id"] for w in walls["elements"]], names=["Unconnected Height"])
selected = revit.get_selection()                 # what the user has selected
revit.set_parameters([{"elementId": selected[0]["id"], "parameter": "Comments", "value": "Checked"}])

doors = revit.list_types(category="Doors")
revit.edit_family(familyId=doors[0]["familyId"])  # later calls target the opened family
family = revit.get_family_parameters()           # {types, currentType, parameters}
revit.set_family_parameters([{"parameter": "Manufacturer", "allTypes": True, "value": "Acme"}])
revit.save_as_document(destinationPath=args["familyPath"])  # an .rfa path in the workspace
```

- `get_active_document()` returns the full response. Its `document` is the active document's snapshot plus `isModified`, `activeView`, and `openDocuments`, and later calls in the script target it. With no active document it fails with `no_active_document` and lists the open documents.
- `find_elements(category, kind="instance", levelId=None, typeName=None, limit=200, offset=0)` pages elements of a category in element-id order. `category` is a `BuiltInCategory` name (`"OST_Walls"`) or the name the document shows (`"Walls"`). An unknown name fails with `unknown_category` and the closest names.
- `get_parameters(elementIds, names=None, includeType=True)` returns each element's parameters (`name`, `builtIn`, `guid`, `storageType`, raw `value` in internal units, `display`, `readOnly`, `hasValue`) and its type's. A missing id fails the whole call with `element_not_found`.
- `list_types(category)` lists a category's types, and `list_views(viewTypes=None, includeSheets=True, includeTemplates=False)` lists views and sheets with `capturable` for `capture_revit_view`.
- `get_selection()` reads and `set_selection(elementIds)` replaces the UI selection of the active document. Another document fails with `document_not_active`. `set_selection` starts no transaction, leaves the document unmodified and the view unchanged, and checks the selection it set (`selection_readback`).
- `set_parameters(changes)` changes instance and type parameters. Each change is `{elementId, parameter | builtIn | guid, value | valueString}`: the parameter by name, `BuiltInParameter` name, or shared-parameter GUID, and either a raw `value` matching the storage type (a number in internal units for Double, an integer or boolean for Integer, a string for String, an integer element id for ElementId) or a `valueString` in the document's display units, such as `"1200 mm"`. A type parameter is set on the type's id (`type.id` from `get_parameters`); an instance id is never redirected to its type. The whole call is validated before anything changes and is rejected with nothing applied on `element_not_found`, `parameter_not_found`, `ambiguous_parameter` (several parameters share the name; the message lists their `builtIn` and `guid`), `parameter_read_only`, or `value_type_mismatch`. It is a model change: it shares the batch's one transaction, rolls back completely on failure, and appears in Revit's undo list as `Drive It model batch`. The receipt names each change and carries a `parameter_readback` check per entry (doubles within 1e-9 internal units, `valueString` by display string).
- `get_family_parameters()` reads an RFA's family parameters (`name`, `builtIn`, `guid`, `isInstance`, `isShared`, `isReporting`, `storageType`, `formula`) with each type's `value` and `display` under `values`, plus `types` and `currentType`. It does not change the current type. An RVT fails with `wrong_document_kind`.
- `set_family_parameters(changes)` changes family parameters per type. Each change is `{parameter, type | allTypes, value | valueString | formula}`: the parameter by name, one type by name or `allTypes: True`, and a `value` or `valueString` as in `set_parameters`, or a `formula` (`""` clears it). A Revit formula belongs to the parameter, so with `type` or `allTypes` it applies to every type, and the receipt says so. The whole call is validated first and rejected with nothing applied on `wrong_document_kind`, `family_type_not_found`, `parameter_not_found`, `parameter_has_formula` (a value for a formula-driven parameter), `parameter_read_only`, or `value_type_mismatch`; a formula Revit rejects fails with `invalid_formula`. It is a model change in the shared transaction: each type is made current to set it, and the original current type is restored before commit. The receipt names each type and parameter and carries a `family_parameter_readback` check per change.
- `edit_family(familyId)` opens a loadable family of the RVT (the `familyId` from `find_elements` or `list_types`) as an unsaved, in-memory family document and returns the full response with it as `document`, so later calls target the family. The project is not modified (`project_unmodified` check). Save the family into the workspace with `save_as_document`. In-place and non-editable families, and ids that are not families (system families such as walls have none), fail with `family_not_editable`. Load the edited family back into the project through the bridge: `revit.document().LoadFamily(project, revit.options.family_load(overwrite=True))`, where `project` is `revit.document(document=...)` with the project's document from an earlier receipt.
- `units.to_internal(value, unit)` and `units.from_internal(value, unit)` convert lengths (`mm`, `cm`, `m`, `in`, `ft`), areas (`mm2`, `m2`, `in2`, `ft2`), and angles (`deg`, `rad`) to and from Revit's internal feet, square feet, and radians.

Every primitive takes an optional `document`. Without one, it uses the script's current document, which `get_active_document` and `edit_family` set. A script with no current document fails with `document_not_open`, and the message says to pass `targets` on the call, or to open or create a document in the script. With `targets`, the first is the current document and `revit.targets` lists them all, each `{uniqueId, title, path, kind}`. Read primitives (`find_elements`, `get_parameters`, `list_types`, `list_views`, `get_selection`, `get_family_parameters`) return their output directly. All other operations return the full broker response. Reads start no transaction and never change the model. `limit` is at most 2000, and so is the number of element ids per call. A larger request fails with `limit_exceeded` and is never silently cut. Element ids are integers. Linked models are not queried.

### Document operations and model changes

The same `revit` object opens, creates, saves and closes documents and makes a few typed model changes. Each returns the full broker response and takes the optional `document`:

```python
revit.create_document(templatePath=args["template"], kind="rvt")    # unsaved; later calls target it
revit.create_level(name="Level 2", elevation=units.to_internal(3000, "mm"))
revit.create_wall(start={"x": 0, "y": 0, "z": 0}, end={"x": 20, "y": 0, "z": 0},
                  baseLevelId=args["levelId"], height=10.0)          # internal units (feet)
view = revit.create_3d_view(name="Check")                            # createdViews[0]["id"] for capture_revit_view
revit.save_as_document(destinationPath=args["projectPath"])          # an .rvt path in the workspace
```

- **Documents.** `open_document(path, kind=None)` opens an RVT or RFA. `create_document(templatePath, kind)` creates an unsaved document from an RTE or RFT template; give it a path with `save_as_document`. `read_document()` reads a snapshot. `save_document()` saves to the existing path. `save_as_document(destinationPath, overwrite=False)` keeps the document's identity across the save-as. `close_document()` closes without saving further changes. `delete_document()` closes a saved document and deletes its file. Every path goes through the [outside-root policy](how-it-works.md#workspace-and-outside-root-decisions), and Revit's installed templates and libraries can be read without a decision.
- **Model changes.** `create_level(name, elevation)` creates a level, `create_wall(start, end, baseLevelId, height)` a wall from `{x, y, z}` points, `create_3d_view(name=None)` an isometric 3D view, `create_family_type(name)` a type in an RFA, and `delete_element(elementId)` deletes an element and the elements that depend on it. Values are in Revit's internal units.
- **Batches.** `revit.execute([{"type": ..., "arguments": {...}}, ...])` sends several operations in one batch, and consecutive model changes in it share one Revit transaction.
- **Files.** `files.read(path, encoding="utf-8")`, `files.write(path, content, encoding="utf-8")`, `files.rename(source, destination)`, `files.move(source, destination)` and `files.delete(path)` go through the same policy. In a standard install, plain `open()` and `os` file calls are mediated the same way.
- **Checks.** `checks.record(name, passed, observed=None)` adds an observed check to the run receipt. Checks are how a run proves it did what was asked, and `promote_script` requires them.
