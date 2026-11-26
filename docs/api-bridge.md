# Revit API bridge

How a script calls Revit's modeling API directly. Read [Safety and ability](../README.md#safety-and-ability) before using it.

A script can also call Revit's modeling API itself, for what no built-in primitive covers: placing families, authoring family geometry, sheets, schedules, project parameters, copying standards between models. The script still runs in Drive-It's worker, not in Revit. It holds **handles** to Revit objects, and the add-in resolves each call inside Revit.

```python
doc = revit.document()                      # the script's current document
symbol = revit.element(args["deskTypeId"])  # one element by its integer id
level = revit.element(args["levelId"])
with revit.transaction("Place desks"):      # every change goes inside one
    if not symbol.IsActive:
        symbol.Activate()
    for x in range(0, 30, 6):
        desk = doc.Create.NewFamilyInstance(
            DB.XYZ(x, 0, 0), symbol, level, DB.Structure.StructuralType.NonStructural)
        checks.record("desk_placed", desk.IsValidObject)
```

- **Names.** `DB` is the `Autodesk.Revit.DB` namespace: calling a type constructs it, and static methods and enum values resolve where they are used. `revit.document(document=None)` and `revit.element(id, document=None)` return handles. `with revit.transaction(name, document=None):` commits on leaving the block and rolls back if it raises.
- **Values.** Numbers, strings, booleans and `None` cross by value, and a `Guid` crosses as its string. A `System.DateTime` crosses as a Python `datetime` and back: one Revit marks as UTC is aware in UTC, any other is naive; an aware `datetime` goes to Revit as the same instant in UTC, a naive one as this computer's local time (Revit refuses a time with no zone). Revit keeps some values in UTC, a view's sun date and time among them: set `datetime(2026, 6, 21, 17, 30, tzinfo=timezone.utc)` and it reads back equal, while a naive value reads back as the same instant in UTC. Everything else is a handle, with attribute access, method calls, indexing, iteration, `len`, `==` and `str`. `a + b`, `a - b`, `a * 2`, `a / 2` and `-a` run Revit's own operator where it defines one (`XYZ`, `UV`), so `p2 - p1` is an `XYZ`; a pair it defines none for fails with `operator_not_supported` naming both types. `x.GetType()` answers with text, `Name`, `FullName` and `Namespace`, never a handle. Python lists become the collection the method takes. Arguments are positional. A method whose matching overload has `out` parameters takes no argument for them and returns its result and then the out values as a tuple: `loaded, family = doc.LoadFamily(path, revit.options.family_load())`. Where Revit fills an out collection in place, Drive-It passes it a new empty one: `roof, mapping = doc.Create.NewFootPrintRoof(footprint, level, roof_type)`. `ref` (input/output) parameters are not supported. A handle lasts for one run; carry an element to the next run by its integer id (`element.Id.Value`).
- **The hold.** The first use of `DB`, `revit.document`, `revit.element` or `revit.transaction` holds Revit for the rest of the run, so thousands of calls are fast and a transaction can span many of them. Revit is paused for the person at the workstation until the run ends, bounded by the run's time limit; a small window over Revit says so and offers **Stop**. Runs that use only built-in operations are never held.
- **Transactions.** Drive-It owns every transaction. A change outside `revit.transaction` fails with `modification_outside_transaction`, whichever of its two exceptions Revit raises. A held run's transactions on each document become one undo entry, `Drive-It: <displayName>`. A run that fails, is stopped (`stopped_by_user`) or times out is rolled back whole, except what came before a `save_document` or `save_as_document` in it. Warnings go into the receipt instead of dialogs; an error rolls that transaction back and raises `RevitError` (`transaction_failed`) with Revit's message.
- **Questions back.** `revit.options.family_load(overwrite=False, overwriteParameterValues=False)` answers `LoadFamily`'s "already loaded; replace it?", and `revit.options.copy_paste(duplicateTypes="abort")` (or `"use_destination"`) answers `CopyElements`'s "a type with this name exists". Both default to what changes least. Any other callback, and Revit events, fail with `callback_not_supported` naming the interface.
- **Errors that teach.** A failed call raises `RevitError`; `error.response["error"]` has its `code` and `message`. A missing member (`member_not_found`) lists the members that exist, and a call no overload takes (`no_matching_overload`) lists the signatures. Revit's own exceptions come back as `revit_api_error`, naming the type and member called and then Revit's message (`WallType.Duplicate: ArgumentException: ...`); a property Revit's API only sets fails with `member_write_only`. `revit.describe("FamilyItemFactory")` returns a Revit API type's constructors, properties, methods and fields from the running Revit, without holding it.
- **Receipt.** `held` is `null` for a run that never used the bridge, otherwise `{ms, calls}`. A held run's receipt adds `transactions`, one entry per committed `revit.transaction` with its `name`, `document`, the element ids Revit reported as `added`, `changed` and `deleted`, their `totals`, and `truncated` when a list was cut at 1000 ids; and `warnings` with each warning's `description`, `severity` and `elementIds`. Each transaction also adds a `changes` line, such as `Place desks in Tower.rvt: 5 added, 0 changed, 0 deleted.`, and its added and changed ids to `affectedElements`. A bridge script proves its result with its own `checks`, and `promote_script` still needs a checked success.

### Guardrails

The bridge is the whole modeling API, so these rules are about what stays out of reach. They are a guardrail, not a sandbox.

| Rule | What it does | Error |
|---|---|---|
| Only Revit API objects | A handle is given only for an object whose type is defined in Revit's model API assembly, or a standard collection of them. The .NET runtime, files, processes, reflection and Revit's UI API are refused | `type_not_allowed` |
| Calls that stay with built-in operations | Saving, saving as, closing, opening and creating documents (and `EditFamily`), and creating `Transaction`, `TransactionGroup` or `SubTransaction`, are refused; the message names the built-in operation to use | `member_not_allowed` |
| Calls that leave the session | Synchronizing with central (`Document.SynchronizeWithCentral`), reloading latest (`Document.ReloadLatest`) and printing (`Document.Print`, `View.Print`, `PrintManager.SubmitPrint`) cannot be rolled back, so they are refused; the message says to ask the user to do it in Revit | `member_not_allowed` |
| File paths | A string argument that is an absolute file path goes through the outside-root policy. Inside the workspace root it passes, and so does reading Revit's installed content with `LoadFamily` or `LoadFamilySymbol`. Otherwise the run ends `pending` with an outside-root request, rolled back and with Revit released, as a built-in operation does; approve it and retry with the same `idempotencyKey` | the policy's `pending` and `denied` |
| Run limits | The run's time limit, and at most 100,000 live handles per run. Over the cap fails; nothing is silently dropped | `limit_exceeded` |

Use the built-in primitives where they cover the task: they check before they change anything. Open, create, save and close documents with the built-in operations. Run a long job, such as a full sheet set, as a chain of short scripts, one coherent step each, carrying element ids from each receipt into the next.
